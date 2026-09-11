import fs from 'fs';
import path from 'path';
import { beeziCodexHome, codexSessionsDir, stateDir } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { orDefault } from './compat.mjs';
import { acquireLock as _acquireLock, electionLock, withLock, sharedLock } from './single-instance-lock.mjs';
import { hookMayProceed } from './env-guard.mjs';
import { isUsableSessionId, listRolloutFiles as _listRolloutFiles } from './transcript-codex.mjs';
import { readRolloutHead as _readRolloutHead, subagentIdentityFrom as _subagentIdentityFrom } from './subagent-codex.mjs';
import { runCheckpoint as _runCheckpoint, reconcileSession } from './checkpoint.mjs';
import { runAudit as _runAudit, SYNC_MODE } from './session-audit.mjs';
import { getAccessToken as _getAccessToken } from './token.mjs';
import { pruneStale as _pruneStale } from './prune.mjs';
import { readTrackingState, isLiveTrackingAllowed } from './tracking.mjs';
import { loadLedger as _loadLedger } from './audit-ledger.mjs';
import { BackfillSessionStatus } from './audit-flush.mjs';
import { getMachineClientId } from './machine-identity.mjs';
import {
  fetchCoverage as _fetchCoverage,
  loadCoverageCheckpoints as _loadCoverageCheckpoints,
  checkpointLineFor,
  currentBinding,
  decideReplay,
  childSweepAllowed,
  ReplayDecision,
  DeferReason,
} from './session-coverage.mjs';

// The C-in-MCP rollout watcher (G-1-1, Branch A) — under the corrections in REVIEW.md §R2/§R3.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// SHIPPED OFF. THE OPT-IN IS `BEEZI_CODEX_WATCHER`.
// ─────────────────────────────────────────────────────────────────────────────────────────────
// The plan's release order (`2026-09-10-codex-gap-closure-plan.md` §"Release order") puts delivery
// automation AFTER the production cutover and its guarded migration. This module therefore starts
// nothing unless `BEEZI_CODEX_WATCHER` is set to one of TRUE_VALUES below. `startWatcher()` on an
// un-opted machine arms NO timer, makes NO filesystem call and touches NO state — pinned by
// test/watcher-optin.test.mjs, which injects an `fs` whose every method throws.
//
// `.mcp.json`'s `env_vars` is an ALLOWLIST of the variables Codex forwards into the plugin's
// stdio server, and it NOW NAMES THIS ONE — so a machine that sets `BEEZI_CODEX_WATCHER=1` gets
// a watcher, and a machine that does not is exactly where it was. That second lock was there
// because the production cutover had not shipped; it has (G-1-2, R1), so the lock is gone and
// the remaining gate is the opt-in itself. The default stays OFF: a resident scan loop belongs
// to machines that asked for one until a soak says otherwise.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS PROCESS KNOWS ABOUT ITSELF: NOTHING
// ─────────────────────────────────────────────────────────────────────────────────────────────
// M-1-2's standing measurement (F11/F12, and the option-C design's §2.1) is that the plugin's MCP
// server spawns eagerly at session start, lives for the whole session, and its `initialize` params
// carry no session id, no thread id and no project cwd. `process.cwd()` is the plugin cache
// directory. Re-checked against lib/mcp-bridge.mjs at this commit: nothing there reads a session
// identity out of the handshake, and `.mcp.json` forwards only static strings.
//
// Two consequences shape everything below:
//
//   1. DISCOVERY IS THE ONLY PATH. The watcher cannot ask "which session am I?", so it processes
//      every rollout whose observation moved, whichever session this process belongs to. The
//      engine already fits that: state files are keyed by session id, `segmentId` is
//      `<sessionId>:<from>-<to>`, and `session_meta.cwd` recovers the project from the rollout.
//   2. THE ELECTION LOCK IS LOAD-BEARING, NOT DECORATIVE. One MCP process per session means N
//      concurrent watchers on one machine, all equally eligible, all scanning one tree. Without
//      the lock they would each open the same rollouts and each POST the same windows.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// R2'S DISCOVERY TRAPS, AND WHERE EACH IS HANDLED
// ─────────────────────────────────────────────────────────────────────────────────────────────
//   * NEVER GATE ON DIRECTORY MTIME. Appending to a rollout does not touch its parent directory's
//     mtime, so a "did today's folder change?" pre-check misses every append. The cheap pre-check
//     from the option-C sketch (§3.3) is therefore NOT implemented here — `scanPass` always walks
//     the whole tree. Deliberate cost, pinned by test/watcher-discovery.test.mjs.
//   * OLD DATE DIRECTORIES. A resumed session keeps writing into the directory it was created in,
//     which may be weeks back. The walk is the WHOLE tree (listRolloutFiles is depth-bounded at
//     the sessions/YYYY/MM/DD shape), plus a per-file stat, so an old-date append is seen exactly
//     like a today append.
//   * NO QUIET-AGE THRESHOLD. R2 forbids one, because it starves a continuously growing rollout.
//     Instead a session that changed is due IMMEDIATELY, and the only rate limit is a per-session
//     COOLDOWN measured from its last successful checkpoint: a rollout under continuous write is
//     processed once per cooldown, forever, never skipped. G-1-6 already holds back a torn
//     trailing line, so reading mid-write is safe and no delay is needed for correctness.
//   * BOUNDED WORK. Per pass: a cap on head reads, a cap on sessions checkpointed, a per-session
//     network budget, one coverage request, and a yield to the event loop every CHUNK files.
//     Whatever does not fit is carried to the next pass by a rotating scan index and by simply
//     staying due — nothing is dropped.
//   * PRUNING WITHOUT A TRUSTED HOOK. `pruneStale()` runs on its own long interval from the tick,
//     recorded in the watermark, so a machine that never trusted SessionStart still gets swept.
//   * MCP RESPONSIVENESS. R2 is explicit that "never write to stdout" does not protect the
//     JSON-RPC channel from a SYNCHRONOUS filesystem/JSON stall. The scan is therefore chunked
//     with an awaited yield between chunks, and every await point re-checks `stopped`.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE OBSERVATION WATERMARK — A NEW FILE, NOT A FIELD IN CURSOR STATE
// ─────────────────────────────────────────────────────────────────────────────────────────────
// R2 forbids inventing a persisted `mtimeMs` on the existing per-session cursor state, so this is
// its own record at `<beeziCodexHome()>/watcher.json`, at the data-root LEVEL for the same reason
// coverage.json / tracking.json / audit-ledger.json are: lib/prune.mjs sweeps state/ and queue/,
// and a watermark that expired at 14 days would make every old rollout look brand new.
//
//   { version, sessions: { <sessionId>: { mtimeMs, size, at } },
//     children: { <agentThreadId>: { mtimeMs, size, root, at } },
//     prunedAt, historyAt, updatedAt }
//
// IT IS AN OBSERVATION, NOT A CURSOR. It answers exactly one question — "has this file changed
// since the last time a checkpoint of it SUCCEEDED?" — and it is never consulted to decide which
// LINES to read. Lines come from state/<id>.json, or from the coverage core.
//
// WHEN IT ADVANCES: only after a checkpoint of that session reported durable success
// (`checkpointSucceeded()` below). A pass that was locked out, refused to name the session or
// failed its delta leaves the watermark alone, so the next pass retries. `enqueued === 0` IS
// success — a session with no new billable usage is a correct, complete read.
//
// WHAT IS RECORDED: the observation taken BEFORE the checkpoint ran, never a fresh stat after it.
// A rollout that grew while its checkpoint was in flight must stay due; stamping the post-run
// mtime would silently swallow that append until the next one.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// ELIGIBILITY: THREE PATHS, NO OVERLAP
// ─────────────────────────────────────────────────────────────────────────────────────────────
// `if (!seen && isImported(...)) continue` is unsafe (R2): the ledger has no imported line
// boundary and marks REJECTED sessions imported. Nothing here consults `isImported`. Instead a
// session is routed by whether a NON-OVERLAPPING START LINE IS ALREADY ESTABLISHED:
//
//   A. ESTABLISHED — a local cursor exists (state/<id>.json) or this watcher has a watermark for
//      it. The boundary is known; run the ordinary incremental checkpoint. Cheapest, most common.
//   B. UNESTABLISHED AND ACTIVE — no boundary, and the file moved inside ACTIVE_WINDOW_MS. These
//      are exactly the sessions lib/session-audit.mjs REFUSES (it skips anything younger than its
//      own active window to avoid racing live writers), so nobody else will ever establish them.
//      One batched `/sessions/coverage` request per pass, then `decideReplay` decides. A REPLAY
//      verdict is handed to runCheckpoint as a `startCursor` HARD OVERRIDE (G-3-3) with the
//      subagent sweep set by `childSweepAllowed`. A DEFER verdict is counted and retried — and
//      `coverage === null` (unavailable) is a DEFER, never a scan from zero.
//   C. UNESTABLISHED AND QUIET — no boundary, and the file has been still for longer than the
//      active window. That is history, and R2 requires history to ride the tracking-policy-aware
//      sync route: `runAudit({ mode: SYNC_MODE })`, on a long interval. It drains the queue first,
//      consults coverage, honours audit-only tenants and neither seals nor reopens the one-time
//      backfill. This module does not reimplement any of that.
//
// Path A and B are LIVE capture and are gated on `isLiveTrackingAllowed()`; path C gates itself.
//
// A CHANGED CHILD SCHEDULES ITS ROOT (R2, G-7-1/G-7-2). `listAllRollouts()` excludes subagent
// rollouts, and excluding them from a listing does not bill them — the parent's sweep does. So the
// walk classifies every file with the SAME discriminator listAllRollouts uses
// (`subagentIdentityFrom` on the head record), and a child whose observation moved marks its
// `rootSessionId` due with `sweepSubagents: true`.
//
// KNOWN RESIDUAL — IDENTITY CHANGE (R2's "identity change" row, NOT closed here). `coverage.json`
// is bound to `{identity, environment, apiBase}` and discards a record written under another
// login. Neither this watermark nor `state/<id>.json` carries that binding. After a
// logout→login into a different workspace, every session with a surviving local cursor still reads
// as ESTABLISHED, so path A would keep checkpointing the previous tenant's tails under the new
// one's credentials, from a cursor that means nothing there. A hook only ever sees the session it
// fired in; a watcher sweeps the whole machine, so it makes the same latent bug much wider.
// Binding this file alone would NOT fix it — `establishedProbe` reads the cursor, and the cursor
// is the thing that is unbound. The fix belongs in the cursor's own module and in the login path,
// neither of which this change owns. Reported, untested, deliberately not worked around here.
//
// WHY NOT JUST CALL listAllRollouts(). It walks the tree and head-reads every file synchronously
// and without bound, which is the stall R2 says a stdout rule does not protect against, and it
// discards children, which are half of what this module has to see. The classification here is a
// deliberate mirror of it — same head read, same discriminator, same `id`-then-filename id
// derivation, same newest-file-wins collapse for a resumed session id — so the two can never
// disagree about what a top-level session is.

// ── The opt-in ──────────────────────────────────────────────────────────────────────────────

/** The documented opt-in. Absent or anything outside TRUE_VALUES means the watcher never starts. */
export const WATCHER_ENV_VAR = 'BEEZI_CODEX_WATCHER';

// An allowlist rather than a truthiness test: `BEEZI_CODEX_WATCHER=0` and `=false` are things a
// user types to turn something OFF, and both are truthy strings.
const TRUE_VALUES = Object.freeze(['1', 'true', 'yes', 'on', 'enabled']);

export function isWatcherEnabled(env) {
  const raw = (env || {})[WATCHER_ENV_VAR];
  if (typeof raw !== 'string') return false;
  return TRUE_VALUES.indexOf(raw.trim().toLowerCase()) !== -1;
}

// ── Defaults ────────────────────────────────────────────────────────────────────────────────

/** How often a tick runs. Chained setTimeout, so a slow pass never overlaps itself. */
export const TICK_MS = 20_000;
/** Election lease. Comfortably longer than a tick, so a renew is never racing its own expiry. */
export const ELECTION_LEASE_MS = 120_000;
/** A session is re-checkpointed at most this often, however fast its rollout grows. */
export const SESSION_COOLDOWN_MS = 60_000;
/** Files classified (head-read) per pass. The remainder rides a rotating index to the next pass. */
export const MAX_HEAD_READS_PER_PASS = 120;
/** Sessions checkpointed per pass on the INCREMENTAL path (A). The rest stay due, oldest first. */
export const MAX_SESSIONS_PER_PASS = 5;
/**
 * Sessions ESTABLISHED per pass on the coverage path (B), counted separately from path A. The two
 * ceilings add up, so the real per-pass maximum is MAX_SESSIONS_PER_PASS + MAX_ESTABLISH_PER_PASS.
 * Path B is the more expensive one — a first read of a session is a whole-transcript parse — so it
 * gets the smaller number, and a fresh machine ramps up over several passes instead of one.
 */
export const MAX_ESTABLISH_PER_PASS = 2;
/** Session ids asked about in one coverage request. */
export const MAX_COVERAGE_PER_PASS = 50;
/** Network budget handed to one checkpoint, so a dead server cannot stall a pass. */
export const CHECKPOINT_BUDGET_MS = 8_000;
/** Files walked between yields to the event loop. This is the MCP-responsiveness knob. */
export const SCAN_CHUNK = 25;
/** Matches lib/session-audit.mjs's ACTIVE_SESSION_WINDOW_MS — the boundary between B and C. */
export const ACTIVE_WINDOW_MS = 30 * 60 * 1000;
/** pruneStale() cadence, independent of any hook. */
export const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** runAudit(sync) cadence. Long: it is a whole-machine reconciliation, not a tick's work. */
export const HISTORY_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Watermark entries kept. Oldest observation evicted first; eviction only costs a re-read. */
export const MAX_OBSERVATIONS = 2000;

export const OBSERVATION_VERSION = 1;

// ── The observation watermark ───────────────────────────────────────────────────────────────

export function observationFile() {
  return path.join(beeziCodexHome(), 'watcher.json');
}

function emptyObservations() {
  return {
    version: OBSERVATION_VERSION,
    sessions: {},
    children: {},
    prunedAt: null,
    historyAt: null,
    updatedAt: null,
  };
}

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/**
 * Read the watermark. A record from another version is DISCARDED rather than migrated: the worst
 * an empty watermark costs is one redundant re-read per session, and every line decision is made
 * by the cursor or the coverage core, never by this file.
 */
export function loadObservations(deps) {
  const read = orDefault((deps || {}).readJsonImpl, readJson);
  let stored = null;
  try {
    stored = read(observationFile(), null);
  } catch {
    stored = null;
  }
  const record = plainObject(stored);
  if (!record || record.version !== OBSERVATION_VERSION) return emptyObservations();
  return {
    version: OBSERVATION_VERSION,
    sessions: orDefault(plainObject(record.sessions), {}),
    children: orDefault(plainObject(record.children), {}),
    prunedAt: typeof record.prunedAt === 'number' ? record.prunedAt : null,
    historyAt: typeof record.historyAt === 'number' ? record.historyAt : null,
    updatedAt: orDefault(record.updatedAt, null),
  };
}

export function saveObservations(record, deps) {
  const write = orDefault((deps || {}).writeJsonSecureImpl, writeJsonSecure);
  try {
    const result = withLock(sharedLock('watcher-observations'), {}, () => {
      write(observationFile(), { ...record, updatedAt: new Date().toISOString() });
    });
    return result.ok;
  } catch {
    // Best-effort like every other write in this plugin: a watermark we could not persist costs a
    // repeated read next pass, and the server upserts by segmentId, so nothing is double-counted.
    return false;
  }
}

/** What we last saw for a session, or null. `{ mtimeMs, size, at }`. */
export function observationFor(record, sessionId) {
  const entry = plainObject(((record || {}).sessions || {})[sessionId]);
  if (!entry) return null;
  if (typeof entry.mtimeMs !== 'number' || !isFinite(entry.mtimeMs)) return null;
  return { mtimeMs: entry.mtimeMs, size: typeof entry.size === 'number' ? entry.size : null, at: orDefault(entry.at, null) };
}

export function childObservationFor(record, agentThreadId) {
  const entry = plainObject(((record || {}).children || {})[agentThreadId]);
  if (!entry) return null;
  if (typeof entry.mtimeMs !== 'number' || !isFinite(entry.mtimeMs)) return null;
  return { mtimeMs: entry.mtimeMs, size: typeof entry.size === 'number' ? entry.size : null, root: orDefault(entry.root, null) };
}

/**
 * Stamp an observation. `observed` is the stat taken BEFORE the checkpoint, never after — see the
 * header. Called only on durable checkpoint success.
 */
export function recordObservation(record, sessionId, observed, nowMs) {
  if (!record || !record.sessions) return record;
  if (typeof sessionId !== 'string' || !sessionId) return record;
  if (!observed || typeof observed.mtimeMs !== 'number') return record;
  record.sessions[sessionId] = {
    mtimeMs: observed.mtimeMs,
    size: typeof observed.size === 'number' ? observed.size : null,
    at: nowMs,
  };
  return record;
}

export function recordChildObservation(record, agentThreadId, observed, rootSessionId, nowMs) {
  if (!record || !record.children) return record;
  if (typeof agentThreadId !== 'string' || !agentThreadId) return record;
  if (!observed || typeof observed.mtimeMs !== 'number') return record;
  record.children[agentThreadId] = {
    mtimeMs: observed.mtimeMs,
    size: typeof observed.size === 'number' ? observed.size : null,
    root: orDefault(rootSessionId, null),
    at: nowMs,
  };
  return record;
}

/**
 * Bound the record. A machine with years of history must not grow this file without limit; the
 * oldest observation goes first, and losing one costs exactly one redundant read of a session
 * whose cursor still says where it got to.
 */
export function pruneObservations(record, max = MAX_OBSERVATIONS) {
  for (const key of ['sessions', 'children']) {
    const table = plainObject(record[key]);
    if (!table) continue;
    const names = Object.keys(table);
    if (names.length <= max) continue;
    names.sort((a, b) => {
      const av = typeof table[a].at === 'number' ? table[a].at : 0;
      const bv = typeof table[b].at === 'number' ? table[b].at : 0;
      return av - bv;
    });
    for (let i = 0; i < names.length - max; i += 1) delete table[names[i]];
  }
  return record;
}

// ── Classification (a deliberate mirror of listAllRollouts) ─────────────────────────────────

// rollout-<ISO-with-dashes>-<uuid>.jsonl — the trailing UUID is the session id. Same regex as
// lib/transcript-index-codex.mjs and lib/transcript-codex.mjs; the internal dashes make a greedy
// suffix capture wrong.
const TRAILING_UUID_RE = /-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/;

function str(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * One head record answers all three questions: is it a subagent, which session is it, where was it
 * launched. 512KB / 1 record mirrors listAllRollouts exactly.
 *
 * Returns `{ kind: 'top', sessionId, cwd }`, `{ kind: 'child', agentThreadId, rootSessionId }`, or
 * `{ kind: 'skip' }`.
 */
export function classifyRollout(file, deps) {
  const headRead = orDefault((deps || {}).readRolloutHead, _readRolloutHead);
  const identityFrom = orDefault((deps || {}).subagentIdentityFrom, _subagentIdentityFrom);
  let records;
  try {
    records = headRead(file, { maxBytes: 512 * 1024, maxRecords: 1 });
  } catch {
    return { kind: 'skip' };
  }
  const first = Array.isArray(records) ? records[0] : null;
  if (!first) return { kind: 'skip' };

  const identity = identityFrom([first]);
  if (identity) {
    // A child with no resolvable ROOT cannot schedule anything, so it is skipped rather than
    // guessed at. `rootSessionId` is null on the oldest rollout format and whenever `session_id`
    // merely repeats `id` — exactly the cases where a guess would attach an agent to a session it
    // does not belong to.
    const root = str(identity.rootSessionId);
    const own = str(identity.ownThreadId);
    if (!root || !isUsableSessionId(root) || !own) return { kind: 'skip' };
    return { kind: 'child', agentThreadId: own, rootSessionId: root };
  }

  const meta = first.type === 'session_meta' ? first.payload : null;
  // `id`, never `session_id` — on a subagent rollout the latter holds the PARENT's thread id.
  const metaId = str((meta || {}).id);
  const nameId = orDefault((TRAILING_UUID_RE.exec(path.basename(file)) || [])[1], null);
  const sessionId = isUsableSessionId(metaId)
    ? metaId
    : (isUsableSessionId(nameId) ? nameId : null);
  if (!sessionId) return { kind: 'skip' };
  return { kind: 'top', sessionId, cwd: str((meta || {}).cwd) };
}

// ── The scan ────────────────────────────────────────────────────────────────────────────────

function defaultYield() {
  // A macrotask, not a microtask: only returning to the event loop lets readline deliver the next
  // JSON-RPC line. `setTimeout(_, 0)` always fires, so there is nothing to clear and nothing to
  // unref — the G-10-2 rule applies to timers that must be CANCELLED, and this is not one.
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

/**
 * Walk the WHOLE sessions tree once, stat every rollout, and classify the ones we do not already
 * know. Never gated on directory mtime (R2).
 *
 * @returns { tops, children, scanned, classified, truncated, nextIndex }
 *          `tops` is Map<sessionId, { sessionId, transcriptPath, cwd, mtimeMs, size }> with the
 *          newest file winning a resumed id, exactly as listAllRollouts collapses it.
 *          `children` is [{ agentThreadId, rootSessionId, transcriptPath, mtimeMs, size }].
 */
export async function scanPass(options = {}, deps = {}) {
  const fsImpl = orDefault(deps.fs, fs);
  const listFiles = orDefault(deps.listRolloutFiles, _listRolloutFiles);
  const yieldControl = orDefault(deps.yieldControl, defaultYield);
  const shouldStop = orDefault(deps.shouldStop, () => false);
  // Classification is cached for the life of the PROCESS, keyed by path. The first record of a
  // rollout is written once and never rewritten (measured across 201 real rollouts: markers are
  // appended, files never shrink), so a file's kind cannot change under us — which is what keeps
  // steady-state head reads at zero and the pass at one stat per file.
  const heads = deps.headCache instanceof Map ? deps.headCache : new Map();

  const root = options.sessionsDir === undefined || options.sessionsDir === null
    ? codexSessionsDir()
    : options.sessionsDir;
  const maxHeadReads = orDefault(options.maxHeadReads, MAX_HEAD_READS_PER_PASS);
  const chunk = Math.max(1, orDefault(options.chunkSize, SCAN_CHUNK));

  let files;
  try {
    files = listFiles(root);
  } catch {
    files = [];
  }
  // Sorted so the rotating index means the same thing from pass to pass; an unsorted readdir order
  // would let a bounded pass revisit the same prefix forever and starve the tail.
  files.sort();

  const tops = new Map();
  const children = [];
  const total = files.length;
  const start = total === 0 ? 0 : ((orDefault(options.startIndex, 0) % total) + total) % total;
  let classified = 0;
  let truncated = false;
  let nextIndex = start;
  let scanned = 0;

  for (let step = 0; step < total; step += 1) {
    if (shouldStop()) { truncated = true; nextIndex = (start + step) % total; break; }
    if (step > 0 && step % chunk === 0) {
      // The yield that keeps the JSON-RPC channel answering during a large scan (R2).
      await yieldControl();
      if (shouldStop()) { truncated = true; nextIndex = (start + step) % total; break; }
    }
    const index = (start + step) % total;
    const full = files[index];
    let stat;
    try {
      stat = fsImpl.statSync(full);
    } catch {
      continue; // vanished or unreadable between readdir and stat
    }
    if (!stat.isFile()) continue;
    scanned += 1;

    let kind = heads.get(full);
    if (!kind) {
      if (classified >= maxHeadReads) {
        // Out of budget. Remember where to resume so the tail is classified next pass instead of
        // being permanently invisible behind a bounded prefix.
        truncated = true;
        nextIndex = index;
        break;
      }
      kind = classifyRollout(full, deps);
      classified += 1;
      if (kind.kind !== 'skip') heads.set(full, kind);
    }
    if (kind.kind === 'skip') continue;

    if (kind.kind === 'child') {
      children.push({
        agentThreadId: kind.agentThreadId,
        rootSessionId: kind.rootSessionId,
        transcriptPath: full,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      });
      continue;
    }

    const entry = {
      sessionId: kind.sessionId,
      transcriptPath: full,
      cwd: kind.cwd,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    };
    // Codex resume can leave two files carrying one session id; the newest supersedes.
    const existing = tops.get(kind.sessionId);
    if (!existing || entry.mtimeMs > existing.mtimeMs) tops.set(kind.sessionId, entry);
  }
  if (!truncated) nextIndex = start;

  return { tops, children, scanned, classified, truncated, nextIndex, total };
}

// ── The plan ────────────────────────────────────────────────────────────────────────────────

function changedSince(prior, observed) {
  if (!prior) return true;
  if (observed.mtimeMs > prior.mtimeMs) return true;
  // Size is the second witness. A same-second append on a coarse-granularity filesystem can leave
  // mtime unmoved, and `!==` rather than `>` so a shrink (G-3-5's rollback case) is also a change
  // the checkpoint gets to judge rather than something discovery hides.
  return typeof prior.size === 'number' && observed.size !== prior.size;
}

/**
 * "Does a local cursor already establish a boundary for this session?"
 *
 * One `readdir` of state/ per pass, then at most one read per session that both HAS a state file
 * and lacks a watermark — which in steady state is none, because a session gets a watermark the
 * first time it is checkpointed. Built as a closure rather than a per-session call so a machine
 * with hundreds of quiet old sessions costs one directory read per pass instead of hundreds of
 * stats.
 *
 * `cursor` must be an integer, not merely present: a corrupt state file is not a boundary, and
 * treating it as one would send that session down the incremental path from line 0 — the scan
 * from zero R2 forbids — instead of letting coverage decide.
 */
function establishedProbe(deps) {
  const fsImpl = orDefault((deps || {}).fs, fs);
  const readImpl = orDefault((deps || {}).readJsonImpl, readJson);
  const dir = stateDir();
  let present = null;
  try {
    present = new Set();
    for (const name of fsImpl.readdirSync(dir)) {
      if (String(name).slice(-5) === '.json') present.add(String(name).slice(0, -5));
    }
  } catch {
    present = null; // no state dir at all: nothing is established
  }
  const cache = new Map();
  return (sessionId) => {
    if (present === null || !present.has(sessionId)) return false;
    if (cache.has(sessionId)) return cache.get(sessionId);
    let ok = false;
    try {
      const state = readImpl(path.join(dir, `${sessionId}.json`), null);
      ok = !!state && typeof state === 'object' && Number.isInteger(state.cursor);
    } catch {
      ok = false;
    }
    cache.set(sessionId, ok);
    return ok;
  };
}

/**
 * Route every discovered session. Pure over its inputs so the whole matrix is testable without a
 * timer, a socket or a real rollout.
 *
 * @returns { due, fresh, quiet, cooling, childrenBySession }
 *   due     established sessions whose file moved — ordered oldest-observation-first, capped.
 *   fresh   unestablished and still moving — path B, the coverage-gated establishment.
 *   quiet   unestablished and still — path C, handed to runAudit(sync).
 *   cooling how many due sessions were held back by their cooldown this pass.
 */
export function planPass(input = {}) {
  const tops = input.tops instanceof Map ? input.tops : new Map();
  const children = Array.isArray(input.children) ? input.children : [];
  const record = orDefault(input.observations, emptyObservations());
  const nowMs = orDefault(input.now, Date.now());
  const cooldownMs = orDefault(input.cooldownMs, SESSION_COOLDOWN_MS);
  const activeWindowMs = orDefault(input.activeWindowMs, ACTIVE_WINDOW_MS);
  const maxSessions = orDefault(input.maxSessions, MAX_SESSIONS_PER_PASS);
  const isEstablished = orDefault(input.isEstablished, () => false);

  // A changed CHILD schedules its ROOT even though the parent's own file did not move (R2). The
  // child's observation rides along with the root's checkpoint, so it is carried here.
  const childrenBySession = new Map();
  const movedChildren = new Set();
  for (const child of children) {
    const prior = childObservationFor(record, child.agentThreadId);
    if (!changedSince(prior, child)) continue;
    movedChildren.add(child.rootSessionId);
    const list = childrenBySession.get(child.rootSessionId);
    if (list) list.push(child);
    else childrenBySession.set(child.rootSessionId, [child]);
  }

  const candidates = [];
  const fresh = [];
  const quiet = [];
  let cooling = 0;

  for (const entry of tops.values()) {
    const prior = observationFor(record, entry.sessionId);
    const established = isEstablished(entry.sessionId);
    if (!established) {
      // No proven boundary. Never a scan from zero on a guess — route by liveness instead.
      if (nowMs - entry.mtimeMs <= activeWindowMs) fresh.push(entry);
      else quiet.push(entry);
      continue;
    }
    const childMoved = movedChildren.has(entry.sessionId);
    if (!changedSince(prior, entry) && !childMoved) continue;
    // The cooldown, and the ONLY rate limit on a changed session. It is measured from the last
    // SUCCESS, so a continuously growing rollout is processed once per window rather than starved
    // by a quiet-age threshold R2 forbids.
    const lastAt = prior && typeof prior.at === 'number' ? prior.at : null;
    if (lastAt !== null && nowMs - lastAt < cooldownMs) { cooling += 1; continue; }
    candidates.push({ entry, childMoved, lastAt: lastAt === null ? 0 : lastAt });
  }

  // Oldest observation first: fairness, so a machine with more due sessions than one pass can take
  // rotates through them instead of servicing the same head of the list forever.
  candidates.sort((a, b) => a.lastAt - b.lastAt);
  const due = candidates.slice(0, Math.max(0, maxSessions)).map((c) => c.entry);

  // A child whose root is not in `tops` has no parent file to check against — either the root's
  // own rollout was not classified this pass (the head-read budget truncated before reaching it)
  // or it is gone. Its root is still scheduled, because the checkpoint resolves the transcript
  // from the session id itself.
  //
  // SYNTHETIC, and marked as such. There is no stat behind this entry, so `mtimeMs` is null rather
  // than a wall-clock stand-in: stamping the parent's watermark from a number that never came from
  // the filesystem would claim we had observed a file we never looked at, and a null `size` would
  // then also disable the size witness for that session forever. Only the CHILD observations
  // advance on this path; the parent's own file is judged the next time the scan reaches it.
  for (const rootId of childrenBySession.keys()) {
    if (tops.has(rootId)) continue;
    if (!isEstablished(rootId)) continue; // unestablished root: coverage decides, not a guess
    if (due.length >= maxSessions) break;
    if (due.some((e) => e.sessionId === rootId)) continue;
    due.push({ sessionId: rootId, transcriptPath: null, cwd: null, mtimeMs: null, size: null, synthetic: true });
  }

  return { due, fresh, quiet, cooling, childrenBySession, deferred: candidates.length - due.length };
}

// ── Durable success ─────────────────────────────────────────────────────────────────────────

/**
 * Did this checkpoint actually read and commit the window?
 *
 * `enqueued === 0` is SUCCESS: a transcript with no new billable usage is a complete read, and
 * gating the watermark on a non-empty enqueue would make every quiet session re-read forever.
 * The three real failures are the ones that mean the window was NOT processed.
 */
export function checkpointSucceeded(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.outcome !== 'committed') return false;
  if (result.gated || (result.skipped && result.skipped.emitFailed)) return false;
  if (result.lockSkipped === true) return false;      // another writer held the session lock
  if (result.unnamedSession === true) return false;   // refused to write under an unusable id
  if (result.skipped && result.skipped.deltaFailed === true) return false;
  if (result.skipped && result.skipped.rateLimitDeferred === true) return false;
  return true;
}

function ledgerDelivered(ledger, sessionId) {
  const sessions = (ledger || {}).sessions;
  if (!sessions || typeof sessions !== 'object') return false;
  const entry = sessions[sessionId];
  if (!entry || typeof entry !== 'object') return false;
  // ACCEPTED/PARTIAL only. A REJECTED entry is NOT delivery — that is what lets a repository that
  // was once unconnected replay in full the moment it is connected (R2). Mirrors the private
  // helper in lib/session-audit.mjs; kept in step by test/watcher-eligibility.test.mjs.
  return entry.outcome === BackfillSessionStatus.ACCEPTED || entry.outcome === BackfillSessionStatus.PARTIAL;
}

// ── One pass ────────────────────────────────────────────────────────────────────────────────

function emptyPass(reason) {
  return {
    reason,
    checkpointed: 0,
    succeeded: 0,
    established: 0,
    deferredUnavailable: 0,
    deferredGap: 0,
    cooling: 0,
    scanned: 0,
    classified: 0,
    truncated: false,
    nextIndex: 0,
    pruned: false,
    history: null,
    errors: 0,
  };
}

/**
 * One complete watcher pass. Synchronous work is chunked and every await point re-checks `stop`.
 * Never throws: a pass that fails is a pass that reports `errors`, because the only thing this
 * process must never do is take the MCP bridge down with it.
 */
export async function runWatchPass(deps = {}, options = {}) {
  if ((!deps.getAccessToken || deps.hookMayProceed) && !(deps.hookMayProceed || hookMayProceed)()) {
    return emptyPass('environment-blocked');
  }
  const nowFn = orDefault(deps.now, Date.now);
  const shouldStop = orDefault(deps.shouldStop, () => false);
  const getAccessToken = orDefault(deps.getAccessToken, _getAccessToken);
  const runCheckpoint = orDefault(deps.runCheckpoint, _runCheckpoint);
  const runAudit = orDefault(deps.runAudit, _runAudit);
  const pruneStale = orDefault(deps.pruneStale, _pruneStale);
  const fetchCoverage = orDefault(deps.fetchCoverage, _fetchCoverage);
  const loadCoverage = orDefault(deps.loadCoverageCheckpoints, _loadCoverageCheckpoints);
  const loadLedger = orDefault(deps.loadLedger, _loadLedger);
  const trackingState = orDefault(deps.readTrackingState, readTrackingState);
  const liveAllowed = orDefault(deps.isLiveTrackingAllowed, isLiveTrackingAllowed);

  const result = emptyPass(null);
  const record = loadObservations(deps);
  let dirty = false;
  const nowMs = nowFn();

  // Pruning, on its own cadence and with no dependence on a trusted SessionStart hook (R2).
  // Deliberately BEFORE the token check: a machine that logged out still accumulates state.
  const prunedAt = typeof record.prunedAt === 'number' ? record.prunedAt : null;
  if (prunedAt === null || nowMs - prunedAt >= orDefault(options.pruneIntervalMs, PRUNE_INTERVAL_MS)) {
    try { pruneStale(); result.pruned = true; } catch { result.errors += 1; }
    record.prunedAt = nowMs;
    dirty = true;
  }

  let token = null;
  try {
    token = await getAccessToken();
  } catch {
    token = null;
  }
  if (!token) {
    // Unlinked. Quiet by design — the option-C constraint: ticket drafting must keep working when
    // analytics cannot, and an unlinked machine must not produce one error per tick forever.
    if (dirty) saveObservations(record, deps);
    result.reason = 'unlinked';
    return result;
  }
  if (shouldStop()) { if (dirty) saveObservations(record, deps); result.reason = 'stopped'; return result; }

  const scan = await scanPass(
    {
      sessionsDir: options.sessionsDir,
      startIndex: options.startIndex,
      maxHeadReads: options.maxHeadReads,
      chunkSize: options.chunkSize,
    },
    deps,
  );
  result.scanned = scan.scanned;
  result.classified = scan.classified;
  result.truncated = scan.truncated;
  result.nextIndex = scan.nextIndex;
  if (shouldStop()) { if (dirty) saveObservations(record, deps); result.reason = 'stopped'; return result; }

  const plan = planPass({
    tops: scan.tops,
    children: scan.children,
    observations: record,
    now: nowMs,
    cooldownMs: options.cooldownMs,
    activeWindowMs: options.activeWindowMs,
    maxSessions: options.maxSessions,
    isEstablished: establishedProbe(deps),
  });
  result.cooling = plan.cooling;

  // The live-capture gate. An audit-only or disabled tenant gets no live checkpoint from the
  // watcher, exactly as flushQueue refuses one from a hook. Fail-open on a missing/corrupt cache,
  // the same posture lib/tracking.mjs documents — the server's guard is the real boundary.
  let live = true;
  try { live = liveAllowed(trackingState()) !== false; } catch { live = true; }

  const checkpointOne = async (sessionId, entry, extra, sessionHandle) => {
    // Null for a SYNTHETIC entry (a child-scheduled root whose own file this pass never stat'ed).
    // No stat, no watermark — see the note in planPass.
    const observed = entry && typeof entry.mtimeMs === 'number' && isFinite(entry.mtimeMs)
      ? { mtimeMs: entry.mtimeMs, size: entry.size }
      : null;
    let outcome = null;
    try {
      outcome = await runCheckpoint(
        {
          session_id: sessionId,
          transcript_path: (entry || {}).transcriptPath,
          cwd: (entry || {}).cwd,
        },
        { sessionHandle },
        {
          // A changed child bills through its ROOT's sweep. Excluding subagents from a listing
          // does not bill them (R2/G-7-1); this flag is what does.
          sweepSubagents: true,
          drainRateLimits: true,
          budgetMs: orDefault(options.budgetMs, CHECKPOINT_BUDGET_MS),
          ...orDefault(extra, {}),
        },
      );
    } catch {
      result.errors += 1;
      return false;
    }
    result.checkpointed += 1;
    if (!checkpointSucceeded(outcome)) return false;
    result.succeeded += 1;
    // The observation taken BEFORE the run, never a fresh stat after it (see the header).
    if (observed) { recordObservation(record, sessionId, observed, nowFn()); dirty = true; }
    const kids = plan.childrenBySession.get(sessionId);
    if (kids) {
      for (const child of kids) {
        recordChildObservation(record, child.agentThreadId, child, sessionId, nowFn());
      }
      dirty = true;
    }
    return true;
  };

  // ── Path A: established sessions ──────────────────────────────────────────────────────────
  if (live) {
    for (const entry of plan.due) {
      if (shouldStop()) break;
      await checkpointOne(entry.sessionId, entry, {});
    }
  }

  // ── Path B: unestablished but still active — coverage decides the boundary ────────────────
  if (live && plan.fresh.length > 0 && !shouldStop()) {
    for (const entry of plan.fresh.slice(0, Math.min(orDefault(options.maxEstablish, MAX_ESTABLISH_PER_PASS),
      orDefault(options.maxCoverageIds, MAX_COVERAGE_PER_PASS)))) {
      if (shouldStop()) break;
      const reconciled = await (deps.reconcileSession || reconcileSession)(entry.sessionId, token, async sessionHandle => {
        const coverage = await fetchCoverage([entry.sessionId], token, {}, {});
        const identity = getMachineClientId();
        const ledger = loadLedger(identity);
        const coverageRecord = loadCoverage(currentBinding(identity));
        const verdict = decideReplay(entry.sessionId, {
          coverage, checkpointLine: checkpointLineFor(coverageRecord, entry.sessionId),
          localCursor: 0, ledgerDelivered: ledgerDelivered(ledger, entry.sessionId),
        });
        if (verdict.decision === ReplayDecision.DEFER) return { outcome: 'deferred', reason: verdict.reason };
        const ok = await checkpointOne(entry.sessionId, entry, {
          startCursor: verdict.startCursor, sweepSubagents: false, recovery: true,
        }, sessionHandle);
        if (ok) result.established += 1;
        return { outcome: ok ? 'committed' : 'deferred' };
      }, { flushQueue: deps.flushQueue });
      if (reconciled.outcome !== 'committed') {
        if (reconciled.reason === DeferReason.GAP) result.deferredGap += 1;
        else result.deferredUnavailable += 1;
      }
    }
  }

  const historyAt = typeof record.historyAt === 'number' ? record.historyAt : null;
  const historyDue = historyAt === null
    || nowMs - historyAt >= orDefault(options.historyIntervalMs, HISTORY_INTERVAL_MS);
  if (plan.quiet.length > 0 && historyDue && !shouldStop()) {
    // runAudit takes runLock('backfill') at rank 1 itself — legal under our rank-0 election lock,
    // and a concurrent /beezi:sync simply refuses this one as 'run-in-progress'. It drains the
    // queue first, consults coverage, honours an audit-only tenant and never seals or reopens the
    // one-time backfill (R2). None of that is reimplemented here.
    try {
      result.history = await runAudit({}, { mode: SYNC_MODE });
    } catch {
      result.errors += 1;
      result.history = null;
    }
    record.historyAt = nowFn();
    dirty = true;
  }

  if (dirty) {
    pruneObservations(record, orDefault(options.maxObservations, MAX_OBSERVATIONS));
    saveObservations(record, deps);
  }
  return result;
}

// ── The loop ────────────────────────────────────────────────────────────────────────────────

/**
 * Start the watcher. Returns `{ stop, started, tick }` — `started: false` when the machine has not
 * opted in, in which case NOTHING has been read, written or armed.
 *
 * The election lock (R3) is held ACROSS ticks and renewed at the top of each one:
 *
 *   not held        → acquireLock(electionLock('watcher'))  — rank 0, coarser than every lock the
 *                     checkpoint transaction (2), the queue/ledger (3) or the backfill run (1)
 *                     take, so nothing below it can ever be a lock-order violation.
 *   held            → renew(). 'lost' means a successor owns the election: the handle self-retires,
 *                     the TICK IS ABANDONED before any scan or checkpoint, and the next tick
 *                     contends again from scratch.
 *   'held'/'contended' → another MCP process is the elected watcher. Skip quietly; try next tick.
 *   'lock-order'    → NOT a busy lock. It is a defect in this process's own acquisition sequence
 *                     and retrying it fails identically forever, so it is surfaced and the loop
 *                     stops rather than spinning on it.
 *
 * TIMERS ARE CLEARED, NEVER UNREF'D (G-10-2). An unref'd timer in a process whose only other
 * handle is stdin is exactly the bug that made the Linux login path hang; the same rule applies to
 * a resident tick loop, and `stop()` is what keeps it from holding the process open at shutdown.
 */
export function startWatcher(deps = {}, options = {}) {
  const env = orDefault(deps.env, process.env);
  if (!isWatcherEnabled(env)) {
    // The whole point of the gate: no fs call, no lock, no timer, no state. Anything above this
    // line in this function must stay free of side effects.
    return { started: false, stop() {}, tick: async () => emptyPass('disabled'), reason: 'disabled' };
  }

  const acquire = orDefault(deps.acquireLockImpl, _acquireLock);
  const setTimeoutImpl = orDefault(deps.setTimeoutImpl, setTimeout);
  const clearTimeoutImpl = orDefault(deps.clearTimeoutImpl, clearTimeout);
  const onPass = orDefault(deps.onPass, () => {});
  const tickMs = orDefault(options.tickMs, TICK_MS);
  const leaseMs = orDefault(options.leaseMs, ELECTION_LEASE_MS);

  let timer = null;
  let stopped = false;
  let running = false;
  let handle = null;
  let startIndex = 0;
  const headCache = new Map();

  const releaseHandle = () => {
    if (!handle) return;
    try { handle.release(); } catch { /* best-effort */ }
    handle = null;
  };

  // Returns 'own' | 'skip' | 'fatal'.
  const takeElection = () => {
    if (handle) {
      const renewed = handle.renew({ leaseMs });
      if (renewed.ok) return 'own';
      if (renewed.reason === 'lost') {
        // The primitive already retired the handle. Abandon this tick untouched — a lost election
        // means another watcher has been running passes we cannot see, and doing work on top of
        // that is the overlap the lock exists to prevent.
        handle = null;
        return 'skip';
      }
      // 'contended'/'expired'/'write-failed': keep the handle, do nothing this tick, try next.
      return 'skip';
    }
    let taken;
    try {
      taken = acquire(electionLock('watcher'), { leaseMs }, deps.lockDeps);
    } catch {
      return 'skip';
    }
    if (taken.ok) { handle = taken.handle; return 'own'; }
    if (taken.reason === 'lock-order') return 'fatal';
    return 'skip';
  };

  const tick = async () => {
    if (stopped || running) return emptyPass('busy');
    running = true;
    try {
      const election = takeElection();
      if (election === 'fatal') {
        // Surfaced, not retried. Stopping is the honest response: every future tick would refuse
        // identically, and a loop that keeps calling is a loop that hides the bug. stop(), not a
        // bare `stopped = true`, so the pending timer is CLEARED rather than left armed to fire
        // once more into a watcher that has already given up.
        stop();
        const out = emptyPass('lock-order');
        onPass(out);
        return out;
      }
      if (election === 'skip') {
        const out = emptyPass('not-elected');
        onPass(out);
        return out;
      }
      const pass = await runWatchPass(
        { ...deps, shouldStop: () => stopped, headCache },
        { ...options, startIndex },
      );
      startIndex = pass.truncated ? pass.nextIndex : 0;
      onPass(pass);
      return pass;
    } catch (error) {
      // A pass that throws must never escape: an unhandled rejection is fatal in Node, and staying
      // up for the whole session is this server's entire job. Nothing is written to stdout — that
      // channel belongs to JSON-RPC.
      const out = emptyPass('error');
      out.errors = 1;
      out.error = orDefault((error || {}).message, 'watcher pass failed');
      onPass(out);
      return out;
    } finally {
      running = false;
      if (!stopped) schedule();
    }
  };

  function schedule() {
    if (stopped) return;
    timer = setTimeoutImpl(() => { timer = null; void tick(); }, tickMs);
  }

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) { clearTimeoutImpl(timer); timer = null; }
    releaseHandle();
  };

  schedule();
  return {
    started: true,
    stop,
    tick,
    // Test seams only: neither is read by production code.
    get armed() { return timer !== null; },
    get elected() { return handle !== null; },
  };
}
