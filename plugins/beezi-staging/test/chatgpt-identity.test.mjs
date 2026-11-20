// Imported first, for its side effect: every root the plugin can resolve is redirected into a
// per-process sandbox, so a missed injection cannot read the developer's own machine.
import '../tools/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatgptIdentityFields, readChatgptIdentity, subscriptionKey } from '../lib/chatgpt-identity.mjs';

// THE single answer to "which account does this usage row belong to", and it runs on the checkpoint
// hot path — so it stays synchronous and never spawns anything. Both readers are injected here for
// the usual reason: unstubbed they open ~/.beezi-codex/billing.json and ~/.codex/auth.json.

test('the field map drops an unknown or overlong identifier rather than truncating it', () => {
  assert.deepEqual(chatgptIdentityFields(null), {});
  assert.deepEqual(chatgptIdentityFields({ accountId: '  ', email: '' }), {});
  assert.deepEqual(chatgptIdentityFields({ accountId: 'x'.repeat(65) }), {});
  assert.deepEqual(
    chatgptIdentityFields({ accountId: ' uuid ', email: 'a@b.c' }),
    { account_uuid: 'uuid', account_email: 'a@b.c' },
  );
});

test('billing.json wins — it is the only home a live app-server identity has', () => {
  const fields = readChatgptIdentity({
    readBillingConfig: () => ({ accountId: 'live-uuid', email: 'live@example.com' }),
    readChatgptAuth: () => ({ accountId: 'stale-uuid', email: 'stale@example.com' }),
  });
  assert.equal(fields.account_uuid, 'live-uuid');
  assert.equal(fields.account_email, 'live@example.com');
});

test('auth.json answers when billing.json has recorded no identity', () => {
  const fields = readChatgptIdentity({
    readBillingConfig: () => ({ source: 'subscription', plan: 'plus' }),
    readChatgptAuth: () => ({ accountId: 'from-auth-json', email: 'auth@example.com' }),
  });
  assert.equal(fields.account_uuid, 'from-auth-json');
});

test('a machine that knows nothing reports nothing, rather than throwing', () => {
  assert.deepEqual(readChatgptIdentity({ readBillingConfig: () => null, readChatgptAuth: () => null }), {});
});

test('a throwing reader on either side does not break the checkpoint', () => {
  const fields = readChatgptIdentity({
    readBillingConfig: () => { throw new Error('unreadable'); },
    readChatgptAuth: () => ({ accountId: 'from-auth-json' }),
  });
  assert.equal(fields.account_uuid, 'from-auth-json');
  assert.deepEqual(
    readChatgptIdentity({
      readBillingConfig: () => ({ accountId: 'live-uuid' }),
      readChatgptAuth: () => { throw new Error('unreadable'); },
    }),
    { account_uuid: 'live-uuid' },
  );
});

// A Business/Team workspace (chatgpt_account_id) is shared by every seat, so the seat
// (chatgpt_user_id) is the account and the workspace its organization — the (accountUuid,
// organizationUuid) shape the server already splits subscriptions on. Without a seat the report
// keeps the workspace-only shape every older plugin sent.
const keyCases = [
  { name: 'the seat is the account and the workspace its organization',
    config: { accountId: 'ws', userId: 'user-a' }, auth: null,
    want: { account_uuid: 'user-a', account_org_uuid: 'ws' } },
  { name: 'auth.json fills a seat billing.json lacks, for the same workspace',
    config: { accountId: 'ws', userId: null }, auth: { accountId: 'ws', userId: 'user-a' },
    want: { account_uuid: 'user-a', account_org_uuid: 'ws' } },
  { name: 'a seat from another workspace is never paired with this one',
    config: { accountId: 'ws', userId: null }, auth: { accountId: 'ws-other', userId: 'user-b' },
    want: { account_uuid: 'ws' } },
  { name: 'auth.json alone gives both ids',
    config: null, auth: { accountId: 'ws', userId: 'user-a' },
    want: { account_uuid: 'user-a', account_org_uuid: 'ws' } },
  { name: 'no seat anywhere keeps the workspace-only shape',
    config: { accountId: 'ws' }, auth: { accountId: 'ws' },
    want: { account_uuid: 'ws' } },
  { name: 'an overlong seat is dropped, not truncated',
    config: { accountId: 'ws', userId: 'u'.repeat(65) }, auth: null,
    want: { account_uuid: 'ws' } },
  { name: 'a seat without a workspace names nothing',
    config: { userId: 'user-a' }, auth: null,
    want: {} },
];
for (const c of keyCases) {
  test(`subscriptionKey — ${c.name}`, () => {
    assert.deepEqual(subscriptionKey(c.config, c.auth), c.want);
  });
}

test('two seats of one Business workspace report two accounts under one organization', () => {
  const seat = (userId, email) => readChatgptIdentity({
    readBillingConfig: () => ({ accountId: 'ws-business', userId, email }),
    readChatgptAuth: () => null,
  });
  assert.deepEqual(seat('user-a', 'a@example.com'),
    { account_uuid: 'user-a', account_org_uuid: 'ws-business', account_email: 'a@example.com' });
  assert.deepEqual(seat('user-b', 'b@example.com'),
    { account_uuid: 'user-b', account_org_uuid: 'ws-business', account_email: 'b@example.com' });
});

test('a keychain machine whose billing.json predates the seat still finds it in auth.json', () => {
  const fields = readChatgptIdentity({
    readBillingConfig: () => ({ accountId: 'ws', email: 'a@example.com' }),
    readChatgptAuth: () => ({ accountId: 'ws', userId: 'user-a', email: 'a@example.com' }),
  });
  assert.deepEqual(fields, { account_uuid: 'user-a', account_org_uuid: 'ws', account_email: 'a@example.com' });
});
