import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  askNewFolders, lastLine, parseHistory, parsePlaces, parseWorkspaces, placeOptions, placeQuestion, report,
  reviewJoined, reviewRoutes, ruleArgv, setupOptions, tenantsArg, token, workspaceOptions,
} from '../lib/setup-routing.mjs';

const W_LINES = [
  'W. Acme account=k1 tenant=t1 role=Owner',
  'W. Beta Team account=k1 tenant=t2 role=',
];
const ROUTES = [
  'dev@example.com: 3 repos or folders have past sessions with no rule (9 sessions) account=k1',
  ...W_LINES,
  'P1. api (github.com/acme/api), 4 sessions account=k1 kind=repo match=github.com/acme/api',
  "P1-command=node \"/p/scripts/workspace.mjs\" rule add --repo 'github.com/acme/api' --account k1 <tenants>",
  'P2. My (old) docs (~/My (old) docs), 1 session account=k1 kind=folder match=/Users/dev/My (old) docs',
  "P2-command=node \"/p/scripts/workspace.mjs\" rule add --folder '/Users/dev/My (old) docs' --account k1 <tenants>",
  'P3. outside a project, 4 sessions account=k1 kind=outside match=outside',
  'P3-command=node "/p/scripts/workspace.mjs" rule add --outside --account k1 <tenants>',
  'all-command=node "/p/scripts/workspace.mjs" rule add-all --account k1 <tenants>',
  '2 other past sessions have no recorded folder and are not sent.',
  'routes=3',
].join('\n');
const JOINED = [
  'dev@example.com: you joined Beta Team — 2 repos or folders to review account=k1 new=t2',
  'W. Acme account=k1 tenant=t1 new=no role=Owner',
  'W. Beta Team account=k1 tenant=t2 new=yes role=Member',
  'J1. api (github.com/acme/api), 4 sessions, now: Acme account=k1 kind=repo match=github.com/acme/api now=t1',
  "J1-command=node \"/p/scripts/workspace.mjs\" joined pick --repo 'github.com/acme/api' --account k1 <tenant>",
  'J2. notes (~/My notes), 1 session, now: no rule yet account=k1 kind=folder match=/Users/dev/My notes now=pending',
  "J2-command=node \"/p/scripts/workspace.mjs\" joined pick --folder '/Users/dev/My notes' --account k1 <tenant>",
  'add-all-command=node "/p/scripts/workspace.mjs" joined add-all --account k1',
  'done-command=node "/p/scripts/workspace.mjs" joined done --account k1',
  'joined=2',
].join('\n');

const ok = (stdout) => ({ code: 0, stdout, stderr: '' });

function fakeCtx(outputs, answers) {
  const runs = [];
  const asked = [];
  const printed = [];
  const queue = answers.slice();
  const next = (kind, question, options, opts) => {
    asked.push({ kind, question, options, opts });
    return Promise.resolve(queue.length ? queue.shift() : null);
  };
  return {
    runs, asked, printed,
    print: (line) => printed.push(line),
    run: (script, argv) => {
      runs.push([script].concat(argv).join(' '));
      const key = argv.join(' ');
      return Promise.resolve(Object.prototype.hasOwnProperty.call(outputs, key) ? outputs[key] : ok('✓ done\n'));
    },
    ask: {
      choose: (q, o) => next('choose', q, o),
      chooseMany: (q, o, opts) => next('chooseMany', q, o, opts),
      confirm: (q) => next('confirm', q),
      text: (q) => next('text', q),
    },
  };
}

test('token reads space-free key=value fields; lastLine finds the last matching line', () => {
  const line = 'new-folders=ask set=no multi=yes account=k1';
  assert.equal(token(line, 'set'), 'no');
  assert.equal(token(line, 'new-folders'), 'ask');
  assert.equal(token(line, 'tenant'), null);
  assert.equal(lastLine('a=1\nx\naccount=k1\naccount=k2\n', /^account=/), 'account=k2');
  assert.equal(lastLine('x\r\ny\r\n', /^z/), null);
});

test('parseWorkspaces reads names with spaces, tenants, empty roles and new flags', () => {
  assert.deepEqual(parseWorkspaces(ROUTES), [
    { name: 'Acme', tenant: 't1', role: 'Owner', isNew: false },
    { name: 'Beta Team', tenant: 't2', role: '', isNew: false },
  ]);
  assert.equal(parseWorkspaces(JOINED)[1].isNew, true);
});

test('parsePlaces reads P lines, including labels and matches with spaces and parentheses', () => {
  assert.deepEqual(parsePlaces(ROUTES, 'P'), [
    { kind: 'repo', match: 'github.com/acme/api', short: 'api', label: 'github.com/acme/api', where: null },
    { kind: 'folder', match: '/Users/dev/My (old) docs', short: 'My (old) docs', label: '~/My (old) docs', where: null },
    { kind: 'outside', match: 'outside', short: 'outside a project', label: null, where: null },
  ]);
});

test('parsePlaces reads J lines: where, and a match ending before now=', () => {
  assert.deepEqual(parsePlaces(JOINED, 'J'), [
    { kind: 'repo', match: 'github.com/acme/api', short: 'api', label: 'github.com/acme/api', where: 'Acme' },
    { kind: 'folder', match: '/Users/dev/My notes', short: 'notes', label: '~/My notes', where: 'no rule yet' },
  ]);
  assert.deepEqual(parsePlaces(JOINED, 'P'), []);
});

test('placeQuestion and placeOptions follow the login wording per kind', () => {
  const [repo, folder, outside] = parsePlaces(ROUTES, 'P');
  const workspaces = parseWorkspaces(ROUTES);
  assert.equal(placeQuestion(repo, 1, 3), '(1 of 3) Where should analytics for api go?');
  assert.equal(placeQuestion(folder, 2, 3), '(2 of 3) Where should analytics for ~/My (old) docs (and everything inside it) go?');
  assert.equal(placeQuestion(outside, 3, 3), '(3 of 3) Where should analytics for sessions outside a project folder go?');
  assert.deepEqual(placeOptions(repo, workspaces), [
    { label: 'Acme', description: 'Owner' },
    { label: 'Beta Team', description: 'Beezi workspace' },
    { label: "Don't track this repo", description: 'Not tracked: nothing from api is sent' },
  ]);
  assert.equal(placeOptions(folder, workspaces)[2].label, "Don't track this folder");
  assert.deepEqual(placeOptions(outside, workspaces)[2], {
    label: "Don't track these", description: 'Not tracked: nothing from sessions outside a project folder is sent',
  });
  assert.deepEqual(workspaceOptions(parseWorkspaces(JOINED))[1], { label: 'Beta Team', description: 'Member, new' });
});

test('a folder label with unbalanced parentheses is asked about by its path, never as null', () => {
  const [place] = parsePlaces('P1. notes :) (~/notes :)), 1 session account=k1 kind=folder match=/Users/dev/notes :)', 'P');
  const question = placeQuestion(place, 1, 1);
  assert.equal(question, '(1 of 1) Where should analytics for /Users/dev/notes :) (and everything inside it) go?');
  assert.doesNotMatch(question, /null/);
  assert.deepEqual(ruleArgv(place, 'k1', 't1'), ['rule', 'add', '--folder', '/Users/dev/notes :)', '--account', 'k1', 't1', '--defer-upload']);
});

test('tenantsArg joins picked tenants in pick order; Don\'t track alone is none, and a mix throws', () => {
  const workspaces = parseWorkspaces(ROUTES);
  assert.equal(tenantsArg([0, 1], workspaces), 't1,t2');
  assert.equal(tenantsArg([1, 0], workspaces), 't2,t1');
  assert.equal(tenantsArg([1], workspaces), 't2');
  assert.equal(tenantsArg([2], workspaces), 'none');
  assert.throws(() => tenantsArg([0, 2], workspaces), { message: "Don't track was combined with a workspace" });
});

test('ruleArgv builds argv without shell quoting', () => {
  const [repo, folder, outside] = parsePlaces(ROUTES, 'P');
  assert.deepEqual(ruleArgv(repo, 'k1', 't1'), ['rule', 'add', '--repo', 'github.com/acme/api', '--account', 'k1', 't1', '--defer-upload']);
  assert.deepEqual(ruleArgv(folder, 'k1', 'none'), ['rule', 'add', '--folder', '/Users/dev/My (old) docs', '--account', 'k1', 'none', '--defer-upload']);
  assert.deepEqual(ruleArgv(outside, 'k1', 't1,t2'), ['rule', 'add', '--outside', '--account', 'k1', 't1,t2', '--defer-upload']);
  const quoted = parsePlaces("P1. it's $HOME (~/it's $HOME), 1 session account=k1 kind=folder match=/Users/dev/it's $HOME", 'P')[0];
  assert.deepEqual(ruleArgv(quoted, 'k1', 't1'), ['rule', 'add', '--folder', "/Users/dev/it's $HOME", '--account', 'k1', 't1', '--defer-upload']);
});

test('report prints the first stdout line on success and the error lines on failure', () => {
  const ctx = fakeCtx({}, []);
  report(ctx, ok('\n✓ Rule added.\nmore\n'));
  report(ctx, { code: 1, stdout: '', stderr: '\n✗ No such workspace.\n' });
  report(ctx, { code: 1, stdout: '✗ refused\n', stderr: '' });
  assert.deepEqual(ctx.printed, ['✓ Rule added.', '✗ No such workspace.', '✗ refused']);
});

test('report never prints machine lines from stdout when a failing step has no stderr', () => {
  const machineOnly = fakeCtx({}, []);
  const machine = ROUTES.split('\n').filter((line) => /=/.test(line) && !/^dev@/.test(line)).join('\n');
  report(machineOnly, { code: 1, stdout: `${machine}\naccount=k1 email=dev@example.com\n{"ok":false,"status":"no_key"}\n`, stderr: '' });
  assert.deepEqual(machineOnly.printed, ['✗ That step stopped unexpectedly.']);

  const mixed = fakeCtx({}, []);
  report(mixed, { code: 1, stdout: 'routes=3\n✗ Could not read your rules.\nP1. api (github.com/acme/api), 4 sessions account=k1 kind=repo match=github.com/acme/api\nall-command=node x\n  [1, 2]\n', stderr: '' });
  assert.deepEqual(mixed.printed, ['✗ Could not read your rules.']);
});

const LISTING = 'new-folders --history --account k1';
const SETUP_QUESTION = 'Where should analytics from this machine go?';
const PER_REPO = { label: 'Let me choose per repo', description: 'Beezi asks about each repo and folder with history next, and new ones when a session starts there' };
const SEVERAL_OPTION = { label: 'Several workspaces…', description: 'Pick two or more; everything goes to each of them' };
const unset = (history) => ok(`${W_LINES.join('\n')}\n${history}new-folders=ask set=no multi=yes account=k1\n`);

test('askNewFolders asks only when set=no on a multi-workspace account', async () => {
  const settled = fakeCtx({ [LISTING]: ok(`${W_LINES.join('\n')}\nhistory=3 places=2\nnew-folders=ask set=yes multi=yes account=k1\n`) }, []);
  await askNewFolders(settled, 'k1');
  assert.equal(settled.asked.length, 0);
  assert.deepEqual(settled.runs, ['workspace.mjs new-folders --history --account k1']);

  const single = fakeCtx({ [LISTING]: ok('new-folders=n/a multi=no account=k1\n') }, []);
  await askNewFolders(single, 'k1');
  assert.equal(single.asked.length, 0);
});

test('askNewFolders asks one question: a workspace each, several, then per repo', async () => {
  const ctx = fakeCtx({ [LISTING]: unset('history=143 places=12\n') }, [1]);
  await askNewFolders(ctx, 'k1');
  assert.equal(ctx.asked[0].question, SETUP_QUESTION);
  const everything = 'Everything goes here: new repos and folders, and 12 with history (143 past sessions)';
  assert.deepEqual(ctx.asked[0].options, [
    { label: 'Acme', description: everything },
    { label: 'Beta Team', description: everything },
    SEVERAL_OPTION,
    PER_REPO,
  ]);
  assert.deepEqual(ctx.runs, ['workspace.mjs new-folders --history --account k1', 'workspace.mjs new-folders send t2 --account k1 --defer-upload']);
  assert.deepEqual(ctx.printed, ['✓ done']);

  const perRepo = fakeCtx({ [LISTING]: unset('history=143 places=12\n') }, [3]);
  await askNewFolders(perRepo, 'k1');
  assert.equal(perRepo.runs[1], 'workspace.mjs new-folders ask --account k1 --defer-upload');

  const first = fakeCtx({ [LISTING]: unset('') }, [0]);
  await askNewFolders(first, 'k1');
  assert.equal(first.runs[1], 'workspace.mjs new-folders send t1 --account k1 --defer-upload');

  const dismissed = fakeCtx({ [LISTING]: unset('history=143 places=12\n') }, [null]);
  await askNewFolders(dismissed, 'k1');
  assert.equal(dismissed.runs.length, 1);
  assert.deepEqual(dismissed.printed, []);
});

test('askNewFolders Several workspaces… asks which ones and sends everything to each, in pick order', async () => {
  const ctx = fakeCtx({ [LISTING]: unset('history=143 places=12\n') }, [2, [1, 0]]);
  await askNewFolders(ctx, 'k1');
  assert.deepEqual(ctx.asked[1], {
    kind: 'chooseMany', question: 'Which workspaces should get analytics from this machine?',
    options: [{ label: 'Acme', description: 'Owner' }, { label: 'Beta Team', description: 'Beezi workspace' }], opts: undefined,
  });
  assert.equal(ctx.runs[1], 'workspace.mjs new-folders send t2,t1 --account k1 --defer-upload');

  const one = fakeCtx({ [LISTING]: unset('') }, [2, [1]]);
  await askNewFolders(one, 'k1');
  assert.equal(one.runs[1], 'workspace.mjs new-folders send t2 --account k1 --defer-upload');

  for (const answer of [null, []]) {
    const dismissed = fakeCtx({ [LISTING]: unset('') }, [2, answer]);
    await askNewFolders(dismissed, 'k1');
    assert.equal(dismissed.runs.length, 1);
    assert.deepEqual(dismissed.printed, []);
  }
});

test('one question, one option per workspace, several, then per repo, with history in the descriptions', () => {
  const options = setupOptions([{ name: 'Acme', tenant: 'A' }, { name: 'Beta', tenant: 'B' }], { sessions: 37, places: 4 });
  assert.deepEqual(options.map((o) => o.label), ['Acme', 'Beta', 'Several workspaces…', 'Let me choose per repo']);
  assert.deepEqual(options[2], SEVERAL_OPTION);
  assert.equal(options[0].description, 'Everything goes here: new repos and folders, and 4 with history (37 past sessions)');
  assert.equal(setupOptions([{ name: 'Acme' }], { sessions: 1, places: 0 })[0].description, 'Everything goes here: new repos and folders, and 1 past session');
  assert.equal(setupOptions([{ name: 'Acme' }], null)[0].description, 'Everything goes here, starting with new repos and folders');
});

test('setupOptions words the history counts, singular and zero; a bad history line reads as zero', () => {
  const workspaces = parseWorkspaces(W_LINES.join('\n'));
  assert.equal(setupOptions(workspaces, { sessions: 1, places: 1 })[0].description,
    'Everything goes here: new repos and folders, and 1 with history (1 past session)');
  assert.equal(setupOptions(workspaces, { sessions: 0, places: 0 })[1].description, 'Everything goes here, starting with new repos and folders');
  assert.equal(setupOptions(workspaces, null)[0].description, 'Everything goes here, starting with new repos and folders');
  assert.equal(setupOptions(workspaces, { sessions: 4, places: 0 })[0].description, 'Everything goes here: new repos and folders, and 4 past sessions');
  assert.deepEqual(setupOptions(workspaces, null).at(-1), PER_REPO);
  assert.deepEqual(parseHistory('W. x\nhistory=143 places=12\nnew-folders=ask'), { sessions: 143, places: 12 });
  assert.equal(parseHistory('history=lots places=12'), null);
  assert.equal(parseHistory('history=3'), null);
  assert.equal(parseHistory('new-folders=ask'), null);
});

test('askNewFolders reports a failing listing and asks nothing', async () => {
  const ctx = fakeCtx({ [LISTING]: { code: 1, stdout: '', stderr: '✗ Not linked.\n' } }, []);
  await askNewFolders(ctx, 'k1');
  assert.deepEqual(ctx.printed, ['✗ Not linked.']);
  assert.equal(ctx.asked.length, 0);
});

test('reviewRoutes with 4 or fewer places asks per place and prints the no-folder line once', async () => {
  const ctx = fakeCtx({ 'routes --account k1': ok(ROUTES) }, [[0], [], [2]]);
  await reviewRoutes(ctx, 'k1');
  assert.deepEqual(ctx.asked.map((a) => a.question), [
    '(1 of 3) Where should analytics for api go?',
    '(2 of 3) Where should analytics for ~/My (old) docs (and everything inside it) go?',
    '(3 of 3) Where should analytics for sessions outside a project folder go?',
  ]);
  assert.deepEqual(ctx.runs, [
    'workspace.mjs routes --account k1',
    'workspace.mjs rule add --repo github.com/acme/api --account k1 t1 --defer-upload',
    'workspace.mjs rule add --outside --account k1 none --defer-upload',
  ]);
  assert.equal(ctx.printed[0], '2 other past sessions have no recorded folder and are not sent.');
});

test('askPerPlace passes Don\'t track as the exclusive choice', async () => {
  const ctx = fakeCtx({ 'routes --account k1': ok(ROUTES) }, [[0], [], [2]]);
  await reviewRoutes(ctx, 'k1');
  assert.deepEqual(ctx.asked.map((a) => a.opts), [{ exclusive: [2] }, { exclusive: [2] }, { exclusive: [2] }]);
});

test('reviewRoutes with routes=0 asks nothing', async () => {
  const ctx = fakeCtx({ 'routes --account k1': ok('routes=0\n') }, []);
  await reviewRoutes(ctx, 'k1');
  assert.equal(ctx.asked.length, 0);
  assert.equal(ctx.runs.length, 1);
});

function manyRoutes(n) {
  const lines = [...W_LINES];
  for (let i = 1; i <= n; i += 1) {
    lines.push(`P${i}. r${i} (github.com/acme/r${i}), 1 session account=k1 kind=repo match=github.com/acme/r${i}`);
  }
  lines.push(`routes=${n}`);
  return lines.join('\n');
}

test('reviewRoutes with more than 4 places offers send-all, per repo or skip', async () => {
  const all = fakeCtx({ 'routes --account k1': ok(manyRoutes(5)) }, [0, [0, 1]]);
  await reviewRoutes(all, 'k1');
  assert.equal(all.asked[0].question, 'Where should analytics for these 5 repos and folders go?');
  assert.deepEqual(all.asked[0].options.map((o) => o.label), ['Send all 5 to the same workspaces…', 'Choose per repo', 'Skip']);
  assert.equal(all.asked[1].question, 'Which workspaces should get analytics for these 5 repos and folders?');
  assert.equal(all.runs[1], 'workspace.mjs rule add-all --account k1 t1,t2 --defer-upload');

  const skip = fakeCtx({ 'routes --account k1': ok(manyRoutes(5)) }, [2]);
  await reviewRoutes(skip, 'k1');
  assert.equal(skip.runs.length, 1);

  const perRepo = fakeCtx({ 'routes --account k1': ok(manyRoutes(5)) }, [1, [0], [], [], [], [1]]);
  await reviewRoutes(perRepo, 'k1');
  assert.equal(perRepo.asked.length, 6);
  assert.deepEqual(perRepo.runs.slice(1), [
    'workspace.mjs rule add --repo github.com/acme/r1 --account k1 t1 --defer-upload',
    'workspace.mjs rule add --repo github.com/acme/r5 --account k1 t2 --defer-upload',
  ]);
});

test('reviewJoined asks repos per new tenant and runs joined pick per picked place', async () => {
  const ctx = fakeCtx({ 'joined --account k1': ok(JOINED) }, [[0, 1]]);
  await reviewJoined(ctx, 'k1');
  const picks = ctx.runs.filter((r) => /^workspace\.mjs joined pick /.test(r));
  assert.equal(picks.length, 2);
  assert.ok(picks.every((r) => / --defer-upload$/.test(r)));
  assert.match(ctx.asked[0].question, /repos and folders should also send analytics to Beta Team/i);
  assert.deepEqual(ctx.runs, [
    'workspace.mjs joined --account k1',
    'workspace.mjs joined pick --repo github.com/acme/api --account k1 t2 --defer-upload',
    'workspace.mjs joined pick --folder /Users/dev/My notes --account k1 t2 --defer-upload',
    'workspace.mjs joined done --account k1 --defer-upload',
  ]);
});

test('reviewJoined stops without recording the review when a repo screen is dismissed', async () => {
  const ctx = fakeCtx({ 'joined --account k1': ok(JOINED) }, [null]);
  await reviewJoined(ctx, 'k1');
  assert.equal(ctx.runs.indexOf('workspace.mjs joined done --account k1 --defer-upload'), -1);
});

test('reviewJoined records the review when a repo screen is a clean no-op', async () => {
  const ctx = fakeCtx({ 'joined --account k1': ok(JOINED) }, [[]]);
  await reviewJoined(ctx, 'k1');
  assert.deepEqual(ctx.runs, ['workspace.mjs joined --account k1', 'workspace.mjs joined done --account k1 --defer-upload']);
});

function manyJoined(n) {
  const lines = ['dev@example.com: you joined Beta Team — 5 repos or folders to review account=k1 new=t2',
    'W. Acme account=k1 tenant=t1 new=no role=Owner', 'W. Beta Team account=k1 tenant=t2 new=yes role=Member'];
  for (let i = 1; i <= n; i += 1) {
    lines.push(`J${i}. r${i} (github.com/acme/r${i}), 1 session, now: Acme account=k1 kind=repo match=github.com/acme/r${i} now=t1`);
  }
  lines.push(`joined=${n}`);
  return lines.join('\n');
}

test('reviewJoined with more than 4 places offers add-all, choose repos or leave', async () => {
  const add = fakeCtx({ 'joined --account k1': ok(manyJoined(5)) }, [0]);
  await reviewJoined(add, 'k1');
  assert.equal(add.asked[0].question, 'You joined Beta Team. Where should analytics for these 5 repos and folders go? Their past sessions will be sent there too.');
  assert.deepEqual(add.asked[0].options.map((o) => o.label), ['Add Beta Team to all 5', 'Choose repos', 'Leave them as they are']);
  assert.equal(add.runs[1], 'workspace.mjs joined add-all --account k1 --defer-upload');

  const leave = fakeCtx({ 'joined --account k1': ok(manyJoined(5)) }, [2]);
  await reviewJoined(leave, 'k1');
  assert.equal(leave.runs[1], 'workspace.mjs joined done --account k1 --defer-upload');

  const dismissed = fakeCtx({ 'joined --account k1': ok(manyJoined(5)) }, [null]);
  await reviewJoined(dismissed, 'k1');
  assert.equal(dismissed.runs.length, 1);
});

test('reviewJoined chunks more than 4 places into 4+1 screens for one tenant', async () => {
  const ctx = fakeCtx({ 'joined --account k1': ok(manyJoined(5)) }, [1, [0], [0]]);
  await reviewJoined(ctx, 'k1');
  const screens = ctx.asked.filter((a) => a.kind === 'chooseMany');
  assert.equal(screens.length, 2);
  assert.equal(screens[1].options.length, 1);
  assert.equal(ctx.runs[ctx.runs.length - 1], 'workspace.mjs joined done --account k1 --defer-upload');
});

function twoNewJoined() {
  return [
    'dev@example.com: you joined Acme and Beta — 2 repos or folders to review account=k1 new=t1,t2',
    'W. Acme account=k1 tenant=t1 new=yes role=Owner',
    'W. Beta account=k1 tenant=t2 new=yes role=Member',
    'J1. r1 (github.com/acme/r1), 1 session, now: no rule yet account=k1 kind=repo match=github.com/acme/r1 now=pending',
    'J2. r2 (github.com/acme/r2), 1 session, now: no rule yet account=k1 kind=repo match=github.com/acme/r2 now=pending',
    'joined=2',
  ].join('\n');
}

test('reviewJoined asks one repo picker per new tenant', async () => {
  const ctx = fakeCtx({ 'joined --account k1': ok(twoNewJoined()) }, [[0], [1]]);
  await reviewJoined(ctx, 'k1');
  const screens = ctx.asked.filter((a) => a.kind === 'chooseMany');
  assert.equal(screens.length, 2);
  assert.match(screens[0].question, /send analytics to Acme/);
  assert.match(screens[1].question, /send analytics to Beta/);
  assert.deepEqual(ctx.runs, [
    'workspace.mjs joined --account k1',
    'workspace.mjs joined pick --repo github.com/acme/r1 --account k1 t1 --defer-upload',
    'workspace.mjs joined pick --repo github.com/acme/r2 --account k1 t2 --defer-upload',
    'workspace.mjs joined done --account k1 --defer-upload',
  ]);
});

test('reviewJoined with joined=0 asks nothing', async () => {
  const ctx = fakeCtx({ 'joined --account k1': ok('joined=0\n') }, []);
  await reviewJoined(ctx, 'k1');
  assert.equal(ctx.asked.length, 0);
});
