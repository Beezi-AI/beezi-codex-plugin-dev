import '../tools/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withCodexAuth } from '../tools/hermetic-env.mjs';
import { makeHome, TEST_KEY } from '../tools/account-fixtures.mjs';
import { initSessionWorkspace } from '../lib/workspace.mjs';
import { countPastSessions, pastSessions } from '../lib/past-sessions.mjs';

const now = Date.parse('2026-10-21T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const e = (sessionId, cwd, ageMs, size = 10) => ({ sessionId, cwd, mtimeMs: now - ageMs, size });
const keyOf = (dir) => ({ kind: 'folder', match: dir.split('/').slice(0, 3).join('/') });

test('counts what the upload would send, and the distinct places, less here', () => {
  const entries = [
    e('live', '/work/a', DAY), e('s1', '/work/a/x', DAY), e('s2', '/work/b', DAY),
    e('active', '/work/c', 10 * 60 * 1000), e('big', '/work/d', DAY, 65 * 1024 * 1024),
    e('old', '/work/e', 31 * DAY), e('done', '/work/f', DAY), e('nodir', null, DAY),
  ];
  const counts = countPastSessions(entries, {
    liveSessionId: 'live', now, imported: (id) => id === 'done', readCwd: (en) => en.cwd, keyOf,
    hereKey: { kind: 'folder', match: '/work/a' },
  });
  assert.deepEqual(counts, { sessions: 3, places: 1 });
});

test('a recorded session directory wins over the rollout cwd, and places dedupe', () => {
  const entries = [e('s1', '/work/elsewhere', DAY), e('s2', '/work/b', DAY)];
  const counts = countPastSessions(entries, {
    now, imported: () => false, readState: (id) => (id === 's1' ? { cwd: '/work/b/x' } : null), readCwd: (en) => en.cwd, keyOf,
  });
  assert.deepEqual(counts, { sessions: 2, places: 1 });
});

const UUID_A = '019fd897-9320-7c20-9585-8fa3fff07bf7';
const UUID_B = '029fd897-9320-7c20-9585-8fa3fff07bf8';

// Two finished rollouts outside a project (`/` keys without a git walk), two days old.
function twoRollouts(t) {
  const dir = path.join(withCodexAuth(t, null), 'sessions', '2026', '10', '19');
  fs.mkdirSync(dir, { recursive: true });
  const at = (Date.now() - 2 * DAY) / 1000;
  for (const id of [UUID_A, UUID_B]) {
    const file = path.join(dir, `rollout-2026-10-19T00-00-00-${id}.jsonl`);
    fs.writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { id, session_id: id, thread_source: 'user', source: 'cli', cwd: '/' } })}\n`);
    fs.utimesSync(file, at, at);
  }
}

test('pastSessions leaves out the session its caller runs in, by the env it is given', (t) => {
  makeHome(t);
  twoRollouts(t);
  const row = { key: TEST_KEY, clientId: 'c-test', tenants: [{ id: 'A', name: 'Acme' }, { id: 'B', name: 'Beta' }] };
  assert.equal(pastSessions(row, null, { cwd: '/work/none', env: {} }).sessions, 2);
  assert.equal(pastSessions(row, null, { cwd: '/work/none', env: { CODEX_THREAD_ID: UUID_A } }).sessions, 1);
  // With no thread id, the newest session recorded for the caller's directory is the live one (currentSession's rule).
  initSessionWorkspace(UUID_B, { cwd: '/work/here' });
  assert.equal(pastSessions(row, null, { cwd: '/work/here', env: {} }).sessions, 1);
});
