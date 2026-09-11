import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BEEZI_HOOKS,
  BEEZI_STATUS_MESSAGE,
  buildHookEntries,
  hookOwner,
  hooksStatus,
  installHooks,
  removeBeeziHooks,
  uninstallHooks,
} from '../lib/hooks-install.mjs';

// G-1-7 / R1 — sibling hook isolation.
//
// `~/.codex/hooks.json` belongs to Codex and is NOT namespaced by BEEZI_ENV, so every installed
// variant merges into the same file. The defect R1 reproduced: one recogniser matched ANY variant's
// handler, so installing beezi-staging stripped beezi's entries and vice versa. These tests are the
// regression lock, and they run the matrix R1 asks for — install, upgrade and uninstall of prod and
// staging in BOTH orders, with a sibling and a user hook present throughout.
//
// `owner` is injected rather than resolved from the environment: lib/paths.mjs freezes BEEZI_ENV at
// module load, so reading it would force one child process per variant for what is a pure merge.

const PROD = 'beezi';
const STAGING = 'beezi-staging';
const DEV = 'beezi-dev';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-hookown-'));
}

// The real install layout, measured on a live machine:
//   ~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/scripts
// The plugin segment carries the variant name, and the version segment moves on every upgrade —
// which is exactly why ownership cannot be anchored on the script path alone.
function variantScriptsDir(root, owner, version = '0.7.0') {
  const marketplace = owner === PROD ? 'beezi' : 'beezi-internal';
  return path.join(root, 'plugins', 'cache', marketplace, owner, version, 'scripts');
}

// Each variant's launcher dir is hookLauncherDir() = ~/.beezi-codex<suffix>/hooks, already
// namespaced by G-2-2. Mirrored here so the legacy-migration path is exercised per variant.
function variantLauncherDir(root, owner) {
  return path.join(root, owner === PROD ? '.beezi-codex' : `.beezi-codex-${owner.slice('beezi-'.length)}`, 'hooks');
}

const USER_HOOK = { type: 'command', command: '/usr/local/bin/audit' };

function withUserHook(hooksFile) {
  fs.writeFileSync(hooksFile, JSON.stringify({
    hooks: { PreCompact: [{ matcher: '.*', hooks: [USER_HOOK] }] },
  }, null, 2));
}

function readRegistry(hooksFile) {
  return JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
}

// Every handler in the registry the given owner would claim, flattened across events.
function handlersOf(registry, owner, launcherDir) {
  const stripped = removeBeeziHooks(registry, launcherDir, owner);
  const before = [];
  const after = [];
  for (const groups of Object.values(registry.hooks || {})) {
    if (Array.isArray(groups)) for (const g of groups) before.push(...(g.hooks || []));
  }
  for (const groups of Object.values(stripped.hooks || {})) {
    if (Array.isArray(groups)) for (const g of groups) after.push(...(g.hooks || []));
  }
  return before.filter((h) => !after.includes(h));
}

function bench(t) {
  const root = tmpdir();
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });
  const hooksFile = path.join(root, '.codex', 'hooks.json');
  fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
  const opts = (owner, version) => ({
    scriptsDir: variantScriptsDir(root, owner, version),
    launcherDir: variantLauncherDir(root, owner),
    hooksFile,
    owner,
  });
  return { root, hooksFile, opts };
}

test('hookOwner() is the plugin name, and the unsuffixed build resolves to it', () => {
  // The hermetic gate deletes BEEZI_ENV and the tree ships no env.json, so this process is the
  // production variant. That is the identity the shipped installer writes under.
  assert.equal(hookOwner(), PROD);
});

test('the unsuffixed build writes exactly the entry that ships today — no tag, no relabel', () => {
  // Load-bearing: a changed entry is an entry Codex asks the user to re-trust through /hooks.
  // Existing installs must not be churned by a feature that only concerns variants.
  const scriptsDir = variantScriptsDir('/r', PROD);
  const entries = buildHookEntries({ scriptsDir, owner: PROD });
  for (const { event, script } of BEEZI_HOOKS) {
    const handler = entries[event][0].hooks[0];
    assert.deepEqual(handler.arguments, [path.join(scriptsDir, script)], 'no owner tag on production');
    assert.equal(handler.statusMessage, BEEZI_STATUS_MESSAGE);
  }
});

test('a named variant tags its arguments and namespaces the label', () => {
  const scriptsDir = variantScriptsDir('/r', STAGING);
  const entries = buildHookEntries({ scriptsDir, owner: STAGING });
  for (const { event, script } of BEEZI_HOOKS) {
    const handler = entries[event][0].hooks[0];
    assert.deepEqual(handler.arguments, [path.join(scriptsDir, script), '--beezi-owner=beezi-staging']);
    // Visible in /hooks, so two installed variants are distinguishable while being reviewed —
    // the same reason the variant builder namespaces interface.displayName.
    assert.equal(handler.statusMessage, 'Beezi analytics (staging)');
  }
  const dev = buildHookEntries({ scriptsDir: variantScriptsDir('/r', DEV), owner: DEV });
  assert.equal(dev.Stop[0].hooks[0].statusMessage, 'Beezi analytics (dev)');
  assert.equal(dev.Stop[0].hooks[0].arguments[1], '--beezi-owner=beezi-dev');
});

test('install prod then staging: both variants are registered, neither stripped the other', (t) => {
  const { hooksFile, opts } = bench(t);
  withUserHook(hooksFile);

  installHooks(opts(PROD));
  installHooks(opts(STAGING));

  assert.equal(hooksStatus(opts(PROD)).state, 'installed');
  assert.equal(hooksStatus(opts(STAGING)).state, 'installed');
  const registry = readRegistry(hooksFile);
  for (const { event } of BEEZI_HOOKS) {
    assert.equal(registry.hooks[event].length, 2, `${event} carries one group per variant`);
  }
  assert.deepEqual(registry.hooks.PreCompact[0].hooks, [USER_HOOK], 'the user hook is untouched');
});

test('install staging then prod: the other order behaves identically', (t) => {
  const { hooksFile, opts } = bench(t);
  withUserHook(hooksFile);

  installHooks(opts(STAGING));
  installHooks(opts(PROD));

  assert.equal(hooksStatus(opts(PROD)).state, 'installed');
  assert.equal(hooksStatus(opts(STAGING)).state, 'installed');
  const registry = readRegistry(hooksFile);
  for (const { event } of BEEZI_HOOKS) assert.equal(registry.hooks[event].length, 2);
  assert.deepEqual(registry.hooks.PreCompact[0].hooks, [USER_HOOK]);
});

test('upgrading one variant leaves the sibling on its own scripts', (t) => {
  const { hooksFile, opts } = bench(t);
  installHooks(opts(STAGING, '0.7.0-staging.41'));
  installHooks(opts(PROD, '0.7.0'));

  // Prod moves to a new versioned cache directory; staging did not move.
  installHooks(opts(PROD, '0.8.0'));

  assert.equal(hooksStatus(opts(PROD, '0.8.0')).state, 'installed');
  assert.equal(hooksStatus(opts(STAGING, '0.7.0-staging.41')).state, 'installed',
    'the sibling is still current — an upgrade of one variant is not a downgrade of the other');
  const registry = readRegistry(hooksFile);
  for (const { event } of BEEZI_HOOKS) {
    assert.equal(registry.hooks[event].length, 2, 'the old prod entry was replaced, not duplicated');
  }
});

test('uninstalling staging keeps prod and the user hook, and keeps the file', (t) => {
  const { hooksFile, opts } = bench(t);
  withUserHook(hooksFile);
  installHooks(opts(PROD));
  installHooks(opts(STAGING));

  const res = uninstallHooks(opts(STAGING));

  assert.equal(res.removed, true);
  assert.equal(res.owner, STAGING);
  assert.ok(fs.existsSync(hooksFile), 'a sibling still owns entries — the registry must survive');
  assert.equal(hooksStatus(opts(PROD)).state, 'installed');
  assert.equal(hooksStatus(opts(STAGING)).state, 'absent');
  const registry = readRegistry(hooksFile);
  for (const { event } of BEEZI_HOOKS) assert.equal(registry.hooks[event].length, 1);
  assert.deepEqual(registry.hooks.PreCompact[0].hooks, [USER_HOOK]);
});

test('uninstalling prod keeps staging — the reverse order of the same claim', (t) => {
  const { hooksFile, opts } = bench(t);
  withUserHook(hooksFile);
  installHooks(opts(STAGING));
  installHooks(opts(PROD));

  uninstallHooks(opts(PROD));

  assert.ok(fs.existsSync(hooksFile));
  assert.equal(hooksStatus(opts(STAGING)).state, 'installed');
  assert.equal(hooksStatus(opts(PROD)).state, 'absent');
  const registry = readRegistry(hooksFile);
  for (const { event } of BEEZI_HOOKS) {
    const handler = registry.hooks[event][0].hooks[0];
    assert.equal(handler.arguments[1], '--beezi-owner=beezi-staging');
  }
  assert.deepEqual(registry.hooks.PreCompact[0].hooks, [USER_HOOK]);
});

test('uninstalling the last variant still takes the file when nothing else is in it', (t) => {
  const { hooksFile, opts } = bench(t);
  installHooks(opts(PROD));
  installHooks(opts(STAGING));

  uninstallHooks(opts(PROD));
  assert.ok(fs.existsSync(hooksFile), 'staging is still registered');
  uninstallHooks(opts(STAGING));
  assert.ok(!fs.existsSync(hooksFile), 'nothing left that we did not put there');
});

test('a sibling install does not make an uninstalled variant report as installed', (t) => {
  const { hooksFile, opts } = bench(t);
  installHooks(opts(STAGING));

  const prod = hooksStatus(opts(PROD));
  assert.equal(prod.state, 'absent');
  assert.deepEqual(prod.registered, []);
  assert.equal(prod.owner, PROD);
  assert.equal(uninstallHooks(opts(PROD)).removed, false, 'nothing of ours to remove');
  assert.ok(fs.existsSync(hooksFile), "and the sibling's registry is still there");
  assert.equal(hooksStatus(opts(STAGING)).state, 'installed');
});

test("a variant's entry is claimed by its tag even after the user rewords the label", (t) => {
  const { hooksFile, opts } = bench(t);
  installHooks(opts(PROD));
  installHooks(opts(STAGING));

  // The install flow invites the user into /hooks, so a hand-edited label is a real state.
  const edited = readRegistry(hooksFile);
  for (const groups of Object.values(edited.hooks)) {
    for (const group of groups) {
      for (const handler of group.hooks) handler.statusMessage = 'my analytics';
    }
  }
  fs.writeFileSync(hooksFile, JSON.stringify(edited, null, 2));

  // The tag survives the rewording, so prod's uninstall still cannot reach staging's entries.
  uninstallHooks(opts(PROD));
  const registry = readRegistry(hooksFile);
  for (const { event } of BEEZI_HOOKS) {
    assert.equal(registry.hooks[event].length, 1);
    assert.equal(registry.hooks[event][0].hooks[0].arguments[1], '--beezi-owner=beezi-staging');
  }
});

test('legacy unsuffixed entries are recognised only by the unsuffixed owner', (t) => {
  const { hooksFile, opts } = bench(t);
  const legacyLauncherDir = variantLauncherDir(opts(PROD).launcherDir, PROD);
  // What the shipped 0.6.x installer left behind: launcher scripts under ~/.beezi-codex/hooks,
  // no `arguments`, and a label the user may since have reworded away.
  const hooks = {};
  for (const { event, script } of BEEZI_HOOKS) {
    const launcher = path.join(opts(PROD).launcherDir, `beezi-${path.basename(script, '.mjs')}.sh`);
    hooks[event] = [{ matcher: '.*', hooks: [{ type: 'command', command: launcher, timeout: 10 }] }];
  }
  fs.mkdirSync(opts(PROD).launcherDir, { recursive: true });
  fs.writeFileSync(hooksFile, JSON.stringify({ hooks }, null, 2));
  assert.ok(legacyLauncherDir);

  // Staging must not adopt — or delete — a legacy install that predates variants.
  const stagingStatus = hooksStatus(opts(STAGING));
  assert.equal(stagingStatus.state, 'absent');
  assert.equal(uninstallHooks(opts(STAGING)).removed, false);
  assert.ok(fs.existsSync(hooksFile), 'the legacy install survived a staging uninstall');
  assert.equal(readRegistry(hooksFile).hooks.Stop[0].hooks[0].command,
    path.join(opts(PROD).launcherDir, 'beezi-stop.sh'));

  // The unsuffixed owner is the migration path, and it does claim them.
  assert.equal(hooksStatus(opts(PROD)).state, 'stale');
  installHooks(opts(PROD));
  const registry = readRegistry(hooksFile);
  for (const { event } of BEEZI_HOOKS) {
    assert.equal(registry.hooks[event].length, 1, 'converted in place, not duplicated');
    assert.equal(registry.hooks[event][0].hooks[0].command, 'node');
  }
});

test("a staging install does not adopt production's untagged current-format entries", (t) => {
  const { hooksFile, opts } = bench(t);
  installHooks(opts(PROD));
  const before = readRegistry(hooksFile);

  // Everything staging can see of prod is an untagged handler whose path says `beezi`. Under the
  // old recogniser this was "ours"; it must now resolve to the unsuffixed owner alone.
  assert.deepEqual(handlersOf(before, STAGING, opts(STAGING).launcherDir), []);
  assert.equal(handlersOf(before, PROD, opts(PROD).launcherDir).length, BEEZI_HOOKS.length);

  installHooks(opts(STAGING));
  const after = readRegistry(hooksFile);
  for (const { event, script } of BEEZI_HOOKS) {
    assert.equal(after.hooks[event].length, 2);
    assert.deepEqual(after.hooks[event][0].hooks[0].arguments,
      [path.join(opts(PROD).scriptsDir, script)], "prod's entry is unchanged, byte for byte");
  }
});

test('dev, staging and prod coexist — three variants, one registry', (t) => {
  const { hooksFile, opts } = bench(t);
  withUserHook(hooksFile);
  installHooks(opts(DEV));
  installHooks(opts(PROD));
  installHooks(opts(STAGING));

  for (const owner of [DEV, PROD, STAGING]) {
    assert.equal(hooksStatus(opts(owner)).state, 'installed', `${owner} is installed`);
  }
  const registry = readRegistry(hooksFile);
  for (const { event } of BEEZI_HOOKS) assert.equal(registry.hooks[event].length, 3);

  uninstallHooks(opts(DEV));
  assert.equal(hooksStatus(opts(DEV)).state, 'absent');
  assert.equal(hooksStatus(opts(PROD)).state, 'installed');
  assert.equal(hooksStatus(opts(STAGING)).state, 'installed');
  assert.deepEqual(readRegistry(hooksFile).hooks.PreCompact[0].hooks, [USER_HOOK]);
});
