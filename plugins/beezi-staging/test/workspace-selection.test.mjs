import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHome, linkAccount, TEST_KEY } from '../tools/account-fixtures.mjs';
import { getAccount } from '../lib/accounts.mjs';
import { workspaceCommand } from '../lib/workspace-cli.mjs';

const TENANTS = [{ id: 'A', name: 'Acme' }, { id: 'B', name: 'Beta' }];
const MIX = '✗ Pick workspaces or none, not both.';

// No upload worker, no keychain, no real rollouts, and a directory with no session recorded for it.
const deps = { startHistoryWorker: async () => {}, getAuthentication: async () => null, listAllRollouts: () => [], cwd: '/work/here' };

const refused = (out) => { assert.equal(out.ok, false); assert.ok(out.stderr.join('\n').includes(MIX), out.stderr.join('\n')); };

test('rule add refuses none mixed with a workspace, in any case or separator, and saves no rule', async (t) => {
  const home = makeHome(t); linkAccount(home, TEST_KEY, { tenants: TENANTS });
  for (const refs of [['A,none'], ['NONE', 'A'], ['A, None']]) {
    refused(await workspaceCommand(['rule', 'add', '--outside', '--session', 'sess-mix', '--account', TEST_KEY, ...refs], deps));
  }
  assert.deepEqual((await getAccount(TEST_KEY)).workspaceRules || [], []);
  assert.equal(fs.existsSync(path.join(home, 'state', 'sess-mix.workspace')), false);
});

test('rule set refuses the mix and keeps the rule as it was', async (t) => {
  linkAccount(makeHome(t), TEST_KEY, { tenants: TENANTS });
  assert.equal((await workspaceCommand(['rule', 'add', '--outside', '--account', TEST_KEY, 'B'], deps)).ok, true);
  refused(await workspaceCommand(['rule', 'set', '1', 'B,none', '--account', TEST_KEY], deps));
  assert.deepEqual((await getAccount(TEST_KEY)).workspaceRules[0].tenantIds, ['B']);
});

test('rule add-all refuses the mix', async (t) => {
  linkAccount(makeHome(t), TEST_KEY, { tenants: TENANTS });
  refused(await workspaceCommand(['rule', 'add-all', '--account', TEST_KEY, 'A,none'], deps));
  assert.deepEqual((await getAccount(TEST_KEY)).workspaceRules || [], []);
});

test('new-folders send refuses the mix with the mix error, not the empty-send error', async (t) => {
  linkAccount(makeHome(t), TEST_KEY, { tenants: TENANTS });
  const before = (await getAccount(TEST_KEY)).newFolders;
  const out = await workspaceCommand(['new-folders', 'send', 'A,none', '--account', TEST_KEY], deps);
  refused(out);
  assert.ok(!out.stderr.join('\n').includes('Send needs at least one workspace'));
  assert.deepEqual((await getAccount(TEST_KEY)).newFolders, before);
});

test('none alone, and none repeated, still send nowhere', async (t) => {
  linkAccount(makeHome(t), TEST_KEY, { tenants: TENANTS });
  assert.equal((await workspaceCommand(['rule', 'add', '--outside', '--account', TEST_KEY, 'none'], deps)).ok, true);
  assert.equal((await workspaceCommand(['rule', 'add', '--repo', 'github.com/acme/api', '--account', TEST_KEY, 'none,NONE'], deps)).ok, true);
  assert.deepEqual((await getAccount(TEST_KEY)).workspaceRules.map((r) => r.tenantIds), [[], []]);
});
