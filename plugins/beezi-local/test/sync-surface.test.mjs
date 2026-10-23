import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withoutGuard } from '../tools/hermetic-env.mjs';
import { runAudit } from '../lib/session-audit.mjs';
import { BackfillHalt, isKeyMissing, KEY_MISSING_MESSAGE } from '../lib/audit-flush.mjs';
import { makeHome, accountSession } from '../tools/account-fixtures.mjs';
import { CHANGED_LINE } from '../lib/history-offer.mjs';
import { WRITER_BUSY_LINE, ACCEPT_BUSY_LINE, PENDING_UNREADABLE_TEXT } from '../lib/history-cli.mjs';

// G-9-3: the repeatable sync surface: the script's flag policy and the skill that drives it.

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const syncScript = path.join(pluginRoot, 'scripts', 'sync.mjs');
// The run printer and the offer, accept and decline commands sync.mjs dispatches to.
const historyCli = path.join(pluginRoot, 'lib', 'history-cli.mjs');
const skillFile = path.join(pluginRoot, 'skills', 'sync', 'SKILL.md');
const skill = fs.readFileSync(skillFile, 'utf-8');

// The flag refusals happen in parseSyncArgs, before runAudit and therefore before any token read,
// filesystem scan or request. The child still gets a sandbox home so a regression that moved the
// check later fails loudly here instead of reading the developer's machine.
function runScript(t, script, args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-syncsurf-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  env.HOME = home;
  env.USERPROFILE = home;
  env.BEEZI_CODEX_HOME = home;
  env.CODEX_HOME = path.join(home, '.codex');
  const res = withoutGuard(() => spawnSync(process.execPath, [script, ...args], {
    cwd: pluginRoot, encoding: 'utf-8', timeout: 60_000, env,
  }));
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

const runSync = (t, args) => runScript(t, syncScript, args);

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

test('sync — --accept without the question\'s --token uploads nothing and says the sessions changed', (t) => {
  const res = runSync(t, ['--accept', '--account', 'a1b2c3d4', '--tenant', 't1']);
  assert.equal(res.status, 1);
  assert.ok(res.stderr.includes(CHANGED_LINE), res.stderr);
  assert.equal(res.stdout, '');
});

test('sync — --dry-run with an answer, or --background or --token without --accept, is refused naming the pair', (t) => {
  for (const [args, message] of [
    [['--dry-run', '--accept'], /--dry-run previews the offer only; it does not go with --accept\./],
    [['--dry-run', '--decline'], /--dry-run previews the offer only; it does not go with --decline\./],
    [['--background', '--decline'], /--background goes only with --accept, not with --decline\./],
    [['--background'], /--background goes only with --accept, not with --offer\./],
    [['--decline', '--token', 'abc'], /--token goes only with --accept, not with --decline\./],
    [['--offer', '--token', 'abc'], /--token goes only with --accept, not with --offer\./],
  ]) {
    const res = runSync(t, args);
    assert.equal(res.status, 1, args.join(' '));
    assert.match(res.stderr, message, args.join(' '));
    assert.equal(res.stdout, '', args.join(' '));
  }
});

// ── the one-time import script is gone ───────────────────────────────────────────────────────

test('backfill — scripts/backfill.mjs no longer exists', () => {
  assert.equal(fs.existsSync(path.join(pluginRoot, 'scripts', 'backfill.mjs')), false);
});

// ── an anonymized workspace with no key is named, never summarised as an empty upload ─────────

test('isKeyMissing reads the stop from the check-in reason and from the upload halt', () => {
  assert.equal(isKeyMissing({ reason: BackfillHalt.ANONYMIZATION_KEY_MISSING, halt: null }), true);
  assert.equal(isKeyMissing({ reason: null, halt: BackfillHalt.ANONYMIZATION_KEY_MISSING }), true);
  assert.equal(isKeyMissing({ reason: null, halt: null }), false);
  assert.equal(isKeyMissing({ reason: 'no-token', halt: BackfillHalt.FORBIDDEN }), false);
});

test('the missing-key line sends the user to sign in again, then to their admin', () => {
  assert.equal(
    KEY_MISSING_MESSAGE,
    'Beezi: this workspace is anonymized but this machine has no key yet. '
      + 'Sign in to Beezi again (login skill); if this repeats, contact your workspace admin.',
  );
});

test('sync — a missing key gets its own line before the coverage and upload summaries', () => {
  const script = fs.readFileSync(historyCli, 'utf-8');
  const at = script.indexOf('if (isKeyMissing(result)) {\n    return refusal(KEY_MISSING_MESSAGE);\n  }');
  assert.ok(at > -1);
  assert.ok(at < script.indexOf('result.coverageKnown === false'));
  assert.ok(at < script.indexOf('result.scanned === 0'));
});

test('login — the past-sessions answers pass the --account and --tenant sync requires', () => {
  const skill = fs.readFileSync(path.join(pluginRoot, 'skills', 'login', 'SKILL.md'), 'utf-8');
  assert.match(skill, /scripts\/sync\.mjs" --accept --account <key> --tenant <id> --token <token>/);
  assert.match(skill, /scripts\/sync\.mjs" --decline --account <key> --tenant <id>/);
  assert.match(skill, /`offer account=<key> tenant=<id> sessions=<n> audit=<yes\|no> token=<token>`/);
});

// THE ASSERTION ABOVE IS NOT ENOUGH, and shipping it as if it were is how this broke: it greps for
// the step-4 command string, while the `beezi_login`-tool outcome that told the model to run the
// remaining steps without the flag sits ~118 lines ABOVE it. On the path a Codex model actually
// takes, step 4 would have refused outright.
//
// WHAT THIS TEST IS, EXACTLY — because overclaiming is what produced that defect:
//   · a real STRUCTURAL property: every line invoking the script carries the flag. Complete.
//   · an ENUMERATED phrasing guard for prose that tells a path to skip it. Prose cannot be pinned
//     completely; this covers without/skip/omit/drop/leave off/leave out/no within 20 characters of
//     the flag. It is a family, not a proof.
//   · the positive: the keyless branch names where a key comes from.
//
// TWO KNOWN IMPRECISIONS, both stated rather than engineered away:
//   · The window was 40 and is now 20, which stops `Never drop a step; always run step 4 with
//     \`--account <key>\`` — prose INSISTING on the flag — failing the test. Every ENUMERATED
//     phrasing that should be caught still is; only the gap between verb and flag narrowed.
//   · A verb sitting right next to the flag in insisting prose (`Never drop the \`--account\`
//     flag.`) still matches. Separating that from a real instruction needs negative lookbehind for
//     never/always/must/don't, which is more pattern than this is worth: the failure is loud, in
//     the safe direction, and a one-word edit clears it.
const SKIPS_ACCOUNT_FLAG = /(without|skip|omit|drop|leave off|leave out|no)\b[^.\n]{0,20}`?--account/i;

test('login — every sync invocation carries --account, and no enumerated phrasing tells a path to skip it', () => {
  const skill = fs.readFileSync(path.join(pluginRoot, 'skills', 'login', 'SKILL.md'), 'utf-8');

  const invocations = skill.split('\n').filter((line) => line.includes('scripts/sync.mjs"'));
  assert.ok(invocations.length > 0, 'the skill still answers the past-sessions question');
  for (const line of invocations) {
    assert.match(line, /--account/, `sync is invoked without --account: ${line}`);
  }

  const skipped = skill.match(SKIPS_ACCOUNT_FLAG);
  assert.equal(
    skipped, null,
    `the skill tells a path to run without --account, where sync's answers refuse: ${skipped && skipped[0]}`,
  );

  assert.match(skill, /get a key before continuing/);
  assert.match(skill, /node "<plugin-root>\/scripts\/accounts\.mjs" list/);
});

// ── the skill ───────────────────────────────────────────────────────────────────────────────

test('skill — declares the frontmatter the plugin loader reads', () => {
  assert.match(skill, /^---\r?\nname: sync\r?\ndescription: /);
});

test('skill — routes history before syncing, with scripts derived from its own location', () => {
  assert.match(skill, /<plugin-root>\/skills\/sync\/SKILL\.md/);
  assert.match(skill, /node "<plugin-root>\/scripts\/sync\.mjs"/);
  const commands = skill.match(/^node .+$/gm) || [];
  assert.deepEqual(commands, [
    'node "<plugin-root>/scripts/sync.mjs" --review',
    'node "<plugin-root>/scripts/sync.mjs" --review-routes',
    'node "<plugin-root>/scripts/sync.mjs"',
  ], 'joined workspaces and pending routes are resolved before the history upload, which carries their history');
  // One call when nothing needs an answer: the skill reads the sync's output after review=0 and runs nothing more.
  assert.match(skill, /`review=<n>`/);
  assert.match(skill, /On `review=0` it goes straight on to the sync/);
  assert.match(skill, /its output is everything after\s+that `review=0` line\. Do not run it again\./);
  assert.match(skill, /Run nothing for them after `joined=0`/);
  assert.match(skill, /counts as nothing to ask/);
  assert.match(skill, /J<i>-command=/);
  assert.match(skill, /done-command=/);
  assert.match(skill, /P<i>-command=/);
  assert.match(skill, /all-command=/);
  assert.match(skill, /global across accounts/);
});

// REWRITTEN. This used to assert the skill said "takes no flags" and named --since and --force as
// the two it refuses. The script now takes `--account`, so the old assertion pinned a sentence that
// had become false: a skill saying the command takes none would have the model drop the one flag
// the login flow and the user both need. The two refusals themselves are unchanged and still
// pinned — above, against the script, and here against the skill.
test('skill — states the flag policy in the same terms the script enforces', () => {
  assert.match(skill, /--account <account>/);
  assert.match(skill, /--tenant <workspace>/);
  assert.match(skill, /only when the user asks/);
  assert.match(skill, /takes no other flags/i);
  assert.match(skill, /`--review` or `--review-routes`/);
  assert.match(skill, /--since/);
  assert.match(skill, /--force/);
  assert.doesNotMatch(skill, /takes no flags/i, 'it takes --account — saying otherwise hides it');
});

test('skill — documents the per-account fan-out the script prints headings for', () => {
  const script = fs.readFileSync(historyCli, 'utf-8');
  assert.ok(script.includes('── Account: '), 'lib/history-cli.mjs should still print the heading');
  assert.match(skill, /── Account: /, 'skills/sync/SKILL.md should explain the heading');
  assert.match(skill, /every linked\s+account in turn/);
});

// ── a scoped run's 'no-token' is about the ACCOUNT, never the machine ────────────────────────
//
// REACHABILITY FIRST, because this branch had no behavioural test at all and the false sentence it
// used to print survived a full green suite. auditSession returns null whenever the key names no
// entry in linkedSessions() — an account that is in the index and cannot produce a token right now
// — and runAudit reports that as 'no-token', the same code an unlinked machine gets.
test('a run scoped to an account that cannot produce a token answers no-token', async (t) => {
  makeHome(t);
  const result = await runAudit(
    { linkedSessions: async () => [accountSession('99887766', 'tok-b')] },
    { key: 'a1b2c3d4' },
  );
  assert.equal(result.reason, 'no-token');
  assert.equal(result.scanned, 0, 'nothing was read — the account was the whole problem');
});

test('sync words that as the account’s problem, from one definition', () => {
  const sync = fs.readFileSync(historyCli, 'utf-8');
  // One definition: a second spelling leaves the skill relaying a sentence sync
  // no longer prints — the same rule test/account-surfaces.test.mjs case 15 enforces.
  assert.match(
    fs.readFileSync(path.join(pluginRoot, 'lib', 'session-audit.mjs'), 'utf-8'),
    /export const ACCOUNT_TOKEN_UNUSABLE/,
  );
  assert.match(sync, /ACCOUNT_TOKEN_UNUSABLE/, 'lib/history-cli.mjs should import the one definition');
  // sync keeps it for the UNSCOPED run, which is the only one where it is still true.
  assert.match(sync, /key === null\s*\n?\s*\? 'Beezi: this machine is not linked/);
  assert.match(skill, /could not use the saved credentials for that account/);
  assert.match(skill, /Do not report it as the machine being unlinked/);
});

test('skill — running sync is not a yes: uploads follow only an Upload answer to a shown question', () => {
  assert.match(skill, /## Running sync is not a yes/);
  assert.match(skill, /go up only after the user\s+answers Upload to a question this skill showed/);
  assert.match(skill, /Never\s+run `--accept` for a question the user did not answer with Upload/);
  assert.doesNotMatch(skill, /one-time import/);
});

test('README — names no one-time import and no hostname in the OAuth client name', () => {
  const readme = fs.readFileSync(path.join(pluginRoot, 'README.md'), 'utf-8');
  assert.doesNotMatch(readme, /one-time import/);
  assert.ok(!readme.includes('<hostname>'));
  assert.ok(fs.readFileSync(path.join(pluginRoot, 'lib', 'oauth.mjs'), 'utf-8').includes("client_name: 'Beezi Codex plugin',"));
});

test('skill — explains the changed-offer, busy-writer and tracking-off outcomes the script prints', () => {
  const script = fs.readFileSync(historyCli, 'utf-8');
  const flat = skill.replace(/\s+/g, ' ');
  assert.ok(CHANGED_LINE.includes('these past sessions changed after the question was shown, so nothing was uploaded'));
  assert.ok(flat.includes('these past sessions changed after the question was shown, so nothing was uploaded'));
  assert.ok(flat.includes('Never retry `--accept` with that token or any other.'));
  assert.ok(WRITER_BUSY_LINE.includes('Codex is still saving analytics on this machine, so nothing was listed this time'));
  assert.ok(flat.includes('Codex is still saving analytics on this machine, so nothing was listed this time'));
  for (const [line, fragment] of [
    [PENDING_UNREADABLE_TEXT, 'could not read Codex’s pending analytics on this machine'],
    [ACCEPT_BUSY_LINE, 'your yes is saved, but this machine is busy, so nothing was uploaded yet'],
  ]) {
    assert.ok(line.includes(fragment), fragment);
    assert.ok(flat.includes(fragment), fragment);
  }
  assert.ok(script.includes("'Beezi: this workspace does not accept history uploads on demand.'"));
  assert.ok(flat.includes('this workspace does not accept history uploads on demand'));
});

test('skill — carries the trust-gap framing and points at the cause, not just the symptom', () => {
  assert.match(skill, /trusts them in `\/hooks`/);
  assert.match(skill, /Trust survives a plugin upgrade/);
  assert.match(skill, /analytics-hooks/);
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
  const script = fs.readFileSync(historyCli, 'utf-8');
  // The success phrase and the deferral count must be mutually exclusive branches: the skill
  // teaches the model that the phrase means "stop", so printing it over deferred history is the
  // one way this surface can tell a user to give up on work that is still recoverable.
  // The deferral branch is tested first, and the success phrase sits in the `else if` behind it,
  // so the two can never both print.
  assert.match(script, /if \(result\.sessionsImported === 0 && result\.deferred > 0\) \{/);
  assert.match(script, /\} else if \(result\.sessionsImported === 0\) \{\n\s*console\.log\(nothingLeftLine\(result\)\);/);
  assert.match(script, /function nothingLeftLine\(result\) \{[\s\S]{0,200}everything is already uploaded/);
  // And the success line's parenthetical must not mention deferred history at all.
  assert.doesNotMatch(script, /bits\.push\([^)]*deferred/);
});

test('skill — the deferred-gap outcome is documented as final, with no override to ask for', () => {
  assert.match(skill, /does not prove a safe resume point/);
  assert.match(skill, /there is no flag that overrides it/);
});

test('skill — every outcome the script can print is documented', () => {
  const script = fs.readFileSync(historyCli, 'utf-8');
  // Distinctive fragments of each user-visible line, paired with the phrase the skill must carry.
  const outcomes = [
    ['everything is already uploaded', /everything is already uploaded/],
    ['were left for a ', /were left for a later run/],
    ['could not reach Beezi to check', /could not reach Beezi to check/],
    ['does not line up', /does not line up/],
    ['does not prove a safe resume point', /does not prove a safe resume point/],
    ['left alone: live tracking is still delivering', /sub-agents left alone/],
    ['not linked', /not linked/],
    ['does not support history sync yet', /does not support history sync yet/],
    ['already-saved analytics have not reached Beezi', /already-saved analytics have not reached Beezi/],
  ];
  for (const [fragment, inSkill] of outcomes) {
    assert.ok(script.includes(fragment), `lib/history-cli.mjs should still print "${fragment}"`);
    assert.match(skill, inSkill, `skills/sync/SKILL.md should explain "${fragment}"`);
  }
});

test('sync never asks for liveOnly, so audit workspaces are offered their history too', () => {
  for (const file of [syncScript, historyCli]) {
    const script = fs.readFileSync(file, 'utf-8');
    assert.ok(!script.includes('liveOnly'), 'sync uploads to audit workspaces too');
    assert.ok(!script.includes("'audit-only'"), 'sync never receives the audit-only refusal');
  }
});

test('skill — track points at sync for history it cannot repair', () => {
  const track = fs.readFileSync(path.join(pluginRoot, 'skills', 'track', 'SKILL.md'), 'utf-8');
  assert.match(track, /the `sync` skill/);
  assert.match(track, /only ever saves \*\*the session it is run from\*\*/);
});

// Spec §4: the last choice of a place's workspace question says nothing is sent, never "uploaded".
test('skill — a place\'s Don\'t track choice is described as nothing sent', () => {
  const flat = skill.replace(/\s+/g, ' ');
  assert.ok(flat.includes('"Not tracked: nothing from <short> is sent"'));
  assert.ok(flat.includes('"Not tracked: nothing from sessions outside a project folder is sent"'));
  assert.ok(!flat.includes('Nothing from <short> is uploaded'));
  assert.ok(!flat.includes('outside a project folder is uploaded'));
});

test('skill — step 2 shows the summary and asks each Q line under both choices; running it is not a yes', () => {
  const flat = skill.replace(/\s+/g, ' ');
  assert.ok(flat.includes('node "<plugin-root>/scripts/sync.mjs" --accept --account <key> --tenant <id> --token <token>'));
  assert.ok(flat.includes('node "<plugin-root>/scripts/sync.mjs" --decline --account <key> --tenant <id>'));
  assert.ok(flat.includes('`offer account=<key> tenant=<id> sessions=<n> audit=<yes|no> token=<token>`'));
  assert.ok(flat.includes('whatever the workspace\'s past-sessions setting is'));
  assert.ok(flat.includes('Running this skill is not a yes'));
  assert.ok(flat.includes('` Reply upload or not now.`'));
  assert.ok(flat.includes('No answer means no upload.'));
  assert.ok(flat.includes('the summary step 2 shows, without its question, ending `offers=0`; nothing is recorded or sent'));
  assert.doesNotMatch(skill, /past sessions will be sent there too|gets its history uploaded|sync would send/);
});
