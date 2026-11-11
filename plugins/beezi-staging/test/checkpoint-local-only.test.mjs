import '../tools/hermetic-env.mjs';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCheckpoint } from '../lib/checkpoint.mjs';
import { queueDir, stateDir } from '../lib/paths.mjs';
import { listUploadDue } from '../lib/upload-due.mjs';
import { readSessionWorkspace } from '../lib/workspace.mjs';
import { grantConsent, grantCorrelation } from '../lib/diagnostics.mjs';
import { acquireLock, sessionLock, forgetHeldLocks } from '../lib/single-instance-lock.mjs';
import { KINDS } from '../lib/anonymize.mjs';
import { tmpHome as sandboxHome } from '../tools/suite-fixtures.mjs';
import { linkAccount, accountSession, TEST_KEY } from '../tools/account-fixtures.mjs';

// I-local: the hooks capture to disk and hand off. `localOnly` reads no credentials, makes no HTTP
// call, queues for every linked account tokenless, parks errors, then marks the session due and
// pokes the upload trigger — the worker does the network half.

afterEach(() => forgetHeldLocks());

const tmpHome = (t) => sandboxHome(t, 'beezi-local-');

const seg = (fromLine = 1, toLine = 4) => ({
  repoRoot: '/repo',
  branch: 'main',
  fromLine,
  toLine,
  stats: {
    models: { 'gpt-5.2-codex': { token_input: 10, token_output: 5, token_cache_read: 0, token_cache_creation: 0, requests: 1 } },
    token_total: 15, token_input: 10, token_output: 5, token_cache: 0,
    duration_sec: 12,
    code_changes: { files_changed: 0, lines_added: 0, lines_removed: 0, by_extension: {} },
    operations: {},
    started_at: '2026-01-01T00:00:00.000Z',
    ended_at: '2026-01-01T00:00:12.000Z',
  },
});

const API_ERROR = { error: 'usage_limit_exceeded', text: 'You hit the limit', occurredAt: '2026-01-01T00:00:10.000Z' };

function stubTranscript(home) {
  const p = path.join(home, 'rollout-s1.jsonl');
  fs.writeFileSync(p, '\n');
  return p;
}

const queueFiles = (key = TEST_KEY) => {
  let names = [];
  try { names = fs.readdirSync(queueDir(key)); } catch { names = []; }
  return names.sort().map((f) => JSON.parse(fs.readFileSync(path.join(queueDir(key), f), 'utf-8')));
};
const readState = (id) => JSON.parse(fs.readFileSync(path.join(stateDir(), `${id}.json`), 'utf-8'));

// Every network and credential seam throws AND counts, so a test proves both "never called" and
// "the run did not depend on it".
function world(home, over = {}) {
  const calls = { fetch: 0, linkedSessions: 0, getCredentials: 0, getDefaultKey: 0, drain: 0, trigger: 0 };
  const transcriptPath = stubTranscript(home);
  const deps = {
    linkedSessions: async () => { calls.linkedSessions += 1; throw new Error('no credential read on the hook path'); },
    getCredentials: async () => { calls.getCredentials += 1; throw new Error('no credential read on the hook path'); },
    getDefaultKey: async () => { calls.getDefaultKey += 1; throw new Error('no index migration on the hook path'); },
    fetchImpl: async () => { calls.fetch += 1; throw new Error('no network on the hook path'); },
    drainRateLimitSnapshots: async () => { calls.drain += 1; throw new Error('no usage drain on the hook path'); },
    findPlanPredecessor: () => null,
    resolveTranscript: () => ({ transcriptPath, sessionId: 's1' }),
    computeDelta: () => ({ nextCursor: 4, segments: [seg()], apiErrorEvents: [API_ERROR] }),
    gitImpl: () => 'https://host/org/repo.git',
    resolveSessionName: () => 'fix the login bug',
    maybeSpawnUploadWorker: () => { calls.trigger += 1; return 'spawned'; },
    ...over,
  };
  return { deps, calls, transcriptPath };
}

const STOP = { localOnly: true, emitTimeline: true, budgetMs: 17500 };
const POST_TOOL_USE = { localOnly: true, emitTimeline: false, budgetMs: 17500 };

test('a local-only turn end with throwing credential and fetch fakes still enqueues, parks, marks due and triggers once', async (t) => {
  const home = tmpHome(t);
  linkAccount(home);
  const { deps, calls, transcriptPath } = world(home);

  const result = await runCheckpoint({ session_id: 's1', cwd: home }, deps, STOP);

  assert.equal(result.outcome, 'committed');
  assert.deepEqual(queueFiles().map((p) => p.segmentId), ['s1:1-4']);
  const state = readState('s1');
  assert.equal(state.cursor, 4);
  assert.equal(state.pendingErrors.length, 1);
  assert.equal(state.pendingErrors[0].error, 'usage_limit_exceeded');
  assert.deepEqual(state.pendingErrors[0].deliveredTo, []);
  const due = listUploadDue();
  assert.equal(due.length, 1);
  assert.equal(due[0].sessionId, 's1');
  assert.equal(due[0].transcriptPath, transcriptPath);
  assert.equal(due[0].cwd, home);
  assert.equal(due[0].timeline, true);
  assert.equal(due[0].sessionStart, false);
  assert.equal(calls.trigger, 1);
  assert.deepEqual(
    { fetch: calls.fetch, linkedSessions: calls.linkedSessions, getCredentials: calls.getCredentials,
      getDefaultKey: calls.getDefaultKey, drain: calls.drain },
    { fetch: 0, linkedSessions: 0, getCredentials: 0, getDefaultKey: 0, drain: 0 },
  );
  assert.equal(result.flush, null);
  assert.equal(result.timelineConfirmed, null);
});

test('a local-only PostToolUse checkpoint marks the session due without a timeline', async (t) => {
  const home = tmpHome(t);
  linkAccount(home);
  const { deps, calls } = world(home);

  const result = await runCheckpoint({ session_id: 's1', cwd: home }, deps, POST_TOOL_USE);

  assert.equal(result.outcome, 'committed');
  assert.deepEqual(queueFiles().map((p) => p.segmentId), ['s1:1-4']);
  const due = listUploadDue();
  assert.equal(due.length, 1);
  assert.equal(due[0].timeline, false);
  assert.equal(calls.trigger, 1);
  assert.equal(calls.fetch, 0);
  assert.equal(calls.linkedSessions, 0);
});

test('local-only queues for every linked account, each tokenless', async (t) => {
  const home = tmpHome(t);
  linkAccount(home, 'a1b2c3d4');
  linkAccount(home, 'b2c3d4e5');
  const { deps } = world(home);

  await runCheckpoint({ session_id: 's1', cwd: home }, deps, STOP);

  assert.deepEqual(queueFiles('a1b2c3d4').map((p) => p.segmentId), ['s1:1-4']);
  assert.deepEqual(queueFiles('b2c3d4e5').map((p) => p.segmentId), ['s1:1-4']);
});

test('local-only ignores options.sessions: the tokened sessions it was handed are never used', async (t) => {
  const home = tmpHome(t);
  linkAccount(home);
  const { deps, calls } = world(home);

  await runCheckpoint({ session_id: 's1', cwd: home }, deps, { ...STOP, sessions: [accountSession(TEST_KEY, 'tok')] });

  assert.equal(calls.fetch, 0);
  assert.deepEqual(queueFiles().map((p) => p.segmentId), ['s1:1-4']);
});

test('local-only skips the installation binding even with correlation granted', async (t) => {
  const home = tmpHome(t);
  linkAccount(home);
  grantConsent();
  grantCorrelation();
  const { deps, calls } = world(home);

  const result = await runCheckpoint({ session_id: 's1', cwd: home }, deps, STOP);

  assert.equal(result.outcome, 'committed');
  assert.equal(calls.getDefaultKey, 0);
  assert.equal(calls.fetch, 0);
});

test('local-only binds the session workspace for a ruled account (the only writer of that binding)', async (t) => {
  const home = tmpHome(t);
  linkAccount(home, TEST_KEY, {
    tenants: [{ id: 'A', name: 'Acme' }, { id: 'B', name: 'Beta' }],
    newFolders: { mode: 'send', tenantIds: ['A'] },
  });
  const { deps } = world(home);

  await runCheckpoint({ session_id: 's1', cwd: home }, deps, STOP);

  const bound = readSessionWorkspace('s1');
  assert.notEqual(bound, null);
  assert.equal(bound.cwd, home);
});

test('a local-only turn end does not read the whole rollout when a byte cursor can resume', async (t) => {
  const home = tmpHome(t);
  linkAccount(home);
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(path.join(stateDir(), 's1.json'), JSON.stringify({
    cursor: 2, sentSessionName: null, anchor: null,
    cursorByte: 10, cursorSize: 10, cursorHead: 'h', cursorWalk: { line: 2 },
  }));
  const reads = [];
  const transcriptMemo = {
    readLines: (p) => { reads.push(p); return { records: [], lines: [] }; },
    readTail: () => ({ records: [], lines: [] }),
    peek: () => null,
  };
  const { deps } = world(home, { transcriptMemo });

  const result = await runCheckpoint({ session_id: 's1', cwd: home }, deps, STOP);

  assert.equal(result.outcome, 'committed');
  assert.deepEqual(reads, []);
});

test('a busy session lock still marks the turn end due, so the worker picks it up', async (t) => {
  const home = tmpHome(t);
  linkAccount(home);
  const { deps, calls } = world(home);
  const held = acquireLock(sessionLock('s1'), { leaseMs: 60000 });
  assert.equal(held.ok, true);
  let result;
  try {
    result = await runCheckpoint({ session_id: 's1', cwd: home }, deps, STOP);
  } finally {
    held.handle.release();
  }

  assert.equal(result.lockSkipped, true);
  const due = listUploadDue();
  assert.equal(due.length, 1);
  assert.equal(due[0].timeline, true);
  assert.equal(calls.trigger, 1);
});

test('no linked account: nothing is marked due and the trigger is not called', async (t) => {
  const home = tmpHome(t);
  const { deps, calls } = world(home);

  const result = await runCheckpoint({ session_id: 's1', cwd: home }, deps, STOP);

  assert.equal(result.outcome, 'deferred');
  assert.deepEqual(listUploadDue(), []);
  assert.equal(calls.trigger, 0);
});

test('an unresolvable transcript marks nothing due', async (t) => {
  const home = tmpHome(t);
  linkAccount(home);
  const { deps, calls } = world(home, { resolveTranscript: () => null });

  await runCheckpoint({ session_id: 's1', cwd: home }, deps, STOP);

  assert.deepEqual(listUploadDue(), []);
  assert.equal(calls.trigger, 0);
});

test('the due marker is written after the cursor: a mark finds the state already committed', async (t) => {
  const home = tmpHome(t);
  linkAccount(home);
  let cursorAtMark = null;
  const { deps } = world(home, {
    markUploadDue: () => { cursorAtMark = readState('s1').cursor; return {}; },
  });

  await runCheckpoint({ session_id: 's1', cwd: home }, deps, STOP);

  assert.equal(cursorAtMark, 4);
});

// The report's before/after numbers: the same turn end through the old inline path and through
// localOnly, with a tokened account behind the old path's linkedSessions (one call = one guard read
// plus one token read per account in production) and an offline-but-answering fetch.
test('a Stop run: the inline path reads credentials and posts; the local-only path does neither', async (t) => {
  const home = tmpHome(t);
  linkAccount(home);
  const counted = (calls) => ({
    linkedSessions: async () => { calls.linkedSessions += 1; return [accountSession(TEST_KEY, 'tok')]; },
    fetchImpl: async () => { calls.fetch += 1; return { ok: false, status: 503, headers: { get: () => null }, json: async () => ({}) }; },
    drainRateLimitSnapshots: async () => { calls.drain += 1; return { posted: 0 }; },
  });
  const inline = world(home);
  Object.assign(inline.deps, counted(inline.calls));
  await runCheckpoint({ session_id: 's1', cwd: home }, inline.deps, { emitTimeline: true, budgetMs: 17500 });

  const local = world(home, {
    resolveTranscript: () => ({ transcriptPath: stubTranscript(home), sessionId: 's2' }),
  });
  Object.assign(local.deps, counted(local.calls));
  await runCheckpoint({ session_id: 's2', cwd: home }, local.deps, STOP);

  // Inline: one linkedSessions, two POSTs (the error, the queued report) and the drain;
  // the stub transcript holds no activity, so there is no timeline to post.
  assert.equal(inline.calls.linkedSessions, 1);
  assert.equal(inline.calls.fetch, 2);
  assert.equal(inline.calls.drain, 1);
  assert.deepEqual(
    { linkedSessions: local.calls.linkedSessions, fetch: local.calls.fetch, drain: local.calls.drain },
    { linkedSessions: 0, fetch: 0, drain: 0 },
  );
});

// Carry-in: the stored prompt-derived name goes through the same gate as the stored sent name.
test('a stored rollout name that fails the session-name gate never reaches the wire', async (t) => {
  const home = tmpHome(t);
  linkAccount(home);
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(path.join(stateDir(), 's1.json'), JSON.stringify({
    cursor: 0, sentSessionName: null, anchor: null,
    rolloutName: '<environment_context>secret</environment_context>',
  }));
  const { deps } = world(home);
  delete deps.resolveSessionName;

  await runCheckpoint({ session_id: 's1', cwd: home }, deps, POST_TOOL_USE);

  const [queued] = queueFiles();
  assert.equal(queued.session_name, null);
});

// The hook now takes the stored-name branch and the worker the fresh one, so both must answer the
// same name, or the two writers would flip the session's name — and replay its anchor — every turn.
// A first prompt cut at the 200-character cap right after a space is the shape that differed: the
// fresh name kept the trailing space, the sanitized stored one did not.
test('the fresh and the stored rollout name are the same name, so no anchor replay follows', async (t) => {
  const home = tmpHome(t);
  linkAccount(home);
  const prompt = `${'a'.repeat(199)} ${'b'.repeat(10)}`;
  const transcriptPath = path.join(home, 'rollout-named.jsonl');
  fs.writeFileSync(transcriptPath, `${JSON.stringify({
    timestamp: '2026-01-01T00:00:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: prompt },
  })}\n`);
  let segments = [seg()];
  const { deps } = world(home, {
    resolveTranscript: () => ({ transcriptPath, sessionId: 's1' }),
    computeDelta: () => ({ nextCursor: 4, segments, apiErrorEvents: [] }),
  });
  delete deps.resolveSessionName;

  // The first run has no stored name: the fresh branch answers. The second has no new segment and
  // takes the stored branch; a different answer there would replay the anchor (one more copy).
  await runCheckpoint({ session_id: 's1', cwd: home }, deps, POST_TOOL_USE);
  const firstName = queueFiles()[0].session_name;
  segments = [];
  const second = await runCheckpoint({ session_id: 's1', cwd: home }, deps, POST_TOOL_USE);

  assert.equal(firstName, 'a'.repeat(199));
  assert.equal(second.routedCopies, 0);
  assert.equal(readState('s1').rolloutName, 'a'.repeat(199));
});

// ── Parked errors on a session one workspace hides ──────────────────────────────────────────────
// A local-only run parks every error. With one workspace that hides sessions beside one that does
// not, each target is parked its OWN body — scrubbed for the hiding one, capped for the other, the
// exact transform postSessionError applies — and the delivery sends each target its own: the
// non-hiding workspace still gets the text, and the state file never holds it for the hiding one.

const anonBlock = (tenantId, on) => ({
  tenantId,
  kinds: Object.fromEntries(KINDS.map((kind) => [kind, on.includes(kind)])),
  key: 'a'.repeat(64),
  machineName: null,
  pastSessions: { choice: 'offer', changedAt: null },
});
const MIXED = {
  tenants: [
    { id: 'A', name: 'Acme', anonymization: anonBlock('A', ['sessions']) },
    { id: 'B', name: 'Beta', anonymization: anonBlock('B', []) },
  ],
  newFolders: { mode: 'send', tenantIds: ['A', 'B'] },
};
const LONG_ERROR = {
  error: 'usage_limit_exceeded', text: 'x'.repeat(1500), details: 'd'.repeat(1200), occurredAt: '2026-01-01T00:00:10.000Z',
};

test('a mixed hiding/non-hiding setup parks one pre-scrubbed body per target', async (t) => {
  const home = tmpHome(t);
  linkAccount(home, TEST_KEY, MIXED);
  const { deps } = world(home, {
    computeDelta: () => ({ nextCursor: 4, segments: [seg()], apiErrorEvents: [LONG_ERROR] }),
  });

  await runCheckpoint({ session_id: 's1', cwd: home }, deps, STOP);

  const [parked] = readState('s1').pendingErrors;
  assert.equal(parked.text, undefined);
  assert.equal(parked.details, undefined);
  assert.deepEqual(parked.bodies['a1b2c3d4:A'], {
    sessionId: 's1', error: 'usage_limit_exceeded', occurredAt: '2026-01-01T00:00:10.000Z',
  });
  assert.deepEqual(parked.bodies['a1b2c3d4:B'], {
    sessionId: 's1', error: 'usage_limit_exceeded', occurredAt: '2026-01-01T00:00:10.000Z',
    errorDetails: 'd'.repeat(1000), lastAssistantMessage: 'x'.repeat(1000),
  });
});

test('the delivery sends each target the body parked for it', async (t) => {
  const home = tmpHome(t);
  linkAccount(home, TEST_KEY, MIXED);
  const local = world(home, {
    computeDelta: () => ({ nextCursor: 4, segments: [seg()], apiErrorEvents: [LONG_ERROR] }),
  });
  await runCheckpoint({ session_id: 's1', cwd: home }, local.deps, STOP);

  const posted = {};
  const worker = world(home, {
    computeDelta: () => ({ nextCursor: 4, segments: [], apiErrorEvents: [] }),
    fetchImpl: async (url, init) => {
      if (String(url).endsWith('/sessions/errors')) posted[init.headers['X-Beezi-Tenant']] = JSON.parse(init.body);
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) };
    },
  });
  const tokened = { ...accountSession(TEST_KEY, 'tok'), ...MIXED };
  await runCheckpoint({ session_id: 's1', cwd: home }, worker.deps, { sessions: [tokened], skipFlush: true });

  assert.deepEqual(posted.A, { sessionId: 's1', error: 'usage_limit_exceeded', occurredAt: '2026-01-01T00:00:10.000Z' });
  assert.equal(posted.B.lastAssistantMessage, 'x'.repeat(1000));
  assert.equal(posted.B.errorDetails, 'd'.repeat(1000));
  assert.deepEqual(readState('s1').pendingErrors, []);
});

test('a single hiding target parks only the scrubbed body, as before', async (t) => {
  const home = tmpHome(t);
  linkAccount(home, TEST_KEY, {
    tenants: [{ id: 'A', name: 'Acme', anonymization: anonBlock('A', ['sessions']) }],
  });
  const { deps } = world(home, {
    computeDelta: () => ({ nextCursor: 4, segments: [seg()], apiErrorEvents: [LONG_ERROR] }),
  });

  await runCheckpoint({ session_id: 's1', cwd: home }, deps, STOP);

  const raw = fs.readFileSync(path.join(stateDir(), 's1.json'), 'utf-8');
  assert.equal(raw.indexOf('xxxx'), -1);
  assert.equal(raw.indexOf('dddd'), -1);
});

test('a target that turns session hiding on has its parked body scrubbed at the next park', async (t) => {
  const home = tmpHome(t);
  linkAccount(home, TEST_KEY, MIXED);
  const first = world(home, {
    computeDelta: () => ({ nextCursor: 4, segments: [seg()], apiErrorEvents: [LONG_ERROR] }),
  });
  await runCheckpoint({ session_id: 's1', cwd: home }, first.deps, STOP);
  assert.equal(readState('s1').pendingErrors[0].bodies['a1b2c3d4:B'].lastAssistantMessage, 'x'.repeat(1000));

  linkAccount(home, TEST_KEY, {
    ...MIXED,
    tenants: [MIXED.tenants[0], { id: 'B', name: 'Beta', anonymization: anonBlock('B', ['sessions']) }],
  });
  const second = world(home, {
    computeDelta: () => ({ nextCursor: 8, segments: [seg(5, 8)], apiErrorEvents: [] }),
  });
  await runCheckpoint({ session_id: 's1', cwd: home }, second.deps, STOP);

  assert.deepEqual(readState('s1').pendingErrors[0].bodies['a1b2c3d4:B'], {
    sessionId: 's1', error: 'usage_limit_exceeded', occurredAt: '2026-01-01T00:00:10.000Z',
  });
  const raw = fs.readFileSync(path.join(stateDir(), 's1.json'), 'utf-8');
  assert.equal(raw.indexOf('xxxx'), -1);
  assert.equal(raw.indexOf('dddd'), -1);
});
