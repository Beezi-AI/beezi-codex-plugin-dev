import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withoutGuard } from '../tools/hermetic-env.mjs';
import { makeHome, linkAccount, TEST_KEY } from '../tools/account-fixtures.mjs';
import { settledHome } from '../tools/spawn-fixtures.mjs';
import { syncReview, workspaceCommand } from '../lib/workspace-cli.mjs';
import { listAllRollouts } from '../lib/transcript-index-codex.mjs';
import { UserError } from '../lib/friendly-error.mjs';

// sync.mjs --review: the sync skill's step 1 listings and the upload in one call, stopping only for a question.

const SYNC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'sync.mjs');
const OLD = [
  { id: 'X', name: 'Xco', joinedAt: '2026-01-01T00:00:00.000Z' },
  { id: 'Y', name: 'Yco', joinedAt: '2026-01-01T00:00:00.000Z' },
];
const JOINED = [OLD[0], { id: 'T', name: 'NewCo', joinedAt: '2026-10-10T00:00:00.000Z' }];
// Plain folders outside home and temp (temp keys as `outside`).
const R1 = path.resolve('/beezi-sync-review-test/r1');
const R2 = path.resolve('/beezi-sync-review-test/r2');
const NOTHING = ['<joined>', 'joined=0', '</joined>', '<routes>', 'routes=0', '</routes>', 'review=0'];

function link(t, tenants) {
  linkAccount(makeHome(t), TEST_KEY, { tenants, linkedAt: '2026-10-01T00:00:00.000Z' });
}

// Two past sessions with no rule, one per folder; the listings must never start an upload.
function deps(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-sync-review-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, '2026', '10', '13');
  fs.mkdirSync(dir, { recursive: true });
  const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
  for (const [id, cwd] of [['019fd897-9320-7c20-9585-8fa3fff07c01', R1], ['019fd897-9320-7c20-9585-8fa3fff07c02', R2]]) {
    const file = path.join(dir, `rollout-2026-10-13T00-00-00-${id}.jsonl`);
    const meta = { timestamp: '2026-10-13T00:00:00.000Z', type: 'session_meta', payload: { id, thread_source: 'user', source: 'cli', cwd } };
    fs.writeFileSync(file, `${JSON.stringify(meta)}\n`);
    fs.utimesSync(file, twoHoursAgo, twoHoursAgo);
  }
  return {
    listAllRollouts: () => listAllRollouts({ sessionsDir: root }),
    startHistoryWorker: async () => { throw new Error('a listing must not start an upload'); },
  };
}

test('nothing to ask: both listings, then review=0', async (t) => {
  link(t, OLD);
  const out = await syncReview(false, TEST_KEY, { listAllRollouts: () => [] });
  assert.deepEqual(out.lines, NOTHING);
  assert.equal(out.review, 0);
});

test('a joined workspace stops after <joined>, before the routes listing', async (t) => {
  link(t, JOINED);
  const out = await syncReview(false, TEST_KEY, deps(t));
  assert.equal(out.review, 2);
  assert.equal(out.lines[0], '<joined>');
  assert.equal(out.lines.filter((line) => /^J\d+\. /.test(line)).length, 2);
  assert.ok(out.lines.some((line) => /^J1-command=.* --defer-upload <tenant>$/.test(line)));
  assert.deepEqual(out.lines.slice(-3), ['joined=2', '</joined>', 'review=2']);
  assert.ok(!out.lines.includes('<routes>'), 'a J answer can give these places a rule, so routes waits');
});

test('repos and folders with no rule stop after <routes>, with deferred rule commands', async (t) => {
  link(t, OLD);
  const out = await syncReview(false, TEST_KEY, deps(t));
  assert.equal(out.review, 2);
  assert.deepEqual(out.lines.slice(0, 4), ['<joined>', 'joined=0', '</joined>', '<routes>']);
  assert.equal(out.lines.filter((line) => /^P\d+\. /.test(line)).length, 2);
  assert.ok(out.lines.some((line) => /^P1-command=.* --account a1b2c3d4 --defer-upload <tenants>$/.test(line)));
  assert.deepEqual(out.lines.slice(-3), ['routes=2', '</routes>', 'review=2']);
});

test('fromRoutes starts at the routes listing', async (t) => {
  link(t, OLD);
  const out = await syncReview(true, TEST_KEY, deps(t));
  assert.equal(out.lines[0], '<routes>');
  assert.ok(!out.lines.includes('<joined>'));
  assert.deepEqual(out.lines.slice(-3), ['routes=2', '</routes>', 'review=2']);
});

test('a failed listing shows its ✗ line in its block and asks nothing', async (t) => {
  link(t, JOINED);
  const out = await syncReview(false, TEST_KEY, { listAllRollouts: () => { throw new UserError('rollouts unreadable'); } });
  assert.equal(out.review, 0);
  assert.deepEqual(out.lines.slice(0, 3), ['<joined>', '✗ rollouts unreadable', '</joined>']);
  assert.equal(out.lines[out.lines.length - 1], 'review=0');
});

test('the joined and routes listings report their J and P line counts; other commands add no count', async (t) => {
  link(t, OLD);
  const d = deps(t);
  assert.equal((await workspaceCommand(['joined', '--account', TEST_KEY], d)).count, 0);
  assert.equal((await workspaceCommand(['routes', '--account', TEST_KEY], d)).count, 2);
  const rules = await workspaceCommand(['rules', '--account', TEST_KEY], { ...d, cwd: os.homedir() });
  assert.equal(rules.ok, true, rules.stderr.join('\n'));
  assert.equal('count' in rules, false);
});

// ── the script ──────────────────────────────────────────────────────────────────────────────

function sync(t, args) {
  const home = settledHome(t, 'beezi-sync-review-home-');
  const env = { ...process.env, HOME: home, USERPROFILE: home, BEEZI_CODEX_HOME: home, CODEX_HOME: path.join(home, '.codex') };
  delete env.NODE_TEST_CONTEXT;
  const res = withoutGuard(() => spawnSync(process.execPath, [SYNC, ...args], { cwd: home, encoding: 'utf-8', timeout: 60_000, env }));
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

test('sync.mjs --review prints both listings and goes on to the sync when nothing needs a question', (t) => {
  const res = sync(t, ['--review']);
  assert.equal(res.stdout, `${NOTHING.join('\n')}\n`);
  assert.match(res.stderr, /this machine is not linked/, 'the sync itself ran, as plain sync.mjs does');
  assert.equal(res.status, 1);
});

test('sync.mjs --review and --review-routes together are refused before anything is read', (t) => {
  const res = sync(t, ['--review', '--review-routes']);
  assert.equal(res.status, 1);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /pass --review or --review-routes, not both/);
});

test('sync.mjs --review still refuses --force first', (t) => {
  const res = sync(t, ['--review', '--force']);
  assert.notEqual(res.status, 0);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /takes no --force/);
});
