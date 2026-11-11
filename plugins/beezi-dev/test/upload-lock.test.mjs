import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withUploadLock } from '../lib/upload-lock.mjs';
import { acquireLock, runLock, forgetHeldLocks, heldLocks, inspectLock } from '../lib/single-instance-lock.mjs';

// The manual drains' hold on runLock('upload'): the one lock the background upload worker runs
// under, so a terminal drain and the worker never send at the same time. Waits up to 60 s, polling
// every 500 ms; anything but a busy lock is answered at once.

test.afterEach(() => forgetHeldLocks());

// A fake clock the sleep advances: no real waiting anywhere in this file.
function clock(start = 1_000_000) {
  const state = { t: start, sleeps: [] };
  return {
    state,
    now: () => state.t,
    sleep: async (ms) => { state.sleeps.push(ms); state.t += ms; },
  };
}

const noTimers = { setIntervalImpl: () => null, clearIntervalImpl: () => {} };

test('a free lock runs the work under run-upload, releases it, then starts the worker once', async () => {
  const seen = [];
  const triggers = [];
  const out = await withUploadLock(async () => {
    seen.push(heldLocks().map((l) => `${l.kind}:${l.name}`));
    return 'sent';
  }, { ...noTimers, maybeSpawnUploadWorker: () => { triggers.push(heldLocks().length); return 'disabled'; } });

  assert.deepEqual(out, { ok: true, value: 'sent' });
  assert.deepEqual(seen, [['run:run-upload']]);
  assert.deepEqual(heldLocks(), []);
  assert.equal(inspectLock(runLock('upload')).held, false);
  // After the release: a hook that enqueued during the hold saw a running worker and spawned none.
  assert.deepEqual(triggers, [0]);
});

test('a lock held by another process the whole time: 121 tries 500 ms apart, then busy, and the work never runs', async () => {
  const c = clock();
  let tries = 0;
  let ran = false;
  const out = await withUploadLock(async () => { ran = true; }, {
    ...noTimers,
    now: c.now,
    sleep: c.sleep,
    acquireLock: () => { tries += 1; return { ok: false, reason: 'held' }; },
    maybeSpawnUploadWorker: () => { throw new Error('a busy drain starts no worker'); },
  });

  assert.deepEqual(out, { ok: false, reason: 'busy', detail: 'held' });
  assert.equal(ran, false);
  assert.equal(tries, 121);
  assert.equal(c.state.sleeps.length, 120);
  assert.ok(c.state.sleeps.every((ms) => ms === 500));
  assert.equal(c.state.t - 1_000_000, 60_000);
});

test('a contended breaker is busy too, and a lock freed on the third try is taken', async () => {
  const c = clock();
  const answers = [{ ok: false, reason: 'contended' }, { ok: false, reason: 'held' }];
  const handle = { renew: () => ({ ok: true }), release: () => ({ ok: true }) };
  const out = await withUploadLock(async () => 'late', {
    ...noTimers,
    now: c.now,
    sleep: c.sleep,
    acquireLock: () => answers.shift() || { ok: true, handle },
    maybeSpawnUploadWorker: () => 'disabled',
  });
  assert.deepEqual(out, { ok: true, value: 'late' });
  assert.deepEqual(c.state.sleeps, [500, 500]);
});

test('a real lock held by another holder on this machine reads as busy', async () => {
  const other = acquireLock(runLock('upload'), { leaseMs: 150000 });
  assert.equal(other.ok, true);
  // Out of this process's registry: what remains on disk is a live foreign holder.
  forgetHeldLocks();
  const c = clock();
  const out = await withUploadLock(async () => 'never', { ...noTimers, now: c.now, sleep: c.sleep, waitMs: 1000 });
  assert.deepEqual(out, { ok: false, reason: 'busy', detail: 'held' });
  assert.deepEqual(c.state.sleeps, [500, 500]);
  other.handle.release();
});

const refusals = ['lock-order', 'write-failed', 'mkdir-failed'];
for (const reason of refusals) {
  test(`a '${reason}' refusal is answered at once, never waited out as busy`, async () => {
    const c = clock();
    let tries = 0;
    const out = await withUploadLock(async () => 'never', {
      ...noTimers,
      now: c.now,
      sleep: c.sleep,
      acquireLock: () => { tries += 1; return { ok: false, reason, detail: 'why' }; },
    });
    assert.deepEqual(out, { ok: false, reason, detail: 'why' });
    assert.equal(tries, 1);
    assert.deepEqual(c.state.sleeps, []);
  });
}

test('a lock acquire that throws is a lock-failed answer, not a throw', async () => {
  const out = await withUploadLock(async () => 'never', {
    ...noTimers,
    acquireLock: () => { throw new Error('locks dir unwritable'); },
  });
  assert.deepEqual(out, { ok: false, reason: 'lock-failed', detail: 'locks dir unwritable' });
});

test('the hold is renewed every 60 s with the worker lease of 150 s, and the timer is cleared', async () => {
  const renews = [];
  let tick = null;
  const cleared = [];
  const handle = { renew: (o) => { renews.push(o); return { ok: true }; }, release: () => ({ ok: true }) };
  await withUploadLock(async () => { tick(); tick(); }, {
    acquireLock: (target, options) => {
      assert.deepEqual([target.kind, target.name, options.leaseMs], ['run', 'run-upload', 150000]);
      return { ok: true, handle };
    },
    setIntervalImpl: (fn, ms) => { assert.equal(ms, 60000); tick = fn; return 'timer-1'; },
    clearIntervalImpl: (id) => cleared.push(id),
    maybeSpawnUploadWorker: () => 'disabled',
  });
  assert.deepEqual(renews, [{ leaseMs: 150000 }, { leaseMs: 150000 }]);
  assert.deepEqual(cleared, ['timer-1']);
});

test('work that throws still releases the lock, and the throw reaches the caller', async () => {
  await assert.rejects(
    withUploadLock(async () => { throw new Error('drain blew up'); }, { ...noTimers, maybeSpawnUploadWorker: () => 'disabled' }),
    /drain blew up/,
  );
  assert.deepEqual(heldLocks(), []);
  assert.equal(inspectLock(runLock('upload')).held, false);
});

test('work that throws still starts the worker after the release: what it saved is handed off', async () => {
  const triggers = [];
  await assert.rejects(withUploadLock(async () => { throw new Error('drain blew up'); }, {
    ...noTimers,
    maybeSpawnUploadWorker: () => { triggers.push(heldLocks().length); return 'disabled'; },
  }), /drain blew up/);
  assert.deepEqual(triggers, [0]);
});
