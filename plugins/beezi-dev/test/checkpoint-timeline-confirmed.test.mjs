import '../tools/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCheckpoint } from '../lib/checkpoint.mjs';
import { tmpHome as sandboxHome } from '../tools/suite-fixtures.mjs';
import { accountSession, TEST_KEY } from '../tools/account-fixtures.mjs';

// `timelineConfirmed` on runCheckpoint's result: the upload worker keeps a session's due marker
// until the timeline it owes is confirmed by every sender, because the timeline POST itself is
// best-effort and a committed checkpoint says nothing about it.

const SESSION = accountSession(TEST_KEY, 'tok');
const T = Date.parse('2026-05-01T10:00:00.000Z');
const rec = (ms, type, payload) => ({ timestamp: new Date(ms).toISOString(), type, payload });

function rollout(home) {
  const file = path.join(home, 'rollout-s1.jsonl');
  fs.writeFileSync(file, [
    rec(T, 'session_meta', { id: 's1', cwd: home }),
    rec(T + 1000, 'event_msg', { type: 'user_message', message: 'do it' }),
    rec(T + 5000, 'event_msg', { type: 'agent_message' }),
    rec(T + 6000, 'event_msg', { type: 'task_complete' }),
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

// Timeline POSTs answer `status`; every other request is offline, so reports stay queued.
function deps(home, status, posts = []) {
  const file = rollout(home);
  return {
    linkedSessions: async () => [SESSION],
    resolveTranscript: () => ({ transcriptPath: file, sessionId: 's1' }),
    computeDelta: () => ({ nextCursor: 4, segments: [], apiErrorEvents: [] }),
    gitImpl: () => 'https://host/org/repo.git',
    drainRateLimitSnapshots: async () => ({ posted: 0 }),
    findPlanPredecessor: () => null,
    fetchImpl: async (url) => {
      if (String(url).indexOf('/sessions/timeline') === -1) throw new Error('offline');
      posts.push(url);
      return { status };
    },
  };
}
const TURN_END = { emitTimeline: true, skipFlush: true };

test('a timeline every sender stored is reported confirmed', async (t) => {
  const home = sandboxHome(t, 'beezi-tl-');
  const posts = [];
  const result = await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, 200, posts), TURN_END);
  assert.equal(posts.length, 1);
  assert.equal(result.timelineConfirmed, true);
  assert.equal(result.timelineConfirmedLive, true);
});

test('a timeline post the server refused is reported unconfirmed even though the checkpoint committed', async (t) => {
  const home = sandboxHome(t, 'beezi-tl-');
  const result = await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, 500), TURN_END);
  assert.equal(result.outcome, 'committed');
  assert.equal(result.timelineConfirmed, false);
  assert.equal(result.timelineConfirmedLive, false);
});

test('a timeline identical to the one already sent needs no post and counts as confirmed', async (t) => {
  const home = sandboxHome(t, 'beezi-tl-');
  await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, 200), TURN_END);
  const posts = [];
  const again = await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, 500, posts), TURN_END);
  assert.equal(posts.length, 0);
  assert.equal(again.timelineConfirmed, true);
  assert.equal(again.timelineConfirmedLive, true);
});

test('a tokenless sender leaves the timeline unconfirmed, but confirmed for every live sender', async (t) => {
  // The worker tells "a live sender failed" (retry, back off) from "only a sender with no token this
  // run is missing it" (nothing this run can do) by the second field.
  const home = sandboxHome(t, 'beezi-tl-');
  const posts = [];
  const d = deps(home, 200, posts);
  const result = await runCheckpoint({ session_id: 's1', cwd: home }, d,
    { ...TURN_END, sessions: [SESSION, { ...accountSession('b2c3d4e5', null), token: null }] });
  assert.equal(posts.length, 1);
  assert.equal(result.timelineConfirmed, false);
  assert.equal(result.timelineConfirmedLive, true);
});

test('a live sender refusing the timeline beside a tokenless one is unconfirmed on both fields', async (t) => {
  const home = sandboxHome(t, 'beezi-tl-');
  const result = await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, 500),
    { ...TURN_END, sessions: [SESSION, { ...accountSession('b2c3d4e5', null), token: null }] });
  assert.equal(result.timelineConfirmed, false);
  assert.equal(result.timelineConfirmedLive, false);
});

test('a checkpoint that was not asked for a timeline reports null', async (t) => {
  const home = sandboxHome(t, 'beezi-tl-');
  const result = await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, 200), { skipFlush: true });
  assert.equal(result.timelineConfirmed, null);
  assert.equal(result.timelineConfirmedLive, null);
});

// `errorsPendingLive`: whether a parked API error is still owed to a sender that HAD a token this
// run. The worker keeps the due marker while it is true; a transient failure must not clear the
// marker and leave the error waiting for the session's next activity.
const API_ERROR = { error: 'usage_limit_exceeded', text: 'You hit the limit', occurredAt: '2026-05-01T10:00:03.000Z' };

function errorDeps(home, status, posts = []) {
  const d = deps(home, 200);
  return {
    ...d,
    computeDelta: () => ({ nextCursor: 4, segments: [], apiErrorEvents: [API_ERROR] }),
    fetchImpl: async (url) => {
      if (String(url).indexOf('/sessions/errors') === -1) throw new Error('offline');
      posts.push(url);
      return { status, json: async () => ({}) };
    },
  };
}
const NO_TIMELINE = { skipFlush: true };

test('an error a live sender refused is reported still owed to a live sender', async (t) => {
  const home = sandboxHome(t, 'beezi-tl-');
  const posts = [];
  const result = await runCheckpoint({ session_id: 's1', cwd: home }, errorDeps(home, 500, posts), NO_TIMELINE);
  assert.equal(posts.length, 1);
  assert.equal(result.outcome, 'committed');
  assert.equal(result.errorsPendingLive, true);
});

test('an error every sender took leaves nothing owed', async (t) => {
  const home = sandboxHome(t, 'beezi-tl-');
  const result = await runCheckpoint({ session_id: 's1', cwd: home }, errorDeps(home, 200), NO_TIMELINE);
  assert.equal(result.errorsPendingLive, false);
});

test('an error only a tokenless sender still owes is not owed to a live sender', async (t) => {
  const home = sandboxHome(t, 'beezi-tl-');
  const posts = [];
  const result = await runCheckpoint({ session_id: 's1', cwd: home }, errorDeps(home, 200, posts),
    { ...NO_TIMELINE, sessions: [SESSION, { ...accountSession('b2c3d4e5', null), token: null }] });
  assert.equal(posts.length, 1);
  assert.equal(result.errorsPendingLive, false);
});

test('an error a live sender refused beside a tokenless one is still owed to a live sender', async (t) => {
  const home = sandboxHome(t, 'beezi-tl-');
  const result = await runCheckpoint({ session_id: 's1', cwd: home }, errorDeps(home, 500),
    { ...NO_TIMELINE, sessions: [SESSION, { ...accountSession('b2c3d4e5', null), token: null }] });
  assert.equal(result.errorsPendingLive, true);
});

test('a checkpoint with no error at all reports nothing owed', async (t) => {
  const home = sandboxHome(t, 'beezi-tl-');
  const result = await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, 200), NO_TIMELINE);
  assert.equal(result.errorsPendingLive, false);
});
