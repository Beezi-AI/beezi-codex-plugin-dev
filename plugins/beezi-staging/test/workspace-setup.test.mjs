import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeHome, linkAccount, TEST_KEY } from '../tools/account-fixtures.mjs';
import { workspaceCommand } from '../lib/workspace-cli.mjs';
import { getAccount, markTrackingChosen } from '../lib/accounts.mjs';
import { saveRepoMap } from '../lib/repo-map.mjs';
import { KINDS } from '../lib/anonymize.mjs';

// workspace.mjs setup in-process: the listing with the dry-run engine faked at runAudit and whoami, the writes for real.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/');
const RUN = `node "${ROOT}/scripts/workspace.mjs"`;
const C = '2026-10-01T00:00:00.000Z';
const OFFER = { choice: 'offer', changedAt: C };
const SKIP = { choice: 'skip', changedAt: C };
// Never created and outside home and temp, so each keys as a folder place.
const WEB = '/beezi-setup-x/web';
const API = '/beezi-setup-x/api';
const SEP_3 = new Date(2026, 8, 3, 12).getTime();
const OCT_1 = new Date(2026, 9, 1, 12).getTime();
const NOV_11 = new Date(2026, 10, 11, 12).getTime();
const NOT_LINKED = '\n✗ Beezi: this machine is not linked. Use the login skill to link an account.';

const block = (tenantId, on, pastSessions) => ({
  tenantId,
  kinds: KINDS.reduce((out, kind) => ({ ...out, [kind]: on.indexOf(kind) !== -1 }), {}),
  key: 'a'.repeat(64),
  machineName: null,
  pastSessions,
});
const tenant = (id, name, on = [], past = OFFER) => ({ id, name, anonymization: block(id, on, past) });
const ACME = tenant('t1', 'Acme', ['sessions']);
const SIDE = tenant('t2', 'Side Project');
const session = (sessionId, cwd, startedMs = OCT_1) => ({ sessionId, startedMs, mtimeMs: startedMs, cwd });

function link(t, over = {}) {
  linkAccount(makeHome(t), TEST_KEY, { tenantId: 't1', tenants: [ACME], linkedAt: '2026-09-01T00:00:00.000Z', ...over });
}

// The engine boundary: `listedBy[tenantId]` ('null' for a one-workspace run) is what each list run returns; `over`
// overrides fields of every run's result. `sleep` records each wait in `sleeps` and moves `now` on by it.
function engine(listedBy, over = {}, seams = {}) {
  const audits = [];
  const sleeps = [];
  let clock = NOV_11;
  return {
    audits,
    sleeps,
    deps: {
      now: () => clock,
      sleep: async (ms) => { sleeps.push(ms); clock += ms; },
      readTrackingState: () => null,
      whoamiImpl: async () => ({ valid: true, tenants: (await getAccount(TEST_KEY)).tenants }),
      runAudit: async (d, options) => {
        audits.push(options);
        if (d.whoamiImpl != null) await d.whoamiImpl({}, {});
        const listed = listedBy[options.tenantId == null ? 'null' : options.tenantId] || [];
        return { ok: true, reason: null, halt: null, scanned: 5, tooOld: 0, coverageKnown: true, trackingMode: 'live', listed, ...over };
      },
      getAuthentication: async () => null,
      listAllRollouts: () => [],
      ...seams,
    },
  };
}

const listing = (deps) => workspaceCommand(['setup', '--account', TEST_KEY], deps);
const WRITES = engine({}).deps;
const last = (lines) => lines[lines.length - 1];
const tLines = (lines) => lines.filter((l) => /^T\d+\. /.test(l));

test('one workspace lists its places by sessions with outside last, under the full checklist', async (t) => {
  link(t);
  const home = os.homedir();
  const { sleeps, deps } = engine({
    null: [
      session('w1', WEB, SEP_3), session('w2', WEB), session('w3', WEB), session('a1', API), session('a2', API, NOV_11),
      session('o1', home), session('o2', home), session('o3', home), session('o4', home), session('n1', null),
    ],
  });
  assert.deepEqual(await listing(deps), {
    ok: true,
    stderr: [],
    lines: [
      '<checklist>',
      'Beezi found 9 past Codex sessions (3 Sep – 11 Nov, 3 folders)',
      '  in web, api, outside a project',
      '  Sent',
      '    ✓ dates, duration, models, tokens, cost',
      '    ✓ tool, skill and MCP names',
      '    ✓ folder and repository names, branch names, computer name and account email, as they are',
      '  Never sent',
      '    ✕ session titles, error messages and subagent names',
      '</checklist>',
      'W. Acme account=a1b2c3d4 tenant=t1 role=',
      'T1. web (/beezi-setup-x/web), 3 sessions account=a1b2c3d4 kind=folder now=default match=/beezi-setup-x/web',
      `T1-command=${RUN} rule add --folder '/beezi-setup-x/web' --account a1b2c3d4 --defer-upload <tenants>`,
      'T2. api (/beezi-setup-x/api), 2 sessions account=a1b2c3d4 kind=folder now=default match=/beezi-setup-x/api',
      `T2-command=${RUN} rule add --folder '/beezi-setup-x/api' --account a1b2c3d4 --defer-upload <tenants>`,
      'T3. outside a project, 4 sessions account=a1b2c3d4 kind=outside now=default match=outside',
      `T3-command=${RUN} rule add --outside --account a1b2c3d4 --defer-upload <tenants>`,
      `everything-command=${RUN} setup everything --account a1b2c3d4 --defer-upload <tenants>`,
      `chosen-command=${RUN} setup chosen --account a1b2c3d4 --defer-upload`,
      '1 other past session has no recorded folder and is not sent.',
      'setup=3 sessions=9 workspaces=1 chosen=no',
    ],
  });
  assert.deepEqual(sleeps, []);
});

test('two workspaces list unrouted, under the combined checklist, with one W line each and a shared session once', async (t) => {
  link(t, { tenants: [tenant('t1', 'Acme', ['repos', 'branches']), SIDE] });
  const { audits, deps } = engine({ t1: [session('w1', WEB, SEP_3), session('w2', WEB)], t2: [session('w2', WEB), session('a1', API, NOV_11)] });
  const out = await listing(deps);
  assert.deepEqual(out.lines, [
    '<checklist>',
    'Beezi found 3 past Codex sessions (3 Sep – 11 Nov)',
    '  Always sent: dates, duration, models, tokens, cost, tool, skill and MCP names',
    '  Acme · made-up names for repos and branches',
    '  Side Project · names and titles as they are',
    '</checklist>',
    'W. Acme account=a1b2c3d4 tenant=t1 role=',
    'W. Side Project account=a1b2c3d4 tenant=t2 role=',
    'T1. web (/beezi-setup-x/web), 2 sessions account=a1b2c3d4 kind=folder now=default match=/beezi-setup-x/web',
    `T1-command=${RUN} rule add --folder '/beezi-setup-x/web' --account a1b2c3d4 --defer-upload <tenants>`,
    'T2. api (/beezi-setup-x/api), 1 session account=a1b2c3d4 kind=folder now=default match=/beezi-setup-x/api',
    `T2-command=${RUN} rule add --folder '/beezi-setup-x/api' --account a1b2c3d4 --defer-upload <tenants>`,
    `everything-command=${RUN} setup everything --account a1b2c3d4 --defer-upload <tenants>`,
    `chosen-command=${RUN} setup chosen --account a1b2c3d4 --defer-upload`,
    'setup=2 sessions=3 workspaces=2 chosen=no',
  ]);
  assert.deepEqual(audits.map((a) => [a.tenantId, a.sessionRoutes, a.listOnly, a.scope]), [['t1', undefined, true, 'past'], ['t2', undefined, true, 'past']]);
});

const chosenCases = [
  { name: 'the marker is set', arrange: async (t) => { link(t); await markTrackingChosen(TEST_KEY, '2026-11-11T00:00:00.000Z'); }, last: 'setup=0 sessions=0 workspaces=1 chosen=yes' },
  { name: 'several workspaces already set New folders', arrange: async (t) => link(t, { tenants: [ACME, SIDE], newFolders: { mode: 'ask', tenantIds: [] } }), last: 'setup=0 sessions=0 workspaces=2 chosen=yes' },
];
for (const c of chosenCases) {
  test(`the listing says chosen=yes and counts nothing when ${c.name}`, async (t) => {
    await c.arrange(t);
    const { audits, deps } = engine({ null: [session('w1', WEB)], t1: [session('w1', WEB)] });
    const out = await listing(deps);
    assert.equal(last(out.lines), c.last);
    assert.deepEqual(tLines(out.lines), []);
    assert.equal(audits.length, 0);
  });
}

test('an account whose workspace list is unknown prints only workspaces=0 and counts nothing', async (t) => {
  link(t, { tenants: null });
  const { audits, deps } = engine({ null: [session('w1', WEB)] });
  assert.deepEqual(await listing(deps), { ok: true, lines: ['setup=0 sessions=0 workspaces=0 chosen=no'], stderr: [] });
  assert.equal(audits.length, 0);
});

test('no place to list prints no checklist', async (t) => {
  link(t);
  const { deps } = engine({});
  assert.deepEqual((await listing(deps)).lines, [
    'W. Acme account=a1b2c3d4 tenant=t1 role=',
    `everything-command=${RUN} setup everything --account a1b2c3d4 --defer-upload <tenants>`,
    `chosen-command=${RUN} setup chosen --account a1b2c3d4 --defer-upload`,
    'setup=0 sessions=0 workspaces=1 chosen=no',
  ]);
});

const nowCases = [
  { name: "a Don't-track rule", tenants: [ACME], tenantIds: [], now: 'now=none' },
  { name: 'a rule to one of two workspaces', tenants: [ACME, SIDE], tenantIds: ['t2'], now: 'now=t2' },
];
for (const c of nowCases) {
  test(`a place under ${c.name} is still listed, with its routing in ${c.now}`, async (t) => {
    link(t, { tenants: c.tenants, workspaceRules: [{ kind: 'folder', match: WEB, label: WEB, tenantIds: c.tenantIds }] });
    const { deps } = engine({ null: [session('w1', WEB)], t1: [session('w1', WEB)] });
    const out = await listing(deps);
    assert.deepEqual(tLines(out.lines), [`T1. web (/beezi-setup-x/web), 1 session account=a1b2c3d4 kind=folder ${c.now} match=/beezi-setup-x/web`]);
    assert.equal(last(out.lines), `setup=1 sessions=1 workspaces=${c.tenants.length} chosen=no`);
  });
}

const failedCounts = [
  {
    name: 'another history run is using the machine',
    over: { reason: 'run-in-progress' },
    out: { lines: ['✓ Beezi: another Beezi history run is using this machine right now — letting it finish.'], stderr: [] },
  },
  {
    name: 'the account cannot sign in',
    over: { reason: 'no-token' },
    out: { lines: [], stderr: ['✗ Beezi: could not use the saved credentials for that account. Sign in to Beezi again as it (the login skill).'] },
  },
  {
    name: 'the server cannot say what it already holds',
    over: { coverageKnown: false },
    out: {
      lines: ['✓ Beezi: could not reach Beezi to check what it already has, so nothing was uploaded — and nothing was lost or duplicated. Try again in a moment.'],
      stderr: [],
    },
  },
];
for (const c of failedCounts) {
  test(`when ${c.name} the listing prints only that line and fails`, async (t) => {
    link(t);
    const { deps } = engine({ null: [session('w1', WEB)] }, c.over);
    assert.deepEqual(await listing(deps), { ok: false, ...c.out });
  });
}

// The engine's deps with `tenantId`'s first run answering busy with `reason`; every run is in audits.
function busyOnce({ audits, deps }, reason, tenantId = null) {
  let busy = true;
  return {
    ...deps,
    runAudit: async (d, options) => {
      if (!busy || options.tenantId !== tenantId) return deps.runAudit(d, options);
      busy = false;
      audits.push(options);
      return { ok: false, reason, halt: null };
    },
  };
}

const BUSY_FAILED = { ok: false, lines: ['✓ Beezi: another Beezi history run is using this machine right now — letting it finish.'], stderr: [] };

test('a busy history run is retried every 2 s and the listing goes on once it is free', async (t) => {
  link(t);
  const world = engine({ null: [session('w1', WEB)] });
  const out = await listing(busyOnce(world, 'run-in-progress'));
  assert.equal(out.ok, true);
  assert.equal(last(out.lines), 'setup=1 sessions=1 workspaces=1 chosen=no');
  assert.deepEqual(world.sleeps, [2000]);
});

for (const reason of ['run-in-progress', 'upload-busy', 'active-writer', 'pending-transaction']) {
  test(`a listing busy with ${reason} once is retried`, async (t) => {
    link(t);
    const world = engine({ null: [session('w1', WEB)] });
    const out = await listing(busyOnce(world, reason));
    assert.deepEqual(tLines(out.lines), ['T1. web (/beezi-setup-x/web), 1 session account=a1b2c3d4 kind=folder now=default match=/beezi-setup-x/web']);
    assert.deepEqual(world.sleeps, [2000]);
  });
}

test('a history run still busy after 60 s prints today\'s line and fails', async (t) => {
  link(t);
  const { sleeps, deps } = engine({ null: [session('w1', WEB)] }, { reason: 'run-in-progress' });
  assert.deepEqual(await listing(deps), BUSY_FAILED);
  assert.equal(sleeps.length, 30);
});

test('a clock that never moves still stops after 30 sleeps', async (t) => {
  link(t);
  const { sleeps, deps } = engine({ null: [session('w1', WEB)] }, { reason: 'run-in-progress' }, { now: () => NOV_11 });
  assert.deepEqual(await listing(deps), BUSY_FAILED);
  assert.equal(sleeps.length, 30);
});

test('of two workspaces only the busy one runs again', async (t) => {
  link(t, { tenants: [ACME, SIDE] });
  const world = engine({ t1: [session('w1', WEB)], t2: [session('a1', API)] });
  const out = await listing(busyOnce(world, 'run-in-progress', 't2'));
  assert.deepEqual(world.audits.map((a) => a.tenantId), ['t1', 't2', 't2']);
  assert.deepEqual(tLines(out.lines).map((l) => l.slice(0, l.indexOf(' account='))), [
    'T1. api (/beezi-setup-x/api), 1 session',
    'T2. web (/beezi-setup-x/web), 1 session',
  ]);
  assert.equal(last(out.lines), 'setup=2 sessions=2 workspaces=2 chosen=no');
});

test('a workspace with analytics off lists nothing, quietly', async (t) => {
  link(t);
  const { deps } = engine({ null: [session('w1', WEB)] }, { trackingMode: 'disabled' });
  const out = await listing(deps);
  assert.equal(out.ok, true);
  assert.equal(last(out.lines), 'setup=0 sessions=0 workspaces=1 chosen=no');
});

const skippedCases = [
  { name: 'the owner chose never', over: { tenants: [tenant('t1', 'Acme', [], SKIP)] }, seams: {} },
  { name: 'tracking is off', over: {}, seams: { readTrackingState: () => ({ trackingMode: 'disabled' }) } },
  { name: 'the workspace settled under the current choice', over: { historyOffers: { t1: { state: 'settled', changedAt: C } } }, seams: {} },
  { name: 'the workspace declined under the current choice', over: { historyOffers: { t1: { state: 'declined', changedAt: C, declinedIds: ['x'] } } }, seams: {} },
];
for (const c of skippedCases) {
  test(`a workspace the upload skips because ${c.name} lists no place and no checklist`, async (t) => {
    link(t, c.over);
    const { audits, deps } = engine({ null: [session('w1', WEB)] }, {}, c.seams);
    assert.deepEqual((await listing(deps)).lines, [
      'W. Acme account=a1b2c3d4 tenant=t1 role=',
      `everything-command=${RUN} setup everything --account a1b2c3d4 --defer-upload <tenants>`,
      `chosen-command=${RUN} setup chosen --account a1b2c3d4 --defer-upload`,
      'setup=0 sessions=0 workspaces=1 chosen=no',
    ]);
    assert.equal(audits.length, 0);
  });
}

test('of two workspaces, only the one the upload can send to counts its sessions', async (t) => {
  link(t, { tenants: [ACME, tenant('t2', 'Side Project', [], SKIP)] });
  const { deps } = engine({ t1: [session('w1', WEB)], t2: [session('a1', API)] });
  const out = await listing(deps);
  assert.deepEqual(tLines(out.lines), ['T1. web (/beezi-setup-x/web), 1 session account=a1b2c3d4 kind=folder now=default match=/beezi-setup-x/web']);
  assert.equal(last(out.lines), 'setup=1 sessions=1 workspaces=2 chosen=no');
});

test('a place whose name holds a control character is left out of the T lines, the checklist and the counts', async (t) => {
  link(t);
  const { deps } = engine({ null: [session('w1', WEB), session('x1', '/beezi-setup-x/bad\nname'), session('x2', '/beezi-setup-x/bad\u2028name')] });
  const out = await listing(deps);
  assert.equal(out.lines[1], 'Beezi found 1 past Codex session (1 Oct, 1 folder)');
  assert.deepEqual(tLines(out.lines).map((l) => l.slice(0, l.indexOf(' account='))), ['T1. web (/beezi-setup-x/web), 1 session']);
  assert.equal(last(out.lines), 'setup=1 sessions=1 workspaces=1 chosen=no');
});

// POSIX word splitting for the quoting the printed commands use: '…', "…" and a backslash outside quotes.
function shellWords(line) {
  const words = [];
  let word = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === ' ') {
      if (word != null) words.push(word);
      word = null;
      continue;
    }
    if (word == null) word = '';
    if (c === "'" || c === '"') {
      const end = line.indexOf(c, i + 1);
      word += line.slice(i + 1, end);
      i = end;
    } else if (c === '\\') {
      word += line[i + 1];
      i += 1;
    } else {
      word += c;
    }
  }
  if (word != null) words.push(word);
  return words;
}

test('a folder with a space and a quote round-trips through its printed T command', async (t) => {
  link(t);
  const quoted = "/beezi-setup-x/My Repo's";
  const { deps } = engine({ null: [session('q1', quoted)] });
  const command = (await listing(deps)).lines.find((l) => l.startsWith('T1-command=')).slice('T1-command='.length).replace('<tenants>', 'none');
  const words = shellWords(command);
  assert.deepEqual(words.slice(0, 2), ['node', `${ROOT}/scripts/workspace.mjs`]);
  const out = await workspaceCommand(words.slice(2), WRITES);
  assert.equal(out.ok, true, out.stderr.join('\n'));
  assert.deepEqual((await getAccount(TEST_KEY)).workspaceRules.map((r) => [r.kind, r.match, r.tenantIds]), [['folder', quoted, []]]);
});

for (const ref of ['t2', 't1']) {
  test(`a one-workspace rule refuses a workspace id (${ref}) and takes only none`, async (t) => {
    link(t);
    const out = await workspaceCommand(['rule', 'add', '--folder', WEB, '--account', TEST_KEY, ref], WRITES);
    assert.equal(out.ok, false);
    assert.deepEqual(out.stderr, ['\n✗ a1b2c3d4@example.com has one workspace, so a rule can only stop tracking a repo or folder. Pass none.']);
    assert.equal((await getAccount(TEST_KEY)).workspaceRules, undefined);
  });
}

test('a place whose sessions route differently lists as now=default', async (t) => {
  link(t, { workspaceRules: [{ kind: 'folder', match: '/beezi-setup-x/two', label: '/beezi-setup-x/two', tenantIds: [] }] });
  const origin = { origin: 'https://github.com/acme/app.git' };
  saveRepoMap({ roots: { '/beezi-setup-x/one/app': origin, '/beezi-setup-x/two/app': origin } });
  const { deps } = engine({ null: [session('s1', '/beezi-setup-x/one/app'), session('s2', '/beezi-setup-x/two/app')] });
  const out = await listing(deps);
  assert.deepEqual(tLines(out.lines), ['T1. app (github.com/acme/app), 2 sessions account=a1b2c3d4 kind=repo now=default match=github.com/acme/app']);
});

test('a place whose name holds " <word>=" is left out of the T lines and the counts', async (t) => {
  link(t);
  const { deps } = engine({ null: [session('w1', WEB), session('x1', '/beezi-setup-x/bad account=y now=none')] });
  const out = await listing(deps);
  assert.deepEqual(tLines(out.lines).map((l) => l.slice(0, l.indexOf(' account='))), ['T1. web (/beezi-setup-x/web), 1 session']);
  assert.equal(last(out.lines), 'setup=1 sessions=1 workspaces=1 chosen=no');
  assert.deepEqual((await getAccount(TEST_KEY)).setupListing.sessionIds, ['w1']);
});

const QUOTED = "/beezi-setup-x/it's \u2018q\u2019";
const quotingCases = [
  { platform: 'darwin', flag: "--folder '/beezi-setup-x/it'\\''s \u2018q\u2019'" },
  { platform: 'linux', flag: "--folder '/beezi-setup-x/it'\\''s \u2018q\u2019'" },
  { platform: 'win32', flag: "--folder '/beezi-setup-x/it''s \u2018\u2018q\u2019\u2019'" },
];
for (const c of quotingCases) {
  test(`the T command quotes a folder for the ${c.platform === 'win32' ? 'PowerShell' : 'POSIX'} shell on ${c.platform}`, async (t) => {
    link(t);
    const { deps } = engine({ null: [session('q1', QUOTED)] }, {}, { platform: c.platform });
    const command = (await listing(deps)).lines.find((l) => l.startsWith('T1-command='));
    assert.equal(command, `T1-command=${RUN} rule add ${c.flag} --account a1b2c3d4 --defer-upload <tenants>`);
  });
}

test('a listing that asks saves the consent record: the listed sessions and each workspace\'s hidden kinds', async (t) => {
  link(t, { tenants: [tenant('t1', 'Acme', ['repos', 'branches']), SIDE] });
  const { deps } = engine({ t1: [session('w1', WEB, SEP_3), session('w2', WEB)], t2: [session('w2', WEB), session('a1', API, NOV_11)] });
  await listing(deps);
  const { listedAt, ...record } = (await getAccount(TEST_KEY)).setupListing;
  assert.equal(typeof listedAt, 'string');
  assert.deepEqual(record, { sessionIds: ['w1', 'w2', 'a1'], kinds: { t1: ['repos', 'branches'], t2: [] } });
});

const noRecordCases = [
  { name: 'says chosen=yes', arrange: async (t) => { link(t); await markTrackingChosen(TEST_KEY, '2026-11-11T00:00:00.000Z'); }, over: {} },
  { name: 'fails to count', arrange: async (t) => link(t), over: { reason: 'no-token' } },
];
for (const c of noRecordCases) {
  test(`a listing that ${c.name} saves no consent record`, async (t) => {
    await c.arrange(t);
    const { deps } = engine({ null: [session('w1', WEB)] }, c.over);
    await listing(deps);
    assert.equal((await getAccount(TEST_KEY)).setupListing, undefined);
  });
}

for (const sub of ['everything', 'chosen']) {
  test(`setup ${sub} marks the saved listing record answered`, async (t) => {
    link(t);
    const { deps } = engine({ null: [session('w1', WEB)] });
    await listing(deps);
    assert.equal((await getAccount(TEST_KEY)).setupListing.answeredAt, undefined);
    const out = await workspaceCommand(['setup', sub, '--account', TEST_KEY, '--defer-upload'], WRITES);
    assert.equal(out.ok, true, out.stderr.join('\n'));
    const row = await getAccount(TEST_KEY);
    assert.equal(row.setupListing.answeredAt, row.trackingChosenAt);
    assert.deepEqual(row.setupListing.sessionIds, ['w1']);
  });
}

const RULE = { kind: 'folder', match: WEB, label: WEB, tenantIds: [] };

test('setup everything t1,t2 sends new folders to both, keeps the rules, marks reviewed and sets the marker', async (t) => {
  link(t, { tenants: [ACME, SIDE], workspaceRules: [RULE] });
  const out = await workspaceCommand(['setup', 'everything', 't1,t2', '--account', TEST_KEY, '--defer-upload'], WRITES);
  assert.equal(out.ok, true, out.stderr.join('\n'));
  assert.equal(last(out.lines), 'setup=everything');
  const row = await getAccount(TEST_KEY);
  assert.deepEqual(row.newFolders, { mode: 'send', tenantIds: ['t1', 't2'] });
  assert.deepEqual(row.workspaceRules.map((r) => [r.match, r.tenantIds]), [[WEB, []]]);
  assert.deepEqual(row.reviewedTenantIds, ['t1', 't2']);
  assert.equal(typeof row.trackingChosenAt, 'string');
});

test('setup everything on one workspace only records the choice', async (t) => {
  link(t);
  const out = await workspaceCommand(['setup', 'everything', 't1', '--account', TEST_KEY, '--defer-upload'], WRITES);
  assert.deepEqual(out, { ok: true, lines: ['setup=everything'], stderr: [] });
  const row = await getAccount(TEST_KEY);
  assert.equal(row.newFolders, undefined);
  assert.equal(row.workspaceRules, undefined);
  assert.deepEqual(row.reviewedTenantIds, ['t1']);
  assert.equal(typeof row.trackingChosenAt, 'string');
});

test('setup chosen on several workspaces sets New folders to ask, marks reviewed and sets the marker', async (t) => {
  link(t, { tenants: [ACME, SIDE] });
  const out = await workspaceCommand(['setup', 'chosen', '--account', TEST_KEY, '--defer-upload'], WRITES);
  assert.equal(out.ok, true, out.stderr.join('\n'));
  assert.equal(last(out.lines), 'setup=chosen');
  const row = await getAccount(TEST_KEY);
  assert.deepEqual(row.newFolders, { mode: 'ask', tenantIds: [] });
  assert.deepEqual(row.reviewedTenantIds, ['t1', 't2']);
  assert.equal(typeof row.trackingChosenAt, 'string');
});

test('setup chosen on one workspace only records the choice', async (t) => {
  link(t);
  const out = await workspaceCommand(['setup', 'chosen', '--account', TEST_KEY, '--defer-upload'], WRITES);
  assert.deepEqual(out, { ok: true, lines: ['setup=chosen'], stderr: [] });
  assert.equal(typeof (await getAccount(TEST_KEY)).trackingChosenAt, 'string');
});

for (const argv of [['setup'], ['setup', 'everything', 't1'], ['setup', 'chosen']]) {
  test(`${argv.join(' ')} refuses an account that is not linked`, async (t) => {
    link(t, { status: 'revoked' });
    const { audits, deps } = engine({ null: [session('w1', WEB)] });
    const out = await workspaceCommand(argv.concat(['--account', TEST_KEY, '--defer-upload']), deps);
    assert.deepEqual(out, { ok: false, lines: [], stderr: [NOT_LINKED] });
    assert.equal(audits.length, 0);
    assert.equal((await getAccount(TEST_KEY)).trackingChosenAt, undefined);
  });
}
