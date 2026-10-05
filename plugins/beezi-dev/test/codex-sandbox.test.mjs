import '../tools/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { inCodexSandbox, SANDBOXED_CREDENTIAL_STORE_MESSAGE } from '../lib/codex-sandbox.mjs';
import { ensureEnvironmentMigrated, PRODUCTION_API_ORIGIN } from '../lib/env-migration.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';
import { tmpHome } from '../tools/suite-fixtures.mjs';

// Codex runs the model's shell commands under Seatbelt on macOS, and the base profile has no
// com.apple.SecurityServer lookup: `security find-generic-password` comes back empty, exactly as a
// locked keychain does. These cases pin that the guard then says "sandbox, escalate" — the wording
// the skills and the workspace prompt tell the model to retry on — and says it for nothing else.

const SEATBELT = { CODEX_SANDBOX: 'seatbelt', CODEX_SANDBOX_NETWORK_DISABLED: '1' };
const LEGACY_MESSAGE = 'Committed credentials could not be read; check access to the credential store and try again later';

function storeUnreadable() {
  const error = new Error(LEGACY_MESSAGE);
  error.code = 'CREDENTIALS_UNAVAILABLE';
  error.storeUnreadable = true;
  return error;
}

// A used root, so the guard has to read the credential store to classify it.
function usedRoot(t, readRawCredential, processEnv) {
  const home = tmpHome(t, 'codex-sandbox-');
  fs.mkdirSync(path.join(home, 'queue'));
  return { env: '', apiOrigin: PRODUCTION_API_ORIGIN, home: () => home, readRawCredential, processEnv };
}

test('inCodexSandbox reads the markers Codex sets on a sandboxed command', () => {
  assert.equal(inCodexSandbox({ CODEX_SANDBOX: 'seatbelt' }), true);
  assert.equal(inCodexSandbox({ CODEX_SANDBOX_NETWORK_DISABLED: '1' }), true);
  assert.equal(inCodexSandbox({}), false);
  assert.equal(inCodexSandbox({ CODEX_SANDBOX: '', CODEX_SANDBOX_NETWORK_DISABLED: '0' }), false);
});

test('the hermetic suite does not inherit a sandbox marker from the shell that runs it', () => {
  assert.equal(inCodexSandbox(), false);
});

test('a sandboxed command that cannot read the credential store is told to escalate', (t) => {
  const result = ensureEnvironmentMigrated(usedRoot(t, () => { throw storeUnreadable(); }, SEATBELT));
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'credential-store-sandboxed');
  assert.equal(result.message, SANDBOXED_CREDENTIAL_STORE_MESSAGE);
  assert.match(result.message, /sandbox/);
  assert.match(result.message, /run it again with escalated permissions/i);
  assert.doesNotMatch(result.message, /try again later/);
});

test('outside the sandbox the same failure keeps its existing message', (t) => {
  const result = ensureEnvironmentMigrated(usedRoot(t, () => { throw storeUnreadable(); }, {}));
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'inspection-or-migration-failed');
  assert.equal(result.message, `Beezi: environment verification failed (${LEGACY_MESSAGE}). No uploads are permitted.`);
});

test('inside the sandbox a different failure is not relabelled as a sandbox refusal', (t) => {
  const mismatch = new Error('Credential revision mismatch');
  mismatch.code = 'CREDENTIALS_UNAVAILABLE';
  const result = ensureEnvironmentMigrated(usedRoot(t, () => { throw mismatch; }, SEATBELT));
  assert.equal(result.reason, 'inspection-or-migration-failed');
  assert.equal(result.message, 'Beezi: environment verification failed (Credential revision mismatch). No uploads are permitted.');
});

test('a CLI error from an unreadable store under the sandbox reads as the escalation hint', () => {
  assert.equal(friendlyMessage(storeUnreadable(), { env: SEATBELT }), SANDBOXED_CREDENTIAL_STORE_MESSAGE);
  assert.equal(friendlyMessage(storeUnreadable(), { env: {} }),
    'Something went wrong. Re-run with BEEZI_DEBUG=1 to see details.');
});
