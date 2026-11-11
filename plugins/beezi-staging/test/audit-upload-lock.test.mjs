import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runAudit } from '../lib/session-audit.mjs';
import { BackfillSessionStatus } from '../lib/audit-flush.mjs';
import { acquireLock, heldLocks, forgetHeldLocks } from '../lib/single-instance-lock.mjs';
import { queueDir } from '../lib/paths.mjs';
import { accountSession, TEST_KEY } from '../tools/account-fixtures.mjs';
import { classifyRun } from '../lib/pending-history-run.mjs';
import { RunOutcome } from '../lib/pending-history.mjs';

// ONE DRAINER for the history sync: runAudit's drain before reconciliation (R2) holds the upload
// worker's runLock('upload'), and the MCP watcher's unprompted pass (drainQueue: false) drains
// nothing — it hands a non-empty queue to the background worker and defers.
//
// 'upload' and 'backfill' are both rank-1 run locks and the primitive refuses the second whichever
// comes first, so the drain runs BEFORE the history lock is taken, never inside it.

const KEY = TEST_KEY;
const SESSION = accountSession(KEY, 'tok');

test.afterEach(() => {
  forgetHeldLocks();
  fs.rmSync(queueDir(KEY), { recursive: true, force: true });
});

const rollout = (sessionId) => ({
  sessionId,
  transcriptPath: `C:/sessions/2026/01/01/rollout-2026-01-01T00-00-00-${sessionId}.jsonl`,
  cwd: 'C:/work/app',
  mtimeMs: 1_000,
  size: 1024,
});

const emptyDrain = () => ({ flushed: 0, failed: 0, deferred: 0, unreadable: 0, trackingDisabled: false, lastError: null });

const held = () => heldLocks().map((l) => `${l.kind}:${l.name}`);

function makeDeps(overrides = {}) {
  const calls = { drains: [], coverage: 0, posted: [], triggers: 0, lockedDuringCheckpoint: [] };
  const deps = {
    now: () => 10 * 60 * 60 * 1000,
    linkedSessions: async () => [SESSION],
    getDefaultKey: async () => KEY,
    whoamiImpl: async () => ({ valid: true, trackingMode: 'live', backfillCompleted: false }),
    recordWhoamiImpl: () => {},
    listRollouts: () => [rollout('s1')],
    resolveTranscriptByCwdImpl: () => null,
    readStateImpl: () => null,
    readChatgptAuthImpl: () => null,
    readBillingConfigImpl: () => null,
    postJsonImpl: async () => ({ ok: true, status: 200, json: async () => ({ accountLinked: true }) }),
    readTrackingStateImpl: () => null,
    statImpl: () => { throw new Error('ENOENT'); },
    rolloutStartedAtImpl: () => null,
    flushQueueImpl: async (key) => { calls.drains.push({ key, locks: held() }); return emptyDrain(); },
    fetchCoverageImpl: async () => { calls.coverage += 1; return new Map(); },
    loadCoverageCheckpointsImpl: () => ({ version: 1, identity: null, environment: '', apiBase: null, sessions: {}, updatedAt: null }),
    saveCoverageCheckpointsImpl: () => true,
    runCheckpointImpl: async (input, _d, options) => {
      calls.lockedDuringCheckpoint.push(held());
      options.sink({ segmentId: `${input.session_id}:0-1`, sessionId: input.session_id, remote: 'r', branch: 'main' });
      return { outcome: 'committed', enqueued: 1, flush: null, sessionErrors: [], agents: {} };
    },
    flushBackfillChunksImpl: async (groups) => {
      for (const g of groups) calls.posted.push(g.sessionId);
      const bySession = new Map(groups.map((g) => [g.sessionId, { status: BackfillSessionStatus.ACCEPTED, reason: null }]));
      return { chunks: 1, stored: groups.length, skipped: 0, timelines: 0, timelinesDropped: 0, itemErrors: 0,
        retryableFailures: 0, permanentRejections: 0, unattributed: 0, bySession, halt: null, lastError: null };
    },
    loadLedgerImpl: () => ({ version: 1, identity: null, sessions: {}, unreadable: {}, updatedAt: null }),
    saveLedgerImpl: () => {},
    computeSessionTimelineImpl: () => null,
    postSessionErrorImpl: async () => ({ reported: true }),
    maybeSpawnUploadWorker: () => { calls.triggers += 1; return 'disabled'; },
    uploadLock: { maybeSpawnUploadWorker: () => { calls.triggers += 1; return 'disabled'; } },
    ...overrides,
  };
  return { deps, calls };
}

// A wait that never sees the lock free, on a clock the poll sleep advances.
function busyUpload(calls) {
  const state = { t: 0 };
  return {
    state,
    lock: {
      acquireLock: () => ({ ok: false, reason: 'held' }),
      now: () => state.t,
      sleep: async (ms) => { state.t += ms; },
      maybeSpawnUploadWorker: () => { calls.triggers += 1; return 'disabled'; },
    },
  };
}

function writeQueueFile(name) {
  fs.mkdirSync(queueDir(KEY), { recursive: true });
  fs.writeFileSync(path.join(queueDir(KEY), name), JSON.stringify({ segmentId: 'x:0-1', sessionId: 'x' }));
}

test('the drain runs under run-upload alone, and reconciliation under run-backfill alone', async () => {
  const { deps, calls } = makeDeps();
  const result = await runAudit(deps, { key: KEY });

  assert.equal(result.ok, true);
  assert.equal(result.reason, null);
  assert.deepEqual(calls.drains, [{ key: KEY, locks: ['run:run-upload'] }]);
  assert.deepEqual(calls.lockedDuringCheckpoint, [['run:run-backfill']]);
  assert.deepEqual(calls.posted, ['s1']);
  assert.deepEqual(held(), []);
});

test('a worker holding run-upload for the whole 60 s wait: busy, nothing drained, asked or posted', async () => {
  const { deps, calls } = makeDeps();
  const busy = busyUpload(calls);
  deps.uploadLock = busy.lock;
  const result = await runAudit(deps, { key: KEY });

  assert.equal(busy.state.t, 60000);
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'upload-busy');
  assert.equal(result.lastError, 'the background upload is sending');
  assert.deepEqual(calls.drains, []);
  assert.equal(calls.coverage, 0);
  assert.deepEqual(calls.posted, []);
});

test('a lock-order refusal on run-upload is surfaced as lock-order, never as busy', async () => {
  const { deps, calls } = makeDeps();
  deps.uploadLock = { acquireLock: () => ({ ok: false, reason: 'lock-order', detail: 'rank 1 under rank 1' }) };
  const result = await runAudit(deps, { key: KEY });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'lock-order');
  assert.equal(result.lastError, 'rank 1 under rank 1');
  assert.deepEqual(calls.drains, []);
});

test('drainQueue false with a queued report: no drain, the worker is started, the run defers as busy', async () => {
  writeQueueFile('s9_0-1.json');
  const { deps, calls } = makeDeps();
  const result = await runAudit(deps, { key: KEY, drainQueue: false });

  assert.deepEqual(calls.drains, []);
  assert.equal(calls.triggers, 1);
  // Busy, not failed: a pending-history retry waits minutes, not a failure count.
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'upload-busy');
  assert.equal(result.lastError, 'queued reports wait for the background upload');
  assert.equal(calls.coverage, 0);
  assert.deepEqual(calls.posted, []);
});

test('drainQueue false with only a held workspace-ask file: no drain, and the run proceeds', async () => {
  writeQueueFile('s9_0-1__ask.qjson');
  const { deps, calls } = makeDeps();
  const result = await runAudit(deps, { key: KEY, drainQueue: false });

  assert.deepEqual(calls.drains, []);
  assert.equal(calls.triggers, 0);
  assert.equal(result.reason, null);
  assert.deepEqual(calls.posted, ['s1']);
});

test('drainQueue false takes no upload lock at all', async () => {
  const { deps, calls } = makeDeps();
  deps.uploadLock = { acquireLock: () => { throw new Error('the watcher pass takes no upload lock'); } };
  const result = await runAudit(deps, { key: KEY, drainQueue: false });
  assert.equal(result.reason, null);
  assert.deepEqual(calls.posted, ['s1']);
});

test('a report a hook queued between the drain and run-backfill stops the run before coverage', async () => {
  const { deps, calls } = makeDeps({
    // The window the sequential order opens: the upload lock is released, the history lock not yet taken.
    acquireLockImpl: (target, options) => {
      writeQueueFile('late_0-1.json');
      return acquireLock(target, options);
    },
  });
  const result = await runAudit(deps, { key: KEY });

  assert.equal(calls.drains.length, 1);
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'pending-not-drained');
  assert.equal(result.lastError, 'reports were queued after the drain');
  assert.equal(calls.coverage, 0);
  assert.deepEqual(calls.posted, []);
  assert.deepEqual(held(), []);
});

test('a file that was queued before the drain and that the drain kept (held for a workspace) does not stop the run', async () => {
  writeQueueFile('kept_0-1__t-gone.qjson');
  const { deps, calls } = makeDeps({
    flushQueueImpl: async (key) => { calls.drains.push({ key, locks: held() }); return { ...emptyDrain(), workspacePending: 1 }; },
  });
  const result = await runAudit(deps, { key: KEY });
  assert.equal(result.reason, null);
  assert.deepEqual(calls.posted, ['s1']);
});

test('a report a hook queued DURING the drain, and the drain did not send, stops the run', async () => {
  const { deps, calls } = makeDeps({
    flushQueueImpl: async (key) => {
      calls.drains.push({ key, locks: held() });
      writeQueueFile('during_0-1.json');
      return emptyDrain();
    },
  });
  const result = await runAudit(deps, { key: KEY });
  assert.equal(result.reason, 'pending-not-drained');
  assert.equal(result.lastError, 'reports were queued after the drain');
  assert.deepEqual(calls.posted, []);
});

// A report the worker already tried and left (5xx, route absent, a 401) is older than its last run:
// that is not a run in progress, and treating it as one would retry the watcher's pass every few
// minutes forever. The base answer comes back — the queue is not drained.
test('drainQueue false with only reports the worker already left behind: not drained, not busy', async () => {
  writeQueueFile('old_0-1.json');
  fs.utimesSync(path.join(queueDir(KEY), 'old_0-1.json'), 1000, 1000);
  const { deps, calls } = makeDeps({ readUploadStatus: () => ({ lastRunAt: 2_000_000 }) });
  const result = await runAudit(deps, { key: KEY, drainQueue: false });
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'pending-not-drained');
  assert.equal(result.lastError, 'queued reports the background upload could not deliver');
  assert.equal(classifyRun(result, false), RunOutcome.FAILED);
  assert.deepEqual(calls.drains, []);
  assert.deepEqual(calls.posted, []);
});

// The worker's last run ended with work still on disk (`pendingWork`): the trigger starts the next
// one once its backoff passes, so an old report is a retry on its way, not the drain's verdict.
test('drainQueue false with an old report while the worker still owes work: busy, not failed', async () => {
  writeQueueFile('old_0-1.json');
  fs.utimesSync(path.join(queueDir(KEY), 'old_0-1.json'), 1000, 1000);
  const { deps, calls } = makeDeps({ readUploadStatus: () => ({ lastRunAt: 2_000_000, pendingWork: true }) });
  const result = await runAudit(deps, { key: KEY, drainQueue: false });
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'upload-busy');
  assert.equal(result.lastError, 'queued reports wait for the background upload');
  assert.equal(classifyRun(result, false), RunOutcome.BUSY);
  assert.equal(calls.triggers, 1);
  assert.deepEqual(calls.drains, []);
  assert.deepEqual(calls.posted, []);
});

test('drainQueue false with a report newer than the worker\'s last run: busy, the worker has not tried it', async () => {
  writeQueueFile('old_0-1.json');
  fs.utimesSync(path.join(queueDir(KEY), 'old_0-1.json'), 1000, 1000);
  writeQueueFile('new_0-1.json');
  fs.utimesSync(path.join(queueDir(KEY), 'new_0-1.json'), 3000, 3000);
  const { deps, calls } = makeDeps({ readUploadStatus: () => ({ lastRunAt: 2_000_000 }) });
  const result = await runAudit(deps, { key: KEY, drainQueue: false });
  assert.equal(result.reason, 'upload-busy');
  assert.equal(calls.triggers, 1);
});

// A queue that keeps failing (5xx): the worker's last run failed with the report on disk. Still busy
// (retried in minutes), but flagged so the pending-history request counts a failure and cannot
// expire silently. Only a run that tried and failed charges; one cut by its deadline, or an unlinked
// or dark machine, does not.
const FAILING_CASES = [
  { outcome: 'stalled', failing: true },
  { outcome: 'crash', failing: true },
  { outcome: 'watchdog', failing: true },
  { outcome: 'lock-failed', failing: true },
  { outcome: 'deadline', failing: undefined },
  { outcome: 'no-accounts', failing: undefined },
  { outcome: 'tracking-disabled', failing: undefined },
];
for (const c of FAILING_CASES) {
  test(`drainQueue false behind a worker whose last run ended ${c.outcome} with the report on disk: busy, uploadFailing ${c.failing}`, async () => {
    writeQueueFile('old_0-1.json');
    fs.utimesSync(path.join(queueDir(KEY), 'old_0-1.json'), 1000, 1000);
    const { deps } = makeDeps({ readUploadStatus: () => ({ lastRunAt: 2_000_000, pendingWork: true, outcome: c.outcome }) });
    const result = await runAudit(deps, { key: KEY, drainQueue: false });
    assert.equal(result.reason, 'upload-busy');
    assert.equal(result.uploadFailing, c.failing);
    assert.equal(classifyRun(result, false), RunOutcome.BUSY);
  });
}

test('drainQueue false while a worker is running: busy and uncharged, even after a failed run', async () => {
  writeQueueFile('old_0-1.json');
  fs.utimesSync(path.join(queueDir(KEY), 'old_0-1.json'), 1000, 1000);
  const { deps, calls } = makeDeps({
    readUploadStatus: () => ({ lastRunAt: 2_000_000, pendingWork: true, outcome: 'stalled', state: 'running' }),
    maybeSpawnUploadWorker: () => { calls.triggers += 1; return 'running'; },
  });
  const result = await runAudit(deps, { key: KEY, drainQueue: false });
  assert.equal(result.reason, 'upload-busy');
  assert.equal(result.uploadFailing, undefined);
  assert.equal(calls.triggers, 1);
});

test('drainQueue false with only a report newer than a failed run that left nothing: busy and uncharged', async () => {
  writeQueueFile('new_0-1.json');
  fs.utimesSync(path.join(queueDir(KEY), 'new_0-1.json'), 3000, 3000);
  const { deps } = makeDeps({ readUploadStatus: () => ({ lastRunAt: 2_000_000, pendingWork: false, outcome: 'stalled' }) });
  const result = await runAudit(deps, { key: KEY, drainQueue: false });
  assert.equal(result.reason, 'upload-busy');
  assert.equal(result.uploadFailing, undefined);
});

// The watcher's pass hands over the queue as it stood before it captured anything: a report its own
// path-A capture queued since is no history this run reconciles, and is not "queued after the drain".
test('drainQueue false ignores reports not in queuedBefore, and does not count them as queued late', async () => {
  writeQueueFile('mine_0-4.json');
  const { deps, calls } = makeDeps();
  const result = await runAudit(deps, { key: KEY, drainQueue: false, queuedBefore: new Map([[KEY, new Set()]]) });
  assert.equal(result.reason, null);
  assert.equal(calls.triggers, 0);
  assert.deepEqual(calls.posted, ['s1']);
});

test('drainQueue false still waits for a report that was in queuedBefore', async () => {
  writeQueueFile('old_0-1.json');
  const { deps } = makeDeps();
  const result = await runAudit(deps, { key: KEY, drainQueue: false, queuedBefore: new Map([[KEY, new Set(['old_0-1.json'])]]) });
  assert.equal(result.reason, 'upload-busy');
});
