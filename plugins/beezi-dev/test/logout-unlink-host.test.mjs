import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import { unlinkMachine } from '../lib/login.mjs';
import { KINDS } from '../lib/anonymize.mjs';

// unlinkMachine builds its own headers rather than going through authHeaders, so the logout's DELETE
// is checked here against a loopback portal. os.hostname is stubbed so no assertion reads this machine.
const KEY = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const ANON_HOST = 'anon:host:1519461b2b8f6dd80034a4e274c54335';
const kindsOn = (on) => Object.fromEntries(KINDS.map((kind) => [kind, on.includes(kind)]));
const BLOCK = { tenantId: 'T1', kinds: kindsOn(['hosts']), key: KEY, machineName: null };

async function headersOnUnlink(t, session, hostname) {
  const savedHostname = os.hostname;
  const savedBase = process.env.BEEZI_API_URL;
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, headers: req.headers });
    res.writeHead(204, { Connection: 'close' });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  os.hostname = () => hostname;
  process.env.BEEZI_API_URL = `http://127.0.0.1:${server.address().port}/api`;
  try {
    assert.equal(await unlinkMachine(session), true);
  } finally {
    os.hostname = savedHostname;
    if (savedBase === undefined) delete process.env.BEEZI_API_URL;
    else process.env.BEEZI_API_URL = savedBase;
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'DELETE');
  return seen[0].headers;
}

test('logout unlinks an account with hosts on with the hashed host', async (t) => {
  const session = { token: 'tok', clientId: 'c-1', tenantId: null, tenants: [{ id: 'T1', anonymization: BLOCK }] };
  assert.equal((await headersOnUnlink(t, session, ' Dev-Laptop.LOCAL '))['x-beezi-host'], ANON_HOST);
});

test('logout unlinks an account with only accounts on with the raw host', async (t) => {
  const session = { token: 'tok', clientId: 'c-1', tenantId: null, anonymization: { ...BLOCK, kinds: kindsOn(['accounts']) } };
  assert.equal((await headersOnUnlink(t, session, 'dev-laptop'))['x-beezi-host'], 'dev-laptop');
});

test('logout unlinks an account with hosts on and no key without any host header', async (t) => {
  const session = { token: 'tok', clientId: 'c-1', tenantId: null, anonymization: { ...BLOCK, key: null } };
  assert.equal(Object.hasOwn(await headersOnUnlink(t, session, 'dev-laptop'), 'x-beezi-host'), false);
});

test('the unlink request carries the history consent header', async (t) => {
  const session = { token: 'tok', clientId: 'c-1', tenantId: null };
  assert.equal((await headersOnUnlink(t, session, 'dev-laptop'))['x-beezi-history-consent'], 'ask-first');
});
