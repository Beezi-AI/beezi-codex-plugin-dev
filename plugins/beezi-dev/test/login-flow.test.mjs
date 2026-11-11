import '../tools/hermetic-env.mjs';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeHome, linkAccount } from '../tools/account-fixtures.mjs';
import { loginFlow } from '../scripts/login-flow.mjs';

const KEY = 'a1b2c3d4';
const PLUS = '✓ Beezi billing captured: source=subscription plan=plus via=app-server.\n';
const TRUST = '  One step left — run /hooks in Codex, review the Beezi entries, and trust them.\n';
const SIGNED_IN = `\n✓ Beezi analytics linked as u@x.io.\n\n  Analytics hooks installed for you.\n${TRUST}account=${KEY}\n`;
const NO_TRUST_STEP = '✓ Beezi: analytics hooks updated to this plugin version.\n  The registry entries did not change, so there is NOTHING to re-trust — /hooks can stay closed.\n';
const CAPTURE = `billing-capture.mjs --from-codex --via login --account ${KEY}`;
const LIST = `workspace.mjs setup --account ${KEY}`;
const DEFAULTS = ['telemetry.mjs default', 'settings.mjs keys'];
const FINISH_CALLS = ['hooks.mjs install', `sync.mjs --offer --past --account ${KEY} --consented`].concat(DEFAULTS);

afterEach(() => { process.exitCode = undefined; });

const ok = (stdout) => ({ code: 0, stdout, stderr: '' });

const W_SOLO = `W. Solo account=${KEY} tenant=S role=Owner`;
const W_BETA = `W. Beta account=${KEY} tenant=B role=User`;
const EVERYTHING = `everything-command=node "/p/scripts/workspace.mjs" setup everything --account ${KEY} --defer-upload <tenants>`;
const CHOSEN = `chosen-command=node "/p/scripts/workspace.mjs" setup chosen --account ${KEY} --defer-upload`;
const LISTING = [
  '<checklist>',
  'Beezi found 2 past Codex sessions (3 Sep – 11 Nov, 1 folder)',
  '</checklist>',
  W_SOLO,
  `T1. web-app (github.com/acme/web-app), 2 sessions account=${KEY} kind=repo now=default match=github.com/acme/web-app`,
  `T1-command=node "/p/scripts/workspace.mjs" rule add --repo github.com/acme/web-app --account ${KEY} --defer-upload <tenants>`,
  EVERYTHING,
  CHOSEN,
  'setup=1 sessions=2 workspaces=1 chosen=no',
].join('\n');
const CHOSEN_LISTING = [W_SOLO, EVERYTHING, CHOSEN, 'setup=0 sessions=0 workspaces=1 chosen=yes'].join('\n');
const EMPTY_SOLO = [W_SOLO, EVERYTHING, CHOSEN, 'setup=0 sessions=0 workspaces=1 chosen=no'].join('\n');
const EMPTY_TWO = [W_SOLO, W_BETA, EVERYTHING, CHOSEN, 'setup=0 sessions=0 workspaces=2 chosen=no'].join('\n');

const replies = (listing, extra = {}) => ({
  'billing-capture.mjs': ok(PLUS),
  'workspace.mjs': (args) => (args[1] === 'everything' ? ok('setup=everything\n') : ok(`${listing}\n`)),
  'hooks.mjs': ok(`✓ Beezi: analytics hooks are already installed and current — nothing to change.\n  If analytics still are not arriving, run /hooks in Codex, review the Beezi entries, and trust them.\n`),
  'sync.mjs': ok('uploading=0 workspaces=0\n'),
  'telemetry.mjs': ok(''),
  'settings.mjs': ok('crash=correlate\n'),
  ...extra,
});

// Runs the flow with faked scripts and hook-trust probe, so no test spawns a child; `calls` records each script run.
async function flow(argv, scripted, signIn = ok(SIGNED_IN), verdict = 'untrusted') {
  const calls = [];
  const printed = [];
  const log = console.log;
  console.log = (text) => printed.push(String(text));
  try {
    const run = (script, args) => {
      calls.push([script].concat(args).join(' '));
      const r = scripted[script];
      return typeof r === 'function' ? r(args) : r;
    };
    const live = async (script, args) => { calls.push([script].concat(args).join(' ')); return signIn; };
    await loginFlow(argv, { run, live, trust: async () => ({ verdict, untrusted: [], disabled: [] }) });
  } finally {
    console.log = log;
  }
  const out = printed.join('\n');
  return { calls, out, next: out.split('\n').pop(), tags: out.split('\n').filter((l) => /^<[a-z-]+[ >]/.test(l)) };
}

const link = (t) => linkAccount(makeHome(t), KEY, { tenants: [{ id: 'S', name: 'Solo' }] });

test('a failed sign-in stops with exit code 1', async () => {
  const r = await flow([], replies(LISTING), { code: 1, stdout: 'Opening your browser…\n' });
  assert.deepEqual(r.calls, ['login.mjs']);
  assert.equal(r.next, 'next=stop');
  assert.equal(process.exitCode, 1);
});

test('tracking not chosen yet stops once with the listing in a <track> block', async () => {
  const r = await flow([], replies(LISTING));
  assert.deepEqual(r.calls, ['login.mjs', CAPTURE, LIST]);
  assert.deepEqual(r.tags, ['<sign-in>', '<plan>', `<track account="${KEY}">`, '<checklist>']);
  assert.ok(r.out.endsWith(`<track account="${KEY}">\n${LISTING}\n</track>\nnext=track account=${KEY}`));
});

test('the plan step prints the plan it found and no question', async () => {
  const r = await flow([], replies(LISTING));
  assert.ok(r.out.includes('<plan>\n✓ Plan found: Plus\n</plan>'));
  assert.ok(!/next=tier|ChatGPT Free/.test(r.out));
});

test('a plan the capture cannot settle prints the not-detected line and no question', async () => {
  const capture = ok('Beezi: Codex named no ChatGPT account — nothing captured. Run `codex login` if you meant to be signed in.\n');
  const r = await flow([], replies(LISTING, { 'billing-capture.mjs': capture }));
  assert.ok(r.out.includes("<plan>\nBeezi couldn't detect this machine's plan. Set it in $beezi:settings.\n</plan>"));
  assert.equal(r.next, `next=track account=${KEY}`);
});

test('an expired Codex sign-in keeps its notice in the <plan> block', async () => {
  const expired = 'Beezi: your Codex sign-in expired on 2026-09-30, so its plan info is out of date — sign in to Codex again, or tell Beezi your plan.';
  const r = await flow([], replies(LISTING, { 'billing-capture.mjs': ok(`${expired}\n`) }));
  assert.ok(r.out.includes([
    '<plan>',
    expired,
    "Beezi couldn't detect this machine's plan. Set it in $beezi:settings.",
    '</plan>',
  ].join('\n')));
});

test('tracking already chosen runs to next=done with no stop and no upload', async () => {
  const r = await flow([], replies(CHOSEN_LISTING));
  assert.deepEqual(r.calls, ['login.mjs', CAPTURE, LIST].concat(DEFAULTS));
  assert.ok(r.out.endsWith([
    '<finish>',
    '✓ Tracking is already set up ($beezi:settings)',
    '',
    'One step left. In Codex, run /hooks and trust Beezi.',
    'Crash reports are on ($beezi:settings)',
    '</finish>',
    `next=done account=${KEY}`,
  ].join('\n')));
});

test('an unknown workspace list asks nothing, writes nothing and uploads nothing', async () => {
  const r = await flow([], replies('setup=0 sessions=0 workspaces=0 chosen=no'));
  assert.deepEqual(r.calls, ['login.mjs', CAPTURE, LIST].concat(DEFAULTS));
  assert.ok(r.out.endsWith([
    '<finish>',
    'One step left. In Codex, run /hooks and trust Beezi.',
    'Crash reports are on ($beezi:settings)',
    '</finish>',
    `next=done account=${KEY}`,
  ].join('\n')));
});

const failedListings = [
  ['a non-zero exit with a ✓ notice', { code: 1, stdout: '✓ Beezi: Codex is still saving analytics on this machine, so nothing was listed this time. Run `$beezi:sync` again in a minute.\n', stderr: '' },
    '✓ Beezi: Codex is still saving analytics on this machine, so nothing was listed this time. Run `$beezi:sync` again in a minute.'],
  ['a non-zero exit with a ✗ line', { code: 1, stdout: '', stderr: '\n✗ rollouts unreadable\n' }, '✗ rollouts unreadable'],
  ['no setup= line', ok('Beezi: half a listing\n'), 'Beezi: half a listing'],
];
for (const [name, listing, line] of failedListings) {
  test(`a failed listing (${name}) says past sessions could not be checked and finishes without the upload`, async () => {
    const r = await flow([], replies('', { 'workspace.mjs': listing }));
    assert.deepEqual(r.calls, ['login.mjs', CAPTURE, LIST].concat(DEFAULTS));
    assert.ok(r.out.endsWith([
      '<finish>',
      line,
      '',
      'One step left. In Codex, run /hooks and trust Beezi.',
      'Crash reports are on ($beezi:settings)',
      'Beezi couldn\'t check past sessions. Ask "Sign me in to Beezi" in a new Codex thread to choose what to track.',
      '</finish>',
      `next=done account=${KEY}`,
    ].join('\n')));
  });
}

test('no past sessions in one workspace tracks everything and finishes without the upload', async () => {
  const r = await flow([], replies(EMPTY_SOLO));
  assert.deepEqual(r.calls, ['login.mjs', CAPTURE, LIST, `workspace.mjs setup everything --account ${KEY} --defer-upload`].concat(DEFAULTS));
  assert.ok(r.out.includes('<finish>\n✓ Tracking every repo and folder you work in\n\nOne step left. In Codex, run /hooks and trust Beezi.\n'));
  assert.equal(r.next, `next=done account=${KEY}`);
});

test('no past sessions in one workspace: a failed setup everything shows its line and no tracking line', async () => {
  const write = { code: 1, stdout: '', stderr: '\n✗ Accounts are being updated by another Beezi process. Try again.\n' };
  const r = await flow([], replies(EMPTY_SOLO, { 'workspace.mjs': (args) => (args[1] === 'everything' ? write : ok(`${EMPTY_SOLO}\n`)) }));
  assert.ok(r.out.includes('<finish>\n✗ Accounts are being updated by another Beezi process. Try again.\n\nOne step left. In Codex, run /hooks and trust Beezi.\n'));
  assert.ok(!r.out.includes('✓ Tracking every repo and folder you work in'));
});

test('no past sessions in several workspaces stops for the question', async () => {
  const r = await flow([], replies(EMPTY_TWO));
  assert.deepEqual(r.calls, ['login.mjs', CAPTURE, LIST]);
  assert.ok(r.out.endsWith(`<track account="${KEY}">\n${EMPTY_TWO}\n</track>\nnext=track account=${KEY}`));
});

test('--account alone, after the beezi_login tool signed in, starts at the plan', async (t) => {
  link(t);
  const r = await flow(['--account', KEY], replies(LISTING));
  assert.deepEqual(r.calls, [CAPTURE, LIST]);
  assert.deepEqual(r.tags, ['<plan>', `<track account="${KEY}">`, '<checklist>']);
  assert.equal(r.next, `next=track account=${KEY}`);
});

const uploads = [
  ['uploading=212 workspaces=1\n', ['✓ 212 past sessions are uploading in the background', '']],
  ['uploading=1 workspaces=1\n', ['✓ 1 past session is uploading in the background', '']],
  ['uploading=0 workspaces=0\n', []],
];
for (const [stdout, lines] of uploads) {
  test(`--from finish after ${stdout.trim()} runs the consented upload and the defaults, then the closing lines`, async (t) => {
    link(t);
    const r = await flow(['--account', KEY, '--from', 'finish'], replies(LISTING, { 'sync.mjs': ok(stdout) }));
    assert.deepEqual(r.calls, FINISH_CALLS);
    assert.equal(r.out, ['<finish>'].concat(lines, [
      'One step left. In Codex, run /hooks and trust Beezi.',
      'Crash reports are on ($beezi:settings)',
      '</finish>',
      `next=done account=${KEY}`,
    ]).join('\n'));
  });
}

test('--from finish after a failed upload shows its line and still closes', async (t) => {
  link(t);
  const busy = { code: 1, stdout: 'uploading=0 workspaces=0\n', stderr: 'Beezi: another sync is running. Try again in a minute.\n' };
  const r = await flow(['--account', KEY, '--from', 'finish'], replies(LISTING, { 'sync.mjs': busy }));
  assert.equal(r.out, [
    '<finish>',
    'Beezi: another sync is running. Try again in a minute.',
    '',
    'One step left. In Codex, run /hooks and trust Beezi.',
    'Crash reports are on ($beezi:settings)',
    '</finish>',
    `next=done account=${KEY}`,
  ].join('\n'));
});

const closings = [
  ['crash=correlate', TRUST, ['One step left. In Codex, run /hooks and trust Beezi.', 'Crash reports are on ($beezi:settings)']],
  ['crash=off', TRUST, ['One step left. In Codex, run /hooks and trust Beezi.']],
  ['crash=anonymous', NO_TRUST_STEP, ['Ready. Restart Codex and keep working.', 'Crash reports are on ($beezi:settings)']],
  ['crash=off', NO_TRUST_STEP, ['Ready. Restart Codex and keep working.']],
];
for (const [crash, hooks, closing] of closings) {
  test(`--from finish with ${crash} and hooks ${hooks === TRUST ? 'to trust' : 'trusted'} closes with the matching lines`, async (t) => {
    link(t);
    const verdict = hooks === TRUST ? 'untrusted' : 'trusted';
    const r = await flow(['--account', KEY, '--from', 'finish'], replies(LISTING, { 'hooks.mjs': ok(hooks), 'settings.mjs': ok(`${crash}\n`) }), ok(SIGNED_IN), verdict);
    assert.deepEqual(r.calls, FINISH_CALLS);
    assert.equal(r.out, ['<finish>'].concat(closing, ['</finish>', `next=done account=${KEY}`]).join('\n'));
  });
}

test('a sign-in without the trust step closes with Ready', async () => {
  const signIn = ok(`\n✓ Beezi analytics linked as u@x.io.\n  Another Beezi process is updating the hook registry; it will be current in a moment.\naccount=${KEY}\n`);
  const r = await flow([], replies(CHOSEN_LISTING), signIn, 'trusted');
  assert.ok(r.out.includes('\n\nReady. Restart Codex and keep working.\n'));
});

test('a trusted machine that signs in again closes with Ready, though the sign-in printed the /hooks step', async () => {
  const r = await flow([], replies(CHOSEN_LISTING), ok(SIGNED_IN), 'trusted');
  assert.ok(r.out.endsWith([
    '<finish>',
    '✓ Tracking is already set up ($beezi:settings)',
    '',
    'Ready. Restart Codex and keep working.',
    'Crash reports are on ($beezi:settings)',
    '</finish>',
    `next=done account=${KEY}`,
  ].join('\n')));
});

const failedHooks = [
  ['trusted', []],
  ['untrusted', ['One step left. In Codex, run /hooks and trust Beezi.']],
];
for (const [verdict, closing] of failedHooks) {
  test(`--from finish after a failed hooks check, verdict ${verdict}: its ✗ line and never Ready`, async (t) => {
    link(t);
    const hooks = { code: 1, stdout: '', stderr: '\n✗ Something went wrong. Re-run with BEEZI_DEBUG=1 to see details.\n' };
    const r = await flow(['--account', KEY, '--from', 'finish'], replies(LISTING, { 'hooks.mjs': hooks }), ok(SIGNED_IN), verdict);
    assert.equal(r.out, ['<finish>', '✗ Something went wrong. Re-run with BEEZI_DEBUG=1 to see details.', ''].concat(closing, [
      'Crash reports are on ($beezi:settings)',
      '</finish>',
      `next=done account=${KEY}`,
    ]).join('\n'));
  });
}

test('--from finish shows a ⚠ line from the hooks check and none of its ✓ lines', async (t) => {
  link(t);
  const hooks = ok('✓ Beezi: analytics hooks repaired in /home/dev/.codex/hooks.json (was stale).\n\n⚠ Beezi: 1 registered hook entry points at a file that no longer exists.\n');
  const r = await flow(['--account', KEY, '--from', 'finish'], replies(LISTING, { 'hooks.mjs': hooks }), ok(SIGNED_IN), 'untrusted');
  assert.equal(r.out, [
    '<finish>',
    '⚠ Beezi: 1 registered hook entry points at a file that no longer exists.',
    '',
    'One step left. In Codex, run /hooks and trust Beezi.',
    'Crash reports are on ($beezi:settings)',
    '</finish>',
    `next=done account=${KEY}`,
  ].join('\n'));
});

test('only --from finish resumes, and it needs an account', async (t) => {
  link(t);
  for (const argv of [['--from', 'finish'], ['--account', KEY, '--from', 'setup'], ['--account', KEY, '--from', 'plan'], ['--account', KEY, '--from', 'history'], ['--account', KEY, '--from'], ['--account', KEY, 'finish']]) {
    await assert.rejects(flow(argv, replies(LISTING)), { message: /^Usage: login-flow\.mjs \[--account <ref> \[--from finish\]\]$/ }, argv.join(' '));
  }
});
