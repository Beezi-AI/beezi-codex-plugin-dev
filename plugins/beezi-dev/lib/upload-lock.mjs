import { acquireLock as _acquireLock, runLock } from './single-instance-lock.mjs';
import { RUN_LEASE_MS, HEARTBEAT_MS, BUSY_REFUSALS } from './upload-worker.mjs';
import { maybeSpawnUploadWorker as _maybeSpawnUploadWorker } from './upload-trigger.mjs';
import { orDefault } from './compat.mjs';

// ONE DRAINER. The background upload worker (lib/upload-worker.mjs) sends under runLock('upload');
// the two drains a user starts from a terminal — the track skill's checkpoint and the sync skill's
// drain before reconciliation — take the same lock through this module, so a terminal drain and
// the worker never send the same queue at once. Hooks and the MCP rollout watcher never send:
// they save to disk and call the trigger (lib/upload-trigger.mjs).
//
// WAITING lives here, never in lib/single-instance-lock.mjs, whose contract is bounded work per
// acquire and no sleeping. A user at a terminal can wait for a running worker to finish its pass;
// a hook could not.
//
// Only a busy lock is waited out: 'held' and 'contended' are another holder, 'migration' is a
// migration that has the root. Every other refusal — 'lock-order' above all — is a defect or a
// filesystem fault that retrying cannot fix, and it is answered at once.
//
// LOCK ORDER. 'upload' is a rank-1 run lock, like the history run's 'backfill'. The primitive
// refuses a second rank-1 lock whichever is taken first, so a caller that also needs the history
// lock takes the two in SEQUENCE, never nested: lib/session-audit.mjs drains under this one,
// releases it, then takes 'backfill'. Inside the hold the caller may take session (2), shared (3)
// and credential (4) locks — the checkpoint's session lock and flushQueue's `shared:queue-<key>`.

/** How long a terminal drain waits for a running worker before it reports busy. */
export const UPLOAD_WAIT_MS = 60_000;
/** How often it looks again while it waits. */
export const UPLOAD_POLL_MS = 500;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn(handle)` holding runLock('upload') → `{ ok: true, value }`, or `{ ok: false, reason,
 * detail }` without running it: reason 'busy' (another holder for the whole wait; detail is the
 * last refusal), a refusal the primitive gave ('lock-order', 'write-failed', …), or 'lock-failed'
 * when the acquire threw. A throw from `fn` reaches the caller after the release.
 *
 * The hold is renewed every HEARTBEAT_MS on the worker's own RUN_LEASE_MS: a terminal drain has no
 * budget and can outlive one lease, and a lapsed lease would let a worker start beside it. After
 * the release the trigger runs once: a hook that saved work during the hold saw a running worker
 * and started none.
 *
 * deps: acquireLock, now, sleep, waitMs, pollMs, setIntervalImpl, clearIntervalImpl,
 * maybeSpawnUploadWorker — seams for tests.
 */
export async function withUploadLock(fn, deps = {}) {
  const acquire = orDefault(deps.acquireLock, _acquireLock);
  const now = orDefault(deps.now, Date.now);
  const sleep = orDefault(deps.sleep, defaultSleep);
  const waitMs = orDefault(deps.waitMs, UPLOAD_WAIT_MS);
  const pollMs = orDefault(deps.pollMs, UPLOAD_POLL_MS);
  const setIntervalImpl = orDefault(deps.setIntervalImpl, setInterval);
  const clearIntervalImpl = orDefault(deps.clearIntervalImpl, clearInterval);
  const trigger = orDefault(deps.maybeSpawnUploadWorker, _maybeSpawnUploadWorker);

  const startedAt = now();
  let acquired;
  for (;;) {
    try {
      acquired = acquire(runLock('upload'), { leaseMs: RUN_LEASE_MS });
    } catch (error) {
      return { ok: false, reason: 'lock-failed', detail: orDefault((error || {}).message, 'could not take the upload lock') };
    }
    if (acquired && acquired.ok) break;
    const reason = acquired ? acquired.reason : null;
    if (BUSY_REFUSALS.indexOf(reason) === -1) {
      return { ok: false, reason: orDefault(reason, 'lock-failed'), detail: orDefault((acquired || {}).detail, null) };
    }
    if (now() - startedAt + pollMs > waitMs) return { ok: false, reason: 'busy', detail: reason };
    await sleep(pollMs);
  }

  const handle = acquired.handle;
  let heartbeat = null;
  let value;
  try {
    heartbeat = setIntervalImpl(() => {
      try { handle.renew({ leaseMs: RUN_LEASE_MS }); } catch { /* the inner shared lock still serializes the queue */ }
    }, HEARTBEAT_MS);
    // The drain's own requests keep the process alive; the heartbeat must not.
    if (heartbeat && typeof heartbeat.unref === 'function') heartbeat.unref();
    value = await fn(handle);
  } finally {
    if (heartbeat !== null) { try { clearIntervalImpl(heartbeat); } catch { /* best-effort */ } }
    try { handle.release(); } catch { /* the lease lapses on its own */ }
    // After the release, and even when `fn` threw: whatever it saved before the throw is handed off.
    try { trigger(); } catch { /* the next hook triggers */ }
  }
  return { ok: true, value };
}
