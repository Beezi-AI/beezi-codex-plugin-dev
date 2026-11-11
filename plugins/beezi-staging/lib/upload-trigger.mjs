import path from 'path';
import { fileURLToPath } from 'url';
import { spawnDetached } from './background-spawn.mjs';
import { inspectLock, runLock } from './single-instance-lock.mjs';
import { readUploadStatus, writeUploadStatus, workerWillRetry, hasPostableWork as _hasPostableWork } from './upload-worker.mjs';
import { orDefault } from './compat.mjs';

// The spawn gate every hook runs after it saved its work to disk (I-trigger). Sync and cheap: one
// lock-file read, one small JSON read, a readdir of the due markers and of each linked account's
// queue, one stat of each account's usage-pending.json (read only when newer than the last run) —
// then at most one detached spawn. No credential read and no network, by construction:
// nothing on this module's static import graph reaches either (test/upload-trigger.test.mjs).
//
// Fast matters beyond the hook's own latency: on Windows a hook that hits its TIMEOUT has its whole
// Job Object killed, detached children included, so the spawn must be the last thing a hook does
// and the hook must be long gone before the worker does anything slow.

export const UPLOAD_WORKER_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'upload-worker.mjs');

// A spawned worker that has not recorded a finish gets this long before the gate tries again: long
// enough for a slow machine to start Node, short enough that a worker that died before taking its
// lock costs one turn's delay at most.
export const ATTEMPT_GAP_MS = 30000;

// A worker holds the upload lock: exactly the lock primitive's own answer, never a second opinion.
// `takeoverReady` is the judgement the next acquire would make — an unexpired lease is held even
// when its pid is gone (a successor could not take it yet, so spawning one would only make it exit
// `busy`), and an expired lease is free once its pid is gone or its liveness grace ran out.
// `deps.isProcessAlive` reaches the primitive's liveness probe, for tests.
function workerRunning(deps) {
  const lockDeps = deps.isProcessAlive ? { isProcessAlive: deps.isProcessAlive } : undefined;
  const info = inspectLock(runLock('upload'), {}, lockDeps);
  return Boolean(info.held) && !info.takeoverReady;
}

function numberOr0(value) {
  const n = Number(value);
  return isFinite(n) ? n : 0;
}

/**
 * → 'disabled' | 'running' | 'stalled' | 'throttled' | 'empty' | 'spawned' | 'failed'.
 * Sync, never throws, reads no credentials. 'failed' means no worker is coming.
 */
export function maybeSpawnUploadWorker(deps = {}) {
  try {
    const env = orDefault(deps.env, process.env);
    // 1. Tests (and every hook a test runs as a child) never start a real worker.
    if (env.BEEZI_TEST_NO_SPAWN === '1') return 'disabled';

    const now = orDefault(deps.now, Date.now);
    const hasPostableWork = orDefault(deps.hasPostableWork, _hasPostableWork);
    const t = now();

    // 2. A live worker is already sending; it re-scans before it exits, so this turn's work is seen.
    if (workerRunning(deps)) return 'running';

    const status = readUploadStatus();
    const retryAfterAt = numberOr0(status.retryAfterAt);
    const attemptedAt = numberOr0(status.attemptedAt);
    const lastRunAt = numberOr0(status.lastRunAt);

    // 3. The last run stalled, crashed, found no account or a blocked environment: wait out the
    //    backoff rather than paying a worker start and a credential read on every turn.
    if (retryAfterAt > t) return 'stalled';

    // 4. A worker was spawned moments ago and has not finished; it will pick this turn up.
    if (attemptedAt > 0 && t - attemptedAt < ATTEMPT_GAP_MS && lastRunAt < attemptedAt) return 'throttled';

    // 5. No worker owes anything (workerWillRetry): the last run left nothing on disk (`pendingWork`
    //    false), and nothing is new since it and nothing is marked due. A run that stopped short left
    //    work older than its own lastRunAt, which the scan cannot see; its flag stands for that work,
    //    behind the backoff and throttle above.
    if (!workerWillRetry(status, hasPostableWork)) return 'empty';

    // 6. Stamp first, so a second hook in the same instant is throttled rather than spawning twice.
    writeUploadStatus({ attemptedAt: t });
    return spawnDetached(UPLOAD_WORKER_SCRIPT, deps) ? 'spawned' : 'failed';
  } catch {
    return 'failed';
  }
}
