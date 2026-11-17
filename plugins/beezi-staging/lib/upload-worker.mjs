import fs from 'fs';
import os from 'os';
import path from 'path';
import { queueDir, usagePendingFile, uploadWorkerStatusFile } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { listAccountsSync, linkedSessions as _linkedSessions, AccountStatus } from './accounts.mjs';
import { isPostableQueueFile } from './workspace-queue.mjs';
import { isMultiTenant, tenantsOf } from './workspace.mjs';
import {
  hasUploadDue, listUploadDue as _listUploadDue, clearUploadDue as _clearUploadDue,
  noteUploadDueAttempt as _noteUploadDueAttempt, parkUploadDue as _parkUploadDue,
} from './upload-due.mjs';
import { acquireLock as _acquireLock, runLock } from './single-instance-lock.mjs';
import { orDefault } from './compat.mjs';
import { diagnosticsStep } from './upload-step-diagnostics.mjs';
import { installationBindingStep } from './upload-step-binding.mjs';
import { sessionStartDueHandler } from './session-start-upload.mjs';

// The background uploader (I-worker): ONE detached process per data root, started by
// lib/upload-trigger.mjs, drains every linked account's queue and runs the network half of every
// session a hook marked due. Hooks capture to disk and hand off; only this process reads
// credentials — once per account per run (`linkedSessions()`, held in `ctx.sessions` for every
// pass and every lock round) — and only this process posts.
//
// LOCKS. The worker holds `run:upload` (rank 1) for the whole run, renewed by a 60 s heartbeat.
// Under it the steps take `session` (runCheckpoint) and then `shared:queue-<key>` (flushQueue) —
// the order LOCK_ORDER requires — and never two `shared` locks at once: accounts drain serially.
//
// KILL TOLERANCE. On Windows a hook's timeout kills its Job Object, detached children included, so
// this process can die at any instruction. Nothing here deletes before the server confirmed it
// (flushQueue's own rule), a due marker is cleared only after its checkpoint returned, and a dead
// worker's lock is taken over once its lease (RUN_LEASE_MS) lapses and its pid fails the probe.
//
// IMPORTS. Everything that reads credentials or posts (checkpoint.mjs, accounts' linkedSessions
// path, usage-report-codex.mjs, env-guard.mjs) is imported lazily inside the run. The trigger
// imports this module on every hook for the status and scan helpers, and the checkpoint imports the
// trigger: a static edge to checkpoint.mjs here would be a cycle.

const STATUS_VERSION = 1;

// The lease on `run:upload`. Well above the heartbeat so a healthy worker never lapses, short
// enough that a worker killed without releasing blocks the next one for at most this long. A dead
// pid does NOT shorten it: the lock primitive honours an unexpired lease before it probes the pid,
// and the trigger asks the same primitive, so it answers `running` (no spawn) until the lease lapses.
export const RUN_LEASE_MS = 150000;
export const HEARTBEAT_MS = 60000;
// Passes in a row that moved nothing, with work left, before the run gives up as `stalled`.
export const MAX_IDLE_PASSES = 3;
export const IDLE_PASS_SLEEP_MS = 5000;
// Total sleep a run spends on passes whose only work left is waiting on another writer's lock.
export const WAIT_BUDGET_MS = 30000;
// Session-lock refusals that clear on their own once another writer (a history run included) lets go.
const WAITING_LOCK_REASONS = ['held', 'contended', 'reconciliation', 'migration'];
// After a stalled, crashed, watchdog-cut, no-account or blocked run the trigger does not respawn
// for this long: an offline machine must not pay a worker start and a credential read every 30 s.
export const RETRY_AFTER_MS = 5 * 60 * 1000;
// Run length when the caller gives no deadline (the entry point's watchdog is 5 min).
export const WORKER_RUN_MS = 270000;
// After the batch route fell back to the single route (an older server), post one by one this long.
export const BATCH_UNSUPPORTED_MS = 24 * 60 * 60 * 1000;

// Outcomes of a run that tried and failed: what it owed is still on disk because sending it failed,
// not because the run ran out of time (`deadline`) or had no account or a dark environment.
// `lock-failed`: the lock primitive refused for a filesystem reason (mkdir-, write-, unlink-,
// breaker-write-failed), not because another worker holds it.
const FAILED_OUTCOMES = ['stalled', 'crash', 'watchdog', 'lock-failed'];
// Outcomes the trigger backs off after (RETRY_AFTER_MS): every failure — a broken data root must not
// respawn a worker every 30 s — plus a run with no account or a dark environment.
const RETRY_OUTCOMES = FAILED_OUTCOMES.concat(['tracking-disabled', 'no-accounts']);
// Refusals of runLock('upload') that mean "another worker, or a migration, has the root": the
// worker exits `busy` with its status untouched, and a terminal drain (lib/upload-lock.mjs) waits.
export const BUSY_REFUSALS = ['held', 'contended', 'migration'];

// ── The status file ─────────────────────────────────────────────────────────────────────────────
// <data root>/upload-worker.json: { state, pid, startedAt, attemptedAt, lastRunAt, outcome,
// retryAfterAt, pendingWork, batchUnsupportedUntil, routeAbsent, dueDropped, migrationNotice,
// version }. The trigger writes `attemptedAt`, SessionStart clears `migrationNotice` once it told
// it; the worker writes the rest. `pendingWork` is true when a run that did not end in a clean `empty` left
// a report, due marker or rate-limit snapshot on disk at exit (hasPostableWork(0)): that work is
// OLDER than the run's own `lastRunAt`, which the trigger's scan cannot see, so the flag is what
// starts the next worker for it (after any `retryAfterAt`). A clean `empty`, or an exit with nothing
// on disk, clears it — an empty root never restarts a worker. NOT a liveness signal — a worker killed with its Job Object leaves
// `state: 'running'` behind, so "is a worker running" is answered from the upload lock only.

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** The status record, or {} when it is missing or unreadable. Never throws. */
export function readUploadStatus() {
  const value = readJson(uploadWorkerStatusFile(), null);
  return isPlainObject(value) ? value : {};
}

/**
 * Read-merge-write of the status record (atomic replace). Unlocked by design: a trigger and a
 * worker writing in the same instant can drop one field, and the worst outcomes are one extra
 * spawn or one 30 s delay. Returns false when the write failed. Never throws.
 */
export function writeUploadStatus(patch) {
  try {
    writeJsonSecure(uploadWorkerStatusFile(), Object.assign({}, readUploadStatus(), patch, { version: STATUS_VERSION }));
    return true;
  } catch {
    return false;
  }
}

// ── "Is there anything a worker could post" ─────────────────────────────────────────────────────
// One definition for the trigger's gate and the worker's re-scan before it exits `empty`.

function linkedKeys() {
  const keys = [];
  for (const row of listAccountsSync()) {
    if (row && row.status === AccountStatus.LINKED && typeof row.key === 'string') keys.push(row.key);
  }
  return keys;
}

// A read that failed for any reason but absence: the scan cannot tell whether work is there, so it
// counts as work — at exit it keeps `pendingWork`, and on the hook path it starts a worker only
// behind the backoff and the throttle, like any other work. Absent (ENOENT) is no work.
function inconclusive(error) {
  return !(error && error.code === 'ENOENT');
}

// Whether `key`'s usage-pending.json (the rate-limit snapshots the `rate-limits` step drains) was
// written after `since` and still holds a row. One stat per account; the file is read only when it
// is newer, and a drain that sent every row leaves `pending: []`, which is no work. A malformed file
// is none either: the drain reads no row from it.
function hasPendingRateLimits(key, since) {
  let file;
  try { file = usagePendingFile(key); } catch { return false; }
  let text;
  try {
    if (fs.statSync(file).mtimeMs <= since) return false;
    text = fs.readFileSync(file, 'utf-8');
  } catch (error) {
    return inconclusive(error);
  }
  let state;
  try { state = JSON.parse(text); } catch { return false; }
  return isPlainObject(state) && Array.isArray(state.pending) && state.pending.length > 0;
}

/**
 * True when a due marker was marked after `sinceMs`, or any linked account's queue holds a report
 * (`.json` or `.qjson`, never a held `__ask` file, a `.tmp` or a `.corrupt`) modified after it, or
 * its usage-pending.json was written after it and still holds a rate-limit snapshot.
 * Leftovers older than the last run never start a worker through this scan: after a clean `empty`
 * run they are what no retry could send, and the next new enqueue retries them; after any other
 * exit that left them on disk (this scan from 0, at exit) the status file's `pendingWork` starts one
 * instead. A queue or usage-pending read that fails for any reason but ENOENT counts as work
 * (inconclusive): an unreadable queue is never mistaken for an empty one. Stops at the first hit.
 * Sync; never throws.
 */
export function hasPostableWork(sinceMs) {
  const since = typeof sinceMs === 'number' && isFinite(sinceMs) ? sinceMs : 0;
  if (hasUploadDue(since)) return true;
  let keys;
  try { keys = linkedKeys(); } catch { return false; }
  for (const key of keys) {
    if (hasPendingRateLimits(key, since)) return true;
    let dir;
    try { dir = queueDir(key); } catch { continue; } // a hand-edited index with a bad key
    let names;
    try { names = fs.readdirSync(dir); } catch (error) { if (inconclusive(error)) return true; continue; }
    for (const name of names) {
      if (!isPostableQueueFile(name)) continue;
      let mtimeMs;
      try { mtimeMs = fs.statSync(path.join(dir, name)).mtimeMs; } catch (error) { if (inconclusive(error)) return true; continue; }
      if (mtimeMs > since) return true;
    }
  }
  return false;
}

/**
 * Whether a worker will (re)try this work soon — now, or once a backoff or the attempt throttle has
 * passed — given the status record: the last run left work on disk (`pendingWork`), or
 * `hasWorkSince(lastRunAt)` sees work newer than the last run, which it has not tried yet. The ONE
 * answer for the trigger's gate (with hasPostableWork) and for the history audit that defers to the
 * worker (with its own queue names), so a report the trigger will start a worker for is never
 * counted as the drain's final verdict, and one it will not is never waited on as busy. Throws only
 * what `hasWorkSince` throws: the trigger answers 'failed' for that.
 */
export function workerWillRetry(status, hasWorkSince) {
  const record = isPlainObject(status) ? status : {};
  if (record.pendingWork === true) return true;
  const lastRunAt = Number(record.lastRunAt);
  return hasWorkSince(isFinite(lastRunAt) ? lastRunAt : 0) === true;
}

/**
 * Whether the retry workerWillRetry promises is the retry of a FAILURE: the last run ended in one
 * (FAILED_OUTCOMES) and left work on disk (`pendingWork`). The history audit that defers to the
 * worker still comes back at the busy delay, but charges its request an attempt, so a queue that
 * keeps failing (5xx) reaches the retry and give-up notices instead of expiring silently. Work merely
 * newer than a run that left nothing is not a failure, and neither is a worker running now — the
 * caller asks the lock for that, since this record still holds the previous run's outcome. Never
 * throws.
 */
export function workerRetryFailing(status) {
  const record = isPlainObject(status) ? status : {};
  return record.pendingWork === true && FAILED_OUTCOMES.indexOf(record.outcome) !== -1;
}

/**
 * The status patch a finished run records. The entry point's crash and watchdog exits write it too.
 * `hasWork` is the work scan (hasPostableWork unless a test injects one), asked from 0 — everything
 * on disk, however old — and only when the exit was not a clean `empty`.
 */
export function workerExitStatus(outcome, at, hasWork) {
  const scan = typeof hasWork === 'function' ? hasWork : hasPostableWork;
  let owed = false;
  if (outcome !== 'empty') {
    try { owed = scan(0) === true; } catch { owed = true; }
  }
  return {
    state: 'idle',
    lastRunAt: at,
    outcome,
    retryAfterAt: RETRY_OUTCOMES.indexOf(outcome) !== -1 ? at + RETRY_AFTER_MS : null,
    pendingWork: owed,
  };
}

// ── Steps ───────────────────────────────────────────────────────────────────────────────────────
// A step is `{ name, run(ctx) }`; `run` may be async and answers
//   { progress, remaining, trackingDisabled?, batchUnsupported? }
//   progress          things this pass settled for good (posted, rejected, expired, cleared)
//   remaining         things still owed that a later pass could settle (failed, deferred, busy)
//   waiting           the part of `remaining` held up only by another writer's lock
//   trackingDisabled  the server says every account is dark — the run ends `tracking-disabled`
//   batchUnsupported  the batch route fell back to the single route — batching stops for 24 h
// A missing or malformed answer reads as zeros; a throw reads as `remaining: 1`, never as a crash.
// ctx = { sessions, deadline, now, fetchImpl, batch, status, deps, due }: `sessions` is the run's
// single linkedSessions() read, `due` the listUploadDue() snapshot taken at the start of THIS pass
// (a step registered before `due-sessions` sees the entries before they are cleared). Steps must
// start nothing at or past `deadline` and must take locks in LOCK_ORDER below `run`.

function count(value) {
  const n = Number(value);
  return isFinite(n) && n > 0 ? n : 0;
}

function stepResult(value) {
  const v = isPlainObject(value) ? value : {};
  return {
    progress: count(v.progress),
    remaining: count(v.remaining),
    waiting: count(v.waiting),
    trackingDisabled: v.trackingDisabled === true,
    batchUnsupported: v.batchUnsupported === true,
  };
}

function pastDeadline(ctx) {
  return ctx.now() >= ctx.deadline;
}

// An injected implementation from ctx.deps (tests), else the real one, loaded on first use.
async function impl(ctx, name, load) {
  const injected = ctx.deps ? ctx.deps[name] : null;
  return typeof injected === 'function' ? injected : load();
}

function withFetch(ctx, opts) {
  if (ctx.fetchImpl) opts.fetchImpl = ctx.fetchImpl;
  return opts;
}

// Route-absent file names kept per account in the status record, at most this many.
const ROUTE_ABSENT_FILES_MAX = 200;

/**
 * The queue files of `key` the last drain kept because the report route was absent (404/405), as a
 * Set: status field `routeAbsent`, rewritten by every queue step that answered for the account. The
 * MCP watcher's reconcile tolerates exactly these, as reconcileSession tolerates `routeAbsent`.
 */
export function routeAbsentFilesFor(key) {
  const all = readUploadStatus().routeAbsent;
  const names = isPlainObject(all) && Array.isArray(all[key]) ? all[key] : [];
  return new Set(names.filter((name) => typeof name === 'string'));
}

// Every account's queue, one after another: flushQueue takes `shared:queue-<key>` and two rank-3
// locks at once in one process is a 'lock-order' refusal, not a wait.
const queueStep = {
  name: 'queue',
  async run(ctx) {
    const flushQueue = await impl(ctx, 'flushQueue', async () => (await import('./checkpoint.mjs')).flushQueue);
    const out = { progress: 0, remaining: 0, trackingDisabled: false, batchUnsupported: false };
    let answered = 0;
    let dark = 0;
    const kept = {};
    for (const session of ctx.sessions) {
      if (pastDeadline(ctx)) { out.remaining += 1; continue; }
      let r;
      try {
        // guardChecked: the full guard ran once before this run's lock, so a 401 renewal skips it.
        r = await flushQueue(session.key, session, withFetch(ctx, { deadline: ctx.deadline, now: ctx.now, batch: ctx.batch, guardChecked: true }));
      } catch {
        out.remaining += 1;
        continue;
      }
      const res = isPlainObject(r) ? r : {};
      if (res.lockSkipped === true) { out.remaining += 1; continue; }
      answered += 1;
      kept[session.key] = (Array.isArray(res.routeAbsentFiles) ? res.routeAbsentFiles : []).slice(0, ROUTE_ABSENT_FILES_MAX);
      if (res.trackingDisabled === true) dark += 1;
      if (res.batchUnsupported === true) out.batchUnsupported = true;
      out.progress += count(res.flushed) + count(res.rejected) + count(res.expired) + count(res.quarantined);
      // A 404/405 keeps the file and counts it in `failed` (`routeAbsent`), but no retry inside this
      // run makes the route appear: not work left, as reconcileSession treats it.
      out.remaining += Math.max(0, count(res.failed) - count(res.routeAbsent)) + count(res.deferred);
    }
    out.trackingDisabled = answered > 0 && dark === answered;
    // An account this pass did not answer for keeps its last list.
    if (answered > 0) {
      const prior = readUploadStatus().routeAbsent;
      writeUploadStatus({ routeAbsent: Object.assign({}, isPlainObject(prior) ? prior : {}, kept) });
    }
    return out;
  },
};

// Per-run memory for the due-sessions step, keyed on the run's `ctx.sessions` array (the same array
// on every pass of one run, a new one per run): the checkpoint recipients, the sessions already
// charged a failed run, the handlers that already settled a marker, and the markers (sessionId +
// markedAt) already handled this run with the work-left count each contributes to later passes.
const dueRunStates = new WeakMap();

function dueRunState(ctx) {
  let state = dueRunStates.get(ctx.sessions);
  if (!state) {
    state = { recipients: null, charged: new Set(), handlerSettled: new Map(), handled: new Map() };
    dueRunStates.set(ctx.sessions, state);
  }
  return state;
}

// Who a due checkpoint enqueues for: the run's tokened sessions PLUS every linked account that could
// not produce a token this run, tokenless (checkpoint's listRecipients, an index read and no
// credential read). Handing runCheckpoint `options.sessions` skips its own merge, and without these
// rows the cursor would advance past segments a momentarily tokenless account never received.
// Tokenless rows are queued for and skipped on the network by runCheckpoint itself.
async function checkpointRecipients(ctx, state) {
  if (state.recipients !== null) return state.recipients;
  const list = await impl(ctx, 'listRecipients', async () => (await import('./checkpoint.mjs')).listRecipients);
  let rows;
  try { rows = await list(ctx.sessions, {}); } catch { rows = ctx.sessions; }
  state.recipients = Array.isArray(rows) ? rows : ctx.sessions;
  return state.recipients;
}

// ── Due handlers ────────────────────────────────────────────────────────────────────────────────
// Per-marker work beyond the checkpoint (Task 10's session-start work for `sessionStart: true`).
// `handler(entry, ctx) → Promise<{ settled: boolean }>`; a throw or any other answer is unsettled.
// Every handler runs for every due entry after its checkpoint, whatever the checkpoint answered; a
// handler that settled an entry is not run for it again in the same run, but may be in a later run
// if the marker survives, so handlers must be idempotent.
const DUE_HANDLERS = [];

/** Register a due handler; returns a function that unregisters it. A duplicate is ignored. */
export function registerDueHandler(handler) {
  if (typeof handler !== 'function') throw new TypeError('a due handler must be a function (entry, ctx) => { settled }');
  if (DUE_HANDLERS.indexOf(handler) === -1) DUE_HANDLERS.push(handler);
  return () => {
    const at = DUE_HANDLERS.indexOf(handler);
    if (at !== -1) DUE_HANDLERS.splice(at, 1);
  };
}

// SessionStart's network half (whoami, repo status, check-in, update check) for `sessionStart: true`.
registerDueHandler(sessionStartDueHandler);

// Did the checkpoint deliver everything this marker owes? → null when it did, else why not.
//   lockSkipped                 someone else is mid-checkpoint on the session (not this marker's fault)
//   gated / unnamedSession      nothing is owed and nothing ever will be: settled
//   failed / deferred           the transaction did not commit (ownership-lost, not-checkpointed, ...)
//   timeline asked, not confirmed — the POST is best-effort inside a committed checkpoint, so a
//   `committed` answer says nothing about it; only `timelineConfirmed === true` does.
//   errors-unsent               an API error is still parked for a sender that had a token: the
//   checkpoint parks it and moves on, so only `errorsPendingLive` says a live post failed. Asked
//   after the timeline, so a timeline shortfall that is work left is never hidden behind it.
function checkpointShortfall(r, entry) {
  if (!isPlainObject(r)) return 'no-result';
  if (r.lockSkipped === true) return 'session-busy';
  if (r.gated === true || r.unnamedSession === true) return null;
  if (r.outcome === 'failed') return 'checkpoint-failed';
  if (r.outcome === 'deferred') return `deferred:${orDefault(r.reason, 'unknown')}`;
  if (entry.timeline === true && r.timelineConfirmed !== true) {
    // Every LIVE sender has it; only a sender with no token this run is missing it.
    return r.timelineConfirmedLive === true ? 'timeline-tokenless' : 'timeline-unconfirmed';
  }
  if (r.errorsPendingLive === true) return 'errors-unsent';
  return null;
}

// Shortfalls no later pass of THIS run can change: `ctx.sessions` is read once, so a tokenless
// sender stays tokenless, and an unresolvable transcript stays unresolvable. They keep the marker for
// a later run but are not work left, so they never make a run `stalled` (which would back off every
// account's uploads for 5 minutes) — the same rule the queue step applies to `routeAbsent`.
// `charge`: whether the run counts against the marker's attempt cap. A tokenless sender is the
// account's state, not the marker's failure; a transcript that cannot be found is the marker's.
// An error a live sender refused is the third: a marker is handled once per run, so no later pass
// retries it, and an error route an older server lacks (404) or a payload it refuses would
// otherwise stall every run that handles the session. Charged, so the attempt cap still drops it;
// the error itself stays parked in the session's state for the next checkpoint either way.
const PARKED_SHORTFALLS = {
  'timeline-tokenless': { charge: false },
  'deferred:not-checkpointed': { charge: true },
  'errors-unsent': { charge: true },
};

// A marker whose only debt is SessionStart's (no timeline asked) is not charged for a transcript
// that cannot be resolved while it is young: at session start Codex may not have written the
// rollout yet, and runs before the session's first turn would otherwise spend the cap its later
// marks inherit. Past the grace it is charged like any other, so a session that never wrote a
// rollout is dropped by the cap rather than re-checkpointed (a sessions-tree walk) every run.
export const START_GRACE_MS = 24 * 60 * 60 * 1000;

const owesOnlyStart = (entry) => entry.sessionStart === true && entry.timeline !== true;

function chargesFor(reason, parked, entry, now) {
  if (parked && !parked.charge) return false;
  if (reason !== 'deferred:not-checkpointed' || !owesOnlyStart(entry)) return true;
  return now - entry.markedAt >= START_GRACE_MS;
}

// A marker parked as `timeline-tokenless` records the accounts that still owe its timeline
// (parkUploadDue → `owedKeys`). Until one of them has a token, a run skips its checkpoint — no
// transcript read, no git, and no re-POST of the timeline to the live senders, whose signature
// checkpoint cannot seal while a sender is missing. Its due handlers still run (a session-start
// marker parked for its timeline must not freeze its session-start work until then); a settled
// handler settles at once in every later run (they are idempotent), so the marker then owes only
// its timeline, and an unsettled one is neither work left nor a charged run while parked.
// Uncharged by design, so it is bounded by age instead: a parked marker this much older than its
// last mark is dropped.
export const OWED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function tokenedKeys(ctx) {
  const keys = {};
  for (const s of ctx.sessions) if (s && s.token && typeof s.key === 'string') keys[s.key] = true;
  return keys;
}

function owedNow(entry, ctx) {
  const tokened = tokenedKeys(ctx);
  return entry.owedKeys.some((k) => tokened[k] === true);
}

async function runDueHandlers(entry, ctx, state) {
  const key = `${entry.sessionId}|${entry.markedAt}`;
  let settled = true;
  for (const handler of DUE_HANDLERS.slice()) {
    let done = state.handlerSettled.get(handler);
    if (!done) { done = new Set(); state.handlerSettled.set(handler, done); }
    if (done.has(key)) continue;
    let r = null;
    try { r = await handler(entry, ctx); } catch { r = null; }
    if (isPlainObject(r) && r.settled === true) done.add(key);
    else settled = false;
  }
  return settled;
}

// The network half of each session a hook marked due. runCheckpoint takes the session's own lock;
// it is handed the run's recipients, so it never reads credentials again, and the remaining run time
// as its budget, so its inner drains stay inside the worker's deadline. The marker is cleared only
// when the checkpoint delivered what it owed AND every due handler settled, and only if nobody
// re-marked it meanwhile.
// ONCE PER MARKER PER RUN: a marker's checkpoint and handlers run at most once per run (a re-mark is
// a new marker). Later passes reuse the first answer, so a pass never re-POSTs a timeline. Only a
// busy session lock — the checkpoint did not run at all — is retried on the next pass.
// An unsettled marker is work left (a run that cannot settle it stalls and backs off) unless its
// shortfall is parked (PARKED_SHORTFALLS); it is charged one failed run, at most once per run; at
// MAX_DUE_ATTEMPTS it is dropped and the status file records which one and why (`dueDropped`).
// `deps.checkpointDeps` is merged into runCheckpoint's deps — a test seam (git, transcript fakes).
const dueSessionsStep = {
  name: 'due-sessions',
  async run(ctx) {
    const deps = ctx.deps || {};
    const entries = Array.isArray(ctx.due) ? ctx.due : orDefault(deps.listUploadDue, _listUploadDue)();
    const out = { progress: 0, remaining: 0 };
    if (entries.length === 0) return out;
    const runCheckpoint = await impl(ctx, 'runCheckpoint', async () => (await import('./checkpoint.mjs')).runCheckpoint);
    const clear = orDefault(deps.clearUploadDue, _clearUploadDue);
    const noteAttempt = orDefault(deps.noteUploadDueAttempt, _noteUploadDueAttempt);
    const state = dueRunState(ctx);
    const recipients = await checkpointRecipients(ctx, state);
    const park = orDefault(deps.parkUploadDue, _parkUploadDue);
    for (const entry of entries) {
      const key = `${entry.sessionId}|${entry.markedAt}`;
      if (state.handled.has(key)) { out.remaining += state.handled.get(key); continue; }
      const owed = Array.isArray(entry.owedKeys) && entry.owedKeys.length > 0;
      // Too old to be worth another try: a parked marker whose owed account never came back, or one
      // that owes only SessionStart's work for a session that never got further (the same 7 days).
      const expired = owed ? 'owed-expired' : (owesOnlyStart(entry) ? 'start-expired' : null);
      if (expired !== null && ctx.now() - entry.markedAt > OWED_MAX_AGE_MS) {
        state.handled.set(key, 0);
        // false = re-marked since it was listed: new work, with its owed keys cleared.
        if (clear(entry)) {
          writeUploadStatus({ dueDropped: { sessionId: entry.sessionId, reason: expired, attempts: entry.attempts, at: ctx.now() } });
          out.progress += 1;
        }
        continue;
      }
      // Parked, and no account that owes it has a token in this run: no checkpoint can deliver it.
      if (owed && !owedNow(entry, ctx)) {
        if (!pastDeadline(ctx)) await runDueHandlers(entry, ctx, state);
        state.handled.set(key, 0);
        continue;
      }
      if (pastDeadline(ctx)) { out.remaining += 1; continue; }
      let shortfall;
      let lockReason = null;
      try {
        const r = await runCheckpoint(
          { session_id: entry.sessionId, transcript_path: entry.transcriptPath, cwd: entry.cwd },
          Object.assign({}, deps.checkpointDeps, withFetch(ctx, { now: ctx.now })),
          // skipFlush: the `queue` step drains every account, batched; an inline flush here would
          // drain unbatched while holding the session lock the hooks are waiting on. The binding
          // that rode on it runs as the `installation-binding` step. liveSinceLinkOnly: a session
          // with no cursor that was last written before the link is past (the offer's, not ours).
          {
            sessions: recipients, emitTimeline: entry.timeline === true, budgetMs: Math.max(1, ctx.deadline - ctx.now()),
            skipFlush: true, liveSinceLinkOnly: true,
          },
        );
        shortfall = checkpointShortfall(r, entry);
        if (shortfall === 'session-busy') lockReason = r.lockReason;
      } catch {
        shortfall = 'checkpoint-threw';
      }
      const handlersSettled = await runDueHandlers(entry, ctx, state);
      if (shortfall === null && handlersSettled) {
        // false = re-marked since it was listed: new work, picked up by the next pass.
        if (clear(entry)) out.progress += 1;
        else out.remaining += 1;
        continue;
      }
      const reason = shortfall === null ? 'handler-unsettled' : shortfall;
      // A busy session lock is another writer mid-checkpoint, not a failure of this marker: the
      // checkpoint never ran, so the next pass may run it.
      if (reason === 'session-busy') {
        out.remaining += 1;
        if (WAITING_LOCK_REASONS.indexOf(lockReason) !== -1) out.waiting = (out.waiting || 0) + 1;
        continue;
      }
      const parked = PARKED_SHORTFALLS[reason] || null;
      const left = parked ? 0 : 1;
      state.handled.set(key, left);
      if (reason === 'timeline-tokenless') {
        // The linked accounts with no token this run: the ones still owed this timeline.
        park(entry, recipients.filter((r) => r && !r.token && typeof r.key === 'string').map((r) => r.key));
      }
      if (chargesFor(reason, parked, entry, ctx.now()) && !state.charged.has(entry.sessionId)) {
        state.charged.add(entry.sessionId);
        const noted = noteAttempt(entry);
        if (noted && noted.dropped) {
          writeUploadStatus({ dueDropped: { sessionId: entry.sessionId, reason, attempts: noted.attempts, at: ctx.now() } });
          state.handled.set(key, 0);
          out.progress += 1;
          continue;
        }
      }
      out.remaining += left;
    }
    return out;
  },
};

// One drain per target: a multi-workspace account owes every workspace each row, so it drains once
// per workspace clone, exactly as the checkpoint's own drain does.
function rateLimitTargets(session) {
  if (!isMultiTenant(session)) return [session];
  return tenantsOf(session).map((t) => Object.assign({}, session, { tenantId: t.id }));
}

// Leftovers that a later pass could still send. A rejection keeps its row and its tail, but no
// retry inside this run will change the server's answer, so it is not work left.
const RATE_LIMIT_RETRYABLE = ['deadline', 'network'];

const rateLimitsStep = {
  name: 'rate-limits',
  async run(ctx) {
    const drain = await impl(ctx, 'drainRateLimitSnapshots', async () => (await import('./usage-report-codex.mjs')).drainRateLimitSnapshots);
    const out = { progress: 0, remaining: 0 };
    for (const session of ctx.sessions) {
      for (const target of rateLimitTargets(session)) {
        if (pastDeadline(ctx)) { out.remaining += 1; continue; }
        let r;
        try {
          r = await drain(session.key, target, withFetch(ctx, { deadline: ctx.deadline, now: ctx.now }));
        } catch {
          out.remaining += 1;
          continue;
        }
        const res = isPlainObject(r) ? r : {};
        out.progress += count(res.posted);
        if (RATE_LIMIT_RETRYABLE.indexOf(res.reason) !== -1) out.remaining += count(res.deferred);
      }
    }
    return out;
  },
};

/** The steps every pass runs, in order. Extend through registerUploadStep, never by hand. */
export const UPLOAD_STEPS = [queueStep, dueSessionsStep, rateLimitsStep];

/**
 * Add a step (I-worker): before the step named `options.before`, or at the end when that is absent
 * or unknown. A step with the name of an existing one replaces it, so a module registering on load
 * is idempotent.
 */
export function registerUploadStep(step, options = {}) {
  if (!isPlainObject(step) || typeof step.name !== 'string' || step.name === '' || typeof step.run !== 'function') {
    throw new TypeError('an upload step needs a name and a run(ctx) function');
  }
  const existing = UPLOAD_STEPS.findIndex((s) => s.name === step.name);
  if (existing !== -1) UPLOAD_STEPS.splice(existing, 1);
  const before = options ? options.before : null;
  const at = before == null ? -1 : UPLOAD_STEPS.findIndex((s) => s.name === before);
  if (at === -1) UPLOAD_STEPS.push(step);
  else UPLOAD_STEPS.splice(at, 0, step);
}

registerUploadStep(diagnosticsStep);
registerUploadStep(installationBindingStep, { before: 'diagnostics' });

// ── The run ─────────────────────────────────────────────────────────────────────────────────────

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function defaultCheckEnvironment() {
  const guard = await import('./env-guard.mjs');
  return guard.checkEnvironment();
}

/**
 * One worker run → { outcome, passes, progress }. outcome: 'busy' (another worker holds the lock;
 * the status is left alone) | 'lock-failed' (the lock could not be written; backs off) | 'empty' |
 * 'stalled' | 'deadline' | 'lock-lost' | 'no-accounts' | 'tracking-disabled' | 'crash'. Never throws. `deps.onLock(handle)` receives each lock handle so
 * the entry point can release it from its watchdog and crash exits.
 */
export async function runUploadWorker(deps = {}) {
  const acquire = orDefault(deps.acquireLock, _acquireLock);
  const onLock = orDefault(deps.onLock, () => {});
  const setPriority = orDefault(deps.setPriority, os.setPriority);
  const now = orDefault(deps.now, Date.now);
  const deadline = typeof deps.deadline === 'number' && isFinite(deps.deadline) ? deps.deadline : now() + WORKER_RUN_MS;
  const sleep = orDefault(deps.sleep, defaultSleep);
  const setIntervalImpl = orDefault(deps.setIntervalImpl, setInterval);
  const clearIntervalImpl = orDefault(deps.clearIntervalImpl, clearInterval);
  const pid = orDefault(deps.pid, () => process.pid);
  const checkEnvironment = orDefault(deps.checkEnvironment, defaultCheckEnvironment);
  const linkedSessions = orDefault(deps.linkedSessions, _linkedSessions);
  const hasWork = orDefault(deps.hasPostableWork, hasPostableWork);
  const listDue = orDefault(deps.listUploadDue, _listUploadDue);
  const steps = Array.isArray(deps.steps) ? deps.steps : UPLOAD_STEPS;
  const lease = () => acquire(runLock('upload'), { leaseMs: RUN_LEASE_MS });

  // The FULL environment guard, once, BEFORE the run lock. The migration it may perform
  // (withMigrationRoots) refuses while any run lock is held, so a guard run under run:upload would
  // answer active-writer forever — and once the hooks run only the credential-free guard, this is
  // the one place left that migrates. A throw is remembered and reported as `crash` below.
  let guardOk = false;
  let guardThrew = false;
  try {
    const guard = await checkEnvironment();
    guardOk = Boolean(guard) && (guard.status === 'ok' || guard.status === 'migrated');
    // The hooks never migrate (their guard is credential-free), so a migration this guard ran is
    // told on the next SessionStart (lib/session-start.mjs takeMigrationNotice).
    if (guardOk && guard.status === 'migrated' && typeof guard.message === 'string') writeUploadStatus({ migrationNotice: guard.message });
  } catch {
    guardThrew = true;
  }

  let acquired = lease();
  if (!acquired || !acquired.ok) {
    const reason = acquired ? acquired.reason : null;
    if (BUSY_REFUSALS.indexOf(reason) !== -1) return { outcome: 'busy', passes: 0, progress: 0 };
    // The filesystem refused (mkdir-, write-, unlink-, breaker-write-failed). Unlocked status write
    // by necessity — the lock is exactly what failed — and best-effort for the same reason.
    // No `lastRunAt`: it is the trigger's queue-file cutoff, and no run happened.
    writeUploadStatus({ state: 'idle', outcome: 'lock-failed', retryAfterAt: now() + RETRY_AFTER_MS });
    return { outcome: 'lock-failed', passes: 0, progress: 0 };
  }

  // Below-normal priority: a long drain must never compete with the user's editor or build.
  try { setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best-effort */ }

  const run = { passes: 0, progress: 0 };
  // Read ONCE per run, across both lock rounds: the guard, the credentials, the status, the batch flag.
  let sessions = null;
  let status = null;
  let batch = true;
  let outcome = null;
  let rounds = 0;
  let waited = 0;
  let darkSeen = false;

  for (;;) {
    rounds += 1;
    const handle = acquired.handle;
    onLock(handle);
    let lockLost = false;
    let heartbeat = null;
    let roundOutcome = null;
    let lastPassStart = null;
    try {
      writeUploadStatus({ state: 'running', pid: pid(), startedAt: now() });
      heartbeat = setIntervalImpl(() => {
        let renewed = null;
        try { renewed = handle.renew({ leaseMs: RUN_LEASE_MS }); } catch { renewed = null; }
        // 'lost' is a successor's generation on disk. A busy breaker ('contended') is not.
        if (renewed && !renewed.ok && (renewed.reason === 'lost' || renewed.reason === 'released')) lockLost = true;
      }, HEARTBEAT_MS);
      // The watchdog and in-flight requests keep the process alive; the heartbeat must not.
      if (heartbeat && typeof heartbeat.unref === 'function') heartbeat.unref();

      if (sessions === null) {
        if (guardThrew) throw new Error('environment guard failed');
        if (!guardOk) {
          roundOutcome = 'tracking-disabled';
        } else {
          const linked = await linkedSessions(deps);
          sessions = (Array.isArray(linked) ? linked : []).filter((s) => s != null && s.token);
          status = readUploadStatus();
          batch = !(Number(status.batchUnsupportedUntil) > now());
        }
      }
      if (roundOutcome === null && sessions.length === 0) roundOutcome = 'no-accounts';

      let idle = 0;
      while (roundOutcome === null) {
        if (lockLost) { roundOutcome = 'lock-lost'; break; }
        const passStart = now();
        if (passStart >= deadline) { roundOutcome = 'deadline'; break; }
        run.passes += 1;
        lastPassStart = passStart;
        const ctx = { sessions, deadline, now, fetchImpl: orDefault(deps.fetchImpl, null), batch, status, deps, due: listDue() };
        const pass = { progress: 0, remaining: 0, waiting: 0, trackingDisabled: false, batchUnsupported: false };
        for (const step of steps) {
          if (lockLost) break;
          let r;
          try { r = stepResult(await step.run(ctx)); } catch { r = stepResult({ remaining: 1 }); }
          pass.progress += r.progress;
          pass.remaining += r.remaining;
          pass.waiting += r.waiting;
          if (r.trackingDisabled) pass.trackingDisabled = true;
          if (r.batchUnsupported) pass.batchUnsupported = true;
        }
        run.progress += pass.progress;
        if (pass.batchUnsupported && batch) {
          writeUploadStatus({ batchUnsupportedUntil: now() + BATCH_UNSUPPORTED_MS });
          batch = false;
        }
        if (lockLost) { roundOutcome = 'lock-lost'; break; }
        if (pass.trackingDisabled) {
          // The first dark pass may be a stale history-only cache that this pass refreshed: one more pass.
          if (darkSeen) { roundOutcome = 'tracking-disabled'; break; }
          darkSeen = true;
          continue;
        }
        // Passes repeat until one makes no progress: what this pass sent may have unblocked more.
        if (pass.progress > 0) { idle = 0; continue; }
        // Nothing left that this pass saw: re-scan for what a hook added meanwhile before leaving.
        if (pass.remaining === 0 && !hasWork(passStart)) { roundOutcome = 'empty'; break; }
        // Everything left waits on another writer's lock: wait it out, up to WAIT_BUDGET_MS per run.
        if (pass.remaining > 0 && pass.remaining === pass.waiting && waited < WAIT_BUDGET_MS) {
          waited += IDLE_PASS_SLEEP_MS;
          await sleep(IDLE_PASS_SLEEP_MS);
          continue;
        }
        // Moved nothing: offline, 401, a busy lock. Back off, and give up rather than poll forever.
        idle += 1;
        if (idle >= MAX_IDLE_PASSES) { roundOutcome = 'stalled'; break; }
        await sleep(IDLE_PASS_SLEEP_MS);
      }
      // A deadline reached with nothing moved — by passes that sent nothing, or before the first
      // pass — is a stall, so the trigger backs off too: a `deadline` exit that left work on disk
      // sets `pendingWork` without a backoff, and only progress earns an immediate respawn.
      if (roundOutcome === 'deadline' && run.progress === 0) roundOutcome = 'stalled';
    } catch {
      roundOutcome = 'crash';
    } finally {
      if (heartbeat !== null) { try { clearIntervalImpl(heartbeat); } catch { /* best-effort */ } }
      outcome = roundOutcome === null ? 'crash' : roundOutcome;
      // Status BEFORE release: a hook that looks in between still sees the lock and does not spawn,
      // and whatever it enqueued is caught by the re-scan below.
      writeUploadStatus(workerExitStatus(outcome, now(), hasWork));
      try { handle.release(); } catch { /* the lease lapses on its own */ }
    }

    // A hook that enqueued between the last re-scan and the release saw the lock held and did not
    // spawn, and its file may be older than lastRunAt, so the trigger would skip it. Pick it up
    // here — once: a run is not a loop around the lock.
    if (outcome !== 'empty' || rounds >= 2 || lastPassStart === null) break;
    let again = false;
    try { again = hasWork(lastPassStart); } catch { again = false; }
    if (!again || now() >= deadline) break;
    acquired = lease();
    if (!acquired || !acquired.ok) break;
  }
  return { outcome, passes: run.passes, progress: run.progress };
}
