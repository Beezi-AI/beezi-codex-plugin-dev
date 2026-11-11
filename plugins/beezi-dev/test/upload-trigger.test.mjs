import '../tools/hermetic-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { maybeSpawnUploadWorker, UPLOAD_WORKER_SCRIPT } from '../lib/upload-trigger.mjs';
import { runUploadWorker, writeUploadStatus, workerExitStatus, UPLOAD_STEPS } from '../lib/upload-worker.mjs';
import { markUploadDue } from '../lib/upload-due.mjs';
import { acquireLock, runLock, forgetHeldLocks } from '../lib/single-instance-lock.mjs';
import { makeHome, linkAccount } from '../tools/account-fixtures.mjs';

const T0 = Date.parse('2026-11-05T10:00:00.000Z');
const KEY = 'a1b2c3d4';
const ENV = {}; // BEEZI_TEST_NO_SPAWN unset: the hermetic preload sets it for the whole process
const statusFile = (home) => path.join(home, 'upload-worker.json');
const writeStatus = (home, body) => fs.writeFileSync(statusFile(home), JSON.stringify(body));
const readStatus = (home) => JSON.parse(fs.readFileSync(statusFile(home), 'utf-8'));

const spawnLog = (behaviour) => {
  const calls = [];
  return {
    calls,
    spawnImpl: (exe, args, opts) => {
      calls.push({ exe, args, opts });
      if (behaviour === 'throw') throw new Error('EAGAIN');
      return { unref() {} };
    },
  };
};

// A queued report for KEY whose mtime is `atMs`.
function queueFile(home, name, atMs) {
  const dir = path.join(home, 'accounts', KEY, 'queue');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, '{}');
  fs.utimesSync(file, new Date(atMs), new Date(atMs));
  return file;
}

const world = (t) => {
  const home = makeHome(t, 'upload-trigger-');
  linkAccount(home, KEY);
  return home;
};

test.afterEach(() => forgetHeldLocks());

test('the hermetic preload disables the trigger for every test process', (t) => {
  const home = world(t);
  queueFile(home, 'seg-1.json', T0 - 1000);
  const s = spawnLog();
  assert.equal(maybeSpawnUploadWorker({ now: () => T0, spawnImpl: s.spawnImpl }), 'disabled');
  assert.equal(s.calls.length, 0);
});

test('BEEZI_TEST_NO_SPAWN=1 answers disabled before looking at anything', (t) => {
  world(t);
  const s = spawnLog();
  const hasPostableWork = () => { throw new Error('must not be reached'); };
  assert.equal(maybeSpawnUploadWorker({ env: { BEEZI_TEST_NO_SPAWN: '1' }, hasPostableWork, spawnImpl: s.spawnImpl }), 'disabled');
});

test('a live worker holding the upload lock answers running and spawns nothing', (t) => {
  const home = world(t);
  queueFile(home, 'seg-1.json', T0 - 1000);
  const held = acquireLock(runLock('upload'), { leaseMs: 150000 });
  assert.equal(held.ok, true);
  t.after(() => held.handle.release());
  const s = spawnLog();
  assert.equal(maybeSpawnUploadWorker({ env: ENV, spawnImpl: s.spawnImpl }), 'running');
  assert.equal(s.calls.length, 0);
});

// The gate answers exactly what the lock primitive would: a live lease is a running worker even when
// its pid is gone (a successor could not take it yet anyway), and an expired lease whose pid is gone
// is not.
test('an unexpired upload lease counts as running even when its owner pid is dead', (t) => {
  const home = world(t);
  queueFile(home, 'seg-1.json', Date.now() - 1000);
  const held = acquireLock(runLock('upload'), { leaseMs: 150000 }, { pid: () => 424242 });
  assert.equal(held.ok, true);
  forgetHeldLocks();
  const s = spawnLog();
  const isProcessAlive = (pid) => (pid === 424242 ? false : true);
  assert.equal(maybeSpawnUploadWorker({ env: ENV, spawnImpl: s.spawnImpl, isProcessAlive }), 'running');
  assert.equal(s.calls.length, 0);
});

test('an expired upload lease whose owner pid is dead does not count as running', (t) => {
  const home = world(t);
  queueFile(home, 'seg-1.json', Date.now() - 1000);
  // A worker killed with its Job Object more than a lease ago: the lock file is still there.
  const held = acquireLock(runLock('upload'), { leaseMs: 150000 }, { pid: () => 424242, now: () => Date.now() - 200000 });
  assert.equal(held.ok, true);
  forgetHeldLocks();
  const s = spawnLog();
  const isProcessAlive = (pid) => (pid === 424242 ? false : true);
  assert.equal(maybeSpawnUploadWorker({ env: ENV, spawnImpl: s.spawnImpl, isProcessAlive }), 'spawned');
});

test('an expired upload lease whose owner is still alive is within its grace and counts as running', (t) => {
  const home = world(t);
  queueFile(home, 'seg-1.json', Date.now() - 1000);
  const held = acquireLock(runLock('upload'), { leaseMs: 150000 }, { pid: () => 424242, now: () => Date.now() - 200000 });
  assert.equal(held.ok, true);
  forgetHeldLocks();
  const s = spawnLog();
  assert.equal(maybeSpawnUploadWorker({ env: ENV, spawnImpl: s.spawnImpl, isProcessAlive: () => true }), 'running');
});

test('a backoff in the future answers stalled', (t) => {
  const home = world(t);
  queueFile(home, 'seg-1.json', T0 - 1000);
  writeStatus(home, { retryAfterAt: T0 + 1, lastRunAt: T0 - 60000 });
  const s = spawnLog();
  assert.equal(maybeSpawnUploadWorker({ env: ENV, now: () => T0, spawnImpl: s.spawnImpl }), 'stalled');
  assert.equal(s.calls.length, 0);
});

test('a backoff that has passed no longer stalls', (t) => {
  const home = world(t);
  queueFile(home, 'seg-1.json', T0 - 1000);
  writeStatus(home, { retryAfterAt: T0, lastRunAt: T0 - 60000 });
  const s = spawnLog();
  assert.equal(maybeSpawnUploadWorker({ env: ENV, now: () => T0, spawnImpl: s.spawnImpl }), 'spawned');
});

test('a spawn under 30 s ago with no run finished since answers throttled', (t) => {
  const home = world(t);
  queueFile(home, 'seg-1.json', T0 - 1000);
  writeStatus(home, { attemptedAt: T0 - 29999, lastRunAt: T0 - 60000 });
  const s = spawnLog();
  assert.equal(maybeSpawnUploadWorker({ env: ENV, now: () => T0, spawnImpl: s.spawnImpl }), 'throttled');
  assert.equal(s.calls.length, 0);
});

test('a spawn 30 s ago is no longer throttled', (t) => {
  const home = world(t);
  queueFile(home, 'seg-1.json', T0 - 1000);
  writeStatus(home, { attemptedAt: T0 - 30000, lastRunAt: T0 - 60000 });
  const s = spawnLog();
  assert.equal(maybeSpawnUploadWorker({ env: ENV, now: () => T0, spawnImpl: s.spawnImpl }), 'spawned');
});

test('a recent spawn whose run already finished does not throttle', (t) => {
  const home = world(t);
  queueFile(home, 'seg-1.json', T0 - 1000);
  writeStatus(home, { attemptedAt: T0 - 10000, lastRunAt: T0 - 5000 });
  const s = spawnLog();
  assert.equal(maybeSpawnUploadWorker({ env: ENV, now: () => T0, spawnImpl: s.spawnImpl }), 'spawned');
});

test('no queue file and no due marker answers empty', (t) => {
  world(t);
  const s = spawnLog();
  assert.equal(maybeSpawnUploadWorker({ env: ENV, now: () => T0, spawnImpl: s.spawnImpl }), 'empty');
  assert.equal(s.calls.length, 0);
});

test('queue files no newer than the last run, temp writes and held ask files answer empty', (t) => {
  const home = world(t);
  writeStatus(home, { lastRunAt: T0 - 5000 });
  queueFile(home, 'seg-old.json', T0 - 5000);
  queueFile(home, 'seg-new.json.4242.tmp', T0 - 1000);
  queueFile(home, 'seg-new.json.corrupt', T0 - 1000);
  queueFile(home, 'seg-new__ask.qjson', T0 - 1000);
  queueFile(home, 'seg-new__ask.json', T0 - 1000);
  const s = spawnLog();
  assert.equal(maybeSpawnUploadWorker({ env: ENV, now: () => T0, spawnImpl: s.spawnImpl }), 'empty');
});

test('a queued report newer than the last run spawns the worker and stamps attemptedAt', (t) => {
  const home = world(t);
  writeStatus(home, { lastRunAt: T0 - 5000, outcome: 'empty', version: 1 });
  queueFile(home, 'seg-new.json', T0 - 4999);
  const s = spawnLog();
  assert.equal(maybeSpawnUploadWorker({ env: ENV, now: () => T0, spawnImpl: s.spawnImpl }), 'spawned');
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].exe, process.execPath);
  assert.deepEqual(s.calls[0].args, [UPLOAD_WORKER_SCRIPT]);
  assert.deepEqual(s.calls[0].opts, { detached: true, stdio: 'ignore', windowsHide: true });
  assert.deepEqual(readStatus(home), { lastRunAt: 1793872795000, outcome: 'empty', version: 1, attemptedAt: 1793872800000 });
});

test('a workspace envelope newer than the last run spawns the worker', (t) => {
  const home = world(t);
  queueFile(home, 'seg-1__t-1.qjson', T0 - 1000);
  const s = spawnLog();
  assert.equal(maybeSpawnUploadWorker({ env: ENV, now: () => T0, spawnImpl: s.spawnImpl }), 'spawned');
});

test('a due marker spawns the worker even with an empty queue', (t) => {
  world(t);
  markUploadDue('s-1', { timeline: true }, { now: () => T0 - 60000 });
  const s = spawnLog();
  assert.equal(maybeSpawnUploadWorker({ env: ENV, now: () => T0, spawnImpl: s.spawnImpl }), 'spawned');
});

test('a due marker no newer than the last run does not start a worker on its own', (t) => {
  // An earlier run kept it (its only missing sender had no token): a hook must not respawn a worker
  // for it every turn. The session's next mark moves markedAt and starts one.
  // The scan compares the marker FILE's mtime (its last mark) and parses nothing, so the test pins
  // the mtime on the test clock.
  const home = world(t);
  const marker = path.join(home, 'upload-due', 's-1.json');
  markUploadDue('s-1', { timeline: true }, { now: () => T0 - 60000 });
  fs.utimesSync(marker, new Date(T0 - 60000), new Date(T0 - 60000));
  writeStatus(home, { lastRunAt: T0 - 60000 });
  const s = spawnLog();
  assert.equal(maybeSpawnUploadWorker({ env: ENV, now: () => T0, spawnImpl: s.spawnImpl }), 'empty');
  markUploadDue('s-1', {}, { now: () => T0 - 1000 });
  fs.utimesSync(marker, new Date(T0 - 1000), new Date(T0 - 1000));
  assert.equal(maybeSpawnUploadWorker({ env: ENV, now: () => T0, spawnImpl: s.spawnImpl }), 'spawned');
});

// ── Work a run left behind ──────────────────────────────────────────────────────────────────
// Every worker exit advances lastRunAt, the trigger's queue-file cutoff. A run that stopped with
// reports still owed leaves them OLDER than its own lastRunAt, so the scan alone would never start
// another worker for them; the exit's `pendingWork` flag does.

// One real worker run (real status file, fake lock, the real work scan over the test's own queue)
// driven by `over`, attempted at T0.
async function workerRun(over) {
  let t = T0;
  const now = () => t;
  now.add = (ms) => { t += ms; };
  const handle = { renew: () => ({ ok: true }), release: () => ({ ok: true }) };
  writeUploadStatus({ attemptedAt: T0 });
  const deps = {
    now,
    deadline: T0 + 270000,
    pid: () => 4242,
    acquireLock: () => ({ ok: true, handle }),
    setPriority: () => {},
    sleep: async () => {},
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => {},
    checkEnvironment: () => ({ status: 'ok' }),
    linkedSessions: async () => [{ key: KEY, token: 'tok', clientId: 'c', tenantId: null }],
    ...over(now),
  };
  return runUploadWorker(deps);
}

test('a run cut by its deadline with a report unsent starts the next worker once the throttle allows', async (t) => {
  const home = world(t);
  queueFile(home, 'seg-1.json', T0 - 1000);
  // Each pass sends something and leaves the report owed, until the deadline ends the run.
  const out = await workerRun((now) => ({ steps: [{ name: 'queue', run() { now.add(100000); return { progress: 1, remaining: 1 }; } }] }));
  assert.equal(out.outcome, 'deadline');
  assert.equal(readStatus(home).lastRunAt, 1793873100000);
  const s = spawnLog();
  assert.equal(maybeSpawnUploadWorker({ env: ENV, now: () => T0 + 301000, spawnImpl: s.spawnImpl }), 'spawned');
  assert.equal(s.calls.length, 1);
});

test('a crashed run starts the next worker once its backoff has passed, not before', async (t) => {
  const home = world(t);
  queueFile(home, 'seg-1.json', T0 - 1000);
  const out = await workerRun(() => ({ checkEnvironment: () => { throw new Error('boom'); } }));
  assert.equal(out.outcome, 'crash');
  assert.equal(readStatus(home).retryAfterAt, 1793873100000);
  const s = spawnLog();
  assert.equal(maybeSpawnUploadWorker({ env: ENV, now: () => 1793873099999, spawnImpl: s.spawnImpl }), 'stalled');
  assert.equal(maybeSpawnUploadWorker({ env: ENV, now: () => 1793873100000, spawnImpl: s.spawnImpl }), 'spawned');
  assert.equal(s.calls.length, 1);
});

test('a watchdog exit recorded by the entry point starts the next worker once its backoff has passed', (t) => {
  const home = world(t);
  queueFile(home, 'seg-1.json', T0 - 1000);
  writeUploadStatus(workerExitStatus('watchdog', T0));
  const s = spawnLog();
  assert.equal(maybeSpawnUploadWorker({ env: ENV, now: () => T0 + 299999, spawnImpl: s.spawnImpl }), 'stalled');
  assert.equal(maybeSpawnUploadWorker({ env: ENV, now: () => T0 + 300000, spawnImpl: s.spawnImpl }), 'spawned');
});

test('a clean empty run after an unfinished one clears the flag, so old leftovers start nothing', async (t) => {
  const home = world(t);
  queueFile(home, 'seg-1.json', T0 - 1000);
  writeUploadStatus(workerExitStatus('deadline', T0 - 60000));
  // A route the server lacks: the file stays, but no retry inside a run could send it.
  const out = await workerRun(() => ({ steps: [{ name: 'queue', run: () => ({ progress: 0, remaining: 0 }) }] }));
  assert.equal(out.outcome, 'empty');
  assert.equal(readStatus(home).pendingWork, false);
  const s = spawnLog();
  assert.equal(maybeSpawnUploadWorker({ env: ENV, now: () => T0 + 60000, spawnImpl: s.spawnImpl }), 'empty');
  assert.equal(s.calls.length, 0);
});

// A machine whose linked account cannot sign in: every run exits no-accounts. Only work actually on
// disk at exit keeps the flag — an empty root must not restart a worker after every backoff forever.
const noAccounts = () => ({ linkedSessions: async () => [{ key: KEY, token: null, clientId: 'c', tenantId: null }] });

test('no-accounts runs with nothing queued owe nothing, so the trigger stays quiet after the backoff', async (t) => {
  const home = world(t);
  assert.equal((await workerRun(noAccounts)).outcome, 'no-accounts');
  assert.equal((await workerRun(noAccounts)).outcome, 'no-accounts');
  assert.equal(readStatus(home).pendingWork, false);
  assert.equal(readStatus(home).retryAfterAt, 1793873100000);
  const s = spawnLog();
  assert.equal(maybeSpawnUploadWorker({ env: ENV, now: () => 1793873099999, spawnImpl: s.spawnImpl }), 'stalled');
  assert.equal(maybeSpawnUploadWorker({ env: ENV, now: () => 1793873100000, spawnImpl: s.spawnImpl }), 'empty');
  assert.equal(s.calls.length, 0);
});

test('a no-accounts run with a report queued owes it, so the trigger starts a worker after the backoff', async (t) => {
  const home = world(t);
  queueFile(home, 'seg-1.json', T0 - 1000);
  assert.equal((await workerRun(noAccounts)).outcome, 'no-accounts');
  assert.equal(readStatus(home).pendingWork, true);
  const s = spawnLog();
  assert.equal(maybeSpawnUploadWorker({ env: ENV, now: () => 1793873099999, spawnImpl: s.spawnImpl }), 'stalled');
  assert.equal(maybeSpawnUploadWorker({ env: ENV, now: () => 1793873100000, spawnImpl: s.spawnImpl }), 'spawned');
  assert.equal(s.calls.length, 1);
});

test('a no-accounts run with a session marked due owes it, so the trigger starts a worker after the backoff', async (t) => {
  const home = world(t);
  markUploadDue('s-1', {}, { now: () => T0 - 1000 });
  assert.equal((await workerRun(noAccounts)).outcome, 'no-accounts');
  assert.equal(readStatus(home).pendingWork, true);
  const s = spawnLog();
  assert.equal(maybeSpawnUploadWorker({ env: ENV, now: () => 1793873100000, spawnImpl: s.spawnImpl }), 'spawned');
});

// A rate-limit snapshot is owed work too: it lives in the account's usage-pending.json, not in the
// queue directory, and a run that could not send it must leave the flag that starts the next one.
function usagePending(home, rows, atMs) {
  const file = path.join(home, 'accounts', KEY, 'usage-pending.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, pending: rows }));
  fs.utimesSync(file, new Date(atMs), new Date(atMs));
  return file;
}

const SNAPSHOT = { fetched_at: '2026-11-05T09:59:00.000Z', limit_id: 'codex', five_hour_used_percent: 42 };
const rateLimitsOnly = () => ({
  steps: UPLOAD_STEPS.filter((s) => s.name === 'rate-limits'),
  fetchImpl: async () => { throw new Error('ECONNRESET'); },
});

test('a rate-limit snapshot the run could not send keeps pendingWork, so the trigger starts a worker after the backoff', async (t) => {
  const home = world(t);
  usagePending(home, [SNAPSHOT], T0 - 1000);
  const out = await workerRun(rateLimitsOnly);
  assert.equal(out.outcome, 'stalled');
  assert.equal(readStatus(home).pendingWork, true);
  const s = spawnLog();
  assert.equal(maybeSpawnUploadWorker({ env: ENV, now: () => 1793873099999, spawnImpl: s.spawnImpl }), 'stalled');
  assert.equal(maybeSpawnUploadWorker({ env: ENV, now: () => 1793873100000, spawnImpl: s.spawnImpl }), 'spawned');
  assert.equal(s.calls.length, 1);
});

test('a snapshot newer than the last run starts a worker; an emptied or older usage-pending file does not', (t) => {
  const home = world(t);
  writeStatus(home, { lastRunAt: T0 - 5000, outcome: 'empty', version: 1 });
  const s = spawnLog();
  usagePending(home, [], T0 - 1000);
  assert.equal(maybeSpawnUploadWorker({ env: ENV, now: () => T0, spawnImpl: s.spawnImpl }), 'empty');
  usagePending(home, [SNAPSHOT], T0 - 5000);
  assert.equal(maybeSpawnUploadWorker({ env: ENV, now: () => T0, spawnImpl: s.spawnImpl }), 'empty');
  usagePending(home, [SNAPSHOT], T0 - 4999);
  assert.equal(maybeSpawnUploadWorker({ env: ENV, now: () => T0, spawnImpl: s.spawnImpl }), 'spawned');
  assert.equal(s.calls.length, 1);
});

test('a malformed usage-pending file is no work: the drain could not read a row from it either', (t) => {
  const home = world(t);
  const file = usagePending(home, [], T0 - 1000);
  fs.writeFileSync(file, '{"torn');
  const s = spawnLog();
  assert.equal(maybeSpawnUploadWorker({ env: ENV, now: () => T0, spawnImpl: s.spawnImpl }), 'empty');
});

// ── A queue the scan cannot read ────────────────────────────────────────────────────────────
// Absent (ENOENT) is no work. Any other read error is inconclusive and counts as work: at exit it
// keeps pendingWork, and on the hook path it starts a worker only behind the backoff and throttle.
// chmod cannot make a directory unreadable on Windows, so the error is injected at fs.
const queuePath = (home) => path.join(home, 'accounts', KEY, 'queue');

function denyQueue(t, home, fn = 'readdirSync', target = queuePath(home)) {
  const real = fs[fn];
  return t.mock.method(fs, fn, function (p, ...rest) {
    if (path.resolve(String(p)) === path.resolve(target)) {
      throw Object.assign(new Error(`EACCES: permission denied, ${fn} '${p}'`), { code: 'EACCES' });
    }
    return real.call(this, p, ...rest);
  });
}

test('a queue unreadable during the exit scan keeps pendingWork, so the report is retried once it is readable', async (t) => {
  const home = world(t);
  queueFile(home, 'seg-1.json', T0 - 1000);
  let denied = null;
  // The pass sends something, then the deadline passes and the queue turns unreadable for the exit scan.
  const out = await workerRun((now) => ({ steps: [{ name: 'queue', run() {
    now.add(300000);
    denied = denyQueue(t, home);
    return { progress: 1, remaining: 1 };
  } }] }));
  denied.mock.restore();
  assert.equal(out.outcome, 'deadline');
  assert.equal(readStatus(home).pendingWork, true);
  const s = spawnLog();
  assert.equal(maybeSpawnUploadWorker({ env: ENV, now: () => T0 + 301000, spawnImpl: s.spawnImpl }), 'spawned');
  assert.equal(s.calls.length, 1);
});

test('a missing queue directory at exit is no work: pendingWork stays false', async (t) => {
  const home = world(t);
  const out = await workerRun((now) => ({ steps: [{ name: 'queue', run() { now.add(300000); return { progress: 1, remaining: 1 }; } }] }));
  assert.equal(out.outcome, 'deadline');
  assert.equal(fs.existsSync(queuePath(home)), false);
  assert.equal(readStatus(home).pendingWork, false);
});

test('a queue unreadable for the whole run never ends it empty: it stalls and backs off', async (t) => {
  const home = world(t);
  queueFile(home, 'seg-1.json', T0 - 1000);
  denyQueue(t, home);
  const out = await workerRun(() => ({ steps: [{ name: 'queue', run: () => ({ progress: 0, remaining: 0 }) }] }));
  assert.equal(out.outcome, 'stalled');
  assert.equal(readStatus(home).pendingWork, true);
  assert.equal(readStatus(home).retryAfterAt, 1793873100000);
});

test('on the hook path an unreadable queue starts a worker only behind the throttle and the backoff', (t) => {
  const home = world(t);
  queueFile(home, 'seg-1.json', T0 - 1000);
  denyQueue(t, home);
  const s = spawnLog();
  writeStatus(home, { lastRunAt: T0 - 500, attemptedAt: T0 - 1000, retryAfterAt: T0 + 1 });
  assert.equal(maybeSpawnUploadWorker({ env: ENV, now: () => T0, spawnImpl: s.spawnImpl }), 'stalled');
  writeStatus(home, { lastRunAt: T0 - 60000, attemptedAt: T0 - 1000 });
  assert.equal(maybeSpawnUploadWorker({ env: ENV, now: () => T0, spawnImpl: s.spawnImpl }), 'throttled');
  writeStatus(home, { lastRunAt: T0 - 500 });
  assert.equal(maybeSpawnUploadWorker({ env: ENV, now: () => T0, spawnImpl: s.spawnImpl }), 'spawned');
  assert.equal(s.calls.length, 1);
});

test('an unreadable usage-pending file counts as work; a missing one does not', (t) => {
  const home = world(t);
  writeStatus(home, { lastRunAt: T0 - 5000 });
  const s = spawnLog();
  assert.equal(maybeSpawnUploadWorker({ env: ENV, now: () => T0, spawnImpl: s.spawnImpl }), 'empty');
  denyQueue(t, home, 'statSync', path.join(home, 'accounts', KEY, 'usage-pending.json'));
  assert.equal(maybeSpawnUploadWorker({ env: ENV, now: () => T0, spawnImpl: s.spawnImpl }), 'spawned');
});

test('the worker script path names scripts/upload-worker.mjs', () => {
  assert.equal(path.basename(UPLOAD_WORKER_SCRIPT), 'upload-worker.mjs');
  assert.equal(path.basename(path.dirname(UPLOAD_WORKER_SCRIPT)), 'scripts');
  assert.equal(fs.existsSync(UPLOAD_WORKER_SCRIPT), true);
});

test('a spawn that throws answers failed and keeps the attempt stamp', (t) => {
  const home = world(t);
  queueFile(home, 'seg-1.json', T0 - 1000);
  const s = spawnLog('throw');
  assert.equal(maybeSpawnUploadWorker({ env: ENV, now: () => T0, spawnImpl: s.spawnImpl }), 'failed');
  assert.equal(readStatus(home).attemptedAt, 1793872800000);
});

test('an unreadable status file is read as no status at all', (t) => {
  const home = world(t);
  fs.writeFileSync(statusFile(home), '{"torn');
  queueFile(home, 'seg-1.json', T0 - 1000);
  const s = spawnLog();
  assert.equal(maybeSpawnUploadWorker({ env: ENV, now: () => T0, spawnImpl: s.spawnImpl }), 'spawned');
});

test('anything that throws inside the gate answers failed rather than escaping', (t) => {
  world(t);
  const hasPostableWork = () => { throw new Error('EIO'); };
  assert.equal(maybeSpawnUploadWorker({ env: ENV, now: () => T0, hasPostableWork }), 'failed');
});

// The checkpoint imports this gate, so a static edge from the gate back to checkpoint code would be
// a cycle. (Credential reads and network calls need no graph test: a credential read spawns the
// keyring helper and a post calls fetch, and the hermetic preload fails this whole file on either.)
test('the gate statically imports no checkpoint or upload code, so the checkpoint can import it', () => {
  const libDir = path.join(path.dirname(UPLOAD_WORKER_SCRIPT), '..', 'lib');
  const graph = new Set();
  (function walk(file) {
    if (graph.has(file)) return;
    graph.add(file);
    const source = fs.readFileSync(file, 'utf-8');
    // Spans multi-line `import {\n a,\n} from './x.mjs'`; stops at the first quote, so a bare
    // `import fs from 'fs'` never matches. Dynamic `await import()` is deliberately not followed.
    const pattern = /^import[^']*?from\s+'(\.[^']+)'/gm;
    let match = pattern.exec(source);
    while (match) {
      walk(path.resolve(path.dirname(file), match[1]));
      match = pattern.exec(source);
    }
  }(path.join(libDir, 'upload-trigger.mjs')));
  const names = [...graph].map((f) => path.basename(f));
  for (const banned of ['checkpoint.mjs', 'queue-flush.mjs', 'usage-report-codex.mjs', 'session-start.mjs']) {
    assert.equal(names.indexOf(banned), -1, `${banned} is on the trigger's static import graph`);
  }
  assert.ok(names.indexOf('upload-worker.mjs') !== -1, 'the walk must reach the status helpers');
});
