import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

// The two capture hooks run the checkpoint local-only (I-local). SOURCE ASSERTIONS, for the reason
// test/heartbeat-wiring.test.mjs gives: nothing in this suite may spawn a hook script (the hermetic
// gate records every child_process call), so what is only expressible in the script — which mode it
// asks for, which guard it runs, what it no longer does — is pinned here. What localOnly itself does
// is proved behaviourally in test/checkpoint-local-only.test.mjs.

const scriptsDir = path.join(path.dirname(path.dirname(url.fileURLToPath(import.meta.url))), 'scripts');
const read = (name) => fs.readFileSync(path.join(scriptsDir, name), 'utf-8').replace(/\r\n/g, '\n');
const callLine = (src) => src.split('\n').find((l) => l.includes('runCheckpoint(input,'));
// Code only: a comment that names a removed import or call must not redden these.
const code = (src) => src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

test('Stop checkpoints local-only, with the turn end timeline flag', () => {
  const line = callLine(read('stop.mjs'));
  assert.ok(line, 'stop.mjs still calls runCheckpoint');
  assert.match(line, /localOnly:\s*true/);
  assert.match(line, /emitTimeline:\s*true/);
});

test('PostToolUse checkpoints local-only on both the boundary and the heartbeat path', () => {
  const line = callLine(read('checkpoint.mjs'));
  assert.ok(line, 'checkpoint.mjs still calls runCheckpoint');
  assert.match(line, /localOnly:\s*true/);
  assert.match(line, /emitTimeline:\s*heartbeat/);
});

for (const name of ['stop.mjs', 'checkpoint.mjs']) {
  test(`${name} runs the credential-free guard, never the full one`, () => {
    const src = code(read(name));
    assert.equal((src.match(/\bhookMayProceedLocal\(/g) || []).length, 1);
    assert.equal((src.match(/\b(hookMayProceed|checkEnvironment|environmentNotice)\(/g) || []).length, 0);
  });
}

test('Stop no longer posts diagnostics itself: the upload worker does', () => {
  const src = code(read('stop.mjs'));
  for (const gone of ['telemetry-flush.mjs', 'diagnostics-transport.mjs', 'flushDiagnostics', 'claimFlushWindow', 'isTelemetryGranted']) {
    assert.equal(src.indexOf(gone), -1, `${gone} is still on the Stop hook's path`);
  }
});

// A Stop carrying `stop_hook_active: true` is the continued turn's own turn end, and Beezi never
// blocks a Stop: it checkpoints like any other (a local-only Stop is cheap and cursor-idempotent).
test('Stop does not skip a firing that carries stop_hook_active', () => {
  assert.equal(code(read('stop.mjs')).indexOf('stop_hook_active'), -1);
});
