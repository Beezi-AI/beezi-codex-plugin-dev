import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  loadLedger,
  saveLedger,
  markImported,
  markUnreadable,
  markComplete,
  isImported,
  isComplete,
  wasUnreadable,
} from '../lib/audit-ledger.mjs';
import {
  readTrackingState,
  markBackfillCompleted,
  markTrackingDisabled,
  markLinked,
} from '../lib/tracking.mjs';
import { auditLedgerFile, trackingStateFile } from '../lib/paths.mjs';
import {
  acquireLock,
  forgetHeldLocks,
  sharedLock,
  sessionLock,
} from '../lib/single-instance-lock.mjs';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The two shared files G-8-3 names as raced: ~/.beezi-codex/audit-ledger.json and tracking.json.
//
// Both are whole-file replaces of an in-memory object that was read earlier, and writeJsonSecure
// makes each write ATOMIC — which is exactly why the bug is invisible without a test. Nothing is
// ever torn. Two well-formed writes simply land in order and the second erases whatever the first
// one had added.
//
// The interleaved-save cases below are the ones that bite. A single-writer round-trip passes with
// or without the lock; only "B loaded before A saved" distinguishes them.
// ─────────────────────────────────────────────────────────────────────────────────────────────

afterEach(() => forgetHeldLocks());

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-lockshared-'));
  const prev = process.env.BEEZI_CODEX_HOME;
  process.env.BEEZI_CODEX_HOME = dir;
  t.after(() => {
    forgetHeldLocks();
    if (prev === undefined) delete process.env.BEEZI_CODEX_HOME;
    else process.env.BEEZI_CODEX_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function heldElsewhere(target) {
  const got = acquireLock(target, { leaseMs: 60_000 }, { pid: () => 999_999 });
  assert.equal(got.ok, true, 'the fixture itself must take the lock');
  forgetHeldLocks();
  return got.handle;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The audit ledger — the last-writer-wins hazard G-8-3 opens with.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('two runs that both loaded the same ledger keep BOTH their imported rows', (t) => {
  tmpHome(t);
  // Run B loads before run A saves. This is the whole hazard: `runAudit` loads the ledger once at
  // the top of a scan that can take minutes, mutates it in memory, and writes it back whole.
  const a = loadLedger('client-1');
  const b = loadLedger('client-1');

  markImported(a, 'sess-A', { outcome: 'stored', reports: 1 });
  markImported(b, 'sess-B', { outcome: 'stored', reports: 2 });

  assert.equal(saveLedger(a).written, true);
  assert.equal(saveLedger(b).written, true);

  const disk = loadLedger('client-1');
  assert.equal(isImported(disk, 'sess-A'), true,
    "run A's marker survived run B's save — without the re-read-and-merge it is simply gone, and "
    + 'an already-uploaded session looks importable again on the next run');
  assert.equal(isImported(disk, 'sess-B'), true);
  // The caller's own copy stops being the stale one, so its later isImported() checks are honest.
  assert.equal(isImported(b, 'sess-A'), true);
});

test('a stale save can never un-seal a one-time pull', (t) => {
  tmpHome(t);
  const a = loadLedger('client-1');
  const b = loadLedger('client-1'); // loaded while the pull was still open

  markComplete(a);
  assert.equal(saveLedger(a).written, true);

  markImported(b, 'sess-B', { outcome: 'stored' });
  assert.equal(saveLedger(b).written, true);

  assert.equal(isComplete(loadLedger('client-1')), true,
    'the seal is one-time and has no reopen, so `complete` merges as a logical OR');
});

test('an unreadable marker is not resurrected for a session that has since imported', (t) => {
  tmpHome(t);
  const a = loadLedger('client-1');
  const b = loadLedger('client-1');

  markUnreadable(a, 'sess-X');
  saveLedger(a);
  markImported(b, 'sess-X', { outcome: 'stored' });
  saveLedger(b);

  const disk = loadLedger('client-1');
  assert.equal(isImported(disk, 'sess-X'), true);
  assert.equal(wasUnreadable(disk, 'sess-X'), false,
    'a naive union would make wasUnreadable() answer yes forever for an imported session');
});

test('the merge never replays another login\'s imported set', (t) => {
  tmpHome(t);
  const other = loadLedger('client-OTHER');
  markImported(other, 'sess-FOREIGN', { outcome: 'stored' });
  saveLedger(other);

  // A logout → login into a different workspace. loadLedger discards the foreign record; the save
  // must discard it too, or the new tenant inherits an imported set it never uploaded and seals its
  // own one-time pull empty.
  const mine = loadLedger('client-MINE');
  markImported(mine, 'sess-MINE', { outcome: 'stored' });
  saveLedger(mine);

  const disk = loadLedger('client-MINE');
  assert.equal(isImported(disk, 'sess-FOREIGN'), false);
  assert.equal(isImported(disk, 'sess-MINE'), true);
});

test('a ledger save whose lock is held elsewhere defers without writing', (t) => {
  tmpHome(t);
  const ledger = loadLedger('client-1');
  markImported(ledger, 'sess-A', { outcome: 'stored' });

  const holder = heldElsewhere(sharedLock('audit-ledger'));
  const blocked = saveLedger(ledger);
  assert.equal(blocked.written, false);
  assert.equal(blocked.reason, 'held');
  assert.equal(fs.existsSync(auditLedgerFile()), false, 'nothing was written');

  assert.equal(holder.release().ok, true);
  forgetHeldLocks();
  assert.equal(saveLedger(ledger).written, true);
  assert.equal(isImported(loadLedger('client-1'), 'sess-A'), true,
    'the rows were still in memory, so the deferred save loses nothing');
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// tracking.json.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('a tracking write whose lock is held elsewhere defers without writing', (t) => {
  tmpHome(t);
  const holder = heldElsewhere(sharedLock('tracking'));

  const blocked = markBackfillCompleted();
  assert.equal(blocked.written, false);
  assert.equal(blocked.reason, 'held');
  assert.equal(fs.existsSync(trackingStateFile()), false);

  assert.equal(holder.release().ok, true);
  forgetHeldLocks();
  assert.equal(markBackfillCompleted().written, true);
  assert.equal(readTrackingState().backfillCompleted, true);
});

test('every tracking mutator goes through the one lock, so none of them can clobber another', (t) => {
  tmpHome(t);
  assert.equal(markLinked().written, true);
  assert.equal(markTrackingDisabled('audit mode').written, true);
  assert.equal(markBackfillCompleted().written, true);

  const state = readTrackingState();
  assert.ok(state.linkedAt, 'the link stamp survived two later merges');
  assert.equal(state.trackingMode, 'disabled');
  assert.equal(state.backfillCompleted, true);

  const holder = heldElsewhere(sharedLock('tracking'));
  for (const [name, call] of [
    ['markLinked', () => markLinked()],
    ['markTrackingDisabled', () => markTrackingDisabled('x')],
    ['markBackfillCompleted', () => markBackfillCompleted()],
  ]) {
    const out = call();
    assert.equal(out.written, false, `${name} must take the same lock`);
    assert.equal(out.reason, 'held', `${name} must report a busy lock, not fail silently`);
  }
  holder.release();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Lock ORDER. These two prove the wiring's shape, not the primitive's.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('rank-3 locks are never nested: tracking-while-holding-queue is a lock-order BUG, not a busy lock', (t) => {
  tmpHome(t);
  // Held by THIS process, deliberately — no forgetHeldLocks(). That is what makes the ordering
  // guard, rather than the filesystem, answer.
  const queue = acquireLock(sharedLock('queue'), { leaseMs: 60_000 });
  assert.equal(queue.ok, true);

  const nested = markBackfillCompleted();
  assert.equal(nested.written, false);
  assert.equal(nested.reason, 'lock-order',
    "NOT 'held' — this refusal would repeat forever, so it must never be deferred and retried");
  assert.equal(fs.existsSync(trackingStateFile()), false);

  // The same is true of the other rank-3 pairing.
  const ledger = loadLedger('client-1');
  markImported(ledger, 'sess-A', { outcome: 'stored' });
  assert.equal(saveLedger(ledger).reason, 'lock-order');

  // Release the queue lock and the identical calls succeed, so the refusal was the ordering guard
  // and nothing else. This is the invariant lib/checkpoint.mjs's hoisted `verdict` exists to keep.
  assert.equal(queue.handle.release().ok, true);
  assert.equal(markBackfillCompleted().written, true);
  assert.equal(saveLedger(ledger).written, true);
});

test('coarse-to-fine is fine: a rank-1 or rank-2 holder may still take a rank-3 lock', (t) => {
  tmpHome(t);
  // The backfill holds run(1) across its scan and each checkpoint holds session(2); both reach for
  // the ledger and tracking from inside. Refusing that would leave the audit unable to record
  // anything it learned.
  const session = acquireLock(sessionLock('s1'), { leaseMs: 60_000 });
  assert.equal(session.ok, true);

  assert.equal(markBackfillCompleted().written, true);
  const ledger = loadLedger('client-1');
  markImported(ledger, 'sess-A', { outcome: 'stored' });
  assert.equal(saveLedger(ledger).written, true);

  session.handle.release();
});
