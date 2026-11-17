import '../tools/hermetic-env.mjs';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { runCheckpoint } from '../lib/checkpoint.mjs';
import { runUploadWorker, readUploadStatus } from '../lib/upload-worker.mjs';
import { listUploadDue } from '../lib/upload-due.mjs';
import { queueDir } from '../lib/paths.mjs';
import { acquireLock, runLock, forgetHeldLocks } from '../lib/single-instance-lock.mjs';
import { makeHome, linkAccount } from '../tools/account-fixtures.mjs';

// Hooks capture, the worker sends — end to end, with nothing between the two halves faked: a real
// local-only checkpoint of a fixture rollout writes the cursor, the queue file and the due marker,
// and a real worker run (real lock, real steps, real queue drain) delivers them through a fake
// server. The only fakes are the boundaries: git, the credential read, the guard and fetch.

afterEach(() => forgetHeldLocks());

const KEY = 'aaaa1111';
const SESSION_ID = '11111111-2222-3333-4444-555555555555';

function rollout(dir) {
  const file = path.join(dir, 'rollout.jsonl');
  const rows = [
    { type: 'session_meta', timestamp: '2026-11-05T09:00:00Z', payload: { id: SESSION_ID, cwd: dir } },
    { type: 'turn_context', timestamp: '2026-11-05T09:00:01Z', payload: { cwd: dir, model: 'gpt-5.2-codex' } },
    {
      type: 'event_msg',
      timestamp: '2026-11-05T09:00:02Z',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, cached_input_tokens: 0 } } },
    },
  ];
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  return file;
}

// The batch route stores every report it is sent; every other request answers 200 with no body.
function server() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const raw = init.headers['Content-Encoding'] === 'gzip' ? zlib.gunzipSync(init.body).toString('utf-8') : init.body;
    const body = typeof raw === 'string' && raw !== '' ? JSON.parse(raw) : null;
    calls.push({ url: String(url), body });
    const answer = String(url).endsWith('/sessions/report-batch')
      ? { results: body.reports.map((r) => ({ segmentId: r.segmentId, status: 'stored' })) }
      : {};
    const text = JSON.stringify(answer);
    return { status: 200, ok: true, text: async () => text, json: async () => answer };
  };
  return { calls, fetchImpl };
}

const listing = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };

const captureDeps = {
  gitImpl: () => null,
  readAgents: () => ({}),
  findSubagentRollouts: () => [],
  findPlanPredecessor: () => null,
};

test('a local-only capture is delivered by one worker run: one batch POST, then nothing queued or due', async (t) => {
  const home = makeHome(t, 'upload-e2e-');
  linkAccount(home, KEY);
  // Linked an hour before the session, as login stamps it.
  fs.writeFileSync(path.join(home, 'accounts', KEY, 'tracking.json'),
    JSON.stringify({ version: 1, linkedAt: new Date(Date.now() - 3600000).toISOString() }));
  const transcriptPath = rollout(home);

  // ── the hook half ──
  const captured = await runCheckpoint(
    { session_id: SESSION_ID, transcript_path: transcriptPath, cwd: home },
    { ...captureDeps, linkedSessions: async () => { throw new Error('no credential read on the hook path'); },
      fetchImpl: async () => { throw new Error('no network on the hook path'); } },
    { localOnly: true, emitTimeline: false, budgetMs: 17500 },
  );
  assert.equal(captured.outcome, 'committed');
  assert.equal(captured.uploadDue, true);
  assert.equal(listing(queueDir(KEY)).length, 1, 'the capture queued one report');
  assert.deepEqual(listUploadDue().map((e) => e.sessionId), [SESSION_ID]);

  // ── the worker half ──
  const srv = server();
  const out = await runUploadWorker({
    checkEnvironment: () => ({ status: 'ok' }),
    linkedSessions: async () => [{ key: KEY, token: 'tk-a', clientId: `c-${KEY}`, tenantId: null }],
    fetchImpl: srv.fetchImpl,
    checkpointDeps: captureDeps,
    setPriority: () => {},
    sleep: async () => {},
  });

  assert.equal(out.outcome, 'empty');
  const batches = srv.calls.filter((c) => c.url.endsWith('/sessions/report-batch'));
  const singles = srv.calls.filter((c) => c.url.endsWith('/sessions/report'));
  assert.equal(batches.length, 1, JSON.stringify(srv.calls.map((c) => c.url)));
  assert.equal(batches[0].body.reports.length, 1);
  assert.equal(batches[0].body.reports[0].sessionId, SESSION_ID);
  assert.deepEqual(singles, [], 'nothing went by the single route');
  assert.deepEqual(listing(queueDir(KEY)), [], 'the queue is empty');
  assert.deepEqual(listing(path.join(home, 'upload-due')), [], 'no session is still due');
});

test('a history run holding the lock for three passes delays the turn, not five minutes', async (t) => {
  const home = makeHome(t, 'upload-e2e-');
  linkAccount(home, KEY);
  fs.writeFileSync(path.join(home, 'accounts', KEY, 'tracking.json'),
    JSON.stringify({ version: 1, linkedAt: new Date(Date.now() - 3600000).toISOString() }));
  const transcriptPath = rollout(home);
  const captured = await runCheckpoint(
    { session_id: SESSION_ID, transcript_path: transcriptPath, cwd: home }, captureDeps,
    { localOnly: true, emitTimeline: true, budgetMs: 17500 },
  );
  assert.equal(captured.uploadDue, true);

  // Another process (a past-sessions scan, the installer's listing) holds the history run lock.
  assert.equal(acquireLock(runLock('backfill'), { leaseMs: 600000 }, { pid: () => process.ppid }).ok, true);
  forgetHeldLocks();

  const srv = server();
  let sleeps = 0;
  const out = await runUploadWorker({
    checkEnvironment: () => ({ status: 'ok' }),
    linkedSessions: async () => [{ key: KEY, token: 'tk-a', clientId: `c-${KEY}`, tenantId: null }],
    fetchImpl: srv.fetchImpl,
    checkpointDeps: captureDeps,
    setPriority: () => {},
    sleep: async () => {
      sleeps += 1;
      if (sleeps === 3) fs.unlinkSync(path.join(home, 'locks', 'run-backfill.lock'));
    },
  });

  assert.equal(out.outcome, 'empty');
  assert.deepEqual(listUploadDue(), []);
  assert.equal(readUploadStatus().retryAfterAt, null);
  assert.equal(srv.calls.filter((c) => c.url.endsWith('/sessions/report-batch')).length, 1, JSON.stringify(srv.calls.map((c) => c.url)));
});
