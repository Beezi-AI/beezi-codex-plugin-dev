import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BEEZI_HOOKS,
  BEEZI_STATUS_MESSAGE,
  HOOK_COMMAND,
  buildHookEntries,
  hookCommand,
  hooksStatus,
  installHooks,
  mergeHooks,
  removeBeeziHooks,
  uninstallHooks,
} from '../lib/hooks-install.mjs';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-hooks-'));
}

// A scripts dir the new-style ownership fallback recognises: the real install dir always has a
// `beezi` path segment, and the recognizer leans on that.
function beeziScriptsDir(root, version = 'v1') {
  return path.join(root, 'beezi-plugin', version, 'scripts');
}

// The registry entry shape older plugin versions wrote: a per-event launcher script whose command
// embeds the interpreter and script path, no `arguments`.
function legacyInstall(hooksFile, launcherDir) {
  fs.mkdirSync(launcherDir, { recursive: true });
  const hooks = {};
  for (const { event, script } of BEEZI_HOOKS) {
    const launcher = path.join(launcherDir, `beezi-${path.basename(script, '.mjs')}.sh`);
    fs.writeFileSync(launcher, `#!/bin/sh\nexec "/usr/bin/node" "/old/${script}" "$@"\n`);
    hooks[event] = [{
      matcher: '.*',
      hooks: [{ type: 'command', command: launcher, commandWindows: launcher, statusMessage: BEEZI_STATUS_MESSAGE, timeout: 10 }],
    }];
  }
  fs.writeFileSync(hooksFile, JSON.stringify({ hooks }, null, 2));
}

// The 0.8.x shape Codex accepted but did not execute correctly on Windows: it launched bare Node
// and did not pass the separate arguments array through to the command hook.
function brokenArgumentsInstall(hooksFile, scriptsDir) {
  const hooks = {};
  for (const { event, script } of BEEZI_HOOKS) {
    hooks[event] = [{
      matcher: '.*',
      hooks: [{
        type: 'command',
        command: 'node',
        arguments: [path.join(scriptsDir, script)],
        statusMessage: BEEZI_STATUS_MESSAGE,
        timeout: 10,
      }],
    }];
  }
  fs.writeFileSync(hooksFile, JSON.stringify({ hooks }, null, 2));
}

test('the registered event set is exactly the five Beezi hooks', () => {
  // SessionEnd stays out by choice: Stop already runs the identical checkpoint at every turn end,
  // so registering it would only cost the user another entry to review and trust.
  assert.deepEqual(BEEZI_HOOKS.map((h) => h.event),
    ['SessionStart', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop']);
});

test('buildHookEntries puts the complete invocation in command', () => {
  const scriptsDir = path.join('/p', 'beezi', 'scripts');
  const entries = buildHookEntries({ scriptsDir });
  assert.deepEqual(Object.keys(entries).sort(), ['PostToolUse', 'SessionStart', 'Stop', 'SubagentStart', 'SubagentStop']);
  for (const { event, script } of BEEZI_HOOKS) {
    const handler = entries[event][0].hooks[0];
    assert.equal(handler.type, 'command');
    assert.equal(handler.command, hookCommand(path.join(scriptsDir, script), 'beezi'));
    assert.equal(HOOK_COMMAND, 'node', 'interpreter comes from PATH, never an absolute path');
    assert.ok(!('arguments' in handler), 'Codex 0.154.0 does not pass this field to command hooks');
    assert.equal(handler.statusMessage, BEEZI_STATUS_MESSAGE);
    assert.ok(!('commandWindows' in handler), 'one command works on every platform');
  }
});

test('removeBeeziHooks leaves a user’s own hooks untouched', () => {
  const mine = { type: 'command', command: '/usr/local/bin/audit' };
  const existing = {
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [mine] }],
      Stop: [{ matcher: '.*', hooks: [{ type: 'command', command: '/x', statusMessage: BEEZI_STATUS_MESSAGE }] }],
    },
  };
  const out = removeBeeziHooks(existing);
  assert.deepEqual(out.hooks.PreToolUse, [{ matcher: 'Bash', hooks: [mine] }]);
  assert.ok(!('Stop' in out.hooks), 'an event left with no groups is dropped');
});

test('removeBeeziHooks strips only our handler from a shared group', () => {
  const mine = { type: 'command', command: '/usr/local/bin/audit' };
  const existing = {
    hooks: { Stop: [{ matcher: '.*', hooks: [mine, { type: 'command', command: '/x', statusMessage: BEEZI_STATUS_MESSAGE }] }] },
  };
  assert.deepEqual(removeBeeziHooks(existing).hooks.Stop, [{ matcher: '.*', hooks: [mine] }]);
});

test('removeBeeziHooks preserves unknown top-level keys', () => {
  const out = removeBeeziHooks({ hooks: {}, somethingElse: { keep: true } });
  assert.deepEqual(out.somethingElse, { keep: true });
});

test('mergeHooks is idempotent — re-install does not duplicate entries', () => {
  const beezi = buildHookEntries({ scriptsDir: '/p/beezi/scripts' });
  const once = mergeHooks({}, beezi);
  const twice = mergeHooks(once, beezi);
  assert.deepEqual(twice, once);
  assert.equal(twice.hooks.Stop.length, 1);
});

test('mergeHooks keeps a user hook on an event Beezi also registers', () => {
  const mine = { matcher: 'x', hooks: [{ type: 'command', command: '/mine' }] };
  const merged = mergeHooks({ hooks: { Stop: [mine] } }, buildHookEntries({ scriptsDir: '/p/beezi/scripts' }));
  assert.equal(merged.hooks.Stop.length, 2);
  assert.deepEqual(merged.hooks.Stop[0], mine);
});

test('installHooks writes a readable registry, then uninstall reverses it', () => {
  const root = tmpdir();
  const hooksFile = path.join(root, 'codex', 'hooks.json');
  const launcherDir = path.join(root, 'launchers');
  const scriptsDir = beeziScriptsDir(root);

  const res = installHooks({ scriptsDir, hooksFile, launcherDir });
  assert.deepEqual(res.events, BEEZI_HOOKS.map((h) => h.event));

  const written = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
  assert.deepEqual(Object.keys(written.hooks).sort(), ['PostToolUse', 'SessionStart', 'Stop', 'SubagentStart', 'SubagentStop']);
  for (const { event, script } of BEEZI_HOOKS) {
    const handler = written.hooks[event][0].hooks[0];
    assert.equal(handler.command, hookCommand(path.join(scriptsDir, script), 'beezi'));
    assert.ok(!('arguments' in handler));
  }
  assert.ok(fs.readFileSync(hooksFile, 'utf-8').includes('\n  '), 'registry stays hand-reviewable');

  uninstallHooks({ hooksFile, launcherDir });
  assert.ok(!fs.existsSync(hooksFile), 'a registry that held only our entries is removed, not emptied');
});

test('uninstallHooks keeps the registry file when other hooks remain', () => {
  const root = tmpdir();
  const hooksFile = path.join(root, 'hooks.json');
  const launcherDir = path.join(root, 'l');
  fs.writeFileSync(hooksFile, JSON.stringify({ hooks: { PreCompact: [{ matcher: '.*', hooks: [{ type: 'command', command: '/mine' }] }] } }));

  installHooks({ scriptsDir: beeziScriptsDir(root), hooksFile, launcherDir });
  const res = uninstallHooks({ hooksFile, launcherDir });

  assert.equal(res.removed, true);
  const kept = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
  assert.equal(kept.hooks.PreCompact[0].hooks[0].command, '/mine');
  assert.ok(!('Stop' in kept.hooks));
});

test('installHooks preserves a pre-existing unrelated registry', () => {
  const root = tmpdir();
  const hooksFile = path.join(root, 'hooks.json');
  fs.writeFileSync(hooksFile, JSON.stringify({ hooks: { PreCompact: [{ matcher: '.*', hooks: [{ type: 'command', command: '/mine' }] }] } }));

  installHooks({ scriptsDir: beeziScriptsDir(root), hooksFile, launcherDir: path.join(root, 'l') });

  const written = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
  assert.equal(written.hooks.PreCompact[0].hooks[0].command, '/mine');
});

test('hooksStatus walks absent → installed with the registry alone', () => {
  const root = tmpdir();
  const hooksFile = path.join(root, 'hooks.json');
  const launcherDir = path.join(root, 'l');
  const scriptsDir = beeziScriptsDir(root);

  assert.equal(hooksStatus({ scriptsDir, hooksFile, launcherDir }).state, 'absent');

  installHooks({ scriptsDir, hooksFile, launcherDir });
  const ok = hooksStatus({ scriptsDir, hooksFile, launcherDir });
  assert.equal(ok.state, 'installed');
  assert.equal(ok.complete, true);
  assert.deepEqual(ok.registered.sort(), ['PostToolUse', 'SessionStart', 'Stop', 'SubagentStart', 'SubagentStop']);
  assert.deepEqual(ok.missingEvents, []);
  assert.deepEqual(ok.staleEvents, []);
});

test('hooksStatus calls entries left behind by a plugin upgrade stale, not absent', () => {
  const root = tmpdir();
  const hooksFile = path.join(root, 'hooks.json');
  const launcherDir = path.join(root, 'l');

  installHooks({ scriptsDir: beeziScriptsDir(root, 'v1'), hooksFile, launcherDir });

  // Same install, but the plugin now lives under a new version directory.
  const status = hooksStatus({ scriptsDir: beeziScriptsDir(root, 'v2'), hooksFile, launcherDir });
  assert.equal(status.state, 'stale');
  assert.equal(status.complete, false);
  assert.equal(status.missingEvents.length, 0);
  assert.equal(status.staleEvents.length, BEEZI_HOOKS.length);
});

test('hooksStatus reports partial when one event was hand-deleted from the registry', () => {
  const root = tmpdir();
  const hooksFile = path.join(root, 'hooks.json');
  const launcherDir = path.join(root, 'l');
  const scriptsDir = beeziScriptsDir(root);

  installHooks({ scriptsDir, hooksFile, launcherDir });
  const edited = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
  delete edited.hooks.Stop;
  fs.writeFileSync(hooksFile, JSON.stringify(edited));

  const status = hooksStatus({ scriptsDir, hooksFile, launcherDir });
  assert.equal(status.state, 'partial');
  assert.deepEqual(status.missingEvents, ['Stop']);
});

test('an entry whose label the user reworded is still recognised as ours', () => {
  const root = tmpdir();
  const hooksFile = path.join(root, 'hooks.json');
  const launcherDir = path.join(root, 'l');
  const scriptsDir = beeziScriptsDir(root);

  installHooks({ scriptsDir, hooksFile, launcherDir });
  const edited = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
  for (const groups of Object.values(edited.hooks)) groups[0].hooks[0].statusMessage = 'my analytics';
  fs.writeFileSync(hooksFile, JSON.stringify(edited));

  // Ownership falls back to the script path in `command`, so re-install stays idempotent.
  installHooks({ scriptsDir, hooksFile, launcherDir });
  assert.equal(JSON.parse(fs.readFileSync(hooksFile, 'utf-8')).hooks.Stop.length, 1);

  // …and uninstall does not silently leave firing hooks behind.
  assert.equal(uninstallHooks({ hooksFile, launcherDir }).removed, true);
  assert.ok(!fs.existsSync(hooksFile));
});

test('a user hook that runs their own checkpoint.mjs via node is not ours', () => {
  const root = tmpdir();
  const hooksFile = path.join(root, 'hooks.json');
  const launcherDir = path.join(root, 'l');
  const mine = { type: 'command', command: 'node', arguments: [path.join(root, 'home', 'me', 'checkpoint.mjs')] };
  fs.writeFileSync(hooksFile, JSON.stringify({ hooks: { PostToolUse: [{ matcher: '.*', hooks: [mine] }] } }));

  installHooks({ scriptsDir: beeziScriptsDir(root), hooksFile, launcherDir });
  uninstallHooks({ hooksFile, launcherDir });

  const kept = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
  assert.deepEqual(kept.hooks.PostToolUse[0].hooks, [mine], 'same script name, but not from a beezi directory');
});

test('uninstallHooks on a machine that never installed reports nothing removed', () => {
  const root = tmpdir();
  const res = uninstallHooks({ hooksFile: path.join(root, 'hooks.json'), launcherDir: path.join(root, 'l') });
  assert.equal(res.removed, false);
});

test('an unreadable registry is refused, never silently replaced', () => {
  const root = tmpdir();
  const hooksFile = path.join(root, 'hooks.json');
  // The install flow tells users to open and review this file, so a stray comma is a real state.
  fs.writeFileSync(hooksFile, '{ "hooks": { "PreToolUse": [ ] , } }');

  assert.throws(
    () => installHooks({ scriptsDir: beeziScriptsDir(root), hooksFile, launcherDir: path.join(root, 'l') }),
    /not valid JSON/,
  );
  // Their file is exactly as they left it — merging onto `{}` would have deleted every hook in it.
  assert.equal(fs.readFileSync(hooksFile, 'utf-8'), '{ "hooks": { "PreToolUse": [ ] , } }');
});

test('a user script that merely starts with beezi- is not ours to remove', () => {
  const root = tmpdir();
  const hooksFile = path.join(root, 'hooks.json');
  const launcherDir = path.join(root, 'l');
  const mine = { type: 'command', command: path.join(root, 'bin', 'beezi-notify.sh') };
  fs.writeFileSync(hooksFile, JSON.stringify({ hooks: { PreCompact: [{ matcher: '.*', hooks: [mine] }] } }));

  installHooks({ scriptsDir: beeziScriptsDir(root), hooksFile, launcherDir });
  uninstallHooks({ hooksFile, launcherDir });

  const kept = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
  assert.deepEqual(kept.hooks.PreCompact[0].hooks, [mine], 'uninstall promised to leave their hooks alone');
});

test('hooksStatus reports a legacy launcher-style install as stale', () => {
  const root = tmpdir();
  const hooksFile = path.join(root, 'hooks.json');
  const launcherDir = path.join(root, 'l');
  legacyInstall(hooksFile, launcherDir);

  const status = hooksStatus({ scriptsDir: beeziScriptsDir(root), hooksFile, launcherDir });
  assert.equal(status.state, 'stale');
  assert.equal(status.staleEvents.length, BEEZI_HOOKS.length);
});

test('hooksStatus reports broken node-plus-arguments entries as stale and install migrates them', () => {
  const root = tmpdir();
  const hooksFile = path.join(root, 'hooks.json');
  const launcherDir = path.join(root, 'l');
  const scriptsDir = beeziScriptsDir(root);
  brokenArgumentsInstall(hooksFile, scriptsDir);

  const before = hooksStatus({ scriptsDir, hooksFile, launcherDir });
  assert.equal(before.state, 'stale');
  assert.equal(before.staleEvents.length, BEEZI_HOOKS.length);

  installHooks({ scriptsDir, hooksFile, launcherDir });
  const registry = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
  for (const { event, script } of BEEZI_HOOKS) {
    assert.equal(registry.hooks[event].length, 1, 'broken entry replaced, not duplicated');
    const handler = registry.hooks[event][0].hooks[0];
    assert.equal(handler.command, hookCommand(path.join(scriptsDir, script), 'beezi'));
    assert.ok(!('arguments' in handler));
  }
  assert.equal(hooksStatus({ scriptsDir, hooksFile, launcherDir }).state, 'installed');
});

test('installHooks converts a legacy install and removes the launcher directory', () => {
  const root = tmpdir();
  const hooksFile = path.join(root, 'hooks.json');
  const launcherDir = path.join(root, 'l');
  const scriptsDir = beeziScriptsDir(root);
  legacyInstall(hooksFile, launcherDir);

  installHooks({ scriptsDir, hooksFile, launcherDir });

  const written = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
  for (const { event, script } of BEEZI_HOOKS) {
    assert.equal(written.hooks[event].length, 1, 'old entry replaced, not duplicated');
    const handler = written.hooks[event][0].hooks[0];
    assert.equal(handler.command, hookCommand(path.join(scriptsDir, script), 'beezi'));
    assert.ok(!('arguments' in handler));
  }
  assert.ok(!fs.existsSync(launcherDir), 'old launcher directory is swept away');
  assert.equal(hooksStatus({ scriptsDir, hooksFile, launcherDir }).state, 'installed');
});

test('uninstallHooks strips legacy launcher-style entries too', () => {
  const root = tmpdir();
  const hooksFile = path.join(root, 'hooks.json');
  const launcherDir = path.join(root, 'l');
  legacyInstall(hooksFile, launcherDir);
  // Rewords the label so removal has to rely on the legacy launcher recognition.
  const edited = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
  for (const groups of Object.values(edited.hooks)) delete groups[0].hooks[0].statusMessage;
  fs.writeFileSync(hooksFile, JSON.stringify(edited));

  const res = uninstallHooks({ hooksFile, launcherDir });
  assert.equal(res.removed, true);
  assert.ok(!fs.existsSync(hooksFile));
  assert.ok(!fs.existsSync(launcherDir));
});
