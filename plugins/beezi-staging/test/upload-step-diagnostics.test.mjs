import '../tools/hermetic-env.mjs';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { UPLOAD_STEPS } from '../lib/upload-worker.mjs';
import { diagnosticsStep } from '../lib/upload-step-diagnostics.mjs';
import {
  grantConsent, recordIssue, diagnosticsDir, DIAGNOSTIC_CODES,
} from '../lib/diagnostics.mjs';
import { readSendState } from '../lib/telemetry-flush.mjs';
import { forgetHeldLocks } from '../lib/single-instance-lock.mjs';
import { tmpHome as sandboxHome, recordingFetch, hangingFetch } from '../tools/suite-fixtures.mjs';

// The diagnostics flush the Stop hook used to run inline, as an upload-worker step: the hook no
// longer posts anything, and the worker delivers the consented diagnostics on its run.

afterEach(() => forgetHeldLocks());

const tmpHome = (t) => sandboxHome(t, 'beezi-diagstep-');
const T0 = Date.parse('2026-05-01T10:00:00.000Z');
const events = () => {
  try { return fs.readdirSync(diagnosticsDir()).filter((n) => n.endsWith('.json')); } catch { return []; }
};

// The server accepts every event it is sent.
const accepting = () => recordingFetch(async (url, opts) => ({
  status: 200,
  headers: { get: () => null },
  json: async () => ({ acceptedEventIds: JSON.parse(opts.body).events.map((e) => e.eventId), rejected: [] }),
}));

const ctx = (over = {}) => ({
  sessions: [],
  deadline: Date.now() + 60000,
  now: () => Date.now(),
  fetchImpl: null,
  batch: true,
  status: {},
  due: [],
  deps: {},
  ...over,
});

test('the worker runs the diagnostics step after its upload steps', () => {
  const names = UPLOAD_STEPS.map((s) => s.name);
  assert.equal(names.indexOf('diagnostics') > names.indexOf('rate-limits'), true);
  assert.equal(UPLOAD_STEPS.find((s) => s.name === 'diagnostics'), diagnosticsStep);
});

test('consented diagnostics are delivered to the public route and leave no work behind', async (t) => {
  tmpHome(t);
  grantConsent();
  recordIssue({ code: DIAGNOSTIC_CODES.HOOK_CRASH });
  const fetchImpl = accepting();

  const result = await diagnosticsStep.run(ctx({ fetchImpl }));

  assert.equal(fetchImpl.calls.length, 1);
  assert.match(String(fetchImpl.calls[0].url), /\/cli-agent\/plugin-diagnostics\/public$/);
  assert.equal(fetchImpl.calls[0].opts.headers.Authorization, undefined);
  assert.deepEqual(events(), []);
  assert.deepEqual(result, { progress: 0, remaining: 0 });
});

test('without consent nothing is posted', async (t) => {
  tmpHome(t);
  const fetchImpl = accepting();

  const result = await diagnosticsStep.run(ctx({ fetchImpl }));

  assert.equal(fetchImpl.calls.length, 0);
  assert.deepEqual(result, { progress: 0, remaining: 0 });
});

test('a step that starts at the deadline posts nothing and keeps the events', async (t) => {
  tmpHome(t);
  grantConsent();
  recordIssue({ code: DIAGNOSTIC_CODES.HOOK_CRASH });
  const fetchImpl = accepting();

  await diagnosticsStep.run(ctx({ fetchImpl, now: () => T0, deadline: T0 }));

  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(events().length, 1);
});

test('a refused delivery is not work left, so it never stalls the upload run', async (t) => {
  tmpHome(t);
  grantConsent();
  recordIssue({ code: DIAGNOSTIC_CODES.HOOK_CRASH });
  const fetchImpl = recordingFetch(async () => ({ status: 503, headers: { get: () => null }, json: async () => ({}) }));

  const result = await diagnosticsStep.run(ctx({ fetchImpl }));

  assert.equal(fetchImpl.calls.length, 1);
  assert.deepEqual(result, { progress: 0, remaining: 0 });
  assert.equal(events().length, 1);
});

test('a request the worker deadline cut short does not escalate the shared backoff', async (t) => {
  tmpHome(t);
  grantConsent();
  recordIssue({ code: DIAGNOSTIC_CODES.HOOK_CRASH });
  const fetchImpl = recordingFetch(hangingFetch());

  // A frozen worker clock 30 ms short of its deadline: the request's timeout is the 30 ms left.
  const result = await diagnosticsStep.run(ctx({ fetchImpl, now: () => T0, deadline: T0 + 30 }));

  assert.equal(fetchImpl.calls.length, 1);
  assert.deepEqual(result, { progress: 0, remaining: 0 });
  assert.equal(events().length, 1);
  assert.equal(readSendState().attempts, 0);
});
