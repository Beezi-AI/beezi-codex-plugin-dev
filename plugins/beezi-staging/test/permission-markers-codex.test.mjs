import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  MAX_MARKERS, PERMISSION_MARKER_MAX_AGE_MS, permissionMarkerFile, appendPermissionMarker, readPermissionMarkers,
} from '../lib/permission-markers-codex.mjs';
import { MAX_SESSION_AGE_MS } from '../lib/session-audit.mjs';
import { stateDir } from '../lib/paths.mjs';
import { resolveCodexTranscript, quarantinePoisonedSessionState } from '../lib/transcript-codex.mjs';
import { pruneStale } from '../lib/prune.mjs';
import { forgetHeldLocks } from '../lib/single-instance-lock.mjs';
import { tmpHome } from '../tools/suite-fixtures.mjs';
import { withoutGuard } from '../tools/hermetic-env.mjs';

afterEach(() => forgetHeldLocks());

const pluginRoot = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
const SCRIPT = path.join(pluginRoot, 'scripts', 'permission-request.mjs');

test('append two markers, read back sorted with mapped fields', (t) => {
  tmpHome(t, { prefix: 'beezi-pm-' });
  const t1 = Date.parse('2026-01-01T00:00:10.000Z');
  const t0 = Date.parse('2026-01-01T00:00:05.000Z');
  appendPermissionMarker(
    { session_id: 's1', turn_id: 'T2', agent_id: 'A1', tool_name: 'Bash', permission_mode: 'default' },
    { now: t1 },
  );
  appendPermissionMarker({ session_id: 's1', turn_id: 'T1', tool_name: 'apply_patch' }, { now: t0 });
  const got = readPermissionMarkers('s1');
  assert.deepEqual(got, [
    { ts: t0, turnId: 'T1', agentId: null, toolName: 'apply_patch', permissionMode: null },
    { ts: t1, turnId: 'T2', agentId: 'A1', toolName: 'Bash', permissionMode: 'default' },
  ]);
  assert.equal(typeof got[0].ts, 'number');
});

test('absent keys are omitted from the written line', (t) => {
  tmpHome(t, { prefix: 'beezi-pm-' });
  appendPermissionMarker({ session_id: 's1', tool_name: 'Bash', agent_id: null }, { now: 0 });
  const line = fs.readFileSync(permissionMarkerFile('s1'), 'utf-8');
  assert.equal(line, `${JSON.stringify({ at: new Date(0).toISOString(), tool_name: 'Bash' })}\n`);
});

test('a torn last line is skipped, earlier markers survive', (t) => {
  tmpHome(t, { prefix: 'beezi-pm-' });
  appendPermissionMarker({ session_id: 's1', tool_name: 'Bash' }, { now: 1000 });
  fs.appendFileSync(permissionMarkerFile('s1'), '{"at":"2026-01-01T00:0');
  const got = readPermissionMarkers('s1');
  assert.equal(got.length, 1);
  assert.equal(got[0].ts, 1000);
});

test('lines without a parseable at are skipped', (t) => {
  tmpHome(t, { prefix: 'beezi-pm-' });
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(permissionMarkerFile('s1'),
    '{"tool_name":"x"}\n{"at":"nope"}\nnull\n{"at":"2026-01-01T00:00:00.000Z"}\n');
  assert.equal(readPermissionMarkers('s1').length, 1);
});

test('cap: more than MAX_MARKERS lines read back as MAX_MARKERS, newest kept', (t) => {
  tmpHome(t, { prefix: 'beezi-pm-' });
  fs.mkdirSync(stateDir(), { recursive: true });
  const lines = [];
  for (let i = 0; i < MAX_MARKERS + 5; i++) {
    lines.push(JSON.stringify({ at: new Date(1000 + i).toISOString() }));
  }
  fs.writeFileSync(permissionMarkerFile('s1'), `${lines.join('\n')}\n`);
  const got = readPermissionMarkers('s1');
  assert.equal(got.length, MAX_MARKERS);
  assert.equal(got[got.length - 1].ts, 1000 + MAX_MARKERS + 4);
  assert.equal(got[0].ts, 1005);
});

test('missing file yields []', (t) => {
  tmpHome(t, { prefix: 'beezi-pm-' });
  assert.deepEqual(readPermissionMarkers('nope'), []);
});

test('file name is <id>.perm.jsonl under stateDir', (t) => {
  tmpHome(t, { prefix: 'beezi-pm-' });
  const f = permissionMarkerFile('abc');
  assert.ok(f.endsWith('abc.perm.jsonl'));
  assert.equal(path.dirname(f), stateDir());
  assert.ok(permissionMarkerFile('../evil').startsWith(stateDir()));
});

test('.perm.jsonl is invisible to state/ readers and reclaimed by prune', (t) => {
  tmpHome(t, { prefix: 'beezi-pm-' });
  appendPermissionMarker({ session_id: 'null', tool_name: 'Bash' });
  appendPermissionMarker({ session_id: 's1', tool_name: 'Bash' });
  assert.equal(resolveCodexTranscript({ session_id: null, cwd: '/nowhere' }), null);
  const swept = quarantinePoisonedSessionState();
  assert.deepEqual(swept.moved, [], JSON.stringify(swept));
  assert.deepEqual(swept.failed, []);
  assert.equal(fs.existsSync(permissionMarkerFile('null')), true);

  pruneStale(Date.now() + 36 * 24 * 60 * 60 * 1000);
  assert.equal(fs.existsSync(permissionMarkerFile('s1')), false);
});

test('the marker window outlasts the sync re-derive window', () => {
  assert.ok(PERMISSION_MARKER_MAX_AGE_MS > MAX_SESSION_AGE_MS, 'a sync re-derive must still find its markers');
});

function runScript(home, input) {
  const env = Object.assign({}, process.env, { BEEZI_CODEX_HOME: home });
  return withoutGuard(() => spawnSync(process.execPath, [SCRIPT], { input, encoding: 'utf8', env }));
}

test('script is silent, exits 0 and writes a marker', (t) => {
  const home = tmpHome(t, { prefix: 'beezi-pm-' });
  const res = runScript(home, JSON.stringify({
    session_id: 's1', turn_id: 't1', tool_name: 'Bash', permission_mode: 'default',
    hook_event_name: 'PermissionRequest',
  }));
  assert.equal(res.stdout, '');
  assert.equal(res.status, 0, res.stderr);
  const got = readPermissionMarkers('s1');
  assert.equal(got.length, 1);
  assert.equal(got[0].turnId, 't1');
  assert.equal(got[0].toolName, 'Bash');
});

test('script with invalid stdin is silent, exits 0, writes nothing', (t) => {
  const home = tmpHome(t, { prefix: 'beezi-pm-' });
  for (const input of ['not json', '{}', '{"session_id":""}', 'null']) {
    const res = runScript(home, input);
    assert.equal(res.stdout, '');
    assert.equal(res.status, 0, res.stderr);
  }
  assert.equal(fs.existsSync(stateDir()) ? fs.readdirSync(stateDir()).length : 0, 0);
});

test('script source never prints and never exits', () => {
  const src = fs.readFileSync(SCRIPT, 'utf-8');
  assert.doesNotMatch(src, /console\.|process\.stdout|process\.exit|process\.exitCode/);
});
