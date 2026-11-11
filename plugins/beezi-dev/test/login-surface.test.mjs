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

test('login skill — one script runs the steps, and the beezi_login path starts it with the key', () => {
  const text = flat(skill);
  assert.match(skill, /^node "<plugin-root>\/scripts\/login-flow\.mjs"$/m);
  assert.match(skill, /^node "<plugin-root>\/scripts\/login-flow\.mjs" --account <key>$/m);
  assert.match(skill, /^node "<plugin-root>\/scripts\/login-flow\.mjs" --account <key> --from finish$/m);
  assert.ok(!text.includes('--from setup') && !text.includes('--from <step>'));
  // Every stop the script can print has a row in the skill's table, and the script still prints it.
  const flow = read('scripts', 'login-flow.mjs');
  for (const step of ['stop', 'track', 'done']) {
    assert.ok(flow.includes(`'${step}'`), `login-flow.mjs no longer prints next=${step}`);
    assert.match(skill, new RegExp(`^\\| \`${step}\` +\\|`, 'm'), `the skill has no row for next=${step}`);
  }
  for (const step of ['setup', 'here', 'tier', 'joined', 'routes', 'history', 'default']) {
    assert.doesNotMatch(skill, new RegExp(`^\\| \`${step}\` +\\|`, 'm'), `next=${step} is gone`);
  }
});

test('login skill — the tracking question uses the spec words, by the number of workspaces', () => {
  const text = flat(skill);
  for (const phrase of [
    '"What should it track?"',
    '"Everything" ("all <M>, and new ones as you open them"), "Let me choose" ("tick the repos and folders")',
    '"Let me choose" ("tick repos for each workspace")',
    '"Where should they go?"',
    '"Everything to <A>", "Everything to <B>", "Everything to both", "Let me choose"',
    '"Everything to <A>", "Everything to <B>", "Several workspaces…", "Let me choose"',
    '"Where should this machine\'s analytics go?"',
    '"Ask me for each repo"',
    '"Which repos and folders should Beezi track?"',
    '"Which repos and folders go to <name>?"',
    '"All of them" ("Every place in the list") and "None of them" ("Nothing in the list")',
    '"Which workspaces should get analytics from this machine: Acme (Owner), Beta (User), Gamma (User) — one or more?"',
  ]) {
    assert.ok(text.includes(phrase), phrase);
  }
  assert.ok(text.includes('First write the lines between `<checklist>` and `</checklist>` verbatim'));
  assert.ok(text.includes('run nothing, tell the user nothing was set up and to ask Beezi to sign in again to choose what this machine tracks, and stop'));
  assert.ok(text.includes('the ticked workspaces\' `tenant=` values joined by commas, or `none` when it is ticked nowhere'));
  assert.ok(text.includes('With one workspace, run it only for the places left out, with `none`.'));
  assert.ok(text.includes('a `T` line with `now=none` is not offered'));
  assert.ok(text.includes('After those, run the `chosen-command=` text EXACTLY ONCE.'));
  assert.ok(text.includes('With one workspace, drop the literal ` <tenants>` instead.'));
  assert.ok(text.includes('A command that prints a `✗` line, or fails, stops this login: run no later command, do not run `--from finish`'));
});

test('login skill — the listing lines it parses are the ones workspace.mjs setup prints', () => {
  const cli = read('lib', 'workspace-cli.mjs');
  for (const fragment of [
    'T${i + 1}. ${labeled(place)}, ${sessionsCount(place.sessions)} account=${row.key} kind=${place.kind} now=${now} match=${place.match}',
    'T${i + 1}-command=${script} rule add ${ruleTargetFlag(place, cx.platform)} --account ${row.key}${deferText(SETUP_FLAGS)} <tenants>',
    'everything-command=${script} setup everything --account ${row.key}${deferText(SETUP_FLAGS)} <tenants>',
    'chosen-command=${script} setup chosen --account ${row.key}${deferText(SETUP_FLAGS)}',
  ]) assert.ok(cli.includes(fragment), fragment);
  const text = flat(skill);
  assert.ok(text.includes('`T<i>. <short> (<label>), <k> sessions account=<key> kind=<…> now=<ids|none|default> match=<…>`'));
  assert.ok(text.includes('`setup=<M> sessions=<N> workspaces=<W> chosen=no`'));
});

test('login skill — the removed questions are gone: plan tier, this folder, joined, routes, past-sessions offers, default account', () => {
  const text = flat(skill);
  for (const gone of [
    'How does this machine pay for Codex',
    'billing-capture.mjs" --plan',
    'the repo you\'re in, go?',
    'workspace.mjs" new-folders',
    'J<i>-command=',
    'P<i>-command=',
    '` Reply upload or not now.`',
    'scripts/accounts.mjs" use <key>',
    'Make `<name>` (`<workspace>`) the account the analytics skill reads from?',
    '"Where should analytics from this machine go?"',
    '`O<i>. <label> — <description>`',
    'no new past sessions to offer',
  ]) assert.ok(!text.includes(gone), gone);
  assert.doesNotMatch(skill, /scripts\/backfill\.mjs|finalized/);
  assert.ok(read('lib', 'setup-wizard.mjs').includes("['--offer', '--past', '--account', key, '--consented']"));
});

test('login skill — the finish block is written verbatim', () => {
  assert.ok(flat(skill).includes('Write its lines verbatim, blank lines included, and add nothing of your own.'));
});
