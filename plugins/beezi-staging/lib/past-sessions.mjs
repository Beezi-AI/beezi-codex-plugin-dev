import { currentSession, readSessionWorkspace, tenantsOf } from './workspace.mjs';
import {
  ACTIVE_SESSION_WINDOW_MS, MAX_SESSION_AGE_MS, MAX_TRANSCRIPT_BYTES, createRouteContext, routeKeyForDir,
} from './workspace-rules.mjs';
import { listAllRollouts } from './transcript-index-codex.mjs';
import { isImported, loadLedger } from './audit-ledger.mjs';

const placeId = (key) => `${key.kind}\n${key.match}`;

// Past sessions the history upload would send (not live, active, over 30 days old, oversized or imported) and the distinct
// places they ran in, deduped by kind+match and less `hereKey`'s place; one with no directory counts in sessions only.
// readState(sessionId)'s cwd wins over readCwd(entry).
export function countPastSessions(entries, {
  liveSessionId = null, now = Date.now(), imported, readState = () => null, readCwd, keyOf, hereKey = null,
}) {
  const places = new Set();
  let sessions = 0;
  for (const entry of entries || []) {
    if (entry == null || entry.sessionId == null || (liveSessionId != null && entry.sessionId === liveSessionId)) continue;
    const age = now - entry.mtimeMs;
    if (age < ACTIVE_SESSION_WINDOW_MS || age > MAX_SESSION_AGE_MS || entry.size > MAX_TRANSCRIPT_BYTES || imported(entry.sessionId)) continue;
    sessions += 1;
    const state = readState(entry.sessionId);
    const dir = state != null && typeof state.cwd === 'string' && state.cwd !== '' ? state.cwd : readCwd(entry);
    const key = dir == null ? null : keyOf(dir);
    if (key != null) places.add(placeId(key));
  }
  if (hereKey != null) places.delete(placeId(hereKey));
  return { sessions, places: places.size };
}

// countPastSessions over this machine's rollouts; a session in the account's legacy ledger or any workspace's is not uploaded again.
// `cwd`/`env` name the session this runs in (currentSession's rule), which is left out as live.
export function pastSessions(row, hereKey = null, { cwd = process.cwd(), env = process.env } = {}) {
  const ctx = createRouteContext();
  const identity = row.clientId == null ? null : row.clientId;
  const ledgers = [loadLedger(row.key, identity)].concat((tenantsOf(row) || []).map((t) => loadLedger(row.key, identity, t.id)));
  return countPastSessions(listAllRollouts(), {
    liveSessionId: currentSession(cwd, env).sessionId,
    imported: (sessionId) => ledgers.some((ledger) => isImported(ledger, sessionId)),
    readState: readSessionWorkspace,
    readCwd: (entry) => entry.cwd,
    keyOf: (dir) => routeKeyForDir(dir, ctx),
    hereKey,
  });
}
