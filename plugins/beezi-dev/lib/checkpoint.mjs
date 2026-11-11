import { fetchCompat } from './fetch-compat.mjs';
import fs from 'fs';
import { orDefault } from './compat.mjs';
import path from 'path';
import { computeDelta as _computeDelta, resumeFields, resumeFromFields } from './delta-codex.mjs';
import { createTranscriptMemo } from './transcript-memo-codex.mjs';
import { linkedSessions as _linkedSessions, listAccountsSync, AccountStatus } from './accounts.mjs';
import { queueDir, stateDir, beeziCodexHome } from './paths.mjs';
import { git, currentBranch, resolveOriginRemote } from './git.mjs';
import { readCheckoutEvents, buildBranchTimeline, branchAt as branchAtReflog } from './reflog.mjs';
import { resolveRepoRoot } from './repo-timeline.mjs';
import { resolveCodexTranscript, isUsableSessionId } from './transcript-codex.mjs';
import { resolveRolloutPath } from './rollout-file.mjs';
import { POST_TIMEOUT_MS } from './http.mjs';
import { HOOK_TIMEOUT_SEC } from './hooks-install.mjs';
import { postSessionError, sessionErrorBody } from './session-error-report.mjs';
import { hidesSessions, markPrivate, privateKinds } from './anonymization.mjs';
import { computeSessionTimeline, postSessionTimeline, parseTranscript } from './session-timeline-codex.mjs';
import { handoffPlanText, findPlanPredecessor as _findPlanPredecessor } from './plan-handoff-codex.mjs';
import { isTimelineUserPrompt } from './timeline-waits-codex.mjs';
import { recordRateLimitObservations } from './rate-limits-codex.mjs';
import { readChatgptIdentity } from './chatgpt-identity.mjs';
import { drainRateLimitSnapshots as _drainRateLimitSnapshots } from './usage-report-codex.mjs';
import { isApiKeyBillingEvidence, isSubscriptionBillingEvidence } from './billing.mjs';
import {
  readBillingConfig,
  writeBillingConfig,
  resolveBilling,
  recordApiKeyEvidence,
  recordSubscriptionEvidence,
} from './billing-config.mjs';
import {
  resolveSessionName as _resolveSessionName, sanitizeSessionName, sessionNameFrom, sessionNameFromRecords,
} from './session-name-codex.mjs';
import { readJson, writeJsonDurable, safeFileName } from './fs-store.mjs';
import {
  isLiveTrackingAllowed, readTrackingState, allowsLiveFor, isTenantDark, workspaceLinkMs,
} from './tracking.mjs';
import { readSessionWorkspace, resolveTargets, isMultiTenant } from './workspace.mjs';
import { enqueue as enqueueCopy, enqueueHeld } from './workspace-queue.mjs';
import {
  bindSessionRoutes, createRouteContext, routeForDir, routeForSegment, routePastSession, rulesOf, usesRules,
} from './workspace-rules.mjs';
import { acquireLock, sessionLock } from './single-instance-lock.mjs';
import { recordIssue, DIAGNOSTIC_CODES, DIAGNOSTIC_SOURCES } from './diagnostics.mjs';
import { bindInstallationForSessions } from './installation-binding.mjs';
import { loadRepoMap, saveRepoMap, upsertRoot, knownOrigin, originFromGitConfig } from './repo-map.mjs';
import { mergeIntervals, subtractIntervals, totalMs, claimIntervals } from './active-time.mjs';
import { probeProjectInstructions } from './project-instructions.mjs';
import { readAgents as _readAgents, writeAgent as _writeAgent } from './subagent-state.mjs';
import { markUploadDue as _markUploadDue } from './upload-due.mjs';
import { createGitMemo } from './session-git-memo.mjs';
import { maybeSpawnUploadWorker as _maybeSpawnUploadWorker } from './upload-trigger.mjs';
import {
  inspectSubagentRollout as _inspectSubagentRollout,
  findSubagentRollouts as _findSubagentRollouts,
  rolloutStartedAt as _rolloutStartedAt,
  canonicalizeAgents,
} from './subagent-codex.mjs';

function loadState(id) {
  return readJson(path.join(stateDir(), `${id}.json`), {
    cursor: 0,
    sentSessionName: null,
    anchor: null,
  });
}

function saveState(id, state) {
  writeJsonDurable(path.join(stateDir(), `${id}.json`), state);
}

// Set the state's byte-cursor fields from `resume`, or delete them for null. True when they changed.
function applyResumeFields(state, resume) {
  const fields = resumeFields(resume);
  let changed = false;
  for (const key of Object.keys(fields)) {
    const value = fields[key];
    if (value === null) {
      if (state[key] !== undefined) { delete state[key]; changed = true; }
    } else if (JSON.stringify(state[key]) !== JSON.stringify(value)) {
      state[key] = value;
      changed = true;
    }
  }
  return changed;
}

// When a rollout started, from the whole read this run already holds for it, else from its head.
function startedAtFromMemo(memo, transcriptPath) {
  const lines = typeof memo.peek === 'function' ? memo.peek(transcriptPath) : null;
  if (!lines) return _rolloutStartedAt(transcriptPath);
  for (const rec of lines.records) {
    if (!rec) continue;
    const ms = Date.parse(orDefault(rec.timestamp, ''));
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

// ONE payload, one copy per account that is allowed to receive it.
//
// The delta is computed once and the same bytes are written into every allowed account's queue,
// because the work happened once and every linked workspace is owed the same account of it. The
// copies then live independent lives: each drains under its own bearer, and one tenant's 403 or
// 404 is a verdict on that tenant's copy alone.
//
// workspace-queue.mjs's enqueue(key, payload, tenantId, opts), also taking the older array of keys.
export function enqueue(keys, payload, tenantId = null, opts = {}) {
  for (const key of Array.isArray(keys) ? keys : [keys]) enqueueCopy(key, payload, tenantId, opts);
}

// Every LINKED account the payloads are owed to. One whose token is momentarily unavailable is
// kept, tokenless: its copies wait in its queue and only its network work is skipped, so the
// cursor never moves past data it did not receive. listAccountsSync, because linkedSessions has
// already run readIndex's migration, and a second readIndex would probe the keyring again.
export async function listRecipients(sessions, deps) {
  let rows = [];
  try { rows = orDefault(await orDefault(deps.listAccounts, listAccountsSync)(deps), []); } catch { rows = []; }
  const byKey = new Map(sessions.map((session) => [session.key, session]));
  for (const row of rows) {
    // The row's own tenantId is the web-side workspace; it never becomes a header.
    if (row && row.status === AccountStatus.LINKED && !byKey.has(row.key)) {
      byKey.set(row.key, { ...row, tenantId: null, token: null });
    }
  }
  return [...byKey.values()];
}

// The route a segment with no rule of its own follows: the one bound on the session, or, with no
// session state, the rule binding would pick for the session's cwd.
function sessionRouteOf(session, workspaceState, cwd, routeCtx) {
  if (workspaceState != null) return orDefault(workspaceState.route[session.key], null);
  return cwd ? routeForDir(session, cwd, routeCtx) : null;
}

// True for a workspace whose max(linkedAt, joinedAt) is at or before `writtenAtMs`, memoized per tenant; always true without a number.
function linkedBy(session, tracking, writtenAtMs) {
  if (typeof writtenAtMs !== 'number') return () => true;
  const deps = { readTrackingStateImpl: () => tracking };
  const cutoffs = new Map();
  return (tenantId) => {
    if (!cutoffs.has(tenantId)) {
      let cutoff = null;
      try { cutoff = workspaceLinkMs({ ...session, tenantId }, tenantId, deps); } catch { cutoff = null; }
      cutoffs.set(tenantId, cutoff);
    }
    const cutoff = cutoffs.get(tenantId);
    return cutoff != null && cutoff <= writtenAtMs;
  };
}

// Per account, where this session's payloads go: `targets` (live workspaces; [null] = no header)
// and `hold` (the workspaces an unanswered Ask may still pick). A `routed` account re-answers per
// segment in segmentPlan, so one with rules stays a recipient even when the session itself sends
// nowhere: a segment in a ruled repo may still go somewhere. A preset tenantId (a backfill run's
// own workspace) counts on an account in several workspaces only. An account whose tracking policy
// is dark gets nothing enqueued at all, which keeps a dark tenant's queue from growing for three
// days only to expire (see QUEUE_HOLD_MS). A `writtenAtMs` drops every workspace linked or joined
// after the session's last write, held copies included.
function planRecipients(recipients, { workspaceState, cwd, skipGate, unrouted, routeCtx, writtenAtMs }) {
  const plans = [];
  let policyGated = false;
  let darkGated = false;
  for (const session of recipients) {
    // Fail OPEN on an unreadable policy, the posture lib/tracking.mjs documents.
    let tracking = null;
    try { tracking = readTrackingState(session.key); } catch { tracking = null; }
    const multi = isMultiTenant(session);
    const linked = linkedBy(session, tracking, writtenAtMs);
    const live = (tenantId) => (skipGate || allowsLiveFor({ ...session, tenantId }, tracking)) && linked(tenantId);
    const holdable = (tenantId) => !isTenantDark(tracking, tenantId) && linked(tenantId);
    const preset = multi && typeof session.tenantId === 'string' && session.tenantId !== '' ? session.tenantId : null;
    const r = resolveTargets(session, workspaceState);
    const targets = (preset == null ? r.targets : [preset]).filter((t) => live(t));
    const hold = preset == null && r.pendingAsk ? r.askTenants.filter(holdable) : [];
    // `unrouted` only means something for a preset workspace, and only multi-workspace runs have
    // one: a one-workspace history run (sync, backfill, the watcher's repair pass) never passes
    // sessionRoutes, so it must still route per segment (I-1) rather than fall back to the
    // session-level plan.
    const routed = usesRules(session) && (!multi || unrouted !== true);
    // The keep-plan exception must not un-gate an account that cannot currently send live: a
    // one-workspace row in backfill_only/disabled mode with a rule would otherwise keep a plan
    // whose every segment live(null) filters out, skipping the dark gate below (I-2).
    if (targets.length === 0 && hold.length === 0 && !(routed && rulesOf(session).length > 0 && (multi || live(null)))) {
      if (preset == null && (r.source === 'rule' || r.source === 'none') && r.targets.length === 0 && !r.pendingAsk) policyGated = true;
      else darkGated = true;
      continue;
    }
    // A history run (preset) falls back to the session's route under the CURRENT rules, as the
    // backfill planner routes it; a live run follows the route bound on the session. Kept for an
    // unrouted run too, where it only answers presetRouted.
    const pastRoute = preset != null
      ? routePastSession(session, { state: workspaceState, readCwd: () => orDefault(cwd, null) }, routeCtx)
      : null;
    const sessionRoute = routed && preset == null ? sessionRouteOf(session, workspaceState, cwd, routeCtx) : null;
    plans.push({ session, multi, live, holdable, preset, targets, hold, routed, sessionRoute, pastRoute });
  }
  return { plans, policyGated, darkGated };
}

// Whether the CURRENT rules send a segment to a history run's preset workspace (Ruling 11): its own
// directory's rule, else the session's past route. True without a preset.
function presetRouted(plan, dir, routeCtx) {
  if (plan.pastRoute == null) return true;
  const own = routeForDir(plan.session, dir, routeCtx);
  const ids = own != null
    ? resolveTargets(plan.session, { route: { [plan.session.key]: own } }).targets
    : plan.pastRoute.tenantIds;
  return ids.indexOf(plan.preset) !== -1;
}

// One segment's destinations for one account: the rule of the segment's own directory, else the
// session's route, else New folders. A preset workspace keeps only what routes to it.
function segmentPlan(plan, dir, routeCtx) {
  if (!plan.routed) return plan;
  if (plan.pastRoute != null) {
    return { targets: presetRouted(plan, dir, routeCtx) && plan.live(plan.preset) ? [plan.preset] : [], hold: [] };
  }
  const route = routeForSegment(plan.session, dir, plan.sessionRoute, routeCtx);
  const r = resolveTargets(plan.session, { route: { [plan.session.key]: route } });
  const targets = r.targets.filter((t) => plan.live(t));
  if (plan.preset != null) return { targets: targets.indexOf(plan.preset) === -1 ? [] : [plan.preset], hold: [] };
  return { targets, hold: r.pendingAsk ? r.askTenants.filter(plan.holdable) : [] };
}

// Each plan's destinations for one segment.
function routeSegment(plans, dir, routeCtx) {
  return plans.map((plan) => ({ ...segmentPlan(plan, dir, routeCtx), session: plan.session, multi: plan.multi }));
}

// The payload with each workspace it reaches added to its marker, under the kinds on there now.
function markForSegment(payload, routes) {
  return markPrivate(payload, privateKinds(routes));
}

// A copy per target workspace, plus one held copy while an Ask is unanswered. `dir` is the
// segment's directory (null = the session's own route); `routes` is its routeSegment answer, computed here when absent.
function emitToPlans(plans, routeCtx) {
  const emit = (payload, dir, routes) => {
    const segmentRoutes = routes != null ? routes : routeSegment(plans, dir, routeCtx);
    const marked = markForSegment(payload, segmentRoutes);
    for (const { session, multi, targets, hold } of segmentRoutes) {
      for (const tenantId of targets) { enqueueCopy(session.key, marked, tenantId, { multi }); emit.copies += 1; }
      if (hold.length > 0) enqueueHeld(session.key, marked, hold, { version: 1, dir });
    }
  };
  // Copies actually written to a queue, for `track` (M-1): `enqueued` counts built payloads, not
  // routed ones, and a payload every plan excludes (a Don't-track rule) must not read as "saved".
  emit.copies = 0;
  return emit;
}

// A row merge is skipped when a caller hands in its own sessions (the backfill does), unless it
// hands in the rows too.
const mergesRows = (deps) => deps.listAccounts != null || deps.linkedSessions == null;

const transactionFile = id => path.join(beeziCodexHome(), 'checkpoint-transactions', `${safeFileName(id)}.json`);

function readTransaction(id) {
  let raw;
  try { raw = fs.readFileSync(transactionFile(id), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const tx = JSON.parse(raw);
  if (!tx || tx.version !== 1 || tx.sessionId !== id || !Array.isArray(tx.payloads)
    || !Array.isArray(tx.children) || !tx.state) throw new Error('Invalid checkpoint transaction');
  return tx;
}

// `routes` (in memory only, never on `tx`) carries each payload's routes when this run computed them.
function commitTransaction(tx, lock, emit, deps, durable, routes = []) {
  const own = () => { if (!stillOwnsSession(lock)) throw new Error('Checkpoint ownership lost'); };
  own();
  // Each payload's segment directory, so a replay routes it afresh; absent in older transactions.
  const dirs = Array.isArray(tx.dirs) ? tx.dirs : [];
  for (const [i, payload] of tx.payloads.entries()) { own(); emit(payload, orDefault(dirs[i], null), routes[i]); }
  if (durable) {
    for (const child of tx.children) {
      own();
      orDefault(deps.writeAgent, _writeAgent)(tx.sessionId, child.agentId, child.state);
    }
    own();
    orDefault(deps.saveState, saveState)(tx.sessionId, tx.state);
    own();
    fs.unlinkSync(transactionFile(tx.sessionId));
  }
  return { parent: tx.state.cursor, children: tx.children.map(c => ({ agentId: c.agentId, cursor: c.state.cursor })) };
}

// Stand-in "remote" for work with no git origin behind it — a directory that isn't a repo, or a
// repo with no origin. Only the folder name travels, never the path around it, and the `local:`
// prefix keeps it from ever canonicalizing onto a real remote server-side.
function localRemote(dir) {
  if (!dir) return null;
  const name = path.basename(dir);
  return name ? `local:${name}` : null;
}

// Server-side DTO caps (`session-report.request.dto.ts` in the hb-ai-agent-portal repo). One
// over-long field 400s the whole request, and flushQueue treats a 400 as permanent: it deletes that
// queue file and moves on, so the segment is gone rather than retried. `branch` is required, so it
// is truncated rather than dropped — a truncated ref still names the work recognisably, an empty
// one fails validation too.
//
// `remote` stays unclamped on purpose: a truncated remote would fabricate a repo key that matches
// nothing server-side, which is worse than the 400. Do not extend this by copy-paste.
const BRANCH_MAX = 255;
const clamp = (value, max) =>
  (typeof value === 'string' && value.length > max ? value.slice(0, max) : value);

// The machine's IANA timezone (e.g. Europe/Kyiv). Snapshotted per checkpoint so the server can
// bucket this session's activity in the user's local time even if they later travel. Null when
// the runtime can't resolve one — the field is then omitted from the payload.
function detectTimezone() {
  try {
    return orDefault(Intl.DateTimeFormat().resolvedOptions().timeZone, null);
  } catch {
    return null;
  }
}

// How long a checkpoint run may spend before it must be finished. Codex kills a hook at the
// timeout it registered and reports the kill as a failed hook — which is what "Stop hook failed
// (exit code 1)" alongside perfectly good analytics means: the work landed, the process was still
// running. The margin covers what is not network here (git shell-outs, transcript parsing, state
// writes) plus node's own startup.
export const HOOK_BUDGET_MS = HOOK_TIMEOUT_SEC * 1000 - 2500;

// Lease for the per-session checkpoint transaction. Comfortably above HOOK_BUDGET_MS so a hook
// never has to renew, and short enough that a hard-killed hook does not block the next tool call
// for long — a dead holder is evicted the moment its lease lapses, because the liveness probe
// answers "gone" rather than buying it the extra grace a live one gets.
//
// It is deliberately NOT sized for the manual `track` path, which passes no budget and drains the
// whole queue with no deadline. That work happens AFTER the state write and cannot be raced into
// anything, so an expiry there is harmless; what protects the state write itself is the ownership
// check immediately before it, not the length of the lease.
export const SESSION_LOCK_LEASE_MS = 60_000;

// Do we still own the session lock, and may this transaction commit?
//
// Three outcomes from the primitive, and collapsing any two of them is a bug:
//   ok        — the record on disk is this acquisition's. Commit.
//   'expired' — still ours, just past our own lease. Nobody took it (a takeover would have replaced
//               the generation), so renew and commit. The manual `track` path has no budget and
//               routinely outlives a lease while draining a backlog.
//   'lost'    — a different generation is on disk: somebody else owns this session and is mid
//               transaction. ABORT the commit, per the module contract.
function stillOwnsSession(lock) {
  const seen = lock.verify();
  if (seen.ok) return true;
  if (seen.reason !== 'expired') return false;
  return lock.renew({ leaseMs: SESSION_LOCK_LEASE_MS }).ok;
}

// Bill every subagent of this session, from the parent's own checkpoint.
//
// One process does all of it on purpose. The alternative — each SubagentStop hook billing its own
// agent — has N+1 processes read-modify-writing the same coverage ledger at the moment a fan-out
// ends, and whichever loses the race silently drops its claim. Here the union is computed in a single
// pass with a deterministic order, and the hooks are reduced to recording identity (see
// scripts/subagent-stop.mjs).
//
// Agents come from two places: the sidecars the hooks wrote, and — on turn ends only — a bounded
// sweep of the rollout tree, which is what keeps this working on a machine where the hooks were never
// trusted and on the hookless `track` path.
// Returns { apiErrorEvents, agents } — `agents` is the merged sidecar+sweep map, handed back so the
// timeline can build its spans from it instead of re-reading the same directory.
function ingestSubagents({
  sessionId, parentTranscriptPath, computeDelta, resolvers, enqueueSegments, sweep, persist = true, recovery = false,
  childFill = null, deps = {},
}) {
  const readAgents = orDefault(deps.readAgents, _readAgents);
  // Not a fallback: runCheckpoint always injects one (it redirects the child write into the
  // transaction it is about to commit), so a default here would only ever mask a miswired caller.
  const writeAgent = deps.writeAgent;
  const inspectRollout = orDefault(deps.inspectSubagentRollout, _inspectSubagentRollout);
  const findRollouts = orDefault(deps.findSubagentRollouts, _findSubagentRollouts);
  const startedAt = orDefault(deps.rolloutStartedAt, _rolloutStartedAt);
  const apiErrorEvents = [];
  let childDeferred = false;
  let childrenSkipped = 0;

  let agents;
  try { agents = readAgents(sessionId); } catch { agents = {}; }
  // A sidecar path recorded while the rollout was plain (or compressed) goes stale when Codex
  // compresses or resumes it; follow the file to its current name, else keep the recorded value.
  for (const agentId of Object.keys(agents)) {
    const record = agents[agentId];
    if (record && typeof record.transcriptPath === 'string') {
      record.transcriptPath = orDefault(resolveRolloutPath(record.transcriptPath), record.transcriptPath);
    }
  }

  if (sweep) {
    try {
      // The parent's own start bounds the scan: a subagent cannot predate the session that spawned
      // it. Without it this walks every rollout the machine has ever written.
      const since = startedAt(parentTranscriptPath);
      for (const { agentId, path: rolloutPath } of findRollouts(sessionId, { sinceMs: since })) {
        if (!agents[agentId]) agents[agentId] = { agent_id: agentId };
        if (agents[agentId].transcriptPath === undefined || agents[agentId].transcriptPath === null) {
          agents[agentId].transcriptPath = rolloutPath;
        }
      }
    } catch { /* best-effort: the sidecars are still authoritative */ }
  }

  // Rollouts that have not changed since their cursor was saved: the same size and mtime as the stat
  // that read was bounded by. Re-reading one can only reproduce the window already billed, so it is
  // skipped outright — no head read, no delta — and its saved inspection stands in for the head read
  // canonicalizeAgents would do. Keyed by PATH, so a second sidecar key for the same file (a hook's
  // agent_id beside the rollout's own id) folds onto it and is skipped with it instead of being
  // billed from the fork boundary. Live runs only: the history fill bills children whole.
  const unchanged = new Map();
  if (persist && !childFill) {
    for (const agentId of Object.keys(agents)) {
      const record = agents[agentId];
      if (!record || typeof record.transcriptPath !== 'string' || unchanged.has(record.transcriptPath)) continue;
      if (!Number.isInteger(record.cursor) || !isSavedInspection(record.inspected)) continue;
      let stat;
      try { stat = fs.statSync(record.transcriptPath); } catch { continue; }
      if (stat.size === record.size && stat.mtimeMs === record.mtimeMs) unchanged.set(record.transcriptPath, record.inspected);
    }
  }
  const inspect = (rolloutPath) => (unchanged.has(rolloutPath) ? unchanged.get(rolloutPath) : inspectRollout(rolloutPath));

  // Deterministic order so the coverage union is reproducible across runs.
  const ordered = Object.entries(agents).sort((a, b) => {
    const at = Date.parse(orDefault((a[1] || {}).started_at, '')) || 0;
    const bt = Date.parse(orDefault((b[1] || {}).started_at, '')) || 0;
    return at - bt || String(a[0]).localeCompare(String(b[0]));
  });

  // Canonicalize before billing: one entry per rollout FILE, keyed by the id the rollout states
  // about itself. A sidecar and the sweep can key the SAME file differently — Codex documents
  // `agent_id` only as "Identifier for the subagent" — and two keys mean two cursors and two
  // non-colliding segment ids, which the server `segmentId::model` upsert cannot collapse. This
  // also folds in the skips the loop used to do inline: no transcript path, unreadable, not a
  // subagent, or a fork whose replayed prefix could not be delimited. See canonicalizeAgents.
  for (const { agentId, record, rolloutPath, inspected } of canonicalizeAgents(ordered, inspect)) {
    // The history fill (lib/session-audit.mjs, sync) sends a child WHOLE, from its fork boundary,
    // which supersedes narrower live windows on the server — but only windows already stored. So a
    // child live capture still owns stays with live capture: one with a durable cursor is its to
    // deliver, and one whose rollout is still being written would gain a narrow live window AFTER
    // the whole one, which nothing retires. Counted, so the run can say what it left.
    if (childFill) {
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(rolloutPath).mtimeMs; } catch { /* unreadable: computeDelta reports it */ }
      if (Number.isInteger((record || {}).cursor) || mtimeMs > childFill.activeSinceMs) {
        childrenSkipped += 1;
        continue;
      }
    }
    if (recovery && (!persist || !Number.isInteger(record.cursor))) {
      childDeferred = true;
      continue;
    }
    if (unchanged.has(rolloutPath)) continue;
    // The import ignores stored cursors on purpose: a dark-mode tenant's live hooks advanced
    // them while every report was 403-dropped, so honoring them would bill only session tails.
    const stored = persist && Number.isInteger((record || {}).cursor);
    const from = stored ? record.cursor : inspected.forkBoundaryLine;
    let delta;
    try {
      // A saved byte cursor lets a growing child be read from where its last window ended.
      delta = computeDelta(rolloutPath, from, { ...resolvers, resume: stored ? resumeFromFields(record) : null });
    } catch { throw new Error('Child transcript could not be read'); }

    // segmentId is scoped by agent id because the server's idempotency key is `segmentId::model` and
    // does NOT include agent_id. Two agents both starting at their own fork boundary produce
    // identical line windows, so without this scope the second would overwrite the first.
    enqueueSegments(delta.segments, `${sessionId}:${agentId}`, {
      is_subagent: true,
      agent_id: String(agentId).slice(0, 200),
      agent_type: record && record.agent_type ? String(record.agent_type).slice(0, 100) : null,
      agent_name: inspected.agentNickname ? String(inspected.agentNickname).slice(0, 200) : null,
      // Omitted rather than nulled when it is not a non-negative integer — the field is optional and
      // the clamp keeps a malformed value out of the payload entirely.
      ...(Number.isInteger(inspected.spawnDepth) && inspected.spawnDepth >= 0
        ? { spawn_depth: inspected.spawnDepth }
        : {}),
    });

    // An agent that dies on an API error never ends the parent's turn, so no Stop fires for it and
    // its own rollout is the only record that the failure happened.
    apiErrorEvents.push(...orDefault(delta.apiErrorEvents, []));

    if (persist) {
      const saved = childCursorFields(delta, inspected);
      if (delta.nextCursor !== from || childFieldsChanged(record, saved)) {
        writeAgent(sessionId, agentId, { cursor: delta.nextCursor, transcriptPath: rolloutPath, ...saved });
      }
    }
  }

  return { apiErrorEvents, agents, childDeferred, childrenSkipped };
}

// An inspection saved with a child cursor, as inspectSubagentRollout returned it.
function isSavedInspection(inspected) {
  return !!inspected && typeof inspected === 'object'
    && Number.isInteger(inspected.forkBoundaryLine) && inspected.forkBoundaryLine >= 0;
}

// What a child cursor is saved with: the size and mtime of the file the delta read (the unchanged
// test above), the inspection that stands in for the head read when it passes, and the byte cursor.
// Null fields rather than absent ones, so the merge-writer clears what a previous run saved.
function childCursorFields(delta, inspected) {
  const source = orDefault(delta.source, {});
  return {
    size: Number.isInteger(source.size) ? source.size : null,
    mtimeMs: typeof source.mtimeMs === 'number' ? source.mtimeMs : null,
    inspected,
    ...resumeFields(delta.resume),
  };
}

function childFieldsChanged(record, saved) {
  const keys = Object.keys(saved);
  for (let i = 0; i < keys.length; i++) {
    const before = (record || {})[keys[i]];
    if (JSON.stringify(before === undefined ? null : before) !== JSON.stringify(saved[keys[i]])) return true;
  }
  return false;
}

// Cap on error reports carried forward in session state. An error whose POST missed the hook
// budget is unrecoverable once the cursor advances, so it is parked rather than dropped — but a
// machine that can never reach the server must not grow its state file forever. Newest wins.
const MAX_PENDING_ERRORS = 20;

const isPlainRecord = (value) => value != null && typeof value === 'object' && !Array.isArray(value);

// The session-error body an API error event becomes.
function errorPayloadOf(event, sessionId) {
  return {
    sessionId,
    error: orDefault(event.error, 'unknown'),
    errorDetails: orDefault(event.details, null),
    lastAssistantMessage: orDefault(event.text, null),
    occurredAt: orDefault(event.occurredAt, new Date().toISOString()),
    ...(event.resetsAt ? { resetsAt: event.resetsAt } : {}),
  };
}

// A parked error keeps no free text once a target hides sessions — but each target it still owes
// is parked its OWN body, made by the transform postSessionError applies for that target
// (sessionErrorBody): scrubbed for a workspace that hides sessions, capped for one that does not.
// A non-hiding workspace beside a hiding one therefore still receives the text, which a local-only
// run (it parks every error) would otherwise lose for good once the cursor moves; the state file
// holds no unscrubbed text for a hiding target. A body already parked is put through the target's
// CURRENT transform again (both are idempotent), so a workspace that turned hiding on since has its
// text scrubbed at rest now, not at delivery; a target added since is built from what the event
// still holds. Bodies for targets that took it are dropped.
function parkedForTargets(event, senders, sessionId) {
  const { text, details, bodies: stored, ...rest } = event;
  const deliveredTo = Array.isArray(event.deliveredTo) ? event.deliveredTo : [];
  const before = isPlainRecord(stored) ? stored : {};
  const payload = errorPayloadOf(event, sessionId);
  const bodies = {};
  for (const session of senders) {
    const target = `${session.key}:${session.tenantId}`;
    if (deliveredTo.indexOf(target) !== -1 || bodies[target]) continue;
    bodies[target] = sessionErrorBody(isPlainRecord(before[target]) ? before[target] : payload, session);
  }
  return { ...rest, bodies };
}

// `deps` holds substitutable implementations (test seams); `options` holds caller-driven execution
// modes. Keeping them separate stops a behavior flag from masquerading as an injectable.
// Returns { enqueued, flush, sessionErrors, skipped, rateLimits, agents } — flush is the flushQueue
// summary (or null when it never ran), and rateLimits is { posted, deferred } from the rate-limit
// drain (or null when that never ran). A checkpoint that could not take its session lock returns
// { lockSkipped: true, lockReason } instead of doing any work.
// `options.budgetMs` bounds the network work: hooks pass it, the CLI (track.mjs) does not, because
// a user waiting at a terminal would rather see the whole queue drained than a partial flush.
//
// `options.localOnly` is the hooks' mode (I-local): capture to disk and hand off. No credential
// read (linkedSessions is never called and `options.sessions` is ignored — every linked account is
// a tokenless recipient, see listRecipients) and no network of any kind: errors stay parked, and
// the timeline, the rate-limit drain, the queue flush and the installation binding are all left to
// the upload worker. Once the session lock is released the session is marked due (with `timeline`
// = `options.emitTimeline`) and the upload trigger is asked to start a worker; the result then
// carries `uploadDue` (the marker was written) and `uploadTrigger` (the trigger's answer).
// `emitTimeline` still drives the subagent sweep, which is capture, not delivery.
export async function runCheckpoint(input, deps = {}, options = {}) {
  // RAW, and used exactly once — to derive `sessionId` below. Every DURABLE key here comes from
  // that one instead: state/<id>.json, the segmentId, the queue filename that segmentId becomes,
  // and the sessionId on the wire. `${null}.json` is `state/null.json`, ONE file shared by every
  // id-less session on the machine, and `${null}:1-18` is a segmentId the server accepts under a
  // phantom session literally named "null". See G-3-1.
  const { session_id, cwd } = input;
  const now = orDefault(deps.now, Date.now);
  const deadline = options.budgetMs ? now() + options.budgetMs : null;
  const timeLeft = () => (deadline === null ? null : deadline - now());
  const collectedErrors = [];
  // Why segments did not become reports. A caller that gets zero reports cannot otherwise tell a
  // session that genuinely holds no usage (a transcript with no assistant tokens — nothing to
  // upload, and nothing wrong) from one we dropped for a reason worth reporting. Only the
  // problem cases are counted: "no usage" is the absence of all of them.
  const skipped = { noRemote: 0, emitFailed: 0, deltaFailed: false };
  const emptyResult = () => ({ outcome: 'deferred', reason: 'not-checkpointed', committedBoundaries: null, enqueued: 0, flush: null, sessionErrors: collectedErrors, skipped });
  // PostToolUse and Stop carry `transcript_path` (possibly null): resolveCodexTranscript uses it
  // when its session_meta names this session, and otherwise resolves the rollout from the session
  // id (a sessions-tree walk) or the cwd mapping in state. No resolvable transcript → nothing to
  // checkpoint.
  const resolveTranscript = orDefault(deps.resolveTranscript, resolveCodexTranscript);
  const resolved = resolveTranscript(input);
  if (!resolved) return emptyResult();
  const transcript_path = resolved.transcriptPath;
  // The hook's own id FIRST, the resolver's second — that order is load-bearing and not
  // interchangeable. resolveCodexTranscript falls through to findRolloutBySessionState, which
  // matches on `cwd` ALONE (lib/transcript-codex.mjs), so `resolved.sessionId` can name a PREVIOUS
  // session that ran in this directory. Preferring it over a perfectly usable hook id would bill
  // this session's segments, state file and wire id under that older session — a cross-session
  // mis-attribution strictly worse than the null-id bug being closed here. The resolver only gets
  // to answer when the hook did not, which is exactly the poisoned path.
  const sessionId = isUsableSessionId(session_id)
    ? session_id
    : (isUsableSessionId(resolved.sessionId) ? resolved.sessionId : null);
  // Refuse rather than write under a name we do not have. This is the WRITING entry point, so the
  // strict check belongs here — never in the resolver, whose null tolerance liveSession()
  // (lib/session-audit.mjs) depends on to exclude the live session by path. Reported as a distinct
  // outcome, not as a silent empty result, so a caller with zero reports can tell "no usage" from
  // "we refused to name it".
  if (sessionId === null) return { ...emptyResult(), unnamedSession: true };
  const handOff = (result) => handOffUpload(result, { deps, options, sessionId, transcript_path, cwd });

  // ── The per-session checkpoint transaction (G-8-3 / R3) ───────────────────────────────────────
  // Taken HERE, the first instruction after the session id is known, and held through the state
  // write at the bottom. Everything between is one transaction — read the cursor, compute the
  // delta, enqueue the segments, advance the cursor — and R3 requires EVERY writer of it to hold
  // this lock, not just the ones that persist: PostToolUse, Stop, the manual track path and the
  // history backfill all enter through this function, so this single acquisition covers all four.
  //
  // It is taken even when `options.persistState === false`. The backfill does not write
  // state/<id>.json, but it still runs the SAME delta through the same sink, and two passes
  // enqueueing one window is the duplicate this lock exists to prevent.
  //
  // Keyed on the ROOT session id by construction: subagents are billed from their parent's
  // checkpoint under `${sessionId}:${agentId}` (see ingestSubagents), so no caller ever asks for a
  // second rank-2 lock — which the primitive refuses outright, deliberately.
  //
  // Acquire-and-finally rather than withLockAsync: this function has a dozen early returns and
  // wrapping four hundred lines in a closure to gain the same guarantee would bury the diff.
  const borrowed = deps.sessionHandle && deps.sessionHandle.name === sessionLock(sessionId).name
    && stillOwnsSession(deps.sessionHandle);
  const acquired = borrowed ? { ok: true, handle: deps.sessionHandle }
    : acquireLock(sessionLock(sessionId), { leaseMs: SESSION_LOCK_LEASE_MS, recoveryPermit: deps.recoveryPermit });
  if (!acquired.ok) {
    // 'held' and 'contended' are somebody else mid-transaction on this same session: defer, and the
    // next hook picks the window up with nothing lost.
    //
    // 'lock-order' is NOT that. It means this process already holds a lock of equal or finer rank,
    // which is a defect in its own acquisition sequence — retrying it fails identically forever, so
    // it must never be folded into the same "we'll get it next time" bucket. `lockReason` on the
    // return is the assertable surfacing; this is the one that survives the process.
    //
    // STATE_WRITE_FAILED is the closest member of a CLOSED server vocabulary, and it is accurate
    // rather than convenient: the consequence of this refusal is precisely that the session's state
    // write does not happen. Inventing a lock-shaped code would 400 the whole diagnostics batch.
    // Unreachable by construction today — the only locks coarser than this one are rank 0 and 1,
    // held by scripts/mcp.mjs and the backfill run, and both are legal above rank 2.
    if (acquired.reason === 'lock-order') {
      recordIssue({
        code: DIAGNOSTIC_CODES.STATE_WRITE_FAILED,
        source: DIAGNOSTIC_SOURCES.CHECKPOINT,
      });
    }
    // Somebody else holds the session — with the upload worker now a session writer too, often the
    // worker itself. The marker is still written: a re-mark changes `markedAt`, so the worker's
    // clear of the marker it is working on misses, and its next pass captures this turn.
    return handOff({ ...emptyResult(), lockSkipped: true, lockReason: acquired.reason });
  }
  let result;
  try {
    result = await runLockedCheckpoint(acquired.handle, {
      deps, options, sessionId, transcript_path, cwd, now, deadline, timeLeft,
      collectedErrors, skipped, emptyResult,
    });
  } catch {
    result = { ...emptyResult(), outcome: 'failed', reason: 'checkpoint-failed' };
  } finally {
    // Unconditional: a section that threw still has to hand the lock back, or the next checkpoint
    // on this session waits out the whole lease for nothing.
    if (!borrowed) acquired.handle.release();
  }
  // After the release, never under the lock: a worker started now would find the session busy.
  return handOff(result);
}

// The local-only checkpoint's hand-off to the upload worker (I-local). Marked due only when this
// run saved something the worker owes the server — a committed transaction (a child deferral still
// committed the parent) — or when another writer holds the session. Nothing is marked for a gated
// session, an unresolvable transcript, no linked account, or a run that failed before its state
// write: the next hook retries those. The trigger runs even when the mark could not be written,
// because the queue files alone are work it sees. Both real seams never throw; the catches are for
// injected ones.
function handOffUpload(result, ctx) {
  const { deps, options, sessionId, transcript_path, cwd } = ctx;
  if (options.localOnly !== true) return result;
  const owed = result.lockSkipped === true || result.outcome === 'committed'
    || result.reason === 'child-coverage-unavailable';
  if (!owed) return result;
  let marked = null;
  try {
    marked = orDefault(deps.markUploadDue, _markUploadDue)(sessionId, {
      transcriptPath: transcript_path, cwd: orDefault(cwd, null), timeline: options.emitTimeline === true,
    });
  } catch { marked = null; }
  let trigger;
  try { trigger = orDefault(deps.maybeSpawnUploadWorker, _maybeSpawnUploadWorker)(); } catch { trigger = 'failed'; }
  return { ...result, uploadDue: marked != null, uploadTrigger: trigger };
}

// Keep the session writer excluded from the drain through coverage and checkpoint commit.
//
// EVERY REPORTING account has to be clean before the caller's boundary decision runs, not just
// one: the question this answers is "does the server already hold everything this machine built
// for this session", and one account with an undrained queue makes that answer wrong for that
// tenant. The accounts are drained SERIALLY — flushQueue takes `shared:queue-<key>`, rank 3, and
// two of those at once in one process is a 'lock-order' refusal rather than a wait.
//
// REPORTING, not linked. The filter is the same account-wide gate runLockedCheckpoint's plans
// apply, and it is here rather than at the caller so every future caller inherits it — the
// invariant it protects ("an account whose tracking policy is dark gets nothing enqueued at all",
// stated at planRecipients above) is broken by this function's own transaction-resume path otherwise.
// A dark account also cannot answer the drain question at all: it receives no payloads, so its
// queue is HELD rather than drained and flushQueue reports `trackingDisabled` unconditionally,
// which read as "not drained" lets one dark workspace stop the live one beside it from ever being
// established. The filtered list is handed to `fn` as well, so the caller's own per-account work
// cannot reach for the unfiltered one by accident.
export async function reconcileSession(sessionId, sessions, fn, deps = {}) {
  const liveAllowed = orDefault(deps.isLiveTrackingAllowed, isLiveTrackingAllowed);
  // Fail OPEN on an unreadable policy, the posture lib/tracking.mjs documents: the server's guard
  // is the real boundary, and treating an unreadable cache as dark would stop reporting outright.
  // An account in several workspaces is gated per workspace, never by its account-wide mode.
  const isReporting = (session) => {
    if (isMultiTenant(session)) return true;
    try { return liveAllowed(session.key, deps) !== false; } catch { return true; }
  };
  const reporting = sessions.filter(isReporting);
  // Nothing is reporting, so there is no boundary to establish — and the transaction below must
  // NOT be read: committing it would emit its payloads into zero queues and then unlink it, which
  // is the one way this function could destroy work. runLockedCheckpoint returns `gated` before
  // its own transaction read for exactly the same reason.
  if (reporting.length === 0) return { outcome: 'deferred', reason: 'tracking-disabled' };

  const acquired = acquireLock(sessionLock(sessionId), { leaseMs: SESSION_LOCK_LEASE_MS });
  if (!acquired.ok) return { outcome: 'deferred', reason: 'session-busy' };
  try {
    const pending = readTransaction(sessionId);
    if (pending) {
      // Targets are re-derived now, so a rule answered since the crash routes the replay.
      const recipients = (mergesRows(deps) ? await listRecipients(sessions, deps) : sessions).filter(isReporting);
      let workspaceState = null;
      try { workspaceState = readSessionWorkspace(sessionId); } catch { /* unreadable = unanswered */ }
      const routeCtx = createRouteContext();
      const { plans } = planRecipients(recipients, {
        workspaceState, cwd: orDefault(pending.state.cwd, null), skipGate: false, unrouted: false, routeCtx,
      });
      // No queue would take the payloads, and committing would unlink the transaction regardless.
      if (plans.length === 0) return { outcome: 'deferred', reason: 'tracking-disabled' };
      commitTransaction(pending, acquired.handle, emitToPlans(plans, routeCtx), deps, true);
      return { outcome: 'deferred', reason: 'transaction-resumed' };
    }
    const flush = orDefault(deps.flushQueue, flushQueue);
    for (const session of reporting) {
      const drained = await flush(session.key, session, deps);
      if (!drained || drained.lockSkipped || drained.trackingDisabled || drained.deferred || drained.unreadable) {
        return { outcome: 'deferred', reason: 'pending-not-drained' };
      }
      // A 404/405 is the ROUTE being absent, not a verdict on the payload: the drain keeps those
      // files and still counts them in `failed`, so the user is told — but they must not block
      // reconciliation. A server with no report route holds no coverage for those segments to be
      // stale against, and on an ACTIVE machine the live account keeps writing fresh queue files,
      // so the 14-day prune never arrives and this session would never be established again.
      // `routeAbsent` is why the emptiness check below is skipped too: those files are on disk by
      // design, and the line above has already established that nothing else failed.
      const routeAbsent = orDefault(drained.routeAbsent, 0);
      if (orDefault(drained.failed, 0) - routeAbsent > 0) {
        return { outcome: 'deferred', reason: 'pending-not-drained' };
      }
      // Files held for a workspace answer (up to QUEUE_HOLD_MS) are on disk by design too, and a
      // session still unestablished here has none of its own among them.
      if (routeAbsent > 0 || orDefault(drained.workspacePending, 0) > 0) continue;
      // A drain step that sent nothing but judged every file on disk itself (the MCP watcher's
      // queueForWorker, lib/rollout-watcher.mjs) has already answered what the re-read below asks.
      if (drained.queueJudged === true) continue;
      let files;
      try { files = fs.readdirSync(queueDir(session.key)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; files = []; }
      if (files.length) return { outcome: 'deferred', reason: 'pending-not-drained' };
    }
    if (!stillOwnsSession(acquired.handle)) return { outcome: 'deferred', reason: 'ownership-lost' };
    return await fn(acquired.handle, reporting);
  } catch { return { outcome: 'deferred', reason: 'reconciliation-unavailable' }; }
  finally { acquired.handle.release(); }
}

// The `writtenAtMs` planRecipients applies: the caller's own, or — `options.liveSinceLinkOnly`, the
// upload worker's due checkpoints — the rollout's last write for a session with no cursor of its
// own yet. That is the history offer's cutoff (lib/tracking.mjs workspaceLinkMs, the rollout
// watcher's paths A and B): a session last written before a workspace's link is past for it, and
// only the offer sends it. Without this a due marker written before any account was linked would
// have the worker checkpoint the session from line 0 after a later login and report it as live.
// A session with a cursor (state/<id>.json with an integer `cursor`, the watcher's
// establishedProbe rule) was already reported live, so it is never cut off here. An unreadable
// rollout reads as written at the epoch: past for every workspace, which fails closed.
function unestablishedWrittenAtMs(options, sessionId, transcriptPath) {
  if (options.liveSinceLinkOnly !== true || typeof options.writtenAtMs === 'number') return options.writtenAtMs;
  const state = readJson(path.join(stateDir(), `${sessionId}.json`), null);
  if (state && typeof state === 'object' && Number.isInteger(state.cursor)) return options.writtenAtMs;
  try { return fs.statSync(transcriptPath).mtimeMs; } catch { return 0; }
}

// The body of the transaction, running under the session lock its caller holds. Split out only so
// that acquire/release can be a try/finally around it; the parameters are the locals runCheckpoint
// had already computed before the lock was taken.
async function runLockedCheckpoint(lock, ctx) {
  const {
    deps, options, sessionId, transcript_path, cwd, now, deadline, timeLeft,
    collectedErrors, skipped, emptyResult,
  } = ctx;
  const listSessions = orDefault(deps.linkedSessions, _linkedSessions);
  // The history run's memo wins over deps.gitImpl, so each (cwd, args) spawns git once per run.
  const gitImpl = deps.runCache != null ? deps.runCache.git : orDefault(deps.gitImpl, git);
  const computeDelta = orDefault(deps.computeDelta, _computeDelta);
  const transcriptMemo = orDefault(deps.transcriptMemo, createTranscriptMemo());
  const fetchImpl = deps.fetchImpl || fetchCompat;
  const durable = options.persistState !== false;
  const payloads = [];
  // Each payload's segment directory, index-aligned with `payloads`; it routes, never travels.
  const dirs = [];
  // Each payload's routes, index-aligned with `payloads` (null = emit computes them); never written to disk.
  const routes = [];
  const children = [];

  // Every account this machine can currently produce a token for, plus (listRecipients) every
  // linked one that cannot right now. `options.sessions` overrides the lookup, as in the Claude
  // plugin; the history import hands its one session in through deps.linkedSessions.
  //
  // localOnly reads no credentials: no session lookup at all, and every linked account is a
  // tokenless recipient (an index read), so its copies queue and every network step below skips it.
  const localOnly = options.localOnly === true;
  let sessions = [];
  if (!localOnly) {
    try { sessions = options.sessions != null ? options.sessions : await listSessions(deps); } catch { sessions = []; }
    sessions = orDefault(sessions, []);
  }
  const recipients = localOnly
    ? await listRecipients([], deps)
    : (options.sessions == null && mergesRows(deps) ? await listRecipients(sessions, deps) : sessions);
  if (recipients.length === 0) return emptyResult();
  // The queue flush and the installation binding are off for a local-only run as well.
  const skipFlush = options.skipFlush === true || localOnly;

  // One route context (repo map load, directory keys) for the whole run.
  const routeCtx = deps.routeCtx == null ? createRouteContext() : deps.routeCtx;
  let workspaceState = null;
  try { workspaceState = readSessionWorkspace(sessionId); } catch { /* unreadable = unanswered */ }
  // A live session no SessionStart bound (the rollout watcher, track, a login mid-session) is bound
  // here, so a rule, a held file's release and the MCP server can find it. Never for the history
  // import: binding hundreds of past sessions would make one of them the newest session workspace.
  const anyPreset = recipients.some((s) => typeof s.tenantId === 'string' && s.tenantId !== '');
  if (workspaceState == null && !anyPreset && cwd && recipients.some(usesRules)) {
    // The routes the bind writes, kept in memory so a refused write still routes this run's
    // segments and its session-level sends (errors, timeline, rate limits) alike.
    const route = {};
    for (const row of recipients) {
      const rule = usesRules(row) ? routeForDir(row, cwd, routeCtx) : null;
      if (rule != null) route[row.key] = rule;
    }
    let bound = null;
    // localOnly ignores `options.sessions`, so the hooks (the only live writers of it) still bind.
    if (durable && (localOnly || options.sessions == null)) {
      try { bound = bindSessionRoutes(sessionId, cwd, recipients, routeCtx); } catch { /* best-effort */ }
    }
    workspaceState = bound != null ? bound : { cwd, route };
  }

  // Tenant gate, PER ACCOUNT and, on an account in several workspaces, per workspace: audit-mode
  // workspaces never track live — the server would 403 every report anyway (TrackingEnabledGuard),
  // this just spares the work and the noise. The delta is computed when AT LEAST ONE account has
  // somewhere to send it, and only those receive it; a dark tenant sitting beside a live one must
  // not silence the live one. `gated` (nowhere to send) lets the track script tell "tracking is
  // off" apart from "nothing new"; reason 'no-targets' is a Don't track rule or New folders set to
  // Don't send. The history import passes skipLiveTrackingGate — an explicit flag, never inferred
  // from the sink seam — and `unrouted` when its preset workspace takes every segment.
  const { plans, policyGated, darkGated } = planRecipients(recipients, {
    workspaceState, cwd, skipGate: options.skipLiveTrackingGate === true, unrouted: options.unrouted === true, routeCtx,
    writtenAtMs: unestablishedWrittenAtMs(options, sessionId, transcript_path),
  });
  if (plans.length === 0) {
    if (policyGated) return { ...emptyResult(), gated: true, reason: darkGated ? 'no-targets-or-dark' : 'no-targets' };
    return { ...emptyResult(), gated: true };
  }
  const planKeys = plans.map((plan) => plan.session.key);
  // One clone per session-level target. Tokenless ones stay in `senders`, so the timeline and the
  // parked errors wait for them; only `liveSenders` reach the network.
  const senders = [];
  for (const plan of plans) for (const tenantId of plan.targets) senders.push({ ...plan.session, tenantId });
  const liveSenders = senders.filter((session) => session.token);

  // Where a built payload goes. The history import collects them in memory and batches them
  // itself; letting it fall through to the disk queue would drip-feed hundreds of segments to
  // the single-report endpoint on the next hook, bypassing the batch route's whole-session dedupe.
  // It is handed only what routes to one of its recipients; `options.elsewhere` gets each payload
  // the current rules send to none of its presets (even on an unrouted run), which is how sync
  // tells a workspace's split history from a contiguous one (Ruling 16).
  // Without a preset (a one-workspace history run) `presetRouted` is trivially true — there is no
  // preset workspace to answer for — so `elsewhere` has to ask the real question instead: did any
  // plan send this payload ANYWHERE (I-3). With a preset (multi-workspace), presetRouted's own
  // per-directory rule-vs-route answer stands unchanged.
  const noPreset = plans.every((plan) => plan.preset == null);
  const emit = options.sink
    ? (payload, dir) => {
      const sentSomewhere = plans.some((plan) => segmentPlan(plan, dir, routeCtx).targets.length > 0);
      if (sentSomewhere) options.sink(payload);
      if (options.elsewhere) {
        const excludedHere = noPreset ? !sentSomewhere : !plans.some((plan) => presetRouted(plan, dir, routeCtx));
        if (excludedHere) options.elsewhere(payload);
      }
    }
    : emitToPlans(plans, routeCtx);

  if (durable) {
    try {
      const pendingTransaction = readTransaction(sessionId);
      if (pendingTransaction) {
        const boundaries = commitTransaction(pendingTransaction, lock, emit, deps, true);
        return { ...emptyResult(), outcome: 'committed', reason: 'resumed', committedBoundaries: boundaries,
          enqueued: pendingTransaction.payloads.length, routedCopies: options.sink ? null : emit.copies };
      }
    } catch {
      return { ...emptyResult(), outcome: 'failed', reason: 'transaction-resume-failed' };
    }
  }

  // Below the token gate: skip this work entirely on an unlinked machine.
  // Resolved after the delta (below), so a rollout-derived name comes off the read the delta made.
  const resolveSessionName = orDefault(deps.resolveSessionName, _resolveSessionName);

  // Memoized git shell-outs for this checkpoint: dir→root, root→remote, root→reflog/HEAD.
  const rootCache = new Map();
  const remoteCache = new Map();
  const timelineCache = new Map();
  // root→project instruction observation. Read once per repo root, not once per segment: a window
  // that spans twenty segments of one repo would otherwise repeat the same filesystem probes inside
  // a hook budget. Missing and unknown answers are cached too.
  const projectInstructionsCache = new Map();

  // Persisted known-root map: seeds resolution (prefix match) and gets refreshed with any root→origin
  // we learn this checkpoint. A best-effort hint — a load failure yields an empty map, not a throw.
  const map = loadRepoMap();
  let mapDirty = false;

  // The session's git memo (createGitMemo), set once the state is loaded below and before anything
  // resolves a root. Live durable runs only: the history import has its own per-run cache.
  let gitMemo = null;

  // Only the history run's cache turns on the one-git-call-per-repository shortcut.
  const repoRootOf = (dir) => {
    if (gitMemo !== null && dir && !rootCache.has(dir)) {
      const known = gitMemo.root(dir);
      if (known !== null) {
        rootCache.set(dir, known);
        return known;
      }
    }
    const root = resolveRepoRoot(gitImpl, dir, rootCache, map, deps.runCache == null ? null : deps.runCache.gitRoots);
    if (gitMemo !== null && dir) gitMemo.setRoot(dir, root);
    return root;
  };

  const projectInstructionsOf = (root) => {
    if (projectInstructionsCache.has(root)) return projectInstructionsCache.get(root);
    const observation = probeProjectInstructions(root);
    projectInstructionsCache.set(root, observation);
    return observation;
  };

  const branchOf = (root, ms) => {
    if (!root) return '(unknown)';
    let entry = timelineCache.get(root);
    if (!entry) {
      const known = gitMemo === null ? null : gitMemo.branch(root);
      if (known !== null) {
        entry = { timeline: buildBranchTimeline(known.events), headBranch: known.branch };
      } else {
        let timeline = null;
        let headBranch = '(unknown)';
        let events = null;
        // Remembered only when both answers came from git: a failed spawn retries next checkpoint.
        let complete = true;
        try {
          events = readCheckoutEvents(gitImpl, root);
          timeline = buildBranchTimeline(events);
        } catch { complete = false; /* no reflog */ }
        // Always resolve current HEAD too: it's the fallback for any line lacking a
        // timestamp even when a reflog timeline exists (otherwise those bill to '(unknown)').
        try {
          const head = currentBranch(root, gitImpl);
          if (head) headBranch = head;
          else complete = false;
        } catch { complete = false; /* keep '(unknown)' */ }
        if (gitMemo !== null && complete) gitMemo.setBranch(root, headBranch, events);
        entry = { timeline, headBranch };
      }
      timelineCache.set(root, entry);
    }
    return (entry.timeline && ms != null) ? branchAtReflog(entry.timeline, ms) : entry.headBranch;
  };

  const resolveRemote = (root) => {
    if (!root) return null;
    if (remoteCache.has(root)) return remoteCache.get(root);
    const known = gitMemo === null ? null : gitMemo.remote(root);
    if (known !== null) {
      remoteCache.set(root, known);
      return known;
    }
    // git first (authoritative), then a git-free .git/config parse (rescues dubious-ownership), then
    // the persisted map (rescues a fully-blocked git binary). Remember any origin we learn.
    let r = resolveOriginRemote(gitImpl, root);
    if (!r) r = originFromGitConfig(root);
    // The session memo keeps only an origin the repository itself answered (git, or its config
    // file, which is what the memo is keyed on). The map's answer stands in for a blocked git, and
    // no origin at all may be a remote added mid-session: both are asked again next checkpoint.
    if (r && gitMemo !== null) gitMemo.setRemote(root, r);
    if (!r) r = knownOrigin(root, map);
    if (r) { upsertRoot(map, root, r); mapDirty = true; }
    remoteCache.set(root, r);
    return r;
  };

  // The history import never reads persisted per-session state: on a dark-mode tenant the live
  // hooks kept advancing cursors while the server 403-dropped every report, so an import that
  // honored those cursors would bill only the tails of exactly the sessions it exists to recover.
  // The server upserts by segmentId, so re-covering lines a live run DID deliver is idempotent.
  const state = options.persistState === false
    ? { cursor: 0, sentSessionName: null, anchor: null }
    : loadState(sessionId);
  if (durable && deps.runCache == null) gitMemo = createGitMemo(state.gitMemo);
  // G-3-3: a coverage-derived start line is a HARD OVERRIDE, not a comparison. The server is the
  // authority on what actually landed — a local cursor can sit at EOF while the upload was lost,
  // and at 0 for a session the server holds in full. lib/session-audit.mjs passes this only when
  // lib/session-coverage.mjs has PROVEN a non-overlapping boundary; 0 and absent are identical.
  const startCursor = Number.isInteger(options.startCursor) && options.startCursor >= 0
    ? options.startCursor
    : null;
  if (startCursor !== null) {
    state.cursor = startCursor;
    // Cleared with the cursor, never separately: coveredIntervals is wall clock already billed for
    // lines BELOW the old cursor, and keeping it while restarting from the server's line would
    // subtract time from segments that were never delivered.
    state.coveredIntervals = [];
    // The byte cursor belongs to the line cursor just replaced, so it goes with it.
    applyResumeFields(state, null);
  }
  let stateDirty = false;
  // When the session file is unreadable (name resolves to null), keep the last name we sent rather
  // than overwriting the stored name with null — but only after putting it through the same gate a
  // fresh name passes. Older resolvers stored names they would not produce today: injected context
  // blocks (XML preambles, absolute home paths), and later the session_index seed, which is raw
  // prompt text and can carry a path mid-sentence. Left in state, such a name is re-sent on every
  // checkpoint forever. sanitizeSessionName redacts what it can and drops what it cannot; either
  // way the name changes, which trips the anchor replay below and corrects what the server holds.
  const storedName = typeof state.sentSessionName === 'string' ? state.sentSessionName : null;
  const stored = sanitizeSessionName(storedName);
  if (storedName && !stored) {
    state.sentSessionName = null;
    stateDirty = true;
  }
  // How a rollout's lines map onto (repo, branch). Shared verbatim by the parent's own delta and
  // every subagent's — an agent's cwd may differ, and the memoized resolvers handle that.
  const resolvers = { cwd, repoRootOf, branchAt: branchOf };
  // The byte cursor saved with the line cursor. Only a durable state has one to trust; the history
  // import starts from a fresh state and reads whole.
  const resume = durable ? resumeFromFields(state) : null;
  const memoTail = typeof transcriptMemo.readTail === 'function' ? transcriptMemo.readTail : undefined;
  // A turn end reads the whole rollout for the timeline anyway, so read it first and let the delta
  // resume from that copy in memory: one read of the file per run either way. Not on a local-only
  // run, which builds no timeline: there the delta's byte-cursor read is the only one.
  if (resume && memoTail && options.emitTimeline === true && !localOnly) {
    try { transcriptMemo.readLines(transcript_path); } catch { /* the delta reports it */ }
  }
  let delta;
  try {
    // Children read without the memo, so it still holds the parent for the timeline.
    delta = computeDelta(transcript_path, state.cursor, {
      ...resolvers, readLines: transcriptMemo.readLines, readTail: memoTail, resume,
    });
  } catch {
    skipped.deltaFailed = true;
    return emptyResult();
  }
  const { nextCursor, segments, apiErrorEvents = [], rateLimitObservations = [] } = delta;

  // The prompt-derived name, for a session the index has no title for, without a read of its own:
  // off this run's whole read when it made one (a first run, a turn end), else the name the last
  // such run saved in state. A state from before that field existed gets one bounded head scan.
  // Saved only once the transcript has content, so an empty session still writes no state.
  const rolloutName = () => {
    const whole = typeof transcriptMemo.peek === 'function' ? transcriptMemo.peek(transcript_path) : null;
    const fromState = !whole && state.rolloutName !== undefined;
    let raw = state.rolloutName;
    if (!fromState) raw = whole ? sessionNameFromRecords(whole.records) : sessionNameFrom(transcript_path);
    // One gate for both answers, the same one the stored sent name above passes: a name an older
    // resolver saved is redacted or dropped, and a fresh one is cut exactly as a stored one. The
    // hook answers from state and the upload worker from its whole read, so two different answers
    // would flip the session's name — and replay its anchor — on every turn.
    const name = typeof raw === 'string' ? sanitizeSessionName(raw) : null;
    if ((fromState || nextCursor > 0) && state.rolloutName !== name) {
      state.rolloutName = name;
      stateDirty = true;
    }
    return name;
  };
  const resolvedSessionName = resolveSessionName(sessionId, transcript_path, { rolloutName });
  const sessionName = orDefault(resolvedSessionName, orDefault(stored, null));

  // Recorded before anything can return early: the observations belong to lines this cursor is
  // about to advance past, so a checkpoint that bails later must not leave them unread. Local file
  // write only — the drain that posts them runs at turn end.
  if (options.persistState !== false && rateLimitObservations.length) {
    try {
      // One debounce decision, one row per recipient account (tokenless ones drain later). A queue
      // this could not append to is reported rather than thrown — see recordRateLimitObservations.
      const queued = recordRateLimitObservations(rateLimitObservations, planKeys);
      if (queued && queued.skippedKeys && queued.skippedKeys.length) skipped.rateLimitDeferred = true;
    } catch {
      skipped.rateLimitDeferred = true;
      return emptyResult(); // keep the cursor so observations are retried
    }
  }

  // Billing is resolved HERE, after the delta, not before it: a quota or usage-limit error in this
  // window is proof of how the session bills, and that proof has to be in hand before the segments
  // it belongs to are stamped. Persisted so later sessions resolve correctly too — the switch that
  // produced it is invisible to process.env.
  let billingConfig = readBillingConfig();
  // Never persisted by the history import: an API-key quota error from months ago must not flip
  // TODAY's billing source. The import's payloads still reflect the current resolved config.
  const stamp = options.persistState === false
    ? null
    : isApiKeyBillingEvidence(apiErrorEvents)
      ? recordApiKeyEvidence(billingConfig)
      : isSubscriptionBillingEvidence(apiErrorEvents)
        ? recordSubscriptionEvidence(billingConfig)
        : null;
  if (stamp) {
    try { writeBillingConfig(stamp); } catch { /* best-effort */ }
    billingConfig = stamp;
  }
  // Both seams are threaded on purpose (G-10-1 L1/L3). Dropped, `resolveBilling` falls back to the
  // real `process.env` for step 1 of the ladder and opens the real `~/.codex/auth.json` for step 4,
  // so a caller that injected every other resolver still resolves billing off the host machine.
  //
  // `now` is handed over as an EPOCH, not as this file's clock function: resolveSource's `now` is a
  // number (`resolveSource` in billing-config.mjs), and passing the function through would make
  // every evidence-freshness comparison NaN and silently discard a fresh API-key stamp.
  const billingFields = resolveBilling(
    billingConfig,
    orDefault(deps.env, process.env),
    { now: now(), readCodexAuthSignals: deps.readCodexAuthSignals },
  );

  // The CHATGPT sign-in these numbers belong to — not a Beezi account, which is what `account`
  // means from 0.13 on. Explicit historical replays cannot infer their owner from today's sign-in.
  const chatgptIdentity = options.persistState === false ? {} : readChatgptIdentity(deps);

  let enqueued = 0;
  // The last enqueued payload becomes the "anchor" we can replay to push a later rename.
  let lastPayload = null;
  let lastDir = null;
  const timezone = detectTimezone();

  // Wall clock already billed this session, as a union of intervals — never a sum.
  // lib/active-time.mjs is the single definition of that rule and carries the measurement behind it.
  // Write-up: docs/plans/2026-09-15-comment-archive.md.
  let covered = mergeIntervals(Array.isArray(state.coveredIntervals) ? state.coveredIntervals : []);
  let coveredDirty = false;

  const enqueueSegments = (segs, segmentScope, extra = null) => {
    const isSubagent = !!(extra && extra.is_subagent);
    for (const seg of segs) {
      const intervals = Array.isArray(seg.activeIntervals) ? seg.activeIntervals : null;
      // Only the time nothing else has claimed. A caller that injected segments without intervals
      // (the test seam) keeps the scalar it supplied.
      const durationSec = intervals
        ? Math.round(totalMs(subtractIntervals(intervals, covered)) / 1000)
        : seg.stats.duration_sec;
      if (seg.stats.token_total === 0 && durationSec === 0) continue;
      // The directory the segment ran in: what names a repo-less remote and what routes the copy.
      const segDir = orDefault(seg.repoRoot, orDefault(cwd, null));
      const remote = orDefault(resolveRemote(seg.repoRoot), localRemote(segDir));
      // Nothing left to name the work by — only reachable when the session has no cwd either.
      if (!remote) { skipped.noRemote += 1; continue; }
      // Read the current instructions at the segment's OWN repo root, not the session cwd.
      // Historical imports use the same observation as live reports: this describes the file
      // available at collection time, not a reconstruction of its contents when the segment ran.
      const projectInstructions = projectInstructionsOf(seg.repoRoot);
      // A subagent runs its own context window, so the parent's occupancy is not its own and these
      // three never ship on a non-main segment. The server already nulls them there
      // (`session-report.service.ts` in the hb-ai-agent-portal repo), so this is hygiene rather
      // than correctness — but the payload must never state something the server will discard.
      // Byte-identical construct to the Claude plugin's own lib/checkpoint.mjs (the
      // beezi-claude-plugins repo); object rest is ES2018 and clears the ban gate.
      const { context_peak_tokens, context_final_tokens, context_final_model, ...statsSansContext } = seg.stats;
      const segStats = isSubagent ? statsSansContext : seg.stats;
      // Build the complete immutable transaction before publishing any payload.
      try {
        const built = {
          segmentId: `${segmentScope}:${seg.fromLine}-${seg.toLine}`,
          sessionId,
          remote,
          branch: clamp(seg.branch, BRANCH_MAX),
          from_line: seg.fromLine,
          to_line: seg.toLine,
          ...billingFields,
          ...chatgptIdentity,
          session_name: sessionName,
          ...(timezone ? { timezone } : {}),
          // `claude_md_lines` is the established cross-agent wire field. On a Codex report it is
          // the line count of the selected root AGENTS file. The status key is a newer backend-first
          // addition: an older strict DTO rejects it rather than ignoring it.
          project_instructions_status: projectInstructions.status,
          ...(projectInstructions.status === 'present'
            ? { claude_md_lines: projectInstructions.lineCount }
            : {}),
          ...(extra || {}),
          ...segStats,
          // After the spread, deliberately: seg.stats carries the un-deduped scalar.
          duration_sec: durationSec,
        };
        // Marked here so the transaction, the anchor and every queued copy carry the same marker.
        const segmentRoutes = options.sink ? null : routeSegment(plans, segDir, routeCtx);
        const payload = options.sink ? built : markForSegment(built, segmentRoutes);
        payloads.push(payload);
        dirs.push(segDir);
        routes.push(segmentRoutes);
        lastPayload = payload;
        lastDir = segDir;
        enqueued += 1;
        // Claimed only on a successful write, so one failed segment cannot swallow the window for
        // the ones after it.
        if (intervals && intervals.length) {
          covered = claimIntervals(covered, intervals);
          coveredDirty = true;
        }
      } catch { skipped.emitFailed += 1; /* abort publication after building the window */ }
    }
  };

  // Subagents first, the parent's own segments second. The parent sits blocked in wait_agent for the
  // whole fan-out, so that clock belongs to the agents that were actually working; billing them first
  // means the parent takes the residual rather than the other way round.
  const agentResults = ingestSubagents({
    sessionId,
    parentTranscriptPath: transcript_path,
    computeDelta,
    resolvers,
    enqueueSegments,
    // The import needs the sweep without the timeline POST: past sessions' hook sidecars are
    // pruned at 14 days, so the rollout-tree sweep is the only way it finds their subagents.
    // An explicit sweepSubagents: false wins over emitTimeline's implied sweep.
    sweep: options.sweepSubagents === true
      || (options.emitTimeline === true && options.sweepSubagents !== false),
    persist: options.persistState !== false,
    recovery: options.recovery === true || state.childRecoveryRequired === true,
    childFill: orDefault(options.childFill, null),
    deps: {
      ...deps,
      writeAgent: (_parentId, agentId, childState) => children.push({ agentId, state: childState }),
      // The parent's start, off the copy this run already read when it has one.
      rolloutStartedAt: orDefault(deps.rolloutStartedAt, (p) => startedAtFromMemo(transcriptMemo, p)),
    },
  });
  if (options.recovery) state.childRecoveryRequired = true;
  apiErrorEvents.push(...agentResults.apiErrorEvents);

  enqueueSegments(segments, sessionId);

  // Error reports run BEFORE the timeline POST, and both respect the budget. The ordering is
  // deliberate: the cursor advances below whether or not these landed, so an error that misses its
  // window is unrecoverable, while the timeline is re-derived from the whole transcript every turn
  // and simply retries. Anything the budget cuts off is parked in state.pendingErrors and drained
  // by the next checkpoint. postSessionError swallows its own failures (never rejects).
  // The history import buffers error reports instead of POSTing them: they are only worth a row
  // once the server has accepted the session's usage, which the import learns per batch, after
  // this call. It also must not drain state.pendingErrors — those belong to the live epoch.
  if (options.collectSessionErrors) {
    for (const event of apiErrorEvents) {
      collectedErrors.push({
        sessionId,
        error: orDefault(event.error, 'unknown'),
        errorDetails: orDefault(event.details, null),
        lastAssistantMessage: orDefault(event.text, null),
        occurredAt: orDefault(event.occurredAt, new Date().toISOString()),
        ...(event.resetsAt ? { resetsAt: event.resetsAt } : {}),
      });
    }
  }
  const pending = options.collectSessionErrors
    ? []
    : [...(Array.isArray(state.pendingErrors) ? state.pendingErrors : []), ...apiErrorEvents];
  // `errorsPendingLive` on the result: true when an error kept parked below is still owed to a
  // sender that HAD a token this run (a failed post, or the budget ran out before it). The upload
  // worker keeps the session's due marker while it is; one owed only to tokenless senders is not.
  let errorsPendingLive = false;
  if (pending.length > 0) {
    const undelivered = [];
    for (const [i, event] of pending.entries()) {
      const remaining = timeLeft();
      if (remaining !== null && remaining <= 0) {
        undelivered.push(...pending.slice(i));
        break;
      }
      const errorPayload = errorPayloadOf(event, sessionId);
      // A target parked its own body (parkedForTargets) is sent exactly that body.
      const bodies = isPlainRecord(event.bodies) ? event.bodies : null;
      // Every target workspace is owed the failure, so an event is only retired once EVERY sender
      // took it — a tokenless one included, which keeps it parked until its token is back. Who has
      // accepted is kept per `key:tenantId` on the parked event, so a retry reaches only the rest; a
      // lost response can still re-post, which the route already has to tolerate.
      const deliveredTo = Array.isArray(event.deliveredTo) ? event.deliveredTo.slice() : [];
      let deliveredEverywhere = true;
      for (const session of senders) {
        const target = `${session.key}:${session.tenantId}`;
        if (deliveredTo.indexOf(target) !== -1) continue;
        if (!session.token) { deliveredEverywhere = false; continue; }
        const left = timeLeft();
        if (left !== null && left <= 0) { deliveredEverywhere = false; break; }
        const { reported } = await postSessionError(
          // Over the event's own payload, so a scrubbed body sent to a workspace that has since
          // stopped hiding still carries the text fields, as null, exactly as before.
          bodies && isPlainRecord(bodies[target]) ? { ...errorPayload, ...bodies[target] } : errorPayload,
          session,
          { fetchImpl, ...(left === null ? {} : { timeoutMs: Math.min(POST_TIMEOUT_MS, left) }) },
        );
        if (reported) deliveredTo.push(target);
        else deliveredEverywhere = false;
      }
      if (!deliveredEverywhere) undelivered.push({ ...event, deliveredTo });
    }
    // Bounded: a session that cannot reach the server must not grow its state file without limit.
    const parked = hidesSessions(plans)
      ? undelivered.map((event) => parkedForTargets(event, senders, sessionId))
      : undelivered;
    const next = parked.slice(-MAX_PENDING_ERRORS);
    errorsPendingLive = undelivered.slice(-MAX_PENDING_ERRORS).some((event) => {
      const deliveredTo = Array.isArray(event.deliveredTo) ? event.deliveredTo : [];
      return liveSenders.some((session) => deliveredTo.indexOf(`${session.key}:${session.tenantId}`) === -1);
    });
    const before = Array.isArray(state.pendingErrors) ? state.pendingErrors : [];
    if (next.length !== before.length || JSON.stringify(next) !== JSON.stringify(before)) {
      state.pendingErrors = next;
      stateDirty = true;
    }
  }

  // The activity timeline is whole-session, so it's re-derived from the full transcript and shipped
  // only at turn-ends (Stop / SessionEnd) — not on the frequent PostToolUse:Bash path. Skip the POST
  // when the derived content is identical to the last one we sent (a Stop with no new activity), so
  // we don't re-upsert the same growing jsonb every turn. Best-effort: a failure must never break the
  // checkpoint.
  // `timelineConfirmed` on the result (lib/upload-worker.mjs keeps a session's due marker until it is
  // true): null when no timeline was asked for; true when every sender has this session's current
  // timeline — posted now, already sent unchanged, or nothing to send; false otherwise.
  // `timelineConfirmedLive` is the same answer for the LIVE (tokened) senders only: true with
  // `timelineConfirmed` false means the only senders missing it had no token this run.
  let timelineConfirmed = null;
  let timelineConfirmedLive = null;
  // Not on a local-only run: the worker's checkpoint of the due marker builds and posts it.
  if (options.emitTimeline && !localOnly) {
    timelineConfirmed = false;
    timelineConfirmedLive = false;
    // The live-senders verdict of the most recent postToEverySender call.
    let lastPostLive = false;
    // Posts one timeline to every live sender within the remaining budget. True only when every
    // sender confirmed it: a tokenless sender, a budget that ran out or a failed post makes it false.
    // A throw propagates to the caller's own best-effort catch.
    const postToEverySender = async (payload) => {
      let reportedEverywhere = liveSenders.length === senders.length;
      lastPostLive = true;
      for (const session of liveSenders) {
        const remaining = timeLeft();
        if (remaining !== null && remaining <= 0) { reportedEverywhere = false; lastPostLive = false; break; }
        const { reported } = await postSessionTimeline(
          payload,
          session,
          { fetchImpl, ...(remaining === null ? {} : { timeoutMs: Math.min(POST_TIMEOUT_MS, remaining) }) },
        );
        if (!reported) { reportedEverywhere = false; lastPostLive = false; }
      }
      return reportedEverywhere;
    };

    try {
      // The agent map is handed over rather than re-read: ingestSubagents just built it, and its
      // sweep entries are ones a fresh readAgents would not see.
      const timeline = computeSessionTimeline(transcript_path, sessionId, {
        readAgents: () => agentResults.agents,
        readLines: transcriptMemo.readLines,
      });
      if (!(timeline && (timeline.periods.length > 0 || timeline.subagents.length > 0 || timeline.plan_events.length > 0))) {
        timelineConfirmed = true;
        timelineConfirmedLive = true;
      } else {
        // The sender list is part of the signature, so a newly answered workspace still gets it.
        const senderSig = senders.map((s) => `${s.key}:${s.tenantId}`).sort().join(',');
        const sig = `${JSON.stringify(timeline.periods)}|${JSON.stringify(timeline.subagents)}|${JSON.stringify(timeline.plan_events)}|${senderSig}`;
        if (sig === state.sentTimelineSig) { timelineConfirmed = true; timelineConfirmedLive = true; }
        // Skipped rather than started when the budget is already gone: the signature is only
        // recorded on a confirmed send, so the next turn re-derives and retries this same payload.
        if (sig !== state.sentTimelineSig && (timeLeft() === null || timeLeft() > 0)) {
          // The signature is machine-level, so it may only be remembered once every sender has
          // the timeline: sealing it after a partial round would leave the workspaces that missed
          // out with no timeline until the derived content changed again. A tokenless sender is one.
          // Only remember the signature on a confirmed send, so a failed post retries next turn.
          if (await postToEverySender({ sessionId, ...timeline })) {
            state.sentTimelineSig = sig;
            stateDirty = true;
            timelineConfirmed = true;
          }
          timelineConfirmedLive = lastPostLive;
        }
      }
    } catch { /* best-effort */ }

    // A session started by accepting a plan with "Yes, clear context" re-posts its PREDECESSOR's
    // timeline once: Codex writes nothing to the old rollout, so only this session's first prompt
    // can close the old one's plan-approval wait (computeSessionTimeline appends it). Separate try,
    // so a failed own-timeline post above does not skip this. The predecessor's lock and state are
    // never touched: its sentTimelineSig stays stale, and a later recompute re-posting the same
    // content is harmless. The flag is set once there is nothing (more) to do — a first prompt that is
    // not a handoff, no predecessor (it finished before this session began, so a miss now is a miss
    // forever), no timeline — or once every sender confirmed the post; a failed or partial post
    // retries next turn. No prompt yet decides nothing: the handoff prompt may still be on its way.
    if (!state.planHandoffPosted && (timeLeft() === null || timeLeft() > 0)) {
      try {
        const records = parseTranscript(transcript_path, transcriptMemo.readLines);
        let settled = records.some((r) => r && isTimelineUserPrompt(r));
        if (settled && handoffPlanText(records) !== null) {
          const findPredecessor = orDefault(deps.findPlanPredecessor, _findPlanPredecessor);
          const pred = findPredecessor(transcript_path, records);
          // The successor is this session, so the predecessor's successor lookup is pointed at this
          // transcript alone instead of walking the whole sessions directory again.
          // The id came from a session_meta on disk and keys a timeline post: it must be usable.
          const predTimeline = pred && isUsableSessionId(pred.sessionId)
            ? computeSessionTimeline(pred.transcriptPath, pred.sessionId, {
              // Its own hook sidecars, read-only; an empty map once pruned.
              readAgents: _readAgents,
              planHandoff: { listRollouts: () => [transcript_path] },
            })
            : null;
          if (predTimeline) settled = await postToEverySender({ sessionId: pred.sessionId, ...predTimeline });
        }
        if (settled) {
          state.planHandoffPosted = true;
          stateDirty = true;
        }
      } catch { /* best-effort */ }
    }
  }

  // Rate-limit rows the rollout scan queued. Same turn-end gate as the timeline — these are
  // account-scoped observations, so posting them on every PostToolUse would be one request per
  // tool call describing a number that moves once a turn — plus an explicit opt-in for the manual
  // `the track skill` path, which is a turn end in every sense that matters and would otherwise queue
  // rows forever without ever shipping them.
  // The drain's own verdict, surfaced on the return rather than discarded (G-8-8). Null means the
  // drain never ran: this checkpoint was not a turn end, so "0 posted" would be a claim we cannot
  // make. `deferred` is normalised to 0 because the drain's two early exits ('no-token', 'empty')
  // report only `posted`.
  let rateLimits = null;
  // The worker's rate-limits step drains these for a local-only run.
  if (!localOnly && (options.emitTimeline === true || options.drainRateLimits === true)) {
    const drainRateLimits = deps.drainRateLimitSnapshots == null
      ? _drainRateLimitSnapshots
      : deps.drainRateLimitSnapshots;
    try {
      const remaining = timeLeft();
      // Skipped rather than started on an exhausted budget: a negative timeout aborts the request
      // mid-flight, and the rows are only cleared on a confirmed store, so waiting for the next
      // turn end costs nothing but a self-inflicted failure costs a wasted POST.
      //
      // The deadline travels too, not just a per-request timeout: the drain is a serial loop over
      // up to 40 queued rows, so a cap alone bounds each request while the loop as a whole runs
      // well past the hook kill — taking the state write and flushQueue below down with it.
      if (remaining === null || remaining > 0) {
        // ONE deadline for all the accounts, not one each: the drains share the hook budget
        // rather than multiplying it, and whatever the budget cuts off stays queued per account.
        // One drain per workspace clone; the drain keeps each workspace's own sent marker.
        for (const session of liveSenders) {
          const left = timeLeft();
          if (left !== null && left <= 0) break;
          const drained = await drainRateLimits(session.key, session, {
            fetchImpl,
            ...(deadline === null ? {} : { deadline, now, timeoutMs: POST_TIMEOUT_MS }),
          });
          if (!drained) continue;
          if (rateLimits === null) rateLimits = { posted: 0, deferred: 0 };
          rateLimits.posted += orDefault(drained.posted, 0);
          rateLimits.deferred += orDefault(drained.deferred, 0);
        }
      }
    } catch { /* best-effort */ }
  }

  // Codex retitles a session after the first prompt (the session_index thread_name). The new name
  // normally rides on the
  // next billable segment (each report re-reads it), but a session whose rename lands with no
  // further activity would keep the first-prompt title forever. So: remember the anchor segment
  // and the name we last sent; when the name changes but no new segment carried it, replay the
  // anchor with the corrected name. The server upserts by segmentId (idempotent tokens/cost) and
  // takes the latest non-null session_name, so this only fixes the name.
  if (enqueued > 0) {
    state.anchor = lastPayload;
    // Where the anchor ran, so its replay reaches the workspaces the original copy went to.
    state.anchorDir = lastDir;
    state.sentSessionName = sessionName;
    stateDirty = true;
  } else if (sessionName != null && sessionName !== state.sentSessionName && state.anchor) {
    try {
      payloads.push({ ...state.anchor, session_name: sessionName });
      dirs.push(orDefault(state.anchorDir, null));
      routes.push(null);
      state.sentSessionName = sessionName;
      stateDirty = true;
    } catch { /* best-effort; retry next checkpoint */ }
  }

  // The byte cursor moves with the line cursor. While the line cursor stands still and the saved
  // byte cursor still names it, the saved one stays (the file only grew past it, and rewriting the
  // state for a new size would cost a write per checkpoint); otherwise it is replaced by the delta's,
  // or dropped when the delta brings none or nothing has been read yet.
  const savedResume = resumeFromFields(state);
  const keepResume = nextCursor === state.cursor && savedResume !== null && !!delta.resume
    && savedResume.line === delta.resume.line && savedResume.byte === delta.resume.byte;
  if (!keepResume) {
    const nextResume = nextCursor > 0 && delta.resume && delta.resume.line === nextCursor ? delta.resume : null;
    if (applyResumeFields(state, nextResume)) stateDirty = true;
  }
  if (nextCursor !== state.cursor) {
    state.cursor = nextCursor;
    stateDirty = true;
  }
  if (gitMemo !== null && gitMemo.isDirty()) {
    state.gitMemo = gitMemo.value;
    stateDirty = true;
  }
  if (coveredDirty) {
    state.coveredIntervals = covered;
    stateDirty = true;
  }
  // Remember where this session lives. The session's cwd drifts (cd, worktree switches)
  // while the rollout transcript path is fixed, so the track script (and the id-less transcript
  // resolver) reads this mapping instead of relying on process.cwd(). Only recorded once the
  // transcript has content, so an empty session writes no state.
  //
  // `sessionId` is recorded IN the file, not just as its name. findRolloutBySessionState
  // (`findRolloutBySessionState` in lib/transcript-codex.mjs) prefers the recorded id over the
  // filename precisely so a state file cannot answer with whatever string it happens to be named —
  // the read side of that guard is a no-op until this write lands. Old state files keep falling
  // through to the filename.
  if (nextCursor > 0
    && (state.cwd !== cwd || state.transcriptPath !== transcript_path || state.sessionId !== sessionId)) {
    state.cwd = orDefault(cwd, null);
    state.transcriptPath = transcript_path;
    state.sessionId = sessionId;
    state.updatedAt = new Date().toISOString();
    stateDirty = true;
  }
  // The one write that must never race, so it is the one write gated on still owning the lock.
  // `stillOwnsSession` above is where the expired-vs-lost rule is stated; this is the site it
  // protects. Aborting on 'lost' destroys nothing: the cursor simply does not advance, the window is
  // recomputed next checkpoint, and the server upserts by segmentId, so anything already enqueued is
  // idempotent. Write-up: docs/plans/2026-09-15-comment-archive.md.
  if (skipped.emitFailed || skipped.noRemote) return { ...emptyResult(), outcome: 'failed', reason: 'payload-build-failed' };
  let committedBoundaries;
  try {
    if (!stillOwnsSession(lock)) return { ...emptyResult(), reason: 'ownership-lost' };
    const tx = { version: 1, sessionId, payloads, dirs, children, state };
    if (durable) writeJsonDurable(transactionFile(sessionId), tx);
    committedBoundaries = commitTransaction(tx, lock, emit, deps, durable, routes);
  } catch {
    skipped.emitFailed += 1;
    return { ...emptyResult(), outcome: 'failed', reason: 'transaction-commit-failed' };
  }
  // Deliberately unguarded: the repo-map is a machine-global dir→origin cache, and learning
  // origins from history is harmless and useful.
  if (mapDirty) {
    try { saveRepoMap(map); } catch { /* best-effort */ }
  }

  // The import owns its own batched delivery, so it must not drain the live queue per session —
  // that would add unrelated HTTP calls mid-import and muddy its summary.
  //
  // SERIAL over the accounts, sharing one deadline: flushQueue takes `shared:queue-<key>`, and two
  // rank-3 locks under different names at once in one process is a 'lock-order' refusal, which
  // would silently skip an account's drain rather than defer it.
  // Tokenless recipients are skipped: their copies wait for the next drain that has a bearer.
  const flushes = [];
  if (!skipFlush) {
    for (const plan of plans) {
      if (!plan.session.token) continue;
      const drained = await flushQueue(plan.session.key, plan.session,
        { fetchImpl, now, ...(deadline === null ? {} : { deadline }) });
      flushes.push({ key: plan.session.key, ...drained });
    }
    // Off with the flush: the upload worker's due checkpoints skip both, and its own
    // `installation-binding` step binds instead (lib/upload-step-binding.mjs).
    await bindInstallationForSessions(sessions, { ...deps, fetchImpl, now, deadline });
  }
  // `agents` is the merged sidecar+sweep map — the import builds the session timeline from it
  // instead of re-reading (possibly pruned) sidecars.
  // `flush` is the machine-wide summary (one account's numbers when one is linked, which is what
  // every existing reader means by it); `flushes` is the per-account breakdown the track flow
  // words one line per account from.
  return {
    outcome: agentResults.childDeferred ? 'deferred' : 'committed',
    reason: agentResults.childDeferred ? 'child-coverage-unavailable' : null, committedBoundaries,
    enqueued, routedCopies: options.sink ? null : emit.copies,
    flush: skipFlush ? null : mergeFlushResults(flushes), flushes,
    sessionErrors: collectedErrors, skipped, rateLimits, agents: agentResults.agents,
    childrenSkipped: agentResults.childrenSkipped, timelineConfirmed, timelineConfirmedLive, errorsPendingLive,
  };
}

// The accounts' drains folded into one summary. Counters add, flags OR, and the first error stands
// — a caller asking "did the flush work" wants the worst answer any account gave, not an average.
function mergeFlushResults(results) {
  const merged = {
    flushed: 0, rejected: 0, failed: 0, deferred: 0, expired: 0,
    quarantined: 0, salvaged: 0, unreadable: 0, unnamed: 0, routeAbsent: 0, workspacePending: 0,
    trackingDisabled: false, lastError: null,
  };
  const counters = ['flushed', 'rejected', 'failed', 'deferred', 'expired',
    'quarantined', 'salvaged', 'unreadable', 'unnamed', 'routeAbsent', 'workspacePending'];
  for (const one of results) {
    if (!one) continue;
    for (const counter of counters) merged[counter] += orDefault(one[counter], 0);
    if (one.trackingDisabled) merged.trackingDisabled = true;
    if (one.lockSkipped) {
      merged.lockSkipped = true;
      merged.lockReason = orDefault(merged.lockReason, one.lockReason);
    }
    if (one.trackingDisabledWrite && !merged.trackingDisabledWrite) {
      merged.trackingDisabledWrite = one.trackingDisabledWrite;
    }
    if (merged.lastError === null) merged.lastError = orDefault(one.lastError, null);
  }
  return merged;
}

// The live-queue drain lives in lib/queue-flush.mjs. Re-exported here, where every caller and test
// has always imported it from; imported too, because runCheckpoint and reconcileSession call it.
import { flushQueue } from './queue-flush.mjs';
export { flushQueue };
