import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The login surface's cross-file contract, in the shape test/sync-surface.test.mjs uses.
//
// skills/login/SKILL.md branches on step 1's OUTPUT TEXT and on nothing else: it reads the key off
// `account=<key>`, identifies each of the two
// sign-ins-still-with-the-human-in-the-browser by ITS sentence, and treats everything else as a
// failed sign-in.
// None of those sentences live in the skill — lib/login.mjs, scripts/login.mjs and
// lib/mcp-bridge.mjs produce them — so rewording one on either side silently re-labels a real
// outcome as a different one. A genuine refusal becomes a generic failure; a sign-in that is merely
// slow becomes one too, and the user is told to retry something that is still running.
//
// Two-sided on purpose: the source must still PRINT the fragment AND the skill must still carry the
// phrase it branches on. Either assertion alone passes happily while the contract is broken.

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => fs.readFileSync(path.join(pluginRoot, ...parts), 'utf-8');
const skill = read('skills', 'login', 'SKILL.md');

test('login skill — every step-1 outcome is printed by the surface and branched on by the skill', () => {
  // [what prints it, the distinctive fragment it must still print, the phrase the skill branches on]
  const outcomes = [
    [['scripts', 'login.mjs'], 'account=${result.key}', /`account=<key>`/],
    [['lib', 'mcp-bridge.mjs'], 'account=${result.key}', /`account=<key>`/],
    [['lib', 'mcp-bridge.mjs'], 'The sign-in is still running here', /The sign-in is still running here/],
    [['lib', 'mcp-bridge.mjs'], 'A Beezi sign-in is already in progress', /A Beezi sign-in is already in progress/],
    [['lib', 'mcp-bridge.mjs'], 'Beezi sign-in failed:', /Beezi sign-in failed/],
    [['scripts', 'login.mjs'], '✗ ${friendlyMessage(error)}', /✗/],
  ];
  for (const [file, fragment, inSkill] of outcomes) {
    assert.ok(
      read(...file).includes(fragment),
      `${file.join('/')} should still print "${fragment}" — the login skill branches on it`,
    );
    assert.match(skill, inSkill, `skills/login/SKILL.md should still branch on "${fragment}"`);
  }
});

// Shared membership no longer refuses a distinct account on either sign-in surface.
test('login — the same-tenant refusal is absent from both surfaces and the skill', () => {
  for (const file of [['lib', 'login.mjs'], ['scripts', 'login.mjs'], ['lib', 'mcp-bridge.mjs']]) {
    const source = read(...file);
    assert.doesNotMatch(source, /refusedSameTenantMessage|refused-same-tenant|is already linked as/,
      `${file.join('/')} must allow a second user of the same workspace`);
  }
  assert.doesNotMatch(skill, /refused-same-tenant|is already linked as/);
});

// The failure branch is defined as "no account= line and none of the other sentences", so a path
// that printed a key alongside one of them would be read as a success that also failed.
test('login — the MCP tool prints its key only on a completed sign-in', () => {
  const bridge = read('lib', 'mcp-bridge.mjs');
  const pending = bridge.indexOf('The sign-in is still running here');
  const failed = bridge.indexOf('Beezi sign-in failed:');
  const key = bridge.indexOf('account=${result.key}');
  assert.ok(pending > -1 && failed > -1 && key > -1);
  assert.ok(key > pending && key > failed, 'the key is composed after both keyless exits have returned');
  assert.match(bridge, /const key = result\.key \? `\\naccount=\$\{result\.key\}` : '';/);
});

const flat = (text) => text.replace(/\s+/g, ' ');

test('login skill — one script runs the steps, and the beezi_login path resumes it at setup', () => {
  const text = flat(skill);
  assert.match(skill, /^node "<plugin-root>\/scripts\/login-flow\.mjs"$/m);
  assert.ok(text.includes('node "<plugin-root>/scripts/login-flow.mjs" --account <key> --from setup'));
  assert.ok(text.includes('node "<plugin-root>/scripts/login-flow.mjs" --account <key> --from <step>'));
  // Every stop the script can print has a row in the skill's table, and the script still prints it.
  const flow = read('scripts', 'login-flow.mjs');
  for (const step of ['stop', 'setup', 'here', 'tier', 'joined', 'routes', 'backfill']) {
    assert.ok(flow.includes(`'${step}'`), `login-flow.mjs no longer prints next=${step}`);
    assert.match(skill, new RegExp(`^\\| \`${step}\` +\\|`, 'm'), `the skill has no row for next=${step}`);
  }
  assert.ok(!text.includes('workspace.mjs" new-folders --account <key>'), 'the New folders listing is the script\'s now');
});

test('login skill — the one setup question uses the tool for at most 2 workspaces without "Several workspaces…", else one numbered sentence', () => {
  const text = flat(skill);
  assert.ok(text.includes('"Where should analytics from this machine go?"'));
  assert.ok(!text.includes('<preview'), 'Codex options carry no previews (spec D5)');
  assert.match(text, /`O<i>\. <label> — <description>`/);
  assert.match(text, /\*\*`request_user_input`\*\* only when that tool is listed this turn \*\*and\*\* there are at most 2 `W\.` lines \(3 choices\)/);
  assert.match(text, /split at the last ` — ` into the label and the description/);
  assert.match(text, /3 or more `W\.` lines — one plain sentence with the `O` lines as a numbered list, never a 4-option `request_user_input` call/);
  assert.ok(text.includes('node "<plugin-root>/scripts/workspace.mjs" new-folders send <tenants> --account <key> --defer-upload'));
  assert.ok(!text.includes('new-folders send <tenant> '));
  assert.ok(text.includes('one choice per `O` line in order except the "Several workspaces…" line'));
  assert.ok(text.includes('"Where should analytics from this machine go? Pick one, or name several under Other."'));
  assert.ok(text.includes('"Which workspaces should get analytics from this machine: Acme (Owner), Beta (User), Gamma (User) — one or more?"'));
  assert.ok(text.includes('node "<plugin-root>/scripts/workspace.mjs" new-folders ask --account <key> --defer-upload'));
  assert.ok(!text.includes('"Ask me (recommended)"'), 'the old three-way New folders question is gone');
  assert.ok(text.includes('Every `O` line is numbered, "Several workspaces…" included.'));
  assert.ok(text.includes('Two or more numbers that include the "Several workspaces…" or the "Let me choose per repo" number are a dismissal'));
  assert.ok(text.includes('and "both" or "all" is every `W.` line; one that names none, or names a workspace together with "per repo", is a dismissal.'));
  assert.ok(text.includes('and so is an answer that names a workspace together with "per repo"'));
});

test('login skill — describes the here: line as workspace.mjs prints it', () => {
  assert.ok(read('lib', 'workspace-cli.mjs').includes("now=${now.reason.kind === 'pending' ? 'pending' : idList(now.ids)}${where} account="));
  assert.ok(flat(skill).includes('here: <short> (<label>) → <R<n> | no rule> now=<ids|none|pending> path=<path> account=<key> rule=<n|none> kind=<…> match=<…>'));
});

// Spec §4: this session's own folder is asked about as the one you're in, and Don't track says nothing is sent.
test('login — the here question names the folder you\'re in, and the last choice sends nothing', () => {
  const flat = skill.replace(/\s+/g, ' ');
  for (const phrase of [
    '"Where should analytics for <short>, the repo you\'re in, go?"',
    '"Where should analytics for <label>, the folder you\'re in (and everything inside it), go?"',
    '"Where should analytics for sessions outside a project folder go?"',
    '"Don\'t track <short>"',
    '"Don\'t track these"',
    '"Not tracked: nothing from <short> is sent"',
    '"Not tracked: nothing from sessions outside a project folder is sent"',
  ]) {
    assert.ok(flat.includes(phrase), phrase);
  }
  assert.ok(!flat.includes('without the "(i of N) " prefix'), 'the here question has its own wording, not step 4a\'s');
  assert.ok(!flat.includes('Nothing from <short> is uploaded'));
  assert.ok(!flat.includes('outside a project folder is uploaded'));
});
