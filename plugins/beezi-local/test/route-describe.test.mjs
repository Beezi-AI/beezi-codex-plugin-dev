import '../tools/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouteContext } from '../lib/workspace-rules.mjs';
import { placeOfDir, routeOfDir, routeText } from '../lib/route-describe.mjs';

const REPO = '/work/labacus-suite';
const REMOTE = 'github.com/acme/labacus-suite';
const MAP = { version: 1, roots: { [REPO]: { origin: 'https://github.com/acme/labacus-suite.git' } } };
const ctx = () => createRouteContext({ loadRepoMapImpl: () => MAP });
const A = { id: 'A', name: 'Acme' };
const N = { id: 'N', name: 'Northwind' };
const multi = (over = {}) => ({ key: 'a1b2c3d4', status: 'linked', tenants: [A, N], workspaceRules: [], newFolders: null, ...over });
const text = (row, dir) => routeText(row, routeOfDir(row, dir, ctx()));

test('a repo is named by its short name, with its root and remote', () => {
  const place = placeOfDir(`${REPO}/src`, ctx());
  assert.equal(place.short, 'labacus-suite');
  assert.equal(place.kind, 'repo');
  assert.equal(place.path, REPO);
  assert.equal(place.remote, REMOTE);
});

test('every route reads the same way', () => {
  assert.equal(text(multi({ newFolders: { mode: 'send', tenantIds: ['A'] } }), REPO), '→ Acme (default)');
  assert.equal(text(multi(), REPO), '→ no rule yet');
  assert.equal(text(multi({ newFolders: { mode: 'none', tenantIds: [] } }), REPO), '→ not tracked (default)');
  const ruled = multi({ workspaceRules: [{ kind: 'repo', match: REMOTE, label: REMOTE, tenantIds: ['A', 'N'] }] });
  assert.equal(text(ruled, REPO), '→ Acme and Northwind (rule R1)');
  const parent = multi({ workspaceRules: [{ kind: 'folder', match: '/work/scratch', label: '/work/scratch', tenantIds: [] }] });
  assert.equal(text(parent, '/work/scratch/notes'), '→ not tracked (rule R1 for scratch)');
  assert.equal(text({ key: 'a1b2c3d4', status: 'linked', tenants: null }, REPO), '→ workspaces not known yet');
});

test('a rule for a workspace the account left is skipped, as routing skips it', () => {
  const left = multi({
    newFolders: { mode: 'send', tenantIds: ['A'] },
    workspaceRules: [{ kind: 'repo', match: REMOTE, label: REMOTE, tenantIds: ['GONE'] }],
  });
  assert.equal(text(left, REPO), '→ Acme (default)');
});
