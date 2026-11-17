import '../tools/hermetic-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  runUploadWorker, UPLOAD_STEPS, registerUploadStep, registerDueHandler, readUploadStatus, writeUploadStatus as writeUploadStatusForTest,
  workerExitStatus, workerWillRetry,
} from '../lib/upload-worker.mjs';
import { markUploadDue, listUploadDue, parkUploadDue } from '../lib/upload-due.mjs';
import { runCheckpoint as realRunCheckpoint } from '../lib/checkpoint.mjs';
import { forgetHeldLocks, inspectLock, runLock } from '../lib/single-instance-lock.mjs';
import { makeHome, linkAccount, credentialBlob } from '../tools/account-fixtures.mjs';

const T0 = Date.parse('2026-11-05T10:00:00.000Z'); // 1793872800000
const KEY_A = 'aaaa1111';
const KEY_B = 'bbbb2222';
const session = (key, over = {}) => ({ key, token: `tok-${key}`, clientId: `c-${key}`, tenantId: null, ...over });

test.afterEach(() => forgetHeldLocks());

// A clock the test moves; `tick` advances it by `ms` on every read when set.
function clock(start = T0) {
  let t = start;
  const now = () => t;
  now.set = (v) => { t = v; };
  now.add = (ms) => { t += ms; };
  return now;
}

// A fake upload-lock handle that records what the worker did with it.
function fakeLock(renewResult = { ok: true }) {
  const log = { released: 0, renewed: [], acquired: 0 };
  const handle = {
    renew(opts) { log.renewed.push(opts); return renewResult; },
    release() { log.released += 1; return { ok: true }; },
  };
  const acquireLock = (target, options) => {
    log.acquired += 1;
    log.target = target.name;
    log.options = options;
    return { ok: true, handle };
  };
  return { log, handle, acquireLock };
}

// A step that answers from a script of results, one per pass, and records each ctx it saw.
function scriptedStep(name, results) {
  const seen = [];
  let i = 0;
  return {
    seen,
    step: {
      name,
      run(ctx) {
        seen.push(ctx);
        const r = results[Math.min(i, results.length - 1)];
        i += 1;
        if (r instanceof Error) throw r;
        return typeof r === 'function' ? r(ctx) : r;
      },
    },
  };
}

// The baseline deps every outcome test starts from: a linked account, an ok guard, no new work.
function baseDeps(over = {}) {
  const lock = fakeLock();
  const sleeps = [];
  const intervals = [];
  const deps = {
    now: clock(),
    deadline: T0 + 270000,
    pid: () => 4242,
    acquireLock: lock.acquireLock,
    setPriority: () => {},
    sleep: async (ms) => { sleeps.push(ms); },
    setIntervalImpl: (fn, ms) => { const h = { fn, ms, cleared: false, unref() {} }; intervals.push(h); return h; },
    clearIntervalImpl: (h) => { h.cleared = true; },
    checkEnvironment: () => ({ status: 'ok' }),
    linkedSessions: async () => [session(KEY_A)],
    hasPostableWork: () => false,
    steps: [scriptedStep('only', [{ progress: 0, remaining: 0 }]).step],
    ...over,
  };
  return { deps, lock, sleeps, intervals };
}

// ── lock, guard and accounts ────────────────────────────────────────────────────────────────

test('a refused upload lock exits busy and leaves the status untouched', async (t) => {
  const home = makeHome(t, 'upload-worker-');
  let listed = 0;
  const { deps } = baseDeps({
    acquireLock: () => ({ ok: false, reason: 'held', holder: null }),
    linkedSessions: async () => { listed += 1; return [session(KEY_A)]; },
  });
  assert.deepEqual(await runUploadWorker(deps), { outcome: 'busy', passes: 0, progress: 0 });
  assert.equal(fs.existsSync(path.join(home, 'upload-worker.json')), false);
  assert.equal(listed, 0);
});

test('the worker takes runLock(upload) with a 150 s lease and drops to below-normal priority', async (t) => {
  makeHome(t, 'upload-worker-');
  const priorities = [];
  const { deps, lock } = baseDeps({ setPriority: (pid, prio) => priorities.push([pid, prio]) });
  await runUploadWorker(deps);
  assert.equal(lock.log.target, 'run-upload');
  assert.deepEqual(lock.log.options, { leaseMs: 150000 });
  assert.deepEqual(priorities, [[0, 10]]);
});

// Nothing queued and nothing due (the scan answers false): the backoff stands, but no work is owed.
test('a blocked environment ends tracking-disabled with a 5 minute backoff and no account read', async (t) => {
  makeHome(t, 'upload-worker-');
  let listed = 0;
  const { deps, lock } = baseDeps({
    checkEnvironment: () => ({ status: 'blocked', reason: 'unbound' }),
    linkedSessions: async () => { listed += 1; return [session(KEY_A)]; },
  });
  assert.deepEqual(await runUploadWorker(deps), { outcome: 'tracking-disabled', passes: 0, progress: 0 });
  assert.equal(listed, 0);
  assert.equal(lock.log.released, 1);
  assert.deepEqual(readUploadStatus(), {
    state: 'idle', pid: 4242, startedAt: 1793872800000, lastRunAt: 1793872800000,
    outcome: 'tracking-disabled', retryAfterAt: 1793873100000, pendingWork: false, version: 1,
  });
});

test('a migrated environment is a go', async (t) => {
  makeHome(t, 'upload-worker-');
  const { deps } = baseDeps({ checkEnvironment: () => ({ status: 'migrated', message: 'moved' }) });
  assert.equal((await runUploadWorker(deps)).outcome, 'empty');
});

test('no account with a token ends no-accounts with a backoff', async (t) => {
  makeHome(t, 'upload-worker-');
  const { deps, lock } = baseDeps({ linkedSessions: async () => [session(KEY_A, { token: null })] });
  assert.deepEqual(await runUploadWorker(deps), { outcome: 'no-accounts', passes: 0, progress: 0 });
  assert.equal(lock.log.released, 1);
  const status = readUploadStatus();
  assert.equal(status.outcome, 'no-accounts');
  assert.equal(status.retryAfterAt, 1793873100000);
});

test('a throw outside the steps ends crash with a backoff and still releases the lock', async (t) => {
  makeHome(t, 'upload-worker-');
  const { deps, lock } = baseDeps({ checkEnvironment: () => { throw new Error('boom'); } });
  assert.equal((await runUploadWorker(deps)).outcome, 'crash');
  assert.equal(lock.log.released, 1);
  const status = readUploadStatus();
  assert.equal(status.state, 'idle');
  assert.equal(status.outcome, 'crash');
  assert.equal(status.retryAfterAt, 1793873100000);
});

// ── passes and outcomes ─────────────────────────────────────────────────────────────────────

test('a run with nothing to do ends empty, records lastRunAt and sets no backoff', async (t) => {
  makeHome(t, 'upload-worker-');
  const { deps, lock } = baseDeps();
  assert.deepEqual(await runUploadWorker(deps), { outcome: 'empty', passes: 1, progress: 0 });
  assert.equal(lock.log.released, 1);
  assert.deepEqual(readUploadStatus(), {
    state: 'idle', pid: 4242, startedAt: 1793872800000, lastRunAt: 1793872800000,
    outcome: 'empty', retryAfterAt: null, pendingWork: false, version: 1,
  });
});

test('the status says running, with pid and start, while the steps run', async (t) => {
  makeHome(t, 'upload-worker-');
  let during = null;
  const step = { name: 'peek', run() { during = readUploadStatus(); return { progress: 0, remaining: 0 }; } };
  const { deps } = baseDeps({ steps: [step] });
  await runUploadWorker(deps);
  assert.deepEqual(during, { state: 'running', pid: 4242, startedAt: 1793872800000, version: 1 });
});

test('passes repeat while they make progress and stop at the first that makes none', async (t) => {
  makeHome(t, 'upload-worker-');
  const s = scriptedStep('queue', [{ progress: 2, remaining: 1 }, { progress: 1, remaining: 0 }, { progress: 0, remaining: 0 }]);
  const { deps, sleeps } = baseDeps({ steps: [s.step] });
  assert.deepEqual(await runUploadWorker(deps), { outcome: 'empty', passes: 3, progress: 3 });
  assert.deepEqual(sleeps, []);
});

test('work that appeared during the last pass keeps the run going instead of exiting empty', async (t) => {
  makeHome(t, 'upload-worker-');
  const scans = [];
  const answers = [true, false];
  const s = scriptedStep('queue', [{ progress: 0, remaining: 0 }, { progress: 1, remaining: 0 }, { progress: 0, remaining: 0 }]);
  const now = clock();
  const { deps } = baseDeps({
    now,
    steps: [s.step],
    hasPostableWork: (since) => { scans.push(since); return answers.length ? answers.shift() : false; },
  });
  const out = await runUploadWorker(deps);
  assert.equal(out.outcome, 'empty');
  assert.equal(out.passes, 3);
  // Each re-scan looks for work newer than the start of the pass that just ran.
  assert.deepEqual(scans.slice(0, 2), [1793872800000, 1793872800000]);
});

test('three passes that move nothing with work left end stalled, 5 s apart, with a backoff', async (t) => {
  makeHome(t, 'upload-worker-');
  const s = scriptedStep('queue', [{ progress: 0, remaining: 4 }]);
  const { deps, sleeps } = baseDeps({ steps: [s.step] });
  assert.deepEqual(await runUploadWorker(deps), { outcome: 'stalled', passes: 3, progress: 0 });
  assert.deepEqual(sleeps, [5000, 5000]);
  const status = readUploadStatus();
  assert.equal(status.outcome, 'stalled');
  assert.equal(status.retryAfterAt, 1793873100000);
});

test('a pass that makes progress resets the stall count', async (t) => {
  makeHome(t, 'upload-worker-');
  const idle = { progress: 0, remaining: 1 };
  const s = scriptedStep('queue', [idle, idle, { progress: 1, remaining: 1 }, idle, idle, idle]);
  const { deps, sleeps } = baseDeps({ steps: [s.step] });
  assert.deepEqual(await runUploadWorker(deps), { outcome: 'stalled', passes: 6, progress: 1 });
  assert.deepEqual(sleeps, [5000, 5000, 5000, 5000]);
});

test('a step that throws counts as work left, not as a crash', async (t) => {
  makeHome(t, 'upload-worker-');
  const bad = scriptedStep('bad', [new Error('EIO')]);
  const good = scriptedStep('good', [{ progress: 0, remaining: 0 }]);
  const { deps } = baseDeps({ steps: [bad.step, good.step] });
  assert.equal((await runUploadWorker(deps)).outcome, 'stalled');
  assert.equal(good.seen.length, 3, 'the steps after a throwing one still run');
});

test('the deadline ends the run before a pass would start past it', async (t) => {
  makeHome(t, 'upload-worker-');
  const now = clock();
  const s = scriptedStep('queue', [() => { now.add(100000); return { progress: 1, remaining: 5 }; }]);
  const { deps } = baseDeps({ now, deadline: T0 + 250000, steps: [s.step] });
  assert.deepEqual(await runUploadWorker(deps), { outcome: 'deadline', passes: 3, progress: 3 });
  const status = readUploadStatus();
  assert.equal(status.outcome, 'deadline');
  assert.equal(status.retryAfterAt, null);
  assert.equal(status.lastRunAt, 1793873100000);
});

test('a deadline reached without any progress is a stall', async (t) => {
  makeHome(t, 'upload-worker-');
  const now = clock();
  const s = scriptedStep('queue', [() => { now.add(200000); return { progress: 0, remaining: 5 }; }]);
  const { deps } = baseDeps({ now, deadline: T0 + 250000, steps: [s.step] });
  assert.equal((await runUploadWorker(deps)).outcome, 'stalled');
  assert.equal(readUploadStatus().retryAfterAt, 1793873500000);
});

test('a deadline already past before the first pass is a stall, so the trigger backs off', async (t) => {
  makeHome(t, 'upload-worker-');
  const s = scriptedStep('queue', [{ progress: 1, remaining: 0 }]);
  const { deps } = baseDeps({ deadline: T0, steps: [s.step] });
  assert.deepEqual(await runUploadWorker(deps), { outcome: 'stalled', passes: 0, progress: 0 });
  assert.equal(s.seen.length, 0);
  assert.equal(readUploadStatus().retryAfterAt, 1793873100000);
});

// The exit record every run, crash and watchdog writes: work is owed only when the exit was not a
// clean `empty` AND a queue file or due marker is still on disk at exit (the scan, asked from 0);
// every exit that owes something without having made progress carries a 5-minute backoff.
const EXIT_CASES = [
  ['empty', true, null, false],
  ['empty', false, null, false],
  ['deadline', true, null, true],
  ['deadline', false, null, false],
  ['lock-lost', true, null, true],
  ['lock-lost', false, null, false],
  ['stalled', true, 1793873100000, true],
  ['stalled', false, 1793873100000, false],
  ['crash', true, 1793873100000, true],
  ['crash', false, 1793873100000, false],
  ['watchdog', true, 1793873100000, true],
  ['watchdog', false, 1793873100000, false],
  ['no-accounts', true, 1793873100000, true],
  ['no-accounts', false, 1793873100000, false],
  ['tracking-disabled', true, 1793873100000, true],
  ['tracking-disabled', false, 1793873100000, false],
];
for (const [outcome, workLeft, retryAfterAt, pendingWork] of EXIT_CASES) {
  test(`a ${outcome} exit with${workLeft ? '' : ' no'} work left records retryAfterAt ${retryAfterAt} and pendingWork ${pendingWork}`, () => {
    const asked = [];
    const hasWork = (since) => { asked.push(since); return workLeft; };
    assert.deepEqual(workerExitStatus(outcome, T0, hasWork), { state: 'idle', lastRunAt: 1793872800000, outcome, retryAfterAt, pendingWork });
    // The scan is asked for everything on disk, never only what is newer than this run.
    assert.deepEqual(asked, outcome === 'empty' ? [] : [0]);
  });
}

// "Will a worker (re)try this soon": owed work on file, or work newer than the last run. The scan is
// asked from the recorded lastRunAt, or from 0 when there is none.
const RETRY_CASES = [
  ['owed work on file', { lastRunAt: 2000, pendingWork: true }, false, true, []],
  ['nothing owed and nothing newer', { lastRunAt: 2000, pendingWork: false }, false, false, [2000]],
  ['nothing owed but work newer than the last run', { lastRunAt: 2000, pendingWork: false }, true, true, [2000]],
  ['no status recorded', {}, true, true, [0]],
  ['an unreadable status', null, false, false, [0]],
];
for (const [what, status, newer, expected, asked] of RETRY_CASES) {
  test(`workerWillRetry: ${what} answers ${expected}`, () => {
    const seen = [];
    assert.equal(workerWillRetry(status, (since) => { seen.push(since); return newer; }), expected);
    assert.deepEqual(seen, asked);
  });
}

test('an exit whose work scan throws counts the work as owed', () => {
  const hasWork = () => { throw new Error('EACCES'); };
  assert.equal(workerExitStatus('stalled', T0, hasWork).pendingWork, true);
});

test('the default deadline is 270 s after the start', async (t) => {
  makeHome(t, 'upload-worker-');
  const s = scriptedStep('queue', [{ progress: 0, remaining: 0 }]);
  const { deps } = baseDeps({ deadline: undefined, steps: [s.step] });
  await runUploadWorker(deps);
  assert.equal(s.seen[0].deadline, 1793873070000);
});

test('a step reporting a dark workspace ends tracking-disabled with a backoff', async (t) => {
  makeHome(t, 'upload-worker-');
  const s = scriptedStep('queue', [{ progress: 1, remaining: 2, trackingDisabled: true }]);
  const { deps } = baseDeps({ steps: [s.step] });
  assert.deepEqual(await runUploadWorker(deps), { outcome: 'tracking-disabled', passes: 2, progress: 2 });
  assert.equal(readUploadStatus().retryAfterAt, 1793873100000);
});

test('a first dark pass gets one more pass, and a live second pass ends with no back-off', async (t) => {
  makeHome(t, 'upload-worker-');
  const s = scriptedStep('queue', [{ progress: 0, remaining: 0, trackingDisabled: true }, { progress: 0, remaining: 0 }]);
  const { deps } = baseDeps({ steps: [s.step] });
  assert.deepEqual(await runUploadWorker(deps), { outcome: 'empty', passes: 2, progress: 0 });
  assert.equal(readUploadStatus().retryAfterAt, null);
});

test('a pass that left only waiting work keeps the run going without counting it idle', async (t) => {
  makeHome(t, 'upload-worker-');
  const waiting = { progress: 0, remaining: 1, waiting: 1 };
  const s = scriptedStep('queue', [waiting, waiting, waiting, { progress: 1, remaining: 0 }, { progress: 0, remaining: 0 }]);
  const { deps, sleeps } = baseDeps({ steps: [s.step] });
  assert.deepEqual(await runUploadWorker(deps), { outcome: 'empty', passes: 5, progress: 1 });
  assert.deepEqual(sleeps, [5000, 5000, 5000]);
  assert.equal(readUploadStatus().retryAfterAt, null);
});

test('waiting stops counting after 30 s: a lock refused for the whole run ends stalled', async (t) => {
  makeHome(t, 'upload-worker-');
  const s = scriptedStep('queue', [{ progress: 0, remaining: 1, waiting: 1 }]);
  const { deps, sleeps } = baseDeps({ steps: [s.step] });
  assert.deepEqual(await runUploadWorker(deps), { outcome: 'stalled', passes: 9, progress: 0 });
  assert.deepEqual(sleeps, [5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000]);
  assert.equal(readUploadStatus().retryAfterAt, 1793873100000);
});

test('a pass with work left that is not all waiting counts idle as before', async (t) => {
  makeHome(t, 'upload-worker-');
  const s = scriptedStep('queue', [{ progress: 0, remaining: 2, waiting: 1 }]);
  const { deps, sleeps } = baseDeps({ steps: [s.step] });
  assert.deepEqual(await runUploadWorker(deps), { outcome: 'stalled', passes: 3, progress: 0 });
  assert.deepEqual(sleeps, [5000, 5000]);
});

// ── heartbeat ───────────────────────────────────────────────────────────────────────────────

test('the heartbeat renews the lease every 60 s and is cleared when the run ends', async (t) => {
  makeHome(t, 'upload-worker-');
  let beat = null;
  const s = scriptedStep('queue', [{ progress: 0, remaining: 0 }]);
  const { deps, lock, intervals } = baseDeps({ steps: [{ name: 'q', run(ctx) { intervals[0].fn(); return s.step.run(ctx); } }] });
  beat = await runUploadWorker(deps);
  assert.equal(beat.outcome, 'empty');
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].ms, 60000);
  assert.equal(intervals[0].cleared, true);
  assert.deepEqual(lock.log.renewed, [{ leaseMs: 150000 }]);
});

test('a heartbeat that finds the lock taken over ends the run lock-lost', async (t) => {
  makeHome(t, 'upload-worker-');
  const lock = fakeLock({ ok: false, reason: 'lost', holder: null });
  const s = scriptedStep('queue', [{ progress: 1, remaining: 3 }]);
  let firstStepRuns = 0;
  const steps = [
    { name: 'first', run(ctx) { firstStepRuns += 1; intervals[0].fn(); return s.step.run(ctx); } },
    { name: 'second', run() { throw new Error('must not run after the lock is lost'); } },
  ];
  const { deps, intervals } = baseDeps({ acquireLock: lock.acquireLock, steps });
  assert.deepEqual(await runUploadWorker(deps), { outcome: 'lock-lost', passes: 1, progress: 1 });
  assert.equal(firstStepRuns, 1);
  assert.equal(readUploadStatus().outcome, 'lock-lost');
  assert.equal(readUploadStatus().retryAfterAt, null);
});

test('a heartbeat refused only by a busy breaker keeps the lock', async (t) => {
  makeHome(t, 'upload-worker-');
  const lock = fakeLock({ ok: false, reason: 'contended', stage: 'breaker' });
  const s = scriptedStep('queue', [{ progress: 0, remaining: 0 }]);
  const steps = [{ name: 'q', run(ctx) { intervals[0].fn(); return s.step.run(ctx); } }];
  const { deps, intervals } = baseDeps({ acquireLock: lock.acquireLock, steps });
  assert.equal((await runUploadWorker(deps)).outcome, 'empty');
});

// ── the context handed to steps ─────────────────────────────────────────────────────────────

test('steps get the tokened sessions, deadline, clock, fetch, batch flag, status, deps and due list', async (t) => {
  makeHome(t, 'upload-worker-');
  markUploadDue('s-1', { cwd: 'C:/repo', timeline: true }, { now: () => T0 - 1000 });
  const fetchImpl = async () => ({ status: 200 });
  const s = scriptedStep('queue', [{ progress: 0, remaining: 0 }]);
  const { deps } = baseDeps({
    fetchImpl,
    steps: [s.step],
    linkedSessions: async () => [session(KEY_A), session(KEY_B, { token: '' })],
  });
  await runUploadWorker(deps);
  const ctx = s.seen[0];
  assert.deepEqual(ctx.sessions, [session(KEY_A)]);
  assert.equal(ctx.deadline, 1793873070000);
  assert.equal(ctx.now(), 1793872800000);
  assert.equal(ctx.fetchImpl, fetchImpl);
  assert.equal(ctx.batch, true);
  assert.deepEqual(ctx.status, { state: 'running', pid: 4242, startedAt: 1793872800000, version: 1 });
  assert.equal(ctx.deps, deps);
  assert.deepEqual(ctx.due, [
    { sessionId: 's-1', transcriptPath: null, cwd: 'C:/repo', timeline: true, sessionStart: false, markedAt: 1793872799000, attempts: 0, owedKeys: null },
  ]);
});

test('batching starts off while an earlier fallback\'s 24 h window is open', async (t) => {
  const home = makeHome(t, 'upload-worker-');
  fs.writeFileSync(path.join(home, 'upload-worker.json'), JSON.stringify({ batchUnsupportedUntil: T0 + 1 }));
  const s = scriptedStep('queue', [{ progress: 0, remaining: 0 }]);
  const { deps } = baseDeps({ steps: [s.step] });
  await runUploadWorker(deps);
  assert.equal(s.seen[0].batch, false);
});

test('a batch fallback records a 24 h window and turns batching off for the rest of the run', async (t) => {
  makeHome(t, 'upload-worker-');
  const s = scriptedStep('queue', [{ progress: 1, remaining: 0, batchUnsupported: true }, { progress: 0, remaining: 0 }]);
  const { deps } = baseDeps({ steps: [s.step] });
  await runUploadWorker(deps);
  assert.deepEqual(s.seen.map((ctx) => ctx.batch), [true, false]);
  assert.equal(readUploadStatus().batchUnsupportedUntil, 1793959200000);
});

// ── re-acquire ──────────────────────────────────────────────────────────────────────────────

test('work that appears after the release re-acquires the lock once, and only once', async (t) => {
  makeHome(t, 'upload-worker-');
  let listed = 0;
  const answers = [false, true, false, true];
  const s = scriptedStep('queue', [{ progress: 0, remaining: 0 }]);
  const { deps, lock } = baseDeps({
    steps: [s.step],
    linkedSessions: async () => { listed += 1; return [session(KEY_A)]; },
    hasPostableWork: () => answers.shift(),
  });
  assert.deepEqual(await runUploadWorker(deps), { outcome: 'empty', passes: 2, progress: 0 });
  assert.equal(lock.log.acquired, 2);
  assert.equal(lock.log.released, 2);
  assert.equal(listed, 1, 'the accounts are read once per run, not once per lock round');
});

test('no re-acquire when the run did not end empty', async (t) => {
  makeHome(t, 'upload-worker-');
  const s = scriptedStep('queue', [{ progress: 0, remaining: 1 }]);
  const { deps, lock } = baseDeps({ steps: [s.step], hasPostableWork: () => true });
  assert.equal((await runUploadWorker(deps)).outcome, 'stalled');
  assert.equal(lock.log.acquired, 1);
});

test('a re-acquire refused because another worker took over ends quietly', async (t) => {
  makeHome(t, 'upload-worker-');
  const lock = fakeLock();
  let calls = 0;
  const acquireLock = (target, options) => {
    calls += 1;
    return calls === 1 ? lock.acquireLock(target, options) : { ok: false, reason: 'held', holder: null };
  };
  const answers = [false, true];
  const { deps } = baseDeps({ acquireLock, hasPostableWork: () => answers.shift() });
  assert.deepEqual(await runUploadWorker(deps), { outcome: 'empty', passes: 1, progress: 0 });
  assert.equal(calls, 2);
});

test('the real upload lock is free again after a run', async (t) => {
  makeHome(t, 'upload-worker-');
  const { deps } = baseDeps({ acquireLock: undefined });
  assert.equal((await runUploadWorker(deps)).outcome, 'empty');
  assert.equal(inspectLock(runLock('upload')).held, false);
});

// ── the default steps ───────────────────────────────────────────────────────────────────────

const stepNamed = (name) => UPLOAD_STEPS.find((s) => s.name === name);
const ctxOf = (over = {}) => ({
  sessions: [session(KEY_A)],
  deadline: T0 + 270000,
  now: () => T0,
  fetchImpl: null,
  batch: true,
  status: {},
  due: [],
  deps: {},
  ...over,
});

test('the default steps run queue, then due-sessions, then rate-limits, then the installation binding, then diagnostics', () => {
  assert.deepEqual(UPLOAD_STEPS.map((s) => s.name), ['queue', 'due-sessions', 'rate-limits', 'installation-binding', 'diagnostics']);
});

test('registerUploadStep inserts before a named step, or appends, and replaces a same-named step', (t) => {
  const before = UPLOAD_STEPS.slice();
  t.after(() => { UPLOAD_STEPS.splice(0, UPLOAD_STEPS.length, ...before); });
  const run = () => ({ progress: 0, remaining: 0 });
  registerUploadStep({ name: 'session-start', run }, { before: 'due-sessions' });
  registerUploadStep({ name: 'diagnostics', run });
  registerUploadStep({ name: 'diagnostics', run }, { before: 'queue' });
  registerUploadStep({ name: 'late', run }, { before: 'no-such-step' });
  assert.deepEqual(UPLOAD_STEPS.map((s) => s.name), ['diagnostics', 'queue', 'session-start', 'due-sessions', 'rate-limits', 'installation-binding', 'late']);
});

test('registerUploadStep refuses a step without a name or a run function', () => {
  assert.throws(() => registerUploadStep({ name: '', run() {} }), TypeError);
  assert.throws(() => registerUploadStep({ name: 'x' }), TypeError);
});

test('the queue step drains each tokened account serially with the worker deadline and batch flag', async () => {
  const calls = [];
  let inFlight = 0;
  const fetchImpl = async () => ({ status: 200 });
  const flushQueue = async (key, s, opts) => {
    inFlight += 1;
    assert.equal(inFlight, 1, 'two drains at once would be a lock-order refusal');
    calls.push([key, s.token, opts]);
    await Promise.resolve();
    inFlight -= 1;
    return key === KEY_A
      ? { flushed: 2, rejected: 1, failed: 1, deferred: 0, expired: 1, quarantined: 1 }
      : { flushed: 0, rejected: 0, failed: 0, deferred: 3, expired: 0, quarantined: 0, lockSkipped: false };
  };
  const now = () => T0;
  const result = await stepNamed('queue').run(ctxOf({
    sessions: [session(KEY_A), session(KEY_B)], now, fetchImpl, deps: { flushQueue },
  }));
  assert.deepEqual(calls, [
    [KEY_A, 'tok-aaaa1111', { deadline: 1793873070000, fetchImpl, now, batch: true, guardChecked: true }],
    [KEY_B, 'tok-bbbb2222', { deadline: 1793873070000, fetchImpl, now, batch: true, guardChecked: true }],
  ]);
  assert.deepEqual(result, { progress: 5, remaining: 4, trackingDisabled: false, batchUnsupported: false });
});

test('the queue step counts a drain skipped on its lock as work left', async () => {
  const flushQueue = async () => ({ flushed: 0, lockSkipped: true, lockReason: 'held' });
  assert.deepEqual(await stepNamed('queue').run(ctxOf({ deps: { flushQueue } })),
    { progress: 0, remaining: 1, trackingDisabled: false, batchUnsupported: false });
});

test('the queue step reports a dark workspace only when every account is dark', async () => {
  const dark = async () => ({ flushed: 0, expired: 1, trackingDisabled: true });
  const mixed = async (key) => (key === KEY_A ? { trackingDisabled: true } : { flushed: 1 });
  const two = [session(KEY_A), session(KEY_B)];
  assert.equal((await stepNamed('queue').run(ctxOf({ sessions: two, deps: { flushQueue: dark } }))).trackingDisabled, true);
  assert.equal((await stepNamed('queue').run(ctxOf({ sessions: two, deps: { flushQueue: mixed } }))).trackingDisabled, false);
});

test('the queue step passes a batch fallback up and survives a throwing drain', async () => {
  const flushQueue = async (key) => {
    if (key === KEY_A) throw new Error('ECONNRESET');
    return { flushed: 1, batchUnsupported: true };
  };
  assert.deepEqual(await stepNamed('queue').run(ctxOf({ sessions: [session(KEY_A), session(KEY_B)], deps: { flushQueue } })),
    { progress: 1, remaining: 1, trackingDisabled: false, batchUnsupported: true });
});

test('the queue step starts no drain past the deadline', async () => {
  const calls = [];
  const flushQueue = async (key) => { calls.push(key); return {}; };
  const result = await stepNamed('queue').run(ctxOf({ now: () => T0 + 270000, deps: { flushQueue } }));
  assert.deepEqual(calls, []);
  assert.equal(result.remaining, 1);
});

test('the due-sessions step checkpoints each due session with the run\'s sessions and clears it', async (t) => {
  makeHome(t, 'upload-worker-');
  markUploadDue('s-1', { transcriptPath: 'C:/r/a.jsonl', cwd: 'C:/repo', timeline: true }, { now: () => T0 - 2000 });
  markUploadDue('s-2', { cwd: 'C:/other' }, { now: () => T0 - 1000 });
  const calls = [];
  const runCheckpoint = async (input, deps, options) => {
    calls.push([input, deps, options]);
    return { outcome: 'committed', timelineConfirmed: options.emitTimeline ? true : null };
  };
  const sessions = [session(KEY_A)];
  const now = () => T0;
  const result = await stepNamed('due-sessions').run(ctxOf({ sessions, now, due: listUploadDue(), deps: { runCheckpoint } }));
  assert.deepEqual(calls, [
    [{ session_id: 's-1', transcript_path: 'C:/r/a.jsonl', cwd: 'C:/repo' }, { now }, { sessions, emitTimeline: true, budgetMs: 270000, skipFlush: true, liveSinceLinkOnly: true }],
    [{ session_id: 's-2', transcript_path: null, cwd: 'C:/other' }, { now }, { sessions, emitTimeline: false, budgetMs: 270000, skipFlush: true, liveSinceLinkOnly: true }],
  ]);
  assert.deepEqual(result, { progress: 2, remaining: 0 });
  assert.deepEqual(listUploadDue(), []);
});

test('the due-sessions step keeps a linked account whose token is unavailable as a tokenless recipient', async (t) => {
  // Without it the checkpoint would enqueue for the tokened accounts only and advance the cursor
  // past segments the other account never received.
  const home = makeHome(t, 'upload-worker-');
  linkAccount(home, KEY_A);
  linkAccount(home, KEY_B);
  markUploadDue('s-1', {}, { now: () => T0 - 1000 });
  let seen = null;
  const runCheckpoint = async (input, deps, options) => { seen = options.sessions; return {}; };
  await stepNamed('due-sessions').run(ctxOf({ sessions: [session(KEY_A)], due: listUploadDue(), deps: { runCheckpoint } }));
  assert.deepEqual(seen.map((s) => [s.key, s.token, s.tenantId]), [[KEY_A, 'tok-aaaa1111', null], [KEY_B, null, null]]);
});

test('the due-sessions step keeps the marker of a checkpoint that reports failed', async (t) => {
  makeHome(t, 'upload-worker-');
  markUploadDue('s-1', { timeline: true }, { now: () => T0 - 1000 });
  const runCheckpoint = async () => ({ outcome: 'failed', reason: 'checkpoint-failed' });
  const result = await stepNamed('due-sessions').run(ctxOf({ due: listUploadDue(), deps: { runCheckpoint } }));
  assert.deepEqual(result, { progress: 0, remaining: 1 });
  assert.deepEqual(listUploadDue().map((e) => [e.sessionId, e.timeline]), [['s-1', true]]);
});

test('the due-sessions step passes the fetch seam through when one is set', async (t) => {
  makeHome(t, 'upload-worker-');
  markUploadDue('s-1', {}, { now: () => T0 - 1000 });
  const fetchImpl = async () => ({ status: 200 });
  let seen = null;
  const runCheckpoint = async (input, deps) => { seen = deps; return {}; };
  const now = () => T0;
  await stepNamed('due-sessions').run(ctxOf({ now, fetchImpl, due: listUploadDue(), deps: { runCheckpoint } }));
  assert.deepEqual(seen, { now, fetchImpl });
});

test('the due-sessions step keeps a marker whose session lock was busy, whose checkpoint threw or deferred', async (t) => {
  makeHome(t, 'upload-worker-');
  markUploadDue('s-busy', {}, { now: () => T0 - 3000 });
  markUploadDue('s-throw', {}, { now: () => T0 - 2000 });
  markUploadDue('s-none', {}, { now: () => T0 - 1000 });
  const runCheckpoint = async (input) => {
    if (input.session_id === 's-busy') return { lockSkipped: true, lockReason: 'held' };
    if (input.session_id === 's-throw') throw new Error('EIO');
    return { outcome: 'deferred', reason: 'not-checkpointed' };
  };
  const result = await stepNamed('due-sessions').run(ctxOf({ due: listUploadDue(), deps: { runCheckpoint } }));
  // s-none's `not-checkpointed` cannot change within this run: charged, but not work left.
  assert.deepEqual(result, { progress: 0, remaining: 2, waiting: 1 });
  // A busy session lock is someone else mid-checkpoint, not a failure of this marker.
  assert.deepEqual(listUploadDue().map((e) => [e.sessionId, e.attempts]), [['s-busy', 0], ['s-throw', 1], ['s-none', 1]]);
});

for (const lockReason of ['reconciliation', 'held', 'contended', 'migration']) {
  test(`a marker whose session lock is refused as ${lockReason} is waiting`, async (t) => {
    makeHome(t, 'upload-worker-');
    markUploadDue('s-1', {}, { now: () => T0 - 1000 });
    const runCheckpoint = async () => ({ lockSkipped: true, lockReason });
    const result = await stepNamed('due-sessions').run(ctxOf({ due: listUploadDue(), deps: { runCheckpoint } }));
    assert.deepEqual(result, { progress: 0, remaining: 1, waiting: 1 });
    assert.deepEqual(listUploadDue().map((e) => [e.sessionId, e.attempts]), [['s-1', 0]]);
  });
}

test('a marker refused for lock-order is not waiting', async (t) => {
  makeHome(t, 'upload-worker-');
  markUploadDue('s-1', {}, { now: () => T0 - 1000 });
  const runCheckpoint = async () => ({ lockSkipped: true, lockReason: 'lock-order' });
  const result = await stepNamed('due-sessions').run(ctxOf({ due: listUploadDue(), deps: { runCheckpoint } }));
  assert.deepEqual(result, { progress: 0, remaining: 1 });
});

test('the due-sessions step leaves a session re-marked mid-checkpoint for the next pass', async (t) => {
  makeHome(t, 'upload-worker-');
  markUploadDue('s-1', { timeline: false }, { now: () => T0 - 1000 });
  const runCheckpoint = async () => { markUploadDue('s-1', { timeline: true }, { now: () => T0 }); return {}; };
  const result = await stepNamed('due-sessions').run(ctxOf({ due: listUploadDue(), deps: { runCheckpoint } }));
  assert.deepEqual(result, { progress: 0, remaining: 1 });
  assert.equal(listUploadDue()[0].timeline, true);
});

test('the due-sessions step starts no checkpoint past the deadline', async (t) => {
  makeHome(t, 'upload-worker-');
  markUploadDue('s-1', {}, { now: () => T0 - 1000 });
  let ran = 0;
  const runCheckpoint = async () => { ran += 1; return {}; };
  const result = await stepNamed('due-sessions').run(ctxOf({ now: () => T0 + 270000, due: listUploadDue(), deps: { runCheckpoint } }));
  assert.equal(ran, 0);
  assert.deepEqual(result, { progress: 0, remaining: 1 });
});

test('the rate-limits step drains each account, and each workspace of a multi-workspace account', async () => {
  const calls = [];
  const fetchImpl = async () => ({ status: 200 });
  const now = () => T0;
  const drainRateLimitSnapshots = async (key, s, opts) => {
    calls.push([key, s.tenantId, opts]);
    return { posted: 1, deferred: 0, reason: 'drained' };
  };
  const multi = session(KEY_B, { tenants: [{ id: 'T1' }, { id: 'T2' }] });
  const result = await stepNamed('rate-limits').run(ctxOf({
    sessions: [session(KEY_A), multi], now, fetchImpl, deps: { drainRateLimitSnapshots },
  }));
  const opts = { deadline: 1793873070000, fetchImpl, now };
  assert.deepEqual(calls, [[KEY_A, null, opts], [KEY_B, 'T1', opts], [KEY_B, 'T2', opts]]);
  assert.deepEqual(result, { progress: 3, remaining: 0 });
});

test('the rate-limits step counts deadline and network leftovers as work left, a rejection not', async () => {
  const answers = {
    [KEY_A]: { posted: 0, deferred: 2, reason: 'network' },
    [KEY_B]: { posted: 1, deferred: 4, reason: 'rejected' },
  };
  const drainRateLimitSnapshots = async (key) => answers[key];
  const result = await stepNamed('rate-limits').run(ctxOf({
    sessions: [session(KEY_A), session(KEY_B)], deps: { drainRateLimitSnapshots },
  }));
  assert.deepEqual(result, { progress: 1, remaining: 2 });
});

// ── credentials, end to end ─────────────────────────────────────────────────────────────────

test('a run with several passes and a re-acquire reads each account\'s credentials exactly once', async (t) => {
  const home = makeHome(t, 'upload-worker-');
  linkAccount(home, KEY_A);
  linkAccount(home, KEY_B);
  markUploadDue('s-1', { cwd: 'C:/repo', timeline: true }, { now: () => T0 - 1000 });
  const reads = {};
  const getCredentials = async (key) => {
    reads[key] = (reads[key] || 0) + 1;
    return credentialBlob({ access_token: `at-${key}`, client_id: `c-${key}`, expires_at: T0 + 3600000 });
  };
  const flushed = { [KEY_A]: 2, [KEY_B]: 1 };
  const flushQueue = async (key) => {
    const n = flushed[key];
    flushed[key] = 0;
    return { flushed: n, rejected: 0, failed: 0, deferred: 0, expired: 0, quarantined: 0 };
  };
  const checkpointSessions = [];
  const runCheckpoint = async (input, deps, options) => {
    checkpointSessions.push(options.sessions);
    return { outcome: 'committed', timelineConfirmed: true };
  };
  const drainRateLimitSnapshots = async () => ({ posted: 0, reason: 'empty' });
  const answers = [false, true, false];
  const { deps } = baseDeps({
    acquireLock: undefined,
    linkedSessions: undefined,
    steps: undefined,
    getCredentials,
    flushQueue,
    runCheckpoint,
    drainRateLimitSnapshots,
    hasPostableWork: () => answers.shift(),
  });
  const out = await runUploadWorker(deps);
  assert.equal(out.outcome, 'empty');
  assert.ok(out.passes >= 3, `expected several passes, got ${out.passes}`);
  assert.deepEqual(reads, { [KEY_A]: 1, [KEY_B]: 1 });
  assert.equal(checkpointSessions.length, 1);
  assert.deepEqual(checkpointSessions[0].map((s) => [s.key, s.token]), [[KEY_A, 'at-aaaa1111'], [KEY_B, 'at-bbbb2222']]);
});

test('an account whose credentials are unavailable is read once, gets no drain and stays a checkpoint recipient', async (t) => {
  const home = makeHome(t, 'upload-worker-');
  linkAccount(home, KEY_A);
  linkAccount(home, KEY_B);
  markUploadDue('s-1', { cwd: 'C:/repo' }, { now: () => T0 - 1000 });
  const reads = {};
  const getCredentials = async (key) => {
    reads[key] = (reads[key] || 0) + 1;
    return key === KEY_A ? credentialBlob({ access_token: 'at-a', expires_at: T0 + 3600000 }) : null;
  };
  const drained = [];
  const flushQueue = async (key) => { drained.push(key); return {}; };
  const checkpointSessions = [];
  const runCheckpoint = async (input, deps, options) => { checkpointSessions.push(options.sessions); return {}; };
  const drainRateLimitSnapshots = async () => ({ posted: 0, reason: 'empty' });
  const { deps } = baseDeps({
    acquireLock: undefined, linkedSessions: undefined, steps: undefined,
    getCredentials, flushQueue, runCheckpoint, drainRateLimitSnapshots,
  });
  assert.equal((await runUploadWorker(deps)).outcome, 'empty');
  assert.deepEqual(reads, { [KEY_A]: 1, [KEY_B]: 1 });
  assert.deepEqual([...new Set(drained)], [KEY_A]);
  assert.deepEqual(checkpointSessions[0].map((s) => [s.key, s.token]), [[KEY_A, 'at-a'], [KEY_B, null]]);
});

// ── fix round 1: the guard runs before the run lock ─────────────────────────────────────────────

test('the full environment guard runs before the upload lock is taken, so it can migrate', async (t) => {
  // withMigrationRoots refuses to migrate while any run lock is held; a guard run under
  // run:upload would answer active-writer forever once the hooks stop running the full guard.
  makeHome(t, 'upload-worker-');
  const events = [];
  let heldDuringGuard = null;
  const lock = fakeLock();
  const { deps } = baseDeps({
    checkEnvironment: () => {
      events.push('guard');
      heldDuringGuard = inspectLock(runLock('upload')).held;
      return { status: 'ok' };
    },
    acquireLock: (target, options) => { events.push('acquire'); return lock.acquireLock(target, options); },
  });
  await runUploadWorker(deps);
  assert.deepEqual(events, ['guard', 'acquire']);
  assert.equal(heldDuringGuard, false);
});

test('with the real lock, nothing holds run:upload while the guard runs', async (t) => {
  makeHome(t, 'upload-worker-');
  let heldDuringGuard = null;
  const { deps } = baseDeps({
    acquireLock: undefined,
    checkEnvironment: () => { heldDuringGuard = inspectLock(runLock('upload')).held; return { status: 'ok' }; },
  });
  assert.equal((await runUploadWorker(deps)).outcome, 'empty');
  assert.equal(heldDuringGuard, false);
});

// ── fix round 1: a lock refusal that is not another worker ──────────────────────────────────────

for (const reason of ['mkdir-failed', 'write-failed', 'breaker-write-failed', 'unlink-failed']) {
  test(`a ${reason} lock refusal backs the trigger off for 5 minutes`, async (t) => {
    makeHome(t, 'upload-worker-');
    const { deps } = baseDeps({ acquireLock: () => ({ ok: false, reason, code: 'EACCES', holder: null }) });
    assert.deepEqual(await runUploadWorker(deps), { outcome: 'lock-failed', passes: 0, progress: 0 });
    assert.deepEqual(readUploadStatus(), {
      state: 'idle', outcome: 'lock-failed', retryAfterAt: 1793873100000, version: 1,
    });
  });
}

for (const reason of ['held', 'contended', 'migration']) {
  test(`a ${reason} lock refusal is busy and writes no status`, async (t) => {
    const home = makeHome(t, 'upload-worker-');
    const { deps } = baseDeps({ acquireLock: () => ({ ok: false, reason, holder: null }) });
    assert.equal((await runUploadWorker(deps)).outcome, 'busy');
    assert.equal(fs.existsSync(path.join(home, 'upload-worker.json')), false);
  });
}

// ── fix round 1: the queue step does not count an absent route as work left ─────────────────────

test('the queue step does not count files kept for an absent report route as work left', async () => {
  // Mirrors reconcileSession: a 404/405 keeps the file and counts it in `failed`, but no retry in
  // this run will make the route appear, so it must not stall every run.
  const flushQueue = async () => ({ flushed: 1, failed: 3, routeAbsent: 2, deferred: 1 });
  assert.deepEqual(await stepNamed('queue').run(ctxOf({ deps: { flushQueue } })),
    { progress: 1, remaining: 2, trackingDisabled: false, batchUnsupported: false });
});

// ── fix round 1: a due marker clears only after the server confirmed what it owed ───────────────

const dueRun = async (runCheckpoint, ctxOver = {}) => stepNamed('due-sessions').run(ctxOf({ due: listUploadDue(), deps: { runCheckpoint }, ...ctxOver }));

test('a committed checkpoint whose timeline was not confirmed keeps the marker and counts a failed run', async (t) => {
  makeHome(t, 'upload-worker-');
  markUploadDue('s-1', { timeline: true }, { now: () => T0 - 1000 });
  const result = await dueRun(async () => ({ outcome: 'committed', timelineConfirmed: false }));
  assert.deepEqual(result, { progress: 0, remaining: 1 });
  assert.deepEqual(listUploadDue().map((e) => [e.sessionId, e.timeline, e.attempts]), [['s-1', true, 1]]);
});

test('a committed checkpoint with no timeline field keeps a marker that asked for one', async (t) => {
  makeHome(t, 'upload-worker-');
  markUploadDue('s-1', { timeline: true }, { now: () => T0 - 1000 });
  assert.deepEqual(await dueRun(async () => ({ outcome: 'committed', reason: 'resumed' })), { progress: 0, remaining: 1 });
  assert.equal(listUploadDue().length, 1);
});

test('a committed checkpoint clears a marker that asked for no timeline', async (t) => {
  makeHome(t, 'upload-worker-');
  markUploadDue('s-1', { timeline: false }, { now: () => T0 - 1000 });
  assert.deepEqual(await dueRun(async () => ({ outcome: 'committed', timelineConfirmed: null })), { progress: 1, remaining: 0 });
  assert.deepEqual(listUploadDue(), []);
});

test('a checkpoint that lost its session lock before committing keeps the marker', async (t) => {
  makeHome(t, 'upload-worker-');
  markUploadDue('s-1', {}, { now: () => T0 - 1000 });
  assert.deepEqual(await dueRun(async () => ({ outcome: 'deferred', reason: 'ownership-lost' })), { progress: 0, remaining: 1 });
  assert.equal(listUploadDue().length, 1);
});

test('a checkpoint with nowhere to send, or no usable session id, clears the marker: nothing is owed', async (t) => {
  makeHome(t, 'upload-worker-');
  markUploadDue('s-gated', { timeline: true }, { now: () => T0 - 2000 });
  markUploadDue('s-unnamed', { timeline: true }, { now: () => T0 - 1000 });
  const result = await dueRun(async (input) => (input.session_id === 's-gated'
    ? { outcome: 'deferred', reason: 'no-targets', gated: true }
    : { outcome: 'deferred', reason: 'not-checkpointed', unnamedSession: true }));
  assert.deepEqual(result, { progress: 2, remaining: 0 });
  assert.deepEqual(listUploadDue(), []);
});

test('a marker is counted once per run however many passes fail it', async (t) => {
  makeHome(t, 'upload-worker-');
  markUploadDue('s-1', { timeline: true }, { now: () => T0 - 1000 });
  const runCheckpoint = async () => ({ outcome: 'committed', timelineConfirmed: false });
  const sessions = [session(KEY_A)];
  await dueRun(runCheckpoint, { sessions });
  await stepNamed('due-sessions').run(ctxOf({ sessions, due: listUploadDue(), deps: { runCheckpoint } }));
  assert.equal(listUploadDue()[0].attempts, 1);
});

test('the fifth failed run drops the marker and records why in the status file', async (t) => {
  makeHome(t, 'upload-worker-');
  markUploadDue('s-1', { timeline: true }, { now: () => T0 - 1000 });
  const runCheckpoint = async () => ({ outcome: 'committed', timelineConfirmed: false });
  for (let run = 1; run <= 4; run += 1) assert.deepEqual(await dueRun(runCheckpoint), { progress: 0, remaining: 1 });
  assert.deepEqual(await dueRun(runCheckpoint), { progress: 1, remaining: 0 });
  assert.deepEqual(listUploadDue(), []);
  assert.deepEqual(readUploadStatus().dueDropped, { sessionId: 's-1', reason: 'timeline-unconfirmed', attempts: 5, at: 1793872800000 });
});

test('a whole worker run with a timeline that keeps failing ends stalled, so the trigger backs off', async (t) => {
  makeHome(t, 'upload-worker-');
  markUploadDue('s-1', { timeline: true }, { now: () => T0 - 1000 });
  let checkpoints = 0;
  const { deps } = baseDeps({
    steps: undefined,
    flushQueue: async () => ({}),
    runCheckpoint: async () => { checkpoints += 1; return { outcome: 'committed', timelineConfirmed: false, timelineConfirmedLive: false }; },
    drainRateLimitSnapshots: async () => ({ posted: 0, reason: 'empty' }),
  });
  assert.equal((await runUploadWorker(deps)).outcome, 'stalled');
  assert.equal(checkpoints, 1, 'three passes, one checkpoint: the timeline is not re-posted per pass');
  assert.equal(readUploadStatus().retryAfterAt, 1793873100000);
  assert.equal(listUploadDue()[0].attempts, 1);
});

// ── fix round 1: per-entry due handlers (Task 10's session-start work) ──────────────────────────

test('a due handler that has not settled keeps the marker even when the checkpoint settled', async (t) => {
  makeHome(t, 'upload-worker-');
  markUploadDue('s-1', { sessionStart: true }, { now: () => T0 - 1000 });
  const seen = [];
  const off = registerDueHandler(async (entry, ctx) => { seen.push([entry.sessionId, entry.sessionStart, ctx.deadline]); return { settled: false }; });
  t.after(off);
  // No tokened session: the default session-start handler has no account to ask, and settles.
  const result = await dueRun(async () => ({ outcome: 'committed', timelineConfirmed: null }), { sessions: [] });
  assert.deepEqual(seen, [['s-1', true, 1793873070000]]);
  assert.deepEqual(result, { progress: 0, remaining: 1 });
  assert.deepEqual(listUploadDue().map((e) => [e.sessionId, e.attempts]), [['s-1', 1]]);
});

test('every handler settled and the checkpoint settled clears the marker', async (t) => {
  makeHome(t, 'upload-worker-');
  markUploadDue('s-1', { sessionStart: true }, { now: () => T0 - 1000 });
  const offA = registerDueHandler(async () => ({ settled: true }));
  const offB = registerDueHandler(async () => ({ settled: true }));
  t.after(() => { offA(); offB(); });
  // No tokened session: the default session-start handler has no account to ask, and settles.
  assert.deepEqual(await dueRun(async () => ({ outcome: 'committed' }), { sessions: [] }), { progress: 1, remaining: 0 });
  assert.deepEqual(listUploadDue(), []);
});

test('a handler runs even when the checkpoint did not settle, and a throwing handler keeps the marker', async (t) => {
  makeHome(t, 'upload-worker-');
  markUploadDue('s-1', {}, { now: () => T0 - 1000 });
  let ran = 0;
  const offA = registerDueHandler(async () => { ran += 1; return { settled: true }; });
  const offB = registerDueHandler(async () => { throw new Error('whoami 503'); });
  t.after(() => { offA(); offB(); });
  assert.deepEqual(await dueRun(async () => ({ lockSkipped: true })), { progress: 0, remaining: 1 });
  assert.equal(ran, 1);
  assert.equal(listUploadDue().length, 1);
});

test('a handler that settled is not run again for the same marker in the same run', async (t) => {
  makeHome(t, 'upload-worker-');
  markUploadDue('s-1', { timeline: true }, { now: () => T0 - 1000 });
  let ran = 0;
  const off = registerDueHandler(async () => { ran += 1; return { settled: true }; });
  t.after(off);
  const sessions = [session(KEY_A)];
  let confirmed = false;
  let checkpoints = 0;
  const runCheckpoint = async () => { checkpoints += 1; return { outcome: 'committed', timelineConfirmed: confirmed }; };
  const first = await stepNamed('due-sessions').run(ctxOf({ sessions, due: listUploadDue(), deps: { runCheckpoint } }));
  confirmed = true;
  const second = await stepNamed('due-sessions').run(ctxOf({ sessions, due: listUploadDue(), deps: { runCheckpoint } }));
  // Neither the checkpoint nor the handler runs twice for one marker in one run; the later pass
  // reports the same work left the first one did.
  assert.equal(ran, 1);
  assert.equal(checkpoints, 1);
  assert.deepEqual([first, second], [{ progress: 0, remaining: 1 }, { progress: 0, remaining: 1 }]);
  assert.equal(listUploadDue().length, 1);
});

test('registerDueHandler refuses a non-function, ignores a duplicate and unregisters', async (t) => {
  makeHome(t, 'upload-worker-');
  assert.throws(() => registerDueHandler(null), TypeError);
  let ran = 0;
  const handler = async () => { ran += 1; return { settled: true }; };
  const off = registerDueHandler(handler);
  registerDueHandler(handler);
  markUploadDue('s-1', {}, { now: () => T0 - 1000 });
  await dueRun(async () => ({ outcome: 'committed' }));
  assert.equal(ran, 1);
  off();
  markUploadDue('s-2', {}, { now: () => T0 - 1000 });
  await dueRun(async () => ({ outcome: 'committed' }));
  assert.equal(ran, 1);
});

// ── fix round 2: what no pass of this run can settle is not work left ──────────────────────────

test('a timeline missing only for a tokenless sender keeps the marker but is not work left or a charged run', async (t) => {
  makeHome(t, 'upload-worker-');
  markUploadDue('s-1', { timeline: true }, { now: () => T0 - 1000 });
  const result = await dueRun(async () => ({ outcome: 'committed', timelineConfirmed: false, timelineConfirmedLive: true }));
  assert.deepEqual(result, { progress: 0, remaining: 0 });
  assert.deepEqual(listUploadDue().map((e) => [e.sessionId, e.attempts]), [['s-1', 0]]);
});

test('a live sender that did not confirm is still work left', async (t) => {
  makeHome(t, 'upload-worker-');
  markUploadDue('s-1', { timeline: true }, { now: () => T0 - 1000 });
  const result = await dueRun(async () => ({ outcome: 'committed', timelineConfirmed: false, timelineConfirmedLive: false }));
  assert.deepEqual(result, { progress: 0, remaining: 1 });
});

// Kept and charged, but not work left: a marker is handled once per run, so no later pass of this
// run would retry it, and counting it would only idle the run into `stalled` and back off every
// account — forever on a server whose error route answers 404 or refuses the payload.
test('a committed checkpoint with an error still parked for a live sender keeps the marker and is charged, but is not work left', async (t) => {
  makeHome(t, 'upload-worker-');
  markUploadDue('s-1', { timeline: false }, { now: () => T0 - 1000 });
  const result = await dueRun(async () => ({ outcome: 'committed', timelineConfirmed: null, errorsPendingLive: true }));
  assert.deepEqual(result, { progress: 0, remaining: 0 });
  assert.deepEqual(listUploadDue().map((e) => [e.sessionId, e.attempts]), [['s-1', 1]]);
});

test('a whole run whose error route keeps refusing ends empty and keeps the marker for a later run', async (t) => {
  const home = makeHome(t, 'upload-worker-');
  linkAccount(home, KEY_A);
  fs.writeFileSync(path.join(home, 'accounts', KEY_A, 'tracking.json'), JSON.stringify({ version: 1, linkedAt: new Date(Date.now() - 3600000).toISOString() }));
  const file = turnRollout(home, 'sess-1');
  markDueNow('sess-1', { transcriptPath: file, cwd: home, timeline: false });
  const errorPosts = [];
  const fetchImpl = async (url) => {
    const refused = String(url).indexOf('/sessions/errors') !== -1;
    if (refused) errorPosts.push(String(url));
    const status = refused ? 500 : 200;
    return { status, ok: status === 200, json: async () => ({}), text: async () => '{}' };
  };
  const apiError = { error: 'usage_limit_exceeded', text: 'You hit the limit', occurredAt: new Date().toISOString() };
  const { deps } = baseDeps({
    now: Date.now, deadline: undefined,
    acquireLock: undefined, steps: undefined, hasPostableWork: undefined,
    linkedSessions: async () => [session(KEY_A)],
    fetchImpl,
    checkpointDeps: {
      gitImpl: () => 'https://host/org/repo.git',
      computeDelta: () => ({ nextCursor: 4, segments: [], apiErrorEvents: [apiError] }),
    },
  });
  const out = await runUploadWorker(deps);
  assert.equal(out.outcome, 'empty');
  assert.equal(errorPosts.length, 1);
  assert.deepEqual(listUploadDue().map((e) => [e.sessionId, e.attempts]), [['sess-1', 1]]);
  assert.equal(readUploadStatus().retryAfterAt, null);
});

test('a committed checkpoint whose parked errors only a tokenless sender owes clears a marker that asked for no timeline', async (t) => {
  makeHome(t, 'upload-worker-');
  markUploadDue('s-1', { timeline: false }, { now: () => T0 - 1000 });
  const result = await dueRun(async () => ({ outcome: 'committed', timelineConfirmed: null, errorsPendingLive: false }));
  assert.deepEqual(result, { progress: 1, remaining: 0 });
  assert.deepEqual(listUploadDue(), []);
});

test('an unresolvable transcript is charged a run but is not work left', async (t) => {
  makeHome(t, 'upload-worker-');
  markUploadDue('s-1', {}, { now: () => T0 - 1000 });
  const result = await dueRun(async () => ({ outcome: 'deferred', reason: 'not-checkpointed' }));
  assert.deepEqual(result, { progress: 0, remaining: 0 });
  assert.equal(listUploadDue()[0].attempts, 1);
});

test('a busy session lock is retried on the next pass of the same run', async (t) => {
  makeHome(t, 'upload-worker-');
  markUploadDue('s-1', {}, { now: () => T0 - 1000 });
  const answers = [{ lockSkipped: true }, { outcome: 'committed' }];
  const runCheckpoint = async () => answers.shift();
  const sessions = [session(KEY_A)];
  await stepNamed('due-sessions').run(ctxOf({ sessions, due: listUploadDue(), deps: { runCheckpoint } }));
  const second = await stepNamed('due-sessions').run(ctxOf({ sessions, due: listUploadDue(), deps: { runCheckpoint } }));
  assert.deepEqual(second, { progress: 1, remaining: 0 });
  assert.deepEqual(listUploadDue(), []);
});

test('a marker re-marked during the run is new work and runs again in a later pass', async (t) => {
  makeHome(t, 'upload-worker-');
  markUploadDue('s-1', {}, { now: () => T0 - 1000 });
  let checkpoints = 0;
  const runCheckpoint = async () => { checkpoints += 1; return { outcome: 'deferred', reason: 'ownership-lost' }; };
  const sessions = [session(KEY_A)];
  await stepNamed('due-sessions').run(ctxOf({ sessions, due: listUploadDue(), deps: { runCheckpoint } }));
  markUploadDue('s-1', { timeline: true }, { now: () => T0 });
  await stepNamed('due-sessions').run(ctxOf({ sessions, due: listUploadDue(), deps: { runCheckpoint } }));
  assert.equal(checkpoints, 2);
});

// End to end with the REAL runCheckpoint: a rollout with one turn, two linked accounts, one of
// which has no credentials this run.
function turnRollout(home, id) {
  const T = T0 - 600000;
  const rec = (ms, type, payload) => ({ timestamp: new Date(ms).toISOString(), type, payload });
  const file = path.join(home, `rollout-${id}.jsonl`);
  fs.writeFileSync(file, [
    rec(T, 'session_meta', { id, cwd: home }),
    rec(T + 1000, 'event_msg', { type: 'user_message', message: 'do it' }),
    rec(T + 5000, 'event_msg', { type: 'agent_message' }),
    rec(T + 6000, 'event_msg', { type: 'task_complete' }),
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

// These runs use the REAL runCheckpoint, which writes queue files and state with wall-clock mtimes
// the worker's re-scan compares against its pass starts. So they run on the real clock, not T0: on a
// fixed clock those files would look newer than every pass and the run would never end `empty`.
// Every POST answers 200 (only timeline POSTs are recorded), so the segments the checkpoint enqueues
// are delivered rather than left behind as work.
function markDueNow(sessionId, fields) {
  markUploadDue(sessionId, fields, { now: () => Date.now() - 1000 });
}

function realRunDeps(home, timelinePosts, over = {}) {
  linkAccount(home, KEY_A);
  linkAccount(home, KEY_B);
  // Linked an hour ago, as login stamps it (markLinked): the session below runs after the link, so
  // the due checkpoint treats it as live rather than past (liveSinceLinkOnly).
  for (const key of [KEY_A, KEY_B]) {
    fs.writeFileSync(path.join(home, 'accounts', key, 'tracking.json'), JSON.stringify({ version: 1, linkedAt: new Date(Date.now() - 3600000).toISOString() }));
  }
  const tokened = over.tokened || [KEY_A];
  const getCredentials = async (key) => (tokened.indexOf(key) !== -1
    ? credentialBlob({ access_token: key === KEY_A ? 'at-a' : 'at-b', expires_at: Date.now() + 3600000 })
    : null);
  const fetchImpl = async (url, init) => {
    if (String(url).indexOf('/sessions/timeline') !== -1) timelinePosts.push(init.headers.Authorization || init.headers.authorization);
    return { status: 200, ok: true, json: async () => ({}), text: async () => '{}' };
  };
  return baseDeps({
    now: Date.now, deadline: undefined,
    acquireLock: undefined, linkedSessions: undefined, steps: undefined, hasPostableWork: undefined,
    getCredentials, fetchImpl, checkpointDeps: { gitImpl: () => 'https://host/org/repo.git' },
    ...(over.runCheckpoint ? { runCheckpoint: over.runCheckpoint } : {}),
  }).deps;
}

test('a run with a tokened and a tokenless account ends empty, posts the timeline once and keeps the marker', async (t) => {
  const home = makeHome(t, 'upload-worker-');
  const file = turnRollout(home, 'sess-1');
  markDueNow('sess-1', { transcriptPath: file, cwd: home, timeline: true });
  const posts = [];
  const out = await runUploadWorker(realRunDeps(home, posts));
  assert.equal(out.outcome, 'empty');
  assert.deepEqual(posts, ['Bearer at-a']);
  assert.deepEqual(listUploadDue().map((e) => [e.sessionId, e.timeline, e.attempts]), [['sess-1', true, 0]]);
  assert.equal(readUploadStatus().retryAfterAt, null);
});

test('a run whose due transcript cannot be resolved ends empty, not stalled', async (t) => {
  const home = makeHome(t, 'upload-worker-');
  markDueNow('sess-gone', { transcriptPath: path.join(home, 'no-such-rollout.jsonl'), cwd: home });
  const out = await runUploadWorker(realRunDeps(home, []));
  assert.equal(out.outcome, 'empty');
  assert.equal(listUploadDue()[0].attempts, 1);
});

// ── fix round 3: a parked marker waits for the account that owes it ─────────────────────────────

const DAY = 24 * 60 * 60 * 1000;

test('a timeline missing only for tokenless senders parks the marker on those accounts', async (t) => {
  const home = makeHome(t, 'upload-worker-');
  linkAccount(home, KEY_A);
  linkAccount(home, KEY_B);
  markUploadDue('s-1', { timeline: true }, { now: () => T0 - 1000 });
  const result = await dueRun(async () => ({ outcome: 'committed', timelineConfirmed: false, timelineConfirmedLive: true }),
    { sessions: [session(KEY_A)] });
  assert.deepEqual(result, { progress: 0, remaining: 0 });
  assert.deepEqual(listUploadDue().map((e) => [e.sessionId, e.owedKeys, e.attempts]), [['s-1', [KEY_B], 0]]);
});

test('a parked marker whose owed account is still tokenless is skipped with no checkpoint at all', async (t) => {
  makeHome(t, 'upload-worker-');
  markUploadDue('s-1', { timeline: true }, { now: () => T0 - 1000 });
  parkUploadDue(listUploadDue()[0], [KEY_B]);
  let checkpoints = 0;
  const result = await dueRun(async () => { checkpoints += 1; return {}; }, { sessions: [session(KEY_A)] });
  assert.equal(checkpoints, 0);
  assert.deepEqual(result, { progress: 0, remaining: 0 });
  assert.deepEqual(listUploadDue().map((e) => [e.owedKeys, e.attempts]), [[[KEY_B], 0]]);
});

test('a parked marker runs its checkpoint once the owed account has a token, and clears', async (t) => {
  makeHome(t, 'upload-worker-');
  markUploadDue('s-1', { timeline: true }, { now: () => T0 - 1000 });
  parkUploadDue(listUploadDue()[0], [KEY_B]);
  let checkpoints = 0;
  const result = await dueRun(async () => { checkpoints += 1; return { outcome: 'committed', timelineConfirmed: true, timelineConfirmedLive: true }; },
    { sessions: [session(KEY_A), session(KEY_B)] });
  assert.equal(checkpoints, 1);
  assert.deepEqual(result, { progress: 1, remaining: 0 });
  assert.deepEqual(listUploadDue(), []);
});

test('a parked marker older than 7 days is dropped as owed-expired without a checkpoint', async (t) => {
  makeHome(t, 'upload-worker-');
  markUploadDue('s-old', { timeline: true }, { now: () => T0 - 7 * DAY - 1 });
  markUploadDue('s-edge', { timeline: true }, { now: () => T0 - 7 * DAY });
  for (const e of listUploadDue()) parkUploadDue(e, [KEY_B]);
  let checkpoints = 0;
  const result = await dueRun(async () => { checkpoints += 1; return {}; }, { sessions: [session(KEY_A)] });
  assert.equal(checkpoints, 0);
  assert.deepEqual(result, { progress: 1, remaining: 0 });
  assert.deepEqual(listUploadDue().map((e) => e.sessionId), ['s-edge']);
  assert.deepEqual(readUploadStatus().dueDropped, { sessionId: 's-old', reason: 'owed-expired', attempts: 0, at: 1793872800000 });
});

test('the 7-day limit applies to parked markers only', async (t) => {
  makeHome(t, 'upload-worker-');
  markUploadDue('s-old', {}, { now: () => T0 - 30 * DAY });
  let checkpoints = 0;
  await dueRun(async () => { checkpoints += 1; return { outcome: 'committed' }; });
  assert.equal(checkpoints, 1);
  assert.equal(readUploadStatus().dueDropped, undefined);
});

test('across runs: park, skip while still tokenless, then deliver to the account once it has a token', async (t) => {
  const home = makeHome(t, 'upload-worker-');
  const file = turnRollout(home, 'sess-1');
  markDueNow('sess-1', { transcriptPath: file, cwd: home, timeline: true });
  const posts = [];
  let checkpoints = 0;
  const counting = async (input, deps, options) => { checkpoints += 1; return realRunCheckpoint(input, deps, options); };

  assert.equal((await runUploadWorker(realRunDeps(home, posts, { runCheckpoint: counting }))).outcome, 'empty');
  assert.deepEqual(posts, ['Bearer at-a']);
  assert.deepEqual(listUploadDue()[0].owedKeys, [KEY_B]);

  checkpoints = 0;
  assert.equal((await runUploadWorker(realRunDeps(home, posts, { runCheckpoint: counting }))).outcome, 'empty');
  assert.equal(checkpoints, 0, 'B is still tokenless: no transcript read, no timeline re-post');
  assert.deepEqual(posts, ['Bearer at-a']);

  checkpoints = 0;
  const third = await runUploadWorker(realRunDeps(home, posts, { runCheckpoint: counting, tokened: [KEY_A, KEY_B] }));
  assert.equal(third.outcome, 'empty');
  assert.equal(checkpoints, 1);
  assert.ok(posts.slice(1).indexOf('Bearer at-b') !== -1, `B got the timeline: ${JSON.stringify(posts)}`);
  assert.deepEqual(listUploadDue(), []);
});

// ── Task 10: the session-start handler, a parked marker's handlers, the migration notice ────────

const WHOAMI = '/me/codex/whoami';

function portal() {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => (String(url).endsWith(WHOAMI) ? { email: 'a@example.com' } : {}) };
  };
  return { fetchImpl, whoamis: () => calls.filter((u) => u.endsWith(WHOAMI)).length };
}

const quietNetwork = { syncAccount: async () => ({ synced: false }), checkForUpdate: async () => ({ status: 'skipped' }) };

test('the session-start handler is registered by default and caches each account its answers', async (t) => {
  const home = makeHome(t, 'upload-worker-');
  linkAccount(home, KEY_A);
  markUploadDue('s-1', { sessionStart: true }, { now: () => T0 - 1000 });
  const { fetchImpl, whoamis } = portal();
  const result = await dueRun(null, { fetchImpl, deps: { ...quietNetwork, runCheckpoint: async () => ({ outcome: 'committed' }) } });
  assert.deepEqual(result, { progress: 1, remaining: 0 });
  assert.equal(whoamis(), 1);
  const cache = JSON.parse(fs.readFileSync(path.join(home, 'accounts', KEY_A, 'session-start.json'), 'utf-8'));
  assert.deepEqual([cache.verdict, cache.who.email, cache.checkedAt], ['ok', 'a@example.com', 1793872800000]);
  assert.deepEqual(listUploadDue(), []);
});

test('a parked marker still runs its due handlers, with no checkpoint, and stays parked and uncharged', async (t) => {
  makeHome(t, 'upload-worker-');
  markUploadDue('s-1', { timeline: true }, { now: () => T0 - 1000 });
  parkUploadDue(listUploadDue()[0], [KEY_B]);
  const seen = [];
  const off = registerDueHandler(async (entry) => { seen.push(entry.sessionId); return { settled: false }; });
  t.after(off);
  let checkpoints = 0;
  const result = await dueRun(async () => { checkpoints += 1; return {}; }, { sessions: [session(KEY_A)] });
  assert.deepEqual(seen, ['s-1']);
  assert.equal(checkpoints, 0);
  assert.deepEqual(result, { progress: 0, remaining: 0 });
  assert.deepEqual(listUploadDue().map((e) => [e.owedKeys, e.attempts]), [[[KEY_B], 0]]);
});

test('a session-start marker parked for its timeline gets its session-start work once, then owes only the timeline', async (t) => {
  const home = makeHome(t, 'upload-worker-');
  linkAccount(home, KEY_A);
  markUploadDue('s-1', { timeline: true, sessionStart: true }, { now: () => T0 - 1000 });
  parkUploadDue(listUploadDue()[0], [KEY_B]);
  const { fetchImpl, whoamis } = portal();
  let checkpoints = 0;
  const deps = { ...quietNetwork, runCheckpoint: async () => { checkpoints += 1; return {}; } };
  assert.deepEqual(await dueRun(null, { fetchImpl, deps }), { progress: 0, remaining: 0 });
  assert.equal(whoamis(), 1, 'the session-start work ran although the timeline is parked');
  // The next run (a new sessions array): the handler settles at once; still no checkpoint.
  assert.deepEqual(await dueRun(null, { fetchImpl, deps, sessions: [session(KEY_A)], now: () => T0 + 5000 }), { progress: 0, remaining: 0 });
  assert.equal(whoamis(), 1);
  assert.equal(checkpoints, 0);
  assert.deepEqual(listUploadDue().map((e) => [e.sessionId, e.owedKeys, e.attempts]), [['s-1', [KEY_B], 0]]);
});

test('a worker whose guard migrated the root records the notice for the next SessionStart', async (t) => {
  makeHome(t, 'upload-worker-');
  const { deps } = baseDeps({ checkEnvironment: () => ({ status: 'migrated', message: 'Beezi now reports to the production API.' }) });
  await runUploadWorker(deps);
  assert.equal(readUploadStatus().migrationNotice, 'Beezi now reports to the production API.');
});

test('a plain ok guard records no migration notice', async (t) => {
  makeHome(t, 'upload-worker-');
  await runUploadWorker(baseDeps().deps);
  assert.equal(readUploadStatus().migrationNotice, undefined);
});

// At session start Codex may not have written the rollout yet: a marker that owes only
// SessionStart's work is not charged for it. One that also owes a timeline still is.
for (const [fields, attempts] of [[{ sessionStart: true }, 0], [{ sessionStart: true, timeline: true }, 1], [{}, 1]]) {
  test(`an unresolvable transcript charges a ${JSON.stringify(fields)} marker ${attempts} attempt(s)`, async (t) => {
    makeHome(t, 'upload-worker-');
    markUploadDue('s-1', fields, { now: () => T0 - 1000 });
    // No tokened session: the default session-start handler has no account to ask, and settles.
    const result = await dueRun(async () => ({ outcome: 'deferred', reason: 'not-checkpointed' }), { sessions: [] });
    assert.deepEqual(result, { progress: 0, remaining: 0 });
    assert.deepEqual(listUploadDue().map((e) => e.attempts), [attempts]);
  });
}

// The grace is 24 h: past it, a SessionStart-only marker whose rollout never appeared is charged like
// any other, so the cap drops it instead of re-checkpointing it (a sessions-tree walk) every run.
for (const [age, attempts] of [[DAY - 1, 0], [DAY, 1]]) {
  test(`a SessionStart-only marker ${age} ms old is charged ${attempts} attempt(s) for a missing transcript`, async (t) => {
    makeHome(t, 'upload-worker-');
    markUploadDue('s-1', { sessionStart: true }, { now: () => T0 - age });
    const result = await dueRun(async () => ({ outcome: 'deferred', reason: 'not-checkpointed' }), { sessions: [] });
    assert.deepEqual(result, { progress: 0, remaining: 0 });
    assert.deepEqual(listUploadDue().map((e) => e.attempts), [attempts]);
  });
}

test('a SessionStart-only marker older than 7 days is dropped as start-expired without a checkpoint', async (t) => {
  makeHome(t, 'upload-worker-');
  markUploadDue('s-old', { sessionStart: true }, { now: () => T0 - 7 * DAY - 1 });
  markUploadDue('s-edge', { sessionStart: true }, { now: () => T0 - 7 * DAY });
  markUploadDue('s-turn', { sessionStart: true, timeline: true }, { now: () => T0 - 30 * DAY });
  const checkpointed = [];
  const result = await dueRun(async (input) => { checkpointed.push(input.session_id); return { outcome: 'committed', timelineConfirmed: true }; }, { sessions: [] });
  assert.deepEqual(checkpointed.sort(), ['s-edge', 's-turn']);
  assert.deepEqual(result, { progress: 3, remaining: 0 });
  assert.deepEqual(readUploadStatus().dueDropped, { sessionId: 's-old', reason: 'start-expired', attempts: 0, at: 1793872800000 });
});

// ── one drainer: the queue step records the files an absent route kept ──────────────────────────

test('the queue step records each answered account\'s route-absent files, keeping an unanswered account\'s last list', async (t) => {
  makeHome(t, 'upload-worker-');
  writeUploadStatusForTest({ routeAbsent: { [KEY_A]: ['stale.json'], [KEY_B]: ['b_1-2.json'] } });
  const flushQueue = async (key) => (key === KEY_A
    ? { flushed: 0, failed: 2, routeAbsent: 1, routeAbsentFiles: ['a_1-2.json'] }
    : { lockSkipped: true });
  await stepNamed('queue').run(ctxOf({ sessions: [session(KEY_A), session(KEY_B)], deps: { flushQueue } }));
  assert.deepEqual(readUploadStatus().routeAbsent, { [KEY_A]: ['a_1-2.json'], [KEY_B]: ['b_1-2.json'] });
});

test('an account whose drain kept nothing for an absent route has its list emptied, capped lists stay at 200', async (t) => {
  makeHome(t, 'upload-worker-');
  const many = Array.from({ length: 250 }, (_, i) => `f${i}.json`);
  await stepNamed('queue').run(ctxOf({ deps: { flushQueue: async () => ({ flushed: 0, failed: 250, routeAbsent: 250, routeAbsentFiles: many }) } }));
  assert.equal(readUploadStatus().routeAbsent[KEY_A].length, 200);
  await stepNamed('queue').run(ctxOf({ deps: { flushQueue: async () => ({ flushed: 1 }) } }));
  assert.deepEqual(readUploadStatus().routeAbsent, { [KEY_A]: [] });
});

// ── final review: a session that ran entirely before the link is past ──────────────────────────
// A fresh install's SessionStart used to mark its session due before any account was linked; after
// a later login the worker checkpointed it from cursor 0 and reported a past session as live. Past
// sessions go through the history offer only. The worker's due checkpoint applies the offer's own
// cutoff (a session last written before the link is past) to a session with no cursor yet.

const HOUR = 3600000;

function pastSessionWorld(home, { linkAtMs, writtenAtMs, cursor = null }) {
  linkAccount(home, KEY_A);
  fs.writeFileSync(path.join(home, 'accounts', KEY_A, 'tracking.json'), JSON.stringify({ version: 1, linkedAt: new Date(linkAtMs).toISOString() }));
  const transcriptPath = path.join(home, 'rollout-s-1.jsonl');
  fs.writeFileSync(transcriptPath, '\n');
  fs.utimesSync(transcriptPath, writtenAtMs / 1000, writtenAtMs / 1000);
  if (cursor !== null) {
    fs.mkdirSync(path.join(home, 'state'), { recursive: true });
    fs.writeFileSync(path.join(home, 'state', 's-1.json'), JSON.stringify({ cursor, sessionId: 's-1', cwd: home, transcriptPath }));
  }
  markUploadDue('s-1', { transcriptPath, cwd: home, timeline: false }, { now: () => T0 - 1000 });
  const segment = {
    repoRoot: home, branch: 'main', fromLine: 1, toLine: 4,
    stats: {
      models: { 'gpt-5.2-codex': { token_input: 10, token_output: 5, token_cache_read: 0, token_cache_creation: 0, requests: 1 } },
      token_total: 15, token_input: 10, token_output: 5, token_cache: 0, duration_sec: 12,
      code_changes: { files_changed: 0, lines_added: 0, lines_removed: 0, by_extension: {} },
      operations: {}, started_at: '2026-11-05T08:00:00.000Z', ended_at: '2026-11-05T08:00:12.000Z',
    },
  };
  const checkpointDeps = {
    computeDelta: () => ({ nextCursor: 4, segments: [segment], apiErrorEvents: [] }),
    gitImpl: () => 'https://host/org/repo.git',
    resolveSessionName: () => 'past work',
    findPlanPredecessor: () => null,
  };
  return { transcriptPath, checkpointDeps };
}

const queued = (key) => { try { return fs.readdirSync(path.join(process.env.BEEZI_CODEX_HOME, 'accounts', key, 'queue')); } catch { return []; } };

const pastCases = [
  { name: 'a session last written before the link, with no cursor, is past: nothing is queued and the marker clears',
    linkAtMs: T0 - HOUR, writtenAtMs: T0 - 2 * HOUR, cursor: null, queuedFiles: 0 },
  { name: 'a session last written after the link, with no cursor yet, is live and queued',
    linkAtMs: T0 - 2 * HOUR, writtenAtMs: T0 - HOUR, cursor: null, queuedFiles: 1 },
  { name: 'a session with a cursor of its own is live whenever it was last written',
    linkAtMs: T0 - HOUR, writtenAtMs: T0 - 2 * HOUR, cursor: 2, queuedFiles: 1 },
];

for (const c of pastCases) {
  test(c.name, async (t) => {
    const home = makeHome(t, 'upload-worker-');
    const { checkpointDeps } = pastSessionWorld(home, c);
    const fetchCalls = [];
    const fetchImpl = async (url) => { fetchCalls.push(String(url)); throw new Error('offline'); };
    const result = await stepNamed('due-sessions').run(ctxOf({
      due: listUploadDue(), fetchImpl, deps: { runCheckpoint: realRunCheckpoint, checkpointDeps },
    }));
    assert.deepEqual(result, { progress: 1, remaining: 0 });
    assert.equal(queued(KEY_A).length, c.queuedFiles);
    assert.deepEqual(listUploadDue(), []);
    assert.deepEqual(fetchCalls, []);
  });
}
