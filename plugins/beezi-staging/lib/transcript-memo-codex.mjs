import { orDefault } from './compat.mjs';
import { readRolloutLines } from './transcript-reader-codex.mjs';

// Holds the last path's read only, so one run keeps at most one rollout in memory; a throw is not cached.
export function createTranscriptMemo(deps = {}) {
  const read = orDefault(deps.readLines, readRolloutLines);
  let cached = null;
  return {
    readLines(transcriptPath) {
      if (cached === null || cached.path !== transcriptPath) {
        cached = { path: transcriptPath, lines: read(transcriptPath) };
      }
      return cached.lines;
    },
  };
}
