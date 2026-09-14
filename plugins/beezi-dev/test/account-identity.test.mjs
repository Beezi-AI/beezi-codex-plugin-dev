// Imported first, for its side effect: every root the plugin can resolve is redirected into a
// per-process sandbox, so a missed injection cannot read the developer's own machine.
import '../tools/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountIdentityFields, readAccountIdentity } from '../lib/account-identity.mjs';

// THE single answer to "which account does this usage row belong to", and it runs on the checkpoint
// hot path — so it stays synchronous and never spawns anything. Both readers are injected here for
// the usual reason: unstubbed they open ~/.beezi-codex/billing.json and ~/.codex/auth.json.

test('the field map drops an unknown or overlong identifier rather than truncating it', () => {
  assert.deepEqual(accountIdentityFields(null), {});
  assert.deepEqual(accountIdentityFields({ accountId: '  ', email: '' }), {});
  assert.deepEqual(accountIdentityFields({ accountId: 'x'.repeat(65) }), {});
  assert.deepEqual(
    accountIdentityFields({ accountId: ' uuid ', email: 'a@b.c' }),
    { account_uuid: 'uuid', account_email: 'a@b.c' },
  );
});

test('billing.json wins — it is the only home a live app-server identity has', () => {
  const fields = readAccountIdentity({
    readBillingConfig: () => ({ accountId: 'live-uuid', email: 'live@example.com' }),
    readCodexAccount: () => ({ accountId: 'stale-uuid', email: 'stale@example.com' }),
  });
  assert.equal(fields.account_uuid, 'live-uuid');
  assert.equal(fields.account_email, 'live@example.com');
});

test('auth.json answers when billing.json has recorded no identity', () => {
  const fields = readAccountIdentity({
    readBillingConfig: () => ({ source: 'subscription', plan: 'plus' }),
    readCodexAccount: () => ({ accountId: 'from-auth-json', email: 'auth@example.com' }),
  });
  assert.equal(fields.account_uuid, 'from-auth-json');
});

test('a machine that knows nothing reports nothing, rather than throwing', () => {
  assert.deepEqual(readAccountIdentity({ readBillingConfig: () => null, readCodexAccount: () => null }), {});
});

test('a throwing reader on either side does not break the checkpoint', () => {
  const fields = readAccountIdentity({
    readBillingConfig: () => { throw new Error('unreadable'); },
    readCodexAccount: () => ({ accountId: 'from-auth-json' }),
  });
  assert.equal(fields.account_uuid, 'from-auth-json');
  assert.deepEqual(
    readAccountIdentity({
      readBillingConfig: () => ({ accountId: 'live-uuid' }),
      readCodexAccount: () => { throw new Error('unreadable'); },
    }),
    { account_uuid: 'live-uuid' },
  );
});
