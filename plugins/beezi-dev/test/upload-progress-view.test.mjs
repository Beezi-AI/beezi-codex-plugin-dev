import '../tools/hermetic-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  progressBar, barLine, liveLine, plainLine, doneLine, REST_LINE, followUploads,
} from '../lib/upload-progress-view.mjs';

const T0 = Date.parse('2026-11-18T10:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const record = (over = {}) => ({
  key: 'k', tenantId: 'A', workspace: 'Acme', processed: 30, total: 100, sent: 28,
  startedAt: iso(T0), updatedAt: iso(T0), finishedAt: null, reported: false, ...over,
});
const fakeClock = () => {
  let t = T0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
};
// script(tenantId, nowMs) returns what the record file holds at each poll.
const follow = (script, over = {}) => {
  const clock = fakeClock();
  const updates = [];
  const dones = [];
  const run = followUploads({
    key: 'k', tenantIds: ['A'], sinceMs: T0,
    onUpdate: (r) => updates.push(r), onDone: (r) => dones.push(r),
    read: (key, tenantId) => script(tenantId, clock.now()),
    now: clock.now, sleep: clock.sleep, ...over,
  });
  return run.then((outcome) => ({ outcome, updates, dones, elapsed: clock.now() - T0 }));
};

test('progressBar fills 14 cells by the share processed', () => {
  assert.equal(progressBar(30, 100), '▓▓▓▓░░░░░░░░░░');
});

test('progressBar draws # and - with ascii', () => {
  assert.equal(progressBar(30, 100, { ascii: true }), '####----------');
});

test('progressBar with a zero total is all empty cells', () => {
  assert.equal(progressBar(0, 0), '░░░░░░░░░░░░░░');
});

test('barLine names the workspace, the bar and the counts', () => {
  assert.equal(barLine(record(), {}), 'Uploading past sessions to Acme  ▓▓▓▓░░░░░░░░░░  30/100');
});

test('barLine passes ascii through to the bar', () => {
  assert.equal(barLine(record(), { ascii: true }), 'Uploading past sessions to Acme  ####----------  30/100');
});

test('barLine cuts a workspace name that does not fit the width with …', () => {
  assert.equal(
    barLine(record({ workspace: 'Acme Corporation Platform Team' }), { width: 61 }),
    'Uploading past sessions to Acme Corp…  ▓▓▓▓░░░░░░░░░░  30/100',
  );
});

test('barLine keeps a workspace name that fits the width exactly', () => {
  assert.equal(barLine(record(), { width: 55 }), 'Uploading past sessions to Acme  ▓▓▓▓░░░░░░░░░░  30/100');
});

test('barLine one character too narrow cuts the name to two letters and …', () => {
  assert.equal(barLine(record(), { width: 54 }), 'Uploading past sessions to Ac…  ▓▓▓▓░░░░░░░░░░  30/100');
});

test('plainLine shows sessions read', () => {
  assert.equal(plainLine(record()), 'Beezi: 30/100 sessions read…');
});

test('liveLine shows the spinner and the bar while reading', () => {
  const line = liveLine(record({ workspace: 'AndriiTest', processed: 120, total: 225 }), { tick: 1 });
  assert.equal(line, '⠙ Uploading past sessions to AndriiTest  ▓▓▓▓▓▓▓░░░░░░░  120/225');
});

test('liveLine says finishing once every session is read', () => {
  const line = liveLine(record({ workspace: 'AndriiTest', processed: 225, total: 225 }), { tick: 0 });
  assert.equal(line, '⠋ Finishing upload to AndriiTest…');
});

test('liveLine uses ASCII frames on request', () => {
  const line = liveLine(record({ workspace: 'AndriiTest', processed: 225, total: 225 }), { ascii: true, tick: 2 });
  assert.equal(line, '- Finishing upload to AndriiTest…');
});

test('liveLine wraps the spinner frames around', () => {
  assert.equal(liveLine(record(), { tick: 10 }), '⠋ Uploading past sessions to Acme  ▓▓▓▓░░░░░░░░░░  30/100');
  assert.equal(liveLine(record(), { ascii: true, tick: 4 }), '| Uploading past sessions to Acme  ####----------  30/100');
});

test('liveLine keeps the whole line, spinner included, inside the width', () => {
  const reading = liveLine(record({ workspace: 'Acme Corporation Platform Team' }), { width: 61 });
  assert.equal(reading, '⠋ Uploading past sessions to Acme Co…  ▓▓▓▓░░░░░░░░░░  30/100');
  const finishing = liveLine(record({ workspace: 'Acme Corporation Platform Team', processed: 100 }), { width: 30 });
  assert.equal(finishing, '⠋ Finishing upload to Acme Co…');
});

test('plainLine says all sessions read once processed reaches total', () => {
  assert.equal(plainLine(record({ processed: 225, total: 225 })), 'Beezi: all sessions read, finishing upload…');
});

test('plainLine with no sessions to read is not finishing', () => {
  assert.equal(plainLine(record({ processed: 0, total: 0 })), 'Beezi: 0/0 sessions read…');
});

test('doneLine uses the singular for one session sent', () => {
  assert.equal(doneLine(record({ sent: 1 })), '✓ 1 past session uploaded to Acme');
});

test('doneLine uses the plural for many sessions sent', () => {
  assert.equal(doneLine(record({ sent: 100 })), '✓ 100 past sessions uploaded to Acme');
});

test('REST_LINE says the rest keeps uploading', () => {
  assert.equal(REST_LINE, 'Beezi: the rest keeps uploading in the background');
});

test('follows two workspaces in order and reports each done once', async () => {
  const script = (tenantId, nowMs) => {
    const doneAt = tenantId === 'A' ? T0 + 2000 : T0 + 4000;
    if (nowMs < doneAt) return record({ tenantId, processed: 1, updatedAt: iso(nowMs) });
    return record({ tenantId, processed: 100, sent: 100, updatedAt: iso(doneAt), finishedAt: iso(doneAt) });
  };
  const { outcome, dones } = await follow(script, { tenantIds: ['A', 'B'] });
  assert.deepEqual(dones.map((r) => r.tenantId), ['A', 'B']);
  assert.equal(outcome.finished.length, 2);
  assert.equal(outcome.timedOut, false);
  assert.equal(outcome.stopped, false);
});

test('calls onUpdate only when processed changes', async () => {
  const script = (tenantId, nowMs) => {
    if (nowMs >= T0 + 3000) return record({ processed: 100, updatedAt: iso(nowMs), finishedAt: iso(nowMs) });
    return record({ processed: nowMs >= T0 + 2000 ? 40 : 30, updatedAt: iso(nowMs) });
  };
  const { updates } = await follow(script);
  assert.deepEqual(updates.map((r) => r.processed), [30, 40]);
});

test('ticks on every poll of a live record, though processed stays the same', async () => {
  const script = (tenantId, nowMs) => {
    if (nowMs >= T0 + 3000) return record({ processed: 225, total: 225, updatedAt: iso(nowMs), finishedAt: iso(nowMs) });
    return record({ processed: 225, total: 225, updatedAt: iso(nowMs) });
  };
  const ticks = [];
  const { updates, dones } = await follow(script, { onTick: (r, tick) => ticks.push(tick) });
  assert.deepEqual(ticks, [0, 1, 2]);
  assert.equal(updates.length, 1);
  assert.equal(dones.length, 1);
});

test('ignores a finished record that started before sinceMs - 5000', async () => {
  const old = record({ startedAt: iso(T0 - 5001), updatedAt: iso(T0 - 5001), finishedAt: iso(T0 - 5001) });
  const { outcome, dones, elapsed } = await follow(() => old);
  assert.deepEqual(dones, []);
  assert.deepEqual(outcome, { finished: [], timedOut: false, stopped: true });
  assert.equal(elapsed, 120000);
});

test('counts a record that started 5000 ms before sinceMs as fresh', async () => {
  const done = record({ startedAt: iso(T0 - 5000), finishedAt: iso(T0) });
  const { outcome } = await follow(() => done);
  assert.equal(outcome.finished.length, 1);
});

test('stops after 120 s with no record', async () => {
  const { outcome, elapsed } = await follow(() => null);
  assert.deepEqual(outcome, { finished: [], timedOut: false, stopped: true });
  assert.equal(elapsed, 120000);
});

test('stops 120 s after the running record stops being live', async () => {
  const frozen = record({ updatedAt: iso(T0) });
  const { outcome, elapsed } = await follow(() => frozen);
  assert.equal(outcome.stopped, true);
  assert.equal(elapsed, 240000);
});

test('times out at capMs while the upload is still running', async () => {
  const script = (tenantId, nowMs) => record({ processed: 1, updatedAt: iso(nowMs) });
  const { outcome, elapsed } = await follow(script, { capMs: 100000 });
  assert.deepEqual(outcome, { finished: [], timedOut: true, stopped: false });
  assert.equal(elapsed, 100000);
});

test('stops on the next tick once shouldStop is true', async () => {
  let ticks = 0;
  const script = (tenantId, nowMs) => record({ processed: 1, updatedAt: iso(nowMs) });
  const { outcome, elapsed } = await follow(script, { shouldStop: () => { ticks += 1; return ticks > 1; } });
  assert.deepEqual(outcome, { finished: [], timedOut: false, stopped: true });
  assert.equal(elapsed, 1000);
});

test('a finished record of a run that did not end clean stops the follow without a done line', async () => {
  const script = (tenantId, nowMs) => {
    if (nowMs < T0 + 2000) return record({ processed: 1, total: 40, updatedAt: iso(nowMs) });
    return record({ processed: 1, total: 40, sent: 1, updatedAt: iso(T0 + 2000), finishedAt: iso(T0 + 2000), failed: true });
  };
  const { outcome, dones, elapsed } = await follow(script, { tenantIds: ['A', 'B'] });
  assert.deepEqual(dones, []);
  assert.deepEqual(outcome, { finished: [], timedOut: false, stopped: true });
  assert.equal(elapsed, 2000);
});

test('a finished record with failed: false is done', async () => {
  const done = record({ finishedAt: iso(T0), failed: false });
  const { outcome, dones } = await follow(() => done);
  assert.equal(dones.length, 1);
  assert.equal(outcome.stopped, false);
});
