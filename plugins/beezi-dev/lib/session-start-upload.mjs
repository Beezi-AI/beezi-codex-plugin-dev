import fs from 'fs';
import path from 'path';
import { sessionStartCacheFile } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';

// The network half of SessionStart, as an upload-worker due handler (lib/upload-worker.mjs
// registers it). The hook reads no credential and makes no request: it marks its session due with
// `sessionStart: true`, and the worker — which already holds every account's token for its run —
// does here what the hook used to await: whoami per account (with one forced renewal on a 401/403),
// the /repos/status probe, the account check-in and the update check. The queue drain is the
// worker's own `queue` step.
//
// What the hook needs from those answers is left on disk, per account, in
// accounts/<key>/session-start.json (sessionStartCacheFile):
//   { version, checkedAt, verdict, clientId, who, repos, completed }
//   checkedAt when whoami last answered for the account — whoami's own, not the whole handler's
//   verdict   'ok' | 'rejected' (still refused after the renewal) | 'temporary' (the renewal could
//             not run) — what the hook says about the account
//   who       the last VALID whoami identity { valid, email, name, tenantName, tenants,
//             anonymization }, overlaid on the index row exactly as the live answer used to be
//   repos     { '<target tenantId>|<remote>': { connected, projectName, checkedAt } }
//   completed { '<sessionId>': <markedAt> } — the sessions whose whole start (whoami, repo probe,
//             check-in, update check) finished, and the mark it covered; the worker's own record
//             (lib/session-start.mjs START_DONE_MAX), never read by the hook
// The rest of what whoami fed lives where it always did: the index row (updateAccount) and the
// tracking policy (recordWhoami). Why an account produced no token at all is the token module's
// own record, accounts/<key>/auth-state.json (lib/telemetry-auth.mjs).
//
// WRITERS. The upload worker (one per data root: it holds `run:upload`) and a re-login
// (lib/login.mjs sets the verdict back to ok), so the read-merge-write below takes no lock. A worker
// run that raced a re-login can write back the refusal it reached under the OLD client; the hook
// ignores a refusal whose `clientId` is not the row's. The hook only reads the file.
//
// STATIC IMPORTS STAY LIGHT. lib/upload-worker.mjs imports this module statically, and every hook
// imports the worker through lib/upload-trigger.mjs; the body lives in lib/session-start.mjs and is
// loaded only when a session-start marker is actually handled.

const CACHE_VERSION = 1;

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** The account's cached session-start answers, or {} when missing, unreadable or malformed. Never throws. */
export function readSessionStartCache(key) {
  try {
    const value = readJson(sessionStartCacheFile(key), null);
    return isPlainObject(value) ? value : {};
  } catch {
    return {};
  }
}

/**
 * Merge `patch` into the account's cache (atomic replace). Not written when the account directory
 * is gone — a logout that landed during the run must not get its directory back. → true when
 * written. Never throws.
 */
export function writeSessionStartCache(key, patch) {
  try {
    const file = sessionStartCacheFile(key);
    if (!fs.existsSync(path.dirname(file))) return false;
    writeJsonSecure(file, Object.assign({}, readSessionStartCache(key), patch, { version: CACHE_VERSION }));
    return true;
  } catch {
    return false;
  }
}

/**
 * The `session-start` due handler: (entry, ctx) → { settled }. A marker without `sessionStart`
 * owes it nothing. Unsettled only when the run's deadline cut the work short.
 */
export async function sessionStartDueHandler(entry, ctx) {
  if (!isPlainObject(entry) || entry.sessionStart !== true) return { settled: true };
  const start = await import('./session-start.mjs');
  return start.runSessionStartUpload(entry, ctx);
}
