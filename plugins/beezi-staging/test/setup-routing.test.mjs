import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastLine, parseListing, report, ruleArgv, token } from '../lib/setup-routing.mjs';

const LISTING = [
  '<checklist>',
  'Beezi found 9 past Codex sessions (3 Sep – 11 Nov, 2 folders)',
  '  in api, My (old) docs',
  '</checklist>',
  'W. Acme account=k1 tenant=t1 role=Owner',
  'W. Beta Team account=k1 tenant=t2 role=',
  'T1. api (github.com/acme/api), 4 sessions account=k1 kind=repo now=t1,t2 match=github.com/acme/api',
  "T1-command=node \"/p/scripts/workspace.mjs\" rule add --repo 'github.com/acme/api' --account k1 <tenants> --defer-upload",
  'T2. My (old) docs (~/My (old) docs), 1 session account=k1 kind=folder now=none match=/Users/dev/My (old) docs',
  "T2-command=node \"/p/scripts/workspace.mjs\" rule add --folder '/Users/dev/My (old) docs' --account k1 <tenants> --defer-upload",
  'T3. outside a project, 4 sessions account=k1 kind=outside now=default match=outside',
  'T3-command=node "/p/scripts/workspace.mjs" rule add --outside --account k1 <tenants> --defer-upload',
  'everything-command=node "/p/scripts/workspace.mjs" setup everything --account k1 --defer-upload <tenants>',
  'chosen-command=node "/p/scripts/workspace.mjs" setup chosen --account k1 --defer-upload',
  '2 other past sessions have no recorded folder and are not sent.',
  'setup=3 sessions=9 workspaces=2 chosen=no',
].join('\n');

const ok = (stdout) => ({ code: 0, stdout, stderr: '' });

function printer() {
  const printed = [];
  return { printed, print: (line) => printed.push(line) };
}

test('token reads space-free key=value fields; lastLine finds the last matching line', () => {
  const line = 'setup=3 sessions=9 workspaces=2 chosen=no';
  assert.equal(token(line, 'chosen'), 'no');
  assert.equal(token(line, 'setup'), '3');
  assert.equal(token(line, 'tenant'), null);
  assert.equal(lastLine('a=1\nx\naccount=k1\naccount=k2\n', /^account=/), 'account=k2');
  assert.equal(lastLine('x\r\ny\r\n', /^z/), null);
});

test('parseListing reads the checklist, workspaces, places with now=, the no-folder sentence and the last setup= line', () => {
  assert.deepEqual(parseListing(LISTING), {
    checklist: ['Beezi found 9 past Codex sessions (3 Sep – 11 Nov, 2 folders)', '  in api, My (old) docs'],
    workspaces: [{ name: 'Acme', tenant: 't1' }, { name: 'Beta Team', tenant: 't2' }],
    places: [
      { kind: 'repo', match: 'github.com/acme/api', now: 't1,t2', name: 'github.com/acme/api', sessions: 4 },
      { kind: 'folder', match: '/Users/dev/My (old) docs', now: 'none', name: '~/My (old) docs', sessions: 1 },
      { kind: 'outside', match: 'outside', now: 'default', name: 'outside a project', sessions: 4 },
    ],
    noFolder: '2 other past sessions have no recorded folder and are not sent.',
    workspaceCount: 2,
    chosen: false,
  });
});

test('parseListing with no checklist, no places and an unknown workspace list', () => {
  assert.deepEqual(parseListing('setup=0 sessions=0 workspaces=0 chosen=yes\n'), {
    checklist: [], workspaces: [], places: [], noFolder: null, workspaceCount: 0, chosen: true,
  });
  assert.equal(parseListing('').workspaceCount, 0);
});

test('match= runs to the end of the line, and kind and now are read only from before it', () => {
  const [place] = parseListing("T1. it's $HOME (~/it's $HOME now=t9), 1 session account=k1 kind=folder now=default match=/Users/dev/it's $HOME now=t9 kind=repo").places;
  assert.deepEqual(place, { kind: 'folder', match: "/Users/dev/it's $HOME now=t9 kind=repo", now: 'default', name: "~/it's $HOME now=t9", sessions: 1 });
});

test('ruleArgv builds argv without shell quoting, the defer flag last', () => {
  const [repo, folder, outside] = parseListing(LISTING).places;
  assert.deepEqual(ruleArgv(repo, 'k1', 't1'), ['rule', 'add', '--repo', 'github.com/acme/api', '--account', 'k1', 't1', '--defer-upload']);
  assert.deepEqual(ruleArgv(folder, 'k1', 'none'), ['rule', 'add', '--folder', '/Users/dev/My (old) docs', '--account', 'k1', 'none', '--defer-upload']);
  assert.deepEqual(ruleArgv(outside, 'k1', 't1,t2'), ['rule', 'add', '--outside', '--account', 'k1', 't1,t2', '--defer-upload']);
});

test('report prints the first stdout line on success and the error lines on failure', () => {
  const ctx = printer();
  report(ctx, ok('\n✓ Rule added.\nmore\n'));
  report(ctx, { code: 1, stdout: '', stderr: '\n✗ No such workspace.\n' });
  report(ctx, { code: 1, stdout: '✗ refused\n', stderr: '' });
  assert.deepEqual(ctx.printed, ['✓ Rule added.', '✗ No such workspace.', '✗ refused']);
});

test('report never prints machine lines from stdout when a failing step has no stderr', () => {
  const machineOnly = printer();
  const machine = [
    '<checklist>',
    '</checklist>',
    'W. Acme account=k1 tenant=t1 role=Owner',
    'T1. api (github.com/acme/api), 4 sessions account=k1 kind=repo now=t1 match=github.com/acme/api',
    'T1-command=node x',
    'setup=1 sessions=4 workspaces=1 chosen=no',
    '{"ok":false,"status":"no_key"}',
  ].join('\n');
  report(machineOnly, { code: 1, stdout: machine, stderr: '' });
  assert.deepEqual(machineOnly.printed, ['✗ That step stopped unexpectedly.']);

  const mixed = printer();
  report(mixed, { code: 1, stdout: 'setup=3\n✗ Could not read your rules.\nT1. api (github.com/acme/api), 4 sessions account=k1 kind=repo match=github.com/acme/api\nchosen-command=node x\n  [1, 2]\n</checklist>\n', stderr: '' });
  assert.deepEqual(mixed.printed, ['✗ Could not read your rules.']);
});
