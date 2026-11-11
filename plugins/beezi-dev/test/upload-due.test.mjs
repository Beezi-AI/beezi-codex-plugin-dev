import '../tools/hermetic-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  markUploadDue, listUploadDue, clearUploadDue, hasUploadDue, noteUploadDueAttempt, parkUploadDue,
} from '../lib/upload-due.mjs';
import { forgetHeldLocks, acquireLock as realAcquire } from '../lib/single-instance-lock.mjs';
import { makeHome } from '../tools/account-fixtures.mjs';

const T0 = Date.parse('2026-11-05T10:00:00.000Z');
const clock = (start = T0) => {
  let t = start;
  const now = () => t;
  now.set = (v) => { t = v; };
  return now;
};
const dueFile = (home, id) => path.join(home, 'upload-due', `${id}.json`);
const readMarker = (home, id) => JSON.parse(fs.readFileSync(dueFile(home, id), 'utf-8'));

test.afterEach(() => forgetHeldLocks());

test('marking a session writes one marker file holding exactly the fields given', (t) => {
  const home = makeHome(t, 'upload-due-');
  markUploadDue('s-1', { transcriptPath: 'C:/r/rollout-s-1.jsonl', cwd: 'C:/repo', timeline: true, sessionStart: false },
    { now: clock() });
  assert.deepEqual(readMarker(home, 's-1'), {
    version: 1,
    sessionId: 's-1',
    transcriptPath: 'C:/r/rollout-s-1.jsonl',
    cwd: 'C:/repo',
    timeline: true,
    sessionStart: false,
    markedAt: 1793872800000,
    attempts: 0,
  });
});

test('a second mark ORs the flags, keeps a path the new mark lacks and moves markedAt', (t) => {
  const home = makeHome(t, 'upload-due-');
  const now = clock();
  markUploadDue('s-1', { transcriptPath: 'C:/r/a.jsonl', cwd: 'C:/repo', timeline: false, sessionStart: true }, { now });
  now.set(T0 + 5000);
  markUploadDue('s-1', { transcriptPath: null, cwd: 'C:/repo/sub', timeline: true, sessionStart: false }, { now });
  assert.deepEqual(readMarker(home, 's-1'), {
    version: 1,
    sessionId: 's-1',
    transcriptPath: 'C:/r/a.jsonl',
    cwd: 'C:/repo/sub',
    timeline: true,
    sessionStart: true,
    markedAt: 1793872805000,
    attempts: 0,
  });
});

test('a re-mark in the same millisecond still moves markedAt forward', (t) => {
  const home = makeHome(t, 'upload-due-');
  const now = clock();
  markUploadDue('s-1', { timeline: false }, { now });
  markUploadDue('s-1', { timeline: false }, { now });
  assert.equal(readMarker(home, 's-1').markedAt, 1793872800001);
});

test('missing flags and paths are stored as false and null', (t) => {
  const home = makeHome(t, 'upload-due-');
  markUploadDue('s-1', {}, { now: clock() });
  assert.deepEqual(readMarker(home, 's-1'), {
    version: 1, sessionId: 's-1', transcriptPath: null, cwd: null, timeline: false, sessionStart: false,
    markedAt: 1793872800000, attempts: 0,
  });
});

test('an unusable session id writes nothing and returns null', (t) => {
  const home = makeHome(t, 'upload-due-');
  assert.equal(markUploadDue('../escape', { timeline: true }, { now: clock() }), null);
  assert.equal(markUploadDue(null, { timeline: true }, { now: clock() }), null);
  assert.equal(fs.existsSync(path.join(home, 'upload-due')), false);
});

test('a mark whose lock is refused still writes the marker: a duplicate run beats a lost one', (t) => {
  const home = makeHome(t, 'upload-due-');
  const acquireLock = () => ({ ok: false, reason: 'held', holder: null });
  markUploadDue('s-1', { timeline: true }, { now: clock(), acquireLock, sleepSync: () => {} });
  assert.equal(readMarker(home, 's-1').timeline, true);
});

test('listUploadDue returns every marker oldest first without the version field', (t) => {
  makeHome(t, 'upload-due-');
  const now = clock();
  markUploadDue('s-b', { cwd: 'C:/b', timeline: true }, { now });
  now.set(T0 - 1000);
  markUploadDue('s-a', { transcriptPath: 'C:/r/a.jsonl', sessionStart: true }, { now });
  assert.deepEqual(listUploadDue(), [
    { sessionId: 's-a', transcriptPath: 'C:/r/a.jsonl', cwd: null, timeline: false, sessionStart: true, markedAt: 1793872799000, attempts: 0, owedKeys: null },
    { sessionId: 's-b', transcriptPath: null, cwd: 'C:/b', timeline: true, sessionStart: false, markedAt: 1793872800000, attempts: 0, owedKeys: null },
  ]);
});

test('listUploadDue on a machine that never marked anything is empty', (t) => {
  makeHome(t, 'upload-due-');
  assert.deepEqual(listUploadDue(), []);
  assert.equal(hasUploadDue(), false);
});

test('listUploadDue skips a temp file and removes a corrupt marker so it cannot keep a worker spawning', (t) => {
  const home = makeHome(t, 'upload-due-');
  markUploadDue('s-ok', { timeline: true }, { now: clock() });
  fs.writeFileSync(path.join(home, 'upload-due', 's-ok.json.4242.tmp'), '{"half');
  fs.writeFileSync(dueFile(home, 's-bad'), 'not json');
  fs.writeFileSync(dueFile(home, 's-shape'), '[1,2]');
  assert.deepEqual(listUploadDue().map((e) => e.sessionId), ['s-ok']);
  assert.equal(fs.existsSync(dueFile(home, 's-bad')), false);
  assert.equal(fs.existsSync(dueFile(home, 's-shape')), false);
  assert.equal(fs.existsSync(path.join(home, 'upload-due', 's-ok.json.4242.tmp')), true);
});

test('hasUploadDue is true while a marker exists', (t) => {
  makeHome(t, 'upload-due-');
  markUploadDue('s-1', {}, { now: clock() });
  assert.equal(hasUploadDue(), true);
});

test('clearUploadDue removes a marker that was not re-marked since it was listed', (t) => {
  const home = makeHome(t, 'upload-due-');
  markUploadDue('s-1', { timeline: true }, { now: clock() });
  const [entry] = listUploadDue();
  assert.equal(clearUploadDue(entry), true);
  assert.equal(fs.existsSync(dueFile(home, 's-1')), false);
});

test('a re-mark between list and clear survives the clear with its flags', (t) => {
  const home = makeHome(t, 'upload-due-');
  const now = clock();
  markUploadDue('s-1', { timeline: false, sessionStart: true }, { now });
  const [entry] = listUploadDue();
  // A hook finishes a turn while the worker is mid-checkpoint on the same session.
  markUploadDue('s-1', { timeline: true }, { now });
  assert.equal(clearUploadDue(entry), false);
  assert.deepEqual(readMarker(home, 's-1'), {
    version: 1, sessionId: 's-1', transcriptPath: null, cwd: null, timeline: true, sessionStart: true,
    markedAt: 1793872800001, attempts: 0,
  });
});

test('clearUploadDue whose lock is refused leaves the marker for the next pass', (t) => {
  const home = makeHome(t, 'upload-due-');
  markUploadDue('s-1', { timeline: true }, { now: clock() });
  const [entry] = listUploadDue();
  const acquireLock = () => ({ ok: false, reason: 'held', holder: null });
  assert.equal(clearUploadDue(entry, { acquireLock, sleepSync: () => {} }), false);
  assert.equal(fs.existsSync(dueFile(home, 's-1')), true);
});

test('clearUploadDue of a marker that is already gone reports false and never throws', (t) => {
  makeHome(t, 'upload-due-');
  const entry = { sessionId: 's-gone', markedAt: T0 };
  assert.equal(clearUploadDue(entry), false);
  assert.equal(clearUploadDue(null), false);
  assert.equal(clearUploadDue({ sessionId: '../x', markedAt: T0 }), false);
});

// ── a refused lock: retry, then never a blind overwrite ─────────────────────────────────────────

// A lock that refuses `times` times with `reason`, then hands out the real one.
function refusingLock(times, reason, onRefuse = () => {}) {
  const log = { calls: 0 };
  const acquireLock = (target, options) => {
    log.calls += 1;
    if (log.calls <= times) { onRefuse(log.calls); return { ok: false, reason, holder: null }; }
    return realAcquire(target, options);
  };
  return { log, acquireLock };
}

test('a mark retries a busy lock, about 50 ms in all, and then writes under it', (t) => {
  const home = makeHome(t, 'upload-due-');
  const sleeps = [];
  const lock = refusingLock(2, 'held');
  markUploadDue('s-1', { timeline: true }, { now: clock(), acquireLock: lock.acquireLock, sleepSync: (ms) => sleeps.push(ms) });
  assert.equal(lock.log.calls, 3);
  assert.deepEqual(sleeps, [12, 12]);
  assert.equal(readMarker(home, 's-1').timeline, true);
});

test('a lock that stays busy is tried five times, 48 ms of sleep in all', (t) => {
  makeHome(t, 'upload-due-');
  const sleeps = [];
  const lock = refusingLock(99, 'contended');
  markUploadDue('s-1', {}, { now: clock(), acquireLock: lock.acquireLock, sleepSync: (ms) => sleeps.push(ms) });
  assert.equal(lock.log.calls, 5);
  assert.deepEqual(sleeps, [12, 12, 12, 12]);
});

test('a refusal that is not contention is not retried', (t) => {
  makeHome(t, 'upload-due-');
  const lock = refusingLock(99, 'lock-order');
  markUploadDue('s-1', {}, { now: clock(), acquireLock: lock.acquireLock, sleepSync: () => {} });
  assert.equal(lock.log.calls, 1);
});

test('a mark refused its lock still keeps the flags a locked mark wrote while it waited', (t) => {
  // Interleaving (b): mark A writes timeline:true under the lock while mark B is refused. B reads
  // only after its retries, immediately before its own write, so A's flag is OR-ed in, not reset.
  const home = makeHome(t, 'upload-due-');
  const now = clock();
  markUploadDue('s-1', { sessionStart: true }, { now });
  const lock = refusingLock(99, 'held', (call) => {
    if (call === 2) markUploadDue('s-1', { timeline: true }, { now });
  });
  markUploadDue('s-1', { cwd: 'C:/b' }, { now, acquireLock: lock.acquireLock, sleepSync: () => {} });
  const marker = readMarker(home, 's-1');
  assert.deepEqual([marker.timeline, marker.sessionStart, marker.cwd], [true, true, 'C:/b']);
});

test('a refused mark whose marker a clear unlinked right after its write writes it again', (t) => {
  // Interleaving (a): a clear holding the lock read the old marker, passed its compare, and its
  // unlink landed after the refused mark's rename. The mark re-reads after writing and restores it.
  const home = makeHome(t, 'upload-due-');
  const now = clock();
  let writes = 0;
  const writeJson = (file, record) => {
    writes += 1;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(record));
    if (writes === 1) fs.unlinkSync(file); // the clear's unlink
  };
  const lock = refusingLock(99, 'held');
  markUploadDue('s-1', { timeline: true }, { now, acquireLock: lock.acquireLock, sleepSync: () => {}, writeJson });
  assert.equal(writes, 2);
  assert.equal(readMarker(home, 's-1').timeline, true);
});

test('a mark under the lock writes once and does not re-check', (t) => {
  makeHome(t, 'upload-due-');
  let writes = 0;
  const writeJson = (file, record) => {
    writes += 1;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(record));
  };
  markUploadDue('s-1', {}, { now: clock(), writeJson });
  assert.equal(writes, 1);
});

test('a clear retries a busy lock and then clears', (t) => {
  const home = makeHome(t, 'upload-due-');
  markUploadDue('s-1', {}, { now: clock() });
  const [entry] = listUploadDue();
  const lock = refusingLock(3, 'held');
  assert.equal(clearUploadDue(entry, { acquireLock: lock.acquireLock, sleepSync: () => {} }), true);
  assert.equal(fs.existsSync(dueFile(home, 's-1')), false);
});

// ── the attempt cap ─────────────────────────────────────────────────────────────────────────────

test('each failed run is counted on the marker without moving markedAt', (t) => {
  const home = makeHome(t, 'upload-due-');
  markUploadDue('s-1', { timeline: true }, { now: clock() });
  const [entry] = listUploadDue();
  assert.deepEqual(noteUploadDueAttempt(entry), { attempts: 1, dropped: false });
  assert.deepEqual(noteUploadDueAttempt(entry), { attempts: 2, dropped: false });
  const marker = readMarker(home, 's-1');
  assert.deepEqual([marker.attempts, marker.markedAt, marker.timeline], [2, 1793872800000, true]);
});

test('the fifth failed run drops the marker', (t) => {
  const home = makeHome(t, 'upload-due-');
  markUploadDue('s-1', {}, { now: clock() });
  const [entry] = listUploadDue();
  for (let i = 1; i <= 4; i += 1) assert.deepEqual(noteUploadDueAttempt(entry), { attempts: i, dropped: false });
  assert.deepEqual(noteUploadDueAttempt(entry), { attempts: 5, dropped: true });
  assert.equal(fs.existsSync(dueFile(home, 's-1')), false);
});

test('a re-mark keeps the attempts already counted', (t) => {
  const home = makeHome(t, 'upload-due-');
  const now = clock();
  markUploadDue('s-1', {}, { now });
  noteUploadDueAttempt(listUploadDue()[0]);
  markUploadDue('s-1', { timeline: true }, { now });
  assert.equal(readMarker(home, 's-1').attempts, 1);
  assert.equal(listUploadDue()[0].attempts, 1);
});

test('counting an attempt on a marker that is gone, or under a refused lock, changes nothing', (t) => {
  const home = makeHome(t, 'upload-due-');
  assert.deepEqual(noteUploadDueAttempt({ sessionId: 's-gone', markedAt: T0 }), { attempts: 0, dropped: false });
  markUploadDue('s-1', {}, { now: clock() });
  const acquireLock = () => ({ ok: false, reason: 'held', holder: null });
  assert.deepEqual(noteUploadDueAttempt(listUploadDue()[0], { acquireLock, sleepSync: () => {} }), { attempts: 0, dropped: false });
  assert.equal(readMarker(home, 's-1').attempts, 0);
  assert.deepEqual(noteUploadDueAttempt(null), { attempts: 0, dropped: false });
});

// ── fix round 2: a read error is not an absent marker ──────────────────────────────────────────

// A readFileSync that throws `code` for the first `times` reads of a marker, then reads for real.
function flakyRead(times, code) {
  const log = { reads: 0 };
  const readFileSync = (file, enc) => {
    log.reads += 1;
    if (log.reads <= times) { const e = new Error(code); e.code = code; throw e; }
    return fs.readFileSync(file, enc);
  };
  return { log, readFileSync };
}

test('a mark whose read hits a transient EPERM retries the read and still merges', (t) => {
  const home = makeHome(t, 'upload-due-');
  const now = clock();
  markUploadDue('s-1', { timeline: true }, { now });
  const read = flakyRead(2, 'EPERM');
  const sleeps = [];
  markUploadDue('s-1', { cwd: 'C:/b' }, { now, readFileSync: read.readFileSync, sleepSync: (ms) => sleeps.push(ms) });
  const marker = readMarker(home, 's-1');
  assert.deepEqual([marker.timeline, marker.cwd], [true, 'C:/b']);
  assert.deepEqual(sleeps, [5, 5]);
});

test('a mark whose read keeps failing writes nothing rather than overwrite the marker', (t) => {
  const home = makeHome(t, 'upload-due-');
  const now = clock();
  markUploadDue('s-1', { timeline: true, sessionStart: true }, { now });
  const before = fs.readFileSync(dueFile(home, 's-1'), 'utf-8');
  const read = flakyRead(99, 'EBUSY');
  assert.equal(markUploadDue('s-1', { cwd: 'C:/b' }, { now, readFileSync: read.readFileSync, sleepSync: () => {} }), null);
  assert.equal(read.log.reads, 3);
  assert.equal(fs.readFileSync(dueFile(home, 's-1'), 'utf-8'), before);
});

test('an unlocked mark whose read keeps failing also writes nothing', (t) => {
  const home = makeHome(t, 'upload-due-');
  const now = clock();
  markUploadDue('s-1', { timeline: true }, { now });
  const before = fs.readFileSync(dueFile(home, 's-1'), 'utf-8');
  const acquireLock = () => ({ ok: false, reason: 'held', holder: null });
  const read = flakyRead(99, 'EPERM');
  assert.equal(markUploadDue('s-1', {}, { now, acquireLock, readFileSync: read.readFileSync, sleepSync: () => {} }), null);
  assert.equal(fs.readFileSync(dueFile(home, 's-1'), 'utf-8'), before);
});

test('a first mark, whose read is ENOENT, is written without retrying', (t) => {
  const home = makeHome(t, 'upload-due-');
  const sleeps = [];
  markUploadDue('s-1', { timeline: true }, { now: clock(), sleepSync: (ms) => sleeps.push(ms) });
  assert.equal(readMarker(home, 's-1').timeline, true);
  assert.deepEqual(sleeps, []);
});

test('a clear whose read keeps failing leaves the marker', (t) => {
  const home = makeHome(t, 'upload-due-');
  markUploadDue('s-1', {}, { now: clock() });
  const [entry] = listUploadDue();
  const read = flakyRead(99, 'EPERM');
  assert.equal(clearUploadDue(entry, { readFileSync: read.readFileSync, sleepSync: () => {} }), false);
  assert.equal(fs.existsSync(dueFile(home, 's-1')), true);
});

// ── fix round 2: a re-mark is not charged for the run that saw the older mark ──────────────────

test('an attempt noted against a marker re-marked since it was listed is not charged', (t) => {
  const home = makeHome(t, 'upload-due-');
  const now = clock();
  markUploadDue('s-1', {}, { now });
  const [stale] = listUploadDue();
  markUploadDue('s-1', { timeline: true }, { now });
  assert.deepEqual(noteUploadDueAttempt(stale), { attempts: 0, dropped: false });
  assert.equal(readMarker(home, 's-1').attempts, 0);
});

// ── fix round 2: only a mark newer than the last run starts a worker ───────────────────────────

// The marker file's mtime IS its last mark (every mark rewrites it; bookkeeping writes restore it),
// so the hook-path check is a readdir plus a stat per marker and never parses one.
const setMtime = (home, id, ms) => fs.utimesSync(dueFile(home, id), new Date(ms), new Date(ms));

test('hasUploadDue(since) is true only for a marker whose file was written after `since`', (t) => {
  const home = makeHome(t, 'upload-due-');
  assert.equal(hasUploadDue(T0), false);
  markUploadDue('s-1', {}, { now: () => T0 });
  setMtime(home, 's-1', T0);
  assert.equal(hasUploadDue(T0), false);
  assert.equal(hasUploadDue(T0 - 1), true);
  assert.equal(hasUploadDue(), true);
});

test('hasUploadDue reads no marker contents', (t) => {
  const home = makeHome(t, 'upload-due-');
  markUploadDue('s-1', {}, { now: () => T0 });
  markUploadDue('s-2', {}, { now: () => T0 });
  setMtime(home, 's-1', T0);
  setMtime(home, 's-2', T0);
  const dir = path.join(home, 'upload-due');
  const read = t.mock.method(fs, 'readFileSync');
  assert.equal(hasUploadDue(T0), false);
  assert.equal(hasUploadDue(T0 - 1), true);
  assert.equal(read.mock.calls.filter((c) => String(c.arguments[0]).indexOf(dir) === 0).length, 0);
});

// ── fix round 3: parking a marker on the accounts that still owe its timeline ───────────────────

test('parking records the owed account keys on the marker and keeps markedAt and the file mtime', (t) => {
  const home = makeHome(t, 'upload-due-');
  markUploadDue('s-1', { timeline: true }, { now: clock() });
  setMtime(home, 's-1', T0);
  const [entry] = listUploadDue();
  assert.equal(entry.owedKeys, null);
  assert.equal(parkUploadDue(entry, ['bbbb2222']), true);
  const marker = readMarker(home, 's-1');
  assert.deepEqual([marker.owedKeys, marker.markedAt, marker.timeline], [['bbbb2222'], 1793872800000, true]);
  assert.deepEqual(listUploadDue()[0].owedKeys, ['bbbb2222']);
  assert.equal(fs.statSync(dueFile(home, 's-1')).mtimeMs, 1793872800000);
});

test('counting an attempt keeps the file mtime, so bookkeeping never looks like a new mark', (t) => {
  const home = makeHome(t, 'upload-due-');
  markUploadDue('s-1', {}, { now: clock() });
  setMtime(home, 's-1', T0);
  noteUploadDueAttempt(listUploadDue()[0]);
  assert.equal(fs.statSync(dueFile(home, 's-1')).mtimeMs, 1793872800000);
});

test('a re-mark clears the owed keys: new work runs in full', (t) => {
  const home = makeHome(t, 'upload-due-');
  const now = clock();
  markUploadDue('s-1', { timeline: true }, { now });
  parkUploadDue(listUploadDue()[0], ['bbbb2222']);
  markUploadDue('s-1', {}, { now });
  assert.equal(readMarker(home, 's-1').owedKeys, undefined);
  assert.equal(listUploadDue()[0].owedKeys, null);
});

test('parking a marker re-marked since it was listed, or with no usable keys, changes nothing', (t) => {
  const home = makeHome(t, 'upload-due-');
  const now = clock();
  markUploadDue('s-1', {}, { now });
  const [stale] = listUploadDue();
  markUploadDue('s-1', { timeline: true }, { now });
  assert.equal(parkUploadDue(stale, ['bbbb2222']), false);
  assert.equal(parkUploadDue(listUploadDue()[0], []), false);
  assert.equal(parkUploadDue(listUploadDue()[0], ['../x', 7]), false);
  assert.equal(readMarker(home, 's-1').owedKeys, undefined);
  assert.equal(parkUploadDue(null, ['bbbb2222']), false);
});

test('counting an attempt keeps the owed keys', (t) => {
  makeHome(t, 'upload-due-');
  markUploadDue('s-1', {}, { now: clock() });
  parkUploadDue(listUploadDue()[0], ['bbbb2222']);
  noteUploadDueAttempt(listUploadDue()[0]);
  assert.deepEqual(listUploadDue()[0].owedKeys, ['bbbb2222']);
});
