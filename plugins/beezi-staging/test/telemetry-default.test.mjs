import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { denyConsent, denyCorrelation, grantConsent, markAsked, readConsent, setCrashMode } from '../lib/diagnostics.mjs';
import { telemetryCommand } from '../scripts/telemetry.mjs';

// `telemetry.mjs default`, driven in-process as consent-surface drives the switch.

function withHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-telemetry-default-'));
  const prev = process.env.BEEZI_CODEX_HOME;
  process.env.BEEZI_CODEX_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CODEX_HOME;
    else process.env.BEEZI_CODEX_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

const undecided = [
  { name: 'no record', arrange: () => {} },
  { name: 'a prompt shown and never answered', arrange: () => markAsked() },
];

for (const c of undecided) {
  test(`default turns crash reports on with correlation on an undecided machine: ${c.name}`, (t) => {
    withHome(t);
    c.arrange();
    assert.deepEqual(telemetryCommand(['default']), { ok: true, lines: ['✓ Crash reports are on.'] });
    const state = readConsent();
    assert.equal(state.consent, 'granted');
    assert.equal(state.correlation, 'granted');
  });
}

const decided = [
  { name: 'crash reports granted', arrange: () => grantConsent() },
  { name: 'crash reports denied', arrange: () => denyConsent() },
  { name: 'correlation denied', arrange: () => denyCorrelation() },
  { name: 'anonymous', arrange: () => setCrashMode('anonymous') },
];

for (const c of decided) {
  test(`default changes nothing and says nothing once the user decided: ${c.name}`, (t) => {
    withHome(t);
    c.arrange();
    const before = readConsent();
    assert.deepEqual(telemetryCommand(['default']), { ok: true, lines: [] });
    assert.deepEqual(readConsent(), before);
  });
}

const unreadable = [
  { name: 'a file that cannot be parsed', text: '{"version": 1, "consent": ' },
  { name: 'a file of another version', text: '{"version":7,"consent":"denied"}' },
];

for (const c of unreadable) {
  test(`default counts ${c.name} as decided and leaves it alone`, (t) => {
    withHome(t);
    const file = path.join(process.env.BEEZI_CODEX_HOME, 'telemetry.json');
    fs.writeFileSync(file, c.text);
    assert.deepEqual(telemetryCommand(['default']), { ok: true, lines: [] });
    assert.equal(fs.readFileSync(file, 'utf8'), c.text);
  });
}
