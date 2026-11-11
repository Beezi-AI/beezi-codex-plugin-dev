import { readHookInput } from '../lib/hook-input.mjs';
import { runHook, importHookModule } from '../lib/hook-runner.mjs';
import { DIAGNOSTIC_SOURCES } from '../lib/diagnostics.mjs';
import { touchHeartbeat } from '../lib/timing.mjs';
import { hookMayProceedLocal } from '../lib/env-guard.mjs';
import { exitClean } from '../lib/shutdown.mjs';

const input = readHookInput();
if (!input) process.exit(0);

// R1: nothing is checkpointed or queued while the data root's environment is unsettled. The
// credential-free form of the guard: a hook no longer reads credentials, and it answers 'ok' only
// for a root already bound to this environment. The upload worker runs the full guard (and the
// migration it may perform) before it sends anything. Silent by design — a hook that writes to
// stderr is reported as a failed hook; SessionStart carries the explanation. R-numbers cite
// docs/plans/2026-09-10-sections/REVIEW.md.
const proceed = hookMayProceedLocal();

// A turn end IS a checkpoint, so it resets the mid-turn heartbeat window (G-3-2). Without this the
// marker would only ever track heartbeats, and a session whose Stop lands at minute 14 would pay a
// full engine load two minutes into the next turn for a window holding almost nothing. Stamped
// AFTER the run and only on `outcome === 'committed'`: the marker claims a window that was actually
// covered, so a checkpoint that was gated, skipped or failed leaves the old stamp standing and the
// next turn fires an immediate heartbeat — which is the correct outcome for a Stop that did not
// finish.

// Turn end, CAPTURE ONLY (I-local): the segment checkpoint goes to disk, the session is marked due
// with its timeline owed, and the upload trigger starts the background worker, which posts the
// reports, the timeline, the parked errors, the rate-limit rows and the diagnostics this hook used
// to send inline. emitTimeline still drives the subagent sweep. budgetMs stays as the bound on
// anything time-boxed inside the checkpoint; Codex kills — and reports as failed — a hook that
// overruns its registered timeout.
if (!proceed) {
  exitClean(0);
} else {
  runHook(DIAGNOSTIC_SOURCES.STOP, async () => {
    const mod = await importHookModule('./checkpoint.mjs');
    if (!mod) return;
    const { runCheckpoint, HOOK_BUDGET_MS } = mod;
    const result = await runCheckpoint(input, {}, { localOnly: true, emitTimeline: true, budgetMs: HOOK_BUDGET_MS });
    if (result.outcome === 'committed') touchHeartbeat(input.session_id);
  });
}
