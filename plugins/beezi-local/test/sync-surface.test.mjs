import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withoutGuard } from '../tools/hermetic-env.mjs';

// G-9-3: the repeatable sync surface. Two halves — the script's flag policy, which is the
// MECHANICAL enforcement of "sync is not a way around the one-time import", and the skill that
// drives it, whose two boundary paragraphs are the reason a model does not reach for sync the
// moment backfill refuses.

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const syncScript = path.join(pluginRoot, 'scripts', 'sync.mjs');
const skillFile = path.join(pluginRoot, 'skills', 'sync', 'SKILL.md');
const skill = fs.readFileSync(skillFile, 'utf-8');

// The flag refusals happen in parseSyncArgs, before runAudit and therefore before any token read,
// filesystem scan or request. The child still gets a sandbox home so a regression that moved the
// check later fails loudly here instead of reading the developer's machine.
function runSync(t, args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-syncsurf-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  env.HOME = home;
  env.USERPROFILE = home;
  env.BEEZI_CODEX_HOME = home;
  env.CODEX_HOME = path.join(home, '.codex');
  const res = withoutGuard(() => spawnSync(process.execPath, [syncScript, ...args], {
    cwd: pluginRoot, encoding: 'utf-8', timeout: 60_000, env,
  }));
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

test('sync — --since is refused with a reason, not silently honoured', (t) => {
  const res = runSync(t, ['--since', '2026-01-01']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /takes no --since/);
  // The reason matters: --since filters on when a session RAN, which excludes exactly the old
  // half-uploaded sessions the command exists to repair.
  assert.match(res.stderr, /uploads exactly what Beezi is missing/);
});

test('sync — --force is refused, and says there is no seal to force past', (t) => {
  const res = runSync(t, ['--force']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /takes no --force/);
  assert.match(res.stderr, /no one-time seal to force past/);
});

test('sync — a rejected flag is refused before anything is read or sent', (t) => {
  const res = runSync(t, ['--force']);
  // No progress line, no summary: the refusal is the entire run.
  assert.equal(res.stdout, '');
});

test('sync — --via is not accepted as a quiet alias for anything', (t) => {
  // --via is parsed but never read on Claude's sync path. It is not documented here, and passing
  // it must not be a way to smuggle a mode in.
  const res = runSync(t, ['--via', 'login', '--force']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /takes no --force/);
});

// ── the one-time import's surface must not misread a lock refusal ───────────────────────────

test('backfill — a busy run lock is never reported as "no past sessions found"', () => {
  const script = fs.readFileSync(path.join(pluginRoot, 'scripts', 'backfill.mjs'), 'utf-8');
  // Every lock outcome comes back with scanned === 0, so each one must be handled BEFORE the
  // scanned-zero summary or the login flow tells the user a false thing about their machine.
  const scannedZero = script.indexOf('result.scanned === 0');
  for (const branch of ["result.reason === 'run-in-progress'", "result.reason === 'lock-order'", 'BackfillHalt.LOCK_LOST']) {
    const at = script.indexOf(branch);
    assert.ok(at > -1, `scripts/backfill.mjs must handle ${branch}`);
    assert.ok(at < scannedZero, `${branch} must be handled before the scanned-zero summary`);
  }
  assert.match(script, /already running on this machine/);
});

// ── the skill ───────────────────────────────────────────────────────────────────────────────

test('skill — declares the frontmatter the plugin loader reads', () => {
  assert.match(skill, /^---\r?\nname: sync\r?\ndescription: /);
});

test('skill — runs exactly the one script, derived from its own location', () => {
  assert.match(skill, /<plugin-root>\/skills\/sync\/SKILL\.md/);
  assert.match(skill, /node "<plugin-root>\/scripts\/sync\.mjs"/);
  const commands = skill.match(/^node /gm) || [];
  assert.equal(commands.length, 1, 'the house pattern is exactly one command');
});

test('skill — carries the hard boundary against the one-time import', () => {
  assert.match(skill, /NOT the one-time import/);
  assert.match(skill, /does not consume, reopen, re-run or stand in for/);
  assert.match(skill, /decline/);
});

test('skill — carries the trust-gap framing and points at the cause, not just the symptom', () => {
  assert.match(skill, /trusts them in `\/hooks`/);
  assert.match(skill, /upgrade invalidates that\s+trust/);
  assert.match(skill, /analytics-hooks/);
});

test('skill — states the no-flags policy in the same terms the script enforces', () => {
  assert.match(skill, /takes no flags/i);
  assert.match(skill, /--since/);
  assert.match(skill, /--force/);
});

test('skill — "everything is already uploaded" is documented as a success, not a retry', () => {
  assert.match(skill, /everything is already uploaded/);
  assert.match(skill, /do not re-run hoping for a different answer/);
});

test('skill — the coverage-unknown notice is relayed, not treated as an error', () => {
  assert.match(skill, /could not reach Beezi to check what it already has/);
  assert.match(skill, /not an error and nothing was\s+lost or duplicated/);
});

test('sync — a deferred run never claims "everything is already uploaded"', () => {
  const script = fs.readFileSync(syncScript, 'utf-8');
  // The success phrase and the deferral count must be mutually exclusive branches: the skill
  // teaches the model that the phrase means "stop", so printing it over deferred history is the
  // one way this surface can tell a user to give up on work that is still recoverable.
  // The deferral branch is tested first, and the success phrase sits in the `else if` behind it,
  // so the two can never both print.
  assert.match(script, /if \(result\.sessionsImported === 0 && result\.deferred > 0\) \{/);
  assert.match(script, /\} else if \(result\.sessionsImported === 0\) \{[\s\S]{0,400}everything is already uploaded/);
  // And the success line's parenthetical must not mention deferred history at all.
  assert.doesNotMatch(script, /bits\.push\([^)]*deferred/);
});

test('skill — the deferred-gap outcome is documented as final, with no override to ask for', () => {
  assert.match(skill, /does not line up/);
  assert.match(skill, /there is no flag that overrides it/);
});

test('skill — every outcome the script can print is documented', () => {
  const script = fs.readFileSync(syncScript, 'utf-8');
  // Distinctive fragments of each user-visible line, paired with the phrase the skill must carry.
  const outcomes = [
    ['everything is already uploaded', /everything is already uploaded/],
    ['were left for a ', /were left for a later run/],
    ['could not reach Beezi to check', /could not reach Beezi to check/],
    ['does not line up', /does not line up/],
    ['was not re-checked', /sub-agent activity was not re-checked/],
    ['audit-only plan', /audit-only plan/],
    ['not linked', /not linked/],
    ['does not support history sync yet', /does not support history sync yet/],
    ['already-saved analytics have not reached Beezi', /already-saved analytics have not reached Beezi/],
  ];
  for (const [fragment, inSkill] of outcomes) {
    assert.ok(script.includes(fragment), `scripts/sync.mjs should still print "${fragment}"`);
    assert.match(skill, inSkill, `skills/sync/SKILL.md should explain "${fragment}"`);
  }
});

test('skill — track points at sync for history it cannot repair', () => {
  const track = fs.readFileSync(path.join(pluginRoot, 'skills', 'track', 'SKILL.md'), 'utf-8');
  assert.match(track, /the `sync` skill/);
  assert.match(track, /only ever saves \*\*the session it is run from\*\*/);
});
