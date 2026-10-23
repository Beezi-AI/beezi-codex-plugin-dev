import { runPendingHistoryPatiently } from '../lib/pending-history-run.mjs';
import { scanOffers } from '../lib/history-cli.mjs';
import { exitClean } from '../lib/shutdown.mjs';

const WATCHDOG_MS = 30 * 60 * 1000;

let finished = false;
function finish(code) {
  if (finished) return;
  finished = true;
  clearTimeout(watchdog);
  exitClean(code);
}

const watchdog = setTimeout(() => finish(0), WATCHDOG_MS);
process.on('uncaughtException', () => finish(0));
process.on('unhandledRejection', () => finish(0));

const at = process.argv.indexOf('--account');
const key = at === -1 ? null : process.argv[at + 1];
// --offer lists what each workspace would be offered; without it the worker uploads what was accepted.
const work = process.argv.indexOf('--offer') === -1 ? runPendingHistoryPatiently : scanOffers;
(key == null ? Promise.resolve() : work(key)).then(() => finish(0), () => finish(0));
