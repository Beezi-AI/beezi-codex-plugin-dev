import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHome, linkAccount, TEST_KEY } from '../tools/account-fixtures.mjs';
import { consentedCommand } from '../lib/history-cli.mjs';
import { workspaceCommand } from '../lib/workspace-cli.mjs';
import { getAccount, updateAccount } from '../lib/accounts.mjs';
import { planWorkspaceRuns } from '../lib/session-audit.mjs';
import { KINDS } from '../lib/anonymize.mjs';

// sync.mjs --offer --past --consented in-process: the real route planner over a faked rollout list, a list run that
// keeps only what the real one would under the run's routes, whoami and the worker spawn faked at their seams.

const T0 = Date.parse('2026-11-11T10:00:00.000Z');
const C = '2026-10-01T00:00:00.000Z';
const OFFER = { choice: 'offer', changedAt: C };
const UPLOAD = { choice: 'upload', changedAt: C };
const SKIP = { choice: 'skip', changedAt: C };
const NOTHING = 'uploading=0 workspaces=0 tenants=';
// Never created and outside home and temp, so each keys as a folder place.
const APP = '/beezi-consented/app';
const WEB = '/beezi-consented/web';
const API = '/beezi-consented/api';
const BLOG = '/beezi-consented/blog';
const OCT_1 = new Date(2026, 9, 1, 12).getTime();

const block = (tenantId, on, pastSessions) => ({
  tenantId,
  kinds: KINDS.reduce((out, kind) => ({ ...out, [kind]: on.indexOf(kind) !== -1 }), {}),
  key: 'a'.repeat(64),
  machineName: null,
  pastSessions,
});
const tenant = (id, name, on = ['repos'], past = OFFER) => ({ id, name, anonymization: block(id, on, past) });
const session = (sessionId, cwd = APP) => ({ sessionId, startedMs: OCT_1, mtimeMs: OCT_1, cwd });
const BOTH = { tenants: [tenant('t1', 'Acme'), tenant('t2', 'Side')], newFolders: { mode: 'send', tenantIds: ['t1', 't2'] } };
// The answered listing record the setup leaves on the account row, seeded for the tests about the upload's own gates.
const answered = (ids, kinds = { t1: ['repos'] }) => ({
  setupListing: { listedAt: '2026-11-11T09:00:00.000Z', sessionIds: ids, kinds, answeredAt: '2026-11-11T09:01:00.000Z' },
});

function link(t, over = {}) {
  linkAccount(makeHome(t), TEST_KEY, { tenantId: 't1', tenants: [tenant('t1', 'Acme')], linkedAt: '2026-09-01T00:00:00.000Z', ...over });
}

// Whether the real list run would keep session `id` under `options`: not a Don't-track session, and routed here.
function routedHere(options, id) {
  if (options.excludedSessionIds != null && options.excludedSessionIds.has(id)) return false;
  if (options.sessionRoutes == null) return true;
  const route = options.sessionRoutes.get(id);
  return route != null && route.tenantIds.indexOf(options.tenantId) !== -1;
}

// `disk` is every past session on the machine; `over(options)` overrides fields of a run's result. `sleep` records each
// wait in `sleeps` and moves `now` on by it.
function engine({ disk = [session('A'), session('D')], over = () => ({}), whoamiImpl = null, spawned = true } = {}) {
  const audits = [];
  const spawns = [];
  const sleeps = [];
  let clock = T0;
  return {
    audits,
    spawns,
    sleeps,
    deps: {
      now: () => clock,
      sleep: async (ms) => { sleeps.push(ms); clock += ms; },
      readTrackingState: () => null,
      planWorkspaceRuns: (row) => planWorkspaceRuns(row, { listRollouts: () => disk.map((s) => ({ sessionId: s.sessionId, cwd: s.cwd, mtimeMs: s.mtimeMs })) }),
      whoamiImpl: whoamiImpl != null ? whoamiImpl : async () => ({ valid: true, tenants: (await getAccount(TEST_KEY)).tenants }),
      runAudit: async (d, options) => {
        audits.push(options);
        if (d.whoamiImpl != null) await d.whoamiImpl({}, {});
        const listed = disk.filter((s) => routedHere(options, s.sessionId));
        return { ok: true, reason: null, halt: null, scanned: disk.length, tooOld: 0, coverageKnown: true, trackingMode: 'live', listed, ...over(options) };
      },
      spawnImpl: (cmd, args) => {
        spawns.push(args.slice(1));
        if (!spawned) throw new Error('spawn failed');
        return { unref() {} };
      },
      getAuthentication: async () => null,
      listAllRollouts: () => [],
    },
  };
}

function capture(t) {
  const out = [];
  const err = [];
  t.mock.method(console, 'log', (...args) => { out.push(args.join(' ')); });
  t.mock.method(console, 'error', (...args) => { err.push(args.join(' ')); });
  return { out, err };
}

const consented = (deps) => consentedCommand({ key: TEST_KEY }, deps);
const owed = async () => ((await getAccount(TEST_KEY)).pendingHistory || []).map((e) => [e.tenantId, e.sessionIds, e.kinds]);
const WORKER = [['--account', TEST_KEY]];

test('an ask-first workspace is owed its counted sessions and the worker starts once, asking and declining nothing', async (t) => {
  link(t, answered(['A', 'D']));
  const io = capture(t);
  const { spawns, deps } = engine();
  assert.equal(await consented(deps), 0);
  assert.deepEqual(io, { out: ['uploading=2 workspaces=1 tenants=t1'], err: [] });
  assert.deepEqual(spawns, WORKER);
  assert.deepEqual(await owed(), [['t1', ['A', 'D'], ['repos']]]);
  const record = (await getAccount(TEST_KEY)).historyOffers.t1;
  assert.deepEqual([record.state, record.declinedIds], ['settled', []]);
});

test('a no-ask workspace is owed the same with no notice, under the kinds it hid when counted and hides now', async (t) => {
  link(t, { tenants: [tenant('t1', 'Acme', ['repos'], UPLOAD)], ...answered(['A', 'D']) });
  const io = capture(t);
  const whoamiImpl = async () => ({ valid: true, tenants: [tenant('t1', 'Acme', ['branches'], UPLOAD)] });
  const { spawns, deps } = engine({ whoamiImpl });
  assert.equal(await consented(deps), 0);
  assert.deepEqual(io, { out: ['uploading=2 workspaces=1 tenants=t1'], err: [] });
  assert.deepEqual(spawns, WORKER);
  assert.deepEqual(await owed(), [['t1', ['A', 'D'], ['repos', 'branches']]]);
});

test('an audit workspace is included', async (t) => {
  link(t, answered(['A', 'D']));
  const io = capture(t);
  const { spawns, deps } = engine({ over: () => ({ trackingMode: 'backfill_only' }) });
  assert.equal(await consented(deps), 0);
  assert.deepEqual(io.out, ['uploading=2 workspaces=1 tenants=t1']);
  assert.deepEqual(spawns, WORKER);
  assert.deepEqual(await owed(), [['t1', ['A', 'D'], ['repos']]]);
});

const skipped = [
  { name: 'the owner chose never', over: { tenants: [tenant('t1', 'Acme', ['repos'], SKIP)] }, seams: {} },
  { name: 'tracking is off', over: {}, seams: { readTrackingState: () => ({ trackingMode: 'disabled' }) } },
  { name: 'the workspace settled under the current choice', over: { historyOffers: { t1: { state: 'settled', changedAt: C } } }, seams: {} },
  { name: 'the workspace declined under the current choice', over: { historyOffers: { t1: { state: 'declined', changedAt: C, declinedIds: ['x'] } } }, seams: {} },
];
for (const c of skipped) {
  test(`a workspace is skipped, asked nothing and owed nothing when ${c.name}`, async (t) => {
    link(t, { ...c.over, ...answered(['A', 'D']) });
    const io = capture(t);
    const { audits, spawns, deps } = engine();
    assert.equal(await consented({ ...deps, ...c.seams }), 0);
    assert.deepEqual(io, { out: [NOTHING], err: [] });
    assert.equal(audits.length, 0);
    assert.deepEqual(spawns, []);
    assert.deepEqual(await owed(), []);
  });
}

test('a workspace with analytics off is skipped quietly and owed nothing', async (t) => {
  link(t, answered(['A', 'D']));
  const io = capture(t);
  const { spawns, deps } = engine({ over: () => ({ trackingMode: 'disabled' }) });
  assert.equal(await consented(deps), 0);
  assert.deepEqual(io, { out: [NOTHING], err: [] });
  assert.deepEqual(spawns, []);
  assert.deepEqual(await owed(), []);
});

test('two workspaces owed the same sessions print the distinct count and start the worker once', async (t) => {
  link(t, { ...BOTH, ...answered(['A', 'D'], { t1: ['repos'], t2: ['repos'] }) });
  const io = capture(t);
  const { spawns, deps } = engine();
  assert.equal(await consented(deps), 0);
  assert.deepEqual(io, { out: ['uploading=2 workspaces=2 tenants=t1,t2'], err: [] });
  assert.deepEqual(spawns, WORKER);
  assert.deepEqual((await owed()).map(([id, ids]) => [id, ids]), [['t1', ['A', 'D']], ['t2', ['A', 'D']]]);
});

test('nothing to upload prints uploading=0 workspaces=0 tenants= and starts no worker', async (t) => {
  link(t, answered([]));
  const io = capture(t);
  const { spawns, deps } = engine({ disk: [] });
  assert.equal(await consented(deps), 0);
  assert.deepEqual(io, { out: [NOTHING], err: [] });
  assert.deepEqual(spawns, []);
});

const failures = [
  {
    name: 'another history run is using the machine',
    result: { reason: 'run-in-progress' },
    io: { out: ['✓ Beezi: another Beezi history run is using this machine right now — letting it finish.', NOTHING], err: [] },
    sleeps: 30,
  },
  {
    name: 'the account cannot sign in',
    result: { reason: 'no-token' },
    io: { out: [NOTHING], err: ['✗ Beezi: could not use the saved credentials for that account. Sign in to Beezi again as it (the login skill).'] },
    sleeps: 0,
  },
];
for (const c of failures) {
  test(`when ${c.name}: today's line, nothing owed, no worker, exit 1`, async (t) => {
    link(t, answered(['A', 'D']));
    const io = capture(t);
    const { spawns, sleeps, deps } = engine({ over: () => c.result });
    assert.equal(await consented(deps), 1);
    assert.deepEqual(io, c.io);
    assert.deepEqual(spawns, []);
    assert.deepEqual(await owed(), []);
    assert.equal(sleeps.length, c.sleeps);
  });
}

test('a busy count is retried and the counted sessions are owed once it is free', async (t) => {
  link(t, answered(['A', 'D']));
  capture(t);
  let runs = 0;
  const { spawns, sleeps, deps } = engine({ over: () => { runs += 1; return runs === 1 ? { reason: 'run-in-progress' } : {}; } });
  assert.equal(await consented(deps), 0);
  assert.deepEqual(spawns, WORKER);
  assert.deepEqual(sleeps, [2000]);
  assert.deepEqual(await owed(), [['t1', ['A', 'D'], ['repos']]]);
});

test('one workspace failing its count owes nothing to the other either', async (t) => {
  link(t, { ...BOTH, ...answered(['A', 'D'], { t1: ['repos'], t2: ['repos'] }) });
  const io = capture(t);
  const { spawns, deps } = engine({ over: (options) => (options.tenantId === 't2' ? { reason: 'no-token' } : {}) });
  assert.equal(await consented(deps), 1);
  assert.equal(io.out[io.out.length - 1], NOTHING);
  assert.deepEqual(spawns, []);
  assert.deepEqual(await owed(), []);
});

test('a worker that cannot start reports nothing uploading and exits 1, leaving the sessions owed for the retry', async (t) => {
  link(t, answered(['A', 'D']));
  const io = capture(t);
  const { spawns, deps } = engine({ spawned: false });
  assert.equal(await consented(deps), 1);
  assert.deepEqual(io, { out: [NOTHING], err: [] });
  assert.deepEqual(spawns, WORKER);
  assert.deepEqual(await owed(), [['t1', ['A', 'D'], ['repos']]]);
});

// The listing's T lines up to their machine fields, and its last line.
async function listedPlaces(deps) {
  const { lines } = await workspaceCommand(['setup', '--account', TEST_KEY], deps);
  return { places: lines.filter((l) => /^T\d+\. /.test(l)).map((l) => l.slice(0, l.indexOf(' account='))), last: lines[lines.length - 1] };
}

async function write(argv, deps) {
  const out = await workspaceCommand(argv.concat(['--account', TEST_KEY, '--defer-upload']), deps);
  assert.equal(out.ok, true, out.stderr.join('\n'));
}

// W1, W2 in web, P1 in api; N1 has no folder and X1 an unsafe one, so neither is listed nor sent.
const ONE_DISK = [session('W1', WEB), session('W2', WEB), session('P1', API), session('N1', null), session('X1', '/beezi-consented/bad\nname')];

test('one workspace, Everything: the consented run owes exactly the sessions the listing counted', async (t) => {
  link(t);
  const io = capture(t);
  const { deps } = engine({ disk: ONE_DISK });
  assert.deepEqual(await listedPlaces(deps), {
    places: ['T1. web (/beezi-consented/web), 2 sessions', 'T2. api (/beezi-consented/api), 1 session'],
    last: 'setup=2 sessions=3 workspaces=1 chosen=no',
  });
  await write(['setup', 'everything', 't1'], deps);
  assert.equal(await consented(deps), 0);
  assert.equal(io.out[io.out.length - 1], 'uploading=3 workspaces=1 tenants=t1');
  assert.deepEqual((await owed()).map(([id, ids]) => [id, ids]), [['t1', ['W1', 'W2', 'P1']]]);
});

test('one workspace, Let me choose: the consented run owes exactly the listed places left ticked', async (t) => {
  link(t);
  const io = capture(t);
  const { deps } = engine({ disk: ONE_DISK });
  await listedPlaces(deps);
  await write(['rule', 'add', '--folder', API, 'none'], deps);
  await write(['setup', 'chosen'], deps);
  assert.equal(await consented(deps), 0);
  assert.equal(io.out[io.out.length - 1], 'uploading=2 workspaces=1 tenants=t1');
  assert.deepEqual((await owed()).map(([id, ids]) => [id, ids]), [['t1', ['W1', 'W2']]]);
});

test("several workspaces, Everything to both: the consented run owes the listed places, not a Don't-track one", async (t) => {
  link(t, { tenants: BOTH.tenants, workspaceRules: [{ kind: 'folder', match: BLOG, label: BLOG, tenantIds: [] }] });
  const io = capture(t);
  const { deps } = engine({ disk: [session('W1', WEB), session('P1', API), session('B1', BLOG), session('N1', null)] });
  assert.deepEqual(await listedPlaces(deps), {
    places: [
      'T1. api (/beezi-consented/api), 1 session',
      'T2. blog (/beezi-consented/blog), 1 session',
      'T3. web (/beezi-consented/web), 1 session',
    ],
    last: 'setup=3 sessions=3 workspaces=2 chosen=no',
  });
  await write(['setup', 'everything', 't1,t2'], deps);
  assert.equal(await consented(deps), 0);
  assert.equal(io.out[io.out.length - 1], 'uploading=2 workspaces=2 tenants=t1,t2');
  assert.deepEqual((await owed()).map(([id, ids]) => [id, ids]), [['t1', ['W1', 'P1']], ['t2', ['W1', 'P1']]]);
});

test('several workspaces, Let me choose: each workspace is owed only the places ticked for it', async (t) => {
  link(t, { tenants: BOTH.tenants });
  const io = capture(t);
  const { deps } = engine({ disk: [session('W1', WEB), session('P1', API), session('N1', null)] });
  await listedPlaces(deps);
  await write(['rule', 'add', '--folder', WEB, 't1,t2'], deps);
  await write(['rule', 'add', '--folder', API, 't2'], deps);
  await write(['setup', 'chosen'], deps);
  assert.equal(await consented(deps), 0);
  assert.equal(io.out[io.out.length - 1], 'uploading=2 workspaces=2 tenants=t1,t2');
  assert.deepEqual((await owed()).map(([id, ids]) => [id, ids]), [['t1', ['W1']], ['t2', ['W1', 'P1']]]);
});

const noRecord = [
  { name: 'no listing record', arrange: async () => {} },
  { name: 'a listing whose question was never answered', arrange: async (deps) => { await listedPlaces(deps); } },
];
for (const c of noRecord) {
  test(`with ${c.name} the consented run counts nothing, owes nothing and starts no worker`, async (t) => {
    link(t);
    const io = capture(t);
    const { audits, spawns, deps } = engine();
    await c.arrange(deps);
    const listed = audits.length;
    assert.equal(await consented(deps), 0);
    assert.deepEqual(io, { out: [NOTHING], err: [] });
    assert.equal(audits.length, listed);
    assert.deepEqual(spawns, []);
    assert.deepEqual(await owed(), []);
  });
}

test('a session that became eligible after the listing is not owed', async (t) => {
  link(t);
  const io = capture(t);
  const disk = [session('W1', WEB)];
  const { deps } = engine({ disk });
  await listedPlaces(deps);
  disk.push(session('W2', WEB));
  await write(['setup', 'everything'], deps);
  assert.equal(await consented(deps), 0);
  assert.equal(io.out[io.out.length - 1], 'uploading=1 workspaces=1 tenants=t1');
  assert.deepEqual((await owed()).map(([id, ids]) => [id, ids]), [['t1', ['W1']]]);
});

test('a kind the listing showed as hidden stays hidden though the workspace stopped hiding it', async (t) => {
  link(t);
  capture(t);
  const { deps } = engine({ disk: [session('W1', WEB)] });
  await listedPlaces(deps);
  await updateAccount(TEST_KEY, { tenants: [tenant('t1', 'Acme', [])] });
  await write(['setup', 'everything'], deps);
  assert.equal(await consented(deps), 0);
  assert.deepEqual(await owed(), [['t1', ['W1'], ['repos']]]);
});

test('a second consented run after a successful one owes nothing more', async (t) => {
  link(t);
  const io = capture(t);
  const { spawns, deps } = engine({ disk: [session('W1', WEB), session('W2', WEB)] });
  await listedPlaces(deps);
  await write(['setup', 'everything'], deps);
  assert.equal(await consented(deps), 0);
  assert.equal(await consented(deps), 0);
  assert.deepEqual(io.out.slice(-2), ['uploading=2 workspaces=1 tenants=t1', NOTHING]);
  assert.deepEqual(spawns, WORKER);
  assert.equal((await getAccount(TEST_KEY)).setupListing, undefined);
});
