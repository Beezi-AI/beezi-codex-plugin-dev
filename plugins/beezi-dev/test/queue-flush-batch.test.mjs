import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { flushQueue } from '../lib/checkpoint.mjs';
import { queueDir, coverageFile } from '../lib/paths.mjs';
import { enqueue, enqueueHeld } from '../lib/workspace-queue.mjs';
import { KINDS, anonymizeReport } from '../lib/anonymize.mjs';
import { tmpHome as sandboxHome } from '../tools/suite-fixtures.mjs';
import { linkAccount, accountSession, TEST_KEY } from '../tools/account-fixtures.mjs';

// The batch path of the live-queue drain (deps.batch): queued reports go to /sessions/report-batch
// in planned batches, and an answer this plugin does not understand sends them by the single route.
const KEY = TEST_KEY;
const SESSION = accountSession(KEY, 'tok');
const BATCH_URL = 'https://api.beezi.ai/api/sessions/report-batch';
const SINGLE_URL = 'https://api.beezi.ai/api/sessions/report';

function home(t) {
  const dir = sandboxHome(t, 'beezi-qbatch-');
  linkAccount(dir, KEY);
  fs.mkdirSync(queueDir(KEY), { recursive: true });
  return dir;
}

// A raw single-workspace queue file named the way enqueue names it: `s1:1-10` -> `s1_1-10.json`.
function queue(...segmentIds) {
  for (const segmentId of segmentIds) {
    fs.writeFileSync(path.join(queueDir(KEY), `${segmentId.split(':').join('_')}.json`), JSON.stringify({ segmentId }));
  }
}

const left = () => fs.readdirSync(queueDir(KEY)).sort();

// Answers both routes and records every request. `batch` / `single` are lists of answers taken in
// order (the last one repeats); an Error is thrown, a number is a status with an empty body, an
// object { status, body } is that answer, and a function is called with the request body for one.
function server({ batch = [], single = [200] } = {}) {
  const calls = [];
  const answer = (list, n) => list[Math.min(n, list.length - 1)];
  let batches = 0;
  let singles = 0;
  const fetchImpl = async (url, init) => {
    const isBatch = url === BATCH_URL;
    const raw = init.headers['Content-Encoding'] === 'gzip' ? zlib.gunzipSync(init.body).toString('utf-8') : init.body;
    calls.push({
      url,
      bearer: init.headers.Authorization,
      tenant: init.headers['X-Beezi-Tenant'] || null,
      gzip: init.headers['Content-Encoding'] === 'gzip',
      body: JSON.parse(raw),
    });
    let next = isBatch ? answer(batch, batches++) : answer(single, singles++);
    if (typeof next === 'function') next = next(calls[calls.length - 1].body);
    if (next instanceof Error) throw next;
    const status = typeof next === 'number' ? next : next.status;
    const body = typeof next === 'number' ? {} : next.body;
    const text = JSON.stringify(body);
    return { status, ok: status >= 200 && status < 300, text: async () => text, json: async () => body };
  };
  const batchCalls = () => calls.filter((c) => c.url === BATCH_URL);
  const singleCalls = () => calls.filter((c) => c.url === SINGLE_URL);
  return { fetchImpl, calls, batchCalls, singleCalls };
}

const results = (...statuses) => ({ status: 200, body: { results: statuses.map((status) => ({ status })) } });
const ids = (call) => call.body.reports.map((r) => r.segmentId);
const storeAll = (body) => results(...body.reports.map(() => 'stored'));

test('one batch carries the whole queue, contained window first, and stored and rejected delete', async (t) => {
  home(t);
  queue('s1:10-120', 's1:10-80', 's2:1-5');
  const srv = server({ batch: [results('stored', 'rejected', 'stored')] });
  const result = await flushQueue(KEY, SESSION, { fetchImpl: srv.fetchImpl, batch: true });
  assert.equal(srv.calls.length, 1);
  assert.deepEqual(ids(srv.calls[0]), ['s1:10-80', 's2:1-5', 's1:10-120']);
  assert.equal(srv.calls[0].bearer, 'Bearer tok');
  assert.equal(result.flushed, 2);
  assert.equal(result.rejected, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.lastError, 'rejected');
  assert.equal(result.batchUnsupported, undefined);
  assert.deepEqual(left(), []);
});

test('a rejected item carrying a code reports that code', async (t) => {
  home(t);
  queue('s1:1-10');
  const srv = server({ batch: [{ status: 200, body: { results: [{ segmentId: 's1:1-10', status: 'rejected', code: 'INVALID_PAYLOAD' }] } }] });
  const result = await flushQueue(KEY, SESSION, { fetchImpl: srv.fetchImpl, batch: true });
  assert.equal(result.rejected, 1);
  assert.equal(result.lastError, 'INVALID_PAYLOAD');
  assert.deepEqual(left(), []);
});

test('a retry item keeps its file and the rest of its scope group is not sent this pass', async (t) => {
  home(t);
  queue('s1:1-10', 's1:1-20', 's2:1-5');
  // One item per batch, so the group's wider window would otherwise go out in a later request.
  const srv = server({ batch: [results('retry'), results('stored')] });
  const result = await flushQueue(KEY, SESSION, { fetchImpl: srv.fetchImpl, batch: true, batchLimits: { maxItems: 1 } });
  assert.deepEqual(srv.batchCalls().map(ids), [['s1:1-10'], ['s2:1-5']]);
  assert.equal(srv.singleCalls().length, 0);
  assert.equal(result.flushed, 1);
  assert.equal(result.failed, 2);
  assert.deepEqual(left(), ['s1_1-10.json', 's1_1-20.json']);
});

const keepAll = [
  { name: '429 throttled', answer: 429, lastError: 'HTTP 429' },
  { name: '408 throttled', answer: 408, lastError: 'HTTP 408' },
  { name: '409 busy', answer: 409, lastError: 'HTTP 409' },
  { name: '423 locked', answer: 423, lastError: 'HTTP 423' },
  { name: '425 too early', answer: 425, lastError: 'HTTP 425' },
  { name: '503 server error', answer: 503, lastError: null },
  { name: 'a thrown request', answer: new Error('ECONNRESET'), lastError: null },
  { name: '403 without TRACKING_DISABLED', answer: { status: 403, body: { code: 'SEAT_REVOKED', message: 'Seat revoked' } }, lastError: 'Seat revoked' },
];

for (const c of keepAll) {
  test(`${c.name} keeps every file and sends nothing by the single route`, async (t) => {
    home(t);
    queue('s1:1-10', 's2:1-10');
    const srv = server({ batch: [c.answer] });
    const result = await flushQueue(KEY, SESSION, { fetchImpl: srv.fetchImpl, batch: true });
    assert.equal(srv.batchCalls().length, 1);
    assert.equal(srv.singleCalls().length, 0);
    assert.equal(result.failed, 2);
    assert.equal(result.flushed, 0);
    assert.equal(result.lastError, c.lastError);
    assert.equal(result.batchUnsupported, undefined);
    assert.deepEqual(left(), ['s1_1-10.json', 's2_1-10.json']);
  });
}

test('three network-class batch failures in a row stop the drain and defer the rest', async (t) => {
  home(t);
  queue('s1:1-10', 's2:1-10', 's3:1-10', 's4:1-10', 's5:1-10');
  const srv = server({ batch: [503, 429, new Error('ECONNRESET')] });
  const result = await flushQueue(KEY, SESSION, { fetchImpl: srv.fetchImpl, batch: true, batchLimits: { maxItems: 1 } });
  assert.equal(srv.calls.length, 3);
  assert.equal(result.failed, 3);
  assert.equal(result.deferred, 2);
  assert.equal(left().length, 5);
});

test('an understood answer between failures resets the count', async (t) => {
  home(t);
  queue('s1:1-10', 's2:1-10', 's3:1-10', 's4:1-10', 's5:1-10');
  const srv = server({ batch: [503, 503, results('stored'), 503, 503] });
  const result = await flushQueue(KEY, SESSION, { fetchImpl: srv.fetchImpl, batch: true, batchLimits: { maxItems: 1 } });
  assert.equal(srv.calls.length, 5);
  assert.equal(result.flushed, 1);
  assert.equal(result.failed, 4);
  assert.equal(result.deferred, 0);
});

const fallbacks = [
  { name: 'a 404 (production has no batch route)', answer: 404 },
  { name: 'a 405', answer: 405 },
  { name: 'a 2xx without results', answer: { status: 200, body: { ok: true } } },
  { name: 'a 2xx echoing another report\'s segmentId', answer: { status: 200, body: { results: [
    { segmentId: 's2:1-10', status: 'stored' },
    { segmentId: 's1:1-10', status: 'stored' },
  ] } } },
  { name: 'a 422', answer: 422 },
];

for (const c of fallbacks) {
  test(`${c.name} delivers every report by the single route and flags the batch route unsupported`, async (t) => {
    home(t);
    queue('s1:1-10', 's2:1-10');
    const srv = server({ batch: [c.answer], single: [200] });
    const result = await flushQueue(KEY, SESSION, { fetchImpl: srv.fetchImpl, batch: true });
    assert.equal(srv.batchCalls().length, 1);
    assert.deepEqual(srv.singleCalls().map((call) => call.body), [{ segmentId: 's1:1-10' }, { segmentId: 's2:1-10' }]);
    assert.equal(result.flushed, 2);
    assert.equal(result.batchUnsupported, true);
    assert.deepEqual(left(), []);
  });
}

test('a fallback keeps the single route\'s own verdicts: a throttled report stays', async (t) => {
  home(t);
  queue('s1:1-10', 's2:1-10');
  const srv = server({ batch: [404], single: [200, 429] });
  const result = await flushQueue(KEY, SESSION, { fetchImpl: srv.fetchImpl, batch: true });
  assert.equal(result.flushed, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.lastError, 'HTTP 429');
  assert.equal(result.batchUnsupported, true);
  assert.deepEqual(left(), ['s2_1-10.json']);
});

test('a 401 renews the token once and resends the batch with the new bearer', async (t) => {
  home(t);
  queue('s1:1-10');
  const srv = server({ batch: [401, results('stored')] });
  const result = await flushQueue(KEY, SESSION, {
    fetchImpl: srv.fetchImpl, batch: true, getAccessToken: async () => 'new',
  });
  assert.deepEqual(srv.calls.map((c) => `${c.url === BATCH_URL ? 'batch' : 'single'} ${c.bearer}`),
    ['batch Bearer tok', 'batch Bearer new']);
  assert.equal(result.flushed, 1);
  assert.equal(result.batchUnsupported, undefined);
  assert.deepEqual(left(), []);
});

test('a 401 the renewal does not cure falls back to the single route with the renewed bearer', async (t) => {
  home(t);
  queue('s1:1-10');
  const srv = server({ batch: [401], single: [200] });
  let renewals = 0;
  const result = await flushQueue(KEY, SESSION, {
    fetchImpl: srv.fetchImpl, batch: true, getAccessToken: async () => { renewals += 1; return 'new'; },
  });
  assert.equal(renewals, 1);
  assert.deepEqual(srv.calls.map((c) => `${c.url === BATCH_URL ? 'batch' : 'single'} ${c.bearer}`),
    ['batch Bearer tok', 'batch Bearer new', 'single Bearer new']);
  assert.equal(result.flushed, 1);
  // A 401 says nothing about the route: a revoked token or a skipped renewal looks the same.
  assert.equal(result.batchUnsupported, undefined);
});

test('a 401 with no renewal available falls back', async (t) => {
  home(t);
  queue('s1:1-10');
  const srv = server({ batch: [401], single: [200] });
  const result = await flushQueue(KEY, SESSION, {
    fetchImpl: srv.fetchImpl, batch: true, getAccessToken: async () => null,
  });
  assert.equal(srv.batchCalls().length, 1);
  assert.equal(srv.singleCalls().length, 1);
  assert.equal(result.flushed, 1);
  assert.equal(result.batchUnsupported, undefined);
});

test('a 413 halves the batch size for the rest of the drain', async (t) => {
  home(t);
  queue('s1:1-10', 's2:1-10', 's3:1-10', 's4:1-10');
  const srv = server({ batch: [413, results('stored', 'stored'), results('stored', 'stored')] });
  const result = await flushQueue(KEY, SESSION, { fetchImpl: srv.fetchImpl, batch: true });
  assert.deepEqual(srv.batchCalls().map(ids), [
    ['s1:1-10', 's2:1-10', 's3:1-10', 's4:1-10'],
    ['s1:1-10', 's2:1-10'],
    ['s3:1-10', 's4:1-10'],
  ]);
  assert.equal(srv.singleCalls().length, 0);
  assert.equal(result.flushed, 4);
  assert.deepEqual(left(), []);
});

test('a 413 on a batch of one sends that report by the single route', async (t) => {
  home(t);
  queue('s1:1-10', 's2:1-10');
  const srv = server({ batch: [413, 413, results('stored')], single: [200] });
  const result = await flushQueue(KEY, SESSION, { fetchImpl: srv.fetchImpl, batch: true });
  assert.deepEqual(srv.calls.map((c) => (c.url === BATCH_URL ? ids(c) : `single ${c.body.segmentId}`)), [
    ['s1:1-10', 's2:1-10'],
    ['s1:1-10'],
    'single s1:1-10',
    ['s2:1-10'],
  ]);
  assert.equal(result.flushed, 2);
  assert.equal(result.batchUnsupported, undefined);
  assert.deepEqual(left(), []);
});

test('once a proxy refuses a gzip body, the rest of the drain posts plain JSON', async (t) => {
  home(t);
  queue('s1:1-10', 's2:1-10');
  const srv = server({ batch: [415, results('stored'), results('stored')] });
  const result = await flushQueue(KEY, SESSION, { fetchImpl: srv.fetchImpl, batch: true, batchLimits: { maxItems: 1 } });
  assert.deepEqual(srv.batchCalls().map((c) => c.gzip), [true, false, false]);
  assert.equal(result.flushed, 2);
});

test('a fallback the single route cannot deliver either does not flag the batch route', async (t) => {
  home(t);
  queue('s1:1-10', 's2:1-10');
  const srv = server({ batch: [404], single: [404] });
  const result = await flushQueue(KEY, SESSION, { fetchImpl: srv.fetchImpl, batch: true });
  assert.equal(srv.singleCalls().length, 2);
  assert.equal(result.flushed, 0);
  assert.equal(result.batchUnsupported, undefined);
  assert.deepEqual(left(), ['s1_1-10.json', 's2_1-10.json']);
});

test('409, 423 and 425 keep the batch but do not count toward the network stop', async (t) => {
  home(t);
  queue('s1:1-10', 's2:1-10', 's3:1-10', 's4:1-10', 's5:1-10');
  const srv = server({ batch: [409, 423, 425, 409, 423] });
  const result = await flushQueue(KEY, SESSION, { fetchImpl: srv.fetchImpl, batch: true, batchLimits: { maxItems: 1 } });
  assert.equal(srv.batchCalls().length, 5);
  assert.equal(srv.singleCalls().length, 0);
  assert.equal(result.failed, 5);
  assert.equal(result.deferred, 0);
  assert.equal(result.batchUnsupported, undefined);
});

test('less than a second left before the deadline: no batch is started', async (t) => {
  home(t);
  queue('s1:1-10', 's2:1-10');
  const srv = server({ batch: [results('stored', 'stored')] });
  const result = await flushQueue(KEY, SESSION, {
    fetchImpl: srv.fetchImpl, batch: true, now: () => 1_000_000, deadline: 1_000_000 + 999,
  });
  assert.equal(srv.calls.length, 0);
  assert.equal(result.deferred, 2);
  assert.deepEqual(left(), ['s1_1-10.json', 's2_1-10.json']);
});

test('a 413 on a batch of one past the deadline defers that report instead of sending it', async (t) => {
  home(t);
  queue('s1:1-10');
  let nowMs = 1_000_000;
  const srv = server({ batch: [413], single: [200] });
  const fetchImpl = async (url, init) => { const res = await srv.fetchImpl(url, init); nowMs += 10_000; return res; };
  const result = await flushQueue(KEY, SESSION, {
    fetchImpl, batch: true, now: () => nowMs, deadline: 1_000_000 + 5_000,
  });
  assert.equal(srv.batchCalls().length, 1);
  assert.equal(srv.singleCalls().length, 0);
  assert.equal(result.deferred, 1);
  assert.deepEqual(left(), ['s1_1-10.json']);
});

test('TRACKING_DISABLED on a single-workspace account stops the drain and holds every file', async (t) => {
  home(t);
  queue('s1:1-10', 's2:1-10');
  const srv = server({ batch: [{ status: 403, body: { code: 'TRACKING_DISABLED', message: 'Workspace is in audit mode' } }] });
  const result = await flushQueue(KEY, SESSION, { fetchImpl: srv.fetchImpl, batch: true });
  assert.equal(srv.calls.length, 1);
  assert.equal(result.trackingDisabled, true);
  assert.equal(result.lastError, 'Workspace is in audit mode');
  assert.equal(result.failed, 0);
  assert.equal(result.rejected, 0);
  assert.deepEqual(left(), ['s1_1-10.json', 's2_1-10.json']);
});

test('without batch: true the drain posts one report at a time', async (t) => {
  home(t);
  queue('s1:1-10', 's2:1-10');
  const srv = server();
  const result = await flushQueue(KEY, SESSION, { fetchImpl: srv.fetchImpl });
  assert.equal(srv.batchCalls().length, 0);
  assert.equal(srv.singleCalls().length, 2);
  assert.equal(result.flushed, 2);
});

test('BEEZI_NO_BATCH=1 turns batching off', async (t) => {
  home(t);
  queue('s1:1-10', 's2:1-10');
  const prev = process.env.BEEZI_NO_BATCH;
  process.env.BEEZI_NO_BATCH = '1';
  t.after(() => { if (prev === undefined) delete process.env.BEEZI_NO_BATCH; else process.env.BEEZI_NO_BATCH = prev; });
  const srv = server();
  const result = await flushQueue(KEY, SESSION, { fetchImpl: srv.fetchImpl, batch: true });
  assert.equal(srv.batchCalls().length, 0);
  assert.equal(srv.singleCalls().length, 2);
  assert.equal(result.flushed, 2);
});

test('the batch request gets 20 s, or what the deadline leaves when that is less', async (t) => {
  home(t);
  queue('s1:1-10', 's2:1-10');
  let nowMs = 1_000_000;
  const timeouts = [];
  const srv = server({ batch: [results('stored')] });
  const fetchImpl = async (url, init) => { const res = await srv.fetchImpl(url, init); nowMs += 50_000; return res; };
  const result = await flushQueue(KEY, SESSION, {
    fetchImpl, batch: true, batchLimits: { maxItems: 1 },
    now: () => nowMs, deadline: 1_000_000 + 55_000, onRequestTimeout: (ms) => timeouts.push(ms),
  });
  assert.deepEqual(timeouts, [20_000, 5_000]);
  assert.equal(result.flushed, 2);
});

test('a drain past its deadline sends no batch and defers every ready report', async (t) => {
  home(t);
  queue('s1:1-10', 's2:1-10', 's3:1-10');
  const srv = server({ batch: [results('stored')] });
  let nowMs = 1_000_000;
  const fetchImpl = async (url, init) => { const res = await srv.fetchImpl(url, init); nowMs += 10_000; return res; };
  const result = await flushQueue(KEY, SESSION, {
    fetchImpl, batch: true, batchLimits: { maxItems: 1 }, now: () => nowMs, deadline: 1_000_000 + 5_000,
  });
  assert.equal(srv.batchCalls().length, 1);
  assert.equal(srv.singleCalls().length, 0);
  assert.equal(result.flushed, 1);
  assert.equal(result.deferred, 2);
  assert.equal(left().length, 2);
});

test('maxBytes is measured on the JSON of each report, in UTF-8 bytes', async (t) => {
  home(t);
  // `{"segmentId":"s1:1-10"}` is 23 bytes: two fit in 46, not in 45.
  for (const [maxBytes, want] of [[46, [['s1:1-10', 's2:1-10']]], [45, [['s1:1-10'], ['s2:1-10']]]]) {
    queue('s1:1-10', 's2:1-10');
    const srv = server({ batch: [storeAll] });
    await flushQueue(KEY, SESSION, { fetchImpl: srv.fetchImpl, batch: true, batchLimits: { maxBytes } });
    assert.deepEqual(srv.batchCalls().map(ids), want, `maxBytes ${maxBytes}`);
  }
});

test('a batch carries the same wire form the single route sends: anonymized, marker stripped', async (t) => {
  home(t);
  const key = 'a'.repeat(64);
  const kinds = Object.fromEntries(KINDS.map((kind) => [kind, false]));
  const anon = { tenantId: 'A', kinds, key, machineName: null, pastSessions: { choice: 'offer', changedAt: null } };
  const session = { ...SESSION, tenants: [{ id: 'A', name: 'Acme', anonymization: anon }], anonymization: anon };
  const payload = {
    segmentId: 's1:1-4', sessionId: 's1', remote: 'https://host/org/repo.git', branch: 'main',
    session_name: 'fix the login bug', beeziPrivate: { A: KINDS.slice() },
  };
  fs.writeFileSync(path.join(queueDir(KEY), 's1_1-4.json'), JSON.stringify(payload));
  const srv = server({ batch: [results('stored')] });
  await flushQueue(KEY, session, { fetchImpl: srv.fetchImpl, batch: true });
  assert.equal(srv.calls.length, 1);
  const { beeziPrivate, ...unmarked } = payload;
  assert.deepEqual(srv.calls[0].body.reports, [anonymizeReport(unmarked, key, KINDS.slice())]);
  assert.match(srv.calls[0].body.reports[0].remote, /^anon:(repo|folder):[0-9a-f]{32}$/);
  assert.equal(JSON.stringify(srv.calls[0].body).includes('beeziPrivate'), false);
});

// Several workspaces: one tenant per batch, and an Ask file is released, never batched itself.
const TWO = { ...SESSION, tenants: [{ id: 'A', name: 'Acme' }, { id: 'B', name: 'Beta' }] };

test('several workspaces post one batch per tenant, each under its own tenant header', async (t) => {
  home(t);
  enqueue(KEY, { segmentId: 's1:1-10', sessionId: 's1' }, 'A', { multi: true });
  enqueue(KEY, { segmentId: 's2:1-10', sessionId: 's2' }, 'B', { multi: true });
  enqueue(KEY, { segmentId: 's3:1-10', sessionId: 's3' }, 'A', { multi: true });
  const srv = server({ batch: [results('stored', 'stored'), results('stored')] });
  const result = await flushQueue(KEY, TWO, { fetchImpl: srv.fetchImpl, batch: true });
  assert.deepEqual(srv.batchCalls().map((c) => [c.tenant, ids(c)]), [
    ['A', ['s1:1-10', 's3:1-10']],
    ['B', ['s2:1-10']],
  ]);
  assert.equal(result.flushed, 3);
  assert.deepEqual(left(), []);
});

test('an Ask file waiting for an answer is held, not batched', async (t) => {
  home(t);
  enqueueHeld(KEY, { segmentId: 's1:1-10', sessionId: 's1' }, ['A', 'B']);
  enqueue(KEY, { segmentId: 's2:1-10', sessionId: 's2' }, 'A', { multi: true });
  const srv = server({ batch: [results('stored')] });
  const result = await flushQueue(KEY, { ...TWO, newFolders: { mode: 'ask' } }, { fetchImpl: srv.fetchImpl, batch: true });
  assert.deepEqual(srv.batchCalls().map(ids), [['s2:1-10']]);
  assert.equal(result.flushed, 1);
  assert.equal(result.workspacePending, 1);
  assert.deepEqual(left(), ['s1_1-10__ask.qjson']);
});

test('TRACKING_DISABLED for one of several workspaces drops only that tenant\'s reports', async (t) => {
  home(t);
  enqueue(KEY, { segmentId: 's1:1-10', sessionId: 's1' }, 'A', { multi: true });
  enqueue(KEY, { segmentId: 's2:1-10', sessionId: 's2' }, 'B', { multi: true });
  const srv = server({ batch: [
    { status: 403, body: { code: 'TRACKING_DISABLED', message: 'Acme is in audit mode' } },
    results('stored'),
  ] });
  const result = await flushQueue(KEY, TWO, { fetchImpl: srv.fetchImpl, batch: true });
  assert.deepEqual(srv.batchCalls().map((c) => c.tenant), ['A', 'B']);
  assert.equal(result.rejected, 1);
  assert.equal(result.flushed, 1);
  assert.equal(result.trackingDisabled, false);
  assert.equal(result.lastError, 'Acme is in audit mode');
  assert.deepEqual(left(), []);
});

// ─── the fallback loop: production has no batch route, so this is where a production drain runs ───

test('after a fallback, three network-class single failures in a row stop the drain', async (t) => {
  home(t);
  queue('s1:1-10', 's2:1-10', 's3:1-10', 's4:1-10', 's5:1-10');
  const srv = server({ batch: [404], single: [503, 503, 503] });
  const result = await flushQueue(KEY, SESSION, { fetchImpl: srv.fetchImpl, batch: true });
  assert.equal(srv.singleCalls().length, 3);
  assert.equal(result.failed, 3);
  assert.equal(result.deferred, 2);
  assert.equal(result.batchUnsupported, undefined);
  assert.equal(left().length, 5);
});

test('after a fallback, a window the single route kept holds back the rest of its scope', async (t) => {
  home(t);
  queue('s1:1-10', 's1:1-20');
  const srv = server({ batch: [404], single: [429] });
  const result = await flushQueue(KEY, SESSION, { fetchImpl: srv.fetchImpl, batch: true });
  assert.deepEqual(srv.singleCalls().map((c) => c.body.segmentId), ['s1:1-10']);
  assert.equal(result.failed, 2);
  assert.deepEqual(left(), ['s1_1-10.json', 's1_1-20.json']);
});

test('after a fallback, the deadline defers the reports not yet sent', async (t) => {
  home(t);
  queue('s1:1-10', 's2:1-10', 's3:1-10');
  let nowMs = 1_000_000;
  const srv = server({ batch: [404], single: [200] });
  const fetchImpl = async (url, init) => {
    const res = await srv.fetchImpl(url, init);
    if (url === SINGLE_URL) nowMs += 10_000;
    return res;
  };
  const result = await flushQueue(KEY, SESSION, {
    fetchImpl, batch: true, now: () => nowMs, deadline: 1_000_000 + 5_000,
  });
  assert.equal(srv.singleCalls().length, 1);
  assert.equal(result.flushed, 1);
  assert.equal(result.deferred, 2);
  assert.equal(left().length, 2);
});

test('a workspace that went dark in an earlier batch has its later reports dropped unsent', async (t) => {
  home(t);
  enqueue(KEY, { segmentId: 's1:1-10', sessionId: 's1' }, 'A', { multi: true });
  enqueue(KEY, { segmentId: 's2:1-10', sessionId: 's2' }, 'A', { multi: true });
  enqueue(KEY, { segmentId: 's3:1-10', sessionId: 's3' }, 'B', { multi: true });
  const srv = server({ batch: [
    { status: 403, body: { code: 'TRACKING_DISABLED', message: 'Acme is in audit mode' } },
    results('stored'),
  ] });
  const result = await flushQueue(KEY, TWO, { fetchImpl: srv.fetchImpl, batch: true, batchLimits: { maxItems: 1 } });
  assert.deepEqual(srv.batchCalls().map((c) => [c.tenant, ids(c)]), [['A', ['s1:1-10']], ['B', ['s3:1-10']]]);
  assert.equal(result.rejected, 2);
  assert.equal(result.flushed, 1);
  assert.deepEqual(left(), []);
});

test('a batch whose replay evidence cannot be saved is kept and never sent', async (t) => {
  home(t);
  enqueue(KEY, { segmentId: 's1:1-10', sessionId: 's1', to_line: 10 }, 'A', { multi: true });
  // A directory where the workspace's attempt file goes: the evidence write cannot land.
  fs.mkdirSync(path.join(coverageFile(KEY, 'A'), 'blocker'), { recursive: true });
  const srv = server({ batch: [results('stored')] });
  const result = await flushQueue(KEY, TWO, { fetchImpl: srv.fetchImpl, batch: true });
  assert.equal(srv.calls.length, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.lastError, 'Could not save workspace replay evidence; report retained.');
  assert.equal(left().length, 1);
});

// ── fix round (one drainer): which files an absent route kept ───────────────────────────────────

test('a 404 on the single route names each file it kept, so the watcher can tolerate exactly those', async (t) => {
  home(t);
  queue('s1:1-10', 's2:1-5');
  const srv = server({ single: [404, 500] });
  const result = await flushQueue(KEY, SESSION, { fetchImpl: srv.fetchImpl });
  assert.equal(result.routeAbsent, 1);
  assert.equal(result.failed, 2);
  assert.deepEqual(result.routeAbsentFiles, ['s1_1-10.json']);
  assert.deepEqual(left(), ['s1_1-10.json', 's2_1-5.json']);
});

test('a drain with no absent route names no kept file', async (t) => {
  home(t);
  queue('s1:1-10');
  const srv = server({ single: [200] });
  const result = await flushQueue(KEY, SESSION, { fetchImpl: srv.fetchImpl });
  assert.deepEqual(result.routeAbsentFiles, []);
});
