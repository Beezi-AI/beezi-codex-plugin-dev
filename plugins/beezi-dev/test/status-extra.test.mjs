import '../tools/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { createRouteContext } from '../lib/workspace-rules.mjs';
import { pluginInfo, statusExtraLines, uploadStatusLines } from '../lib/status-extra.mjs';

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

// ── the background upload ──────────────────────────────────────────────────────────────────────
// A stuck worker is otherwise invisible: hooks only capture, so nothing else tells the user that
// nothing has been sent. Read from upload-worker.json and whether queue or due files are waiting.

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const RAN = Date.parse('2026-11-05T11:30:00.000Z');
const LATER = Date.parse('2026-11-05T12:05:00.000Z');
const HOUR = 3600000;

const uploadCases = [
  { name: 'no run recorded and nothing waiting prints nothing',
    upload: { status: {}, now: NOW, workWaiting: false }, lines: [] },
  { name: 'a run that sent everything says so, with no warning',
    upload: { status: { lastRunAt: RAN, outcome: 'empty', retryAfterAt: null }, now: NOW, workWaiting: false },
    lines: ['Background upload: last run 2026-11-05 11:30 UTC, everything was sent.'] },
  { name: 'a run cut at its time limit is not a warning',
    upload: { status: { lastRunAt: RAN, outcome: 'deadline' }, now: NOW, workWaiting: true },
    lines: ['Background upload: last run 2026-11-05 11:30 UTC, stopped at its time limit with more to send; the next run continues.'] },
  { name: 'a stalled run backing off warns once, with the retry time and what to do',
    upload: { status: { lastRunAt: RAN, outcome: 'stalled', retryAfterAt: LATER }, now: NOW, workWaiting: true },
    lines: [
      'Background upload: last run 2026-11-05 11:30 UTC, could not send everything.',
      'Warning: the last background upload could not send everything it had, usually because there is no network or the sign-in has expired. Check your connection, and if this keeps happening run the login skill. Beezi retries on its own after 2026-11-05 12:05 UTC.',
    ] },
  { name: 'a crash whose backoff is over warns without a retry time',
    upload: { status: { lastRunAt: RAN, outcome: 'crash', retryAfterAt: RAN + 300000 }, now: NOW, workWaiting: false },
    lines: [
      'Background upload: last run 2026-11-05 11:30 UTC, crashed.',
      'Warning: the last background upload crashed. Beezi retries on its own; to send now and see the error, run the track skill.',
    ] },
  { name: 'a run the watchdog stopped warns',
    upload: { status: { lastRunAt: RAN, outcome: 'watchdog' }, now: NOW, workWaiting: false },
    lines: [
      'Background upload: last run 2026-11-05 11:30 UTC, was stopped for running too long.',
      'Warning: the last background upload was stopped for running too long. Beezi retries on its own; to send now, run the track skill.',
    ] },
  { name: 'a lock that could not be written warns even with no run time',
    upload: { status: { outcome: 'lock-failed', retryAfterAt: LATER }, now: NOW, workWaiting: true },
    lines: [
      'Background upload: could not start, because its lock file could not be written.',
      'Warning: the background upload could not write its lock file in Beezi’s data folder. Check that the folder is writable and the disk is not full. Beezi retries on its own after 2026-11-05 12:05 UTC.',
    ] },
  { name: 'a lock failure after an earlier run does not pair the old run’s time with it',
    upload: { status: { lastRunAt: RAN - 2 * HOUR, outcome: 'lock-failed', retryAfterAt: LATER }, now: NOW, workWaiting: false },
    lines: [
      'Background upload: could not start, because its lock file could not be written.',
      'Warning: the background upload could not write its lock file in Beezi’s data folder. Check that the folder is writable and the disk is not full. Beezi retries on its own after 2026-11-05 12:05 UTC.',
    ] },
  { name: 'tracking off warns with the wording true for both causes',
    upload: { status: { lastRunAt: RAN, outcome: 'tracking-disabled' }, now: NOW, workWaiting: false },
    lines: [
      'Background upload: last run 2026-11-05 11:30 UTC, sent nothing because tracking is off.',
      'Warning: the last background upload sent nothing: tracking is off for every linked account, or this machine’s Beezi data is waiting on an environment check. Run the settings skill to see each account’s state.',
    ] },
  { name: 'no account that could sign in warns to sign in again',
    upload: { status: { lastRunAt: RAN, outcome: 'no-accounts' }, now: NOW, workWaiting: false },
    lines: [
      'Background upload: last run 2026-11-05 11:30 UTC, sent nothing because no linked account could sign in.',
      'Warning: the last background upload found no linked account that could sign in. Run the login skill to sign in again.',
    ] },
  { name: 'a backoff still running after a quiet outcome warns',
    upload: { status: { lastRunAt: RAN, outcome: 'empty', retryAfterAt: LATER }, now: NOW, workWaiting: false },
    lines: [
      'Background upload: last run 2026-11-05 11:30 UTC, everything was sent.',
      'Warning: background uploads are paused until 2026-11-05 12:05 UTC after a failed run. Beezi retries on its own then; to send now, run the track skill.',
    ] },
  { name: 'waiting work with no run in the last 24 hours warns',
    upload: { status: { lastRunAt: NOW - 25 * HOUR, outcome: 'empty' }, now: NOW, workWaiting: true },
    lines: [
      'Background upload: last run 2026-11-04 11:00 UTC, everything was sent.',
      'Warning: analytics are waiting to upload, but no background upload has finished in the last 24 hours. Run the track skill to send them now.',
    ] },
  { name: 'waiting work with no run ever recorded warns',
    upload: { status: {}, now: NOW, workWaiting: true },
    lines: [
      'Background upload: no run has finished yet.',
      'Warning: analytics are waiting to upload, but no background upload has finished in the last 24 hours. Run the track skill to send them now.',
    ] },
  { name: 'an old run with nothing waiting is not a warning',
    upload: { status: { lastRunAt: NOW - 25 * HOUR, outcome: 'empty' }, now: NOW, workWaiting: false },
    lines: ['Background upload: last run 2026-11-04 11:00 UTC, everything was sent.'] },
  { name: 'a run that lost its lock to a successor is not a warning',
    upload: { status: { lastRunAt: RAN, outcome: 'lock-lost' }, now: NOW, workWaiting: false },
    lines: ['Background upload: last run 2026-11-05 11:30 UTC, handed over to another upload run.'] },
  { name: 'an outcome this build does not know is named as it is',
    upload: { status: { lastRunAt: RAN, outcome: 'future-thing' }, now: NOW, workWaiting: false },
    lines: ['Background upload: last run 2026-11-05 11:30 UTC, ended "future-thing".'] },
];

for (const c of uploadCases) {
  test(`upload status: ${c.name}`, () => {
    assert.deepEqual(uploadStatusLines(c.upload), c.lines);
  });
}

test('the upload lines sit between the route lines and the plugin line', () => {
  const upload = { status: { lastRunAt: RAN, outcome: 'crash' }, now: NOW, workWaiting: false };
  assert.deepEqual(statusExtraLines({ rows: [row], dir: REPO, ctx: ctx(), tracking: {}, plugin: CURRENT, upload }), [
    'This repo: labacus-suite → Acme (default)',
    'Background upload: last run 2026-11-05 11:30 UTC, crashed.',
    'Warning: the last background upload crashed. Beezi retries on its own; to send now and see the error, run the track skill.',
    'Plugin: 0.23.0, the newest',
  ]);
});

test('a machine with no linked account gets no upload lines', () => {
  const upload = { status: { lastRunAt: RAN, outcome: 'no-accounts' }, now: NOW, workWaiting: true };
  const revoked = { ...row, status: 'revoked' };
  assert.deepEqual(statusExtraLines({ rows: [revoked], dir: null, ctx: ctx(), tracking: {}, plugin: CURRENT, upload }), [
    'Plugin: 0.23.0, the newest',
  ]);
});

test('no upload reading leaves the answer as it was', () => {
  assert.deepEqual(statusExtraLines({ rows: [row], dir: null, ctx: ctx(), tracking: {}, plugin: CURRENT }), [
    'Plugin: 0.23.0, the newest',
  ]);
});
