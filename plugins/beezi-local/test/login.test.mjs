import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// performLogin now has real filesystem side effects (tracking.json, audit-ledger.json). Point the
// data root at a throwaway dir BEFORE the lib loads paths, or the suite writes into the real
// ~/.beezi-codex of whoever runs it.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-login-'));
process.env.BEEZI_CODEX_HOME = TEST_HOME;
process.on('exit', () => { try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* best-effort */ } });

const { performLogin, openBrowser } = await import('../lib/login.mjs');
const { trackingStateFile, auditLedgerFile } = await import('../lib/paths.mjs');

// Enough of the flow to reach the browser step and past it, with nothing touching the network.
function loginDeps(overrides = {}) {
  return {
    getCredentials: async () => null,
    linkStatus: async () => ({ state: 'not_linked', account: null, apiBase: 'https://api.test' }),
    deleteCredentials: async () => {},
    discover: async () => ({
      authorizationEndpoint: 'https://auth.test/authorize',
      tokenEndpoint: 'https://auth.test/token',
      registrationEndpoint: 'https://auth.test/register',
    }),
    pkcePair: () => ({ verifier: 'v', challenge: 'c' }),
    startLoopback: async () => ({
      redirectUri: 'http://127.0.0.1:1234/callback',
      port: 1234,
      code: Promise.resolve('auth-code'),
      cancel: () => {},
    }),
    registerClient: async () => 'client-123',
    exchangeCode: async () => ({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
    setCredentials: async () => 'the OS keyring',
    whoami: async () => ({ valid: true, name: 'Dev Eloper', email: null }),
    openBrowser: async () => ({ ok: true }),
    // Both halves of the G-2-1 account check-in, always stubbed. Unstubbed, `getAccessToken`
    // opens the real credential store and `syncAccountIfNeeded` runs the real module against the
    // real API — and neither failure shows up as a failed assertion, only as the runner's PROCESS
    // EXIT STATUS moving. The discipline has to be unconditional.
    getAccessToken: async () => 'stored-token',
    syncAccountIfNeeded: async () => ({ synced: false }),
    ...overrides,
  };
}

// Records every account check-in the flow makes: [token, options].
function syncSpy(result = { synced: true, status: 200 }) {
  const calls = [];
  const impl = async (token, options) => {
    calls.push({ token, options: options || {} });
    return result;
  };
  impl.calls = calls;
  return impl;
}

test('login emits the authorize URL before it tries to open a browser', async () => {
  const steps = [];
  const order = [];
  await performLogin({
    onStep: (s) => { steps.push(s); order.push(`step:${s.type}`); },
    deps: loginDeps({ openBrowser: async () => { order.push('openBrowser'); return { ok: true }; } }),
  });
  assert.equal(order[0], 'step:authorize-url');
  assert.equal(order[1], 'openBrowser');
  assert.match(steps[0].url, /^https:\/\/auth\.test\/authorize\?/);
});

// The launcher used to be fire-and-forget with stdio ignored, so a sandboxed shell or a machine
// with no http association failed invisibly: no browser, no message, and — through the MCP tool —
// no URL either. The outcome now reaches the caller.
test('a launcher that fails is surfaced as a browser-failed step', async () => {
  const steps = [];
  const result = await performLogin({
    onStep: (s) => steps.push(s),
    deps: loginDeps({ openBrowser: async () => ({ ok: false, detail: 'no http association' }) }),
  });

  const failed = steps.find((s) => s.type === 'browser-failed');
  assert.ok(failed, 'no browser-failed step was emitted');
  assert.equal(failed.detail, 'no http association');
  assert.match(failed.url, /^https:\/\/auth\.test\/authorize\?/);
  // The sign-in itself still completes — the user can open the URL by hand.
  assert.equal(result.type, 'linked');
  assert.equal(result.account, 'Dev Eloper');
});

test('an openBrowser that resolves ok emits no browser-failed step', async () => {
  const steps = [];
  await performLogin({ onStep: (s) => steps.push(s), deps: loginDeps() });
  assert.equal(steps.find((s) => s.type === 'browser-failed'), undefined);
});

// whoami is a display-name lookup that runs *after* the credentials are stored. It must never be
// able to fail the login — that is what stranded a completed sign-in behind a pending request.
test('a whoami that fails still yields a linked result', async () => {
  const result = await performLogin({
    deps: loginDeps({ whoami: async () => { throw new Error('unreachable'); } }),
  });
  assert.equal(result.type, 'linked');
  assert.equal(result.account, null);
});

// ─── link side effects (backfill groundwork) ────────────────────────────────

test('a fresh link stamps linkedAt, records whoami, and drops the previous ledger', async () => {
  fs.writeFileSync(auditLedgerFile(), JSON.stringify({ version: 1, identity: 'old-login', sessions: {} }));
  fs.writeFileSync(trackingStateFile(), JSON.stringify({ version: 1, trackingMode: 'live', identity: 'old-login' }));

  await performLogin({
    deps: loginDeps({
      whoami: async () => ({ valid: true, name: 'Dev', email: null, trackingMode: 'backfill_only', backfillCompleted: false }),
    }),
  });

  assert.ok(!fs.existsSync(auditLedgerFile()), 'a fresh identity must not replay the old ledger');
  const tracking = JSON.parse(fs.readFileSync(trackingStateFile(), 'utf-8'));
  assert.ok(tracking.linkedAt, 'the link instant is stamped for the backfill cutoff');
  assert.equal(tracking.identity, 'client-123', 'the old identity did not survive the clear');
  assert.equal(tracking.trackingMode, 'backfill_only');
});

test('a whoami that fails still stamps linkedAt but records no policy', async () => {
  try { fs.rmSync(trackingStateFile(), { force: true }); } catch { /* clean slate */ }

  await performLogin({ deps: loginDeps({ whoami: async () => { throw new Error('offline'); } }) });

  const tracking = JSON.parse(fs.readFileSync(trackingStateFile(), 'utf-8'));
  assert.ok(tracking.linkedAt);
  assert.equal(tracking.trackingMode, undefined);
});

test('an already-linked login refreshes the tracking cache from the link status', async () => {
  try { fs.rmSync(trackingStateFile(), { force: true }); } catch { /* clean slate */ }

  const result = await performLogin({
    deps: loginDeps({
      getCredentials: async () => ({ client_id: 'existing-client', redirect_uri: 'http://127.0.0.1:1234/cb' }),
      linkStatus: async () => ({
        state: 'linked',
        account: 'Dev',
        apiBase: 'https://api.test',
        who: { valid: true, trackingMode: 'live', backfillCompleted: true },
      }),
    }),
  });

  assert.equal(result.type, 'already-linked');
  const tracking = JSON.parse(fs.readFileSync(trackingStateFile(), 'utf-8'));
  assert.equal(tracking.trackingMode, 'live');
  assert.equal(tracking.backfillCompleted, true);
  assert.equal(tracking.identity, 'existing-client');
});

// ─── the account check-in (G-2-1 wiring) ────────────────────────────────────
//
// The trigger lives in performLogin, not in scripts/login.mjs, because this function is the shared
// entry for both the CLI script and the `beezi_login` MCP tool — putting it in the script would
// leave the MCP path silent.

test('a fresh link checks the account in, FORCED, with the token it just exchanged', async () => {
  const sync = syncSpy();
  await performLogin({ deps: loginDeps({ syncAccountIfNeeded: sync }) });

  assert.equal(sync.calls.length, 1);
  assert.equal(sync.calls[0].token, 'at', 'the token from exchangeCode, not one re-read from disk');
  // The one trigger where force is genuinely load-bearing: a fresh identity inherits the PREVIOUS
  // identity's marker, so an unchanged payload hash would suppress the check-in guaranteed to be
  // news. Dropping `force` here is invisible until an account switch fails to propagate.
  assert.equal(sync.calls[0].options.force, true);
});

test('an already-linked re-login checks in UNFORCED, on the token the machine already holds', async () => {
  const sync = syncSpy();
  let asked = 0;
  const result = await performLogin({
    deps: loginDeps({
      getCredentials: async () => ({ client_id: 'existing-client', redirect_uri: 'http://127.0.0.1:1234/cb' }),
      linkStatus: async () => ({ state: 'linked', account: 'Dev', apiBase: 'https://api.test', who: { valid: true } }),
      getAccessToken: async () => { asked += 1; return 'already-stored'; },
      syncAccountIfNeeded: sync,
    }),
  });

  assert.equal(result.type, 'already-linked');
  assert.equal(asked, 1, 'the existing access token is the token source on this branch');
  assert.equal(sync.calls.length, 1);
  assert.equal(sync.calls[0].token, 'already-stored');
  // Unforced on purpose: re-running the login command on an unchanged machine is not news, so the
  // payload hash still gates it and last_seen_at refreshes on the resync interval instead.
  assert.notEqual(sync.calls[0].options.force, true);
});

test('an already-linked re-login whose token cannot be read still reports, with no token', async () => {
  const sync = syncSpy();
  const result = await performLogin({
    deps: loginDeps({
      getCredentials: async () => ({ client_id: 'existing-client', redirect_uri: 'http://127.0.0.1:1234/cb' }),
      linkStatus: async () => ({ state: 'linked', account: 'Dev', apiBase: 'https://api.test', who: { valid: true } }),
      getAccessToken: async () => { throw new Error('keyring locked'); },
      syncAccountIfNeeded: sync,
    }),
  });

  assert.equal(result.type, 'already-linked', 'a locked keyring must not fail a status read');
  assert.equal(sync.calls[0].token, null, 'failing soft to null is the module’s quiet no-token path');
});

test('a check-in that throws never strands a completed sign-in', async () => {
  // The credentials are already stored by the time this runs. It is exactly the position whoami
  // was in when an unsettled request stranded a finished login, so it gets the same guarantee.
  const result = await performLogin({
    deps: loginDeps({ syncAccountIfNeeded: async () => { throw new Error('offline'); } }),
  });
  assert.equal(result.type, 'linked');
  assert.equal(result.account, 'Dev Eloper');
});

test('a check-in that throws does not break the already-linked report either', async () => {
  const result = await performLogin({
    deps: loginDeps({
      getCredentials: async () => ({ client_id: 'existing-client', redirect_uri: 'http://127.0.0.1:1234/cb' }),
      linkStatus: async () => ({ state: 'linked', account: 'Dev', apiBase: 'https://api.test', who: { valid: true } }),
      syncAccountIfNeeded: async () => { throw new Error('offline'); },
    }),
  });
  assert.equal(result.type, 'already-linked');
  assert.equal(result.account, 'Dev');
});

test('openBrowser refuses a non-http(s) URL instead of handing it to a shell', async () => {
  const result = await openBrowser('file:///c:/windows/system32/calc.exe');
  assert.equal(result.ok, false);
  assert.match(result.detail, /non-http/);
});

test('openBrowser reports a launcher it cannot start', { skip: process.platform !== 'win32' }, async (t) => {
  // Point the launcher at a directory that holds no powershell.exe: the spawn fails, and the
  // caller has to learn about it rather than believing a browser opened.
  const prev = process.env.SystemRoot;
  process.env.SystemRoot = 'C:\\beezi-no-such-root';
  t.after(() => {
    if (prev === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = prev;
  });

  const result = await openBrowser('https://auth.test/authorize?x=1');
  assert.equal(result.ok, false);
  assert.ok(result.detail, 'the failure carries a reason');
});
