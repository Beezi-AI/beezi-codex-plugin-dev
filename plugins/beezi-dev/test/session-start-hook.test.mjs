import '../tools/hermetic-env.mjs';
import { withoutGuard } from '../tools/hermetic-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { spawnSync } from 'node:child_process';

// scripts/session-start.mjs as Codex runs it: a child node process reading the hook input on stdin.
// A preload records every subprocess and every request the hook attempts, and refuses each one. A
// credential read on any platform is a subprocess (PowerShell, security, secret-tool), so a log
// with none of those proves the hook read no credential; a log with no request proves it asked the
// portal nothing. withoutGuard: the child node process is the experiment (test/env-guard.test.mjs
// runs the subagent hooks the same way).

const pluginRoot = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
const PROD_API = 'https://api.beezi.ai';
const KEY = 'a1b2c3d4';
const ROW = { key: KEY, email: 'dev@acme.io', name: 'Dev', tenantName: 'Acme', clientId: 'c-a1b2c3d4', status: 'linked' };
const REJECTED = '⚠ Beezi: this machine’s link was rejected — analytics are NOT being tracked. Ask Beezi to sign you in again.';
const NOTICE = 'Beezi now reports to the production API.';

function sandbox(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-session-start-hook-')));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } });
  return dir;
}

// A data root bound to production, one linked account with its directory, and no credential at all.
function linkedRoot(dir, { bound = true } = {}) {
  const home = path.join(dir, 'root');
  fs.mkdirSync(path.join(home, 'accounts', KEY), { recursive: true });
  fs.writeFileSync(path.join(home, 'accounts.json'), JSON.stringify({ version: 1, default: KEY, accounts: [ROW] }));
  if (bound) fs.writeFileSync(path.join(home, 'environment.json'), JSON.stringify({ version: 1, env: '', apiOrigin: PROD_API }));
  return home;
}

function cache(home, value) {
  fs.writeFileSync(path.join(home, 'accounts', KEY, 'session-start.json'), JSON.stringify({ version: 1, checkedAt: 1, ...value }));
}

function recorder(dir) {
  const log = path.join(dir, 'calls.log');
  const file = path.join(dir, 'record-calls.mjs');
  fs.writeFileSync(file, [
    "import childProcess from 'node:child_process';",
    "import http from 'node:http';",
    "import https from 'node:https';",
    "import fs from 'node:fs';",
    `const log = ${JSON.stringify(log)};`,
    'const note = (call, command, args) => fs.appendFileSync(log, JSON.stringify({ call, command: String(command), args: Array.isArray(args) ? args.map(String) : [] }) + "\\n");',
    "for (const name of ['spawnSync', 'execSync', 'execFileSync', 'spawn', 'exec', 'execFile', 'fork']) {",
    '  childProcess[name] = function recorded(command, args) {',
    '    note(name, command, args);',
    "    throw new Error('subprocess refused by test');",
    '  };',
    '}',
    "globalThis.fetch = async function recorded(input) { note('fetch', input && input.url ? input.url : input); throw new Error('network refused by test'); };",
    "for (const [name, mod] of [['http', http], ['https', https]]) {",
    "  mod.request = function recorded(target) { note(name, target && target.hostname ? target.hostname : target); throw new Error('network refused by test'); };",
    '}',
  ].join('\n'));
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
  return { file, calls };
}

function runHook(dir, home, input) {
  const rec = recorder(dir);
  const env = { ...process.env, BEEZI_CODEX_HOME: home };
  // The real trigger, so the worker spawn is attempted (and recorded) rather than disabled.
  delete env.BEEZI_TEST_NO_SPAWN;
  const res = withoutGuard(() => spawnSync(process.execPath,
    ['--import', url.pathToFileURL(rec.file).href, path.join(pluginRoot, 'scripts', 'session-start.mjs')], {
      input: JSON.stringify(input), encoding: 'utf8', env,
    }));
  return { res, calls: rec.calls(), out: res.stdout === '' ? null : JSON.parse(res.stdout) };
}

const CREDENTIAL_HELPER = /powershell|pwsh|(^|[\\/])security$|secret-tool/i;
const isWorkerSpawn = (c) => c.call === 'spawn' && c.args.length > 0 && /upload-worker\.mjs$/.test(c.args[0]);

function startInput(dir) {
  const cwd = path.join(dir, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  return { session_id: 'sess-1', cwd, transcript_path: path.join(dir, 'rollout.jsonl'), source: 'startup' };
}

test('SessionStart reads no credential and makes no request, prints from the cache, marks the session due and starts the worker last', (t) => {
  const dir = sandbox(t);
  const home = linkedRoot(dir);
  cache(home, { verdict: 'ok', who: { valid: true, email: 'dev@acme.io', name: 'Dev', tenantName: 'Acme', tenants: null, anonymization: null } });
  const input = startInput(dir);

  const { res, calls, out } = runHook(dir, home, input);

  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stderr, '');
  assert.ok(out.systemMessage.startsWith('Beezi ✓ dev@acme.io, workspace Acme\n'), out.systemMessage);
  assert.deepEqual(calls.filter((c) => CREDENTIAL_HELPER.test(c.command)), [], 'no credential helper ran');
  assert.deepEqual(calls.filter((c) => c.call === 'fetch' || c.call === 'http' || c.call === 'https'), [], 'no request was made');
  assert.equal(calls.filter(isWorkerSpawn).length, 1, JSON.stringify(calls));
  assert.ok(isWorkerSpawn(calls[calls.length - 1]), 'the worker spawn is the last thing the hook does');
  const marker = JSON.parse(fs.readFileSync(path.join(home, 'upload-due', 'sess-1.json'), 'utf8'));
  assert.deepEqual([marker.sessionId, marker.sessionStart, marker.timeline, marker.cwd, marker.transcriptPath],
    ['sess-1', true, false, input.cwd, input.transcript_path]);
});

test('a rejection the worker cached is told at the next start', (t) => {
  const dir = sandbox(t);
  const home = linkedRoot(dir);
  cache(home, { verdict: 'rejected', who: null });
  const { res, out, calls } = runHook(dir, home, startInput(dir));
  assert.equal(res.status, 0, res.stderr);
  assert.equal(out.systemMessage, REJECTED);
  assert.deepEqual(calls.filter((c) => CREDENTIAL_HELPER.test(c.command)), []);
});

test('a migration the worker ran is told once, ahead of the status', (t) => {
  const dir = sandbox(t);
  const home = linkedRoot(dir);
  cache(home, { verdict: 'rejected', who: null });
  fs.writeFileSync(path.join(home, 'upload-worker.json'), JSON.stringify({ version: 1, migrationNotice: NOTICE }));

  assert.equal(runHook(dir, home, startInput(dir)).out.systemMessage, `${NOTICE}\n\n${REJECTED}`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'upload-worker.json'), 'utf8')).migrationNotice, null);
  assert.equal(runHook(dir, home, startInput(dir)).out.systemMessage, REJECTED);
});

// The full guard used to run here and bind or migrate such a root; the worker's full guard does now.
test('a root only the full guard can decide prints nothing, reads no credential, marks the session due and starts the worker', (t) => {
  const dir = sandbox(t);
  const home = linkedRoot(dir, { bound: false });
  const input = startInput(dir);
  const { res, calls } = runHook(dir, home, input);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, '');
  assert.deepEqual(calls.filter((c) => CREDENTIAL_HELPER.test(c.command)), [], 'no credential helper ran');
  assert.deepEqual(calls.filter((c) => !isWorkerSpawn(c)), [], 'nothing but the worker spawn');
  assert.equal(calls.filter(isWorkerSpawn).length, 1, JSON.stringify(calls));
  const marker = JSON.parse(fs.readFileSync(path.join(home, 'upload-due', 'sess-1.json'), 'utf8'));
  assert.deepEqual([marker.sessionId, marker.sessionStart, marker.timeline, marker.cwd, marker.transcriptPath],
    ['sess-1', true, false, input.cwd, input.transcript_path]);
});

// A fresh install: the full guard used to bind it here and then answer as an unlinked machine. The
// hook does not bind (its guard writes nothing) but answers the same, byte for byte. It marks
// nothing: no account is linked, so the session has no SessionStart work, and a marker left until
// a later login would have the worker report a session that ran before the link as live. With
// nothing to post the trigger starts no worker; the MCP server's or the login's full guard binds.
test('a fresh empty root prints the unlinked line the base printed, reads no credential and marks nothing', (t) => {
  const dir = sandbox(t);
  const home = path.join(dir, 'root');
  fs.mkdirSync(home, { recursive: true });
  const { res, calls } = runHook(dir, home, startInput(dir));
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, '{"systemMessage":"⚠ Beezi: this machine is not linked — analytics are NOT being tracked. Ask Beezi to sign you in."}');
  assert.deepEqual(calls, [], 'no credential helper, no request and no worker spawn');
  assert.equal(fs.existsSync(path.join(home, 'environment.json')), false, 'the hook binds nothing');
  assert.equal(fs.existsSync(path.join(home, 'upload-due')), false, 'the session is not marked due');
});

test('a root mid-migration (barrier held) is not marked', (t) => {
  const dir = sandbox(t);
  const home = linkedRoot(dir);
  fs.mkdirSync(path.join(home, 'locks'), { recursive: true });
  fs.writeFileSync(path.join(home, 'locks', 'migration-barrier.lock'), '{}');
  const { res, calls } = runHook(dir, home, startInput(dir));
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, '');
  assert.equal(fs.existsSync(path.join(home, 'upload-due')), false);
  assert.deepEqual(calls.filter((c) => CREDENTIAL_HELPER.test(c.command)), []);
});

test('a hard-blocked root says why, marks nothing and starts no worker', (t) => {
  const dir = sandbox(t);
  const home = linkedRoot(dir, { bound: false });
  // Bound to another API origin: a mismatch no worker run can resolve.
  fs.writeFileSync(path.join(home, 'environment.json'), JSON.stringify({ version: 1, env: '', apiOrigin: 'https://api.elsewhere.example' }));
  const { res, calls, out } = runHook(dir, home, startInput(dir));
  assert.equal(res.status, 0, res.stderr);
  assert.equal(typeof out.systemMessage, 'string');
  assert.equal(fs.existsSync(path.join(home, 'upload-due')), false);
  assert.deepEqual(calls, []);
});

// A bound root with no accounts index yet: the async index reader would run the pre-0.13 keyring
// conversion (a credential read) the moment anything asked it. The history trigger asks for the
// linked rows too, so it must get the hook's sync, credential-free listing like every other ask.
test('a bound root with no accounts index runs no keyring conversion, even for the history trigger', (t) => {
  const dir = sandbox(t);
  const home = path.join(dir, 'root');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'environment.json'), JSON.stringify({ version: 1, env: '', apiOrigin: PROD_API }));
  const { res, calls } = runHook(dir, home, startInput(dir));
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(calls.filter((c) => CREDENTIAL_HELPER.test(c.command)), [], 'no credential helper ran');
  assert.equal(fs.existsSync(path.join(home, 'accounts.json')), false, 'no conversion wrote an index');
  assert.equal(fs.existsSync(path.join(home, 'accounts.migration.json')), false, 'no conversion was journalled');
});
