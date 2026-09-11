import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTrackTarget, trackSession } from '../lib/track-session.mjs';

const SESSION = { sessionId: 's1', transcriptPath: 'C:/roll.jsonl', cwd: 'C:/work/my-repo' };

const linked = { getAccessToken: async () => 'tok' };
const onBranch = (branch) => ({ currentBranch: () => branch });
const checkpoint = (result) => ({ runCheckpoint: async () => result });

test('an unlinked machine refuses before doing any work', async () => {
  let ran = false;
  const { ok, message } = await trackSession(SESSION, {
    getAccessToken: async () => null,
    runCheckpoint: async () => { ran = true; return { outcome: 'committed', enqueued: 0, flush: null }; },
    ...onBranch('main'),
  });
  assert.equal(ok, false);
  assert.match(message, /not linked/);
  assert.equal(ran, false);
});

test('a saved segment is reported against the task id', async () => {
  const { ok, message } = await trackSession(SESSION, {
    ...linked,
    ...onBranch('feature/task-1234-login'),
    ...checkpoint({ outcome: 'committed', enqueued: 1, flush: { flushed: 1 } }),
  });
  assert.equal(ok, true);
  assert.match(message, /analytics saved for task-1234-login \(1 segment\)/);
});

test('a non-task branch is labeled by its branch name', async () => {
  const { message } = await trackSession(SESSION, {
    ...linked,
    ...onBranch('dev'),
    ...checkpoint({ outcome: 'committed', enqueued: 2, flush: { flushed: 2 } }),
  });
  assert.match(message, /analytics saved for dev \(2 segments\)/);
});

test('a directory that is not a repo is tracked, labeled by its folder name', async () => {
  // With the local:<folder> fallback in the engine there is nothing left to refuse: the
  // checkpoint attributes the work, and the branch lookup only decides the label.
  const { ok, message } = await trackSession(SESSION, {
    ...linked,
    currentBranch: () => { throw new Error('fatal: not a git repository'); },
    ...checkpoint({ outcome: 'committed', enqueued: 1, flush: { flushed: 1 } }),
  });
  assert.equal(ok, true);
  assert.match(message, /analytics saved for my-repo/);
  assert.doesNotMatch(message, /not a git repository/);
});

test('nothing new to save says so instead of claiming a save', async () => {
  const { ok, message } = await trackSession(SESSION, {
    ...linked,
    ...onBranch('dev'),
    ...checkpoint({ outcome: 'committed', enqueued: 0, flush: { flushed: 0 } }),
  });
  assert.equal(ok, true);
  assert.match(message, /nothing new to save for dev/);
});

test('an unreachable server is a retry, not a loss', async () => {
  const { ok, message } = await trackSession(SESSION, {
    ...linked,
    ...onBranch('dev'),
    ...checkpoint({ outcome: 'committed', enqueued: 1, flush: { failed: 1 } }),
  });
  assert.equal(ok, false);
  assert.match(message, /retried automatically/);
});

test('a server rejection surfaces the server\'s own reason', async () => {
  const { ok, message } = await trackSession(SESSION, {
    ...linked,
    ...onBranch('dev'),
    ...checkpoint({ outcome: 'committed', enqueued: 1, flush: { rejected: 1, lastError: 'branch not linked' } }),
  });
  assert.equal(ok, false);
  assert.match(message, /branch not linked/);
});

test('the checkpoint is driven without a hook budget, but with the rate-limit drain on', async () => {
  // A user waiting at a terminal would rather see the whole queue drained than a partial flush —
  // and that includes the queued rate-limit rows, which are otherwise only shipped at a turn end.
  let seenArgs = null;
  await trackSession(SESSION, {
    ...linked,
    ...onBranch('dev'),
    runCheckpoint: async (...args) => { seenArgs = args; return { outcome: 'committed', enqueued: 0, flush: null }; },
  });
  assert.deepEqual(seenArgs[0], {
    session_id: 's1',
    transcript_path: 'C:/roll.jsonl',
    cwd: 'C:/work/my-repo',
  });
  assert.deepEqual(seenArgs[2], { drainRateLimits: true }, 'the drain opts in; budgetMs stays unset');
});

// ─── G-3-1: the track path is the one that must be able to NAME the session ──

test('a resolved transcript with a usable id is what gets tracked', () => {
  const target = resolveTrackTarget('C:/work/my-repo', {
    resolveTranscriptByCwdImpl: () => ({ sessionId: 's1', transcriptPath: 'C:/roll.jsonl' }),
  });
  assert.deepEqual(target, { ok: true, sessionId: 's1', transcriptPath: 'C:/roll.jsonl' });
});

test('no transcript at all is refused with the find message', () => {
  const target = resolveTrackTarget('C:/work/my-repo', { resolveTranscriptByCwdImpl: () => null });
  assert.equal(target.ok, false);
  assert.match(target.message, /could not find/);
});

// The resolver deliberately returns { sessionId: null, transcriptPath } for a transcript it can
// locate but not name — lib/session-audit.mjs needs that to exclude the live session by path. The
// TRACK caller cannot use it: every durable key it writes is derived from the id, and a null one
// becomes `state/null.json`, shared by every id-less session in this directory.
test('a transcript that cannot be named is refused rather than filed under "null"', () => {
  const target = resolveTrackTarget('C:/work/my-repo', {
    resolveTranscriptByCwdImpl: () => ({ sessionId: null, transcriptPath: 'C:/roll.jsonl' }),
  });
  assert.equal(target.ok, false);
  assert.match(target.message, /could not identify this session/);
  assert.match(target.message, /Nothing was written/);
});

test('an id that is the stringified form of a missing one is refused too', () => {
  for (const sessionId of ['null', 'undefined', 'NaN', '']) {
    const target = resolveTrackTarget('C:/work/my-repo', {
      resolveTranscriptByCwdImpl: () => ({ sessionId, transcriptPath: 'C:/roll.jsonl' }),
    });
    assert.equal(target.ok, false, `${sessionId} must not be treated as a session id`);
  }
});

// Second gate, on the value actually handed to runCheckpoint — which is what turns an id into
// state/<id>.json and a segmentId.
test('trackSession refuses a null id before it can write any state', async () => {
  let ran = false;
  const { ok, message } = await trackSession({ ...SESSION, sessionId: null }, {
    ...linked,
    ...onBranch('dev'),
    runCheckpoint: async () => { ran = true; return { outcome: 'committed', enqueued: 1, flush: { flushed: 1 } }; },
  });
  assert.equal(ok, false);
  assert.match(message, /could not identify this session/);
  assert.equal(ran, false, 'no checkpoint, so no state file and no queued segment');
});
