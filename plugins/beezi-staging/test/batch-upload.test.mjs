import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { postReportBatch } from '../lib/batch-upload.mjs';

const URL = 'https://api.test/api/sessions/report-batch';
const session = (over = {}) => ({ token: 'tok-1', clientId: 'c-1', tenantId: null, ...over });
const report = (n) => ({ segmentId: `s1:${n}-${n + 9}`, tokens: n });
const REPORTS = [report(1), report(11)];

// A Response as fetch-compat and Node's fetch both expose it: status plus text().
function response(status, body) {
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  return { status, ok: status >= 200 && status < 300, text: async () => text };
}

// Answers each call with the next queued response; records every request.
function scriptedFetch(answers) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = answers[calls.length - 1];
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetchImpl, calls };
}

const opts = (fetchImpl, over = {}) => ({ fetchImpl, url: URL, ...over });

function bodyOf(call) {
  const raw = call.init.body;
  if (call.init.headers['Content-Encoding'] === 'gzip') return JSON.parse(zlib.gunzipSync(raw).toString('utf-8'));
  return JSON.parse(raw);
}

const STORED_ALL = { results: [
  { segmentId: 's1:1-10', status: 'stored' },
  { segmentId: 's1:11-20', status: 'retry' },
] };

test('posts the reports gzipped with the single route\'s auth, agent and tenant headers', async () => {
  const { fetchImpl, calls } = scriptedFetch([response(200, STORED_ALL)]);
  await postReportBatch(REPORTS, session({ tenantId: 'tenant-a' }), opts(fetchImpl));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.test/api/sessions/report-batch');
  assert.equal(calls[0].init.method, 'POST');
  const h = calls[0].init.headers;
  assert.equal(h.Authorization, 'Bearer tok-1');
  assert.equal(h['X-Beezi-Agent'], 'codex');
  assert.equal(h['X-Beezi-Client'], 'c-1');
  assert.equal(h['X-Beezi-Tenant'], 'tenant-a');
  assert.equal(h['Content-Type'], 'application/json');
  assert.equal(h['Content-Encoding'], 'gzip');
  assert.deepEqual(bodyOf(calls[0]), { reports: [
    { segmentId: 's1:1-10', tokens: 1 },
    { segmentId: 's1:11-20', tokens: 11 },
  ] });
});

test('gzip: false posts the body plain', async () => {
  const { fetchImpl, calls } = scriptedFetch([response(200, STORED_ALL)]);
  await postReportBatch(REPORTS, session(), opts(fetchImpl, { gzip: false }));
  assert.equal(calls[0].init.headers['Content-Encoding'], undefined);
  assert.equal(calls[0].init.body, '{"reports":[{"segmentId":"s1:1-10","tokens":1},{"segmentId":"s1:11-20","tokens":11}]}');
});

test('a single-workspace session sends no tenant header', async () => {
  const { fetchImpl, calls } = scriptedFetch([response(200, STORED_ALL)]);
  await postReportBatch(REPORTS, session(), opts(fetchImpl));
  assert.equal(calls[0].init.headers['X-Beezi-Tenant'], undefined);
});

test('without a url it posts to apiBase plus the batch route', async () => {
  const { fetchImpl, calls } = scriptedFetch([response(200, STORED_ALL)]);
  await postReportBatch(REPORTS, session(), { fetchImpl });
  assert.equal(calls[0].url, 'https://api.beezi.ai/api/sessions/report-batch');
});

test('a full 2xx answer maps every item in input order', async () => {
  const { fetchImpl } = scriptedFetch([response(200, { results: [
    { segmentId: 's1:1-10', status: 'stored' },
    { segmentId: 's1:11-20', status: 'rejected', code: 'INVALID_PAYLOAD' },
  ] })]);
  assert.deepEqual(await postReportBatch(REPORTS, session(), opts(fetchImpl)), {
    kind: 'results',
    results: [
      { segmentId: 's1:1-10', status: 'stored', code: null },
      { segmentId: 's1:11-20', status: 'rejected', code: 'INVALID_PAYLOAD' },
    ],
  });
});

test('a 207 with a full answer is still results', async () => {
  const { fetchImpl } = scriptedFetch([response(207, STORED_ALL)]);
  const out = await postReportBatch(REPORTS, session(), opts(fetchImpl));
  assert.equal(out.kind, 'results');
});

test('an empty batch makes no request', async () => {
  const { fetchImpl, calls } = scriptedFetch([]);
  assert.deepEqual(await postReportBatch([], session(), opts(fetchImpl)), { kind: 'results', results: [] });
  assert.equal(calls.length, 0);
});

test('a bare token throws a TypeError instead of passing for a network failure', async () => {
  const { fetchImpl } = scriptedFetch([response(200, STORED_ALL)]);
  await assert.rejects(() => postReportBatch(REPORTS, 'tok-1', opts(fetchImpl)), TypeError);
});

const statusCases = [
  { name: '2xx with too few results', answers: [response(200, { results: [{ segmentId: 's1:1-10', status: 'stored' }] })], want: { kind: 'fallback', status: 200 } },
  { name: '2xx with an unknown status', answers: [response(200, { results: [
    { segmentId: 's1:1-10', status: 'stored' },
    { segmentId: 's1:11-20', status: 'queued' },
  ] })], want: { kind: 'fallback', status: 200 } },
  { name: '2xx with a null item', answers: [response(200, { results: [{ segmentId: 's1:1-10', status: 'stored' }, null] })], want: { kind: 'fallback', status: 200 } },
  { name: '2xx whose results is not an array', answers: [response(200, { results: 'ok' })], want: { kind: 'fallback', status: 200 } },
  { name: '2xx with a non-JSON body', answers: [response(200, '<html>ok</html>')], want: { kind: 'fallback', status: 200 } },
  { name: '2xx with an empty body', answers: [response(204)], want: { kind: 'fallback', status: 204 } },
  { name: '404 (a server without the route)', answers: [response(404, { message: 'Not Found' })], want: { kind: 'fallback', status: 404 } },
  { name: '405', answers: [response(405)], want: { kind: 'fallback', status: 405 } },
  { name: '401', answers: [response(401)], want: { kind: 'unauthorized', status: 401 } },
  { name: '403 TRACKING_DISABLED', answers: [response(403, { code: 'TRACKING_DISABLED', message: 'Workspace is in audit mode' })], want: { kind: 'tracking-disabled', status: 403, code: 'TRACKING_DISABLED', message: 'Workspace is in audit mode' } },
  { name: '403 TRACKING_DISABLED without a message', answers: [response(403, { code: 'TRACKING_DISABLED' })], want: { kind: 'tracking-disabled', status: 403, code: 'TRACKING_DISABLED', message: null } },
  { name: '403 with another code', answers: [response(403, { code: 'SEAT_REVOKED', message: 'Seat revoked' })], want: { kind: 'server-error', status: 403, code: 'SEAT_REVOKED', message: 'Seat revoked' } },
  { name: '403 with no body', answers: [response(403)], want: { kind: 'server-error', status: 403, code: null, message: null } },
  { name: '408', answers: [response(408)], want: { kind: 'throttled', status: 408 } },
  { name: '429', answers: [response(429)], want: { kind: 'throttled', status: 429 } },
  { name: '409', answers: [response(409)], want: { kind: 'throttled', status: 409 } },
  { name: '423', answers: [response(423)], want: { kind: 'throttled', status: 423 } },
  { name: '425', answers: [response(425)], want: { kind: 'throttled', status: 425 } },
  { name: '413', answers: [response(413)], want: { kind: 'too-large', status: 413 } },
  { name: '500', answers: [response(500)], want: { kind: 'server-error', status: 500 } },
  { name: '503', answers: [response(503)], want: { kind: 'server-error', status: 503 } },
  { name: '422 (any other answer)', answers: [response(422)], want: { kind: 'fallback', status: 422 } },
  { name: 'a thrown fetch', answers: [new Error('ECONNREFUSED')], want: { kind: 'network' } },
];

for (const c of statusCases) {
  test(`maps ${c.name}`, async () => {
    const { fetchImpl, calls } = scriptedFetch(c.answers);
    assert.deepEqual(await postReportBatch(REPORTS, session(), opts(fetchImpl)), c.want);
    assert.equal(calls.length, 1);
  });
}

const plainCases = [
  { name: 'a plain 400', status: 400 },
  { name: 'a plain 415', status: 415 },
];

for (const c of plainCases) {
  test(`maps ${c.name} to fallback`, async () => {
    const { fetchImpl, calls } = scriptedFetch([response(c.status)]);
    assert.deepEqual(await postReportBatch(REPORTS, session(), opts(fetchImpl, { gzip: false })), { kind: 'fallback', status: c.status });
    assert.equal(calls.length, 1);
  });
}

for (const status of [400, 415]) {
  test(`a gzip body refused with ${status} is resent plain once, and the answer says so`, async () => {
    const { fetchImpl, calls } = scriptedFetch([response(status), response(200, STORED_ALL)]);
    const out = await postReportBatch(REPORTS, session(), opts(fetchImpl));
    assert.equal(calls.length, 2);
    assert.equal(calls[0].init.headers['Content-Encoding'], 'gzip');
    assert.equal(calls[1].init.headers['Content-Encoding'], undefined);
    assert.deepEqual(bodyOf(calls[1]), bodyOf(calls[0]));
    assert.deepEqual(out, {
      kind: 'results',
      results: [
        { segmentId: 's1:1-10', status: 'stored', code: null },
        { segmentId: 's1:11-20', status: 'retry', code: null },
      ],
      gzipRefused: true,
    });
  });
}

test('a gzip body refused and then refused plain falls back', async () => {
  const { fetchImpl, calls } = scriptedFetch([response(415), response(400)]);
  assert.deepEqual(await postReportBatch(REPORTS, session(), opts(fetchImpl)), { kind: 'fallback', status: 400, gzipRefused: true });
  assert.equal(calls.length, 2);
});

test('a throttled gzip post is not resent plain', async () => {
  const { fetchImpl, calls } = scriptedFetch([response(429), response(200, STORED_ALL)]);
  assert.deepEqual(await postReportBatch(REPORTS, session(), opts(fetchImpl)), { kind: 'throttled', status: 429 });
  assert.equal(calls.length, 1);
});

test('a thrown gzip post is not resent plain', async () => {
  const { fetchImpl, calls } = scriptedFetch([new Error('timeout'), response(200, STORED_ALL)]);
  assert.deepEqual(await postReportBatch(REPORTS, session(), opts(fetchImpl)), { kind: 'network' });
  assert.equal(calls.length, 1);
});

test('the request carries an abort signal bounded by timeoutMs', async () => {
  const fetchImpl = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  assert.deepEqual(await postReportBatch(REPORTS, session(), opts(fetchImpl, { timeoutMs: 20 })), { kind: 'network' });
});

test('a 2xx whose body never finishes is not understood, bounded by readMs', async () => {
  const hung = { status: 200, ok: true, text: () => new Promise(() => {}) };
  const { fetchImpl } = scriptedFetch([hung]);
  assert.deepEqual(await postReportBatch(REPORTS, session(), opts(fetchImpl, { readMs: 20 })), { kind: 'fallback', status: 200 });
});

test('a 403 whose body never finishes is a server error, not tracking-disabled', async () => {
  const hung = { status: 403, ok: false, text: () => new Promise(() => {}) };
  const { fetchImpl } = scriptedFetch([hung]);
  assert.deepEqual(await postReportBatch(REPORTS, session(), opts(fetchImpl, { readMs: 20 })), { kind: 'server-error', status: 403, code: null, message: null });
});

test('a body read that rejects is treated as no body', async () => {
  const broken = { status: 500, ok: false, text: () => Promise.reject(new Error('socket hang up')) };
  const { fetchImpl } = scriptedFetch([broken]);
  assert.deepEqual(await postReportBatch(REPORTS, session(), opts(fetchImpl)), { kind: 'server-error', status: 500 });
});

test('a non-2xx body is drained', async () => {
  let read = 0;
  const res = { status: 500, ok: false, text: async () => { read += 1; return ''; } };
  const { fetchImpl } = scriptedFetch([res]);
  await postReportBatch(REPORTS, session(), opts(fetchImpl));
  assert.equal(read, 1);
});

// A results verdict deletes files by position, so an answer whose echoed segmentId disagrees with
// the report sent at that position must never be acted on.
test('a result echoing a different segmentId at its position falls back', async () => {
  const { fetchImpl } = scriptedFetch([response(200, { results: [
    { segmentId: 's1:11-20', status: 'stored' },
    { segmentId: 's1:1-10', status: 'stored' },
  ] })]);
  assert.deepEqual(await postReportBatch(REPORTS, session(), opts(fetchImpl)), { kind: 'fallback', status: 200 });
});

test('one misaligned segmentId among aligned ones falls back', async () => {
  const { fetchImpl } = scriptedFetch([response(200, { results: [
    { segmentId: 's1:1-10', status: 'stored' },
    { segmentId: 's9:11-20', status: 'stored' },
  ] })]);
  assert.deepEqual(await postReportBatch(REPORTS, session(), opts(fetchImpl)), { kind: 'fallback', status: 200 });
});

test('a result without a segmentId is still matched by position', async () => {
  const { fetchImpl } = scriptedFetch([response(200, { results: [
    { status: 'stored' },
    { segmentId: 's1:11-20', status: 'retry' },
  ] })]);
  assert.deepEqual(await postReportBatch(REPORTS, session(), opts(fetchImpl)), {
    kind: 'results',
    results: [
      { segmentId: null, status: 'stored', code: null },
      { segmentId: 's1:11-20', status: 'retry', code: null },
    ],
  });
});

// One postReportBatch never outlives its timeoutMs: the plain resend of a refused gzip body gets only
// what the first attempt left.
test('the plain resend after a refused gzip body gets only the time the first attempt left', async () => {
  let clock = 0;
  let calls = 0;
  const fetchImpl = (url, init) => {
    calls += 1;
    if (calls === 1) {
      clock += 2950;
      return Promise.resolve(response(415));
    }
    return new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  };
  const started = Date.now();
  const out = await postReportBatch(REPORTS, session(), opts(fetchImpl, { timeoutMs: 3000, now: () => clock }));
  assert.deepEqual(out, { kind: 'network', gzipRefused: true });
  assert.equal(calls, 2);
  assert.ok(Date.now() - started < 1500, 'the resend is bounded by the 50 ms left, not a fresh 3 s');
});

test('a refused gzip body with no time left is not resent', async () => {
  let clock = 0;
  const { fetchImpl, calls } = scriptedFetch([response(415), response(200, STORED_ALL)]);
  const timed = async (url, init) => { clock += 3000; return fetchImpl(url, init); };
  const out = await postReportBatch(REPORTS, session(), opts(timed, { timeoutMs: 3000, now: () => clock }));
  assert.deepEqual(out, { kind: 'network', gzipRefused: true });
  assert.equal(calls.length, 1);
});
