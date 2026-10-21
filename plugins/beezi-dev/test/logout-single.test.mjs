import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withoutGuard } from '../tools/hermetic-env.mjs';
import { settledHome, linkWithoutCredential } from '../tools/spawn-fixtures.mjs';

// logout.mjs --single: the logout skill's one call. One linked account is logged out by the bare
// command's own branch; these cases need no credential store or network, so they spawn the script.

const LOGOUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'logout.mjs');
const KEY_A = 'a1b2c3d4';
const KEY_B = 'b2c3d4e5';

function logout(dir, args) {
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, BEEZI_CODEX_HOME: dir, CODEX_HOME: path.join(dir, '.codex') };
  delete env.NODE_TEST_CONTEXT;
  const res = withoutGuard(() => spawnSync(process.execPath, [LOGOUT, ...args], { cwd: dir, encoding: 'utf-8', timeout: 60_000, env }));
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

const keysIn = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf-8')).accounts.map((a) => a.key);

test('--single with several accounts linked logs nothing out and lists them under the refusal', (t) => {
  const dir = settledHome(t, 'beezi-logout-single-');
  linkWithoutCredential(dir, KEY_A);
  linkWithoutCredential(dir, KEY_B);
  const res = logout(dir, ['--single']);
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.trim().split('\n');
  assert.equal(lines[0], '✗ More than one account is linked — pick one.');
  assert.match(lines[1], /^Beezi: 2 accounts linked\./);
  assert.ok(lines.some((line) => line.startsWith('  1. ') && line.endsWith(`[${KEY_A}]  (default)`)), res.stdout);
  assert.ok(lines.some((line) => line.startsWith('  2. ') && line.endsWith(`[${KEY_B}]`)), res.stdout);
  assert.deepEqual(keysIn(dir), [KEY_A, KEY_B]);
});

test('--single with nothing linked says there is nothing to do', (t) => {
  const res = logout(settledHome(t, 'beezi-logout-single-'), ['--single']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, 'Beezi: this machine is not linked. Nothing to do.\n');
});

test('--single takes no other option', (t) => {
  const dir = settledHome(t, 'beezi-logout-single-');
  linkWithoutCredential(dir, KEY_A);
  for (const extra of [['--all'], ['--list'], ['--account', '1'], ['--next-default', '1']]) {
    const res = logout(dir, ['--single'].concat(extra));
    assert.equal(res.status, 1, extra.join(' '));
    assert.match(res.stderr, /--single logs out the only linked account, so it cannot be combined with another option\./);
  }
  assert.deepEqual(keysIn(dir), [KEY_A]);
});

test('an unknown option names --single among the options logout.mjs takes', (t) => {
  const res = logout(settledHome(t, 'beezi-logout-single-'), ['--bogus']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /logout\.mjs takes --list, --single, --account <account>, --next-default <account> and --all\./);
});

// The skill branches on --single's output, so the script must still print the line and the skill must still carry it.
test('the logout skill runs --single first and reads its ✗ line as "show the list and ask", not a stop', () => {
  const read = (...parts) => fs.readFileSync(path.join(path.dirname(LOGOUT), '..', ...parts), 'utf-8');
  const skill = read('skills', 'logout', 'SKILL.md').replace(/\s+/g, ' ');
  const line = '✗ More than one account is linked — pick one.';
  assert.ok(read('scripts', 'logout.mjs').includes(`console.log('${line}');`));
  const single = skill.indexOf('node "<plugin-root>/scripts/logout.mjs" --single');
  assert.ok(single !== -1, 'the skill runs --single');
  for (const other of ['logout.mjs" --account', 'logout.mjs" --all', 'logout.mjs" --list']) {
    assert.ok(skill.indexOf(other) > single, `${other} comes after --single`);
  }
  assert.ok(skill.includes(`\`${line}\``));
  assert.match(skill, /That `✗` line is not a failure to stop on: show the list and ask whether the user means \*\*one\*\* of them or \*\*all\*\* of them/);
  // "Reading the answer" stops on every other ✗ line, and names this one as the exception.
  assert.match(skill, /a `✗` line \(other than `--single`'s "More than one account is linked" above\)[^.]*relay it and stop/);
});
