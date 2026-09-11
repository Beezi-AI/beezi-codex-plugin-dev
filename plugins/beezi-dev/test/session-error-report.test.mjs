import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { postSessionError } from '../lib/session-error-report.mjs';

test('POSTs the payload to /sessions/errors with bearer auth', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return { status: 200 }; };
  const res = await postSessionError(
    { sessionId: 's1', error: 'rate_limit', errorDetails: null,
      lastAssistantMessage: 'resets 4:30pm (Europe/Kiev)', occurredAt: '2026-07-08T10:00:00.000Z' },
    'my-token',
    { fetchImpl },
  );
  assert.equal(res.reported, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/sessions\/errors$/);
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer my-token');
  assert.deepEqual(JSON.parse(calls[0].opts.body), {
    sessionId: 's1', error: 'rate_limit', errorDetails: null,
    lastAssistantMessage: 'resets 4:30pm (Europe/Kiev)', occurredAt: '2026-07-08T10:00:00.000Z',
  });
});

test('reports false without a token (no fetch)', async () => {
  const calls = [];
  const fetchImpl = async () => { calls.push(1); return { status: 200 }; };
  const res = await postSessionError({ sessionId: 's1', error: 'rate_limit' }, null, { fetchImpl });
  assert.equal(res.reported, false);
  assert.equal(res.reason, 'no-token');
  assert.equal(calls.length, 0);
});

test('a non-2xx records one diagnostic carrying only the status — never the payload', async () => {
  const issues = [];
  const fetchImpl = async () => ({ status: 422 });
  const res = await postSessionError(
    { sessionId: 's1', error: 'rate_limit', lastAssistantMessage: 'you are over your ACME Corp quota' },
    'tok',
    { fetchImpl, recordIssue: (issue) => { issues.push(issue); return true; } },
  );

  assert.equal(res.reported, false);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'queue_flush_http_error');
  assert.equal(issues[0].source, 'report');
  assert.equal(issues[0].httpStatus, 422);
  assert.deepEqual(Object.keys(issues[0]).sort(), ['code', 'httpStatus', 'source']);
});

test('a transport failure records the error object, and a 2xx records nothing', async () => {
  const issues = [];
  const boom = async () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }); };
  const failed = await postSessionError({ sessionId: 's1', error: 'rate_limit' }, 'tok', {
    fetchImpl: boom,
    recordIssue: (issue) => { issues.push(issue); return true; },
  });
  assert.equal(failed.reason, 'network');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].error.name, 'TypeError');

  const quiet = [];
  await postSessionError({ sessionId: 's1', error: 'rate_limit' }, 'tok', {
    fetchImpl: async () => ({ status: 201 }),
    recordIssue: (issue) => { quiet.push(issue); return true; },
  });
  assert.deepEqual(quiet, []);
});

test('the real recordIssue writes nothing on a machine that never consented', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-session-error-'));
  const prev = process.env.BEEZI_CODEX_HOME;
  process.env.BEEZI_CODEX_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CODEX_HOME;
    else process.env.BEEZI_CODEX_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const res = await postSessionError({ sessionId: 's1', error: 'rate_limit' }, 'tok', {
    fetchImpl: async () => ({ status: 500 }),
  });

  assert.equal(res.reported, false);
  assert.equal(fs.existsSync(path.join(dir, 'diagnostics')), false);
});
