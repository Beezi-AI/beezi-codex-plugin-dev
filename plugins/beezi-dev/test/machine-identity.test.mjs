import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  setMachineClientId,
  getMachineClientId,
  machineHeaders,
} from '../lib/machine-identity.mjs';
import { loadLedger, saveLedger, markImported, isImported } from '../lib/audit-ledger.mjs';
import { AGENT } from '../lib/config.mjs';

// G-8-5. lib/machine-identity.mjs had zero coverage. It is 29 lines holding ONE module-level
// variable — this process's OAuth client id — and that variable is the binding key for the
// backfill ledger, where getting it wrong is a permanent, unrecoverable outcome
// (lib/audit-ledger.mjs:15-18: a replayed ledger "would ... seal the new tenant's pull EMPTY
// (there is no reopen)").
//
// HERMETICITY. machineHeaders() calls os.hostname(), which is real machine state and is not
// injectable — `os` is a module-level import at machine-identity.mjs:1. Every test here stubs
// os.hostname on the module object rather than reading the developer's, so no assertion in this
// file depends on the machine it runs on. The ledger test writes only under os.tmpdir().

const FAKE_HOST = 'test-host';
let savedHostname;

beforeEach(() => {
  savedHostname = os.hostname;
  os.hostname = () => FAKE_HOST;
  // Module-level state is exactly what makes a suite order-dependent: without this, test N's
  // client id decides test N+1's headers. Reset before AND after, so a bare `node --test` of a
  // single test in this file starts from the same place as a full run.
  setMachineClientId(null);
});

afterEach(() => {
  os.hostname = savedHostname;
  setMachineClientId(null);
});

// ── 1. the X-Beezi-Client truthiness gate (machine-identity.mjs:27) ─────────────────────────────

test('1. machineHeaders omits X-Beezi-Client until an id is set, then carries it', () => {
  const before = machineHeaders();
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(before, 'X-Beezi-Client'),
    false,
    'an unset id must not appear as a header at all — not as null, not as ""',
  );

  setMachineClientId('client-abc');
  assert.strictEqual(machineHeaders()['X-Beezi-Client'], 'client-abc');
});

// :27 is `if (clientId)`, a truthiness check rather than a null check, so an empty-string client
// id is dropped as silently as an unset one. Pinned because the two are indistinguishable to the
// server and only this assertion says which values reach it.
test('1b. an empty-string client id is treated as absent', () => {
  setMachineClientId('');
  assert.strictEqual(getMachineClientId(), '', 'the value is stored verbatim — "" is not null');
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(machineHeaders(), 'X-Beezi-Client'),
    false,
    'but the header is omitted, because :27 tests truthiness',
  );
});

// ── 2. the null normalisation lib/audit-ledger.mjs:26 branches on ───────────────────────────────

// `orDefault(id, null)` at :10 is load-bearing: audit-ledger.mjs:26 is `raw.identity && identity
// && ...`, and a stored `undefined` would behave the same there but read differently everywhere
// that compares to null. strictEqual, not equal — under loose equality this test is vacuous.
test('2. setMachineClientId normalises null and undefined to exactly null', () => {
  setMachineClientId('client-abc');
  assert.strictEqual(getMachineClientId(), 'client-abc');

  setMachineClientId(undefined);
  assert.strictEqual(getMachineClientId(), null, 'undefined becomes null, not undefined');
  assert.notStrictEqual(getMachineClientId(), undefined);

  setMachineClientId('client-abc');
  setMachineClientId(null);
  assert.strictEqual(getMachineClientId(), null);

  // No argument at all is the shape a caller reaches when creds.client_id is missing from an
  // older credentials file (lib/token.mjs:69 passes it straight through).
  setMachineClientId('client-abc');
  setMachineClientId();
  assert.strictEqual(getMachineClientId(), null);
});

// The initial value, before anything has run. This is the state session-audit.mjs:256 reads in
// the hazard below.
test('2b. getMachineClientId is null before any setter call', () => {
  assert.strictEqual(getMachineClientId(), null);
});

// ── 3. the vendor header ────────────────────────────────────────────────────────────────────────

// A value assertion, not a shape one: the server attributes a machine and its analytics to the
// Codex client off this header and nothing else. If it ever said 'claude-code', Codex sessions
// would land in the Claude Code plugin's bucket with no other signal that anything moved.
test('3. X-Beezi-Agent is exactly "codex"', () => {
  assert.strictEqual(machineHeaders()['X-Beezi-Agent'], 'codex');
  assert.strictEqual(AGENT, 'codex', 'and it is the config constant, not a second literal');
  assert.strictEqual(machineHeaders()['X-Beezi-Agent'], AGENT);
});

// ── 4. the host header ──────────────────────────────────────────────────────────────────────────

test('4. X-Beezi-Host is truncated at 255 characters', (t) => {
  os.hostname = () => 'h'.repeat(400);
  const long = machineHeaders()['X-Beezi-Host'];
  assert.strictEqual(long.length, 255, 'a 400-character hostname is cut to exactly 255');
  assert.strictEqual(long, 'h'.repeat(255));

  // A short hostname is passed through untouched — the slice must not be a fixed-width pad.
  os.hostname = () => 'short-host';
  assert.strictEqual(machineHeaders()['X-Beezi-Host'], 'short-host');

  // String() at :24 is what keeps a non-string hostname from throwing on .slice.
  os.hostname = () => undefined;
  assert.doesNotThrow(() => machineHeaders());
  assert.strictEqual(machineHeaders()['X-Beezi-Host'], 'undefined');
  t.diagnostic('hostname stubbed throughout; the real machine name is never read');
});

test('4b. machineHeaders returns a fresh object each call', () => {
  const a = machineHeaders();
  a['X-Beezi-Host'] = 'mutated';
  assert.strictEqual(machineHeaders()['X-Beezi-Host'], FAKE_HOST, 'no shared header object');
});

// ── 5. THE ORDERING HAZARD ──────────────────────────────────────────────────────────────────────

function makeHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-identity-'));
  const prev = process.env.BEEZI_CODEX_HOME;
  process.env.BEEZI_CODEX_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CODEX_HOME;
    else process.env.BEEZI_CODEX_HOME = prev;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });
  return dir;
}

// The regression test for the ordering hazard this ratchet uncovered. It was written to pin the
// BUG, then inverted in the same commit as the fix to lib/audit-ledger.mjs.
//
// The ordering. `clientId` is written by lib/token.mjs:69, lib/login.mjs:138 and :199, and read by
// lib/session-audit.mjs:256 (`const identity = getMachineClientId()`), which hands it to
// loadLedger at :285. The read is only safe because a write is supposed to have happened first —
// session-audit.mjs:252-255 says as much ("getAccessToken primed the machine client id").
//
// When that write did NOT happen first — no credentials, an injected getAccessToken, or a
// credentials file with no client_id, all of which leave the id null — the OLD guard
// (`raw.identity && identity && raw.identity !== identity`) needed BOTH sides truthy, so a null
// identity did not fail the check: it SKIPPED it, the foreign ledger was merged, and the previous
// tenant's imported-session set was trusted under the current login. The guard now tests only
// `raw.identity`, so an unidentified caller discards rather than inherits.
test('5. ORDERING HAZARD — a null client id discards a foreign ledger rather than merging it', (t) => {
  makeHome(t);

  // A ledger left behind by a previous login, bound to that login's identity.
  const previous = loadLedger('client-a');
  markImported(previous, 'sess-1', { outcome: 'accepted', reports: 3 });
  saveLedger(previous);

  // The read-before-write ordering: session-audit reaches getMachineClientId() before anything
  // has set it.
  assert.strictEqual(getMachineClientId(), null, 'the precondition — the setter has not run');

  const merged = loadLedger(getMachineClientId());

  assert.strictEqual(
    isImported(merged, 'sess-1'),
    false,
    'another identity\'s imported sessions are not trusted under a null identity',
  );
  assert.strictEqual(merged.identity, null, 'and the foreign identity is not carried forward');
});

// The contrast, and the reason the hazard is an ORDERING one rather than a stability one: the
// exact same ledger, the exact same call, with the write ordered before the read — and the
// discard fires. Nothing about the ledger changed; only when setMachineClientId ran.
test('5b. the same load with the id primed first discards the foreign ledger', (t) => {
  makeHome(t);

  const previous = loadLedger('client-a');
  markImported(previous, 'sess-1', { outcome: 'accepted', reports: 3 });
  saveLedger(previous);

  setMachineClientId('client-b'); // what lib/token.mjs:69 does before session-audit reads.

  const fresh = loadLedger(getMachineClientId());

  assert.strictEqual(isImported(fresh, 'sess-1'), false, 'the foreign ledger is discarded');
  assert.strictEqual(fresh.identity, 'client-b');
});

// ── 6. state isolation ──────────────────────────────────────────────────────────────────────────

// Asserted rather than assumed: the beforeEach/afterEach reset above is the only thing standing
// between this file and an order-dependent suite, and a reset that is quietly deleted leaves
// every test still passing in file order while failing when run alone.
test('6. module state does not leak out of a test', () => {
  assert.strictEqual(getMachineClientId(), null, 'the previous test\'s id did not survive');
  setMachineClientId('client-leaky');
  assert.strictEqual(getMachineClientId(), 'client-leaky');
});

test('6b. and the leak from the previous test really was cleaned up', () => {
  assert.strictEqual(getMachineClientId(), null);
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(machineHeaders(), 'X-Beezi-Client'),
    false,
  );
});
