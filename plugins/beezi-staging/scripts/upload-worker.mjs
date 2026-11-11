import { runUploadWorker, writeUploadStatus, workerExitStatus } from '../lib/upload-worker.mjs';
import { exitClean } from '../lib/shutdown.mjs';

// The background uploader, started detached by lib/upload-trigger.mjs. Nobody watches it, so every
// path out of here ends in exactly one exit, including the ones nobody planned.
//
// REF'D watchdog: an idle event loop must not end the run while an upload is in flight, and a hung
// request must not keep the process alive forever. Clearing it in finish() is what lets a normal
// run end, which is why finish() is the single exit funnel.
const WATCHDOG_MS = 5 * 60 * 1000;
// runUploadWorker starts no pass at or past its deadline, so a normal run finishes — and writes its
// own status — well before the watchdog would cut it off.
const RUN_MARGIN_MS = 30000;

let finished = false;
// Set only once runUploadWorker holds the upload lock. A worker refused as `busy` never gets one,
// so it can neither release another worker's lock nor overwrite that worker's status.
let lock = null;

// `outcome` is given on the watchdog and crash paths, where runUploadWorker's own finally may not
// have run: the status would otherwise stay `running` and the lock held until its lease lapses.
// release() is a no-op on an already released handle, so a second call is harmless.
function finish(outcome) {
  if (finished) return;
  finished = true;
  clearTimeout(watchdog);
  if (outcome != null && lock != null) {
    // workerExitStatus sets retryAfterAt for `crash` and `watchdog`, so the trigger backs off.
    try { writeUploadStatus(workerExitStatus(outcome, Date.now())); } catch { /* best-effort */ }
  }
  if (lock != null) {
    try { lock.release(); } catch { /* the lease lapses on its own */ }
  }
  exitClean(0);
}

const watchdog = setTimeout(() => finish('watchdog'), WATCHDOG_MS);

// Nothing may escape: a throw from any depth, or a rejection nobody awaited, still exits through
// finish(), so the lock and the timer are handled the same way.
process.on('uncaughtException', () => finish('crash'));
process.on('unhandledRejection', () => finish('crash'));

runUploadWorker({
  onLock: (handle) => { lock = handle; },
  deadline: Date.now() + WATCHDOG_MS - RUN_MARGIN_MS,
}).then(() => finish(null), () => finish('crash'));
