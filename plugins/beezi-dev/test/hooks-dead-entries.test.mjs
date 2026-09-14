import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BEEZI_HOOKS,
  brokenBeeziEntries,
  hooksStatus,
  installHooks,
  removeDeadLegacyLaunchers,
  uninstallHooks,
} from '../lib/hooks-install.mjs';

// A registered hook whose target file is gone.
//
// Measured on a live Windows machine running the beezi-local variant: three launcher-style entries
// from an older PRODUCTION install were still in ~/.codex/hooks.json, pointing into a
// ~/.beezi-codex/hooks directory that had since been deleted. Codex spawned them every session.
// Through cmd.exe a missing .cmd is `The system cannot find the path specified.` and exit 1, so
// SessionStart, PostToolUse and Stop each reported `hook: <Event> Failed` — for every session, on
// a machine whose own `hooks.mjs status` said `✓ analytics hooks are installed`.
//
// It said that truthfully: `state` is owner-scoped, and the orphans belonged to `beezi` while the
// process asking belonged to `beezi-local`. The gap these tests lock is the REPORT, not the
// removal — `beezi`'s own uninstall already removed them correctly once someone knew to run it.

const PROD = 'beezi';
const LOCAL = 'beezi-local';

function bench(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-dead-'));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });
  const hooksFile = path.join(root, '.codex', 'hooks.json');
  fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
  const opts = (owner, version = '0.8.0') => ({
    scriptsDir: path.join(
      root, 'plugins', 'cache', owner === PROD ? 'beezi' : 'beezi-internal', owner, version, 'scripts',
    ),
    launcherDir: path.join(
      root, owner === PROD ? '.beezi-codex' : `.beezi-codex-${owner.slice('beezi-'.length)}`, 'hooks',
    ),
    hooksFile,
    owner,
  });
  return { root, hooksFile, opts };
}

/** Materialise the five hook scripts, so an install of this owner points at files that exist. */
function materialise(o) {
  fs.mkdirSync(o.scriptsDir, { recursive: true });
  for (const { script } of BEEZI_HOOKS) {
    fs.writeFileSync(path.join(o.scriptsDir, script), '// stub\n');
  }
}

/** The registry an abandoned pre-launcherless production install leaves behind. */
function writeLegacyProdLaunchers(hooksFile, launcherDir, { onDisk }) {
  const hooks = {};
  for (const { event, script } of BEEZI_HOOKS) {
    const launcher = path.join(launcherDir, `beezi-${path.basename(script, '.mjs')}.cmd`);
    hooks[event] = [{
      matcher: '.*',
      hooks: [{
        type: 'command',
        command: launcher,
        commandWindows: launcher,
        // The label is the anchor that survives across owners; see brokenBeeziEntries.
        statusMessage: 'Beezi analytics',
        timeout: 10,
      }],
    }];
  }
  if (onDisk) {
    fs.mkdirSync(launcherDir, { recursive: true });
    for (const { script } of BEEZI_HOOKS) {
      fs.writeFileSync(path.join(launcherDir, `beezi-${path.basename(script, '.mjs')}.cmd`), '@echo off\n');
    }
  }
  fs.writeFileSync(hooksFile, JSON.stringify({ hooks }, null, 2));
}

/** The same launchers, merged into a registry that already has a healthy install in it. */
function injectLegacyProdLaunchers(hooksFile, launcherDir) {
  const registry = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
  for (const { event, script } of BEEZI_HOOKS) {
    const launcher = path.join(launcherDir, `beezi-${path.basename(script, '.mjs')}.cmd`);
    registry.hooks[event] = [
      ...(registry.hooks[event] || []),
      {
        matcher: '.*',
        hooks: [{
          type: 'command',
          command: launcher,
          commandWindows: launcher,
          statusMessage: 'Beezi analytics',
          timeout: 10,
        }],
      },
    ];
  }
  fs.writeFileSync(hooksFile, JSON.stringify(registry, null, 2));
}

test('a healthy install of this owner reports no dead entries', (t) => {
  const { hooksFile, opts } = bench(t);
  const local = opts(LOCAL);
  materialise(local);
  installHooks(local);

  const status = hooksStatus(local);
  assert.equal(status.state, 'installed');
  assert.deepEqual(status.broken, [], JSON.stringify(status.broken));
  assert.ok(fs.existsSync(hooksFile));
});

test('an upgrade that moved the scripts is reported as dead as well as stale', (t) => {
  const { opts } = bench(t);
  const old = opts(LOCAL, '0.8.0');
  materialise(old);
  installHooks(old);

  // What a plugin upgrade does: a new versioned cache directory appears, the old one is dropped,
  // and the registry still names the old one. The process asking is the NEW version, which is why
  // `state` can see the drift at all — it compares the registry against its own scriptsDir.
  const upgraded = opts(LOCAL, '0.8.1');
  materialise(upgraded);
  fs.rmSync(path.dirname(old.scriptsDir), { recursive: true, force: true });

  const status = hooksStatus(upgraded);
  assert.equal(status.state, 'stale');
  // `broken` is the sharper signal of the two: `stale` only means "not this version's path",
  // while these entries are failing every spawn right now.
  assert.equal(status.broken.length, BEEZI_HOOKS.length);
  for (const entry of status.broken) {
    assert.equal(entry.owner, LOCAL);
    assert.ok(entry.target.indexOf('0.8.0') !== -1, entry.target);
  }

  // And the repair the existing `stale` branch already prescribes clears it.
  installHooks(upgraded);
  assert.deepEqual(hooksStatus(upgraded).broken, []);
});

test("a sibling's dead launchers are reported by this owner even while its own state is installed", (t) => {
  const { hooksFile, opts } = bench(t);
  const prod = opts(PROD);
  const local = opts(LOCAL);

  // The measured sequence: local is installed and healthy, and production's launcher dir is
  // deleted AFTERWARDS — so nothing has run an install since, and the orphans are simply sitting
  // there. (An install run after this point sweeps them; that is a separate test below.)
  materialise(local);
  installHooks(local);
  injectLegacyProdLaunchers(hooksFile, prod.launcherDir);

  const status = hooksStatus(local);

  // Owner scoping is unchanged — local's own install really is complete, and says so.
  assert.equal(status.state, 'installed');
  assert.equal(status.complete, true);

  // …and the orphans are now named anyway. This is the whole defect: before this scan existed it
  // was `[]`, and three events failed on every session with nothing in the product saying why.
  assert.equal(status.broken.length, BEEZI_HOOKS.length);
  for (const entry of status.broken) {
    assert.equal(entry.owner, PROD);
    assert.ok(entry.target.endsWith('.cmd'), entry.target);
    assert.equal(fs.existsSync(entry.target), false);
  }
  assert.deepEqual(
    status.broken.map((b) => b.event).sort(),
    BEEZI_HOOKS.map((h) => h.event).sort(),
  );
});

test('a sibling whose launchers still exist is not reported', (t) => {
  const { hooksFile, opts } = bench(t);
  const prod = opts(PROD);
  const local = opts(LOCAL);
  writeLegacyProdLaunchers(hooksFile, prod.launcherDir, { onDisk: true });
  materialise(local);
  installHooks(local);

  assert.deepEqual(hooksStatus(local).broken, []);
});

test("the owning variant's own uninstall clears the report — no cross-owner mutation needed", (t) => {
  const { hooksFile, opts } = bench(t);
  const prod = opts(PROD);
  const local = opts(LOCAL);
  materialise(local);
  installHooks(local);
  injectLegacyProdLaunchers(hooksFile, prod.launcherDir);
  assert.equal(hooksStatus(local).broken.length, BEEZI_HOOKS.length);

  // The repair the report points at. It is `beezi`'s uninstall, run as `beezi` — the one-owner-
  // per-mutation rule is not relaxed by any of this.
  assert.equal(uninstallHooks(prod).removed, true);

  const after = hooksStatus(local);
  assert.deepEqual(after.broken, []);
  assert.equal(after.state, 'installed', 'local survived the sibling uninstall untouched');
});

test("a user's own broken hook is not ours to report", (t) => {
  const { hooksFile, opts } = bench(t);
  const local = opts(LOCAL);
  materialise(local);
  installHooks(local);

  const registry = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
  registry.hooks.PreCompact = [{
    matcher: '.*',
    hooks: [{ type: 'command', command: path.join(opts(PROD).launcherDir, '..', 'audit.sh') }],
  }];
  fs.writeFileSync(hooksFile, JSON.stringify(registry, null, 2));

  // Missing, but neither tagged, labelled, nor shaped like one of our scripts — not ours.
  assert.deepEqual(hooksStatus(local).broken, []);
});

test('brokenBeeziEntries tolerates a registry it cannot walk', () => {
  assert.deepEqual(brokenBeeziEntries(null, '/nope'), []);
  assert.deepEqual(brokenBeeziEntries({}, '/nope'), []);
  assert.deepEqual(brokenBeeziEntries({ hooks: 'nope' }, '/nope'), []);
  assert.deepEqual(brokenBeeziEntries({ hooks: { Stop: 'nope' } }, '/nope'), []);
  assert.deepEqual(brokenBeeziEntries({ hooks: { Stop: [null, { hooks: [null, 7] }] } }, '/nope'), []);
});

test('a PATH-resolved interpreter is never treated as a missing file', () => {
  // `command: 'node'` with no arguments names no path — statting it would report every such entry
  // as dead. Labelled as ours so only handlerTarget can be what excludes it.
  const registry = {
    hooks: {
      Stop: [{ matcher: '.*', hooks: [{ type: 'command', command: 'node', statusMessage: 'Beezi analytics' }] }],
    },
  };
  assert.deepEqual(brokenBeeziEntries(registry, '/nope'), []);
});

test("a variant's install sweeps a dead legacy launcher it does not own", (t) => {
  const { hooksFile, opts } = bench(t);
  const prod = opts(PROD);
  const local = opts(LOCAL);
  writeLegacyProdLaunchers(hooksFile, prod.launcherDir, { onDisk: false });
  materialise(local);

  installHooks(local);

  // The orphans are gone without anyone having found the production plugin to run its uninstall —
  // the case that matters, because a user who removed that variant no longer HAS it to run.
  const after = hooksStatus(local);
  assert.deepEqual(after.broken, []);
  assert.equal(after.state, 'installed');

  const registry = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
  for (const groups of Object.values(registry.hooks)) {
    for (const group of groups) {
      for (const handler of group.hooks) {
        assert.match(handler.command, /^node ".+\.mjs" --beezi-owner=beezi-local$/, JSON.stringify(handler));
        assert.ok(!('arguments' in handler), JSON.stringify(handler));
      }
    }
  }
});

test('a LIVE legacy launcher is never swept — only a dead one', (t) => {
  const { hooksFile, opts } = bench(t);
  const prod = opts(PROD);
  const local = opts(LOCAL);
  writeLegacyProdLaunchers(hooksFile, prod.launcherDir, { onDisk: true });
  materialise(local);

  installHooks(local);

  // Production is still installed and its launchers still exist: removing them would break a
  // working sibling, which is the defect the owner-scoping rule exists to prevent.
  const registry = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
  const launchers = [];
  for (const groups of Object.values(registry.hooks)) {
    for (const group of groups) {
      for (const handler of group.hooks) {
        if (handler.command.indexOf('node "') !== 0) launchers.push(handler.command);
      }
    }
  }
  assert.equal(launchers.length, BEEZI_HOOKS.length, JSON.stringify(launchers));
});

test('the sweep will not touch a missing file that merely looks beezi-flavoured', (t) => {
  const { hooksFile, opts } = bench(t);
  const local = opts(LOCAL);
  materialise(local);
  installHooks(local);

  // Each of these fails exactly one of the three conditions: wrong prefix, wrong parent dir,
  // wrong root dir, and (last) a tagged current-format entry that happens to be dead.
  const notOurs = [
    path.join(opts(PROD).launcherDir, 'other-stop.cmd'),
    path.join(path.dirname(opts(PROD).launcherDir), 'beezi-stop.cmd'),
    path.join('/somewhere', '.config', 'hooks', 'beezi-stop.cmd'),
  ];
  const registry = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
  registry.hooks.PreCompact = [{
    matcher: '.*',
    hooks: notOurs.map((command) => ({ type: 'command', command })),
  }];
  fs.writeFileSync(hooksFile, JSON.stringify(registry, null, 2));

  installHooks(local);

  const after = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
  assert.deepEqual(
    after.hooks.PreCompact[0].hooks.map((h) => h.command),
    notOurs,
    'a non-matching entry survived install untouched',
  );
});

test('removeDeadLegacyLaunchers tolerates a registry it cannot walk', () => {
  assert.deepEqual(removeDeadLegacyLaunchers(null), {});
  assert.deepEqual(removeDeadLegacyLaunchers({}), {});
  assert.deepEqual(removeDeadLegacyLaunchers({ hooks: 'nope' }), { hooks: 'nope' });
  assert.deepEqual(
    removeDeadLegacyLaunchers({ hooks: { Stop: [null, { hooks: [7] }] } }),
    { hooks: { Stop: [null, { hooks: [7] }] } },
  );
});
