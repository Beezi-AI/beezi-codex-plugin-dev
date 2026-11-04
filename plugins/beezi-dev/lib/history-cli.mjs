import path from 'path';
import {
  runAudit as _runAudit, createRunCache, planWorkspaceRuns as _planWorkspaceRuns, dontTrackSessionIds,
  HistoryScope, ACCOUNT_TOKEN_UNUSABLE,
} from './session-audit.mjs';
import { BackfillHalt, isKeyMissing, KEY_MISSING_MESSAGE } from './audit-flush.mjs';
import { oneLine, orDefault } from './compat.mjs';
import {
  AccountStatus, AcceptRefusal, describeAccount, getAccount, listAccounts, recordOffer, acceptOffer, owePastSessions,
} from './accounts.mjs';
import { isMultiTenant, tenantById, newFoldersOf, NEW_FOLDERS_SOURCE, joinTenantNames } from './workspace.mjs';
import { usesRules, routeForDir, createRouteContext } from './workspace-rules.mjs';
import { anonymizationFor, kindsOf, pastSessionsOf, unionKinds } from './anonymization.mjs';
import { whoami as _whoami } from './whoami.mjs';
import {
  OfferState, OfferCheck, offerCheck, offerLines, questionText, declineLine, plural, CHANGED_LINE,
  offerToken, offerRecordOf, offerIdsOf, changedAtOf, offerTrackingDisabled, isStaleRecord, declinedNow,
  asksFirst, noAskLines, uploadedLine, combinedLines, combinedQuestion, allChoice,
} from './history-offer.mjs';
import { naming } from './paths.mjs';
import { workspaceIdOf, RunOutcome } from './pending-history.mjs';
import { runPendingHistory as _runPendingHistory, classifyRun } from './pending-history-run.mjs';
import { readTrackingState as _readTrackingState, TrackingMode } from './tracking.mjs';
import { HISTORY_WORKER_SCRIPT, offerWorkspaceIds } from './history-trigger.mjs';
import { spawnDetached } from './background-spawn.mjs';
import { compressedSkippedLine } from './rollout-file.mjs';

// The sync command's three modes (offer, accept, decline) and the offer-scan worker. Past sessions go up only after a
// yes: the offer lists them (runAudit listOnly) and records the shown ids, and accept uploads exactly those ids. A
// workspace that uploads without asking gets its shown ids owed and uploaded right after its notice instead.

// Checks 1–4 of offerCheck: the offer command skips these quietly with --past.
const QUIET_CHECKS = [OfferCheck.SKIP_CHOICE, OfferCheck.TRACKING_OFF, OfferCheck.DECLINED, OfferCheck.SETTLED];
const SCAN_CHECKS = [OfferCheck.SCAN, OfferCheck.SCAN_WAIT];
const BUSY_LINE = '✓ Beezi: another Beezi history run is using this machine right now — letting it finish.';
export const WRITER_BUSY_LINE = `✓ Beezi: Codex is still saving analytics on this machine, so nothing was listed this time. Run \`${naming.syncCommand()}\` again in a minute.`;
export const ACCEPT_BUSY_LINE = '✓ Beezi: your yes is saved, but this machine is busy, so nothing was uploaded yet. Beezi retries on its own.';
export const PENDING_UNREADABLE_TEXT = 'Beezi: could not read Codex’s pending analytics on this machine';
export const NO_NEW_LINE = `✓ Beezi: no new past sessions to offer. Run \`${naming.syncCommand()}\` to see every past session.`;
const NO_UPLOADS_TEXT = 'Beezi: this workspace does not accept history uploads on demand.';
const UPLOAD_FAILED = { text: 'Beezi: the upload stopped with an error. Beezi tries it again at the next session start.', error: true };
// Codex's own writer is busy (a live checkpoint, or its transactions unfinished), not another upload.
const WRITER_REASONS = ['active-writer', 'pending-transaction'];

const union = (a, b) => Array.from(new Set(a.concat(b)));

function seams(deps) {
  return {
    runAudit: deps.runAudit == null ? _runAudit : deps.runAudit,
    planRuns: deps.planWorkspaceRuns == null ? _planWorkspaceRuns : deps.planWorkspaceRuns,
    readTrackingState: deps.readTrackingState == null ? _readTrackingState : deps.readTrackingState,
    runPendingHistory: deps.runPendingHistory == null ? _runPendingHistory : deps.runPendingHistory,
    whoami: deps.whoamiImpl == null ? _whoami : deps.whoamiImpl,
    now: deps.now == null ? () => Date.now() : deps.now,
  };
}

// ── printing a run ─────────────────────────────────────────────────────────────────────────

// A run that stopped before it could list or upload: { text, error }, or null when it did not stop.
function stopLine(result, key) {
  const refusal = (text) => ({ text, error: true });
  const notice = (text) => ({ text, error: false });
  // 'no-token' unscoped is the machine: nothing here can report. Scoped it is the account, which the caller has already
  // resolved against the index, so "this machine is not linked" would be false.
  if (result.reason === 'no-token') {
    return refusal(
      key === null
        ? 'Beezi: this machine is not linked. Sign in to Beezi first (the login skill).'
        : ACCOUNT_TOKEN_UNUSABLE,
    );
  }
  if (result.reason === 'workspace-required') {
    return refusal(
      'Beezi: this account belongs to several workspaces and none was picked for this run. '
      + 'Check where analytics go with the settings skill, then run sync again.',
    );
  }
  if (result.reason === 'lock-order' || result.reason === 'lock-failed') {
    return refusal(`Beezi: could not start the history sync (${orDefault(oneLine(result.lastError), 'lock error')}).`);
  }
  if (result.reason === 'run-in-progress') return notice(BUSY_LINE);
  if (WRITER_REASONS.indexOf(result.reason) !== -1) return notice(WRITER_BUSY_LINE);
  if (result.reason === 'pending-unreadable') {
    return refusal(`${PENDING_UNREADABLE_TEXT} (${orDefault(oneLine(result.lastError), 'unreadable')}). Nothing was listed or uploaded.`);
  }
  // Reports this machine built and Beezi has not received yet. Coverage would be stale by exactly
  // those segments, so the run stops rather than reconcile against an answer it knows is behind.
  if (result.reason === 'pending-not-drained') {
    return notice(
      '✓ Beezi: nothing was synced this time — some already-saved analytics have not reached Beezi '
      + `yet (${orDefault(oneLine(result.lastError), 'delivery pending')}). They are queued on disk and retried `
      + 'automatically; run sync again once they are through.',
    );
  }
  if (result.halt === BackfillHalt.LOCK_LOST) {
    return notice(
      '✓ Beezi: another history upload took over partway through. Nothing was lost — run sync again '
      + 'once it finishes.',
    );
  }
  if (result.halt === BackfillHalt.NOT_ALLOWED || result.halt === BackfillHalt.ALREADY_COMPLETED) {
    return refusal(NO_UPLOADS_TEXT);
  }
  if (result.halt === BackfillHalt.UNSUPPORTED_SERVER) {
    return refusal(
      'Beezi: your workspace’s Beezi server does not support history sync yet — it needs updating. '
      + 'No history was lost; run this again after the portal update.',
    );
  }
  if (result.halt === BackfillHalt.FORBIDDEN) {
    return refusal(
      `Beezi: the server refused the upload (${orDefault(oneLine(result.lastError), 'forbidden')}). `
      + 'Check your seat with your workspace admin, then sign in to Beezi again.',
    );
  }
  if (isKeyMissing(result)) {
    return refusal(KEY_MISSING_MESSAGE);
  }
  // The tri-state, surfaced verbatim: "could not ask" must never be printed as "nothing to do".
  if (result.coverageKnown === false) {
    return notice(
      '✓ Beezi: could not reach Beezi to check what it already has, so nothing was uploaded — '
      + 'and nothing was lost or duplicated. Try again in a moment.',
    );
  }
  return null;
}

// Prints the stop line; → the exit status it implies.
function printStop(stop) {
  if (!stop.error) {
    console.log(stop.text);
    return 0;
  }
  console.error(`✗ ${stop.text}`);
  return 1;
}

// "everything is already uploaded" is the ONE phrase the skill teaches the model to read as final, qualified when the
// 30-day window bit, because "everything" would be a false claim about older history.
function nothingLeftLine(result) {
  return result.tooOld > 0
    ? '✓ Beezi: everything from the last 30 days is already uploaded.'
    : '✓ Beezi: everything is already uploaded.';
}

// One upload run's outcome; options: { key, splitByRules } (a one-workspace account with rules). → exit status.
function printRunResult(result, options) {
  const stop = stopLine(result, options.key);
  if (stop != null) return printStop(stop);

  if (result.scanned === 0) {
    console.log('✓ Beezi: no past Codex sessions found on this machine.');
    return 0;
  }

  // The success phrase is gated on there being nothing left to come back for. A run that deferred history has to say
  // so first, or the surface tells the user to stop precisely when a later retry is the whole point.
  if (result.sessionsImported === 0 && result.deferred > 0) {
    // Split history is the one deferral a later run does not clear, so it gets no "run again".
    console.log(
      result.deferred > orDefault(result.deferredSplit, 0)
        ? `✓ Beezi: nothing new was uploaded — ${plural(result.deferred, 'session')} were left for a `
          + 'later run. Details below; run sync again afterwards.'
        : `✓ Beezi: nothing new was uploaded — ${plural(result.deferred, 'session')} were left alone. Details below.`,
    );
  } else if (result.sessionsImported === 0) {
    console.log(nothingLeftLine(result));
  } else {
    console.log(
      `✓ Beezi: uploaded ${plural(result.sessionsImported, 'session')} `
      + `(${plural(result.reportsStored, 'report')} stored).`,
    );
  }

  // The window is a hard floor on this path too: unlike a deferral, a later run will not reach them.
  if (result.tooOld > 0) {
    console.log(
      `  ${plural(result.tooOld, 'session')} ran more than 30 days ago — sync only reaches back 30 `
      + 'days, so they will not be uploaded by a later run either.',
    );
  }
  if (result.pendingDrained > 0) {
    console.log(`  ${plural(result.pendingDrained, 'saved report')} were delivered before the check.`);
  }
  // Deferred history, split by cause, because the two causes need different follow-up.
  if (result.deferredGap > 0) {
    console.log(
      `  ${plural(result.deferredGap, 'session')} were left alone: what Beezi has recorded for them `
      + 'does not line up with what this machine sent, so re-uploading could double-count. They stay '
      + 'eligible — run sync again later.',
    );
  }
  // A one-workspace account with rules has one workspace, so its excluded segments cannot read as "split between workspaces".
  if (orDefault(result.deferredSplit, 0) > 0) {
    console.log(
      options.splitByRules === true
        ? `  ${plural(result.deferredSplit, 'session')} were left alone: part of their history is in repos `
          + 'or folders you don\'t track, so what Beezi has does not prove a safe resume point and '
          + 're-uploading could double-count. A later run will not change that.'
        : `  ${plural(result.deferredSplit, 'session')} were left alone: their history was split between `
          + 'workspaces, so what Beezi has for this workspace does not prove a safe resume point and '
          + 're-uploading could double-count. A later run will not change that.',
    );
  }
  if (result.deferredOverlap > 0) {
    console.log(
      `  ${plural(result.deferredOverlap, 'session')} were left alone because the resume point could `
      + 'not be honoured. Nothing was sent for them.',
    );
  }
  if (result.childrenDeferred > 0) {
    console.log(
      `  ${plural(result.childrenDeferred, 'sub-agent')} left alone: live tracking is still delivering `
      + 'them, or they ran before 11 September 2026, when sub-agent ids changed. Their main sessions '
      + 'were still checked.',
    );
  }
  if (result.itemErrors > 0) {
    console.log(`  ${plural(result.itemErrors, 'report')} skipped — their repository is not connected to Beezi.`);
  }
  if (result.reportsFailed > 0 || result.unattributed > 0 || result.permanentRejections > 0) {
    const lastError = oneLine(result.lastError);
    const reason = lastError ? ` (last error: ${lastError})` : '';
    console.log(
      `  ${plural(result.reportsFailed, 'report')} could not be delivered${reason} — run sync again to retry them.`,
    );
  }
  if (result.unreadable > 0) {
    console.log(`  ${plural(result.unreadable, 'session')} could not be read — not uploaded.`);
  }
  if (result.compressedUnsupported > 0) {
    console.log(`  ${compressedSkippedLine(result.compressedUnsupported)}`);
  }
  console.log('  Plan and billing details reflect your current setup, not the plan you were on at the time.');
  return 0;
}

// ── which workspaces ───────────────────────────────────────────────────────────────────────

function workspaceName(row, tenantId) {
  const t = tenantById(row, tenantId);
  if (t != null && t.name) return t.name;
  return !isMultiTenant(row) && row.tenantName ? row.tenantName : tenantId;
}

// Sessions a rule routes, then the rest by New folders; a zero clause is dropped and null means print nothing.
function routeSummary(row, plan) {
  const ruled = plan.counts.rule;
  const rest = plan.counts['new-folders'] + plan.counts.none + plan.counts.pending;
  const clauses = [];
  if (ruled > 0) clauses.push(`${plural(ruled, 'past session')} ${ruled === 1 ? 'follows' : 'follow'} your rules`);
  if (rest > 0) {
    // The first printed clause names the sessions.
    const lead = clauses.length === 0 ? plural(rest, 'past session') : String(rest);
    const newFolders = newFoldersOf(row);
    if (newFolders.mode === 'send') {
      const names = newFolders.tenantIds.map((id) => workspaceName(row, id)).join(', ');
      clauses.push(`${lead} in new folders ${rest === 1 ? 'goes' : 'go'} to ${names}`);
    } else if (newFolders.mode === 'none') {
      clauses.push(`${lead} in new folders ${rest === 1 ? 'is' : 'are'} not sent`);
    } else {
      clauses.push(`${lead} in repos or folders with no rule ${rest === 1 ? 'is' : 'are'} not sent this time`);
    }
  }
  return clauses.length === 0 ? null : `Beezi (${describeAccount(row)}): ${clauses.join('; ')}.`;
}

// The account's workspaces as sync runs them: one headerless run, the --tenant override (every past session, unrouted),
// else each workspace a route or rule reaches. → { notes: lines to print, runs: [{ id, heading, override?, options }] }.
function workspaceRuns(row, override, planRuns) {
  if (!isMultiTenant(row)) {
    const options = { tenantId: null };
    if (usesRules(row)) options.excludedSessionIds = dontTrackSessionIds(planRuns(row));
    return { notes: [], runs: [{ id: workspaceIdOf(row), heading: false, options }] };
  }
  if (override.length > 0) {
    return { notes: [], runs: override.map((tenantId) => ({ id: tenantId, heading: true, override: true, options: { tenantId } })) };
  }
  const plan = planRuns(row);
  if (plan.scanned === 0) return { notes: [`✓ Beezi (${describeAccount(row)}): no past Codex sessions found on this machine.`], runs: [] };
  const summary = routeSummary(row, plan);
  const notes = summary == null ? [] : [summary];
  if (plan.compressedUnsupported > 0) notes.push(`  ${compressedSkippedLine(plan.compressedUnsupported)}`);
  return {
    notes,
    runs: plan.tenantIds.map((tenantId) => ({ id: tenantId, heading: true, options: { tenantId, sessionRoutes: plan.routes } })),
  };
}

function checkOf(row, run, seam) {
  const block = anonymizationFor(row, run.id);
  return offerCheck({
    block,
    trackingDisabled: offerTrackingDisabled(row, block, seam.readTrackingState),
    record: offerRecordOf(row, run.id),
    nowMs: seam.now(),
  });
}

// A re-opened place matches a route by its rule key, or New folders by the route's source.
function inPlaces(route, places) {
  return route != null && places.some((p) => (p.kind === NEW_FOLDERS_SOURCE
    ? route.source === NEW_FOLDERS_SOURCE
    : route.key != null && route.key.kind === p.kind && route.key.match === p.match));
}

// A session's folder is in a place when the place's rule would route it, by prefix, so a repo under a folder place counts.
function dirInPlaces(dir, places, ctx) {
  const workspaceRules = places.filter((p) => p.kind !== NEW_FOLDERS_SOURCE).map((p) => ({ kind: p.kind, match: p.match, tenantIds: ['w'] }));
  return typeof dir === 'string' && dir !== '' && routeForDir({ tenants: [{ id: 'w' }], workspaceRules }, dir, ctx) != null;
}

// The places a rule or New folders re-opened since the last decline or settle.
function reopenedPlaces(record) {
  const open = record.state === OfferState.RESCAN || record.state === OfferState.READY;
  return open && Array.isArray(record.places) ? record.places.filter((p) => p != null) : [];
}

// A listed session is in a re-opened place by its folder, or, on a multi-workspace account, by its route.
function placeTester(row, run, places, seam) {
  const ctx = createRouteContext();
  const byDir = (s) => dirInPlaces(s.cwd, places, ctx);
  if (!isMultiTenant(row)) return byDir;
  const routes = run.options.sessionRoutes == null ? seam.planRuns(row).routes : run.options.sessionRoutes;
  return (s) => inPlaces(routes.get(s.sessionId), places) || byDir(s);
}

const pastOf = (row, tenantId) => pastSessionsOf(anonymizationFor(row, tenantId));

// Clears declines and places only while the fresh record is still older than the account's changedAt.
const clearIfChanged = (tenantId) => (fresh, freshRow) => (
  fresh != null && isStaleRecord(pastOf(freshRow, tenantId), fresh) ? { declinedIds: [], places: [] } : null
);

// ── listing ────────────────────────────────────────────────────────────────────────────────

// The list-only run for one workspace. With past: a later changedAt re-opens the whole offer (its declines and places
// are cleared first); otherwise remembered declines are left out, and re-opened places limit the list to their sessions.
// → { result, narrowed: whether re-opened places limited the list, fresh: the run's own whoami answer, or null }.
async function listWorkspace(row, run, { past, save, seam, runCache }) {
  const record = offerRecordOf(row, run.id);
  const selection = {};
  let places = [];
  if (past && record != null) {
    if (isStaleRecord(pastOf(row, run.id), record)) {
      await save(row.key, run.id, clearIfChanged(run.id));
    } else {
      selection.declinedSessionIds = offerIdsOf(record.declinedIds);
      places = reopenedPlaces(record);
    }
  }
  let fresh = null;
  const whoamiImpl = (session, deps) => seam.whoami(session, deps).then((who) => { fresh = who; return who; });
  const result = await seam.runAudit(
    { runCache, whoamiImpl },
    { ...run.options, ...selection, key: row.key, listOnly: true, scope: past ? HistoryScope.PAST : HistoryScope.ALL },
  );
  const narrowed = places.length > 0;
  // The listed sessions are narrowed to the re-opened places, so the shown ids are what accept uploads.
  if (!narrowed || !Array.isArray(result.listed)) return { result, narrowed, fresh };
  return { result: { ...result, listed: result.listed.filter(placeTester(row, run, places, seam)) }, narrowed, fresh };
}

function summaryOf(result) {
  const listed = result.listed;
  const folders = listed.filter((s) => typeof s.cwd === 'string' && s.cwd !== '').map((s) => path.basename(s.cwd));
  return {
    n: listed.length,
    firstMs: Math.min.apply(null, listed.map((s) => s.startedMs)),
    lastMs: Math.max.apply(null, listed.map((s) => s.mtimeMs)),
    folders: Array.from(new Set(folders)),
    audit: result.trackingMode === TrackingMode.BACKFILL_ONLY,
  };
}

// ── offer ──────────────────────────────────────────────────────────────────────────────────

// An empty list narrowed by remembered declines or re-opened places is not "everything is uploaded".
function emptyListLine(result, narrowed) {
  if (result.scanned === 0) return '✓ Beezi: no past Codex sessions found on this machine.';
  return narrowed || result.declined > 0 ? NO_NEW_LINE : nothingLeftLine(result);
}

// SETTLED under the workspace's `past` choice, unless the fresh record is a question printed under it meanwhile.
const settleUnlessAsked = (past) => (fresh) => (
  fresh != null && fresh.state === OfferState.DECLINED && !isStaleRecord(past, fresh)
    ? null
    : { state: OfferState.SETTLED, changedAt: orDefault(past.changedAt, null) }
);

function printHeading(row, run) {
  if (run.heading) console.log(`\n— ${describeAccount(row)} · ${workspaceName(row, run.id)} —`);
}

// One workspace's shown sessions. Only the run's own whoami answering upload skips the question (R17); audit workspaces
// (R15), the --tenant override (R6) and, in sync, a listed session declined under the fresh choice (R18) always ask.
function shownOffer(row, run, result, changedAt, fresh, sync) {
  const summary = summaryOf(result);
  const freshBlock = fresh != null && fresh.valid === true ? anonymizationFor(fresh, run.id) : null;
  const freshPast = pastSessionsOf(freshBlock);
  const record = offerRecordOf(row, run.id);
  const ids = result.listed.map((s) => s.sessionId);
  const declined = sync && declinedNow(freshPast, record) && ids.some((id) => offerIdsOf(record.declinedIds).indexOf(id) !== -1);
  const cachedKinds = kindsOf(anonymizationFor(row, run.id));
  const offer = {
    run, changedAt, summary, ids,
    compressed: orDefault(result.compressedUnsupported, 0),
    name: workspaceName(row, run.id),
    kinds: cachedKinds,
    noAsk: run.override !== true && !asksFirst(freshBlock, summary.audit) && !declined,
    freshChangedAt: orDefault(freshPast.changedAt, null),
  };
  // A no-ask upload hides what the cached or the fresh answer hides.
  if (offer.noAsk) offer.kinds = unionKinds(cachedKinds, kindsOf(freshBlock));
  return offer;
}

// One workspace's list. An outcome with nothing to offer is printed under its heading here. → { status, offer | null }.
async function listOutcome(row, run, ctx) {
  const none = (status) => ({ status, offer: null });
  if (ctx.past && QUIET_CHECKS.indexOf(checkOf(row, run, ctx.seam)) !== -1) return none(0);
  const past = pastOf(row, run.id);
  const changedAt = changedAtOf(row, run.id);
  const { result, narrowed, fresh } = await listWorkspace(row, run, ctx);
  const stop = stopLine(result, row.key);
  const listed = stop == null && Array.isArray(result.listed) && result.trackingMode !== TrackingMode.DISABLED;
  if (listed && result.listed.length > 0) return { status: 0, offer: shownOffer(row, run, result, changedAt, fresh, !ctx.past) };
  printHeading(row, run);
  if (stop != null) return none(printStop(stop));
  // A busy run lists nothing, and is not "nothing to offer".
  if (!Array.isArray(result.listed)) {
    console.log(WRITER_BUSY_LINE);
    return none(0);
  }
  // Session start and login stay quiet; sync prints the refusal.
  if (result.trackingMode === TrackingMode.DISABLED) {
    await ctx.save(row.key, run.id, settleUnlessAsked(past));
    return none(ctx.past ? 0 : printStop({ text: NO_UPLOADS_TEXT, error: true }));
  }
  if (ctx.past) await ctx.save(row.key, run.id, settleUnlessAsked(past));
  console.log(emptyListLine(result, narrowed));
  if (result.compressedUnsupported > 0) console.log(`  ${compressedSkippedLine(result.compressedUnsupported)}`);
  return none(0);
}

// Shown is a decline until the developer says yes (K6): this is the only place a shown question records one.
async function recordAsked(row, { run, changedAt, ids: offeredIds, kinds: shownKinds, summary }, ctx) {
  const past = pastOf(row, run.id);
  await ctx.save(row.key, run.id, (fresh) => {
    const remembered = fresh == null || isStaleRecord(past, fresh) ? [] : offerIdsOf(fresh.declinedIds);
    return {
      state: OfferState.DECLINED, changedAt, offeredIds, declinedIds: union(remembered, offeredIds), shownKinds, summary,
      override: run.override === true,
    };
  });
}

function printQuestion(row, { run, name, ids: offeredIds, kinds: shownKinds, summary }) {
  console.log(`Q ${questionText(summary.n, name)}`);
  console.log(`offer account=${row.key} tenant=${run.id} sessions=${summary.n} audit=${summary.audit ? 'yes' : 'no'} token=${offerToken(offeredIds, shownKinds)}`);
}

// Two or more workspaces: one header counting each session once over the widest range (R2), then the two groups.
function printCombined(offers) {
  const total = offers.reduce((all, o) => union(all, o.ids), []).length;
  const firstMs = Math.min.apply(null, offers.map((o) => o.summary.firstMs));
  const lastMs = Math.max.apply(null, offers.map((o) => o.summary.lastMs));
  const entries = offers.map((o) => ({ name: o.name, n: o.summary.n, kinds: o.kinds, noAsk: o.noAsk }));
  for (const line of combinedLines(entries, firstMs, lastMs, total)) console.log(line);
}

const backgroundLine = (n, names) => `✓ Beezi: uploading ${plural(n, 'past session')} to ${names} in the background.`;

function printProgress({ processed, total }) {
  console.log(`Beezi: ${processed}/${total} sessions read…`);
}

// `deps` with runAudit printing each session read.
function withProgress(seam, deps) {
  const runAudit = (auditDeps, auditOptions) => seam.runAudit({ ...auditDeps, onProgress: printProgress }, auditOptions);
  return { ...deps, runAudit };
}

// No run picked these owed sessions up: no rule or New folders setting sends them to `names` any more.
function noRunStop(names) {
  return {
    text: `Beezi: nothing was uploaded — no rule or New folders setting sends these sessions to ${names} now. `
      + `Run \`${naming.syncCommand()}\` to see what would be sent.`,
    error: true,
  };
}

const queuedLine = (name) => `Beezi: another upload is running, so ${name}'s past sessions are queued and upload later.`;

// One foreground run of the account's owed `tenantIds`, each result classified as accept's is. A failed run prints accept's
// failure lines; a busy one, and the workspaces it skipped, stay owed for the pending-history retry (R5).
// → { status, uploaded: the tenant ids uploaded }.
async function uploadOwed(row, tenantIds, deps) {
  const seam = seams(deps);
  const options = { key: row.key, splitByRules: !isMultiTenant(row) && usesRules(row) };
  const uploaded = [];
  const ran = [];
  let status = 0;
  const onResult = (entry, result) => {
    ran.push(entry.tenantId);
    const outcome = classifyRun(result, false);
    if (outcome === RunOutcome.CLEAN) uploaded.push(entry.tenantId);
    else if (outcome !== RunOutcome.BUSY) status = Math.max(status, 1, result == null ? printStop(UPLOAD_FAILED) : printRunResult(result, options));
  };
  const done = await seam.runPendingHistory(row.key, withProgress(seam, deps), { tenantIds, onResult });
  // A busy run skips the rest of its pass without a result.
  const busy = done.filter((d) => d.outcome === RunOutcome.BUSY).map((d) => d.tenantId);
  for (const id of busy) console.log(queuedLine(workspaceName(row, id)));
  const missed = tenantIds.filter((id) => ran.indexOf(id) === -1 && busy.indexOf(id) === -1);
  if (missed.length > 0) {
    status = Math.max(status, printStop(noRunStop(missed.length === 1 ? workspaceName(row, missed[0]) : joinTenantNames(row, missed))));
  }
  return { status, uploaded };
}

// Owes the no-ask workspaces' shown ids, settled and never declined (R4), and uploads the owed ones here or in the
// background; a workspace nothing was owed for prints nothing more. One workspace prints its notice first; a preview
// prints only that (R14). → { status, notices: the workspaces owed, or shown in a preview }.
async function uploadNoAsk(row, noAsk, single, ctx) {
  if (ctx.dryRun) {
    if (single) console.log(noAskLines(noAsk[0].summary.n, noAsk[0].name)[0]);
    return { status: 0, notices: noAsk.length };
  }
  const nowIso = new Date(ctx.seam.now()).toISOString();
  const owed = [];
  for (const o of noAsk) {
    const { ids } = await owePastSessions(row.key, o.run.id, o.ids, o.kinds, nowIso, o.freshChangedAt);
    if (ids.length > 0) owed.push(o);
  }
  if (owed.length === 0) return { status: 0, notices: 0 };
  const n = owed.reduce((sum, o) => sum + o.summary.n, 0);
  const names = owed.length === 1 ? owed[0].name : joinTenantNames(row, owed.map((o) => o.run.id));
  const [notice, progress] = noAskLines(n, names);
  if (single) console.log(notice);
  console.log(progress);
  // A failed spawn uploads here instead, as an accepted offer does.
  if (ctx.background && spawnDetached(HISTORY_WORKER_SCRIPT, ctx.deps, ['--account', row.key])) {
    console.log(backgroundLine(n, names));
    return { status: 0, notices: owed.length };
  }
  const { status, uploaded } = await uploadOwed(row, owed.map((o) => o.run.id), ctx.deps);
  const done = owed.filter((o) => uploaded.indexOf(o.run.id) !== -1);
  if (done.length > 0) console.log(uploadedLine(done.map((o) => ({ name: o.name, n: o.summary.n }))));
  return { status, notices: owed.length };
}

// One account's workspaces with sessions: one keeps its full checklist, two or more get the combined layout (R1). The
// no-ask uploads run first, then the ask-first questions: `QM` and `QM-all=` lead two or more. → { offered, notices, status }.
async function presentOffers(row, offers, ctx) {
  const noAsk = offers.filter((o) => o.noAsk);
  const asks = offers.filter((o) => !o.noAsk);
  if (offers.length === 1) {
    printHeading(row, offers[0].run);
    for (const line of offerLines({ ...offers[0].summary, kinds: offers[0].kinds })) console.log(line);
  } else {
    printCombined(offers);
  }
  // The accept run uploads only the shown ids, so the offer is the one place these are reported.
  const compressed = Math.max.apply(null, offers.map((o) => o.compressed));
  if (compressed > 0) console.log(`  ${compressedSkippedLine(compressed)}`);
  const { status, notices } = noAsk.length === 0 ? { status: 0, notices: 0 } : await uploadNoAsk(row, noAsk, offers.length === 1, ctx);
  // Recorded after the uploads, so an upload cut short leaves no decline for a question never printed.
  for (const offer of asks) await recordAsked(row, offer, ctx);
  // A preview asks nothing: with no question there is nothing to accept.
  if (ctx.dryRun) return { offered: 0, notices, status };
  if (asks.length > 1) {
    console.log(`QM ${combinedQuestion(asks.map((o) => o.name), notices > 0)}`);
    console.log(`QM-all=${allChoice(asks.length)}`);
  }
  for (const offer of asks) printQuestion(row, offer);
  return { offered: asks.length, notices, status };
}

async function offerRows(key) {
  if (key != null) return [orDefault(await getAccount(key), { key })];
  const linked = (await listAccounts()).filter((a) => a.status === AccountStatus.LINKED);
  // Nothing linked: one unscoped run, so runAudit answers 'no-token' for the machine as it always has.
  return linked.length === 0 ? [{ key: null }] : linked;
}

// Lists each workspace's past sessions with the K7 summary and its question, records the decline, and ends
// `notices=<n>` (when n > 0) then `offers=<n>`; a no-ask workspace gets its notice and upload instead (`background`
// hands that to the history worker). dryRun records and uploads nothing and prints the summary without its question.
// → { offers, status }.
export async function offerCommand({ key = null, past = false, tenantIds = [], dryRun = false, background = false }, deps = {}) {
  const seam = seams(deps);
  const save = dryRun ? async () => null : (k, id, patch) => recordOffer(k, id, patch);
  const ctx = { past, save, seam, runCache: createRunCache(), dryRun, background, deps };
  const rows = await offerRows(key);
  let offers = 0;
  let notices = 0;
  let status = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (rows.length > 1) {
      if (i > 0) console.log('');
      // describeAccount answers the same for two pre-0.13 migrated rows, so the key tells them apart.
      console.log(`── Account: ${describeAccount(row)} [${row.key}] ──`);
    }
    const plan = workspaceRuns(row, tenantIds, seam.planRuns);
    for (const note of plan.notes) console.log(note);
    const shown = [];
    for (const run of plan.runs) {
      const done = await listOutcome(row, run, ctx);
      if (done.offer != null) shown.push(done.offer);
      status = Math.max(status, done.status);
    }
    if (shown.length === 0) continue;
    const done = await presentOffers(row, shown, ctx);
    offers += done.offered;
    notices += done.notices;
    status = Math.max(status, done.status);
  }
  // Only a no-ask notice prints `notices=`, so an account with none keeps today's output.
  if (notices > 0) console.log(`notices=${notices}`);
  console.log(`offers=${offers}`);
  return { offers, status };
}

// The history worker's --offer pass: lists each workspace due a scan and records READY, or SETTLED when nothing is owed
// (a workspace no route reaches has no candidates); a busy run or unknown coverage leaves the record for the next scan.
// → the number of READY workspaces.
export async function scanOffers(key, deps = {}) {
  const seam = seams(deps);
  const row = await getAccount(key);
  if (row == null || row.status !== AccountStatus.LINKED) return 0;
  const ctx = { past: true, save: (k, id, patch) => recordOffer(k, id, patch), seam, runCache: createRunCache() };
  const due = (from, tenantId) => SCAN_CHECKS.indexOf(checkOf(from, { id: tenantId }, seam)) !== -1;
  // Written only while the fresh record is still due a scan, so a question printed meanwhile is kept.
  const writeIfDue = (tenantId, patch) => recordOffer(key, tenantId, (_fresh, freshRow) => (due(freshRow, tenantId) ? patch : null));
  const runs = workspaceRuns(row, [], seam.planRuns).runs;
  const reached = runs.map((run) => run.id);
  for (const tenantId of offerWorkspaceIds(row)) {
    if (reached.indexOf(tenantId) !== -1 || !due(row, tenantId)) continue;
    await writeIfDue(tenantId, { state: OfferState.SETTLED, changedAt: changedAtOf(row, tenantId) });
  }
  let ready = 0;
  for (const run of runs) {
    if (!due(row, run.id)) continue;
    await recordOffer(key, run.id, { scanAt: new Date(seam.now()).toISOString() });
    const changedAt = changedAtOf(row, run.id);
    const { result } = await listWorkspace(row, run, ctx);
    if (stopLine(result, key) != null || !Array.isArray(result.listed)) continue;
    if (result.trackingMode === TrackingMode.DISABLED || result.listed.length === 0) {
      await writeIfDue(run.id, { state: OfferState.SETTLED, changedAt });
      continue;
    }
    const offeredIds = result.listed.map((s) => s.sessionId);
    if (await writeIfDue(run.id, { state: OfferState.READY, changedAt, offeredIds }) != null) ready += 1;
  }
  return ready;
}

// ── accept and decline ─────────────────────────────────────────────────────────────────────

// A yes to the question whose `offer` line carried `token`: owes exactly its ids, then uploads them in the background
// or here. → exit status.
export async function acceptCommand({ key, tenantId, token = null, background = false }, deps = {}) {
  const seam = seams(deps);
  const { ids, refused } = await acceptOffer(key, tenantId, token, new Date(seam.now()).toISOString());
  if (refused === AcceptRefusal.CHANGED) {
    console.error(CHANGED_LINE);
    return 1;
  }
  if (ids.length === 0) {
    console.log(`Beezi: nothing is waiting to upload. Run \`${naming.syncCommand()}\` to see what would be sent.`);
    return 1;
  }
  const row = await getAccount(key);
  // A failed spawn uploads here instead, so the yes is never left waiting on a worker that did not start.
  if (background && spawnDetached(HISTORY_WORKER_SCRIPT, deps, ['--account', key])) {
    console.log(backgroundLine(ids.length, workspaceName(row, tenantId)));
    return 0;
  }
  const options = { key, splitByRules: !isMultiTenant(row) && usesRules(row) };
  let status = 0;
  let ran = false;
  const onResult = (entry, result) => {
    ran = true;
    if (result == null) {
      status = printStop(UPLOAD_FAILED);
      return;
    }
    // A busy run keeps the accepted entry for the next retry.
    if (classifyRun(result, false) === RunOutcome.BUSY) {
      console.log(ACCEPT_BUSY_LINE);
      return;
    }
    status = Math.max(status, printRunResult(result, options));
  };
  await seam.runPendingHistory(key, withProgress(seam, deps), { tenantIds: [tenantId], onResult });
  return ran ? status : printStop(noRunStop(workspaceName(row, tenantId)));
}

// "Not now" to an open question: its shown ids stay declined until a later choice change or a re-opened place; with no
// question open it writes and prints nothing. → exit status.
export async function declineCommand({ key, tenantId }) {
  let audit = null;
  await recordOffer(key, tenantId, (record, row) => {
    if (record == null || record.state !== OfferState.DECLINED || offerIdsOf(record.offeredIds).length === 0) return null;
    audit = record.summary != null && record.summary.audit === true;
    return {
      state: OfferState.DECLINED,
      changedAt: changedAtOf(row, tenantId),
      declinedIds: union(offerIdsOf(record.declinedIds), offerIdsOf(record.offeredIds)),
    };
  });
  if (audit !== null) console.log(declineLine(audit));
  return 0;
}
