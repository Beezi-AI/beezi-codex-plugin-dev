import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderList } from '../lib/accounts-cli.mjs';
import { CRASH_MODES } from '../lib/diagnostics.mjs';
import { keysLines } from '../lib/settings-cli.mjs';
import { parseListing, token } from '../lib/setup-routing.mjs';
import {
  ACCOUNT_LINE, PLAN_EXPIRED, crashModeOf, parseLinkedAccounts, planSettled, uploadPast,
} from '../lib/setup-wizard.mjs';
import { createProgressWriter } from '../lib/upload-progress.mjs';
import { linkAccount, makeHome } from '../tools/account-fixtures.mjs';

// The terminal setup branches on other scripts' output text. Each row is two-sided: the script still prints the fragment, and the setup still reads a line of that shape.

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => fs.readFileSync(path.join(pluginRoot, ...parts), 'utf-8');
const KEY = 'a1b2c3d4';

// [file that prints it, the fragment it must still print, a line of that shape, what the setup reads from it]
const LINES = [
  [['scripts', 'login.mjs'], 'account=${result.key}', `account=${KEY}`,
    (line) => ACCOUNT_LINE.exec(line)[1] === KEY],
  [['scripts', 'billing-capture.mjs'], "✓ Beezi billing captured: source=${config.source} plan=${orDefault(config.plan, 'n/a')}${capturedVia}.",
    '✓ Beezi billing captured: source=subscription plan=pro_5x via=app-server.',
    (line) => planSettled(line)],
  [['scripts', 'billing-capture.mjs'], 'your Codex sign-in expired on ${on}',
    'Beezi: your Codex sign-in expired on 2026-09-30, so its plan info is out of date — sign in to Codex again, or tell Beezi your plan.',
    (line) => PLAN_EXPIRED.test(line)],
  [['lib', 'settings-cli.mjs'], 'crash=${crashMode()}', 'crash=anonymous',
    (line) => crashModeOf(line) === 'anonymous'],
  [['lib', 'settings-cli.mjs'], "workspaces=${workspaceCount(a)} status=${a.status || 'linked'} email=${a.email || 'unknown'}",
    `account=${KEY} default=yes multi=no workspaces=1 status=linked email=ann@example.com`,
    (line) => token(line, 'workspaces') === '1' && token(line, 'email') === 'ann@example.com'],
  [['lib', 'workspace-cli.mjs'], 'W. ${t.name ? t.name : t.id} account=${row.key} tenant=${t.id} role=${roleLabel(t)}',
    `W. Acme Team account=${KEY} tenant=t1 role=Owner`,
    (line) => parseListing(line).workspaces[0].name === 'Acme Team' && parseListing(line).workspaces[0].tenant === 't1'],
  [['lib', 'workspace-cli.mjs'], 'T${i + 1}. ${labeled(place)}, ${sessionsCount(place.sessions)} account=${row.key} kind=${place.kind} now=${now} match=${place.match}',
    `T1. My docs (~/My docs), 2 sessions account=${KEY} kind=folder now=none match=/Users/dev/My docs`,
    (line) => JSON.stringify(parseListing(line).places[0]) === JSON.stringify({ kind: 'folder', match: '/Users/dev/My docs', now: 'none', name: '~/My docs', sessions: 2 })],
  [['lib', 'workspace-cli.mjs'], "setup=${found.places.length} sessions=${found.sessions} workspaces=${tenants.length} chosen=${chosen ? 'yes' : 'no'}",
    'setup=3 sessions=212 workspaces=2 chosen=yes',
    (line) => parseListing(line).workspaceCount === 2 && parseListing(line).chosen === true],
];

// Shapes setup-routing splits on whose reading its own tests already cover.
const SHAPES = [
  "return key.kind === 'outside' ? shortLabel(key) : `${shortLabel(key)} (${key.label})`;",
  "return `${n} session${n === 1 ? '' : 's'}`;",
  "'1 other past session has no recorded folder and is not sent.'",
  '`${lost} other past sessions have no recorded folder and are not sent.`',
  'cx.lines.push(`rule=${n}`);\n}',
  "cx.lines.push('setup=everything');\n}",
  "cx.lines.push('setup=chosen');\n}",
];

// The argv setup-routing builds, as workspace.mjs documents it.
const USAGE = [
  ' | rule add (--current | --repo <url> | --folder <path> | --outside) (<id|name|n>… | none) [--session <id>] [--account <ref>]',
];

// login.mjs lines the setup hides behind its own signed-in line and closing /hooks step (test/setup-wizard.test.mjs reads samples of each).
const LOGIN_REPLACED = [
  "console.log('\\nBeezi analytics — link this machine\\n');",
  'console.log(`\\n✓ already linked as ${who}. Nothing changed',
  'console.log(`\\n✓ Beezi analytics re-linked as ${who}. Credentials stored in ${result.storedIn}.`);',
  'console.log(`\\n✓ Beezi analytics linked as ${who}. Credentials stored in ${result.storedIn}.`);',
  "console.log('  The analytics skill still reads from this machine\\'s default account.');",
  "console.log('  Another Beezi process is updating the hook registry; it will be current in a moment.');",
  'console.log(`  Analytics hooks are installed. If nothing arrives, ${TRUST_STEP}.`);',
  "? '\\n  Analytics hooks installed for you.'",
  ': `\\n  Analytics hooks repaired for you (they were ${result.before}).`);',
  'console.log(`  One step left — ${TRUST_STEP}.`);',
];

test('every line the setup reads is still printed in that shape, and the setup still reads it', () => {
  for (const [file, fragment, sample, reads] of LINES) {
    assert.ok(read(...file).includes(fragment), `${file.join('/')} should still print "${fragment}"`);
    assert.ok(reads(sample), `the setup no longer reads "${sample}"`);
  }
});

test('the place shapes and summary lines setup-routing relies on are unchanged', () => {
  const cli = read('lib', 'workspace-cli.mjs');
  for (const fragment of SHAPES) assert.ok(cli.includes(fragment), fragment);
});

test('workspace.mjs still takes the rule argv the setup builds', () => {
  const cli = read('lib', 'workspace-cli.mjs');
  for (const usage of USAGE) assert.ok(cli.includes(usage), usage);
});

test('sync.mjs still takes the offer argv the setup builds', () => {
  const sync = read('scripts', 'sync.mjs');
  for (const fragment of ["const OFFER = '--offer';", "'--past'"]) assert.ok(sync.includes(fragment), fragment);
});

test('login.mjs still prints each line the setup hides from its sign-in', () => {
  const login = read('scripts', 'login.mjs');
  for (const fragment of LOGIN_REPLACED) assert.ok(login.includes(fragment), fragment);
});

test('every sign-in failure exits non-zero, so the setup needs no failure text of its own', () => {
  const login = read('scripts', 'login.mjs');
  assert.match(login, /if \(!cliMayProceed\(\)\) \{ process\.exitCode = 1; return; \}/);
  assert.match(login, /console\.error\(`\\n✗ \$\{friendlyMessage\(error\)\}`\);\r?\n {2}process\.exit\(1\);/);
});

test('hooks.mjs install still goes through ensureHooks and heads each outcome with ✓, ⚠ or the busy line', () => {
  const hooks = read('scripts', 'hooks.mjs');
  for (const fragment of [
    "if (action === 'install') return runInstall(force);",
    'const result = ensureHooks();',
    "console.log('✓ Beezi: analytics hooks are already installed and current — nothing to change.');",
    "console.log('✓ Beezi: analytics hooks updated to this plugin version.');",
    '? `✓ Beezi: analytics hooks installed in ${result.status.hooksFile}`',
    '`⚠ Beezi: ${status.broken.length} registered hook entr',
    'if (result.skipped) return reportBusy();',
    "console.log('Beezi: another Beezi process is updating the hook registry right now",
  ]) assert.ok(hooks.includes(fragment), fragment);
});

test('accounts.mjs list rows read back as the accounts the setup offers', async (t) => {
  const home = makeHome(t);
  linkAccount(home, 'a1b2c3d4', { name: 'Ann', email: 'ann@example.com', tenantName: 'Acme' });
  linkAccount(home, '99887766', { name: 'Bob', email: 'bob@example.com', tenantName: 'Beta - EU', status: 'revoked' });
  const offline = { run: () => { throw new Error('the list must not touch the credential store'); } };
  assert.deepEqual(parseLinkedAccounts(await renderList(offline)), [
    { description: 'Ann <ann@example.com> - Acme', key: 'a1b2c3d4', isDefault: true, revoked: false },
    { description: 'Bob <bob@example.com> - Beta - EU', key: '99887766', isDefault: false, revoked: true },
  ]);
});

test('settings.mjs keys still carries the crash= line the setup reads', async (t) => {
  const home = makeHome(t);
  linkAccount(home, 'a1b2c3d4');
  assert.equal(crashModeOf((await keysLines({})).join('\n')), CRASH_MODES.OFF);
});

test('sync.mjs --consented still ends with uploading= and tenants=, and the setup follows those workspaces in order', async (t) => {
  assert.ok(read('lib', 'history-cli.mjs').includes('console.log(`uploading=${sessions} workspaces=${owed.length} tenants=${owed.map((o) => o.tenantId).join(\',\')}`);'));
  makeHome(t);
  createProgressWriter({ key: KEY, tenantId: 't1', workspace: 'Acme' }).finish({ processed: 20, total: 20, sent: 20 });
  createProgressWriter({ key: KEY, tenantId: 't2', workspace: 'Side' }).finish({ processed: 17, total: 17, sent: 17 });
  const printed = [];
  await uploadPast({ run: async () => ({ code: 0, stdout: 'uploading=37 workspaces=2 tenants=t1,t2\n', stderr: '' }), print: (line) => printed.push(line) }, KEY);
  assert.deepEqual(printed, ['✓ 20 past sessions uploaded to Acme', '✓ 17 past sessions uploaded to Side']);
});
