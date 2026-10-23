import path from 'path';
import {
  runAudit as _runAudit, createRunCache, planWorkspaceRuns as _planWorkspaceRuns, dontTrackSessionIds,
  HistoryScope, ACCOUNT_TOKEN_UNUSABLE,
} from './session-audit.mjs';
import { BackfillHalt, isKeyMissing, KEY_MISSING_MESSAGE } from './audit-flush.mjs';
import { orDefault } from './compat.mjs';
import { AccountStatus, AcceptRefusal, describeAccount, getAccount, listAccounts, recordOffer, acceptOffer } from './accounts.mjs';
import { isMultiTenant, tenantById, newFoldersOf, NEW_FOLDERS_SOURCE } from './workspace.mjs';
import { usesRules, routeForDir, createRouteContext } from './workspace-rules.mjs';
import { anonymizationFor, kindsOf, isLaterChange } from './anonymization.mjs';
import {
  OfferState, OfferCheck, offerCheck, offerLines, questionText, declineLine, plural, CHANGED_LINE,
  offerToken, offerRecordOf, offerIdsOf, changedAtOf, offerTrackingDisabled,
} from './history-offer.mjs';
import { naming } from './paths.mjs';
import { workspaceIdOf, RunOutcome } from './pending-history.mjs';
import { runPendingHistory as _runPendingHistory, classifyRun } from './pending-history-run.mjs';
import { readTrackingState as _readTrackingState, TrackingMode } from './tracking.mjs';
import { HISTORY_WORKER_SCRIPT, offerWorkspaceIds } from './history-trigger.mjs';
import { spawnDetached } from './background-spawn.mjs';

// The sync command's three modes (offer, accept, decline) and the offer-scan worker. Past sessions go up only after a
// yes: the offer lists them (runAudit listOnly) and records the shown ids, and accept uploads exactly those ids.

// Checks 1–4 of offerCheck: the offer command skips these quietly with --past.
const QUIET_CHECKS = [OfferCheck.SKIP_CHOICE, OfferCheck.TRACKING_OFF, OfferCheck.DECLINED, OfferCheck.SETTLED];
const SCAN_CHECKS = [OfferCheck.SCAN, OfferCheck.SCAN_WAIT];
const BUSY_LINE = '✓ Beezi: another Beezi history run is using this machine right now — letting it finish.';
export const WRITER_BUSY_LINE = `✓ Beezi: Codex is still saving analytics on this machine, so nothing was listed this time. Run \`${naming.syncCommand()}\` again in a minute.`;
export const ACCEPT_BUSY_LINE = '✓ Beezi: your yes is saved, but this machine is busy, so nothing was uploaded yet. Beezi retries on its own.';
export const PENDING_UNREADABLE_TEXT = 'Beezi: could not read Codex’s pending analytics on this machine';
export const NO_NEW_LINE = `✓ Beezi: no new past sessions to offer. Run \`${naming.syncCommand()}\` to see every past session.`;
const NO_UPLOADS_TEXT = 'Beezi: this workspace does not accept history uploads on demand.';
// Codex's own writer is busy (a live checkpoint, or its transactions unfinished), not another upload.
const WRITER_REASONS = ['active-writer', 'pending-transaction'];

const union = (a, b) => Array.from(new Set(a.concat(b)));

function seams(deps) {
  return {
    runAudit: deps.runAudit == null ? _runAudit : deps.runAudit,
    planRuns: deps.planWorkspaceRuns == null ? _planWorkspaceRuns : deps.planWorkspaceRuns,
    readTrackingState: deps.readTrackingState == null ? _readTrackingState : deps.readTrackingState,
    runPendingHistory: deps.runPendingHistory == null ? _runPendingHistory : deps.runPendingHistory,
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
    return refusal(`Beezi: could not start the history sync (${orDefault(result.lastError, 'lock error')}).`);
  }
  if (result.reason === 'run-in-progress') return notice(BUSY_LINE);
  if (WRITER_REASONS.indexOf(result.reason) !== -1) return notice(WRITER_BUSY_LINE);
  if (result.reason === 'pending-unreadable') {
    return refusal(`${PENDING_UNREADABLE_TEXT} (${orDefault(result.lastError, 'unreadable')}). Nothing was listed or uploaded.`);
  }
  // Reports this machine built and Beezi has not received yet. Coverage would be stale by exactly
  // those segments, so the run stops rather than reconcile against an answer it knows is behind.
  if (result.reason === 'pending-not-drained') {
    return notice(
      '✓ Beezi: nothing was synced this time — some already-saved analytics have not reached Beezi '
      + `yet (${orDefault(result.lastError, 'delivery pending')}). They are queued on disk and retried `
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
      `Beezi: the server refused the upload (${orDefault(result.lastError, 'forbidden')}). `
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
    const reason = result.lastError ? ` (last error: ${result.lastError})` : '';
    console.log(
      `  ${plural(result.reportsFailed, 'report')} could not be delivered${reason} — run sync again to retry them.`,
    );
  }
  if (result.unreadable > 0) {
    console.log(`  ${plural(result.unreadable, 'session')} could not be read — not uploaded.`);
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
  return {
    notes: summary == null ? [] : [summary],
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

// A one-workspace account's routes carry no rule key, so its sessions are matched by folder, as each place's rule would match it.
function dirInPlaces(dir, places, ctx) {
  const workspaceRules = places.filter((p) => p.kind !== NEW_FOLDERS_SOURCE).map((p) => ({ kind: p.kind, match: p.match, tenantIds: ['w'] }));
  return typeof dir === 'string' && dir !== '' && routeForDir({ tenants: [{ id: 'w' }], workspaceRules }, dir, ctx) != null;
}

// The places a rule or New folders re-opened since the last decline or settle.
function reopenedPlaces(record) {
  const open = record.state === OfferState.RESCAN || record.state === OfferState.READY;
  return open && Array.isArray(record.places) ? record.places.filter((p) => p != null) : [];
}

// ── listing ────────────────────────────────────────────────────────────────────────────────

// The list-only run for one workspace. With past: a later changedAt re-opens the whole offer (its declines and places
// are cleared first); otherwise remembered declines are left out, and re-opened places limit the list to their sessions.
// → { result, narrowed: whether re-opened places limited the list }.
async function listWorkspace(row, run, { past, save, seam, runCache }) {
  const record = offerRecordOf(row, run.id);
  const selection = {};
  let places = [];
  if (past && record != null) {
    if (isLaterChange(changedAtOf(row, run.id), record.changedAt)) {
      await save(row.key, run.id, { declinedIds: [], places: [] });
    } else {
      selection.declinedSessionIds = offerIdsOf(record.declinedIds);
      places = reopenedPlaces(record);
      if (places.length > 0 && isMultiTenant(row)) {
        const routes = run.options.sessionRoutes == null ? seam.planRuns(row).routes : run.options.sessionRoutes;
        selection.onlySessionIds = Array.from(routes).filter(([, route]) => inPlaces(route, places)).map(([id]) => id);
      }
    }
  }
  const result = await seam.runAudit(
    { runCache },
    { ...run.options, ...selection, key: row.key, listOnly: true, scope: past ? HistoryScope.PAST : HistoryScope.ALL },
  );
  const narrowed = places.length > 0;
  // One workspace: the listed sessions are narrowed to the re-opened folders, so the shown ids are what accept uploads.
  if (!narrowed || isMultiTenant(row) || !Array.isArray(result.listed)) return { result, narrowed };
  const ctx = createRouteContext();
  return { result: { ...result, listed: result.listed.filter((s) => dirInPlaces(s.cwd, places, ctx)) }, narrowed };
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

// SETTLED under `changedAt`, unless the fresh record is a question printed under it meanwhile.
const settleUnlessAsked = (changedAt) => (fresh) => (
  fresh != null && fresh.state === OfferState.DECLINED && !isLaterChange(changedAt, fresh.changedAt)
    ? null
    : { state: OfferState.SETTLED, changedAt }
);

// One workspace's offer: → { offered: 0|1, status }.
async function offerWorkspace(row, run, ctx) {
  if (ctx.past && QUIET_CHECKS.indexOf(checkOf(row, run, ctx.seam)) !== -1) return { offered: 0, status: 0 };
  if (run.heading) console.log(`\n— ${describeAccount(row)} · ${workspaceName(row, run.id)} —`);
  const changedAt = changedAtOf(row, run.id);
  const { result, narrowed } = await listWorkspace(row, run, ctx);
  const stop = stopLine(result, row.key);
  if (stop != null) return { offered: 0, status: printStop(stop) };
  // A busy run lists nothing, and is not "nothing to offer".
  if (!Array.isArray(result.listed)) {
    console.log(WRITER_BUSY_LINE);
    return { offered: 0, status: 0 };
  }
  // Session start and login stay quiet; sync prints the refusal.
  if (result.trackingMode === TrackingMode.DISABLED) {
    await ctx.save(row.key, run.id, settleUnlessAsked(changedAt));
    return { offered: 0, status: ctx.past ? 0 : printStop({ text: NO_UPLOADS_TEXT, error: true }) };
  }
  if (result.listed.length === 0) {
    if (ctx.past) await ctx.save(row.key, run.id, settleUnlessAsked(changedAt));
    console.log(emptyListLine(result, narrowed));
    return { offered: 0, status: 0 };
  }
  const summary = summaryOf(result);
  const offeredIds = result.listed.map((s) => s.sessionId);
  const shownKinds = kindsOf(anonymizationFor(row, run.id));
  // Shown is a decline until the developer says yes (K6): this is the only place a shown question records one.
  await ctx.save(row.key, run.id, (fresh) => {
    const remembered = fresh == null || isLaterChange(changedAt, fresh.changedAt) ? [] : offerIdsOf(fresh.declinedIds);
    return {
      state: OfferState.DECLINED, changedAt, offeredIds, declinedIds: union(remembered, offeredIds), shownKinds, summary,
      override: run.override === true,
    };
  });
  const lines = offerLines({ n: summary.n, firstMs: summary.firstMs, lastMs: summary.lastMs, folders: summary.folders, kinds: shownKinds });
  for (const line of lines) console.log(line);
  // A preview asks nothing: with no question there is nothing to accept.
  if (ctx.dryRun) return { offered: 0, status: 0 };
  console.log(`Q ${questionText(summary.n, workspaceName(row, run.id))}`);
  console.log(`offer account=${row.key} tenant=${run.id} sessions=${summary.n} audit=${summary.audit ? 'yes' : 'no'} token=${offerToken(offeredIds, shownKinds)}`);
  return { offered: 1, status: 0 };
}

async function offerRows(key) {
  if (key != null) return [orDefault(await getAccount(key), { key })];
  const linked = (await listAccounts()).filter((a) => a.status === AccountStatus.LINKED);
  // Nothing linked: one unscoped run, so runAudit answers 'no-token' for the machine as it always has.
  return linked.length === 0 ? [{ key: null }] : linked;
}

// Lists each workspace's past sessions with the K7 summary and its question, records the decline, and ends `offers=<n>`.
// dryRun records nothing and prints the summary without its question. → { offers, status }.
export async function offerCommand({ key = null, past = false, tenantIds = [], dryRun = false }, deps = {}) {
  const seam = seams(deps);
  const save = dryRun ? async () => null : (k, id, patch) => recordOffer(k, id, patch);
  const ctx = { past, save, seam, runCache: createRunCache(), dryRun };
  const rows = await offerRows(key);
  let offers = 0;
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
    for (const run of plan.runs) {
      const done = await offerWorkspace(row, run, ctx);
      offers += done.offered;
      status = Math.max(status, done.status);
    }
  }
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

function printProgress({ processed, total }) {
  console.log(`Beezi: ${processed}/${total} sessions read…`);
}

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
    console.log(`✓ Beezi: uploading ${plural(ids.length, 'past session')} to ${workspaceName(row, tenantId)} in the background.`);
    return 0;
  }
  const options = { key, splitByRules: !isMultiTenant(row) && usesRules(row) };
  const runAudit = (auditDeps, auditOptions) => seam.runAudit({ ...auditDeps, onProgress: printProgress }, auditOptions);
  let status = 0;
  let ran = false;
  const onResult = (entry, result) => {
    ran = true;
    if (result == null) {
      console.error('✗ Beezi: the upload stopped with an error. Beezi tries it again at the next session start.');
      status = 1;
      return;
    }
    // A busy run keeps the accepted entry for the next retry.
    if (classifyRun(result, false) === RunOutcome.BUSY) {
      console.log(ACCEPT_BUSY_LINE);
      return;
    }
    status = Math.max(status, printRunResult(result, options));
  };
  await seam.runPendingHistory(key, { ...deps, runAudit }, { tenantIds: [tenantId], onResult });
  if (ran) return status;
  // No run: no rule or New folders setting sends sessions to this workspace any more.
  console.error(
    `✗ Beezi: nothing was uploaded — no rule or New folders setting sends these sessions to ${workspaceName(row, tenantId)} now. `
    + `Run \`${naming.syncCommand()}\` to see what would be sent.`,
  );
  return 1;
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
