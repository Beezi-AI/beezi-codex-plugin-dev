import fs from 'fs';
import path from 'path';
import { uploadDueDir, uploadDueFile } from './paths.mjs';
import { writeJsonSecure, sleepSync as _sleepSync } from './fs-store.mjs';
import { acquireLock as _acquireLock, sharedLock } from './single-instance-lock.mjs';
import { orDefault } from './compat.mjs';

// "This session owes the upload worker some network work" (I-due). A hook that captured a
// checkpoint to disk marks its session here and hands off; the worker's `due-sessions` step runs the
// network half of the checkpoint (timeline, parked errors, the session-start work) and clears the
// marker. One file per session under <data root>/upload-due/, so repeated marks MERGE: the flags
// are OR-ed (a PostToolUse mark never cancels the Stop's `timeline: true`) and `markedAt` moves.
//
// THE CLEAR RACE. The worker reads a marker, runs the session's checkpoint, then clears it. A hook
// that re-marks the same session in between owes NEW work the worker never saw, so the clear must
// not remove it. Three rules:
//   1. `markedAt` strictly increases on every mark (never equal to the previous one, even within one
//      millisecond), so a re-mark is always visible as a changed `markedAt`.
//   2. Mark, clear and the attempt count each run under `shared:upload-due-<sessionId>`. Clear
//      re-reads, compares and unlinks inside it.
//   3. The lock is non-blocking, so a busy one (`held`/`contended`) is retried: 5 attempts, 12 ms
//      apart, 48 ms of sleep at most. Any other refusal is not retried.
//
// STILL REFUSED AFTER THE RETRIES. Clear and the attempt count give up and leave the marker: that
// loses nothing. Mark cannot give up — a lost mark strands the session's timeline — so it writes
// WITHOUT the lock, and is never a blind overwrite:
//   * it reads the marker only after the retries, immediately before its own write, and OR-merges
//     into what is there (so a locked mark that landed while it waited keeps its flags);
//   * after writing it re-reads, and if the marker is gone — a clear's unlink landed after its
//     rename — it writes it again.
// RESIDUAL, stated plainly: an unlocked mark is not atomic with a locked writer. (a) A clear whose
// unlink lands after this mark's post-write re-read deletes it. (b) A locked mark whose rename
// lands between this mark's read and its rename has its newly set flags overwritten. Each window is a
// few synchronous filesystem calls wide and needs the lock to stay busy for 48 ms first. Both fail
// into one missed timeline post that the next turn's mark re-requests, never a lost report: the
// reports themselves are in the queue, not here.
//
// A READ ERROR IS NOT AN ABSENT MARKER. On Windows a concurrent rename can make a read fail with
// EPERM/EBUSY for a moment; merging against "nothing" then would be the blind overwrite this module
// exists to avoid. Only ENOENT means absent. Any other error is retried (3 reads, 5 ms apart); if it
// persists, mark writes nothing (the next hook re-marks), and clear and the attempt count do nothing.
//
// The lock is rank 3 (`shared`): never call these while holding another shared lock.

const DUE_VERSION = 1;
const DUE_LOCK_LEASE_MS = 5000;
const LOCK_ATTEMPTS = 5;
const LOCK_RETRY_MS = 12;
const RETRYABLE_REFUSALS = ['held', 'contended'];
const MARKER_EXT = '.json';
const READ_ATTEMPTS = 3;
const READ_RETRY_MS = 5;
// Failed worker runs a marker may cost before it is dropped (lib/upload-worker.mjs records why).
export const MAX_DUE_ATTEMPTS = 5;

function dueLock(sessionId) {
  return sharedLock(`upload-due-${sessionId}`);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function attemptsOf(record) {
  const n = record ? Number(record.attempts) : 0;
  return isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function entryOf(record) {
  return {
    sessionId: record.sessionId,
    transcriptPath: nonEmptyString(record.transcriptPath),
    cwd: nonEmptyString(record.cwd),
    timeline: record.timeline === true,
    sessionStart: record.sessionStart === true,
    markedAt: record.markedAt,
    attempts: attemptsOf(record),
    owedKeys: owedKeysOf(record.owedKeys),
  };
}

// The account keys that still owe this marker's timeline (parkUploadDue), or null when not parked.
// Only the 8-hex shape lib/paths.mjs accepts; anything else is dropped.
const ACCOUNT_KEY_RE = /^[0-9a-f]{8}$/;

function owedKeysOf(value) {
  if (!Array.isArray(value)) return null;
  const keys = value.filter((k) => typeof k === 'string' && ACCOUNT_KEY_RE.test(k));
  return keys.length > 0 ? keys : null;
}

// A bookkeeping rewrite (attempt count, parking) that keeps the file's mtime. The mtime is the
// marker's last MARK — hasUploadDue compares it on the hook path instead of parsing — so a write
// the worker makes during its run must not look like a new mark to the trigger.
function rewriteKeepingMtime(file, record, write) {
  let mtime = null;
  try { mtime = fs.statSync(file).mtime; } catch { mtime = null; }
  write(file, record);
  if (mtime !== null) { try { fs.utimesSync(file, new Date(), mtime); } catch { /* best-effort */ } }
}

function validRecord(value) {
  return isPlainObject(value)
    && typeof value.sessionId === 'string' && value.sessionId !== ''
    && typeof value.markedAt === 'number' && isFinite(value.markedAt);
}

// → { ok: true, record } (record null when absent or unparseable) | { ok: false } (could not read).
function readMarker(file, deps) {
  const readFile = orDefault(deps.readFileSync, (f, enc) => fs.readFileSync(f, enc));
  const sleep = orDefault(deps.sleepSync, _sleepSync);
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt += 1) {
    if (attempt > 0) sleep(READ_RETRY_MS);
    let raw;
    try {
      raw = readFile(file, 'utf-8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return { ok: true, record: null };
      continue;
    }
    let value = null;
    try { value = JSON.parse(raw); } catch { value = null; }
    return { ok: true, record: validRecord(value) ? value : null };
  }
  return { ok: false };
}

function seams(deps) {
  return {
    read: (file) => readMarker(file, deps),
    write: orDefault(deps.writeJson, (file, record) => writeJsonSecure(file, record)),
  };
}

// Run `fn` under the marker's lock; `fn(locked)` learns whether the lock was actually taken.
function underDueLock(sessionId, deps, fn) {
  const acquire = orDefault(deps.acquireLock, _acquireLock);
  const sleep = orDefault(deps.sleepSync, _sleepSync);
  let acquired = null;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    if (attempt > 0) sleep(LOCK_RETRY_MS);
    try { acquired = acquire(dueLock(sessionId), { leaseMs: DUE_LOCK_LEASE_MS }); } catch { acquired = null; break; }
    if (acquired && acquired.ok) break;
    if (!acquired || RETRYABLE_REFUSALS.indexOf(acquired.reason) === -1) break;
  }
  const locked = Boolean(acquired && acquired.ok);
  try {
    return fn(locked);
  } finally {
    if (locked) { try { acquired.handle.release(); } catch { /* lease expires */ } }
  }
}

function merged(sessionId, given, before, at) {
  return {
    version: DUE_VERSION,
    sessionId,
    transcriptPath: orDefault(nonEmptyString(given.transcriptPath), before ? nonEmptyString(before.transcriptPath) : null),
    cwd: orDefault(nonEmptyString(given.cwd), before ? nonEmptyString(before.cwd) : null),
    timeline: given.timeline === true || Boolean(before && before.timeline === true),
    sessionStart: given.sessionStart === true || Boolean(before && before.sessionStart === true),
    // Strictly later than the previous mark, or clearUploadDue could not tell them apart.
    markedAt: before && before.markedAt >= at ? before.markedAt + 1 : at,
    // Carried across re-marks: a session whose network half keeps failing is still capped.
    attempts: attemptsOf(before),
  };
}

/**
 * Mark `sessionId` due for the upload worker, merging into its existing marker.
 * fields: { transcriptPath, cwd, timeline: boolean, sessionStart: boolean }.
 * Returns the entry as written, or null when nothing could be written. Never throws.
 */
export function markUploadDue(sessionId, fields, deps = {}) {
  let file;
  try { file = uploadDueFile(sessionId); } catch { return null; }
  const given = isPlainObject(fields) ? fields : {};
  const now = orDefault(deps.now, Date.now);
  const { read, write } = seams(deps);
  try {
    return underDueLock(sessionId, deps, (locked) => {
      // Read here, after the lock attempts — never before them — so an unlocked write folds in
      // whatever a locked writer committed while this one waited.
      const before = read(file);
      if (!before.ok) return null;
      const record = merged(sessionId, given, before.record, now());
      write(file, record);
      // Unlocked: a clear's unlink may have landed after the rename. Put the marker back.
      if (!locked) {
        const after = read(file);
        if (after.ok && after.record === null) write(file, record);
      }
      return entryOf(record);
    });
  } catch {
    return null;
  }
}

/**
 * Every due session, oldest mark first: { sessionId, transcriptPath, cwd, timeline, sessionStart,
 * markedAt, attempts }. A marker that parses to nothing usable is removed here: left in place it
 * would keep the trigger answering "work is due" and respawn a worker that can never clear it.
 * Never throws.
 */
export function listUploadDue(deps = {}) {
  let names;
  try { names = fs.readdirSync(uploadDueDir()); } catch { return []; }
  const out = [];
  for (const name of names) {
    // `.json` only: writeJsonSecure's in-flight temp is `<file>.<pid>.tmp`.
    if (!name.endsWith(MARKER_EXT)) continue;
    const file = path.join(uploadDueDir(), name);
    let raw;
    try { raw = fs.readFileSync(file, 'utf-8'); } catch { continue; } // unreadable this instant: keep
    let value = null;
    try { value = JSON.parse(raw); } catch { value = null; }
    if (!validRecord(value) || `${value.sessionId}${MARKER_EXT}` !== name) {
      try { fs.unlinkSync(file); } catch { /* already gone */ }
      continue;
    }
    out.push(entryOf(value));
  }
  out.sort((a, b) => (a.markedAt - b.markedAt) || (a.sessionId < b.sessionId ? -1 : (a.sessionId > b.sessionId ? 1 : 0)));
  return out;
}

/**
 * True when a marker file was written by a MARK after `sinceMs` (any marker when it is omitted).
 * The trigger's probe, on the hook path: one readdir plus one stat per marker, never a parse. The
 * file's mtime is its last mark, because every mark rewrites the file and the worker's bookkeeping
 * writes restore the mtime (rewriteKeepingMtime). A marker an earlier run could not settle — its only
 * missing sender had no token, its transcript cannot be resolved — is older than that run and must
 * not start a worker on every hook; the session's next mark rewrites it and starts one. A stat that
 * fails says yes, so a worker's listUploadDue gets to read or remove it. Stops at the first hit.
 * Never throws.
 */
export function hasUploadDue(sinceMs) {
  const since = typeof sinceMs === 'number' && isFinite(sinceMs) ? sinceMs : -Infinity;
  let names;
  try { names = fs.readdirSync(uploadDueDir()); } catch { return false; }
  for (const name of names) {
    if (!name.endsWith(MARKER_EXT)) continue;
    if (since === -Infinity) return true;
    let mtimeMs = null;
    try { mtimeMs = fs.statSync(path.join(uploadDueDir(), name)).mtimeMs; } catch { mtimeMs = null; }
    if (mtimeMs === null || mtimeMs > since) return true;
  }
  return false;
}

/**
 * Remove `entry`'s marker only if it was not re-marked since `entry` was listed (same `markedAt`).
 * Returns true when this call removed it. Never throws.
 */
export function clearUploadDue(entry, deps = {}) {
  if (!isPlainObject(entry)) return false;
  let file;
  try { file = uploadDueFile(entry.sessionId); } catch { return false; }
  const { read } = seams(deps);
  try {
    return underDueLock(entry.sessionId, deps, (locked) => {
      if (!locked) return false;
      const current = read(file);
      if (!current.ok || current.record === null || current.record.markedAt !== entry.markedAt) return false;
      fs.unlinkSync(file);
      return true;
    });
  } catch {
    return false;
  }
}

/**
 * Count one failed worker run against `entry`'s session, keeping its `markedAt`; at
 * MAX_DUE_ATTEMPTS the marker is removed. → { attempts, dropped }. Not charged, and left alone with
 * { attempts: <current>, dropped: false }, when the marker was re-marked since `entry` was listed (a
 * run that saw the older mark says nothing about the new work). A marker that is gone, unreadable or
 * whose lock stays refused: { attempts: 0, dropped: false }. Never throws.
 */
export function noteUploadDueAttempt(entry, deps = {}) {
  const none = { attempts: 0, dropped: false };
  if (!isPlainObject(entry)) return none;
  let file;
  try { file = uploadDueFile(entry.sessionId); } catch { return none; }
  const { read, write } = seams(deps);
  try {
    return underDueLock(entry.sessionId, deps, (locked) => {
      if (!locked) return none;
      const read1 = read(file);
      if (!read1.ok || read1.record === null) return none;
      const current = read1.record;
      if (current.markedAt !== entry.markedAt) return { attempts: attemptsOf(current), dropped: false };
      const attempts = attemptsOf(current) + 1;
      if (attempts >= MAX_DUE_ATTEMPTS) {
        fs.unlinkSync(file);
        return { attempts, dropped: true };
      }
      rewriteKeepingMtime(file, Object.assign({}, current, { attempts }), write);
      return { attempts, dropped: false };
    });
  } catch {
    return none;
  }
}

/**
 * Park `entry`'s marker on the accounts that still owe its timeline: every live sender confirmed it
 * and only these accounts, tokenless this run, did not (lib/upload-worker.mjs). A later run re-runs
 * the marker's checkpoint only once one of them has a token, instead of re-reading the transcript
 * and re-posting the timeline to the live senders on every run. A re-mark clears the keys (new work
 * runs in full). Keeps `markedAt` and the file mtime. Not done when the marker was re-marked since
 * `entry` was listed, is gone, or `owedKeys` holds no usable key. → true when written. Never throws.
 */
export function parkUploadDue(entry, owedKeys, deps = {}) {
  const keys = owedKeysOf(owedKeys);
  if (!isPlainObject(entry) || keys === null) return false;
  let file;
  try { file = uploadDueFile(entry.sessionId); } catch { return false; }
  const { read, write } = seams(deps);
  try {
    return underDueLock(entry.sessionId, deps, (locked) => {
      if (!locked) return false;
      const current = read(file);
      if (!current.ok || current.record === null || current.record.markedAt !== entry.markedAt) return false;
      rewriteKeepingMtime(file, Object.assign({}, current.record, { owedKeys: keys }), write);
      return true;
    });
  } catch {
    return false;
  }
}
