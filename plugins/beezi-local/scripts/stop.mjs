import { readHookInput } from '../lib/hook-input.mjs';
import { runCheckpoint, HOOK_BUDGET_MS } from '../lib/checkpoint.mjs';
import { touchHeartbeat } from '../lib/timing.mjs';
import { exitClean } from '../lib/shutdown.mjs';
import { hookMayProceed } from '../lib/env-guard.mjs';

const input = readHookInput();
if (!input) process.exit(0);
// R1: nothing is checkpointed, queued or drained while the data root's environment is unsettled.
// Silent by design — a hook that writes to stderr is reported as a failed hook; SessionStart
// carries the explanation.
if (!hookMayProceed()) process.exit(0);
// A turn end IS a checkpoint, so it resets the mid-turn heartbeat window (G-3-2). Without this the
// marker would only ever track heartbeats, and a session whose Stop lands at minute 14 would pay a
// full engine load two minutes into the next turn for a window holding almost nothing. Stamped
// before the run, not after: the interval is about when the checkpoint STARTED covering the
// window, and a stamp that never lands because the process was killed would leave the next turn
// firing an immediate heartbeat — which is the correct outcome for a Stop that did not finish.
// Free here — checkpoint.mjs is already imported statically on this path.

// Turn-end: emit the whole-session activity timeline alongside the segment checkpoint.
// budgetMs, because this is the hook that flushes the queue: a backlog against a stalled API costs
// one per-request timeout per report, and Codex kills — and reports as failed — a hook that
// overruns its registered timeout. Whatever does not fit stays queued for the next turn.
runCheckpoint(input, {}, { emitTimeline: true, budgetMs: HOOK_BUDGET_MS })
  .then(result => { if (result.outcome === 'committed') touchHeartbeat(input.session_id); })
    .catch(() => {})
  .finally(() => exitClean(0));
