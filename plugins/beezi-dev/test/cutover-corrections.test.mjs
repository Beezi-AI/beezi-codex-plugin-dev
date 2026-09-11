import '../tools/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBridge } from '../lib/mcp-bridge.mjs';
import { ensureEnvironmentMigrated, STAGING_API_ORIGIN, PRODUCTION_API_ORIGIN } from '../lib/env-migration.mjs';
import { acquireLock } from '../lib/single-instance-lock.mjs';
import { reconcileSession } from '../lib/checkpoint.mjs';

function sandbox(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cutover-corrections-'));
  const source = path.join(base, 'production'), destination = path.join(base, 'staging');
  fs.mkdirSync(source);
  const previous = process.env.BEEZI_CODEX_HOME;
  process.env.BEEZI_CODEX_HOME = source;
  t.after(() => {
    if (previous === undefined) delete process.env.BEEZI_CODEX_HOME;
    else process.env.BEEZI_CODEX_HOME = previous;
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { source, destination, env: '', home: () => source, preservedHome: () => destination };
}
const used = source => {
  fs.mkdirSync(path.join(source, 'queue'), { recursive: true });
  fs.writeFileSync(path.join(source, 'queue', 'segment.json'), '{"segmentId":"s:1-2"}');
};

test('MCP blocks login and token refresh, keeps local discovery/status, then retries recovery', async () => {
  let blocked = true, tokenReads = 0, logins = 0;
  const messages = [];
  const bridge = createBridge({ write: line => messages.push(JSON.parse(line)),
    checkEnvironment: () => ({ status: blocked ? 'deferred' : 'ok', message: 'Recovery pending' }),
    getAccessToken: async () => { tokenReads++; return null; },
    performLogin: async () => { logins++; return { ok: true }; },
  });
  for (const [id, method, name] of [[1, 'initialize'], [2, 'tools/list'], [3, 'tools/call', 'beezi_login'], [4, 'tools/call', 'beezi_status']]) {
    await bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params: name ? { name } : {} }));
  }
  assert.equal(tokenReads, 0);
  assert.equal(logins, 0);
  assert.ok(messages.find(m => m.id === 2).result.tools.length > 0);
  assert.ok(messages.find(m => m.id === 3).error);
  blocked = false;
  await bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list' }));
  assert.equal(tokenReads, 1);
});

test('a matching binding cannot authorize a conflicting API override', t => {
  const deps = sandbox(t);
  fs.writeFileSync(path.join(deps.source, 'environment.json'), JSON.stringify({ version: 1, env: '', apiOrigin: PRODUCTION_API_ORIGIN }));
  assert.equal(ensureEnvironmentMigrated({ ...deps, apiOrigin: STAGING_API_ORIGIN, readRawCredential: () => null }).status, 'blocked');
});

for (const root of ['source', 'destination']) {
  test(`migration defers while a ${root} checkpoint writer holds its lock`, t => {
    const deps = sandbox(t);
    used(deps.source);
    const held = acquireLock({ kind: 'session', name: 'session-active', file: path.join(deps[root], 'locks', 'session-active.lock') }, {});
    assert.equal(held.ok, true);
    try { assert.equal(ensureEnvironmentMigrated({ ...deps, readRawCredential: () => null }).status, 'deferred'); }
    finally { held.handle.release(); }
    assert.ok(fs.existsSync(path.join(deps.source, 'queue', 'segment.json')));
    assert.equal(ensureEnvironmentMigrated({ ...deps, readRawCredential: () => null }).status, 'migrated');
  });
}

for (const destinationAvailable of [true, false]) {
  test(`native migration preserves authority without plaintext (destination available: ${destinationAvailable})`, t => {
    const deps = sandbox(t);
    used(deps.source);
    const raw = JSON.stringify({ access_token: 'secret-access', refresh_token: 'secret-refresh', beezi_env: 'staging', beezi_revision: 'original', token_endpoint: STAGING_API_ORIGIN + '/oauth/token' });
    const native = new Map([['beezi-codex', raw]]);
    fs.writeFileSync(path.join(deps.source, 'credential-control.json'), JSON.stringify({ version: 1, revision: 'original', backend: 'secret-service', beezi_env: 'staging' }));
    const run = (command, args, input) => {
      const service = args[args.indexOf('service') + 1];
      if (args[0] === '--version') return { ok: true, stdout: '' };
      if (args[0] === 'store') {
        if (!destinationAvailable && service === 'beezi-codex-staging') return { ok: false, stdout: '' };
        native.set(service, input); return { ok: true, stdout: '' };
      }
      if (args[0] === 'clear') native.delete(service);
      return { ok: true, stdout: native.get(service) || '' };
    };
    const result = ensureEnvironmentMigrated({ ...deps, platform: 'linux', run });
    assert.equal(result.status, 'migrated', result.message);
    const sourceControl = JSON.parse(fs.readFileSync(path.join(deps.source, 'credential-control.json')));
    const destinationControl = JSON.parse(fs.readFileSync(path.join(deps.destination, 'credential-control.json')));
    assert.equal(sourceControl.backend, null);
    assert.equal(destinationControl.backend, destinationAvailable ? 'secret-service' : null);
    assert.equal(fs.existsSync(path.join(deps.destination, 'credentials.json')), false);
    assert.equal(native.has('beezi-codex'), !destinationAvailable);
    if (destinationAvailable) assert.equal(JSON.parse(native.get('beezi-codex-staging')).beezi_revision, destinationControl.revision);
  });
}

for (const drain of [{ lockSkipped: true }, { failed: 1 }, { deferred: 1 }, { unreadable: 1 }]) {
  test(`reconciliation refuses unresolved pending reports ${JSON.stringify(drain)}`, async t => {
    sandbox(t);
    let queried = false;
    const result = await reconcileSession('s', 'token', async () => { queried = true; }, { flushQueue: async () => drain });
    assert.equal(result.outcome, 'deferred');
    assert.equal(queried, false);
  });
}
