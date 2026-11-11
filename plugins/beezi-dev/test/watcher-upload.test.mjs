import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runWatchPass, loadObservations } from '../lib/rollout-watcher.mjs';
import { forgetHeldLocks } from '../lib/single-instance-lock.mjs';
import { queueDir } from '../lib/paths.mjs';
import { writeUploadStatus } from '../lib/upload-worker.mjs';
import { runAudit as realRunAudit } from '../lib/session-audit.mjs';
import { makeMachine as sandboxMachine, uuid } from '../tools/suite-fixtures.mjs';
import { accountSession, TEST_KEY } from '../tools/account-fixtures.mjs';

// ONE DRAINER: the MCP rollout watcher saves to disk and starts the background upload worker; it
// never sends the live queue itself. Path A (an established session) needs no credential at all:
// a local-only checkpoint and an index read. Paths B and C still read credentials, because the
// coverage question and the history sync ask the server — but neither drains the queue.

const makeMachine = (t) => sandboxMachine(t, 'watcher-upload-');
const NOW = 2_000_000_000;
const SESSION = accountSession(TEST_KEY, 'token');
// The accounts.json row the index read answers with: linked, no token.
const ROW = { key: TEST_KEY, email: SESSION.email, name: SESSION.name, tenantName: SESSION.tenantName, clientId: SESSION.clientId, status: 'linked' };

test.afterEach(() => forgetHeldLocks());

function writeRollout(machine, id, mtimeMs) {
  const dir = path.join(machine.sessionsDir, '2026', '09', '10');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-09-10T00-00-00-${id}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/repo' } })}\n`);
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

function writeCursor(machine, id) {
  fs.mkdirSync(path.join(machine.home, 'state'), { recursive: true });
  fs.writeFileSync(path.join(machine.home, 'state', `${id}.json`), JSON.stringify({ cursor: 4, sessionId: id }));
}

function writeQueueFile(name) {
  fs.mkdirSync(queueDir(TEST_KEY), { recursive: true });
  fs.writeFileSync(path.join(queueDir(TEST_KEY), name), JSON.stringify({ segmentId: 'q:0-1', sessionId: 'q' }));
}

// Every credential reader throws and counts: the full guard, linkedSessions, the token path.
function passDeps(overrides) {
  const calls = { checkpoints: [], audits: [], credentialReads: [], triggers: 0, coverage: 0, pending: [] };
  const deps = {
    now: () => NOW,
    hookMayProceed: () => { calls.credentialReads.push('guard'); throw new Error('credential read'); },
    linkedSessions: async () => { calls.credentialReads.push('linkedSessions'); throw new Error('credential read'); },
    hookMayProceedLocal: () => true,
    listAccounts: async () => [ROW],
    runCheckpoint: async (input, _d, options) => {
      calls.checkpoints.push({ id: input.session_id, options });
      return { outcome: 'committed', enqueued: 1, skipped: {} };
    },
    runAudit: async (_d, options) => { calls.audits.push(options); return { ok: true, reason: null }; },
    pruneStale: () => {},
    fetchCoverage: async () => { calls.coverage += 1; return new Map(); },
    loadCoverageCheckpoints: () => ({ version: 1, sessions: {} }),
    loadLedger: () => ({ sessions: {}, unreadable: {} }),
    readTrackingState: () => ({ linkedAt: '1970-01-01T00:00:00.000Z' }),
    isLiveTrackingAllowed: () => true,
    pendingHistoryDue: async () => false,
    runDuePendingHistory: async (d) => { calls.pending.push(d); return []; },
    maybeSpawnUploadWorker: () => { calls.triggers += 1; return 'disabled'; },
    yieldControl: async () => {},
    ...overrides,
  };
  return { deps, calls };
}

const opts = (machine, extra) => ({ sessionsDir: machine.sessionsDir, cooldownMs: 0, ...extra });

test('an established session is captured local-only and the worker started, with every credential reader throwing', async (t) => {
  const m = makeMachine(t);
  const id = uuid(1);
  writeRollout(m, id, NOW - 1000);
  writeCursor(m, id);
  const { deps, calls } = passDeps({});

  const out = await runWatchPass(deps, opts(m));

  assert.deepEqual(calls.credentialReads, []);
  assert.equal(out.errors, 0);
  assert.equal(out.succeeded, 1);
  assert.deepEqual(calls.checkpoints.map((c) => [c.id, c.options.localOnly, c.options.emitTimeline]), [[id, true, true]]);
  assert.equal('drainRateLimits' in calls.checkpoints[0].options, false, 'the worker sends the rate-limit rows');
  assert.equal(calls.triggers, 1);
});

test('an idle tick reads no credential and starts no worker', async (t) => {
  const m = makeMachine(t);
  const { deps, calls } = passDeps({});
  const out = await runWatchPass(deps, opts(m));
  assert.deepEqual(calls.credentialReads, []);
  assert.equal(calls.triggers, 0);
  assert.equal(out.checkpointed, 0);
});

test('an index with no linked account: an established session is not captured, and no credential is read', async (t) => {
  const m = makeMachine(t);
  const id = uuid(2);
  writeRollout(m, id, NOW - 1000);
  writeCursor(m, id);
  const { deps, calls } = passDeps({ listAccounts: async () => [] });
  const out = await runWatchPass(deps, opts(m));
  assert.equal(out.reason, 'unlinked');
  assert.deepEqual(calls.checkpoints, []);
  assert.deepEqual(calls.credentialReads, []);
});

test('the credential-free guard runs before discovery: a blocked root scans nothing', async (t) => {
  const m = makeMachine(t);
  const id = uuid(3);
  writeRollout(m, id, NOW - 1000);
  writeCursor(m, id);
  const heads = [];
  const { deps, calls } = passDeps({
    hookMayProceedLocal: () => false,
    readRolloutHead: (file) => { heads.push(file); return []; },
  });
  const out = await runWatchPass(deps, opts(m));
  assert.equal(out.reason, 'environment-blocked');
  assert.equal(out.scanned, 0);
  assert.deepEqual(heads, []);
  assert.deepEqual(calls.checkpoints, []);
  assert.deepEqual(calls.credentialReads, []);
});

// Path B, through the REAL reconcileSession: its drain step is the watcher's stand-in, which sends nothing.
function pathBDeps(overrides) {
  return passDeps({ hookMayProceed: () => true, linkedSessions: async () => [SESSION], ...overrides });
}

test('path B with a queued report: no drain and no post, the session defers and the worker is started', async (t) => {
  const m = makeMachine(t);
  const id = uuid(4);
  writeRollout(m, id, NOW - 1000);
  writeQueueFile('q_0-1.json');
  const { deps, calls } = pathBDeps({});

  const out = await runWatchPass(deps, opts(m));

  assert.equal(calls.coverage, 0, 'no coverage question over an undrained queue');
  assert.deepEqual(calls.checkpoints, []);
  assert.equal(out.deferredUnavailable, 1);
  assert.equal(calls.triggers, 1);
  assert.deepEqual(fs.readdirSync(queueDir(TEST_KEY)), ['q_0-1.json'], 'the report is still on disk, for the worker');
});

test('path B with only a held workspace-ask file: the session is established, local-only', async (t) => {
  const m = makeMachine(t);
  const id = uuid(5);
  writeRollout(m, id, NOW - 1000);
  writeQueueFile('q_0-1__ask.qjson');
  const { deps, calls } = pathBDeps({});

  const out = await runWatchPass(deps, opts(m));

  assert.equal(calls.coverage, 1);
  assert.equal(out.established, 1);
  assert.deepEqual(calls.checkpoints.map((c) => [c.id, c.options.localOnly, c.options.startCursor]), [[id, true, 0]]);
  assert.equal(calls.triggers, 1);
});

test('path C asks the history sync not to drain, and a pass it deferred for the worker comes round in 5 minutes', async (t) => {
  const m = makeMachine(t);
  writeRollout(m, uuid(6), NOW - 2 * 60 * 60 * 1000);
  const { deps, calls } = passDeps({
    hookMayProceed: () => true,
    linkedSessions: async () => [SESSION],
    runAudit: async (_d, options) => {
      calls.audits.push(options);
      return { ok: true, reason: 'upload-busy', lastError: 'queued reports wait for the background upload' };
    },
  });

  await runWatchPass(deps, opts(m));
  assert.deepEqual(calls.audits.map(({ queuedBefore, ...rest }) => rest), [{ scope: 'live', liveOnly: true, key: TEST_KEY, drainQueue: false }]);
  // Retried 5 minutes on, not 6 hours: the worker usually empties the queue within seconds.
  assert.equal(loadObservations({}).historyAt, NOW - 6 * 60 * 60 * 1000 + 5 * 60 * 1000);

  const soon = passDeps({ ...deps, now: () => NOW + 4 * 60 * 1000 });
  soon.deps.runAudit = async (_d, options) => { soon.calls.audits.push(options); return { ok: true, reason: null }; };
  await runWatchPass(soon.deps, opts(m));
  assert.equal(soon.calls.audits.length, 0, 'not before the 5 minutes');

  const later = passDeps({ ...deps, now: () => NOW + 5 * 60 * 1000 });
  later.deps.runAudit = async (_d, options) => { later.calls.audits.push(options); return { ok: true, reason: null }; };
  await runWatchPass(later.deps, opts(m));
  assert.equal(later.calls.audits.length, 1);
  assert.equal(loadObservations({}).historyAt, NOW + 5 * 60 * 1000, 'a pass that ran waits the full interval again');
});

test('pending history from the watcher runs every audit with drainQueue false', async (t) => {
  const m = makeMachine(t);
  const { deps, calls } = passDeps({
    hookMayProceed: () => true,
    linkedSessions: async () => [SESSION],
    pendingHistoryDue: async () => true,
  });
  await runWatchPass(deps, opts(m));

  assert.equal(calls.pending.length, 1);
  await calls.pending[0].runAudit({ runCache: null }, { key: TEST_KEY, tenantId: 't1' });
  assert.deepEqual(calls.audits.map(({ queuedBefore, ...rest }) => rest), [{ key: TEST_KEY, tenantId: 't1', drainQueue: false }]);
});

test('path C deferred over reports the worker already left waits the full interval, not 5 minutes', async (t) => {
  const m = makeMachine(t);
  writeRollout(m, uuid(7), NOW - 2 * 60 * 60 * 1000);
  const { deps } = passDeps({
    hookMayProceed: () => true,
    linkedSessions: async () => [SESSION],
    runAudit: async () => ({ ok: true, reason: 'pending-not-drained', lastError: 'queued reports the background upload could not deliver' }),
  });
  await runWatchPass(deps, opts(m));
  assert.equal(loadObservations({}).historyAt, NOW);
});

// ── fix round: what path B and path C wait on ───────────────────────────────────────────────────

// A path-A capture that, like the real local checkpoint, leaves a report in the queue.
const capturingCheckpoint = (calls) => async (input, _d, options) => {
  calls.checkpoints.push({ id: input.session_id, options });
  if (options.startCursor === undefined) writeQueueFile(`${input.session_id}_0-4.json`);
  return { outcome: 'committed', enqueued: 1, skipped: {} };
};

test('an established and a fresh session in one pass: the capture of the first does not stop the second establishing', async (t) => {
  const m = makeMachine(t);
  const established = uuid(8);
  const fresh = uuid(9);
  writeRollout(m, established, NOW - 2000);
  writeCursor(m, established);
  writeRollout(m, fresh, NOW - 1000);
  const { deps, calls } = pathBDeps({});
  deps.runCheckpoint = capturingCheckpoint(calls);

  const out = await runWatchPass(deps, opts(m));

  assert.equal(out.established, 1);
  assert.deepEqual(calls.checkpoints.map((c) => [c.id, c.options.startCursor]), [[established, undefined], [fresh, 0]]);
});

test('a leftover the worker kept for an absent report route does not stop path B establishing', async (t) => {
  const m = makeMachine(t);
  const id = uuid(10);
  writeRollout(m, id, NOW - 1000);
  writeQueueFile('old_0-1.json');
  writeUploadStatus({ routeAbsent: { [TEST_KEY]: ['old_0-1.json'] } });
  const { deps, calls } = pathBDeps({});

  const out = await runWatchPass(deps, opts(m));

  assert.equal(out.established, 1);
  assert.equal(calls.coverage, 1);
});

test('a 5xx leftover from before the pass still defers path B', async (t) => {
  const m = makeMachine(t);
  const id = uuid(11);
  writeRollout(m, id, NOW - 1000);
  writeQueueFile('old_0-1.json');
  writeQueueFile('gone_0-1.json');
  // Route-absent is exactly what the worker recorded: another file is not covered by it.
  writeUploadStatus({ routeAbsent: { [TEST_KEY]: ['gone_0-1.json'] } });
  const { deps, calls } = pathBDeps({});

  const out = await runWatchPass(deps, opts(m));

  assert.equal(out.established, 0);
  assert.equal(out.deferredUnavailable, 1);
  assert.equal(calls.coverage, 0);
});

test('path C and pending history wait on the queue as it stood before the pass, plus the captured session\'s report', async (t) => {
  const m = makeMachine(t);
  const established = uuid(12);
  writeRollout(m, established, NOW - 2000);
  writeCursor(m, established);
  writeRollout(m, uuid(13), NOW - 2 * 60 * 60 * 1000);
  writeQueueFile('before_0-1.json');
  const { deps, calls } = passDeps({
    hookMayProceed: () => true,
    linkedSessions: async () => [SESSION],
    pendingHistoryDue: async () => true,
  });
  deps.runCheckpoint = capturingCheckpoint(calls);

  await runWatchPass(deps, opts(m));
  await calls.pending[0].runAudit({}, { key: TEST_KEY });

  assert.equal(calls.audits.length, 2);
  for (const options of calls.audits) {
    assert.equal(options.drainQueue, false);
    // The queue before the pass, plus this pass's report for the session it captured (fix round 2).
    assert.deepEqual([...options.queuedBefore.get(TEST_KEY)], ['before_0-1.json', `${established}_0-4.json`]);
  }
});

// ── fix round 2: a session path A captured in this pass is not audited from under its own report ──

// A quiet established session (a resume an hour old) moved, so path A captures it; its report is
// queued, unsent. The due history audit would replay from the stored coverage line and upload the
// same lines again, so it must wait on that report like any report queued before the pass.
test('a quiet established session captured in this pass makes the due history audit wait: it uploads nothing', async (t) => {
  const m = makeMachine(t);
  const resumed = uuid(14);
  writeRollout(m, resumed, NOW - 2 * 60 * 60 * 1000);
  writeCursor(m, resumed);
  writeRollout(m, uuid(15), NOW - 2 * 60 * 60 * 1000);
  let listed = 0;
  let posted = 0;
  const { deps, calls } = passDeps({
    hookMayProceed: () => true,
    linkedSessions: async () => [SESSION],
    runAudit: (_d, options) => {
      calls.audits.push(options);
      return realRunAudit({
        linkedSessions: async () => [SESSION],
        readTrackingStateImpl: () => null,
        maybeSpawnUploadWorker: () => 'disabled',
        listRollouts: () => { listed += 1; return []; },
        flushBackfillChunksImpl: async () => { posted += 1; throw new Error('nothing may be uploaded'); },
      }, options);
    },
  });
  deps.runCheckpoint = capturingCheckpoint(calls);

  const out = await runWatchPass(deps, opts(m));

  assert.deepEqual(calls.checkpoints.map((c) => c.id), [resumed]);
  assert.deepEqual([...calls.audits[0].queuedBefore.get(TEST_KEY)], [`${resumed}_0-4.json`]);
  assert.deepEqual(out.history.map((h) => [h.reason, h.lastError]), [['upload-busy', 'queued reports wait for the background upload']]);
  assert.equal(listed, 0);
  assert.equal(posted, 0);
});
