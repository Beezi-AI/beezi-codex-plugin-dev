import '../tools/hermetic-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  compareVersions,
  versionFromManifest,
  installedPlugin,
  checkForUpdate,
  updateNotice,
} from '../lib/update-check.mjs';

// G-8-4. The audit called it "blocked upstream" and half of that holds: nothing here updates
// anything, because Codex's remote-marketplace support is unverified (M-8-3). What is tested is
// the half that was never blocked — the plugin carries a version, and now something reads it.

function stateFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-update-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } });
  return () => path.join(dir, 'update-check.json');
}

function manifestResponse(doc, ok = true) {
  return async () => ({ ok, json: async () => doc });
}

// ── version comparison ──────────────────────────────────────────────────────────────────────

test('compare — plain releases order numerically, not lexically', () => {
  assert.equal(compareVersions('0.7.0', '0.7.1'), -1);
  assert.equal(compareVersions('0.7.0', '0.7.0'), 0);
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1, '10 > 9, which a string compare gets wrong');
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
});

test('compare — a prerelease build is BEHIND the plain release of the same core', () => {
  // The internal publishes are 0.7.0-staging.<buildId>; the public build is 0.7.0.
  assert.equal(compareVersions('0.7.0-staging.4821', '0.7.0'), -1);
  assert.equal(compareVersions('0.7.0', '0.7.0-staging.4821'), 1);
});

test('compare — two internal builds order by build NUMBER, so .10 beats .9', () => {
  assert.equal(compareVersions('0.7.0-staging.9', '0.7.0-staging.10'), -1);
  assert.equal(compareVersions('0.7.0-staging.4821', '0.7.0-staging.4102'), 1);
  assert.equal(compareVersions('0.7.0-staging.7', '0.7.0-staging.7'), 0);
});

test('compare — a core bump outranks any prerelease on the older core', () => {
  assert.equal(compareVersions('0.7.0-staging.99999', '0.8.0-staging.1'), -1);
});

test('compare — anything unparseable answers null rather than a guess', () => {
  assert.equal(compareVersions('0.7', '0.7.0'), null);
  assert.equal(compareVersions('latest', '0.7.0'), null);
  assert.equal(compareVersions(null, '0.7.0'), null);
  assert.equal(compareVersions('0.7.0', undefined), null);
});

// ── the manifest ────────────────────────────────────────────────────────────────────────────

test('manifest — a plugin manifest answers its version', () => {
  assert.equal(versionFromManifest({ name: 'beezi', version: '0.8.0' }, 'beezi'), '0.8.0');
});

test('manifest — a manifest for a SIBLING variant is not this build\'s update', () => {
  // The internal repo holds beezi-dev and beezi-staging side by side.
  assert.equal(versionFromManifest({ name: 'beezi-dev', version: '9.9.9' }, 'beezi-staging'), null);
});

test('manifest — a marketplace document answers null: its schema has no version (R1)', () => {
  const marketplace = { name: 'beezi', plugins: [{ name: 'beezi', source: { source: 'local' } }] };
  assert.equal(versionFromManifest(marketplace, 'beezi'), null);
});

test('manifest — garbage answers null', () => {
  assert.equal(versionFromManifest(null, 'beezi'), null);
  assert.equal(versionFromManifest('0.8.0', 'beezi'), null);
  assert.equal(versionFromManifest({ version: 7 }, 'beezi'), null);
});

test('the installed plugin reports this build\'s own name and version', () => {
  const me = installedPlugin();
  assert.ok(me, '.codex-plugin/plugin.json is readable from the module');
  assert.equal(me.name, 'beezi');
  assert.match(me.version, /^\d+\.\d+\.\d+/);
});

// ── the check ───────────────────────────────────────────────────────────────────────────────

test('check — a newer published version is reported, with both versions named', async (t) => {
  const result = await checkForUpdate({
    manifestUrl: () => 'https://manifest.test/plugin.json',
    readPluginJson: () => ({ name: 'beezi', version: '0.7.0' }),
    fetchImpl: manifestResponse({ name: 'beezi', version: '0.8.0' }),
    updateCheckFile: stateFile(t),
  });
  assert.equal(result.status, 'behind');
  assert.equal(result.current, '0.7.0');
  assert.equal(result.latest, '0.8.0');
  const notice = updateNotice(result);
  assert.ok(notice.includes('0.8.0'));
  assert.ok(notice.includes('0.7.0'));
});

test('check — the same version is silent, and so is a LOCAL build that runs ahead', async (t) => {
  const base = {
    manifestUrl: () => 'https://manifest.test/plugin.json',
    fetchImpl: manifestResponse({ name: 'beezi', version: '0.7.0' }),
  };
  const same = await checkForUpdate({ ...base, readPluginJson: () => ({ name: 'beezi', version: '0.7.0' }), updateCheckFile: stateFile(t) });
  assert.equal(same.status, 'current');
  assert.equal(updateNotice(same), null);

  const ahead = await checkForUpdate({ ...base, readPluginJson: () => ({ name: 'beezi', version: '0.9.0' }), updateCheckFile: stateFile(t) });
  assert.equal(ahead.status, 'current');
  assert.equal(updateNotice(ahead), null);
});

test('check — a build that was never stamped makes NO request at all', async (t) => {
  let requests = 0;
  const result = await checkForUpdate({
    manifestUrl: () => null,
    readPluginJson: () => ({ name: 'beezi', version: '0.7.0' }),
    fetchImpl: async () => { requests += 1; return { ok: true, json: async () => ({}) }; },
    updateCheckFile: stateFile(t),
  });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'no-manifest');
  assert.equal(requests, 0);
});

test('check — at most one request a day, and the answer survives the quiet period', async (t) => {
  const file = stateFile(t);
  let requests = 0;
  const deps = {
    manifestUrl: () => 'https://manifest.test/plugin.json',
    readPluginJson: () => ({ name: 'beezi', version: '0.7.0' }),
    fetchImpl: async () => { requests += 1; return { ok: true, json: async () => ({ name: 'beezi', version: '0.8.0' }) }; },
    updateCheckFile: file,
    now: () => 1_000_000,
  };
  assert.equal((await checkForUpdate(deps)).status, 'behind');
  assert.equal(requests, 1);

  // An hour later: no second request, and the nag still stands — the user upgrading is what
  // clears it, not the clock.
  const soon = await checkForUpdate({ ...deps, now: () => 1_000_000 + 3_600_000 });
  assert.equal(soon.status, 'behind');
  assert.equal(soon.cached, true);
  assert.equal(requests, 1);

  // A day later it asks again.
  await checkForUpdate({ ...deps, now: () => 1_000_000 + 25 * 3_600_000 });
  assert.equal(requests, 2);
});

test('check — upgrading clears the remembered nag without waiting for the next check', async (t) => {
  const file = stateFile(t);
  const fetchImpl = manifestResponse({ name: 'beezi', version: '0.8.0' });
  const now = () => 2_000_000;
  assert.equal((await checkForUpdate({
    manifestUrl: () => 'https://m.test/p.json', readPluginJson: () => ({ name: 'beezi', version: '0.7.0' }),
    fetchImpl, updateCheckFile: file, now,
  })).status, 'behind');

  // Same state file, newer build installed, still inside the quiet window.
  const after = await checkForUpdate({
    manifestUrl: () => 'https://m.test/p.json', readPluginJson: () => ({ name: 'beezi', version: '0.8.0' }),
    fetchImpl, updateCheckFile: file, now: () => 2_000_000 + 60_000,
  });
  assert.equal(after.status, 'skipped');
  assert.equal(updateNotice(after), null);
});

test('check — an offline machine is silent, and does not retry every session', async (t) => {
  const file = stateFile(t);
  let requests = 0;
  const deps = {
    manifestUrl: () => 'https://manifest.test/plugin.json',
    readPluginJson: () => ({ name: 'beezi', version: '0.7.0' }),
    fetchImpl: async () => { requests += 1; throw new Error('ENOTFOUND'); },
    updateCheckFile: file,
    now: () => 5_000_000,
  };
  const result = await checkForUpdate(deps);
  assert.equal(result.status, 'skipped');
  assert.equal(updateNotice(result), null);
  assert.equal(requests, 1);

  // The failure stamped the clock: without that, an unreachable manifest costs a request inside
  // the hook budget on every session start, forever.
  await checkForUpdate({ ...deps, now: () => 5_000_000 + 60_000 });
  assert.equal(requests, 1);
});

test('check — a non-2xx manifest is treated as no answer, not as version zero', async (t) => {
  const result = await checkForUpdate({
    manifestUrl: () => 'https://manifest.test/plugin.json',
    readPluginJson: () => ({ name: 'beezi', version: '0.7.0' }),
    fetchImpl: manifestResponse({ message: 'Not Found' }, false),
    updateCheckFile: stateFile(t),
  });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'no-published-version');
});

test('check — every request carries an abort signal, so a hung host cannot stall the hook', async (t) => {
  let seen = null;
  await checkForUpdate({
    manifestUrl: () => 'https://manifest.test/plugin.json',
    readPluginJson: () => ({ name: 'beezi', version: '0.7.0' }),
    fetchImpl: async (_u, init) => { seen = init; return { ok: true, json: async () => ({ name: 'beezi', version: '0.7.0' }) }; },
    updateCheckFile: stateFile(t),
  });
  assert.ok(seen && seen.signal, 'no signal means no timeout');
});

test('check — a manifest the plugin cannot version does not erase the last known one', async (t) => {
  const file = stateFile(t);
  const deps = {
    manifestUrl: () => 'https://manifest.test/plugin.json',
    readPluginJson: () => ({ name: 'beezi', version: '0.7.0' }),
    updateCheckFile: file,
  };
  await checkForUpdate({ ...deps, fetchImpl: manifestResponse({ name: 'beezi', version: '0.8.0' }), now: () => 10_000_000 });
  // A day later the manifest is briefly a marketplace document (a mis-stamped publish).
  const later = await checkForUpdate({
    ...deps,
    fetchImpl: manifestResponse({ plugins: [] }),
    now: () => 10_000_000 + 25 * 3_600_000,
  });
  assert.equal(later.status, 'skipped');
  const stored = JSON.parse(fs.readFileSync(file(), 'utf-8'));
  assert.equal(stored.latest, '0.8.0', 'the known version survives a bad answer');
});
