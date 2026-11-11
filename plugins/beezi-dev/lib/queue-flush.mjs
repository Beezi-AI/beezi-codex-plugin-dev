// The live-queue drain: every file in one account's queue/ read, judged, POSTed and removed, under
// that account's `shared:queue-<key>` lock. Moved out of lib/checkpoint.mjs, which re-exports
// flushQueue so its callers keep importing it from there.
import fs from 'fs';
import path from 'path';
import { fetchCompat } from './fetch-compat.mjs';
import { orDefault } from './compat.mjs';
import { getAccessToken as _getAccessToken } from './token.mjs';
import { queueDir, stateDir } from './paths.mjs';
import { isUsableSessionId } from './transcript-codex.mjs';
import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson, POST_TIMEOUT_MS } from './http.mjs';
import { ANONYMIZATION_KEY_MISSING, reportForWire } from './anonymization.mjs';
import { readJson, readJsonSalvaged } from './fs-store.mjs';
import { isLiveTrackingAllowed, markTrackingDisabled, readTrackingState, isTenantDark, markTenantDark } from './tracking.mjs';
import { readSessionWorkspace, tenantsOf, isMultiTenant, QUEUE_HOLD_MS } from './workspace.mjs';
import { recordCoverageAttempts, ensureAttemptStores } from './session-coverage.mjs';
import { unwrapQueueFile, releaseHeldFile, isQueueFile, isAskFile } from './workspace-queue.mjs';
import { withLockAsync, sharedLock } from './single-instance-lock.mjs';
import { recordIssue, DIAGNOSTIC_CODES, DIAGNOSTIC_SOURCES } from './diagnostics.mjs';
import { postReportBatch, RETRY_LATER_STATUSES } from './batch-upload.mjs';
import { planBatches, BATCH_MAX_ITEMS, BATCH_MAX_BYTES } from './batch-plan.mjs';
import { orderQueueFiles } from './queue-order.mjs';

// The session's state file, as lib/checkpoint.mjs writes it; the drain reads only its cwd.
function loadState(id) {
  return readJson(path.join(stateDir(), `${id}.json`), {});
}

// Lease for one queue drain. The drain is a serial loop of network posts, so this is the one lease
// that has to cover real latency; the CLI path can exceed it, and the same reasoning applies —
// nobody evicts a holder that is still alive, and release re-reads its own generation before it
// unlinks anything.
const QUEUE_LOCK_LEASE_MS = 60_000;

// Once tracking is off, queued reports are held for QUEUE_HOLD_MS (lib/workspace.mjs): a tenant
// that converts to paid inside the window flushes them normally on its first live session; after it
// they expire. The same window bounds a file held for a workspace answer.

// Expire queue files older than the hold window. Only meaningful while tracking is off — a
// live-mode queue drains through flushing, not expiry.
function sweepHeldQueue(dir, result, now) {
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      if (now - fs.statSync(filePath).mtimeMs > QUEUE_HOLD_MS) {
        fs.unlinkSync(filePath);
        result.expired += 1;
      }
    } catch { /* best-effort */ }
  }
}

// RETRY_LATER_STATUSES (lib/batch-upload.mjs, shared with the batch route) are the server saying
// "not now", never a verdict on the payload: kept and retried like a 5xx.
// After this many network-class failures IN A ROW (throw, 5xx, 408, 429) the rest of the drain is
// deferred: a down or throttling API will not answer the next file either.
const MAX_NETWORK_ERRORS = 3;
// An error body is read only to find a message or a code. Fetch's timeout stops at the headers, so
// without this a stalled body would hold the queue lock indefinitely.
const BODY_READ_MS = 1000;
// One batch POST: up to 50 reports and 4 MiB, so a single report's POST_TIMEOUT_MS is too short.
const BATCH_TIMEOUT_MS = 20_000;
// No batch is started with less than this left before the deadline: it could only time out.
const BATCH_MIN_MS = 1000;
// A segmentId's trailing `:<from>-<to>`; what precedes it is the report's scope.
const SEGMENT_RANGE = /^(.*):\d+-\d+$/;
const TIMED_OUT = {};
async function readBodyBounded(res) {
  let timer;
  try {
    const body = await Promise.race([
      res.json(),
      new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), BODY_READ_MS); }),
    ]);
    if (body !== TIMED_OUT) return body;
    // Given up on: cancel the stream so the connection is not held open behind us.
    try {
      if (res.body && typeof res.body.cancel === 'function') Promise.resolve(res.body.cancel()).catch(() => {});
    } catch { /* best-effort */ }
    return null;
  } catch { return null; } finally { clearTimeout(timer); }
}

// Returns { flushed, rejected, failed, deferred, expired, quarantined, salvaged, unreadable,
// unnamed, workspacePending, trackingDisabled, lockSkipped, lockReason, lastError }. The five that
// are not their own names:
//   rejected     permanently declined by the server (4xx, e.g. branch not linked), as against
//                `failed`, which is transient or reversible and keeps the file for retry.
//   quarantined  unparseable, renamed to `<file>.corrupt` for inspection.
//   salvaged     recovered from a torn write and posted.
//   unnamed      carries a session id the plugin could not name, so it was left in place for the
//                quarantine sweep rather than posted.
//   workspacePending  held until a rule or New folders picks a workspace, or stamped for a
//                workspace the account has left; kept until QUEUE_HOLD_MS, then expired.
// `lockSkipped` means another process held the queue lock and this pass deferred without reading
// the directory at all; `lockReason` carries the primitive's refusal. `trackingDisabledWrite` is
// present only when the server sent a dark-mode verdict.
//
// deps.batch: true (the upload worker) posts the ready reports to /sessions/report-batch instead,
// unless BEEZI_NO_BATCH=1; deps.batchLimits ({ maxItems, maxBytes }) overrides the plan's limits.
// `batchUnsupported: true` is present only when a batch answer was not understood and the single
// route then delivered at least one report: the worker posts one by one for a while
// (batchUnsupportedUntil). A 401 never sets it.
// Write-up: docs/plans/2026-09-15-comment-archive.md.
export async function flushQueue(key, session, deps = {}) {
  const result = {
    flushed: 0, rejected: 0, failed: 0, deferred: 0, expired: 0,
    quarantined: 0, salvaged: 0, unreadable: 0, unnamed: 0,
    // A SUBSET of `failed`, not an alternative to it. These files were refused because the route
    // was not there, which is a different fact from a server error even though the outcome for the
    // file is the same (kept, retried) — and the user still has to be told, which is why `failed`
    // counts them too. Carried as a counter rather than folded into `lastError` because
    // reconcileSession needs the COUNT: "is every leftover a 404" is the question it asks.
    routeAbsent: 0,
    // The names of the files `routeAbsent` counts, so the upload worker can record exactly which
    // ones the watcher's reconcile may tolerate (lib/upload-worker.mjs queue step).
    routeAbsentFiles: [],
    workspacePending: 0,
    trackingDisabled: false, lastError: null,
  };
  // What the drain LEARNED about the tenant, carried out of the critical section rather than acted
  // on inside it. Writing tracking.json takes `shared:tracking`, and rank-3 locks are never nested:
  // reaching for it while holding `shared:queue` is refused with 'lock-order', which fails forever
  // rather than being retryable, so the dark-mode verdict would be lost every single time.
  // `darkTenants` is the multi-workspace form: only those workspaces go dark, not the account.
  const verdict = { disabledByServer: false, reason: null, darkTenants: [] };

  // ONE rank-3 `shared:queue-<key>` lock around the WHOLE drain (G-8-3 / R3). Every file in that
  // account's queue/ is read, POSTed and then unlinked, and two passes over the same directory
  // interleave those three steps: the losing pass re-POSTs a segment the winner already deleted
  // (idempotent server-side, merely wasteful) and, worse, its `unlinkSync` can remove a file the
  // other pass has not judged yet. `result.unreadable` — "a concurrent flush already unlinked it"
  // — is that race, counted.
  //
  // THE NAME CARRIES THE KEY, so two accounts never serialise against each other across processes
  // — and so a caller must never run two flushes at once IN one process: both are rank 3 under
  // different names, which is refused as 'lock-order' rather than waited out. Every fan-out site
  // drains the accounts one after another.
  //
  // The lock lives HERE, inside, so every caller is serialized without having to know: the upload
  // worker's steps and the track and sync drains that hold its lock (lib/upload-lock.mjs). Hooks and
  // the MCP watcher save local-only and never drain.
  //
  // Contention DEFERS rather than blocks. Nothing is lost by skipping — the files stay on disk and
  // the next checkpoint drains them — and a hook has a few milliseconds and no right to make the
  // holder wait.
  const run = await withLockAsync(
    sharedLock(`queue-${key}`),
    { leaseMs: QUEUE_LOCK_LEASE_MS },
    (handle) => drainQueue(key, session, deps, result, verdict, handle),
  );
  if (!run.ok) {
    result.lockSkipped = true;
    result.lockReason = run.reason;
    return result;
  }
  if (verdict.disabledByServer) {
    // Outside the queue lock by construction — see `verdict` above. withLockAsync released
    // `shared:queue` in its own finally before returning, so this is rank 3 AFTER rank 3, never
    // rank 3 inside it, which is exactly the sub-order the contract permits.
    //
    // The outcome is kept rather than discarded: 'held' is another writer and the next 403
    // re-records the verdict, but 'lock-order' would mean the release ordering above had broken
    // and every dark-mode verdict on this machine was being dropped in silence.
    try {
      result.trackingDisabledWrite = markTrackingDisabled(key, verdict.reason);
      if (result.trackingDisabledWrite.reason === 'lock-order') {
        recordIssue({
          code: DIAGNOSTIC_CODES.STATE_WRITE_FAILED,
          source: DIAGNOSTIC_SOURCES.CHECKPOINT,
        });
      }
    } catch { /* best-effort */ }
  }
  // Serially, for the same reason: each write takes `shared:tracking-<key>` on its own.
  for (const tenantId of verdict.darkTenants) {
    try {
      const written = markTenantDark(key, tenantId);
      if (written.reason === 'lock-order') {
        recordIssue({ code: DIAGNOSTIC_CODES.STATE_WRITE_FAILED, source: DIAGNOSTIC_SOURCES.CHECKPOINT });
      }
    } catch { /* best-effort */ }
  }
  return result;
}

// The drain itself. Split out of flushQueue so the lock above wraps it whole without re-indenting
// a hundred lines of judgement that has not changed.
async function drainQueue(key, session, deps, result, verdict, queueHandle) {
  const fetchImpl = deps.fetchImpl || fetchCompat;
  const now = orDefault(deps.now, Date.now);
  const getAccessToken = orDefault(deps.getAccessToken, _getAccessToken);
  // Epoch ms after which no further report is started. Null = drain everything (the CLI path);
  // hooks pass one, because a serial loop with only a per-request bound costs N × that bound, and
  // Codex kills the hook — reporting a failure — long before a backlog against a stalled API is
  // drained. Deferring is free: the files stay on disk and the next checkpoint retries them.
  const deadline = orDefault(deps.deadline, null);
  const onRequestTimeout = orDefault(deps.onRequestTimeout, () => {});

  const dir = queueDir(key);
  const tenants = tenantsOf(session);
  const multi = isMultiTenant(session);

  // Dark workspace: no readdir-and-post loop, just the hold-window sweep. Files stay for
  // QUEUE_HOLD_MS in case the tenant converts to paid, then expire. One tenant going dark says
  // nothing about the others — only this account's queue is held. An account in several
  // workspaces is gated per workspace in the loop instead; its account-wide mode is the web's.
  if (!multi && !isLiveTrackingAllowed(key)) {
    result.trackingDisabled = true;
    sweepHeldQueue(dir, result, now());
    return;
  }
  // Fail OPEN on an unreadable policy, as everywhere else.
  let trackingState = null;
  if (multi) { try { trackingState = readTrackingState(key); } catch { trackingState = null; } }
  // Each workspace's attempt file exists before anything is sent to it, so a later session with no
  // entry there was provably never attempted (Ruling 20).
  if (multi) ensureAttemptStores(key, session.clientId, tenants.map((t) => t.id), queueHandle);
  const darkThisFlush = new Set();
  const workspaceCache = new Map();
  const workspaceOf = (sessionId) => {
    if (!workspaceCache.has(sessionId)) {
      let state = null;
      try { state = readSessionWorkspace(sessionId); } catch { /* unreadable = unanswered */ }
      workspaceCache.set(sessionId, state);
    }
    return workspaceCache.get(sessionId);
  };
  const isMember = (tenantId) => tenants != null && tenants.some((t) => t.id === tenantId);
  // The session's recorded directory, for releasing a report whose session was never bound.
  const sessionDirOf = (sessionId) => {
    if (!isUsableSessionId(sessionId) || workspaceOf(sessionId) != null) return null;
    try {
      const recorded = loadState(sessionId).cwd;
      return typeof recorded === 'string' && recorded !== '' ? recorded : null;
    } catch { return null; }
  };

  const reportUrl = `${apiBase()}${ENDPOINTS.sessionsReport}`;

  let files;
  try {
    // Only queued payloads, and filtered HERE rather than inside the loop so `result.deferred`
    // counts postable files instead of dirents. Two things this skips, neither ever postable: the
    // `.tmp` writeJsonSecure leaves behind when a hard kill lands between the temp write and the
    // rename (fs-store.mjs — the temp is a sibling of its target), and the `.corrupt` files
    // quarantined below. pruneStale expires both at 14 days. The house pattern two modules over
    // already does this — `readAgents`/`pruneAgents` in subagent-state.mjs and
    // `findRolloutBySessionId` in transcript-codex.mjs; the queue drain was the one outlier, and an
    // unfiltered readdir is how a truncated `.tmp` got re-read on every flush forever. Envelopes
    // are `.qjson` (see workspace-queue.mjs), raw payloads `.json`.
    files = fs.readdirSync(dir).filter(isQueueFile);
  } catch {
    return;
  }

  // A 401 here is usually an access token that expired between the checkpoint's own token read and
  // this flush, not a revoked link — expires_at is only our estimate. Renew once for THIS ACCOUNT
  // and reuse the replacement for the rest of its queue. A file that still 401s afterwards is
  // kept, never dropped: an unjudged report must not be destroyed on a verdict we aren't sure of.
  //
  // The renewal is keyed: a bare getAccessToken() would refuse outright now, and a renewal that
  // reached for "the" token would hand this account's queue another account's bearer.
  // `deps.guardChecked`: the caller (the upload worker) ran the full environment guard before its
  // run and it passed, so the renewal skips it — after the guard's memo lapses it would otherwise
  // re-read every account's credential for one account's renewal.
  const renewOptions = deps.guardChecked === true ? { forceRefresh: true, guardChecked: true } : { forceRefresh: true };
  let renewed = false;
  const renewToken = async () => {
    if (renewed) return null;
    renewed = true;
    // The renewal is itself a network round trip; skip it once the budget is gone.
    if (deadline !== null && now() >= deadline) return null;
    const next = await getAccessToken(key, {}, renewOptions).catch(() => null);
    if (!next || next === session.token) return null;
    // The client id is unchanged by a refresh — only the bearer moves.
    session = { ...session, token: next };
    return session;
  };

  let networkErrors = 0;
  // A drain with no deadline outlives its lease; renewing keeps the evidence write that follows valid.
  const keepLeaseFresh = (tenantId) => {
    if (tenantId != null && queueHandle != null) {
      const seen = queueHandle.verify();
      if (!seen.ok && seen.reason === 'expired') queueHandle.renew({ leaseMs: QUEUE_LOCK_LEASE_MS });
    }
  };
  // With several workspaces only that one goes dark: recorded once, written after the lock.
  const tenantWentDark = (tenantId) => {
    if (!darkThisFlush.has(tenantId)) verdict.darkTenants.push(tenantId);
    darkThisFlush.add(tenantId);
  };
  // The whole account went dark. RECORDED, not written: markTrackingDisabled runs after the queue
  // lock is released. The caller ends the drain.
  const accountWentDark = (message) => {
    verdict.disabledByServer = true;
    verdict.reason = orDefault(message, null);
    result.trackingDisabled = true;
    result.lastError = orDefault(message, 'HTTP 403');
    sweepHeldQueue(dir, result, now());
  };
  // One report by the single route, judged by its answer: 'stop' ends the drain (the account went
  // dark), 'next' carries on. The one-at-a-time drain and the batch path's fallback both use it.
  const deliverSingle = async ({ filePath, payload, wire, tenantId, failOrExpire }) => {
    // Never hand a request more time than the budget has left, or the last one overruns the kill.
    const perRequest = deadline === null
      ? undefined
      : Math.max(1, Math.min(POST_TIMEOUT_MS, deadline - now()));
    if (perRequest !== undefined) onRequestTimeout(perRequest);

    let gotResponse = false;
    try {
      keepLeaseFresh(tenantId);
      if (!recordCoverageAttempts(key, { ...session, tenantId }, [payload], queueHandle)) {
        result.failed += 1;
        result.lastError = 'Could not save workspace replay evidence; report retained.';
        return 'next';
      }
      const post = (as) => postJson(reportUrl, { ...as, tenantId }, wire, {
        fetchImpl,
        ...(perRequest === undefined ? {} : { timeoutMs: perRequest }),
      });
      let res = await post(session);
      if (res.status === 401) {
        const next = await renewToken();
        if (next) res = await post(next);
      }
      gotResponse = true;
      networkErrors = res.status >= 500 || res.status === 408 || res.status === 429 ? networkErrors + 1 : 0;
      if (res.status >= 200 && res.status < 300) {
        result.flushed += 1;
        fs.unlinkSync(filePath);
      } else if (res.status === 401) {
        // Still rejected after a renewal (or there was none to make). Keep the file: the link
        // may genuinely be revoked, but that is the user's to fix, and re-linking should not
        // find their analytics already deleted.
        failOrExpire();
        result.lastError = 'HTTP 401';
      } else if (res.status === 403) {
        // Branch on the machine-readable code, never the message. TRACKING_DISABLED = the
        // workspace is in audit mode: record it, stop the storm, and HOLD the files — they
        // flush if the tenant converts within the window, and expire after it. A code-less 403
        // (seat revoked, deactivated user) is reversible: keep the file, count it failed.
        const body = await readBodyBounded(res);
        // With several workspaces only that one goes dark: its file is dropped, the rest drain on.
        if (body && body.code === 'TRACKING_DISABLED' && multi) {
          tenantWentDark(tenantId);
          result.rejected += 1;
          result.lastError = orDefault(body.message, 'HTTP 403');
          try { fs.unlinkSync(filePath); } catch { /* best-effort */ }
          return 'next';
        }
        if (body && body.code === 'TRACKING_DISABLED') {
          accountWentDark(body.message);
          return 'stop';
        }
        failOrExpire();
        result.lastError = orDefault((body || {}).message, `HTTP ${res.status}`);
      } else if (res.status === 404 || res.status === 405) {
        // NOT a verdict on the payload. A 404 is "this route is not here" — an older server, a
        // proxy in front of the API, an apiBase pointed somewhere else — and deleting a real
        // segment's tokens and cost over a missing route is unrecoverable. lib/audit-flush.mjs
        // already treats 404/405 as UNSUPPORTED_SERVER and retryable for exactly this reason; the
        // queue drain was the outlier. Kept, counted failed, and expired by pruneStale at 14 days
        // if the route never appears.
        result.failed += 1;
        result.routeAbsent += 1;
        result.routeAbsentFiles.push(path.basename(filePath));
        result.lastError = `HTTP ${res.status}`;
      } else if (RETRY_LATER_STATUSES.indexOf(res.status) !== -1) {
        failOrExpire(); // throttled or busy, not judged: keep for retry
        result.lastError = `HTTP ${res.status}`;
      } else if (res.status < 500) {
        // Permanent rejection — drop the file, but remember why.
        result.rejected += 1;
        const body = await readBodyBounded(res);
        result.lastError = orDefault((body || {}).message, `HTTP ${res.status}`);
        fs.unlinkSync(filePath);
      } else {
        failOrExpire(); // keep for retry
      }
    } catch {
      if (!gotResponse) networkErrors += 1;
      failOrExpire(); // keep file for retry on network error / throw
    }
    return 'next';
  };

  // ─── Batch delivery (deps.batch) ───
  // Every ready report is judged first, with no network; then they go to /sessions/report-batch in
  // planned batches: one tenant per batch, a scope's windows together, a contained window first.
  // Read per call, so BEEZI_NO_BATCH=1 turns batching off without a restart.
  const batching = deps.batch === true && orDefault(deps.env, process.env).BEEZI_NO_BATCH !== '1';
  const ready = new Map();
  const batchLimits = orDefault(deps.batchLimits, {});
  const limits = {
    maxItems: orDefault(batchLimits.maxItems, BATCH_MAX_ITEMS),
    maxBytes: orDefault(batchLimits.maxBytes, BATCH_MAX_BYTES),
  };
  // Plain JSON for the rest of the drain once a proxy refused a gzip body.
  let gzip = true;
  // Scope groups with a window kept this pass: their later windows wait behind it, because the
  // server absorbs narrow-then-wide but would count a wide window landing before its narrow one.
  const stoppedGroups = new Set();
  // The scope (session id plus agent id: the segmentId without its `:<from>-<to>`) and tenant.
  const groupOf = (entry) => {
    const segmentId = entry.payload.segmentId;
    const match = typeof segmentId === 'string' ? SEGMENT_RANGE.exec(segmentId) : null;
    return match == null ? null : `${entry.tenantId == null ? '' : entry.tenantId}|${match[1]}`;
  };
  const stopGroupIfKept = (entry) => {
    const group = groupOf(entry);
    if (group !== null && fs.existsSync(entry.filePath)) stoppedGroups.add(group);
  };
  const keep = (entry) => {
    entry.settled = true;
    entry.failOrExpire();
    stopGroupIfKept(entry);
  };
  // An entry this pass will not send: its workspace went dark (dropped, as the single route drops
  // it), or an earlier window of its scope was kept (kept too).
  const skipped = (entry) => {
    if (multi && darkThisFlush.has(entry.tenantId)) {
      try { fs.unlinkSync(entry.filePath); result.rejected += 1; } catch { /* best-effort */ }
      entry.settled = true;
      return true;
    }
    const group = groupOf(entry);
    if (group !== null && stoppedGroups.has(group)) {
      keep(entry);
      return true;
    }
    return false;
  };
  const sendSingle = async (entry) => {
    entry.settled = true;
    const step = await deliverSingle(entry);
    stopGroupIfKept(entry);
    return step;
  };
  // One per-item verdict: only stored and rejected delete the file.
  const settleItem = (entry, item) => {
    if (item.status === 'retry') {
      keep(entry);
      return;
    }
    entry.settled = true;
    if (item.status === 'stored') result.flushed += 1;
    else {
      result.rejected += 1;
      result.lastError = orDefault(item.code, 'rejected');
    }
    try { fs.unlinkSync(entry.filePath); } catch { /* already gone */ }
  };

  // One batch of one tenant's entries. Returns 'next', 'stop' (the account went dark), 'defer' (the
  // deadline came first), 'replan' (413: smaller batches), 'fallback' (an answer this plugin does
  // not understand; nothing was deleted on it) or 'unauthorized' (a 401 no renewal cured).
  const tooLateForBatch = () => deadline !== null && deadline - now() < BATCH_MIN_MS;
  const sendBatch = async (live) => {
    const tenantId = live[0].tenantId;
    // Before the evidence write: a batch that will not be sent records no attempt.
    if (tooLateForBatch()) return 'defer';
    let evidence = false;
    try {
      keepLeaseFresh(tenantId);
      evidence = recordCoverageAttempts(key, { ...session, tenantId }, live.map((entry) => entry.payload), queueHandle);
    } catch { evidence = false; }
    if (!evidence) {
      for (const entry of live) {
        entry.settled = true;
        result.failed += 1;
        stopGroupIfKept(entry);
      }
      result.lastError = 'Could not save workspace replay evidence; report retained.';
      return 'next';
    }
    let answer;
    for (;;) {
      if (tooLateForBatch()) return 'defer';
      // A multi-megabyte batch needs longer than one report's POST_TIMEOUT_MS, but never more than
      // the budget has left.
      const timeoutMs = deadline === null ? BATCH_TIMEOUT_MS : Math.max(1, Math.min(BATCH_TIMEOUT_MS, deadline - now()));
      onRequestTimeout(timeoutMs);
      answer = await postReportBatch(live.map((entry) => entry.wire), { ...session, tenantId }, { fetchImpl, timeoutMs, gzip, now });
      if (answer.gzipRefused) gzip = false;
      if (answer.kind !== 'unauthorized') break;
      // Renewed once per drain, shared with the single route. A 401 no renewal answers may be an
      // older server's tenant middleware in front of a missing route, or a revoked link: the single
      // route decides, and nothing is concluded about the batch route.
      networkErrors = 0;
      if (!(await renewToken())) return 'unauthorized';
    }
    const status = answer.status;
    if (answer.kind === 'results') {
      networkErrors = 0;
      answer.results.forEach((item, k) => settleItem(live[k], item));
      return 'next';
    }
    if (answer.kind === 'throttled') {
      // No report judged: every file kept. As on the single route, only 408 and 429 count toward
      // the network stop; 409/423/425 are a busy resource, not a busy API.
      networkErrors = status === 408 || status === 429 ? networkErrors + 1 : 0;
      for (const entry of live) keep(entry);
      result.lastError = `HTTP ${status}`;
      return 'next';
    }
    if (answer.kind === 'network' || (answer.kind === 'server-error' && status >= 500)) {
      // No report judged: every file kept; enough of these in a row stop the drain.
      networkErrors += 1;
      for (const entry of live) keep(entry);
      return 'next';
    }
    networkErrors = 0;
    if (answer.kind === 'server-error') {
      // A 403 without TRACKING_DISABLED (seat revoked, deactivated user) is reversible: keep all.
      for (const entry of live) keep(entry);
      result.lastError = orDefault(answer.message, `HTTP ${status}`);
      return 'next';
    }
    if (answer.kind === 'tracking-disabled') {
      for (const entry of live) entry.settled = true;
      if (multi) {
        // Only that workspace goes dark: its reports are dropped, the rest drain on.
        tenantWentDark(tenantId);
        for (const entry of live) {
          result.rejected += 1;
          try { fs.unlinkSync(entry.filePath); } catch { /* best-effort */ }
        }
        result.lastError = orDefault(answer.message, 'HTTP 403');
        return 'next';
      }
      accountWentDark(answer.message);
      return 'stop';
    }
    if (answer.kind === 'too-large') {
      // A batch of one is never resent: that report goes by the single route.
      if (live.length === 1) {
        if (deadline !== null && now() >= deadline) return 'defer';
        return (await sendSingle(live[0])) === 'stop' ? 'stop' : 'next';
      }
      limits.maxItems = Math.max(1, Math.floor(Math.min(limits.maxItems, live.length) / 2));
      return 'replan';
    }
    return 'fallback';
  };

  // The rest of the drain by the single route, in delivery order, under the same stops.
  const deliverEachSingle = async (entries) => {
    for (let k = 0; k < entries.length; k += 1) {
      const entry = entries[k];
      if (skipped(entry)) continue;
      if (deadline !== null && now() >= deadline) {
        result.deferred += entries.length - k;
        return;
      }
      if ((await sendSingle(entry)) === 'stop') return;
      if (networkErrors >= MAX_NETWORK_ERRORS) {
        result.deferred += entries.length - k - 1;
        return;
      }
    }
  };

  const deliverBatches = async (entries) => {
    const byName = new Map(entries.map((entry) => [entry.file, entry]));
    const ordered = orderQueueFiles(Array.from(byName.keys())).map((name) => byName.get(name));
    for (const entry of ordered) {
      entry.settled = false;
      entry.groupKey = groupOf(entry);
      // The exact bytes the single route would send, measured as the server counts them.
      entry.bytes = Buffer.byteLength(JSON.stringify(entry.wire), 'utf8');
    }
    // Every batch before the current one is settled whole, so what is unsettled is "this one on".
    const unsettled = () => ordered.filter((entry) => !entry.settled);
    const planOf = (list) => planBatches(list, limits).map((indices) => indices.map((k) => list[k]));
    let plan = planOf(ordered);
    for (let b = 0; b < plan.length; b += 1) {
      const live = plan[b].filter((entry) => !entry.settled && !skipped(entry));
      if (live.length === 0) continue;
      const step = await sendBatch(live);
      if (step === 'stop') return;
      if (step === 'defer') {
        result.deferred += unsettled().length;
        return;
      }
      if (step === 'replan') {
        plan = planOf(unsettled());
        b = -1;
        continue;
      }
      if (step === 'fallback' || step === 'unauthorized') {
        const flushedBefore = result.flushed;
        await deliverEachSingle(unsettled());
        // Only a single route that delivered proves the server is up and only the batch route is
        // missing. The worker then posts one by one for a while (batchUnsupportedUntil).
        if (step === 'fallback' && result.flushed > flushedBefore) result.batchUnsupported = true;
        return;
      }
      if (networkErrors >= MAX_NETWORK_ERRORS) {
        result.deferred += unsettled().length;
        return;
      }
    }
  };


  for (const [index, file] of files.entries()) {
    if (deadline !== null && now() >= deadline) {
      result.deferred = files.length - index + ready.size;
      ready.clear();
      break;
    }
    const filePath = path.join(dir, file);
    const salvage = readJsonSalvaged(filePath);
    // A { version, tenantId, payload[, hold] } envelope, or a legacy raw payload.
    const entry = unwrapQueueFile(salvage.value);
    const payload = entry.payload;
    if (salvage.unreadable) {
      // Could not be OPENED — a concurrent flush already unlinked it, or an AV scanner has it
      // locked for a moment. Nothing is known about its contents, so it is left exactly where it
      // is for the next pass. This is the one case that must NOT quarantine: renaming a payload
      // that was merely unavailable this instant removes a good report from the drain permanently.
      result.unreadable += 1;
      continue;
    }
    if (multi && isAskFile(file) && payload == null) {
      const held = releaseHeldFile(filePath, session, null);
      if (held.expired) { result.expired += 1; continue; }
    }
    if (payload == null || (salvage.salvaged && payload.segmentId == null)) {
      // Parsed and found unusable — nothing recoverable, or a salvaged prefix with no segmentId,
      // which the server's idempotency key cannot address. Quarantine rather than `continue`: an
      // unparseable file used to be re-read on every flush (every PostToolUse and every Stop) for
      // fourteen days with zero signal, and then pruneStale deleted it and the session's analytics
      // went with it. `.corrupt` keeps the bytes where an operator can look at them, takes the file
      // out of the drain, and is counted in the result so the count is not invisible either.
      result.quarantined += 1;
      result.lastError = orDefault(result.lastError, `quarantined unparseable queue file ${file}`);
      // The one place a segment's analytics are taken out of the drain for good. The count above is
      // local and nobody reads it after the process exits, so without this the only trace of a
      // machine that quarantines every payload is a `.corrupt` file the user never looks at.
      // recordIssue is consent-gated, never throws and carries no payload content — only the code,
      // the source and the environment fields.
      recordIssue({
        code: DIAGNOSTIC_CODES.QUEUE_FILE_QUARANTINED,
        source: DIAGNOSTIC_SOURCES.CHECKPOINT,
      });
      try { fs.renameSync(filePath, `${filePath}.corrupt`); } catch { /* best-effort */ }
      continue;
    }
    // A report queued under a session id the plugin could not name — `queue/null_1-18.json`, written
    // by an older build before the resolver refused to answer with one. It must NOT be posted: the
    // server rejects it, this drain treats a 4xx as permanent, and the `fs.unlinkSync` below would
    // DELETE it. That destroys unreported analytics — the file holds real tokens, real cost and a
    // real segment window, and only its session id is wrong, which a human can still re-attribute
    // from the segment identity inside it. So it is left exactly where it is, out of the drain but
    // on disk, for quarantinePoisonedSessionState (lib/transcript-codex.mjs) to relocate under
    // `quarantine/` on the next `track`. Counted, so the skip is not invisible either.
    //
    // Only a PRESENT id is judged: an absent `sessionId` is not evidence of this bug, and narrowing
    // to what is actually there keeps the check from re-deciding payloads it knows nothing about.
    if (payload.sessionId !== undefined && !isUsableSessionId(payload.sessionId)) {
      result.unnamed += 1;
      result.lastError = orDefault(result.lastError, `skipped queue file with an unusable session id ${file}`);
      continue;
    }
    if (salvage.salvaged) result.salvaged += 1;

    let mtimeMs = null;
    const ageMs = () => {
      if (mtimeMs === null) {
        try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch { mtimeMs = now(); }
      }
      return now() - mtimeMs;
    };
    const expire = () => {
      try { fs.unlinkSync(filePath); result.expired += 1; return true; } catch { return false; }
    };
    // A kept file on an account in several workspaces expires past the hold window instead of
    // failing forever.
    const failOrExpire = () => {
      if (multi && ageMs() > QUEUE_HOLD_MS && expire()) return;
      result.failed += 1;
    };

    // A held or unstamped file becomes per-workspace copies, which this same pass then posts.
    if (multi && (entry.hold !== null || entry.tenantId === null)) {
      let released;
      // A held file that cannot be released must not break the whole drain.
      try { released = releaseHeldFile(filePath, session, workspaceOf(payload.sessionId), sessionDirOf(payload.sessionId)); }
      catch { result.failed += 1; continue; }
      files.push(...released.written);
      if (released.expired) result.expired += 1;
      else if (!released.deleted) result.workspacePending += 1;
      continue;
    }
    // A held file on an account no longer known to be in several workspaces waits out the window:
    // with the list unknown, a headerless post could land in the wrong workspace.
    if (entry.hold !== null) {
      if (ageMs() <= QUEUE_HOLD_MS || !expire()) result.workspacePending += 1;
      continue;
    }
    // A stamp for a workspace the account has left is held for it, never re-routed.
    if (entry.tenantId !== null && tenants !== null && !isMember(entry.tenantId)) {
      if (ageMs() <= QUEUE_HOLD_MS || !expire()) result.workspacePending += 1;
      continue;
    }
    // One or unknown workspaces post headerless, whatever the file was stamped with.
    const tenantId = multi ? entry.tenantId : null;
    // A dark workspace's reports are dropped, not retried.
    if (multi && (darkThisFlush.has(tenantId) || isTenantDark(trackingState, tenantId))) {
      try { fs.unlinkSync(filePath); result.rejected += 1; } catch { /* best-effort */ }
      continue;
    }

    const wire = reportForWire(payload, session, tenantId);
    // Private with no key to anonymize it: never sent raw, so dropped.
    if (wire == null) {
      try { fs.unlinkSync(filePath); result.rejected += 1; } catch { /* best-effort */ }
      result.lastError = orDefault(result.lastError, ANONYMIZATION_KEY_MISSING);
      continue;
    }

    const report = { file, filePath, payload, wire, tenantId, failOrExpire };
    if (batching) {
      // Collected, then sent in batches once the whole directory is judged. Keyed by name: a
      // released copy written over a file already judged this pass replaces it.
      ready.set(file, report);
      continue;
    }
    if ((await deliverSingle(report)) === 'stop') break;
    if (networkErrors >= MAX_NETWORK_ERRORS) {
      result.deferred = files.length - index - 1;
      break;
    }
  }
  if (ready.size > 0) await deliverBatches(Array.from(ready.values()));
}
