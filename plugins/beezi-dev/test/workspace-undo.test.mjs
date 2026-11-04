import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHome, linkAccount, TEST_KEY } from '../tools/account-fixtures.mjs';
import { getAccount, setWorkspaceRule } from '../lib/accounts.mjs';
import { createRouteContext } from '../lib/workspace-rules.mjs';
import { initSessionWorkspace, readSessionWorkspace } from '../lib/workspace.mjs';
import { enqueueHeld } from '../lib/workspace-queue.mjs';
import { queueDir } from '../lib/paths.mjs';
import { hereLine, pickerLines, pickerPlaces, workspaceCommand } from '../lib/workspace-cli.mjs';
import { sessionAnonymization } from '../lib/anonymization.mjs';

const TENANTS = [{ id: 'A', name: 'Acme' }, { id: 'B', name: 'Beta' }];
const SOLO = 'e5f6a7b8';
const UNDO = ' Undo: ask the settings skill to undo.';
const KEPT = ' Sessions already uploaded stay where they went.';
const REMOTE = 'github.com/acme/api';
// Fixed absolute paths that do not exist: they key as folders (or the mapped repo), never as outside.
const REPO = '/work/api';
const NOTES = '/work/notes';
const HERE = '/work/here';
const MAP = { version: 1, roots: { [REPO]: { origin: `https://${REMOTE}.git` } } };
const ctx = () => createRouteContext({ loadRepoMapImpl: () => MAP });
const HOUR = 60 * 60 * 1000;
const entry = (sessionId, cwd, ageMs = 2 * HOUR) => ({ sessionId, transcriptPath: `/t/${sessionId}.jsonl`, cwd, mtimeMs: Date.now() - ageMs, size: 10 });
const OUTSIDE_A = { kind: 'outside', match: 'outside', label: 'outside a project', tenantIds: ['A'] };
const REPO_B = { kind: 'repo', match: REMOTE, label: REMOTE, tenantIds: ['B'] };

// No upload worker, no keychain, no real rollouts, and a directory with no session recorded for it.
const deps = { startHistoryWorker: async () => {}, getAuthentication: async () => null, listAllRollouts: () => [], cwd: HERE };
const run = async (argv, extra = {}) => {
  const out = await workspaceCommand(argv, { ...deps, ...extra });
  assert.equal(out.ok, true, out.stderr.join('\n'));
  return out.lines.filter((l) => !l.startsWith('here:'));
};

// One past Codex rollout under a CODEX_HOME of its own, for the counts that read this machine's rollouts.
function seedRollout(t, cwd) {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-undo-codex-'));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    fs.rmSync(codexHome, { recursive: true, force: true });
  });
  const id = '11111111-2222-3333-4444-555555555555';
  const dir = path.join(codexHome, 'sessions', '2026', '10', '19');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-10-19T00-00-00-${id}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { id, cwd } })}\n`);
  const old = new Date(Date.now() - 2 * 24 * HOUR);
  fs.utimesSync(file, old, old);
}

test('a rule add confirms where it now goes, and undo takes it back', async (t) => {
  linkAccount(makeHome(t), TEST_KEY, { tenants: TENANTS });
  assert.deepEqual(await run(['rule', 'add', '--repo', 'github.com/acme/api', '--account', TEST_KEY, 'B']),
    [`✓ api → Beta (rule R1).${UNDO}`, 'rule=1']);
  assert.deepEqual(await run(['undo']), [`✓ Undid your last change: api → Beta (rule R1).${KEPT}`, 'undone=1']);
  assert.deepEqual((await getAccount(TEST_KEY)).workspaceRules, []);
  assert.deepEqual(await run(['undo']), ['Nothing to undo.', 'undone=0']);
});

test('a set names the old target', async (t) => {
  linkAccount(makeHome(t), TEST_KEY, { tenants: TENANTS });
  await run(['rule', 'add', '--repo', 'github.com/acme/api', '--account', TEST_KEY, 'A', 'B']);
  assert.deepEqual(await run(['rule', 'set', '1', 'none', '--account', TEST_KEY]),
    [`✓ api → not tracked (rule R1). Before: Acme and Beta.${UNDO}`, 'rule=1']);
  assert.deepEqual(await run(['undo']),
    [`✓ Undid your last change: api → not tracked (rule R1). It's back to Acme and Beta.${KEPT}`, 'undone=1']);
  assert.deepEqual((await getAccount(TEST_KEY)).workspaceRules[0].tenantIds, ['A', 'B']);
});

test('undo refuses when the rules changed after that change, writes nothing and forgets it', async (t) => {
  const home = makeHome(t);
  linkAccount(home, TEST_KEY, { tenants: TENANTS });
  await run(['rule', 'add', '--outside', 'A', '--account', TEST_KEY]);
  await setWorkspaceRule(TEST_KEY, { kind: 'repo', match: REMOTE, label: REMOTE, tenantIds: ['B'] });
  const index = path.join(home, 'accounts.json');
  const bytes = fs.readFileSync(index, 'utf-8');
  assert.deepEqual(await run(['undo']), ['Nothing undone: the rules changed after that change.', 'undone=0']);
  assert.equal(fs.readFileSync(index, 'utf-8'), bytes);
  assert.deepEqual(await run(['undo']), ['Nothing to undo.', 'undone=0']);
});

test('a refused undo leaves no session state behind', async (t) => {
  const home = makeHome(t);
  linkAccount(home, TEST_KEY, { tenants: TENANTS });
  await run(['rule', 'add', '--outside', 'A', '--account', TEST_KEY]);
  await setWorkspaceRule(TEST_KEY, { kind: 'repo', match: REMOTE, label: REMOTE, tenantIds: ['B'] });
  assert.deepEqual(await run(['undo', '--session', 'sess-new']), ['Nothing undone: the rules changed after that change.', 'undone=0']);
  assert.equal(fs.existsSync(path.join(home, 'state', 'sess-new.workspace')), false);
});

test('undo refuses when the account is no longer linked', async (t) => {
  const home = makeHome(t);
  linkAccount(home, TEST_KEY, { tenants: TENANTS });
  await run(['rule', 'add', '--outside', 'A', '--account', TEST_KEY]);
  linkAccount(home, TEST_KEY, { tenants: TENANTS, status: 'revoked' });
  assert.deepEqual(await run(['undo']), ['Nothing to undo: that account is no longer linked.', 'undone=0']);
});

test('the deferred flows leave the undo hint off', async (t) => {
  linkAccount(makeHome(t), TEST_KEY, { tenants: TENANTS });
  const out = await run(['rule', 'add', '--repo', 'github.com/acme/api', '--account', TEST_KEY, 'B', '--defer-upload']);
  assert.equal(out[0], '✓ api → Beta (rule R1).');
  assert.equal((await run(['new-folders', 'send', 'B', '--account', TEST_KEY, '--defer-upload']))[0], '✓ New folders → Beta.');
});

test('undo of a deferred rule add removes the rule; the newest change wins', async (t) => {
  linkAccount(makeHome(t), TEST_KEY, { tenants: TENANTS });
  await run(['rule', 'add', '--outside', 'A', '--account', TEST_KEY, '--defer-upload']);
  await run(['rule', 'add', '--repo', REMOTE, 'B', '--account', TEST_KEY, '--defer-upload']);
  assert.deepEqual(await run(['undo']), [`✓ Undid your last change: api → Beta (rule R2).${KEPT}`, 'undone=1']);
  assert.deepEqual((await getAccount(TEST_KEY)).workspaceRules.map((r) => r.kind), ['outside']);
});

test('undo works with no Codex thread to re-bind', async (t) => {
  linkAccount(makeHome(t), TEST_KEY, { tenants: TENANTS });
  delete process.env.CODEX_THREAD_ID;
  delete process.env.CODEX_SESSION_ID;
  await run(['new-folders', 'send', 'A', '--account', TEST_KEY]);
  assert.deepEqual(await run(['undo']), [`✓ Undid your last change: New folders → Acme.${KEPT}`, 'undone=1']);
  assert.equal((await getAccount(TEST_KEY)).newFolders, undefined);
});

test('a removal names the rule and what applies now, on both account kinds', async (t) => {
  const home = makeHome(t);
  const rule = { kind: 'repo', match: REMOTE, label: REMOTE, tenantIds: ['A'], createdAt: '2026-01-01T00:00:00.000Z' };
  linkAccount(home, TEST_KEY, { tenants: TENANTS, workspaceRules: [rule] });
  assert.deepEqual(await run(['rule', 'remove', 'R1', '--account', TEST_KEY]),
    [`✓ Removed rule R1 (api). New sessions there follow the default (Ask me).${UNDO}`, 'removed=1']);
  assert.deepEqual(await run(['undo']), [`✓ Undid your last change: removed rule R1 (api).${KEPT}`, 'undone=1']);
  assert.deepEqual((await getAccount(TEST_KEY)).workspaceRules, [rule]);

  linkAccount(home, SOLO, { tenants: [{ id: 'S', name: 'Solo' }] });
  await run(['rule', 'add', '--outside', 'none', '--account', SOLO]);
  assert.deepEqual(await run(['rule', 'remove', '1', '--account', SOLO]),
    [`✓ Removed rule R1 (sessions outside a project). It's tracked again unless another rule covers it.${UNDO}`, 'removed=1']);
});

test('removing a rule and undoing it re-open no offer and owe no history', async (t) => {
  const settled = { state: 'settled', changedAt: null, places: [] };
  const rule = { ...REPO_B, createdAt: '2026-01-01T00:00:00.000Z' };
  linkAccount(makeHome(t), TEST_KEY, { tenants: TENANTS, workspaceRules: [rule], historyOffers: { B: settled } });
  await run(['rule', 'remove', 'R1', '--account', TEST_KEY]);
  await run(['undo']);
  const row = await getAccount(TEST_KEY);
  assert.deepEqual(row.workspaceRules, [rule]);
  assert.deepEqual(row.historyOffers, { B: settled });
  assert.equal(row.pendingHistory, undefined);
});

test('add-all confirms with the joined workspace names, and undo takes the rules back', async (t) => {
  linkAccount(makeHome(t), TEST_KEY, { tenants: TENANTS, newFolders: { mode: 'ask', tenantIds: [] } });
  const listAllRollouts = () => [entry('s1', NOTES, 2 * 24 * HOUR)];
  assert.deepEqual(await run(['rule', 'add-all', 'A', '--account', TEST_KEY], { listAllRollouts }),
    [`✓ Added 1 rule: that repo or folder → Acme.${UNDO}`, 'rules-added=1']);
  assert.deepEqual(await run(['rule', 'add-all', 'A', '--account', TEST_KEY], { listAllRollouts }),
    ['✓ No repos or folders are waiting for a rule.', 'rules-added=0']);
  assert.deepEqual(await run(['undo']), [`✓ Undid your last change: added 1 rule: that repo or folder → Acme.${KEPT}`, 'undone=1']);
  assert.deepEqual((await getAccount(TEST_KEY)).workspaceRules, []);
});

test('each New folders choice confirms in the shared wording', async (t) => {
  linkAccount(makeHome(t), TEST_KEY, { tenants: TENANTS });
  assert.deepEqual(await run(['new-folders', 'send', 'A,B', '--account', TEST_KEY]), [`✓ New folders → Acme and Beta.${UNDO}`, 'new-folders=send']);
  assert.equal((await run(['new-folders', 'none', '--account', TEST_KEY]))[0], `✓ New folders: not tracked.${UNDO}`);
  assert.equal((await run(['new-folders', 'ask', '--account', TEST_KEY]))[0], `✓ New folders: Ask me — Beezi asks once per repo or folder.${UNDO}`);
});

test('new-folders --history adds the upload counts before the last line; the plain listing is unchanged', async (t) => {
  linkAccount(makeHome(t), TEST_KEY, { tenants: TENANTS });
  seedRollout(t, NOTES);
  const plain = await run(['new-folders', '--account', TEST_KEY]);
  assert.ok(!plain.some((l) => l.startsWith('history=')), plain.join('\n'));
  assert.equal(plain[plain.length - 1], `new-folders=ask set=no multi=yes account=${TEST_KEY}`);
  assert.deepEqual(await run(['new-folders', '--history', '--account', TEST_KEY]),
    plain.slice(0, -1).concat(['history=1 places=1', plain[plain.length - 1]]));
});

test('joined pick records no undo', async (t) => {
  linkAccount(makeHome(t), TEST_KEY, { tenants: TENANTS, newFolders: { mode: 'ask', tenantIds: [] } });
  await run(['joined', 'pick', '--outside', 'A', '--account', TEST_KEY, '--defer-upload']);
  assert.deepEqual(await run(['undo']), ['Nothing to undo.', 'undone=0']);
});

test('rule remove on a multi-workspace account unbinds open sessions bound to that rule only', async (t) => {
  linkAccount(makeHome(t), TEST_KEY, { tenants: TENANTS, newFolders: { mode: 'ask', tenantIds: [] }, workspaceRules: [OUTSIDE_A, REPO_B] });
  initSessionWorkspace('sess-outside', { cwd: os.homedir(), routes: { [TEST_KEY]: OUTSIDE_A } });
  initSessionWorkspace('sess-repo', { cwd: os.homedir(), routes: { [TEST_KEY]: REPO_B } });
  await run(['rule', 'remove', '1', '--account', TEST_KEY, '--defer-upload']);
  assert.equal(readSessionWorkspace('sess-outside').route[TEST_KEY], undefined);
  assert.equal(readSessionWorkspace('sess-repo').route[TEST_KEY].match, REMOTE);
});

test('a removal re-routes every session bound to the rule, releases each one\'s held reports and checks a new workspace in once', async (t) => {
  linkAccount(makeHome(t), TEST_KEY, { tenants: TENANTS, newFolders: { mode: 'send', tenantIds: ['B'] }, workspaceRules: [OUTSIDE_A] });
  for (const sid of ['sess-one', 'sess-two']) {
    initSessionWorkspace(sid, { cwd: os.homedir(), routes: { [TEST_KEY]: OUTSIDE_A } });
    enqueueHeld(TEST_KEY, { segmentId: `${sid}-seg`, sessionId: sid, remote: null }, ['A', 'B']);
  }
  const synced = [];
  await run(['rule', 'remove', '1', '--account', TEST_KEY, '--defer-upload'], {
    getAuthentication: async () => ({ state: 'ready', accessToken: 'tok', clientId: 'c' }),
    syncAccountIfNeeded: async (key, session) => { synced.push([key, session.tenantId]); },
  });
  assert.deepEqual(synced, [[TEST_KEY, 'B']]);
  for (const sid of ['sess-one', 'sess-two']) assert.equal(readSessionWorkspace(sid).route[TEST_KEY], undefined);
  const files = fs.readdirSync(queueDir(TEST_KEY)).filter((f) => f.endsWith('.qjson'));
  assert.ok(!files.some((f) => f.endsWith('__ask.qjson')), files.join('\n'));
  const copies = files.map((f) => JSON.parse(fs.readFileSync(path.join(queueDir(TEST_KEY), f), 'utf-8')));
  assert.deepEqual(copies.map((c) => [c.payload.sessionId, c.tenantId]).sort(), [['sess-one', 'B'], ['sess-two', 'B']]);
});

test('the workspace check-in carries the row\'s anonymization, so an anonymized workspace is checked in anonymized', async (t) => {
  const block = { tenantId: 'B', kinds: { repos: true, branches: true, sessions: true, hosts: true, accounts: true }, key: 'ab'.repeat(32), machineName: null };
  linkAccount(makeHome(t), TEST_KEY, {
    tenants: [TENANTS[0], { ...TENANTS[1], anonymization: block }],
    newFolders: { mode: 'send', tenantIds: ['B'] },
    workspaceRules: [OUTSIDE_A],
  });
  initSessionWorkspace('sess-anon', { cwd: os.homedir(), routes: { [TEST_KEY]: OUTSIDE_A } });
  enqueueHeld(TEST_KEY, { segmentId: 'sess-anon-seg', sessionId: 'sess-anon', remote: null }, ['A', 'B']);
  const synced = [];
  await run(['rule', 'remove', '1', '--account', TEST_KEY, '--defer-upload'], {
    getAuthentication: async () => ({ state: 'ready', accessToken: 'tok', clientId: 'c' }),
    syncAccountIfNeeded: async (key, session) => { synced.push(session); },
  });
  assert.equal(synced.length, 1);
  assert.equal(synced[0].tenantId, 'B');
  assert.deepEqual(sessionAnonymization(synced[0]), block);
});

test('undo of a rule add on a multi-workspace account unbinds sessions bound to it', async (t) => {
  linkAccount(makeHome(t), TEST_KEY, { tenants: TENANTS, newFolders: { mode: 'ask', tenantIds: [] } });
  await run(['rule', 'add', '--outside', 'A', '--account', TEST_KEY, '--defer-upload']);
  initSessionWorkspace('sess-outside', { cwd: os.homedir(), routes: { [TEST_KEY]: OUTSIDE_A } });
  const out = await run(['undo']);
  assert.equal(out[out.length - 1], 'undone=1');
  assert.deepEqual((await getAccount(TEST_KEY)).workspaceRules, []);
  assert.equal(readSessionWorkspace('sess-outside').route[TEST_KEY], undefined);
});

test('here: names the rule, where it sends now and the path, with match= last', () => {
  const row = { key: 'k', tenants: TENANTS, newFolders: { mode: 'ask', tenantIds: [] } };
  assert.equal(hereLine(row, `${REPO}/src`, ctx()),
    `here: api (${REMOTE}) → no rule now=pending path=${REPO} account=k rule=none kind=repo match=${REMOTE}`);
  const ruled = { ...row, workspaceRules: [{ kind: 'repo', match: REMOTE, label: REMOTE, tenantIds: ['A', 'B'] }] };
  assert.equal(hereLine(ruled, REPO, ctx()), `here: api (${REMOTE}) → R1 now=A,B path=${REPO} account=k rule=1 kind=repo match=${REMOTE}`);
  const none = { ...row, newFolders: { mode: 'none', tenantIds: [] } };
  assert.equal(hereLine(none, NOTES, ctx()), `here: notes (${NOTES}) → no rule now=none path=${NOTES} account=k rule=none kind=folder match=${NOTES}`);
  const send = { ...row, newFolders: { mode: 'send', tenantIds: ['B'] } };
  assert.equal(hereLine(send, os.homedir(), ctx()), 'here: outside a project → no rule now=B account=k rule=none kind=outside match=outside');
  assert.equal(hereLine({ key: 's', tenants: [{ id: 'S', name: 'Solo' }] }, REPO, ctx()),
    `here: api (${REMOTE}) → no rule now=S path=${REPO} account=s rule=none kind=repo match=${REMOTE}`);
  assert.equal(hereLine(row, null, ctx()), 'here: none account=k');
});

test('the rules listing ends with the new here: line', async (t) => {
  linkAccount(makeHome(t), TEST_KEY, { tenants: TENANTS });
  const out = await workspaceCommand(['rules', '--account', TEST_KEY], { ...deps, cwd: os.homedir() });
  assert.equal(out.lines[out.lines.length - 1], `here: outside a project → no rule now=pending account=${TEST_KEY} rule=none kind=outside match=outside`);
});

test('pickerPlaces keeps the top 3 recent places with no rule of their own, other than this directory\'s', () => {
  const now = Date.now();
  const entries = [];
  const sessions = (dir, n) => { for (let i = 0; i < n; i += 1) entries.push(entry(`s${entries.length}`, dir)); };
  sessions(`${REPO}/src`, 12);
  sessions('/work/ruled', 11);
  for (let i = 0; i < 5; i += 1) sessions(`/work/p${i}`, 10 - i);
  const row = { key: 'k', email: 'm@x.io', tenants: TENANTS, workspaceRules: [{ kind: 'folder', match: '/work/ruled', label: '/work/ruled', tenantIds: ['A'] }] };
  const found = pickerPlaces(row, entries, `${REPO}/src`, ctx(), { now, readState: () => null });
  assert.deepEqual(found.map((p) => [p.match, p.sessions]), [['/work/p0', 10], ['/work/p1', 9], ['/work/p2', 8]]);
  const lines = pickerLines(row, found.slice(0, 2));
  assert.equal(lines[0], 'm@x.io: 2 repos or folders with recent sessions account=k');
  assert.equal(lines[1], 'F1. p0 (/work/p0), 10 sessions account=k kind=folder match=/work/p0');
  assert.match(lines[2], /^F1-command=node ".+\/scripts\/workspace\.mjs" rule add --folder '\/work\/p0' --account k <tenants>$/);
  assert.equal(lines[3], 'F2. p1 (/work/p1), 9 sessions account=k kind=folder match=/work/p1');
  assert.match(pickerLines(row, found.slice(0, 1), { deferUpload: true })[2], / --account k --defer-upload <tenants>$/);
  assert.deepEqual(pickerLines(row, []), []);
});

test('places lists recent places other than this directory\'s', async (t) => {
  linkAccount(makeHome(t), TEST_KEY, { tenants: TENANTS });
  const listAllRollouts = () => [entry('s1', HERE), entry('s2', NOTES), entry('s3', NOTES)];
  const out = await run(['places', '--account', TEST_KEY], { listAllRollouts });
  assert.deepEqual(out.filter((l) => !l.startsWith('F1-command=')), [
    `${TEST_KEY}@example.com: 1 repo or folder with recent sessions account=${TEST_KEY}`,
    `F1. notes (${NOTES}), 2 sessions account=${TEST_KEY} kind=folder match=${NOTES}`,
    'places=1',
  ]);
  assert.deepEqual(await run(['places', '--account', TEST_KEY], { listAllRollouts: () => [entry('s1', HERE)] }), ['places=0']);
});
