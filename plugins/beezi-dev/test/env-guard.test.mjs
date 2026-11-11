import '../tools/hermetic-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { spawnSync } from 'node:child_process';
import { withoutGuard } from '../tools/hermetic-env.mjs';
import {
  checkEnvironment,
  checkEnvironmentLocal,
  hookMayProceedLocal,
  resetEnvironmentMemo,
} from '../lib/env-guard.mjs';
import { ensureEnvironmentMigrated } from '../lib/env-migration.mjs';
import { acquireLock } from '../lib/single-instance-lock.mjs';

// The entry-point guard's two cost cuts (hook performance, Task 2): the full guard is memoized for
// a short window per process, and hooks that only record identity use a credential-free variant.
// Every credential read here goes through a counting or throwing fake, because on Windows each
// real one is a ~1.1 s PowerShell spawn and the whole point is to prove they do not happen.

const pluginRoot = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));

const PROD_API = 'https://api.beezi.ai';
const STAGING_API = 'https://beezi-api-staging.azurewebsites.net';
const PROD_BLOB = JSON.stringify({
  access_token: 'at-prod', refresh_token: 'rt-prod', client_id: 'c1',
  token_endpoint: 'https://clerk.beezi.ai/oauth/token',
});

function sandbox(t, name) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `beezi-guard-${name}-`)));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } });
  return dir;
}

/** A used data root: a queued segment and an accounts index naming `keys`. */
function usedRoot(dir, keys = ['a1b2c3d4']) {
  fs.mkdirSync(path.join(dir, 'queue'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'queue', 'seg-1.json'), '{}');
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({
    version: 1, default: keys[0], accounts: keys.map(key => ({ key, status: 'linked' })),
  }));
  return dir;
}

function bind(dir, env = '', apiOrigin = PROD_API) {
  fs.writeFileSync(path.join(dir, 'environment.json'), JSON.stringify({ version: 1, env, apiOrigin }));
  return dir;
}

function countingReader(blob = PROD_BLOB) {
  const reader = () => { reader.calls += 1; return blob; };
  reader.calls = 0;
  return reader;
}

function throwingReader() {
  const reader = () => { reader.calls += 1; throw new Error('credential store must not be read'); };
  reader.calls = 0;
  return reader;
}

// ── the memo ────────────────────────────────────────────────────────────────────────────────

test('a second check on the same deps returns the same verdict without re-reading credentials', (t) => {
  resetEnvironmentMemo();
  const home = bind(usedRoot(sandbox(t, 'memo')));
  const readRawCredential = countingReader();
  const deps = { env: '', apiOrigin: PROD_API, home: () => home, readRawCredential, now: () => 1000 };

  const first = checkEnvironment(deps);
  const second = checkEnvironment(deps);

  assert.deepEqual(first, { status: 'ok' });
  assert.deepEqual(second, { status: 'ok' });
  assert.equal(readRawCredential.calls, 1);
});

test('the memo is dropped by resetEnvironmentMemo', (t) => {
  resetEnvironmentMemo();
  const home = bind(usedRoot(sandbox(t, 'reset')));
  const readRawCredential = countingReader();
  const deps = { env: '', apiOrigin: PROD_API, home: () => home, readRawCredential, now: () => 1000 };

  checkEnvironment(deps);
  resetEnvironmentMemo();
  checkEnvironment(deps);

  assert.equal(readRawCredential.calls, 2);
});

test('the memo expires 30 seconds after the check it remembers', (t) => {
  resetEnvironmentMemo();
  const home = bind(usedRoot(sandbox(t, 'ttl')));
  const readRawCredential = countingReader();
  let clock = 1000;
  const deps = { env: '', apiOrigin: PROD_API, home: () => home, readRawCredential, now: () => clock };

  checkEnvironment(deps);
  clock = 1000 + 29_999;
  checkEnvironment(deps);
  assert.equal(readRawCredential.calls, 1);
  clock = 1000 + 30_000;
  checkEnvironment(deps);
  assert.equal(readRawCredential.calls, 2);
});

test('the memo does not survive a clock that jumps backwards', (t) => {
  resetEnvironmentMemo();
  const home = bind(usedRoot(sandbox(t, 'clockback')));
  const readRawCredential = countingReader();
  let clock = 100_000;
  const deps = { env: '', apiOrigin: PROD_API, home: () => home, readRawCredential, now: () => clock };

  checkEnvironment(deps);
  clock = 99_999;
  checkEnvironment(deps);

  assert.equal(readRawCredential.calls, 2);
});

test('a remembered verdict is frozen, so no caller can rewrite it for the next', (t) => {
  resetEnvironmentMemo();
  const home = bind(usedRoot(sandbox(t, 'frozen')));
  const deps = { env: '', apiOrigin: PROD_API, home: () => home, readRawCredential: countingReader(), now: () => 1000 };

  checkEnvironment(deps);
  const hit = checkEnvironment(deps);

  assert.equal(Object.isFrozen(hit), true);
});

// A memo hit still re-runs the credential-free root checks. Another process can rebind the root
// (migrate-env --rollback), hold the migration barrier or leave an unfinished journal while a
// resident MCP server keeps asking; none of those may be answered from the memo.
const REVALIDATE_CASES = [
  {
    name: 'a root rebound to another environment',
    change: (home) => bind(home, 'staging', STAGING_API),
    expect: { status: 'blocked', reason: 'binding-mismatch' },
  },
  {
    name: 'a root left with an unfinished migration journal',
    change: (home) => fs.writeFileSync(path.join(home, 'migration.json'), JSON.stringify({ version: 1, phase: 'copying' })),
    expect: { status: 'blocked', reason: 'inspection-or-migration-failed' },
  },
];

for (const c of REVALIDATE_CASES) {
  test(`a remembered ok is not returned for ${c.name}; the full guard decides`, (t) => {
    resetEnvironmentMemo();
    const home = bind(usedRoot(sandbox(t, 'revalidate')));
    const readRawCredential = countingReader();
    const deps = { env: '', apiOrigin: PROD_API, home: () => home, readRawCredential, now: () => 1000,
      preservedHome: () => path.join(sandbox(t, 'revalidate-dst'), '.beezi-codex-staging') };

    assert.equal(checkEnvironment(deps).status, 'ok');
    c.change(home);
    const result = checkEnvironment(deps);

    assert.deepEqual({ status: result.status, reason: result.reason }, c.expect);
    // The memo was dropped and the full guard ran again: one more credential read, not zero.
    assert.equal(readRawCredential.calls, 2);
  });
}

test('a remembered ok is not returned while another holder owns the migration barrier', (t) => {
  resetEnvironmentMemo();
  const home = bind(usedRoot(sandbox(t, 'barrier-held')));
  const readRawCredential = countingReader();
  const deps = { env: '', apiOrigin: PROD_API, home: () => home, readRawCredential, now: () => 1000,
    preservedHome: () => path.join(sandbox(t, 'barrier-held-dst'), '.beezi-codex-staging') };
  assert.equal(checkEnvironment(deps).status, 'ok');

  const held = acquireLock({ name: 'migration-barrier', kind: 'migration',
    file: path.join(home, 'locks', 'migration-barrier.lock') }, { leaseMs: 120000 });
  assert.equal(held.ok, true);
  t.after(() => held.handle.release());
  const result = checkEnvironment(deps);

  assert.deepEqual({ status: result.status, reason: result.reason }, { status: 'deferred', reason: 'migration-barrier' });
  assert.equal(readRawCredential.calls, 2);
});

test('a refusal is not remembered: the next check runs the guard again', () => {
  resetEnvironmentMemo();
  let calls = 0;
  const deps = {
    now: () => 1000,
    ensureEnvironmentMigrated: () => { calls += 1; return { status: 'deferred', reason: 'migration-barrier' }; },
  };

  assert.equal(checkEnvironment(deps).status, 'deferred');
  assert.equal(checkEnvironment(deps).status, 'deferred');
  assert.equal(calls, 2);
});

test('after a migration the remembered verdict is a plain ok, so the notice is shown once', () => {
  resetEnvironmentMemo();
  let calls = 0;
  const deps = {
    now: () => 1000,
    ensureEnvironmentMigrated: () => { calls += 1; return { status: 'migrated', message: 'moved to staging' }; },
    checkRootWithoutCredentials: () => ({ status: 'ok' }),
  };

  const first = checkEnvironment(deps);
  const second = checkEnvironment(deps);

  assert.deepEqual(first, { status: 'migrated', message: 'moved to staging' });
  assert.deepEqual(second, { status: 'ok' });
  assert.equal(calls, 1);
});

test('two different deps objects never share a remembered verdict', (t) => {
  resetEnvironmentMemo();
  const bound = bind(usedRoot(sandbox(t, 'bound')));
  const mismatched = bind(usedRoot(sandbox(t, 'mismatch')), 'staging', STAGING_API);
  const reader = countingReader();

  const a = checkEnvironment({ env: '', apiOrigin: PROD_API, home: () => bound, readRawCredential: reader, now: () => 1 });
  const b = checkEnvironment({ env: '', apiOrigin: PROD_API, home: () => mismatched, readRawCredential: reader, now: () => 1 });

  assert.equal(a.status, 'ok');
  assert.equal(b.status, 'blocked');
  assert.equal(b.reason, 'binding-mismatch');
});

test('the production call with no deps is remembered too', (t) => {
  resetEnvironmentMemo();
  // A fresh, empty root: the guard binds it without any credential read. The memo is then
  // observed through credentials.json, which only the FULL guard reads: corrupted after the first
  // check, it would block a re-run, while a hit (whose root checks never open it) still answers ok.
  const home = sandbox(t, 'nodeps');
  const previous = process.env.BEEZI_CODEX_HOME;
  process.env.BEEZI_CODEX_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.BEEZI_CODEX_HOME;
    else process.env.BEEZI_CODEX_HOME = previous;
    resetEnvironmentMemo();
  });

  assert.equal(checkEnvironment().status, 'ok');
  assert.equal(fs.existsSync(path.join(home, 'environment.json')), true);
  fs.writeFileSync(path.join(home, 'credentials.json'), JSON.stringify({ neither: 'token nor enc' }));
  assert.equal(checkEnvironment().status, 'ok');
  resetEnvironmentMemo();
  assert.equal(checkEnvironment().status, 'blocked', 'the full guard does refuse this root');
});

test('the remembered production verdict does not carry over to another data root', (t) => {
  resetEnvironmentMemo();
  const fresh = sandbox(t, 'root-a');
  // Malformed binding: refused before any credential read, so the real store is never reached.
  const foreign = sandbox(t, 'root-b');
  fs.writeFileSync(path.join(foreign, 'environment.json'), '{not json');
  const previous = process.env.BEEZI_CODEX_HOME;
  t.after(() => {
    if (previous === undefined) delete process.env.BEEZI_CODEX_HOME;
    else process.env.BEEZI_CODEX_HOME = previous;
    resetEnvironmentMemo();
  });

  process.env.BEEZI_CODEX_HOME = fresh;
  assert.equal(checkEnvironment().status, 'ok');
  process.env.BEEZI_CODEX_HOME = foreign;
  const second = checkEnvironment();

  assert.equal(second.status, 'blocked');
  assert.equal(second.reason, 'inspection-or-migration-failed');
});

// The guard mutates the deps it is given while it holds the migration barrier, so the production
// call must hand it a fresh object, never the memo's shared key.
test('the production call still passes a root left under a stale migration barrier', (t) => {
  resetEnvironmentMemo();
  const home = bind(sandbox(t, 'barrier'));
  // An authoritative logout: the guard reads this record, not the credential store.
  fs.writeFileSync(path.join(home, 'credential-control.json'), JSON.stringify({ version: 1, revision: 'r1', backend: null }));
  fs.mkdirSync(path.join(home, 'locks'), { recursive: true });
  fs.writeFileSync(path.join(home, 'locks', 'migration-barrier.lock'), JSON.stringify({
    token: 'dead', pid: 999999, host: 'elsewhere', acquiredAt: 0, expiresAt: 0,
  }));
  const previous = process.env.BEEZI_CODEX_HOME;
  process.env.BEEZI_CODEX_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.BEEZI_CODEX_HOME;
    else process.env.BEEZI_CODEX_HOME = previous;
    resetEnvironmentMemo();
  });

  const result = checkEnvironment();

  assert.deepEqual({ status: result.status, reason: result.reason }, { status: 'ok', reason: undefined });
});

// ── the credential-free guard ───────────────────────────────────────────────────────────────

const LOCAL_CASES = [
  {
    name: 'a root bound to this environment proceeds',
    root: (dir) => bind(usedRoot(dir)),
    expect: { status: 'ok' },
  },
  {
    name: 'a local variant root bound to its own environment proceeds',
    root: (dir) => bind(usedRoot(dir), 'local', 'http://localhost:5001'),
    deps: { env: 'local', apiOrigin: 'http://localhost:5001' },
    expect: { status: 'ok' },
  },
  {
    name: 'a root bound to another environment is refused',
    root: (dir) => bind(usedRoot(dir), 'staging', STAGING_API),
    expect: { status: 'blocked', reason: 'binding-mismatch' },
  },
  {
    name: 'a root bound to this environment under another API is refused',
    root: (dir) => bind(usedRoot(dir), '', STAGING_API),
    expect: { status: 'blocked', reason: 'conflicting-evidence' },
  },
  {
    name: 'a production build pointed at a non-production API is refused',
    root: (dir) => bind(usedRoot(dir)),
    deps: { apiOrigin: STAGING_API },
    expect: { status: 'blocked', reason: 'api-mismatch' },
  },
  {
    // Its own reason: a root with no data has no linked account, so a hook can answer it as unlinked.
    name: 'an unbound fresh root is refused, not bound, and says it is empty',
    root: (dir) => dir,
    unbound: true,
    expect: { status: 'deferred', reason: 'unbound-empty-root' },
  },
  {
    name: 'an unbound populated root is refused, not migrated',
    root: (dir) => usedRoot(dir),
    unbound: true,
    expect: { status: 'deferred', reason: 'unverified-root' },
  },
  {
    name: 'a populated unbound variant root is refused',
    root: (dir) => usedRoot(dir),
    unbound: true,
    deps: { env: 'local', apiOrigin: 'http://localhost:5001' },
    expect: { status: 'blocked', reason: 'populated-unbound-root' },
  },
  {
    name: 'a root with an unfinished migration journal is refused',
    root: (dir) => {
      bind(usedRoot(dir));
      fs.writeFileSync(path.join(dir, 'migration.json'), JSON.stringify({ version: 1, phase: 'copying' }));
      return dir;
    },
    expect: { status: 'deferred', reason: 'migration-pending' },
  },
  {
    name: 'a root with a finished migration journal proceeds',
    root: (dir) => {
      bind(usedRoot(dir));
      fs.writeFileSync(path.join(dir, 'migration.json'), JSON.stringify({ version: 1, phase: 'done' }));
      return dir;
    },
    expect: { status: 'ok' },
  },
  {
    name: 'a root under a migration barrier is refused',
    root: (dir) => {
      bind(usedRoot(dir));
      fs.mkdirSync(path.join(dir, 'locks'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'locks', 'migration-barrier.lock'), '{}');
      return dir;
    },
    expect: { status: 'deferred', reason: 'migration-barrier' },
  },
];

for (const c of LOCAL_CASES) {
  test(`local guard: ${c.name}, without reading a credential`, (t) => {
    const home = c.root(sandbox(t, 'local'));
    const readRawCredential = throwingReader();
    const getCredentials = throwingReader();
    const deps = { env: '', apiOrigin: PROD_API, home: () => home, readRawCredential, getCredentials, ...(c.deps || {}) };

    const result = checkEnvironmentLocal(deps);

    const { message, ...verdict } = result;
    assert.deepEqual(verdict, c.expect);
    if (result.status === 'blocked') assert.equal(typeof message, 'string');
    assert.equal(readRawCredential.calls, 0);
    assert.equal(getCredentials.calls, 0);
    assert.equal(fs.existsSync(path.join(home, 'environment.json')), !c.unbound, 'the local guard never writes a binding');
  });
}

test('local guard: a malformed binding fails closed', (t) => {
  const home = usedRoot(sandbox(t, 'badbind'));
  fs.writeFileSync(path.join(home, 'environment.json'), '{not json');
  const readRawCredential = throwingReader();

  const result = checkEnvironmentLocal({ env: '', apiOrigin: PROD_API, home: () => home, readRawCredential });

  assert.equal(result.status, 'blocked');
  assert.equal(readRawCredential.calls, 0);
});

test('hookMayProceedLocal answers true only for a bound root', (t) => {
  const bound = bind(usedRoot(sandbox(t, 'yes')));
  const unbound = usedRoot(sandbox(t, 'no'));
  const readRawCredential = throwingReader();

  assert.equal(hookMayProceedLocal({ env: '', apiOrigin: PROD_API, home: () => bound, readRawCredential }), true);
  assert.equal(hookMayProceedLocal({ env: '', apiOrigin: PROD_API, home: () => unbound, readRawCredential }), false);
  assert.equal(readRawCredential.calls, 0);
});

// The same local check the full guard makes: a bound root the FULL guard reads credentials for
// and accepts is accepted by the local one too, and the full guard really does read them.
test('the full guard reads one credential per account on a bound root; the local guard none', (t) => {
  const home = bind(usedRoot(sandbox(t, 'compare'), ['a1b2c3d4', '99887766']));
  const full = countingReader();
  const local = throwingReader();

  assert.equal(ensureEnvironmentMigrated({ env: '', apiOrigin: PROD_API, home: () => home, readRawCredential: full }).status, 'ok');
  assert.equal(checkEnvironmentLocal({ env: '', apiOrigin: PROD_API, home: () => home, readRawCredential: local }).status, 'ok');
  assert.equal(full.calls, 2);
  assert.equal(local.calls, 0);
});

// ── the subagent hooks, as Codex runs them ──────────────────────────────────────────────────

// A preload that makes every subprocess call a recorded failure. A credential read on any
// platform is a subprocess (security, secret-tool, PowerShell), so an empty log proves none ran.
function spawnRecorder(dir) {
  const log = path.join(dir, 'spawns.log');
  const file = path.join(dir, 'record-spawns.mjs');
  fs.writeFileSync(file, [
    "import childProcess from 'node:child_process';",
    "import fs from 'node:fs';",
    `const log = ${JSON.stringify(log)};`,
    "for (const name of ['spawnSync', 'execSync', 'execFileSync', 'spawn', 'exec', 'execFile', 'fork']) {",
    '  childProcess[name] = function recorded(command) {',
    "    fs.appendFileSync(log, `${name} ${String(command)}\\n`);",
    "    throw new Error('subprocess refused by test');",
    '  };',
    '}',
  ].join('\n'));
  return { file, log };
}

for (const hook of ['subagent-start', 'subagent-stop']) {
  test(`${hook} records the agent on a bound root without any subprocess, so without a credential read`, (t) => {
    const dir = sandbox(t, hook);
    const home = bind(usedRoot(path.join(dir, 'root'), ['a1b2c3d4']));
    const recorder = spawnRecorder(dir);
    const env = { ...process.env, BEEZI_CODEX_HOME: home };

    const res = withoutGuard(() => spawnSync(process.execPath,
      ['--import', url.pathToFileURL(recorder.file).href, path.join(pluginRoot, 'scripts', `${hook}.mjs`)], {
        input: JSON.stringify({ session_id: 'sess-1', agent_id: 'agent-1', agent_type: 'worker' }),
        encoding: 'utf8',
        env,
      }));

    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, '');
    assert.equal(fs.existsSync(recorder.log) ? fs.readFileSync(recorder.log, 'utf8') : '', '');
    const agent = JSON.parse(fs.readFileSync(path.join(home, 'state', 'sess-1.agents', 'agent-1.json'), 'utf8'));
    assert.equal(agent.agent_id, 'agent-1');
    assert.equal(agent.agent_type, 'worker');
  });
}

// ── the hooks that run the full guard run it once ───────────────────────────────────────────

function source(rel) {
  return fs.readFileSync(path.join(pluginRoot, rel), 'utf8').replace(/\r\n/g, '\n');
}

const guardCalls = (text) => (text.match(/\b(checkEnvironment|hookMayProceed|environmentNotice)\(/g) || []).length;

// It reads no credential: the full guard (which reads every account's) is the upload worker's.
test('session-start runs only the credential-free guard, once, and derives both proceed and the notice from it', () => {
  const text = source('scripts/session-start.mjs');
  assert.equal(guardCalls(text), 0);
  assert.equal((text.match(/\bcheckEnvironmentLocal\(/g) || []).length, 1);
});

// Stop captures only (I-local): it runs the credential-free guard, and the upload worker the full one.
test('stop runs the credential-free guard once and never the full one', () => {
  assert.equal(guardCalls(source('scripts/stop.mjs')), 0);
  assert.equal((source('scripts/stop.mjs').match(/\bhookMayProceedLocal\(/g) || []).length, 1);
});
