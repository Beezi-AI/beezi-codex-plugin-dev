import '../tools/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouteContext } from '../lib/workspace-rules.mjs';
import { placeOfDir } from '../lib/route-describe.mjs';
import { buildBanner, workspacesText } from '../lib/session-banner.mjs';

const REPO = '/work/labacus-suite';
const REMOTE = 'github.com/acme/labacus-suite';
const ctx = () => createRouteContext({ loadRepoMapImpl: () => ({ version: 1, roots: { [REPO]: { origin: 'https://github.com/acme/labacus-suite.git' } } }) });
const A = { id: 'A', name: 'Acme' };
const N = { id: 'N', name: 'Northwind' };
const row = (over = {}) => ({ key: 'a1b2c3d4', status: 'linked', email: 'dev@acme.io', tenants: [A, N], workspaceRules: [], newFolders: { mode: 'send', tenantIds: ['A'] }, ...over });

const repoKey = { kind: 'repo', match: REMOTE, label: REMOTE };
const PLACE = { key: repoKey, short: 'labacus-suite', kind: 'repo', path: REPO, remote: REMOTE };
const OUTSIDE = { key: { kind: 'outside', match: 'outside', label: 'outside a project' }, short: 'outside a project', kind: 'outside', path: null, remote: null };
// A session state bound to one account's rule for the repo.
const bound = (key, tenantIds) => ({ version: 3, cwd: REPO, updatedAt: '', read: {}, route: { [key]: { ...repoKey, tenantIds } } });

test('one account: who, which workspaces, and where this repo goes', () => {
  assert.equal(buildBanner({ sessions: [row()], place: placeOfDir(REPO, ctx()) }), [
    'Beezi ✓ dev@acme.io, workspaces Acme and Northwind',
    '  labacus-suite → Acme (default)',
    '  Change with the settings skill (Rules)',
  ].join('\n'));
});

test('no rule yet says nothing is sent until you choose, and that Beezi asks now', () => {
  assert.equal(buildBanner({ sessions: [row({ newFolders: null })], place: placeOfDir(REPO, ctx()), asking: true }), [
    'Beezi ✓ dev@acme.io, workspaces Acme and Northwind',
    '  labacus-suite has no rule yet. Nothing is sent until you choose where it goes.',
    '  Beezi asks you now.',
  ].join('\n'));
});

test('no rule yet and nothing asked points at the settings skill', () => {
  const lines = buildBanner({ sessions: [row({ newFolders: null })], place: PLACE }).split('\n');
  assert.equal(lines[2], '  Choose with the settings skill (Rules)');
});

test('a one-workspace account in audit mode says new sessions are not tracked', () => {
  const single = row({ tenants: [A], newFolders: null });
  const out = buildBanner({ sessions: [single], place: placeOfDir(REPO, ctx()), trackingByKey: new Map([[single.key, { trackingMode: 'backfill_only' }]]) });
  assert.match(out, /^ {2}labacus-suite → Acme \(default\), but new sessions are not tracked \(audit mode\)\.$/m);
});

test('live tracking off reads on the route line', () => {
  const single = row({ tenants: [A], newFolders: null });
  const line = (tracking) => buildBanner({ sessions: [single], place: PLACE, trackingByKey: new Map([[single.key, tracking]]) }).split('\n')[1];
  assert.equal(line({ trackingMode: 'disabled' }), '  labacus-suite → Acme (default), but analytics are off for this workspace.');
  assert.equal(line({ trackingMode: 'live' }), '  labacus-suite → Acme (default)');
  const both = row({ newFolders: { mode: 'send', tenantIds: ['A', 'N'] } });
  const dark = buildBanner({ sessions: [both], place: PLACE, trackingByKey: new Map([[both.key, { darkTenants: { N: 'x' } }]]) });
  assert.equal(dark.split('\n')[1], '  labacus-suite → Acme and Northwind (default), but analytics are off in Northwind.');
});

test('a rule that sends to two workspaces is named', () => {
  const ruled = row({ workspaceRules: [{ ...repoKey, tenantIds: ['A', 'N'] }] });
  assert.equal(buildBanner({ sessions: [ruled], place: PLACE, state: bound(ruled.key, ['A', 'N']) }).split('\n')[1],
    '  labacus-suite → Acme and Northwind (rule R1)');
});

test('not tracked: by a rule says track it again, by the default says track it', () => {
  const ruled = row({ tenants: [A], newFolders: null, workspaceRules: [{ ...repoKey, tenantIds: [] }] });
  assert.equal(buildBanner({ sessions: [ruled], place: PLACE, state: bound(ruled.key, []) }), [
    'Beezi ✓ dev@acme.io, workspace Acme',
    '  labacus-suite → not tracked (rule R1). Nothing from this session is sent.',
    '  Track it again with the settings skill (Rules)',
  ].join('\n'));
  const off = buildBanner({ sessions: [row({ newFolders: { mode: 'none', tenantIds: [] } })], place: PLACE }).split('\n');
  assert.equal(off[1], '  labacus-suite → not tracked (default). Nothing from this session is sent.');
  assert.equal(off[2], '  Track it with the settings skill (Rules)');
});

test('outside a project', () => {
  const single = row({ tenants: [A], newFolders: null });
  assert.equal(buildBanner({ sessions: [single], place: OUTSIDE }).split('\n')[1], '  Sessions outside a project → Acme (default)');
  assert.equal(buildBanner({ sessions: [row({ newFolders: null })], place: OUTSIDE, asking: true }).split('\n')[1],
    '  Sessions outside a project have no rule yet. Nothing is sent until you choose where it goes.');
});

test('unknown cwd or unknown workspaces: no route line', () => {
  assert.equal(buildBanner({ sessions: [row({ tenants: [A] })], place: null }), 'Beezi ✓ dev@acme.io, workspace Acme\n  Change with the settings skill (Rules)');
  assert.equal(buildBanner({ sessions: [{ key: 'a1b2c3d4', tenantName: 'Acme' }], place: PLACE }), 'Beezi ✓ a1b2c3d4, workspace Acme\n  Change with the settings skill (Rules)');
  assert.equal(buildBanner({ sessions: [{ key: 'a1b2c3d4', name: 'Dev' }], place: null }).split('\n')[0], 'Beezi ✓ Dev');
});

test('several accounts: one aligned line each, pending wins the last line', () => {
  const a = { key: 'aaaaaaaa', email: 'dev@acme.io', tenants: [A] };
  const b = { key: 'bbbbbbbb', email: 'me@northwind.dev', tenants: [N], workspaceRules: [{ ...repoKey, tenantIds: [] }] };
  assert.equal(buildBanner({ sessions: [a, b], place: PLACE, state: bound('bbbbbbbb', []) }), [
    'Beezi ✓ 2 accounts. In labacus-suite:',
    '  dev@acme.io       → Acme (default)',
    '  me@northwind.dev  → not tracked (rule R1)',
    '  Change with the settings skill (Rules)',
  ].join('\n'));
  const ask = { key: 'bbbbbbbb', email: 'me@northwind.dev', tenants: [A, N] };
  const asked = buildBanner({ sessions: [a, ask], place: PLACE, asking: true }).split('\n');
  assert.equal(asked[2], '  me@northwind.dev  → no rule yet');
  assert.equal(asked[3], '  Beezi asks you now.');
  assert.equal(buildBanner({ sessions: [a, ask], place: PLACE }).split('\n')[3], '  Choose with the settings skill (Rules)');
  assert.equal(buildBanner({ sessions: [a, ask], place: OUTSIDE }).split('\n')[0], 'Beezi ✓ 2 accounts. Outside a project:');
  assert.equal(buildBanner({ sessions: [a, ask], place: null }), 'Beezi ✓ 2 accounts: dev@acme.io and me@northwind.dev\n  Change with the settings skill (Rules)');
});

test('workspace wording', () => {
  const many = [1, 2, 3, 4, 5].map((n) => ({ id: `t${n}`, name: `W${n}` }));
  assert.equal(workspacesText({ key: 'k', tenants: many }), 'workspaces W1, W2 and 3 more');
  assert.equal(workspacesText({ key: 'k', tenants: many.slice(0, 3) }), 'workspaces W1, W2 and W3');
  assert.equal(workspacesText({ key: 'k' }), null);
});

test('nobody signed in: no banner', () => {
  assert.equal(buildBanner({ sessions: [] }), null);
});
