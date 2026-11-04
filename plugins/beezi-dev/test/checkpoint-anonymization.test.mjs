import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCheckpoint, flushQueue } from '../lib/checkpoint.mjs';
import { queueDir, stateDir } from '../lib/paths.mjs';
import { ENDPOINTS } from '../lib/config.mjs';
import { recordSessionRoute } from '../lib/workspace.mjs';
import { createRouteContext } from '../lib/workspace-rules.mjs';
import { KINDS, anonymizeReport } from '../lib/anonymize.mjs';
import { tmpHome as sandboxHome } from '../tools/suite-fixtures.mjs';
import { accountSession, TEST_KEY } from '../tools/account-fixtures.mjs';

const KEY = TEST_KEY;
const ANON_KEY = 'a'.repeat(64);
const ANON_REMOTE = /^anon:(repo|folder):[0-9a-f]{32}$/;

const kindsMap = (on) => Object.fromEntries(KINDS.map((kind) => [kind, on.includes(kind)]));
const block = (tenantId, on, key = ANON_KEY) => ({
  tenantId, kinds: kindsMap(on), key, machineName: null, pastSessions: { choice: 'offer', changedAt: null },
});
const ALL = KINDS.slice();
const NONE = [];
const plain = () => accountSession(KEY, 'tok');
const solo = (anon) => ({ ...plain(), tenants: [{ id: 'A', name: 'Acme', anonymization: anon }], anonymization: anon });
const pair = (a, b) => ({
  ...plain(),
  tenants: [{ id: 'A', name: 'Acme', anonymization: a }, { id: 'B', name: 'Beta', anonymization: b }],
  newFolders: { mode: 'send', tenantIds: ['A', 'B'] },
});
const asking = (a, b) => ({ ...pair(a, b), newFolders: { mode: 'ask' } });

const tmpHome = (t) => sandboxHome(t, 'beezi-cpanon-');

const queueFiles = () => fs.readdirSync(queueDir(KEY)).sort()
  .map((f) => JSON.parse(fs.readFileSync(path.join(queueDir(KEY), f), 'utf-8')));
const readState = (id) => JSON.parse(fs.readFileSync(path.join(stateDir(), `${id}.json`), 'utf-8'));

function stubTranscript(home) {
  const p = path.join(home, 'rollout.jsonl');
  fs.writeFileSync(p, '\n');
  return p;
}

const seg = () => ({
  repoRoot: '/repo',
  branch: 'main',
  fromLine: 1,
  toLine: 4,
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

// The checkpoint's own flush runs offline, so every payload stays queued for the flush under test.
const deps = (home, session, over = {}) => ({
  linkedSessions: async () => [session],
  fetchImpl: async () => { throw new Error('offline'); },
  resolveTranscript: () => ({ transcriptPath: stubTranscript(home), sessionId: 's1' }),
  computeDelta: () => ({ nextCursor: 4, segments: [seg()], apiErrorEvents: [] }),
  gitImpl: () => 'https://host/org/repo.git',
  resolveSessionName: () => 'fix the login bug',
  ...over,
});

function reportSink() {
  const posted = [];
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith(ENDPOINTS.sessionsReport)) {
      posted.push({ tenant: init.headers['X-Beezi-Tenant'] || null, raw: init.body, body: JSON.parse(init.body) });
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  return { fetchImpl, posted };
}

function errorSink(status = 200) {
  const posted = [];
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith(ENDPOINTS.sessionErrors)) {
      posted.push(JSON.parse(init.body));
      return { ok: true, status, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  return { fetchImpl, posted };
}

const withoutMarker = ({ beeziPrivate, ...rest }) => rest;

// A repo rule makes every segment's routing look up its directory's key once in the route context.
test('each segment is routed once, and its routes mark and queue every copy', async (t) => {
  const home = tmpHome(t);
  const session = {
    ...pair(block('A', ['branches']), block('B', NONE)),
    workspaceRules: [{ kind: 'repo', match: 'github.com/other/elsewhere', tenantIds: ['B'] }],
  };
  const routeCtx = createRouteContext();
  const has = routeCtx.keyCache.has.bind(routeCtx.keyCache);
  let lookups = 0;
  routeCtx.keyCache.has = (key) => { if (key === '/repo') lookups += 1; return has(key); };
  const segments = [{ ...seg(), fromLine: 1, toLine: 2 }, { ...seg(), fromLine: 3, toLine: 4 }];
  await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, session, {
    routeCtx,
    computeDelta: () => ({ nextCursor: 4, segments, apiErrorEvents: [] }),
  }));

  assert.equal(lookups, 2);
  const envelopes = queueFiles();
  assert.deepEqual(envelopes.map((e) => `${e.tenantId} ${e.payload.segmentId}`).sort(),
    ['A s1:1-2', 'A s1:3-4', 'B s1:1-2', 'B s1:3-4']);
  for (const envelope of envelopes) assert.deepEqual(envelope.payload.beeziPrivate, { A: ['branches'] });
  const bySegment = (id) => envelopes.filter((e) => e.payload.segmentId === id).map((e) => JSON.stringify(e.payload));
  for (const id of ['s1:1-2', 's1:3-4']) assert.equal(new Set(bySegment(id)).size, 1, `${id} copies differ`);
});

test('a report queued while anonymized is still sent anonymized after the switch-off (bare .json)', async (t) => {
  const home = tmpHome(t);
  await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, solo(block('A', ALL))));
  const [queued] = queueFiles();
  assert.deepEqual(queued.beeziPrivate, { A: ALL });

  const { fetchImpl, posted } = reportSink();
  const result = await flushQueue(KEY, solo(block('A', NONE)), { fetchImpl });

  assert.equal(result.flushed, 1);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].tenant, null);
  assert.deepEqual(posted[0].body, anonymizeReport(queued, ANON_KEY, ALL));
  assert.match(posted[0].body.remote, ANON_REMOTE);
  assert.match(posted[0].body.session_name, /^anon:session:/);
  assert.equal(posted[0].raw.includes('beeziPrivate'), false);
  assert.deepEqual(fs.readdirSync(queueDir(KEY)), []);
});

test('two workspaces: the one anonymized at capture stays anonymized after the switch-off, the other gets the plain body (.qjson)', async (t) => {
  const home = tmpHome(t);
  await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, pair(block('A', ALL), block('B', NONE))));
  const envelopes = queueFiles();
  assert.deepEqual(envelopes.map((e) => e.tenantId).sort(), ['A', 'B']);
  for (const envelope of envelopes) assert.deepEqual(envelope.payload.beeziPrivate, { A: ALL });
  const queued = envelopes[0].payload;

  const { fetchImpl, posted } = reportSink();
  const result = await flushQueue(KEY, pair(block('A', NONE), block('B', NONE)), { fetchImpl });

  assert.equal(result.flushed, 2);
  const byTenant = Object.fromEntries(posted.map((p) => [p.tenant, p]));
  assert.deepEqual(byTenant.A.body, anonymizeReport(queued, ANON_KEY, ALL));
  assert.match(byTenant.A.body.remote, ANON_REMOTE);
  assert.equal(byTenant.B.raw, JSON.stringify(withoutMarker(queued)));
  assert.equal(byTenant.B.body.remote, queued.remote);
  assert.equal(posted.some((p) => p.raw.includes('beeziPrivate')), false);
});

test('a report held for an answer while anonymized is sent anonymized when answered after the switch-off (.ask)', async (t) => {
  const home = tmpHome(t);
  await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, asking(block('A', ALL), block('B', NONE))));
  const [held] = queueFiles();
  assert.equal(held.hold, 'ask');
  assert.deepEqual(held.askTenants, ['A', 'B']);
  assert.deepEqual(held.payload.beeziPrivate, { A: ALL });

  recordSessionRoute('s1', KEY, { kind: 'folder', match: home, tenantIds: ['A', 'B'] });
  const { fetchImpl, posted } = reportSink();
  await flushQueue(KEY, asking(block('A', NONE), block('B', NONE)), { fetchImpl });

  const byTenant = Object.fromEntries(posted.map((p) => [p.tenant, p]));
  assert.deepEqual(Object.keys(byTenant).sort(), ['A', 'B']);
  assert.deepEqual(byTenant.A.body, anonymizeReport(held.payload, ANON_KEY, ALL));
  assert.match(byTenant.A.body.remote, ANON_REMOTE);
  assert.equal(byTenant.B.raw, JSON.stringify(withoutMarker(held.payload)));
  assert.equal(posted.some((p) => p.raw.includes('beeziPrivate')), false);
  assert.deepEqual(fs.readdirSync(queueDir(KEY)), []);
});

test('a marked report with no key left is never posted and its file is removed', async (t) => {
  tmpHome(t);
  fs.mkdirSync(queueDir(KEY), { recursive: true });
  const payload = { segmentId: 's1:1-4', sessionId: 's1', remote: 'https://host/org/repo.git', branch: 'main', beeziPrivate: { A: ['repos'] } };
  fs.writeFileSync(path.join(queueDir(KEY), 's1_1-4.json'), JSON.stringify(payload));

  const { fetchImpl, posted } = reportSink();
  const result = await flushQueue(KEY, solo(block('A', NONE, null)), { fetchImpl });

  assert.equal(posted.length, 0);
  assert.equal(result.flushed, 0);
  assert.equal(result.rejected, 1);
  assert.equal(result.lastError, 'anonymization-key-missing');
  assert.deepEqual(fs.readdirSync(queueDir(KEY)), []);
});

test('the anchor keeps its marker, so a rename replayed after the switch-off is still anonymized', async (t) => {
  const home = tmpHome(t);
  await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, solo(block('A', ALL)), { resolveSessionName: () => 'first title' }));
  assert.deepEqual(readState('s1').anchor.beeziPrivate, { A: ALL });

  await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, solo(block('A', NONE)), {
    computeDelta: () => ({ nextCursor: 4, segments: [], apiErrorEvents: [] }),
    resolveSessionName: () => 'renamed after the fact',
  }));
  const replay = queueFiles().find((p) => p.session_name === 'renamed after the fact');
  assert.ok(replay, 'the anchor was replayed');
  assert.deepEqual(replay.beeziPrivate, { A: ALL });

  const { fetchImpl, posted } = reportSink();
  await flushQueue(KEY, solo(block('A', NONE)), { fetchImpl });

  assert.ok(posted.length > 0);
  for (const p of posted) {
    assert.match(p.body.remote, ANON_REMOTE);
    assert.match(p.body.session_name, /^anon:session:/);
    assert.equal(p.raw.includes('beeziPrivate'), false);
    assert.equal(p.raw.includes('renamed after the fact'), false);
  }
});

test('a transaction resumed after the switch-off keeps the marker it was built with', async (t) => {
  const home = tmpHome(t);
  const crashed = await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, solo(block('A', ALL)), {
    saveState: () => { throw new Error('killed mid-commit'); },
  }));
  assert.equal(crashed.reason, 'transaction-commit-failed');

  const resumed = await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, solo(block('A', NONE))));
  assert.equal(resumed.reason, 'resumed');
  const [queued] = queueFiles();
  assert.deepEqual(queued.beeziPrivate, { A: ALL });

  const { fetchImpl, posted } = reportSink();
  await flushQueue(KEY, solo(block('A', NONE)), { fetchImpl });

  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].body, anonymizeReport(queued, ANON_KEY, ALL));
  assert.equal(posted[0].raw.includes('beeziPrivate'), false);
});

test('a workspace with anonymization off is queued without a marker and posted byte for byte', async (t) => {
  const home = tmpHome(t);
  await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, solo(block('A', NONE))));
  const [queued] = queueFiles();
  assert.equal('beeziPrivate' in queued, false);
  assert.equal(queued.session_name, 'fix the login bug');

  const { fetchImpl, posted } = reportSink();
  await flushQueue(KEY, solo(block('A', NONE)), { fetchImpl });

  assert.equal(posted.length, 1);
  assert.equal(posted[0].raw, JSON.stringify(queued));
});

test('an account with no anonymization block is unchanged', async (t) => {
  const home = tmpHome(t);
  await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, plain()));
  const [queued] = queueFiles();
  assert.equal('beeziPrivate' in queued, false);

  const { fetchImpl, posted } = reportSink();
  await flushQueue(KEY, plain(), { fetchImpl });

  assert.equal(posted.length, 1);
  assert.equal(posted[0].raw, JSON.stringify(queued));
});

const apiError = { error: 'rate_limit', details: 'usage_limit_exceeded', text: 'limit hit', occurredAt: '2026-01-01T00:00:00.000Z' };

test('an anonymized workspace gets no error text, and a parked error delivered after the switch-off has none', async (t) => {
  const home = tmpHome(t);
  const failing = errorSink(500);
  await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, solo(block('A', ALL)), {
    computeDelta: () => ({ nextCursor: 5, segments: [], apiErrorEvents: [apiError] }),
    fetchImpl: failing.fetchImpl,
  }));

  assert.equal(failing.posted.length, 1);
  assert.equal(failing.posted[0].error, 'rate_limit');
  assert.equal('errorDetails' in failing.posted[0], false);
  assert.equal('lastAssistantMessage' in failing.posted[0], false);
  const [parked] = readState('s1').pendingErrors;
  assert.equal(parked.error, 'rate_limit');
  assert.equal('text' in parked, false);
  assert.equal('details' in parked, false);

  const delivered = errorSink();
  await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, solo(block('A', NONE)), {
    computeDelta: () => ({ nextCursor: 6, segments: [], apiErrorEvents: [] }),
    fetchImpl: delivered.fetchImpl,
  }));

  assert.equal(delivered.posted.length, 1);
  assert.equal(delivered.posted[0].error, 'rate_limit');
  assert.equal(delivered.posted[0].lastAssistantMessage, null);
  assert.equal(delivered.posted[0].errorDetails, null);
  assert.deepEqual(readState('s1').pendingErrors, []);
});

test('a workspace with anonymization off still gets and parks the error text', async (t) => {
  const home = tmpHome(t);
  const failing = errorSink(500);
  await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, solo(block('A', NONE)), {
    computeDelta: () => ({ nextCursor: 5, segments: [], apiErrorEvents: [apiError] }),
    fetchImpl: failing.fetchImpl,
  }));

  assert.equal(failing.posted[0].lastAssistantMessage, 'limit hit');
  assert.equal(failing.posted[0].errorDetails, 'usage_limit_exceeded');
  assert.equal(readState('s1').pendingErrors[0].text, 'limit hit');
});

const ANON_BRANCH = /^anon:branch:[0-9a-f]{32}$/;

test('a report marked with repos at emit is sent with the branch hashed too once the block flips to branches (bare .json)', async (t) => {
  const home = tmpHome(t);
  await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, solo(block('A', ['repos']))));
  const [queued] = queueFiles();
  assert.deepEqual(queued.beeziPrivate, { A: ['repos'] });

  const { fetchImpl, posted } = reportSink();
  await flushQueue(KEY, solo(block('A', ['branches'])), { fetchImpl });

  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].body, anonymizeReport(queued, ANON_KEY, ['repos', 'branches']));
  assert.match(posted[0].body.remote, ANON_REMOTE);
  assert.match(posted[0].body.branch, ANON_BRANCH);
  assert.equal(posted[0].body.session_name, 'fix the login bug');
  assert.equal(posted[0].raw.includes('beeziPrivate'), false);
});

test('a report marked with repos at emit is sent with the branch hashed too once the block flips to branches (.qjson)', async (t) => {
  const home = tmpHome(t);
  await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, pair(block('A', ['repos']), block('B', NONE))));
  const envelopes = queueFiles();
  for (const envelope of envelopes) assert.deepEqual(envelope.payload.beeziPrivate, { A: ['repos'] });
  const queued = envelopes[0].payload;

  const { fetchImpl, posted } = reportSink();
  await flushQueue(KEY, pair(block('A', ['branches']), block('B', NONE)), { fetchImpl });

  const byTenant = Object.fromEntries(posted.map((p) => [p.tenant, p]));
  assert.deepEqual(byTenant.A.body, anonymizeReport(queued, ANON_KEY, ['repos', 'branches']));
  assert.match(byTenant.A.body.remote, ANON_REMOTE);
  assert.match(byTenant.A.body.branch, ANON_BRANCH);
  assert.equal(byTenant.B.raw, JSON.stringify(withoutMarker(queued)));
});

test('two workspaces: only the one with sessions on loses the subagent name', async (t) => {
  const home = tmpHome(t);
  const named = () => ({ ...seg(), stats: { ...seg().stats, agent_name: 'Darwin' } });
  await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, pair(block('A', ['sessions']), block('B', NONE)), {
    computeDelta: () => ({ nextCursor: 4, segments: [named()], apiErrorEvents: [] }),
  }));
  for (const envelope of queueFiles()) assert.deepEqual(envelope.payload.beeziPrivate, { A: ['sessions'] });

  const { fetchImpl, posted } = reportSink();
  await flushQueue(KEY, pair(block('A', ['sessions']), block('B', NONE)), { fetchImpl });

  const byTenant = Object.fromEntries(posted.map((p) => [p.tenant, p]));
  assert.equal('agent_name' in byTenant.A.body, false);
  assert.match(byTenant.A.body.session_name, /^anon:session:/);
  assert.equal(byTenant.B.body.agent_name, 'Darwin');
  assert.equal(byTenant.B.body.session_name, 'fix the login bug');
});

const parkedAfterFailure = async (t, on) => {
  const home = tmpHome(t);
  await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, solo(block('A', on)), {
    computeDelta: () => ({ nextCursor: 5, segments: [], apiErrorEvents: [apiError] }),
    fetchImpl: errorSink(500).fetchImpl,
  }));
  return readState('s1').pendingErrors[0];
};

test('a parked error keeps its text when the target hides only computer names', async (t) => {
  const parked = await parkedAfterFailure(t, ['hosts']);
  assert.equal(parked.text, 'limit hit');
  assert.equal(parked.details, 'usage_limit_exceeded');
});

test('a parked error loses its text when the target hides sessions', async (t) => {
  const parked = await parkedAfterFailure(t, ['sessions']);
  assert.equal(parked.error, 'rate_limit');
  assert.equal('text' in parked, false);
  assert.equal('details' in parked, false);
});
