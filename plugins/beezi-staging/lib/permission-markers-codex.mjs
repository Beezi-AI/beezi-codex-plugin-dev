import fs from 'fs';
import path from 'path';
import { stateDir } from './paths.mjs';
import { safeFileName } from './fs-store.mjs';

// Codex never writes an approval request or its decision to the rollout, so a wait on the human
// leaves no trace for the timeline to find. The PermissionRequest hook fires just before Codex puts
// a prompt on screen; a line appended here is the one durable proof that a human was being waited
// on at that instant. The file is the whole channel between the hook process and the timeline
// computation — nothing else is shared between them but the filesystem.
//
// Append-only, one JSON object per line, and deliberately NOT under lib/single-instance-lock.mjs,
// whose rule (every writer of shared state goes through it) this module knowingly steps around:
// the lock guards read-modify-write, and there is no read here. One `appendFileSync` of a whole
// line is a single O_APPEND write that the OS does not interleave, there is one writer per
// approval prompt, and a reader skips any torn line — so concurrent hooks can only produce whole
// lines in some order and a lock would buy nothing. It would cost: the user is staring at a frozen
// prompt, and a lock wait is time spent in front of it.
//
// Never trimmed in place for the same reason. ~100 bytes a line, and pruneStale's sweep over
// stateDir() already collects these alongside every other per-session file.

// Read-time ceiling, so a pathological session cannot hand the classifier an unbounded array.
export const MAX_MARKERS = 2000;

// Kept past the 14-day sweep that governs every other stateDir() file. A marker is the only record of
// an approval wait, and sync re-derives sessions up to MAX_SESSION_AGE_MS (30 days) old and replaces
// the stored timeline on each post; a marker pruned first would silently drop those periods. Must
// exceed that 30-day window. Not imported from session-audit here: this file is loaded by the hook
// script, which has to stay light.
export const PERMISSION_MARKER_MAX_AGE_MS = 35 * 24 * 60 * 60 * 1000;

// safeFileName because `session_id` arrives on a hook payload and becomes a path segment.
//
// `.perm.jsonl`, and never `.json`: state/ is enumerated by readers that parse `*.json` as session
// state (findRolloutBySessionState in lib/transcript-codex.mjs) and derive a session id from
// `<id>.json` / `<id>.agents` names (poisonedStateEntries). See the matching comment in
// lib/timing.mjs; test/permission-markers-codex.test.mjs pins that this shape is ignored by them.
export function permissionMarkerFile(sessionId) {
  return path.join(stateDir(), safeFileName(sessionId) + '.perm.jsonl');
}

// Append one marker for a PermissionRequest hook payload. Best-effort: a telemetry line must never
// break the approval dialog that is waiting on this hook to exit, so this returns false rather than
// throwing. Keys whose value is undefined or null are left out of the line.
export function appendPermissionMarker(input, deps = {}) {
  try {
    if (!input || typeof input.session_id !== 'string' || !input.session_id) return false;
    const now = typeof deps.now === 'number' ? deps.now : Date.now();
    const marker = { at: new Date(now).toISOString() };
    const fields = ['turn_id', 'agent_id', 'tool_name', 'permission_mode'];
    for (let i = 0; i < fields.length; i++) {
      const value = input[fields[i]];
      if (value !== undefined && value !== null) marker[fields[i]] = value;
    }
    fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    fs.appendFileSync(permissionMarkerFile(input.session_id), JSON.stringify(marker) + '\n', { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

const str = (v) => (typeof v === 'string' ? v : null);

// A session's markers, oldest first. A missing file, an unreadable file and torn lines all resolve
// to "no markers", which degrades to the behaviour before markers existed. Past MAX_MARKERS the
// NEWEST are kept: the tail is what the live timeline is still being built from.
export function readPermissionMarkers(sessionId) {
  let raw;
  try {
    raw = fs.readFileSync(permissionMarkerFile(sessionId), 'utf-8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!parsed || typeof parsed !== 'object') continue;
    const ts = Date.parse(parsed.at);
    if (!Number.isFinite(ts)) continue;
    out.push({
      ts,
      turnId: str(parsed.turn_id),
      agentId: str(parsed.agent_id),
      toolName: str(parsed.tool_name),
      permissionMode: str(parsed.permission_mode),
    });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out.length > MAX_MARKERS ? out.slice(out.length - MAX_MARKERS) : out;
}
