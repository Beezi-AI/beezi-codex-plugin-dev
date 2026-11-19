import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { runSetup } from '../lib/setup-wizard.mjs';
import { createProgressWriter, readProgress } from '../lib/upload-progress.mjs';
import { createStyle } from '../lib/setup-style.mjs';
import { commands, failed, fakeCtx, labels, ok } from '../tools/setup-fixtures.mjs';

const KEY = 'a1b2c3d4';
const T0 = Date.parse('2026-11-18T10:00:00.000Z');
const CHECKLIST = [
  'Beezi found 185 past Codex sessions (3 Sep – 11 Nov, 3 folders)',
  '  in web-app, api, blog',
  '  Sent',
  '    ✓ dates, duration, models, tokens, cost',
  '    ✓ tool, skill and MCP names',
  '  Never sent',
  '    ✕ session titles, error messages and subagent names',
];
const ACME = `W. Acme account=${KEY} tenant=t1 role=Owner`;
const SIDE = `W. Side Project account=${KEY} tenant=t2 role=Member`;
const LIST = `workspace.mjs setup --account ${KEY}`;
const CAPTURE = `billing-capture.mjs --from-codex --via login --account ${KEY}`;
const UPLOAD = `sync.mjs --offer --past --account ${KEY} --consented`;
const PLUS = ok('✓ Beezi billing captured: source=subscription plan=plus via=app-server.\n');
const HOOKS_CURRENT = ok([
  '✓ Beezi: analytics hooks are already installed and current — nothing to change.',
  '  Registry: /home/dev/.codex/hooks.json',
  '  Events:   SessionStart, Stop',
  '  If analytics still are not arriving, run /hooks in Codex, review the Beezi entries, and trust them.',
  '',
].join('\n'));
const HOOKS_REFRESHED = ok([
  '✓ Beezi: analytics hooks updated to this plugin version.',
  '  Launcher: /home/dev/.codex/beezi/hook-launcher.mjs',
  '  The registry entries did not change, so there is NOTHING to re-trust — /hooks can stay closed.',
  '',
].join('\n'));

// A T line and its command, `now` before match as workspace.mjs prints it.
function place(i, body, kind, match, now) {
  return [
    `T${i}. ${body} account=${KEY} kind=${kind} now=${now} match=${match}`,
    `T${i}-command=node "/p/scripts/workspace.mjs" rule add --${kind} '${match}' --account ${KEY} <tenants> --defer-upload`,
  ];
}
const WEB = (now) => place(1, 'web-app (github.com/acme/web-app), 96 sessions', 'repo', 'github.com/acme/web-app', now);
const API = (now) => place(2, 'api (github.com/acme/api), 71 sessions', 'repo', 'github.com/acme/api', now);
const BLOG = (now) => place(3, 'blog (~/personal/blog), 18 sessions', 'folder', '/Users/dev/personal/blog', now);

// `workspace.mjs setup` output; the checklist only when there are places.
function listing(o) {
  const places = o.places || [];
  const lines = places.length ? ['<checklist>'].concat(CHECKLIST, ['</checklist>']) : [];
  return ok(lines.concat(o.workspaces, ...places, [
    `everything-command=node "/p/scripts/workspace.mjs" setup everything --account ${KEY} --defer-upload <tenants>`,
    `chosen-command=node "/p/scripts/workspace.mjs" setup chosen --account ${KEY} --defer-upload`,
    `setup=${places.length} sessions=185 workspaces=${o.workspaces.length} chosen=${o.chosen || 'no'}`,
    '',
  ]).join('\n'));
}

const keys = (workspaces, crash) => ok(`menu=Rules|Account|Crash reports\naccount=${KEY} default=yes multi=no workspaces=${workspaces} status=linked email=ann@example.com\ncrash=${crash}\n`);

// A linked one-workspace account on a Plus plan whose hooks are current and trusted; `over` replaces or adds outputs.
function outputs(over) {
  return Object.assign({
    'accounts.mjs list': ok(`Beezi: 1 account linked. The default is the account the analytics skill reads from.\n  1. Ann <ann@example.com> - Acme [${KEY}]  (default)\n`),
    'settings.mjs keys': [keys(1, 'correlate'), keys(1, 'correlate')],
    'hooks.mjs install': HOOKS_REFRESHED,
    [CAPTURE]: PLUS,
    [LIST]: listing({ workspaces: [ACME], places: [WEB('default'), API('default'), BLOG('default')] }),
    [UPLOAD]: ok('uploading=185 workspaces=1 tenants=t1\n'),
  }, over);
}

// The worker's record for Acme, started at T0; `writer` keeps writing it.
const record = (now = () => T0) => createProgressWriter({ key: KEY, tenantId: 't1', workspace: 'Acme', now, throttleMs: 0 });
const uploaded = (sent) => record().finish({ processed: sent, total: sent, sent });
beforeEach(() => uploaded(185));

// The fake ctx on a clock stopped at T0, with sleeps that return at once.
const setupCtx = (...args) => ({ ...fakeCtx(...args), now: () => T0, sleep: async () => {} });

// Fresh per test: the fake shifts its array of answers.
const two = () => ({ 'settings.mjs keys': [keys(2, 'correlate'), keys(2, 'correlate')] });
const CLOSING = ['', 'Ready. Restart Codex and keep working.', 'Crash reports are on ($beezi:settings)'];
const SIGNED_IN = '✓ Signed in as ann@example.com, workspace Acme';
const HEAD = [SIGNED_IN, '✓ Plan found: Plus'];

test('Everything on one workspace: the full command order, the checklist above the question, and the closing block', async () => {
  const ctx = setupCtx(outputs(), [0]);
  assert.equal(await runSetup(ctx), 0);
  assert.deepEqual(commands(ctx), [
    'accounts.mjs list',
    'settings.mjs keys',
    'hooks.mjs install',
    CAPTURE,
    LIST,
    `workspace.mjs setup everything --account ${KEY} --defer-upload`,
    UPLOAD,
    'telemetry.mjs default',
    'settings.mjs keys',
  ]);
  assert.deepEqual(ctx.runs.map((r) => r.label), [
    'Checking this machine', 'Checking this machine', 'Checking this machine', 'Checking this machine',
    'Checking past sessions', 'Checking past sessions', 'Checking past sessions',
    'Checking this machine', 'Checking this machine',
  ]);
  assert.deepEqual(ctx.asked, [{
    kind: 'choose',
    question: 'What should it track?',
    options: [
      { label: 'Everything', description: 'all 3, and new ones as you open them' },
      { label: 'Let me choose', description: 'tick the repos and folders' },
    ],
    lead: CHECKLIST,
  }]);
  assert.deepEqual(ctx.printed, HEAD.concat([
    '✓ Tracking all 3 repos and folders',
    '✓ 185 past sessions uploaded to Acme',
  ], CLOSING));
});

const SIGN_IN = [
  '',
  'Beezi analytics — link this machine',
  '',
  'Opening your browser to sign in with your Beezi account…',
  'If it does not open, go to:',
  '  https://auth.example.com/authorize?client=1',
  '',
  '',
  '✓ Beezi analytics linked as Ann <ann@example.com> - Acme. Credentials stored in the macOS keychain.',
  '',
  '  Analytics hooks installed for you.',
  '  One step left — run /hooks in Codex, review the Beezi entries, and trust them.',
  `account=${KEY}`,
  '',
].join('\n');

test('with no usable account it signs in through the browser, reads the new account, skips the hooks check and ends on the /hooks step', async () => {
  const ctx = setupCtx(outputs({
    'accounts.mjs list': [
      ok('Beezi: 1 account linked. The default is the account the analytics skill reads from.\n  1. old@example.com [0badc0de]  (revoked)\n'),
      ok(`  1. old@example.com [0badc0de]  (revoked)\n  2. Ann <ann@example.com> - Acme [${KEY}]  (default)\n`),
    ],
    'login.mjs': ok(SIGN_IN),
  }), [0], 'untrusted');
  assert.equal(await runSetup(ctx), 0);
  assert.deepEqual(commands(ctx), [
    'accounts.mjs list',
    'login.mjs',
    'accounts.mjs list',
    'settings.mjs keys',
    CAPTURE,
    LIST,
    `workspace.mjs setup everything --account ${KEY} --defer-upload`,
    UPLOAD,
    'telemetry.mjs default',
    'settings.mjs keys',
  ]);
  const opts = ctx.runs[1].opts;
  assert.deepEqual([opts.stream, opts.label], [true, 'Waiting for you to sign in in your browser']);
  const shown = [
    'Opening your browser to sign in with your Beezi account…',
    'If it does not open, go to:',
    '  https://auth.example.com/authorize?client=1',
    '✗ Could not open a browser automatically (no http handler).',
    '  Open this URL yourself to finish signing in:',
    'Already linked on this machine (1):',
  ];
  const hidden = [
    `account=${KEY}`,
    '',
    'Beezi analytics — link this machine',
    '✓ Beezi analytics linked as Ann <ann@example.com> - Acme. Credentials stored in the macOS keychain.',
    '✓ Beezi analytics re-linked as Ann. Credentials stored in Windows Credential Manager.',
    '✓ already linked as Ann. Nothing changed — the sign-in you just completed was handed back.',
    "  The analytics skill still reads from this machine's default account.",
    '  Analytics hooks installed for you.',
    '  Analytics hooks repaired for you (they were stale).',
    '  Analytics hooks are installed. If nothing arrives, run /hooks in Codex, review the Beezi entries, and trust them.',
    '  One step left — run /hooks in Codex, review the Beezi entries, and trust them.',
    '  Another Beezi process is updating the hook registry; it will be current in a moment.',
  ];
  assert.deepEqual(shown.map((line) => opts.hide.test(line)), [false, false, false, false, false, false]);
  assert.deepEqual(hidden.map((line) => opts.hide.test(line)), Array(12).fill(true));
  assert.deepEqual(ctx.printed, [
    SIGNED_IN,
    '✓ Plan found: Plus',
    '✓ Tracking all 3 repos and folders',
    '✓ 185 past sessions uploaded to Acme',
    '',
    'One step left. In Codex, run /hooks and trust Beezi.',
    'Crash reports are on ($beezi:settings)',
  ]);
});

test('a trusted machine that signs in again ends Ready, though the sign-in printed the /hooks step', async () => {
  const ctx = setupCtx(outputs({
    'accounts.mjs list': [ok('No Beezi accounts are linked on this machine.\n'), ok(`  1. Ann <ann@example.com> - Acme [${KEY}]  (default)\n`)],
    'login.mjs': ok(SIGN_IN),
    [LIST]: listing({ workspaces: [ACME], chosen: 'yes' }),
  }), [], 'trusted');
  assert.equal(await runSetup(ctx), 0);
  assert.deepEqual(ctx.printed, [SIGNED_IN, '✓ Plan found: Plus', '✓ Tracking is already set up ($beezi:settings)'].concat(CLOSING));
});

test('a sign-in whose hooks were already installed and trusted ends Ready', async () => {
  const ctx = setupCtx(outputs({
    'accounts.mjs list': [ok('No Beezi accounts are linked on this machine.\n'), ok(`  1. Ann <ann@example.com> - Acme [${KEY}]  (default)\n`)],
    'login.mjs': ok(`✓ Beezi analytics linked as Ann <ann@example.com> - Acme. Credentials stored in the macOS keychain.\n  Another Beezi process is updating the hook registry; it will be current in a moment.\naccount=${KEY}\n`),
    [LIST]: listing({ workspaces: [ACME], chosen: 'yes' }),
  }), []);
  assert.equal(await runSetup(ctx), 0);
  assert.deepEqual(ctx.printed.slice(-2), CLOSING.slice(1));
});

test('a failed or keyless sign-in stops setup with exit 1 before any other step', async () => {
  const outcomes = [
    { code: 1, stdout: 'Opening your browser to sign in with your Beezi account…\n', stderr: '\n✗ Could not reach the Beezi server. Check your internet connection and try again.\n' },
    failed("✗ Beezi is migrating this machine's data to the production namespace. Try again in a moment.\n"),
    { code: 1, stdout: `account=${KEY}\n`, stderr: '' },
    ok('✓ Beezi analytics linked as Ann. Credentials stored in the macOS keychain.\n'),
    ok('account=K1\n'),
  ];
  for (const outcome of outcomes) {
    const ctx = fakeCtx({ 'accounts.mjs list': ok('No Beezi accounts are linked on this machine.\n'), 'login.mjs': outcome }, []);
    assert.equal(await runSetup(ctx), 1);
    assert.deepEqual(commands(ctx), ['accounts.mjs list', 'login.mjs']);
    assert.deepEqual(ctx.printed, []);
  }
});

test('a linked account is reused without a question, the default one first', async () => {
  const ctx = setupCtx(outputs({
    'accounts.mjs list': ok([
      'Beezi: 3 accounts linked. The default is the account the analytics skill reads from.',
      '  1. old@example.com [0badc0de]  (revoked)',
      '  2. Bob <bob@example.com> - Beta - EU [99887766]',
      `  3. Ann <ann@example.com> - Acme [${KEY}]  (default)`,
    ].join('\n')),
    [LIST]: listing({ workspaces: [ACME], chosen: 'yes' }),
  }), []);
  assert.equal(await runSetup(ctx), 0);
  assert.deepEqual(ctx.asked, []);
  assert.deepEqual(commands(ctx).slice(0, 4), ['accounts.mjs list', 'settings.mjs keys', 'hooks.mjs install', CAPTURE]);
  assert.equal(ctx.printed[0], SIGNED_IN);
});

test('the signed-in line names a workspace with " - " in it, and none when the account has several or no email', async () => {
  const bob = '99887766';
  const row = (workspaces, email) => ok(`account=${bob} default=yes multi=no workspaces=${workspaces} status=linked email=${email}\ncrash=off\n`);
  const cases = [
    { description: 'Bob <bob@example.com> - Beta - EU', keys: row(1, 'bob@example.com'), line: '✓ Signed in as bob@example.com, workspace Beta - EU' },
    { description: 'bob@example.com - Beta', keys: row(1, 'bob@example.com'), line: '✓ Signed in as bob@example.com, workspace Beta' },
    { description: 'Bob <bob@example.com> - Beta', keys: row(2, 'bob@example.com'), line: '✓ Signed in as bob@example.com' },
    { description: 'Bob <bob@example.com> - Beta', keys: row(0, 'unknown'), line: '✓ Signed in' },
  ];
  for (const c of cases) {
    const ctx = fakeCtx({
      'accounts.mjs list': ok(`  1. ${c.description} [${bob}]  (default)\n`),
      'settings.mjs keys': c.keys,
      [`workspace.mjs setup --account ${bob}`]: ok('setup=0 sessions=0 workspaces=0 chosen=no\n'),
    }, []);
    assert.equal(await runSetup(ctx), 0);
    assert.equal(ctx.printed[0], c.line, c.description);
  }
});

test('Let me choose on one workspace: unticked places get a none rule, then setup chosen, then the upload', async () => {
  uploaded(96);
  const ctx = setupCtx(outputs({ [UPLOAD]: ok('uploading=96 workspaces=1 tenants=t1\n') }), [1, [0]]);
  assert.equal(await runSetup(ctx), 0);
  assert.deepEqual(ctx.asked[1], {
    kind: 'chooseMany',
    question: 'Which repos and folders should Beezi track?',
    options: [
      { label: 'github.com/acme/web-app', description: '96 sessions' },
      { label: 'github.com/acme/api', description: '71 sessions' },
      { label: '~/personal/blog', description: '18 sessions' },
    ],
    preselected: [0, 1, 2],
  });
  assert.deepEqual(commands(ctx).slice(4, 9), [
    LIST,
    `workspace.mjs rule add --repo github.com/acme/api --account ${KEY} none --defer-upload`,
    `workspace.mjs rule add --folder /Users/dev/personal/blog --account ${KEY} none --defer-upload`,
    `workspace.mjs setup chosen --account ${KEY} --defer-upload`,
    UPLOAD,
  ]);
  assert.deepEqual(ctx.printed.slice(2, 6), [
    '✓ Tracking 1 of 3 repos and folders',
    '  Not tracked: github.com/acme/api, ~/personal/blog',
    '✓ 96 past sessions uploaded to Acme',
    '  New repos are tracked. Leave one out in $beezi:settings.',
  ]);
});

test('Let me choose with nothing ticked writes none everywhere, says nothing is tracked and uploads nothing', async () => {
  const ctx = setupCtx(outputs(), [1, []]);
  assert.equal(await runSetup(ctx), 0);
  assert.deepEqual(commands(ctx).slice(5, 10), [
    `workspace.mjs rule add --repo github.com/acme/web-app --account ${KEY} none --defer-upload`,
    `workspace.mjs rule add --repo github.com/acme/api --account ${KEY} none --defer-upload`,
    `workspace.mjs rule add --folder /Users/dev/personal/blog --account ${KEY} none --defer-upload`,
    `workspace.mjs setup chosen --account ${KEY} --defer-upload`,
    'telemetry.mjs default',
  ]);
  assert.deepEqual(ctx.printed.slice(2), ['– Nothing is tracked yet. $beezi:settings adds repos and folders.'].concat(CLOSING));
});

test("one workspace: a Don't track place is not offered and counts as not tracked, with Let me choose or Everything", async () => {
  const listed = () => listing({ workspaces: [ACME], places: [WEB('t1'), API('default'), BLOG('none')] });
  const chosen = setupCtx(outputs({ [LIST]: listed() }), [1, [0, 1]]);
  assert.equal(await runSetup(chosen), 0);
  assert.deepEqual(chosen.asked[1].options, [
    { label: 'github.com/acme/web-app', description: '96 sessions' },
    { label: 'github.com/acme/api', description: '71 sessions' },
  ]);
  assert.deepEqual(chosen.asked[1].preselected, [0, 1]);
  assert.deepEqual(commands(chosen).slice(5, 7), [`workspace.mjs setup chosen --account ${KEY} --defer-upload`, UPLOAD]);
  assert.deepEqual(chosen.printed.slice(2, 4), ['✓ Tracking 2 of 3 repos and folders', '  Not tracked: ~/personal/blog']);
  const unticked = setupCtx(outputs({ [LIST]: listed() }), [1, [0]]);
  assert.equal(await runSetup(unticked), 0);
  assert.deepEqual(commands(unticked).slice(5, 7), [
    `workspace.mjs rule add --repo github.com/acme/api --account ${KEY} none --defer-upload`,
    `workspace.mjs setup chosen --account ${KEY} --defer-upload`,
  ]);
  assert.deepEqual(unticked.printed.slice(2, 4), ['✓ Tracking 1 of 3 repos and folders', '  Not tracked: github.com/acme/api, ~/personal/blog']);
  const all = setupCtx(outputs({ [LIST]: listed() }), [0]);
  assert.equal(await runSetup(all), 0);
  assert.deepEqual(all.printed.slice(2, 4), ['✓ Tracking 2 of 3 repos and folders', '  Not tracked: ~/personal/blog']);
});

const RULE_API = `workspace.mjs rule add --repo github.com/acme/api --account ${KEY} none --defer-upload`;
const EVERYTHING = `workspace.mjs setup everything --account ${KEY} --defer-upload`;
const CHOSEN = `workspace.mjs setup chosen --account ${KEY} --defer-upload`;
const failedWrites = [
  {
    name: 'a none rule write that fails',
    answers: [1, [0]],
    over: { [RULE_API]: failed('\n✗ Could not save the rule.\n') },
    after: [RULE_API],
    line: '✗ Could not save the rule.',
  },
  {
    name: 'a setup everything that fails',
    answers: [0],
    over: { [EVERYTHING]: failed('\n✗ Accounts are being updated by another Beezi process. Try again.\n') },
    after: [EVERYTHING],
    line: '✗ Accounts are being updated by another Beezi process. Try again.',
  },
  {
    name: 'a setup chosen that ends without its last line',
    answers: [1, [0, 1, 2]],
    over: { [CHOSEN]: ok('') },
    after: [CHOSEN],
    line: '✗ That step stopped unexpectedly.',
  },
];
for (const c of failedWrites) {
  test(`${c.name} stops the setup: its line, no tracking line, no later write and no upload, then the closing block`, async () => {
    const ctx = setupCtx(outputs(c.over), c.answers);
    assert.equal(await runSetup(ctx), 0);
    assert.deepEqual(commands(ctx).slice(4), [LIST].concat(c.after, ['telemetry.mjs default', 'settings.mjs keys']));
    assert.deepEqual(ctx.printed.slice(2), [c.line].concat(CLOSING));
  });
}

test('the signed-in line and the Everything line show the email and workspace names in bold', async () => {
  const ctx = setupCtx(outputs(Object.assign({
    [LIST]: listing({ workspaces: [ACME, SIDE], places: [WEB('default')] }),
  }, two())), [2]);
  ctx.style = createStyle({ enabled: true });
  assert.equal(await runSetup(ctx), 0);
  assert.equal(ctx.printed[0], '✓ Signed in as \x1b[1mann@example.com\x1b[0m');
  assert.equal(ctx.printed[2], '✓ Tracking all 1 repos and folders in \x1b[1mAcme and Side Project\x1b[0m');
  const one = setupCtx(outputs(), [0]);
  one.style = createStyle({ enabled: true });
  assert.equal(await runSetup(one), 0);
  assert.equal(one.printed[0], '✓ Signed in as \x1b[1mann@example.com\x1b[0m, workspace \x1b[1mAcme\x1b[0m');
});

const everythingCases = [
  { answer: 0, tenants: 't1', line: '✓ Tracking all 3 repos and folders in Acme' },
  { answer: 1, tenants: 't2', line: '✓ Tracking all 3 repos and folders in Side Project' },
  { answer: 2, tenants: 't1,t2', line: '✓ Tracking all 3 repos and folders in Acme and Side Project' },
];
for (const c of everythingCases) {
  test(`two workspaces, Everything row ${c.answer}: New folders go to ${c.tenants}`, async () => {
    const ctx = setupCtx(outputs(Object.assign({
      [LIST]: listing({ workspaces: [ACME, SIDE], places: [WEB('default'), API('default'), BLOG('default')] }),
    }, two())), [c.answer]);
    assert.equal(await runSetup(ctx), 0);
    assert.equal(ctx.asked[0].question, 'Where should they go?');
    assert.deepEqual(ctx.asked[0].options, [
      { label: 'Everything to Acme' },
      { label: 'Everything to Side Project' },
      { label: 'Everything to both' },
      { label: 'Let me choose', description: 'tick repos for each workspace' },
    ]);
    assert.equal(commands(ctx)[5], `workspace.mjs setup everything --account ${KEY} --defer-upload ${c.tenants}`);
    assert.deepEqual(ctx.printed.slice(0, 4), ['✓ Signed in as ann@example.com', '✓ Plan found: Plus', c.line, '✓ 185 past sessions uploaded to Acme']);
  });
}

test('three workspaces: one Everything row each, then Everything to all 3', async () => {
  const third = `W. Gamma account=${KEY} tenant=t3 role=Member`;
  const ctx = setupCtx(outputs(Object.assign({
    [LIST]: listing({ workspaces: [ACME, SIDE, third], places: [WEB('default'), API('default')] }),
  }, two())), [3]);
  assert.equal(await runSetup(ctx), 0);
  assert.deepEqual(labels(ctx.asked[0]), ['Everything to Acme', 'Everything to Side Project', 'Everything to Gamma', 'Everything to all 3', 'Let me choose']);
  assert.equal(commands(ctx)[5], `workspace.mjs setup everything --account ${KEY} --defer-upload t1,t2,t3`);
  assert.equal(ctx.printed[2], '✓ Tracking all 2 repos and folders in Acme, Side Project and Gamma');
});

test('two workspaces, Let me choose: ticks start from now=, rules follow the ticks, unchanged ones are not rewritten', async () => {
  const ctx = setupCtx(outputs(Object.assign({
    [LIST]: listing({ workspaces: [ACME, SIDE], places: [WEB('default'), API('t2'), BLOG('none')] }),
  }, two())), [3, [0], [1, 2]]);
  assert.equal(await runSetup(ctx), 0);
  assert.deepEqual(ctx.asked.slice(1).map((a) => [a.question, a.preselected]), [
    ['Which repos and folders go to Acme?', [0]],
    ['Which repos and folders go to Side Project?', [1]],
  ]);
  assert.deepEqual(commands(ctx).slice(5, 9), [
    `workspace.mjs rule add --repo github.com/acme/web-app --account ${KEY} t1 --defer-upload`,
    `workspace.mjs rule add --folder /Users/dev/personal/blog --account ${KEY} t2 --defer-upload`,
    `workspace.mjs setup chosen --account ${KEY} --defer-upload`,
    UPLOAD,
  ]);
  assert.deepEqual(ctx.printed.slice(2), [
    '✓ Acme gets 1 of 3 repos and folders',
    '✓ Side Project gets 2 of 3 repos and folders',
    '✓ 185 past sessions uploaded to Acme',
    '  New repos: Beezi asks the first time you work in one.',
  ].concat(CLOSING));
});

test("two workspaces, Let me choose: the second list starts with the first list's leftovers", async () => {
  const ctx = setupCtx(outputs(Object.assign({
    [LIST]: listing({ workspaces: [ACME, SIDE], places: [WEB('default'), API('default'), BLOG('default')] }),
  }, two())), [3, [0], []]);
  assert.equal(await runSetup(ctx), 0);
  assert.deepEqual(ctx.asked.slice(1).map((a) => a.preselected), [[0, 1, 2], [1, 2]]);
  assert.deepEqual(commands(ctx).slice(5, 9), [
    `workspace.mjs rule add --repo github.com/acme/web-app --account ${KEY} t1 --defer-upload`,
    `workspace.mjs rule add --repo github.com/acme/api --account ${KEY} none --defer-upload`,
    `workspace.mjs rule add --folder /Users/dev/personal/blog --account ${KEY} none --defer-upload`,
    `workspace.mjs setup chosen --account ${KEY} --defer-upload`,
  ]);
  assert.deepEqual(ctx.printed.slice(2, 7), [
    '✓ Acme gets 1 of 3 repos and folders',
    '– Nothing goes to Side Project.',
    '  Not tracked: github.com/acme/api, ~/personal/blog',
    '✓ 185 past sessions uploaded to Acme',
    '  New repos: Beezi asks the first time you work in one.',
  ]);
});

test('a tick list closed without an answer writes nothing and skips the upload', async () => {
  const ctx = setupCtx(outputs(Object.assign({
    [LIST]: listing({ workspaces: [ACME, SIDE], places: [WEB('default')] }),
  }, two())), [3, [0]]);
  assert.equal(await runSetup(ctx), 0);
  assert.deepEqual(commands(ctx).slice(4, 6), [LIST, 'telemetry.mjs default']);
  assert.deepEqual(ctx.printed.slice(2), ['✓ Acme gets 1 of 1 repos and folders'].concat(CLOSING));
});

test('no past sessions on one workspace: no question, everything is recorded, no upload', async () => {
  const ctx = setupCtx(outputs({ [LIST]: listing({ workspaces: [ACME] }) }), []);
  assert.equal(await runSetup(ctx), 0);
  assert.deepEqual(ctx.asked, []);
  assert.deepEqual(commands(ctx).slice(4, 7), [LIST, `workspace.mjs setup everything --account ${KEY} --defer-upload`, 'telemetry.mjs default']);
  assert.deepEqual(ctx.printed.slice(2), ['✓ Tracking every repo and folder you work in'].concat(CLOSING));
});

test('no past sessions on several workspaces: where analytics go, or ask for each repo', async () => {
  const ask = setupCtx(outputs(Object.assign({ [LIST]: listing({ workspaces: [ACME, SIDE] }) }, two())), [3]);
  assert.equal(await runSetup(ask), 0);
  assert.deepEqual(ask.asked, [{
    kind: 'choose',
    question: "Where should this machine's analytics go?",
    options: [{ label: 'Everything to Acme' }, { label: 'Everything to Side Project' }, { label: 'Everything to both' }, { label: 'Ask me for each repo' }],
    lead: [],
  }]);
  assert.deepEqual(commands(ask).slice(5, 7), [`workspace.mjs setup chosen --account ${KEY} --defer-upload`, 'telemetry.mjs default']);
  assert.equal(ask.printed[2], '  New repos: Beezi asks the first time you work in one.');
  const both = setupCtx(outputs(Object.assign({ [LIST]: listing({ workspaces: [ACME, SIDE] }) }, two())), [2]);
  assert.equal(await runSetup(both), 0);
  assert.deepEqual(commands(both).slice(5, 7), [`workspace.mjs setup everything --account ${KEY} --defer-upload t1,t2`, 'telemetry.mjs default']);
  assert.equal(both.printed[2], '✓ Tracking every repo and folder you work in');
});

test('tracking already chosen: no question, no writes, no upload', async () => {
  const ctx = setupCtx(outputs({ [LIST]: listing({ workspaces: [ACME], chosen: 'yes' }) }), []);
  assert.equal(await runSetup(ctx), 0);
  assert.deepEqual(ctx.asked, []);
  assert.deepEqual(commands(ctx).slice(4, 6), [LIST, 'telemetry.mjs default']);
  assert.deepEqual(ctx.printed.slice(2), ['✓ Tracking is already set up ($beezi:settings)'].concat(CLOSING));
});

test('an unknown workspace list: sign-in line without a workspace, no question, no tracking line, no upload', async () => {
  const ctx = setupCtx(outputs({
    'settings.mjs keys': [keys(0, 'correlate'), keys(0, 'correlate')],
    [LIST]: ok('setup=0 sessions=0 workspaces=0 chosen=no\n'),
  }), []);
  assert.equal(await runSetup(ctx), 0);
  assert.deepEqual(ctx.asked, []);
  assert.deepEqual(commands(ctx).slice(4, 6), [LIST, 'telemetry.mjs default']);
  assert.deepEqual(ctx.printed, ['✓ Signed in as ann@example.com', '✓ Plan found: Plus'].concat(CLOSING));
});

const UNCHECKED = 'Beezi couldn\'t check past sessions. Ask "Sign me in to Beezi" in a new Codex thread to choose what to track.';
const failedListings = [
  { name: 'an error on stderr', result: failed("✗ Could not access Beezi's local data (EACCES).\n"), line: "✗ Could not access Beezi's local data (EACCES)." },
  {
    name: 'a busy count on stdout',
    result: { code: 1, stdout: 'Beezi: another session sync is running. Try again after it finishes.\n', stderr: '' },
    line: 'Beezi: another session sync is running. Try again after it finishes.',
  },
];
for (const c of failedListings) {
  test(`a failed listing with ${c.name} asks nothing, writes nothing, uploads nothing, and the closing block says so`, async () => {
    const ctx = setupCtx(outputs({ [LIST]: c.result }), []);
    assert.equal(await runSetup(ctx), 0);
    assert.deepEqual(ctx.asked, []);
    assert.deepEqual(commands(ctx).slice(4, 6), [LIST, 'telemetry.mjs default']);
    assert.deepEqual(ctx.printed.slice(2), [c.line].concat(CLOSING, UNCHECKED));
  });
}

const NO_PLAN = "Beezi couldn't detect this machine's plan. Set it in $beezi:settings.";
const EXPIRED = 'Beezi: your Codex sign-in expired on 2026-09-30, so its plan info is out of date — sign in to Codex again, or tell Beezi your plan.';
const planCases = [
  { name: 'Plus subscription', capture: PLUS, lines: ['✓ Plan found: Plus'] },
  { name: 'Pro 20x subscription', capture: ok('✓ Beezi billing captured: source=subscription plan=pro_20x via=auth-json.\n'), lines: ['✓ Plan found: Pro 20x'] },
  { name: 'API key', capture: ok('✓ Beezi billing captured: source=openai_api_key plan=n/a via=auth-json.\n'), lines: ['✓ Plan found: API key'] },
  { name: 'third-party provider', capture: ok('✓ Beezi billing captured: source=third_party plan=n/a.\n'), lines: ['✓ Plan found: Third-party provider'] },
  { name: 'unknown tier', capture: ok('✓ Beezi billing captured: source=subscription plan=unknown via=app-server.\n'), lines: [], noPlan: true },
  {
    name: 'no ChatGPT account',
    capture: ok('Beezi: Codex named no ChatGPT account — nothing captured. Run `codex login` if you meant to be signed in.\n'),
    lines: [],
    noPlan: true,
  },
  { name: 'expired Codex sign-in', capture: ok(`${EXPIRED}\n`), lines: [EXPIRED], noPlan: true },
  { name: 'failed capture', capture: failed('✗ Something went wrong. Re-run with BEEZI_DEBUG=1 to see details.\n'), lines: ['✗ Something went wrong. Re-run with BEEZI_DEBUG=1 to see details.'], noPlan: true },
];
for (const c of planCases) {
  test(`plan step, ${c.name}: ${c.noPlan ? 'no plan line and the closing dim line' : c.lines[0]}`, async () => {
    const ctx = setupCtx(outputs({ [CAPTURE]: c.capture, [LIST]: listing({ workspaces: [ACME], chosen: 'yes' }) }), []);
    assert.equal(await runSetup(ctx), 0);
    assert.deepEqual(ctx.asked, []);
    assert.deepEqual(commands(ctx).slice(3, 5), [CAPTURE, LIST]);
    const tail = ['✓ Tracking is already set up ($beezi:settings)'].concat(CLOSING);
    assert.deepEqual(ctx.printed.slice(1), c.lines.concat(tail, c.noPlan ? [NO_PLAN] : []));
  });
}

const uploadCases = [
  { name: 'one session', sent: 1, result: ok('uploading=1 workspaces=1 tenants=t1\n'), lines: ['✓ 1 past session uploaded to Acme'] },
  { name: 'none owed', result: ok('uploading=0 workspaces=0 tenants=\n'), lines: [] },
  {
    name: 'another sync running',
    result: failed('✗ Beezi: another sync is already running. Try again when it finishes.\n'),
    lines: ['✗ Beezi: another sync is already running. Try again when it finishes.'],
  },
  { name: 'a worker that cannot start, with nothing on stderr', result: { code: 1, stdout: 'uploading=0 workspaces=0 tenants=\n', stderr: '' }, lines: ['✗ That step stopped unexpectedly.'] },
];
for (const c of uploadCases) {
  test(`the upload step, ${c.name}, still ends with the closing block`, async () => {
    if (c.sent !== undefined) uploaded(c.sent);
    const ctx = setupCtx(outputs({ [UPLOAD]: c.result }), [0]);
    assert.equal(await runSetup(ctx), 0);
    assert.deepEqual(ctx.printed.slice(2), ['✓ Tracking all 3 repos and folders'].concat(c.lines, CLOSING));
  });
}

const THREE = { [UPLOAD]: ok('uploading=3 workspaces=1 tenants=t1\n') };
const TRACKED = '✓ Tracking all 3 repos and folders';

// A ctx whose worker has read 1 of Acme's 3 sessions, and finishes them during the first sleep.
function followCtx(over) {
  const writer = record();
  writer.update({ processed: 1, total: 3, sent: 1 });
  const sleep = async () => { writer.finish({ processed: 3, total: 3, sent: 3 }); };
  return { ...setupCtx(outputs(THREE), [0]), sleep, ...over };
}

test('on a terminal the upload redraws one bar line in place, then ends on the done line', async () => {
  const written = [];
  const ctx = followCtx({ platform: 'darwin', activity: true, output: { write: (text) => written.push(text) }, format: (line) => `  ${line}` });
  assert.equal(await runSetup(ctx), 0);
  assert.deepEqual(written, ['\r\x1b[2K  ⠋ Uploading past sessions to Acme  ▓▓▓▓▓░░░░░░░░░  1/3', '\r\x1b[2K']);
  assert.deepEqual(ctx.printed.slice(2), [TRACKED, '✓ 3 past sessions uploaded to Acme'].concat(CLOSING));
});

// The worker has read all 3 sessions; its record is finished on the second sleep.
function finishingCtx(over) {
  const writer = record();
  writer.update({ processed: 3, total: 3, sent: 1 });
  let polls = 0;
  const sleep = async () => {
    polls += 1;
    if (polls === 2) writer.finish({ processed: 3, total: 3, sent: 3 });
  };
  return { ...setupCtx(outputs(THREE), [0]), sleep, ...over };
}

test('on a terminal the spinner moves every poll while the count stays at the total', async () => {
  const written = [];
  const ctx = finishingCtx({ platform: 'darwin', activity: true, output: { write: (text) => written.push(text) }, format: (line) => line });
  assert.equal(await runSetup(ctx), 0);
  assert.deepEqual(written, ['\r\x1b[2K⠋ Finishing upload to Acme…', '\r\x1b[2K⠙ Finishing upload to Acme…', '\r\x1b[2K']);
  assert.deepEqual(ctx.printed.slice(2), [TRACKED, '✓ 3 past sessions uploaded to Acme'].concat(CLOSING));
});

test('off a terminal the finishing line prints once however many polls follow', async () => {
  const writer = record();
  writer.update({ processed: 1, total: 3, sent: 1 });
  let polls = 0;
  const sleep = async () => {
    polls += 1;
    if (polls === 1) writer.update({ processed: 3, total: 3, sent: 1 });
    if (polls === 3) writer.finish({ processed: 3, total: 3, sent: 3 });
  };
  const ctx = { ...setupCtx(outputs(THREE), [0]), sleep };
  assert.equal(await runSetup(ctx), 0);
  assert.deepEqual(ctx.printed.slice(2), [
    TRACKED, 'Beezi: 1/3 sessions read…', 'Beezi: all sessions read, finishing upload…', '✓ 3 past sessions uploaded to Acme',
  ].concat(CLOSING));
});

test('on a Windows terminal the bar is drawn in ASCII', async () => {
  const written = [];
  const ctx = followCtx({ platform: 'win32', activity: true, output: { write: (text) => written.push(text) }, format: (line) => `  ${line}` });
  assert.equal(await runSetup(ctx), 0);
  assert.deepEqual(written, ['\r\x1b[2K  | Uploading past sessions to Acme  #####---------  1/3', '\r\x1b[2K']);
});

const widthCases = [
  {
    name: 'a long workspace name is cut with … to the columns left after the margin, less one',
    workspace: 'Acme Corporation Platform Team',
    columns: 60,
    bar: '⠋ Uploading past sessions to Acme Cor…  ▓▓▓▓▓░░░░░░░░░  1/3',
  },
  {
    name: 'on a wide terminal the bar line is cut at 100 characters, where lines wrap',
    workspace: 'X'.repeat(80),
    columns: 200,
    bar: `⠋ Uploading past sessions to ${'X'.repeat(49)}…  ▓▓▓▓▓░░░░░░░░░  1/3`,
  },
  {
    name: 'a name that fits is drawn whole',
    workspace: 'Acme',
    columns: 60,
    bar: '⠋ Uploading past sessions to Acme  ▓▓▓▓▓░░░░░░░░░  1/3',
  },
];
for (const c of widthCases) {
  test(`on a terminal, ${c.name}`, async () => {
    const writer = createProgressWriter({ key: KEY, tenantId: 't1', workspace: c.workspace, now: () => T0, throttleMs: 0 });
    writer.update({ processed: 1, total: 3, sent: 1 });
    const written = [];
    const ctx = {
      ...setupCtx(outputs(THREE), [0]),
      platform: 'darwin', activity: true, columns: () => c.columns, output: { write: (text) => written.push(text) }, format: (line) => line,
      sleep: async () => { writer.finish({ processed: 3, total: 3, sent: 3 }); },
    };
    assert.equal(await runSetup(ctx), 0);
    assert.equal(written[0], `\r\x1b[2K${c.bar}`);
  });
}

test('a run that did not end clean shows no done line, says the rest keeps uploading and is not marked reported', async () => {
  const writer = record();
  writer.update({ processed: 1, total: 40, sent: 1 });
  const ctx = { ...setupCtx(outputs(THREE), [0]), sleep: async () => { writer.finish({ processed: 1, total: 40, sent: 1 }, true); } };
  assert.equal(await runSetup(ctx), 0);
  assert.deepEqual(ctx.printed.slice(2), [TRACKED, 'Beezi: 1/40 sessions read…', 'Beezi: the rest keeps uploading in the background'].concat(CLOSING));
  assert.equal(readProgress(KEY, 't1').reported, false);
});

test('off a terminal the upload prints a plain line per change and the done line, with no carriage return', async () => {
  const ctx = followCtx({});
  assert.equal(await runSetup(ctx), 0);
  assert.deepEqual(ctx.printed.slice(2), [TRACKED, 'Beezi: 1/3 sessions read…', '✓ 3 past sessions uploaded to Acme'].concat(CLOSING));
  assert.deepEqual(ctx.printed.filter((line) => line.indexOf('\r') !== -1), []);
});

test('the workspace whose done line setup showed is marked reported', async () => {
  const ctx = followCtx({});
  await runSetup(ctx);
  assert.equal(readProgress(KEY, 't1').reported, true);
});

test('Ctrl+C while following says the rest keeps uploading and setup still closes', async () => {
  const ctx = followCtx({ catchInterrupt: (task) => task(() => true) });
  assert.equal(await runSetup(ctx), 0);
  assert.deepEqual(ctx.printed.slice(2), [TRACKED, 'Beezi: the rest keeps uploading in the background'].concat(CLOSING));
});

test('a finished record from an earlier upload is not shown: off a terminal setup stops at 100 s instead', async () => {
  record(() => T0 - 60000).finish({ processed: 9, total: 9, sent: 9 });
  const slept = [];
  let nowMs = T0;
  const ctx = { ...setupCtx(outputs(THREE), [0]), now: () => nowMs, sleep: async (ms) => { slept.push(ms); nowMs += ms; } };
  assert.equal(await runSetup(ctx), 0);
  assert.equal(slept.length, 100);
  assert.deepEqual(ctx.printed.slice(2), [TRACKED, 'Beezi: the rest keeps uploading in the background'].concat(CLOSING));
});

const HOOKS_REPAIRED = ok([
  '✓ Beezi: analytics hooks repaired in /home/dev/.codex/hooks.json (was stale).',
  '  Events: SessionStart, Stop',
  '',
  '  One more step — Codex will not run a hook it has not been shown:',
  '    run /hooks in Codex, review the Beezi entries, and trust them.',
  '',
  '⚠ Beezi: 1 registered hook entry points at a file that no longer exists.',
  '  Codex runs these every session and every run fails — check `hook: <Event> Failed`.',
  '',
].join('\n'));
const BUSY = ok('Beezi: another Beezi process is updating the hook registry right now — nothing was changed.\n  It is writing the same entries. Re-run this in a moment to see the result.\n');
const READY = 'Ready. Restart Codex and keep working.';
const ONE_STEP = 'One step left. In Codex, run /hooks and trust Beezi.';
const HOOKS_FAILED = failed('\n✗ Something went wrong. Re-run with BEEZI_DEBUG=1 to see details.\n');
const FAILED_LINE = '✗ Something went wrong. Re-run with BEEZI_DEBUG=1 to see details.';
const WARNING = '⚠ Beezi: 1 registered hook entry points at a file that no longer exists.';
// The closing headline follows the hook-trust verdict, never the hooks output; a failed check never closes with Ready.
const hooksCases = [
  { name: 'current', hooks: HOOKS_CURRENT, verdict: 'trusted', lines: [], closing: [READY] },
  { name: 'current', hooks: HOOKS_CURRENT, verdict: 'untrusted', lines: [], closing: [ONE_STEP] },
  { name: 'refreshed', hooks: HOOKS_REFRESHED, verdict: 'trusted', lines: [], closing: [READY] },
  { name: 'repaired', hooks: HOOKS_REPAIRED, verdict: 'untrusted', lines: [WARNING], closing: [ONE_STEP] },
  { name: 'repaired', hooks: HOOKS_REPAIRED, verdict: 'unknown', lines: [WARNING], closing: [READY] },
  { name: 'busy', hooks: BUSY, verdict: 'trusted', lines: [], closing: [READY] },
  { name: 'failed', hooks: HOOKS_FAILED, verdict: 'trusted', lines: [FAILED_LINE], closing: [] },
  { name: 'failed', hooks: HOOKS_FAILED, verdict: 'untrusted', lines: [FAILED_LINE], closing: [ONE_STEP] },
];
for (const c of hooksCases) {
  test(`a reused account's hooks check, ${c.name}, verdict ${c.verdict}: only its ⚠/✗ lines, then ${c.closing.length === 0 ? 'no headline' : c.closing[0]}`, async () => {
    const ctx = setupCtx(outputs({ 'hooks.mjs install': c.hooks, [LIST]: listing({ workspaces: [ACME], chosen: 'yes' }) }), [], c.verdict);
    assert.equal(await runSetup(ctx), 0);
    assert.deepEqual(ctx.runs[2], { command: 'hooks.mjs install', opts: {}, label: 'Checking this machine' });
    assert.deepEqual(ctx.printed, [SIGNED_IN].concat(c.lines, [
      '✓ Plan found: Plus', '✓ Tracking is already set up ($beezi:settings)', '',
    ], c.closing, ['Crash reports are on ($beezi:settings)']));
  });
}

const closingCases = [
  { crash: 'correlate', verdict: 'trusted', lines: ['', READY, 'Crash reports are on ($beezi:settings)'] },
  { crash: 'off', verdict: 'trusted', lines: ['', READY] },
  { crash: 'anonymous', verdict: 'untrusted', lines: ['', ONE_STEP, 'Crash reports are on ($beezi:settings)'] },
  { crash: 'off', verdict: 'untrusted', lines: ['', ONE_STEP] },
];
for (const c of closingCases) {
  test(`closing block after crash=${c.crash} with hooks ${c.verdict}`, async () => {
    const ctx = setupCtx(outputs({
      'settings.mjs keys': [keys(1, 'correlate'), keys(1, c.crash)],
      [LIST]: listing({ workspaces: [ACME], chosen: 'yes' }),
    }), [], c.verdict);
    assert.equal(await runSetup(ctx), 0);
    assert.deepEqual(commands(ctx).slice(-2), ['telemetry.mjs default', 'settings.mjs keys']);
    assert.deepEqual(ctx.printed.slice(-c.lines.length), c.lines);
  });
}

test('a failing crash default is reported, and an unreadable mode counts as off', async () => {
  const ctx = setupCtx(outputs({
    'settings.mjs keys': [keys(1, 'correlate'), failed('✗ Beezi: the data root could not be checked.\n')],
    'telemetry.mjs default': failed('✗ Beezi: could not save the crash report setting.\n'),
    [LIST]: listing({ workspaces: [ACME], chosen: 'yes' }),
  }), []);
  assert.equal(await runSetup(ctx), 0);
  assert.deepEqual(ctx.printed.slice(3), [
    '✗ Beezi: could not save the crash report setting.',
    '✗ Beezi: the data root could not be checked.',
    '', READY,
  ]);
});

test('a folder path with spaces, a quote and parentheses reaches the rule write whole, match= read to the end of the line', async () => {
  const body = `T1. My Repo's (~/My Repo's (old)), 3 sessions account=${KEY} kind=folder now=default match=/Users/dev/My Repo's (old)`;
  const ctx = setupCtx(outputs({
    [LIST]: ok(['<checklist>', CHECKLIST[0], '</checklist>', ACME, body, 'setup=1 sessions=3 workspaces=1 chosen=no', ''].join('\n')),
  }), [1, []]);
  assert.equal(await runSetup(ctx), 0);
  assert.deepEqual(ctx.asked[1].options, [{ label: "~/My Repo's (old)", description: '3 sessions' }]);
  assert.equal(commands(ctx)[5], `workspace.mjs rule add --folder /Users/dev/My Repo's (old) --account ${KEY} none --defer-upload`);
});

test('the checklist lead carries the no-folder sentence, and outside a project lists last by its own name', async () => {
  const outside = `T2. outside a project, 1 session account=${KEY} kind=outside now=default match=outside`;
  const ctx = setupCtx(outputs({
    [LIST]: ok(['<checklist>', CHECKLIST[0], '</checklist>', ACME].concat(WEB('default'), [
      outside, '2 other past sessions have no recorded folder and are not sent.', 'setup=2 sessions=97 workspaces=1 chosen=no', '',
    ]).join('\n')),
  }), [1, [0]]);
  assert.equal(await runSetup(ctx), 0);
  assert.deepEqual(ctx.asked[0].lead, [CHECKLIST[0], '2 other past sessions have no recorded folder and are not sent.']);
  assert.deepEqual(ctx.asked[1].options, [
    { label: 'github.com/acme/web-app', description: '96 sessions' },
    { label: 'outside a project', description: ' 1 session' },
  ]);
  assert.equal(commands(ctx)[5], `workspace.mjs rule add --outside --account ${KEY} none --defer-upload`);
});
