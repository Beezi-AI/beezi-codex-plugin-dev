import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHome, linkAccount, TEST_KEY } from '../tools/account-fixtures.mjs';
import { clearUndo, readUndo, recordUndo, routingOf } from '../lib/rule-undo.mjs';
import { getAccount, restoreRouting, setWorkspaceRule } from '../lib/accounts.mjs';

const TENANTS = [{ id: 'A', name: 'Acme' }, { id: 'B', name: 'Beta' }];

test('the record keeps only the newest change and survives a re-read', (t) => {
  makeHome(t);
  const before = { workspaceRules: [], newFolders: null };
  const after = { workspaceRules: [{ kind: 'repo', match: 'github.com/acme/api', tenantIds: ['A'] }], newFolders: null };
  recordUndo({ account: TEST_KEY, summary: 'api → Acme (rule R1).', change: 'api → Acme (rule R1).', before, after });
  assert.equal(readUndo().change, 'api → Acme (rule R1).');
  clearUndo();
  assert.equal(readUndo(), null);
});

test('restoreRouting puts the old routing back only when nothing changed since', async (t) => {
  linkAccount(makeHome(t), TEST_KEY, { tenants: TENANTS });
  const before = routingOf(await getAccount(TEST_KEY));
  await setWorkspaceRule(TEST_KEY, { kind: 'repo', match: 'github.com/acme/api', tenantIds: ['A'] });
  const after = routingOf(await getAccount(TEST_KEY));
  assert.equal(await restoreRouting(TEST_KEY, { expected: after, before }), 'restored');
  assert.deepEqual(routingOf(await getAccount(TEST_KEY)), before);
  await setWorkspaceRule(TEST_KEY, { kind: 'repo', match: 'github.com/acme/web', tenantIds: ['B'] });
  assert.equal(await restoreRouting(TEST_KEY, { expected: after, before }), 'changed');
  assert.equal(await restoreRouting('ffffffff', { expected: after, before }), 'missing');
});
