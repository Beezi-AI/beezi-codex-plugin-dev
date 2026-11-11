import '../tools/hermetic-env.mjs';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { UPLOAD_STEPS } from '../lib/upload-worker.mjs';
import { runCheckpoint } from '../lib/checkpoint.mjs';
import { grantConsent, grantCorrelation } from '../lib/diagnostics.mjs';
import { forgetHeldLocks } from '../lib/single-instance-lock.mjs';
import { tmpHome as sandboxHome } from '../tools/suite-fixtures.mjs';
import { linkAccount } from '../tools/account-fixtures.mjs';

// The installation binding (associate this machine's installation id with an account) used to run
// at the end of every non-local checkpoint. The worker's due checkpoints now skip their inline
// flush, which also skipped the binding, so the worker binds in a step of its own. The inline
// checkpoint (track) still binds.

afterEach(() => forgetHeldLocks());

const T0 = Date.parse('2026-11-05T10:00:00.000Z');
const KEY_A = 'aaaa1111';
const KEY_B = 'bbbb2222';
const session = (key, over = {}) => ({ key, token: `tok-${key}`, clientId: `c-${key}`, tenantId: null, ...over });
const ROUTE = '/cli-agent/plugin-diagnostics/installation';

function home(t, { correlation = true } = {}) {
  const dir = sandboxHome(t, { prefix: 'beezi-binding-' });
  linkAccount(dir, KEY_A);
  if (correlation) { grantConsent(); grantCorrelation(); }
  return dir;
}

// Records every request; the binding route answers 200, everything else is offline.
function recorder() {
  const posts = [];
  const fetchImpl = async (url, init) => {
    posts.push({ url: String(url), auth: init.headers.Authorization, tenant: init.headers['X-Beezi-Tenant'], body: JSON.parse(init.body) });
    if (String(url).endsWith(ROUTE)) return { status: 200, json: async () => ({}) };
    throw new Error('offline');
  };
  return { posts, fetchImpl, bindings: () => posts.filter((p) => p.url.endsWith(ROUTE)) };
}

const step = () => UPLOAD_STEPS.find((s) => s.name === 'installation-binding');
const ctxOf = (over = {}) => ({
  sessions: [session(KEY_A)], deadline: T0 + 270000, now: () => T0, fetchImpl: null, batch: true, status: {}, due: [], deps: {}, ...over,
});

test('the worker runs the installation binding as its own step, before diagnostics', () => {
  assert.deepEqual(UPLOAD_STEPS.map((s) => s.name), ['queue', 'due-sessions', 'rate-limits', 'installation-binding', 'diagnostics']);
});

test('the binding step binds with a tokened session of the run, account-wide, and answers no work', async (t) => {
  home(t);
  const rec = recorder();
  const result = await step().run(ctxOf({ sessions: [session(KEY_A, { tenantId: 'ws-1' })], fetchImpl: rec.fetchImpl }));
  assert.deepEqual(result, { progress: 0, remaining: 0 });
  const bound = rec.bindings();
  assert.equal(bound.length, 1);
  assert.equal(bound[0].auth, 'Bearer tok-aaaa1111');
  assert.equal(bound[0].tenant, undefined, 'binding is account-wide: no workspace header');
  assert.deepEqual(Object.keys(bound[0].body).sort(), ['consentVersion', 'installationId']);
});

test('the binding step prefers the default account among the run\'s sessions', async (t) => {
  const dir = home(t);
  linkAccount(dir, KEY_B);
  const rec = recorder();
  await step().run(ctxOf({ sessions: [session(KEY_A), session(KEY_B)], fetchImpl: rec.fetchImpl, deps: { getDefaultKey: async () => KEY_B } }));
  assert.deepEqual(rec.bindings().map((p) => p.auth), ['Bearer tok-bbbb2222']);
});

test('a bound installation is not bound again on the next pass', async (t) => {
  home(t);
  const rec = recorder();
  await step().run(ctxOf({ fetchImpl: rec.fetchImpl }));
  await step().run(ctxOf({ fetchImpl: rec.fetchImpl }));
  assert.equal(rec.bindings().length, 1);
});

test('the binding step posts nothing without correlation consent', async (t) => {
  home(t, { correlation: false });
  const rec = recorder();
  assert.deepEqual(await step().run(ctxOf({ fetchImpl: rec.fetchImpl })), { progress: 0, remaining: 0 });
  assert.deepEqual(rec.posts, []);
});

test('the binding step starts nothing at or past the deadline', async (t) => {
  home(t);
  const rec = recorder();
  assert.deepEqual(await step().run(ctxOf({ fetchImpl: rec.fetchImpl, deadline: T0 })), { progress: 0, remaining: 0 });
  assert.deepEqual(rec.posts, []);
});

test('the binding step never fails a run, even when the request throws', async (t) => {
  home(t);
  const fetchImpl = async () => { throw new Error('offline'); };
  assert.deepEqual(await step().run(ctxOf({ fetchImpl })), { progress: 0, remaining: 0 });
});

// ── the inline checkpoint ───────────────────────────────────────────────────────────────────────

function checkpointWorld(dir, rec) {
  const transcriptPath = path.join(dir, 'rollout-s1.jsonl');
  fs.writeFileSync(transcriptPath, '\n');
  return {
    linkedSessions: async () => [session(KEY_A)],
    resolveTranscript: () => ({ transcriptPath, sessionId: 's1' }),
    computeDelta: () => ({ nextCursor: 1, segments: [], apiErrorEvents: [] }),
    gitImpl: () => 'https://host/org/repo.git',
    findPlanPredecessor: () => null,
    fetchImpl: rec.fetchImpl,
  };
}

test('an inline checkpoint (track) still binds the installation after its flush', async (t) => {
  const dir = home(t);
  const rec = recorder();
  const result = await runCheckpoint({ session_id: 's1', cwd: dir }, checkpointWorld(dir, rec), {});
  assert.equal(result.outcome, 'committed');
  assert.deepEqual(rec.bindings().map((p) => p.auth), ['Bearer tok-aaaa1111']);
});

test('a checkpoint told to skip its flush skips the binding too', async (t) => {
  const dir = home(t);
  const rec = recorder();
  await runCheckpoint({ session_id: 's1', cwd: dir }, checkpointWorld(dir, rec), { skipFlush: true });
  assert.deepEqual(rec.bindings(), []);
});
