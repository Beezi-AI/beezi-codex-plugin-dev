import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { authHeaders, getJson, postJson } from '../lib/http.mjs';
import { KINDS } from '../lib/anonymize.mjs';

const manifestPath = fileURLToPath(new URL('../.codex-plugin/plugin.json', import.meta.url));
let moduleId = 0;

async function withManifest(t, contents) {
  const original = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function (file, ...args) {
    if (file === manifestPath) {
      reads++;
      if (contents === undefined) throw new Error('manifest unavailable');
      return contents;
    }
    return original.call(this, file, ...args);
  };
  t.after(() => { fs.readFileSync = original; });
  const { machineHeaders } = await import(`../lib/machine-identity.mjs?version-test=${moduleId++}`);
  return { machineHeaders, reads: () => reads };
}

test('version header uses the installed build version and caches it across accounts', async (t) => {
  const { machineHeaders, reads } = await withManifest(t, '{"version":"0.14.2-staging.5358"}');
  for (const clientId of ['client-a', 'client-b']) {
    const headers = machineHeaders(clientId);
    assert.equal(headers['X-Beezi-Plugin-Version'], '0.14.2-staging.5358');
    assert.equal(headers['X-Beezi-Client'], clientId);
  }
  assert.equal(reads(), 1);
});

test('version header is limited to 255 characters', async (t) => {
  const { machineHeaders } = await withManifest(t, JSON.stringify({ version: 'v'.repeat(300) }));
  assert.equal(machineHeaders()['X-Beezi-Plugin-Version'], 'v'.repeat(255));
});

for (const contents of [undefined, '{', 'null', '{}', '{"version":42}', '{"version":""}']) {
  test(`unavailable version is omitted and cached: ${contents}`, async (t) => {
    const { machineHeaders, reads } = await withManifest(t, contents);
    for (let i = 0; i < 2; i++) {
      assert.equal(Object.hasOwn(machineHeaders(), 'X-Beezi-Plugin-Version'), false);
    }
    assert.equal(reads(), 1);
  });
}

test('API GET and POST send the installed plugin version', async () => {
  const expected = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).version;
  const seen = [];
  const deps = { fetchImpl: async (_url, options) => { seen.push(options.headers); return { ok: true }; } };
  const session = { token: 'token', clientId: 'client' };
  await getJson('https://api.test/thing', session, deps);
  await postJson('https://api.test/thing', session, {}, deps);
  assert.equal(seen.length, 2);
  for (const headers of seen) assert.equal(headers['X-Beezi-Plugin-Version'], expected);
});

// X-Beezi-Host follows the session's anonymization block; os.hostname is stubbed so no assertion reads this machine.
const ANON_KEY = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const ANON_HOST = 'anon:host:1519461b2b8f6dd80034a4e274c54335';
const RAW_HOST = ' Dev-Laptop.LOCAL ';
const kindsOn = (on) => Object.fromEntries(KINDS.map((kind) => [kind, on.includes(kind)]));
const block = (on, over = {}) => ({ tenantId: 'T1', kinds: kindsOn(on), key: ANON_KEY, machineName: null, ...over });

// The X-Beezi-Host each of a GET and a POST carried; undefined when the header was left out.
async function hostSent(session) {
  const savedHostname = os.hostname;
  os.hostname = () => RAW_HOST;
  try {
    const seen = [];
    const deps = { fetchImpl: async (_url, options) => { seen.push(options.headers['X-Beezi-Host']); return { ok: true }; } };
    await getJson('https://api.test/thing', session, deps);
    await postJson('https://api.test/thing', session, {}, deps);
    return seen;
  } finally {
    os.hostname = savedHostname;
  }
}

test('a session with hosts on sends the hashed host on GET and POST', async () => {
  const session = { token: 'token', clientId: 'client', tenantId: null, tenants: [{ id: 'T1', anonymization: block(['hosts']) }] };
  assert.deepEqual(await hostSent(session), [ANON_HOST, ANON_HOST]);
});

test('a per-workspace clone sends the hashed host only to the workspace with hosts on', async () => {
  const tenants = [{ id: 'T1', anonymization: block(['hosts']) }, { id: 'T2', anonymization: block([], { tenantId: 'T2' }) }];
  assert.deepEqual(await hostSent({ token: 'token', clientId: 'client', tenantId: 'T1', tenants }), [ANON_HOST, ANON_HOST]);
  assert.deepEqual(await hostSent({ token: 'token', clientId: 'client', tenantId: 'T2', tenants }), [RAW_HOST, RAW_HOST]);
});

test('a session without a block, or with only accounts on, sends the raw host', async () => {
  const raw = [RAW_HOST, RAW_HOST];
  assert.deepEqual(await hostSent({ token: 'token', clientId: 'client' }), raw);
  assert.deepEqual(await hostSent({ token: 'token', clientId: 'client', anonymization: block([]) }), raw);
  assert.deepEqual(await hostSent({ token: 'token', clientId: 'client', anonymization: block(['accounts']) }), raw);
});

test('hosts on without a key leaves X-Beezi-Host out entirely', async () => {
  const savedHostname = os.hostname;
  os.hostname = () => RAW_HOST;
  try {
    const seen = [];
    const deps = { fetchImpl: async (_url, options) => { seen.push(options.headers); return { ok: true }; } };
    const session = { token: 'token', clientId: 'client', anonymization: block(['hosts'], { key: null }) };
    await getJson('https://api.test/thing', session, deps);
    await postJson('https://api.test/thing', session, {}, deps);
    assert.equal(seen.length, 2);
    for (const headers of seen) assert.equal(Object.hasOwn(headers, 'X-Beezi-Host'), false);
  } finally {
    os.hostname = savedHostname;
  }
});

test('every authenticated request says the plugin asks before uploading past sessions', () => {
  assert.equal(authHeaders({ token: 'token', clientId: 'client' })['x-beezi-history-consent'], 'ask-first');
});
