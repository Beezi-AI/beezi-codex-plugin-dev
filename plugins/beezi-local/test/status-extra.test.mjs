import '../tools/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { createRouteContext } from '../lib/workspace-rules.mjs';
import { pluginInfo, statusExtraLines } from '../lib/status-extra.mjs';

const REPO = '/work/labacus-suite';
const ctx = () => createRouteContext({ loadRepoMapImpl: () => ({ version: 1, roots: { [REPO]: { origin: 'https://github.com/acme/labacus-suite.git' } } }) });
const row = { key: 'a1b2c3d4', status: 'linked', email: 'dev@acme.io', tenants: [{ id: 'A', name: 'Acme' }], workspaceRules: [] };
const CURRENT = { installed: '0.23.0', latest: '0.23.0', checkedAt: '2026-10-21T09:00:00.000Z' };

test('the route line and an up-to-date plugin', () => {
  assert.deepEqual(statusExtraLines({ rows: [row], dir: REPO, ctx: ctx(), tracking: {}, plugin: CURRENT }), [
    'This repo: labacus-suite → Acme (default)',
    'Plugin: 0.23.0, the newest',
  ]);
});

test('an update names the version, when it was seen, and the steps', () => {
  const plugin = { installed: '0.22.10', latest: '0.23.0', checkedAt: '2026-10-21T09:00:00.000Z' };
  assert.deepEqual(statusExtraLines({ rows: [row], dir: REPO, ctx: ctx(), tracking: {}, plugin }).slice(1), [
    'Plugin: 0.22.10. Update available: 0.23.0 (last checked 2026-10-21 09:00 UTC)',
    '',
    'To update to 0.23.0:',
    '  Run: codex plugin marketplace upgrade',
    '  Then start a new Codex thread to apply it.',
  ]);
});

test('no cached reading says so, and nothing is fetched', () => {
  const plugin = { installed: '0.23.0', latest: null, checkedAt: null };
  assert.equal(statusExtraLines({ rows: [], dir: REPO, ctx: ctx(), tracking: {}, plugin })[0], 'Plugin: 0.23.0 (could not check for updates)');
});

test('a local build ahead of the published one says so and offers no steps', () => {
  const plugin = { installed: '0.24.0', latest: '0.23.0', checkedAt: '2026-10-21T09:00:00.000Z' };
  assert.deepEqual(statusExtraLines({ rows: [], dir: REPO, ctx: ctx(), tracking: {}, plugin }), [
    'Plugin: 0.24.0, newer than the published 0.23.0',
  ]);
});

test('a variant build behind its release compares the way the update check does', () => {
  const plugin = { installed: '0.23.0-dev.12', latest: '0.23.0-dev.13', checkedAt: '2026-10-21T09:00:00.000Z' };
  assert.equal(statusExtraLines({ rows: [], dir: REPO, ctx: ctx(), tracking: {}, plugin })[0],
    'Plugin: 0.23.0-dev.12. Update available: 0.23.0-dev.13 (last checked 2026-10-21 09:00 UTC)');
});

test('home keys as outside a project', () => {
  assert.equal(statusExtraLines({ rows: [row], dir: os.homedir(), ctx: ctx(), tracking: {}, plugin: CURRENT })[0],
    'Here: sessions outside a project → Acme (default)');
});

test('audit mode adds the banner note to the route line', () => {
  const tracking = { [row.key]: { trackingMode: 'backfill_only' } };
  assert.equal(statusExtraLines({ rows: [row], dir: REPO, ctx: ctx(), tracking, plugin: CURRENT })[0],
    'This repo: labacus-suite → Acme (default), but new sessions are not tracked (audit mode)');
});

test('an account whose workspaces are not known yet gets no route line', () => {
  const unknown = { ...row, tenants: null };
  assert.deepEqual(statusExtraLines({ rows: [unknown], dir: REPO, ctx: ctx(), tracking: {}, plugin: CURRENT }), [
    'Plugin: 0.23.0, the newest',
  ]);
});

test('pluginInfo reads the installed version and the cached check, never the network', () => {
  const info = pluginInfo({
    readPluginJson: () => ({ name: 'beezi', version: '0.22.10' }),
    updateCheckFile: () => '/cache/update-check.json',
    readJson: () => ({ checkedAt: Date.parse('2026-10-21T09:00:00.000Z'), latest: '0.23.0' }),
    fetchImpl: async () => { throw new Error('beezi_status must not reach the network'); },
  });
  assert.deepEqual(info, { installed: '0.22.10', latest: '0.23.0', checkedAt: '2026-10-21T09:00:00.000Z' });
});

test('pluginInfo with no cache leaves latest unknown', () => {
  const info = pluginInfo({
    readPluginJson: () => ({ name: 'beezi', version: '0.23.0' }),
    updateCheckFile: () => '/cache/update-check.json',
    readJson: () => null,
  });
  assert.deepEqual(info, { installed: '0.23.0', latest: null, checkedAt: null });
});

test('several accounts: each route line names its account, one account names none', () => {
  const other = { key: '99887766', status: 'linked', email: 'dev@northwind.io', tenants: [{ id: 'N', name: 'Northwind' }], workspaceRules: [] };
  assert.deepEqual(statusExtraLines({ rows: [row, other], dir: REPO, ctx: ctx(), tracking: {}, plugin: CURRENT }), [
    'This repo (dev@acme.io): labacus-suite → Acme (default)',
    'This repo (dev@northwind.io): labacus-suite → Northwind (default)',
    'Plugin: 0.23.0, the newest',
  ]);
  assert.equal(statusExtraLines({ rows: [row], dir: '/', ctx: ctx(), tracking: {}, plugin: CURRENT })[0],
    'Here: sessions outside a project → Acme (default)');
});

test('no recorded folder prints no route line', () => {
  assert.deepEqual(statusExtraLines({ rows: [row], dir: null, ctx: ctx(), tracking: {}, plugin: CURRENT }), [
    'Plugin: 0.23.0, the newest',
  ]);
});

test('a revoked account gets no route line, and the one left is not suffixed', () => {
  const revoked = { ...row, key: '99887766', email: 'old@acme.io', status: 'revoked' };
  assert.deepEqual(statusExtraLines({ rows: [row, revoked], dir: REPO, ctx: ctx(), tracking: {}, plugin: CURRENT }), [
    'This repo: labacus-suite → Acme (default)',
    'Plugin: 0.23.0, the newest',
  ]);
});

test('a row whose route throws drops only its own line', () => {
  const broken = Object.defineProperty({ ...row, key: '99887766', email: 'broken@acme.io' }, 'tenants', {
    get() { throw new Error('unreadable row'); },
  });
  assert.deepEqual(statusExtraLines({ rows: [row, broken], dir: REPO, ctx: ctx(), tracking: {}, plugin: CURRENT }), [
    'This repo (dev@acme.io): labacus-suite → Acme (default)',
    'Plugin: 0.23.0, the newest',
  ]);
});

test('a row whose tracking or label read throws drops only its own line', () => {
  const other = { key: '99887766', status: 'linked', email: 'dev@northwind.io', tenants: [{ id: 'N', name: 'Northwind' }], workspaceRules: [] };
  // liveOffNote reads trackingMode for a one-workspace account.
  const tracking = { [other.key]: Object.defineProperty({}, 'trackingMode', { get() { throw new Error('unreadable tracking'); } }) };
  assert.deepEqual(statusExtraLines({ rows: [row, other], dir: REPO, ctx: ctx(), tracking, plugin: CURRENT }), [
    'This repo (dev@acme.io): labacus-suite → Acme (default)',
    'Plugin: 0.23.0, the newest',
  ]);
  const unlabeled = Object.defineProperty({ ...other }, 'email', { get() { throw new Error('unreadable email'); } });
  assert.deepEqual(statusExtraLines({ rows: [row, unlabeled], dir: REPO, ctx: ctx(), tracking: {}, plugin: CURRENT }), [
    'This repo (dev@acme.io): labacus-suite → Acme (default)',
    'Plugin: 0.23.0, the newest',
  ]);
});
