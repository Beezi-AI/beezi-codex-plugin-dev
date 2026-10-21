import '../tools/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeHome, linkAccount, TEST_KEY } from '../tools/account-fixtures.mjs';
import { settingsLines } from '../lib/settings-cli.mjs';
import { initSessionWorkspace } from '../lib/workspace.mjs';
import { workspaceCommand } from '../lib/workspace-cli.mjs';

const TENANTS = [{ id: 'A', name: 'Acme' }, { id: 'B', name: 'Beta' }];
const EMAIL = 'user@example.com';
const blocks = (lines) => lines.filter((l) => /^<[a-z-]+[ >]/.test(l)).map((l) => l.replace(/ .*$|>$/g, '').slice(1));
const inside = (lines, open) => lines.slice(lines.indexOf(open) + 1, lines.indexOf(`</${open.slice(1).replace(/[ >].*$/, '')}>`, lines.indexOf(open)));

// A signed-in account without a network: health checks pass, nothing is written back, no hook registry is touched.
const deps = (over = {}) => ({
  cwd: '/work/client',
  linkStatus: async () => ({ accounts: [{ state: 'linked', who: { email: EMAIL } }] }),
  updateAccount: async () => {},
  ensureHooks: () => ({ repaired: false, launcherRefreshed: false }),
  ...over,
});

test('the menu view prints everything the next question needs in one call', async (t) => {
  linkAccount(makeHome(t), TEST_KEY, { email: EMAIL, tenants: TENANTS, newFolders: { mode: 'send', tenantIds: ['A'] } });
  const lines = await settingsLines('menu', deps());
  assert.deepEqual(blocks(lines), ['show', 'keys', 'labels', 'rules', 'here-card', 'new-folders']);
  assert.deepEqual(inside(lines, '<labels>'), ['Rules: here → Acme', 'New folders: send to Acme', `Account: ${EMAIL}`, 'Crash reports off']);
  assert.deepEqual(await settingsLines(undefined, deps()), lines, 'no argument is the menu');
});

test('the screen says where this folder goes before it counts rules', async (t) => {
  linkAccount(makeHome(t), TEST_KEY, { email: EMAIL, tenants: TENANTS, newFolders: { mode: 'send', tenantIds: ['A'] } });
  const lines = await settingsLines('menu', deps());
  assert.deepEqual(inside(lines, '<show>'), [
    `Beezi · ${EMAIL}`,
    '  This folder     client → Acme (default)',
    '  Rules           none yet',
    '  New folders     Send to Acme',
    '  Crash reports   Off',
  ]);
  const card = inside(lines, `<here-card account="${TEST_KEY}">`);
  assert.deepEqual(card, ["● You're here", '  client, a folder', '  /work/client', '', 'Now     → Acme (default)']);
});

test('the rules listing inside the menu is the one workspace.mjs prints for this folder', async (t) => {
  linkAccount(makeHome(t), TEST_KEY, { email: EMAIL, tenants: TENANTS, newFolders: { mode: 'send', tenantIds: ['A'] } });
  const listing = inside(await settingsLines('menu', deps()), `<rules account="${TEST_KEY}">`);
  assert.ok(listing.includes(`W. Acme account=${TEST_KEY} tenant=A role=`), listing.join('\n'));
  assert.equal(listing[listing.length - 1],
    `here: client (/work/client) → no rule now=A path=/work/client account=${TEST_KEY} rule=none kind=folder match=/work/client`);
  const newFolders = inside(await settingsLines('menu', deps()), `<new-folders account="${TEST_KEY}">`);
  assert.equal(newFolders[newFolders.length - 1], `new-folders=send set=yes multi=yes account=${TEST_KEY}`);
});

test('a one-workspace account gets three menu labels and a card saying what Don\'t track changes', async (t) => {
  linkAccount(makeHome(t), TEST_KEY, { email: EMAIL, tenants: [TENANTS[0]] });
  const lines = await settingsLines('menu', deps());
  assert.deepEqual(blocks(lines), ['show', 'keys', 'labels', 'rules', 'here-card']);
  assert.deepEqual(inside(lines, '<labels>'), ['Rules: here → Acme', `Account: ${EMAIL}`, 'Crash reports off']);
  assert.deepEqual(inside(lines, '<show>'), [`Beezi · ${EMAIL}`, '  This folder     client → Acme (default)', '  Crash reports   Off']);
  assert.deepEqual(inside(lines, `<here-card account="${TEST_KEY}">`).slice(4), [
    'Now     → Acme (default)', 'After   → not tracked (new rule)', '', 'The rule covers this folder and', 'everything inside it.',
  ]);
});

test('the rules view shows the table, leaving out the session it runs in', async (t) => {
  linkAccount(makeHome(t), TEST_KEY, { email: EMAIL, tenants: TENANTS, newFolders: { mode: 'send', tenantIds: ['A'] } });
  initSessionWorkspace('live-1', { cwd: '/work/client' });
  const old = Date.now() - 2 * 60 * 60 * 1000;
  const listAllRollouts = () => [
    { sessionId: 'live-1', cwd: '/work/client', mtimeMs: old, size: 10 },
    { sessionId: 'past-1', cwd: '/work/client', mtimeMs: old, size: 10 },
  ];
  const lines = await settingsLines('rules', deps({ listAllRollouts }));
  assert.deepEqual(blocks(lines), ['show', 'keys', 'rules', 'here-card']);
  const show = inside(lines, '<show>');
  assert.equal(show[0], "You're in **client**, a folder at /work/client.");
  assert.equal(show[show.length - 1], "| Default | new repos and folders | | Acme | 1 session | ← you're here |");
});

test('the rules view and workspace.mjs rules --table leave out the same live session', async (t) => {
  linkAccount(makeHome(t), TEST_KEY, { email: EMAIL, tenants: TENANTS, newFolders: { mode: 'send', tenantIds: ['A'] } });
  // The env id has no state file yet; an older session here does, and must not stand in for it.
  initSessionWorkspace('other-1', { cwd: '/work/client' });
  const old = Date.now() - 2 * 60 * 60 * 1000;
  const seams = {
    cwd: '/work/client',
    env: { CODEX_THREAD_ID: 'live-2' },
    listAllRollouts: () => [
      { sessionId: 'live-2', cwd: '/work/client', mtimeMs: old, size: 10 },
      { sessionId: 'past-2', cwd: '/work/client', mtimeMs: old, size: 10 },
    ],
  };
  const table = await workspaceCommand(['rules', '--table'], seams);
  assert.ok(table.ok, table.stderr.join('\n'));
  const show = inside(await settingsLines('rules', deps(seams)), '<show>');
  assert.deepEqual(show, table.lines);
  assert.equal(show[show.length - 1], "| Default | new repos and folders | | Acme | 1 session | ← you're here |");
});

test('the other views carry their own blocks only', async (t) => {
  linkAccount(makeHome(t), TEST_KEY, { email: EMAIL, tenants: TENANTS });
  assert.deepEqual(blocks(await settingsLines('new-folders', deps())), ['show', 'keys', 'new-folders']);
  assert.deepEqual(blocks(await settingsLines('account', deps())), ['show', 'keys']);
  assert.deepEqual(blocks(await settingsLines('privacy', deps())), ['show', 'keys']);
  assert.deepEqual(blocks(await settingsLines('all', deps())), ['show', 'keys']);
  await assert.rejects(settingsLines('previews', deps()), /Usage: settings\.mjs/);
});

test('keys stays exactly as the setup wizard parses it', async (t) => {
  linkAccount(makeHome(t), TEST_KEY, { email: EMAIL, tenants: TENANTS });
  const lines = await settingsLines('keys', {});
  assert.deepEqual(lines, [
    'menu=Rules|New folders|Account|Crash reports',
    `account=${TEST_KEY} default=yes multi=yes workspaces=2 status=linked email=${EMAIL}`,
    'crash=off',
  ]);
});

// ── the skill reads the views, two-sided ──────────────────────────────────────────────────────

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => fs.readFileSync(path.join(pluginRoot, ...parts), 'utf-8').replace(/\r\n/g, '\n');
const flat = (text) => text.replace(/\s+/g, ' ');

test('the settings skill reads each view once and shows its <show> block first', () => {
  const skill = flat(read('skills', 'settings', 'SKILL.md'));
  for (const view of ['all', 'rules', 'new-folders', 'account', 'privacy']) {
    assert.ok(skill.includes(`node "<plugin-root>/scripts/settings.mjs" ${view}\``), view);
  }
  for (const tag of ['<show>', '<keys>', '<labels>', '<rules account="<key>">', '<here-card account="<key>">', '<new-folders account="<key>">']) {
    assert.ok(skill.includes(tag), tag);
  }
  assert.ok(!skill.includes('<preview'), 'Codex options carry no previews (spec D5)');
  assert.match(skill, /never run a read again/);
});

test('the settings menu uses the tool only for 2-3 labels, else one numbered sentence', () => {
  const skill = flat(read('skills', 'settings', 'SKILL.md'));
  assert.match(skill, /`request_user_input` is listed this turn \*\*and\*\* there are at most 3 `<labels>` lines/);
  assert.match(skill, /Otherwise[^.]*one plain sentence with the `<labels>` lines as a numbered list/);
  assert.match(skill, /never a 4-option `request_user_input` call/);
  assert.match(skill, /What do you want to change: 1\. Rules: here → Acme, 2\. New folders: send to Acme, 3\. Account: ann@example\.com, or 4\. Crash reports off\?/);
});

test('the settings skill closes with "Close", shows the here card, and offers undo and the folder picker', () => {
  const raw = read('skills', 'settings', 'SKILL.md');
  const skill = flat(raw);
  assert.ok(!/"Done" — /.test(raw) && !raw.includes('"Done" stops.'), 'a menu option is labelled Close, never Done');
  assert.ok(skill.includes('"Close" stops.'));
  assert.match(skill, /write the account's `<here-card account="<key>">` block verbatim/);
  assert.ok(skill.includes('node "<plugin-root>/scripts/workspace.mjs" undo'));
  assert.ok(raw.includes('## Undo my last change'));
  // Nothing says whether an undo record exists, so undo is reached by asking, never offered as a choice.
  assert.ok(!raw.includes('- "Undo my last change"'), 'undo is not a Rules choice');
  assert.ok(skill.includes('node "<plugin-root>/scripts/workspace.mjs" places --account <key>'));
  assert.ok(skill.includes('"Stop tracking another folder"'));
  assert.match(skill, /`F<i>-command=` value with `<tenants>` replaced by/);
  // workspace-cli's confirmations end with the undo hint; the skill shows them whole.
  assert.ok(read('lib', 'workspace-cli.mjs').includes("const UNDO_HINT = ' Undo: ask the settings skill to undo.';"));
  assert.match(skill, /ends with " Undo: ask the settings skill to undo\."/);
});

test('the skills describe the here: line as workspace.mjs prints it', () => {
  const cli = read('lib', 'workspace-cli.mjs');
  assert.ok(cli.includes("now=${now.reason.kind === 'pending' ? 'pending' : idList(now.ids)}${where} account="));
  const shape = 'here: <short> (<label>) → <R<n> | no rule> now=<ids|none|pending> path=<path> account=<key> rule=<n|none> kind=<…> match=<…>';
  for (const name of ['settings', 'track']) {
    assert.ok(flat(read('skills', name, 'SKILL.md')).includes(shape), name);
  }
});

// Spec §4: "sent", never "uploaded", for what a Don't send / Don't track choice keeps back.
test('New folders\' Don\'t send says nothing is sent, in the view and the skill', async (t) => {
  linkAccount(makeHome(t), TEST_KEY, { email: EMAIL, tenants: TENANTS, newFolders: { mode: 'none', tenantIds: [] } });
  const show = inside(await settingsLines('new-folders', deps()), '<show>');
  assert.ok(show.some((l) => l.endsWith("Don't send — nothing from a repo or folder with no rule is sent")), show.join('\n'));
  const skill = flat(read('skills', 'settings', 'SKILL.md'));
  assert.ok(skill.includes('"Don\'t send" ("Nothing from a repo or folder with no rule is sent")'));
  assert.ok(!skill.includes('no rule is uploaded'));
  assert.ok(!read('lib', 'settings-cli.mjs').includes('no rule is uploaded'));
});
