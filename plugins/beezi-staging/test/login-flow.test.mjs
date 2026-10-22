import '../tools/hermetic-env.mjs';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeHome, linkAccount } from '../tools/account-fixtures.mjs';
import { loginFlow } from '../scripts/login-flow.mjs';
import { UserError } from '../lib/friendly-error.mjs';

const KEY = 'a1b2c3d4';
const TENANTS = [{ id: 'A', name: 'Acme', role: 'Tenant Owner' }, { id: 'B', name: 'Northwind', role: 'User' }];
const SOLO = [{ id: 'S', name: 'Solo' }];
const PLUS = '✓ Beezi billing captured: source=subscription plan=plus via=app-server.\n';
// A fixed non-existent path: routes as a folder, never as this worktree's repo.
const CWD = '/work/labacus-suite';

afterEach(() => { process.exitCode = undefined; });

const ok = (stdout) => ({ code: 0, stdout, stderr: '' });
const listed = (lines, extra = {}) => ({ ok: true, lines, stderr: [], ...extra });

// Collects console.log output while fn runs.
async function capture(fn) {
  const printed = [];
  const log = console.log;
  console.log = (text) => printed.push(String(text));
  try {
    await fn();
  } finally {
    console.log = log;
  }
  return printed.join('\n');
}

// Faked scripts and counts, so no test spawns a child or reads this machine's rollouts; `calls` records each script run.
function fakes(calls, { signIn = ok(`\n✓ Beezi analytics linked as u@x.io.\naccount=${KEY}\n`), captured = PLUS, ...extra } = {}) {
  return {
    run: (script, args) => { calls.push([script].concat(args).join(' ')); return ok(captured); },
    live: async (script, args) => { calls.push([script].concat(args).join(' ')); return signIn; },
    pastSessions: () => ({ sessions: 37, places: 4 }),
    cwd: CWD,
    ...extra,
  };
}

async function flow(argv, options = {}) {
  const calls = [];
  const out = await capture(() => loginFlow(argv, fakes(calls, options)));
  return { calls, out, next: out.split('\n').pop(), tags: out.split('\n').filter((l) => /^<[a-z-]+[ >]/.test(l)) };
}

const link = (t, over = {}) => linkAccount(makeHome(t), KEY, { tenants: TENANTS, ...over });
const deps = fakes([]);

test('the setup question lists each workspace, several, and the per-repo choice, with the counts', async (t) => {
  link(t);
  const out = await capture(() => loginFlow(['--account', KEY, '--from', 'setup'], deps));
  assert.match(out, /^<setup account="a1b2c3d4">\nW\. Acme account=a1b2c3d4 tenant=A role=Owner\nW\. Northwind .*\nsessions=37 places=4\n/m);
  assert.match(out, /^O1\. Acme — Everything goes here: new repos and folders, and 4 with history \(37 past sessions\)$/m);
  assert.match(out, /^O3\. Several workspaces… — Pick two or more; everything goes to each of them$/m);
  assert.match(out, /^O4\. Let me choose per repo — Beezi asks about each repo and folder with history next, and new ones when a session starts there\n<\/setup>$/m);
  assert.doesNotMatch(out, /<preview/);
  assert.match(out, /^next=setup account=a1b2c3d4$/m);
});

test('a fresh sign-in of an account in several workspaces stops at the setup question, before the capture', async (t) => {
  link(t);
  const r = await flow([]);
  assert.deepEqual(r.calls, ['login.mjs']);
  assert.deepEqual(r.tags, ['<sign-in>', `<setup account="${KEY}">`]);
  assert.ok(r.out.includes('W. Northwind account=a1b2c3d4 tenant=B role=User\nsessions=37 places=4\nO1. Acme — '));
  assert.equal(r.next, `next=setup account=${KEY}`);
});

test('a failing count still asks, with its ✗ line and the options without counts', async (t) => {
  link(t);
  const r = await flow(['--account', KEY, '--from', 'setup'], { pastSessions: () => { throw new UserError('rollouts unreadable'); } });
  assert.ok(r.out.includes('role=User\n✗ rollouts unreadable\nO1. Acme — Everything goes here, starting with new repos and folders\n'));
  assert.ok(r.out.includes('O2. Northwind — Everything goes here, starting with new repos and folders\nO3. Several workspaces… — Pick two or more; everything goes to each of them\nO4. Let me choose per repo — '));
  assert.ok(!r.out.includes('sessions='));
  assert.equal(r.next, `next=setup account=${KEY}`);
});

test('a failed sign-in stops with exit code 1', async (t) => {
  link(t);
  const r = await flow([], { signIn: { code: 1, stdout: 'Opening your browser…\n' } });
  assert.deepEqual(r.calls, ['login.mjs']);
  assert.equal(r.next, 'next=stop');
  assert.equal(process.exitCode, 1);
});

test('a one-workspace account with a known plan runs every step in one call, up to the backfill', async (t) => {
  link(t, { tenants: SOLO });
  const r = await flow([]);
  assert.deepEqual(r.calls, ['login.mjs', `billing-capture.mjs --from-codex --via login --account ${KEY}`]);
  assert.deepEqual(r.tags, ['<sign-in>', '<capture>', `<joined account="${KEY}">`, `<routes account="${KEY}">`]);
  assert.ok(r.out.includes(`<capture>\n${PLUS.trim()}\n</capture>`));
  assert.equal(r.next, `next=backfill account=${KEY}`);
});

test('--from setup goes straight to the capture for one workspace, or New folders already set', async (t) => {
  const home = makeHome(t);
  for (const over of [{ tenants: SOLO }, { tenants: TENANTS, newFolders: { mode: 'send', tenantIds: ['A'] } }]) {
    linkAccount(home, KEY, over);
    const r = await flow(['--account', KEY, '--from', 'setup']);
    assert.ok(!r.out.includes('<setup'));
    assert.equal(r.calls[0], `billing-capture.mjs --from-codex --via login --account ${KEY}`);
    assert.equal(r.next, `next=backfill account=${KEY}`);
  }
});

test('--from here stops for this folder under Ask me when it has no rule', async (t) => {
  link(t, { newFolders: { mode: 'ask', tenantIds: [] } });
  const r = await flow(['--account', KEY, '--from', 'here']);
  assert.deepEqual(r.calls, []);
  assert.match(r.out, new RegExp(`^<rules account="${KEY}">\\n[\\s\\S]*\\nhere: .* account=${KEY} rule=none kind=\\S+ match=.*\\n</rules>\\nnext=here account=${KEY}$`));
});

test('--from here skips this folder when New folders sends somewhere, and shows no rules block', async (t) => {
  link(t, { newFolders: { mode: 'send', tenantIds: ['B'] } });
  const r = await flow(['--account', KEY, '--from', 'here']);
  assert.ok(!r.out.includes('<rules'));
  assert.equal(r.calls[0], `billing-capture.mjs --from-codex --via login --account ${KEY}`);
  assert.equal(r.next, `next=backfill account=${KEY}`);
});

test('--from here goes on when this folder already has a rule', async (t) => {
  link(t, { newFolders: { mode: 'ask', tenantIds: [] } });
  const here = `here: x → R1 now=A account=${KEY} rule=1 kind=folder match=/work/x`;
  const r = await flow(['--account', KEY, '--from', 'here'], { workspace: async (argv) => listed(argv[0] === 'rules' ? [here] : []) });
  assert.ok(!r.out.includes('<rules'));
  assert.equal(r.next, `next=backfill account=${KEY}`);
});

test('a folder path holding " rule=" does not decide whether this folder is asked about', async (t) => {
  link(t, { newFolders: { mode: 'ask', tenantIds: [] } });
  const ruled = `here: a rule=none b (/work/a rule=none b) → R1 now=A path=/work/a rule=none b account=${KEY} rule=1 kind=folder match=/work/a rule=none b`;
  const goes = await flow(['--account', KEY, '--from', 'here'], { workspace: async (argv) => listed(argv[0] === 'rules' ? [ruled] : []) });
  assert.ok(!goes.out.includes('<rules'));
  assert.equal(goes.next, `next=backfill account=${KEY}`);
  const unruled = `here: a rule=1 b (/work/a rule=1 b) → no rule now=pending path=/work/a rule=1 b account=${KEY} rule=none kind=folder match=/work/a rule=1 b`;
  const stops = await flow(['--account', KEY, '--from', 'here'], { workspace: async (argv) => listed(argv[0] === 'rules' ? [unruled] : []) });
  assert.ok(stops.out.includes(`<rules account="${KEY}">\n${unruled}\n</rules>`));
  assert.equal(stops.next, `next=here account=${KEY}`);
});

test('a rules listing that fails under Ask me shows its ✗ line and does not stop for this folder', async (t) => {
  link(t, { newFolders: { mode: 'ask', tenantIds: [] } });
  const workspace = async (argv) => (argv[0] === 'rules' ? listed([], { ok: false, stderr: ['\n✗ boom'] }) : listed([]));
  const r = await flow(['--account', KEY, '--from', 'here'], { workspace });
  assert.ok(r.out.includes(`<rules account="${KEY}">\n✗ boom\n</rules>\n<capture>`));
  assert.equal(r.next, `next=backfill account=${KEY}`);
});

test('the plan step stops for the tier question unless the capture settled a plan', async (t) => {
  link(t, { tenants: SOLO });
  const cases = [
    ['Beezi: Codex named no ChatGPT account — nothing captured. Run `codex login` if you meant to be signed in.\n', 'tier'],
    ['Beezi: ChatGPT account info still does not name a plan — keeping the self-reported plan.\n', 'tier'],
    ['Beezi: your Codex sign-in expired on 2026-09-01, so its plan info is out of date — sign in to Codex again, or tell Beezi your plan.\n', 'tier'],
    ['✓ Beezi billing captured: source=subscription plan=unknown via=auth-json.\n', 'tier'],
    [PLUS, 'backfill'],
    ['✓ Beezi billing captured: source=openai_api_key plan=n/a.\n', 'backfill'],
  ];
  for (const [captured, step] of cases) {
    const r = await flow(['--account', KEY, '--from', 'plan'], { captured });
    assert.equal(r.next, `next=${step} account=${KEY}`, captured);
  }
});

test('--from joined runs only the listings, in-process and deferring their upload', async (t) => {
  link(t, { tenants: SOLO });
  const seen = [];
  const workspace = async (argv, options) => { seen.push([argv, options]); return listed([`${argv[0]}=0`]); };
  const r = await flow(['--account', KEY, '--from', 'joined'], { workspace });
  assert.deepEqual(r.calls, []);
  assert.deepEqual(seen, [[['joined', '--account', KEY, '--defer-upload'], { cwd: CWD }], [['routes', '--account', KEY, '--defer-upload'], { cwd: CWD }]]);
  assert.deepEqual(r.tags, [`<joined account="${KEY}">`, `<routes account="${KEY}">`]);
  assert.equal(r.next, `next=backfill account=${KEY}`);
});

test('a listing with something to ask stops there', async (t) => {
  link(t, { tenants: SOLO });
  const joined = await flow(['--account', KEY, '--from', 'joined'], { workspace: async () => listed(['J1. api (github.com/o/api), 2 sessions', 'joined=1']) });
  assert.ok(!joined.out.includes('<routes'));
  assert.equal(joined.next, `next=joined account=${KEY}`);
  const routes = await flow(['--account', KEY, '--from', 'routes'], { workspace: async () => listed(['routes=2']) });
  assert.equal(routes.next, `next=routes account=${KEY}`);
});

test('a listing that fails shows its ✗ line in its block and the later steps still run', async (t) => {
  link(t, { tenants: SOLO });
  const workspace = async (argv) => (argv[0] === 'joined' ? listed([], { ok: false, stderr: ['\n✗ rollouts unreadable'] }) : listed(['routes=0']));
  const r = await flow(['--account', KEY, '--from', 'joined'], { workspace });
  assert.ok(r.out.includes(`<joined account="${KEY}">\n✗ rollouts unreadable\n</joined>\n<routes account="${KEY}">\nroutes=0\n</routes>`));
  assert.equal(r.next, `next=backfill account=${KEY}`);
});

test('--from needs a known step and an account', async (t) => {
  link(t, { tenants: SOLO });
  for (const argv of [['--from', 'plan'], ['--account', KEY, '--from', 'backfill'], ['--account', KEY], ['--account', KEY, '--from']]) {
    await assert.rejects(flow(argv), { message: /^Usage: login-flow\.mjs/ }, argv.join(' '));
  }
});
