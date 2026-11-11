import { orDefault } from './compat.mjs';
import { readRolloutLines, readRolloutTail, sliceRolloutLines } from './transcript-reader-codex.mjs';

// Holds the last path's read only, so one run keeps at most one rollout in memory; a throw is not cached.
//
// `readTail(path, resume)` is the byte-offset read computeDelta takes when it holds a saved resume:
// cut from the cached whole read when this run already has one (a turn end, where the timeline reads
// the whole file anyway), else read from disk at the saved byte. A tail is never cached — nothing
// else in a run reads one. `peek(path)` is the cached whole read, or null, and never reads.
export function createTranscriptMemo(deps = {}) {
  const read = orDefault(deps.readLines, readRolloutLines);
  const readTail = orDefault(deps.readTail, readRolloutTail);
  const slice = orDefault(deps.sliceLines, sliceRolloutLines);
  let cached = null;
  return {
    readLines(transcriptPath) {
      if (cached === null || cached.path !== transcriptPath) {
        cached = { path: transcriptPath, lines: read(transcriptPath) };
      }
      return cached.lines;
    },
    readTail(transcriptPath, resume) {
      if (cached !== null && cached.path === transcriptPath) return slice(cached.lines, resume);
      return readTail(transcriptPath, resume);
    },
    peek(transcriptPath) {
      return cached !== null && cached.path === transcriptPath ? cached.lines : null;
    },
  };
}
