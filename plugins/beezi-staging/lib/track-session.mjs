import path from 'path';
import { getAccessToken as _getAccessToken } from './token.mjs';
import { runCheckpoint as _runCheckpoint } from './checkpoint.mjs';
import { currentBranch as _currentBranch, taskFromBranch } from './git.mjs';
import {
  isUsableSessionId,
  resolveTranscriptByCwd as _resolveTranscriptByCwd,
} from './transcript-codex.mjs';
import { orDefault } from './compat.mjs';

// What /beezi:track will report on, or a refusal — `{ ok: true, sessionId, transcriptPath }` or
// `{ ok: false, message }`.
//
// This is where the strict id validation lives, and it is deliberately NOT in the resolver.
// resolveTranscriptByCwd answers `{ sessionId: null, transcriptPath }` for a rollout it can locate
// but not name, and one of its two callers NEEDS that: liveSession() (lib/session-audit.mjs)
// resolves the current session only to exclude it from the backfill, and matches on the transcript
// PATH. Rejecting at the resolver would make it blind, the backfill would stop excluding the live
// session, and it would re-segment a transcript the live hooks are already reporting on different
// boundaries — double-billing the spend. test/session-audit.test.mjs case 7 pins that tolerance.
//
// This caller is the asymmetric one. Every durable key it produces is derived from the id: the
// state file `state/<id>.json`, the `<id>:<from>-<to>` segmentId, the queue filename derived from
// that segmentId, and the sessionId on the wire. A null id here writes `state/null.json` — one
// file shared by every id-less session in this directory, whose cursor and coveredIntervals they
// clobber for each other — and, before the resolver learned to skip it, made every later track
// from this cwd report as a session literally called "null".
export function resolveTrackTarget(cwd, deps = {}) {
  const resolveTranscript = orDefault(deps.resolveTranscriptByCwdImpl, _resolveTranscriptByCwd);
  const transcript = resolveTranscript(cwd);
  if (!transcript || !transcript.transcriptPath) {
    return { ok: false, message: 'Beezi: could not find this session’s transcript to track.' };
  }
  if (!isUsableSessionId(transcript.sessionId)) {
    return {
      ok: false,
      message: 'Beezi: could not identify this session — its transcript records no session id, '
        + 'so there is no id to save the analytics under. Nothing was written.',
    };
  }
  return { ok: true, sessionId: transcript.sessionId, transcriptPath: transcript.transcriptPath };
}

// The manual track flow for one session: checkpoint, flush, word the outcome.
// Returns { ok, message } (message unprefixed); expected failures never throw.
//
// No budgetMs is passed to the checkpoint: hooks bound their network work because Codex kills an
// overrunning hook, but a user waiting at a terminal would rather see the whole queue drained.
// `drainRateLimits` is set for the same reason: this is the one path with no budget to protect, so
// it is the last place the queued rate-limit rows should be left sitting on disk. The timeline POST
// stays off — it is derived from the whole transcript and re-sent at every real turn end anyway.
export async function trackSession({ sessionId, transcriptPath, cwd }, deps = {}) {
  // Second gate, on the value actually handed to runCheckpoint. resolveTrackTarget above is the
  // one the script calls, but this is the function that turns an id into `state/<id>.json` and a
  // segmentId, so it refuses rather than trust every future caller to have checked.
  if (!isUsableSessionId(sessionId)) {
    return {
      ok: false,
      message: 'Beezi: could not identify this session, so there is nothing to save it under.',
    };
  }
  const getAccessToken = orDefault(deps.getAccessToken, _getAccessToken);
  const runCheckpoint = orDefault(deps.runCheckpoint, _runCheckpoint);
  const currentBranch = orDefault(deps.currentBranch, _currentBranch);

  // Label only. The checkpoint attributes every segment from the rollout, so a cwd outside
  // any repo — or a repo with no origin — is not a reason to refuse; those report under a
  // `local:<folder>` remote like the automatic hooks do.
  let branch = null;
  try { branch = currentBranch(cwd); } catch { /* not a repo */ }
  let label = taskFromBranch(branch);
  if (label === undefined || label === null) label = branch;
  if (label === undefined || label === null) label = path.basename(orDefault(cwd, '')) || cwd;

  const token = await getAccessToken().catch(() => null);
  if (!token) {
    return { ok: false, message: 'Beezi: this machine is not linked. Sign in to Beezi first.' };
  }

  const { enqueued, flush, outcome, reason } = await runCheckpoint(
    {
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd,
    },
    {},
    { drainRateLimits: true },
  );

  if (outcome !== 'committed') {
    return { ok: false, message: `Beezi: checkpoint ${outcome || 'deferred'} (${reason || 'not committed'}); retry tracking.` };
  }

  if (flush && flush.failed) {
    return { ok: false, message: 'Beezi: could not reach the server — analytics will be retried automatically.' };
  }
  if (flush && flush.rejected) {
    return { ok: false, message: `Beezi: ${orDefault(flush.lastError, 'the server rejected this report')}.` };
  }

  const saved = orDefault((flush || {}).flushed, 0);
  if (enqueued === 0 && saved === 0) {
    return { ok: true, message: `Beezi: nothing new to save for ${label} — already up to date.` };
  }
  return { ok: true, message: `Beezi: analytics saved for ${label} (${saved} segment${saved === 1 ? '' : 's'}).` };
}
