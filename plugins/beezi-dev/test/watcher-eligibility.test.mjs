import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runWatchPass, loadObservations, saveObservations, observationFor } from '../lib/rollout-watcher.mjs';
import { makeMachine as sandboxMachine, uuid } from '../tools/suite-fixtures.mjs';
import { accountSession, linkAccount, TEST_KEY } from '../tools/account-fixtures.mjs';
import { runAudit } from '../lib/session-audit.mjs';
import { BackfillSessionStatus } from '../lib/audit-flush.mjs';
import { OfferState } from '../lib/history-offer.mjs';
import { runCheckpoint } from '../lib/checkpoint.mjs';
import { queueDir } from '../lib/paths.mjs';
import { ENDPOINTS } from '../lib/config.mjs';
import { writeTrackingState } from '../lib/tracking.mjs';

// The pass resolves every linked account and hands the whole list to runCheckpoint, which fans the
// one delta out into each of their queues. `linkedSessions` is therefore the seam that says
// whether this machine is linked at all.
const SESSION = accountSession(TEST_KEY, 'token');


// R2's eligibility matrix, driven through the watcher rather than through the coverage core.
//
// The sketch this replaces was `if (!seen && isImported(ledger, id)) continue`. Three facts make
// it unsafe and all three are exercised below: the ledger records no imported LINE boundary, it
// marks REJECTED sessions imported, and per-session cursors are pruned at 14 days so "no cursor"
// means "old", not "never delivered".
//
// The one rule that outranks everything here: UNAVAILABLE IS NOT ZERO. A coverage request that
// could not be answered defers every session it covered. It never becomes a scan from line 0 —
// that is how one network blip turns into every linked machine re-uploading its whole history.

const makeMachine = (t) => sandboxMachine(t, 'watcher-elig-');

const NOW = 2_000_000_000;

// `mtimeMs` decides which of the two unestablished paths a session takes: inside the active
// window it is live capture (coverage decides the boundary), outside it, it is history (the
// tracking-policy-aware sync route).
function writeRollout(machine, id, { mtimeMs = NOW - 1000, subagentOf = null } = {}) {
  const dir = path.join(machine.sessionsDir, '2026', '09', '10');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-09-10T00-00-00-${id}.jsonl`);
  const meta = subagentOf
    ? { type: 'session_meta', payload: { id, session_id: subagentOf, thread_source: 'subagent' } }
    : { type: 'session_meta', payload: { id, cwd: '/repo' } };
  fs.writeFileSync(file, `${JSON.stringify(meta)}\n`);
  const seconds = mtimeMs / 1000;
  fs.utimesSync(file, seconds, seconds);
  return file;
}

function writeCursor(machine, id, cursor) {
  fs.mkdirSync(path.join(machine.home, 'state'), { recursive: true });
  fs.writeFileSync(path.join(machine.home, 'state', `${id}.json`), JSON.stringify({ cursor, sessionId: id }));
}

function passDeps(overrides) {
  const calls = { checkpoints: [], audits: [], coverageAsks: [] };
  const deps = {
    now: () => NOW,
    linkedSessions: async () => [SESSION],
    runCheckpoint: async (input, _d, options) => {
      calls.checkpoints.push({ id: input.session_id, options });
      return { outcome: 'committed', enqueued: 1, skipped: {} };
    },
    runAudit: async (_d, options) => { calls.audits.push(options); return { ok: true, reason: null }; },
    pruneStale: () => {},
    fetchCoverage: async (ids) => { calls.coverageAsks.push(ids); return new Map(); },
    loadCoverageCheckpoints: () => ({ version: 1, sessions: {} }),
    loadLedger: () => ({ sessions: {}, unreadable: {} }),
    // Linked at the epoch, so every rollout here is written after link (Path B's live cutoff).
    readTrackingState: () => ({ linkedAt: '1970-01-01T00:00:00.000Z' }),
    isLiveTrackingAllowed: () => true,
    yieldControl: async () => {},
    ...overrides,
  };
  return { deps, calls };
}

const opts = (machine, extra) => ({ sessionsDir: machine.sessionsDir, cooldownMs: 0, ...extra });

// ── unavailable is not zero ─────────────────────────────────────────────────────────────────

test('1. coverage unavailable defers every session — it never becomes a scan from zero', async (t) => {
  const m = makeMachine(t);
  const id = uuid(1);
  writeRollout(m, id);

  const { deps, calls } = passDeps({ fetchCoverage: async () => null });
  const out = await runWatchPass(deps, opts(m));

  assert.equal(calls.checkpoints.length, 0, 'nothing may be checkpointed on an unanswerable coverage query');
  assert.equal(out.deferredUnavailable, 1);
  assert.equal(out.deferredGap, 0, 'unavailable is its own reason, not a gap');
  assert.equal(observationFor(loadObservations({}), id), null, 'and nothing is marked as seen');
});

test('2. a coverage request that THROWS is unavailable too, not an empty answer', async (t) => {
  const m = makeMachine(t);
  writeRollout(m, uuid(2));
  const { deps, calls } = passDeps({
    fetchCoverage: async () => { throw new Error('ECONNRESET'); },
  });
  const out = await runWatchPass(deps, opts(m));
  assert.equal(calls.checkpoints.length, 0);
  assert.equal(out.deferredUnavailable, 1);
  assert.equal(out.errors, 0, 'an offline machine is a state, not an error');
});

// ── confirmed zero, and the partial prefix ──────────────────────────────────────────────────

test('3. a confirmed zero replays from line 0 with the subagent sweep ON', async (t) => {
  const m = makeMachine(t);
  const id = uuid(3);
  writeRollout(m, id);
  // The server answered and holds nothing: an id asked about and absent from the Map is a
  // CONFIRMED zero, which is a different fact from "we could not ask".
  const { deps, calls } = passDeps({ fetchCoverage: async () => new Map() });
  await runWatchPass(deps, opts(m));

  assert.equal(calls.checkpoints.length, 1);
  assert.equal(calls.checkpoints[0].options.startCursor, 0);
  assert.equal(
    calls.checkpoints[0].options.sweepSubagents,
    false,
    'a whole-session replay from 0 is the one case where children may be replayed',
  );
});

test('4. a stored contiguous prefix becomes a startCursor HARD OVERRIDE, with children deferred', async (t) => {
  const m = makeMachine(t);
  const id = uuid(4);
  writeRollout(m, id);
  const { deps, calls } = passDeps({ fetchCoverage: async () => new Map([[id, 240]]) });
  await runWatchPass(deps, opts(m));

  assert.equal(calls.checkpoints.length, 1);
  // Without this, coverage is inert for a partial-prefix session: the local cursor is absent, the
  // checkpoint would start at 0, and lines 1-240 would be re-sent under different segment ids.
  assert.equal(calls.checkpoints[0].options.startCursor, 240);
  assert.equal(
    calls.checkpoints[0].options.sweepSubagents,
    false,
    'the live recovery path leaves children to their durable cursors — history sync fills them',
  );
});

test('5. our own confirmation running ahead of the server\'s prefix is a GAP, and defers', async (t) => {
  const m = makeMachine(t);
  const id = uuid(5);
  writeRollout(m, id);
  const { deps, calls } = passDeps({
    fetchCoverage: async () => new Map([[id, 10]]),
    // We believe we delivered through line 90; the server's contiguous prefix stops at 10. Some of
    // what we delivered is therefore stored past a gap, and no start line can be proven free.
    loadCoverageCheckpoints: () => ({ version: 1, sessions: { [id]: { line: 90 } } }),
  });
  const out = await runWatchPass(deps, opts(m));
  assert.equal(calls.checkpoints.length, 0);
  assert.equal(out.deferredGap, 1);
  assert.equal(out.deferredUnavailable, 0);
});

// ── the ledger cases R2 names ───────────────────────────────────────────────────────────────

test('6. an IMPORTED session that resumes and grows is still processed', async (t) => {
  const m = makeMachine(t);
  const id = uuid(6);
  writeRollout(m, id);
  writeCursor(m, id, 12); // hooks ran, so the boundary is established locally

  const { deps, calls } = passDeps({
    // The ledger says this session was imported. The unsafe sketch would `continue` here forever.
    loadLedger: () => ({ sessions: { [id]: { at: 'x', outcome: 'accepted', reports: 4 } }, unreadable: {} }),
    fetchCoverage: async () => { throw new Error('coverage must not be needed for an established session'); },
  });
  await runWatchPass(deps, opts(m));

  assert.equal(calls.checkpoints.length, 1, 'ledger membership never excludes a session');
  assert.equal(calls.checkpoints[0].id, id);
  assert.equal(
    calls.checkpoints[0].options.startCursor,
    undefined,
    'an established session uses its own cursor, not a coverage override',
  );
});

test('7. a REJECTED ledger entry is not delivery — a repo that is later connected replays in full', async (t) => {
  const m = makeMachine(t);
  const id = uuid(7);
  writeRollout(m, id); // no cursor: the reports were rejected, nothing was ever stored

  const { deps, calls } = passDeps({
    loadLedger: () => ({ sessions: { [id]: { at: 'x', outcome: 'rejected', reports: 0 } }, unreadable: {} }),
    fetchCoverage: async () => new Map(),
  });
  await runWatchPass(deps, opts(m));

  assert.equal(calls.checkpoints.length, 1, 'a rejected session is eligible the moment its repo is connected');
  assert.equal(calls.checkpoints[0].options.startCursor, 0);
});

test('8. an ACCEPTED ledger entry with a confirmed zero prefix DEFERS rather than replaying', async (t) => {
  const m = makeMachine(t);
  const id = uuid(8);
  writeRollout(m, id);

  const { deps, calls } = passDeps({
    // Delivered before, and the server's contiguous prefix from line 1 is empty — which is exactly
    // what a session whose stored rows all sit past a gap answers. Replaying from 0 would
    // double-count it under new segment ids.
    loadLedger: () => ({ sessions: { [id]: { at: 'x', outcome: 'accepted', reports: 9 } }, unreadable: {} }),
    fetchCoverage: async () => new Map(),
  });
  const out = await runWatchPass(deps, opts(m));
  assert.equal(calls.checkpoints.length, 0);
  assert.equal(out.deferredGap, 1);
});

// ── pruned cursor ───────────────────────────────────────────────────────────────────────────

test('9. a pruned cursor routes to coverage, never to a scan from zero', async (t) => {
  const m = makeMachine(t);
  const id = uuid(9);
  writeRollout(m, id);
  // pruneStale took state/<id>.json at 14 days. "No cursor" means old, not never-delivered.
  assert.equal(fs.existsSync(path.join(m.home, 'state', `${id}.json`)), false, 'precondition');

  const { deps, calls } = passDeps({ fetchCoverage: async () => new Map([[id, 512]]) });
  await runWatchPass(deps, opts(m));
  assert.equal(calls.checkpoints[0].options.startCursor, 512, 'the server, not the missing cursor, sets the line');
});

// ── the two unestablished paths do not overlap ──────────────────────────────────────────────

test('10. an unestablished QUIET session goes down the sync route, not a direct checkpoint', async (t) => {
  const m = makeMachine(t);
  const id = uuid(10);
  // Older than lib/session-audit.mjs's active window: this is history, and R2 requires history to
  // ride the tracking-policy-aware sync route so it cannot bypass an audit-only tenant or touch
  // the one-time backfill's seal.
  writeRollout(m, id, { mtimeMs: NOW - (2 * 60 * 60 * 1000) });

  const { deps, calls } = passDeps({
    fetchCoverage: async () => { throw new Error('the quiet path must not ask coverage itself'); },
  });
  const out = await runWatchPass(deps, opts(m));

  assert.equal(calls.checkpoints.length, 0, 'no direct replay of history');
  // One repair pass PER ACCOUNT, each naming the account it uploads to: the audit uploads to the
  // account it was given, so a second linked workspace would never have its history repaired.
  assert.deepEqual(calls.audits, [{ scope: 'live', liveOnly: true, key: SESSION.key }], 'exactly one audit, for the one linked account');
  assert.equal(out.history.length, 1, 'one audit result per linked account is surfaced');
});

test('11. an unestablished ACTIVE session is the one the sync route refuses, so coverage handles it', async (t) => {
  const m = makeMachine(t);
  const id = uuid(11);
  writeRollout(m, id, { mtimeMs: NOW - 1000 }); // well inside the 30-minute active window

  const { deps, calls } = passDeps({ fetchCoverage: async () => new Map() });
  await runWatchPass(deps, opts(m));
  assert.equal(calls.audits.length, 0, 'a live session is not history');
  assert.equal(calls.checkpoints.length, 1);
});

test('12. the sync route runs on its own long interval, not every tick', async (t) => {
  const m = makeMachine(t);
  writeRollout(m, uuid(12), { mtimeMs: NOW - (2 * 60 * 60 * 1000) });

  const first = passDeps({});
  await runWatchPass(first.deps, opts(m));
  assert.equal(first.calls.audits.length, 1);

  const second = passDeps({ now: () => NOW + 1000 });
  await runWatchPass(second.deps, opts(m));
  assert.equal(second.calls.audits.length, 0, 'a second tick a second later must not re-run it');

  const later = passDeps({ now: () => NOW + 7 * 60 * 60 * 1000 });
  await runWatchPass(later.deps, opts(m));
  assert.equal(later.calls.audits.length, 1, 'but the interval does come round');
});

// ── tenant policy ───────────────────────────────────────────────────────────────────────────

test('13. an audit-only tenant gets no live capture from the watcher', async (t) => {
  const m = makeMachine(t);
  const live = uuid(13);
  const old = uuid(14);
  writeRollout(m, live, { mtimeMs: NOW - 1000 });
  writeCursor(m, live, 5);
  writeRollout(m, old, { mtimeMs: NOW - (2 * 60 * 60 * 1000) });

  const { deps, calls } = passDeps({
    readTrackingState: () => ({ version: 1, trackingMode: 'backfill_only' }),
    isLiveTrackingAllowed: () => false,
  });
  await runWatchPass(deps, opts(m));

  assert.equal(calls.checkpoints.length, 0, 'no live checkpoint on a dark tenant');
  // The history route still runs, asking liveOnly so runAudit refuses an audit-only tenant itself (it alone knows the server's verdict).
  assert.deepEqual(calls.audits, [{ scope: 'live', liveOnly: true, key: SESSION.key }]);
});

test('14. a missing tracking cache fails OPEN, matching lib/tracking.mjs\'s documented posture', async (t) => {
  const m = makeMachine(t);
  const id = uuid(15);
  writeRollout(m, id);
  writeCursor(m, id, 1);
  const { deps, calls } = passDeps({
    readTrackingState: () => { throw new Error('unreadable'); },
  });
  await runWatchPass(deps, opts(m));
  assert.equal(calls.checkpoints.length, 1, 'a fresh install is not dark-moded by its own empty cache');
});

// ── bounds on the eligibility work itself ───────────────────────────────────────────────────

test('15. one coverage request per SESSION, bounded by the establish cap, and the remainder waits', async (t) => {
  const m = makeMachine(t);
  for (let i = 20; i < 30; i += 1) writeRollout(m, uuid(i));

  const { deps, calls } = passDeps({ fetchCoverage: async (ids) => { calls.coverageAsks.push(ids); return null; } });
  await runWatchPass(deps, opts(m, { maxEstablish: 2 }));

  assert.equal(calls.coverageAsks.length, 2, 'eligibility is serialized per session and capped by maxEstablish');
  assert.equal(calls.coverageAsks[0].length, 1, 'one session lock protects each coverage request');
});

test('16. establishment is capped per pass, so a fresh machine does not checkpoint everything at once', async (t) => {
  const m = makeMachine(t);
  const ids = [];
  for (let i = 40; i < 50; i += 1) { ids.push(uuid(i)); writeRollout(m, uuid(i)); }

  const { deps, calls } = passDeps({ fetchCoverage: async () => new Map() });
  // Path B has its own ceiling, counted separately from path A's: a first read of a session is a
  // whole-transcript parse, so it is the more expensive of the two and gets the smaller number.
  const out = await runWatchPass(deps, opts(m, { maxEstablish: 2 }));
  assert.equal(out.established, 2);
  assert.equal(calls.checkpoints.length, 2, 'the rest stay unestablished and are picked up next pass');
});

test('18. the two paths have separate ceilings, and the pass total is their sum', async (t) => {
  const m = makeMachine(t);
  // Three established (path A) and three not (path B), all active.
  for (let i = 70; i < 73; i += 1) { writeRollout(m, uuid(i)); writeCursor(m, uuid(i), 4); }
  for (let i = 80; i < 83; i += 1) writeRollout(m, uuid(i));

  const { deps, calls } = passDeps({ fetchCoverage: async () => new Map() });
  const out = await runWatchPass(deps, opts(m, { maxSessions: 2, maxEstablish: 1 }));

  assert.equal(out.established, 1, 'path B is bounded on its own');
  assert.equal(calls.checkpoints.length, 3, 'and the pass total is maxSessions + maxEstablish');
  const withStartCursor = calls.checkpoints.filter((c) => c.options.startCursor !== undefined);
  assert.equal(withStartCursor.length, 1, 'only the coverage path passes a startCursor override');
});

test('17. a checkpoint that throws is contained — the pass reports it and keeps going', async (t) => {
  const m = makeMachine(t);
  const bad = uuid(60);
  const good = uuid(61);
  writeRollout(m, bad, { mtimeMs: NOW - 2000 });
  writeRollout(m, good, { mtimeMs: NOW - 1000 });
  writeCursor(m, bad, 1);
  writeCursor(m, good, 1);

  const { deps, calls } = passDeps({
    runCheckpoint: async (input) => {
      calls.checkpoints.push({ id: input.session_id, options: {} });
      if (input.session_id === bad) throw new Error('boom');
      return { outcome: 'committed', enqueued: 1, skipped: {} };
    },
  });
  const out = await runWatchPass(deps, opts(m));
  assert.equal(calls.checkpoints.length, 2, 'one session failing does not abandon the pass');
  assert.equal(out.errors, 1);
  assert.equal(out.succeeded, 1);
  assert.equal(observationFor(loadObservations({}), bad), null, 'and the failure is retried next pass');
});

// ── the quiet pass sends only what live tracking would ──────────────────────────────────────

const LINKED_AT = NOW - 5 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

// The real runAudit behind the watcher's seam, with every network and disk reader it uses stubbed.
function auditBench(rollouts) {
  const posted = [];
  const handle = { verify: () => ({ ok: true }), renew: () => ({ ok: true }), release: () => ({ ok: true }) };
  const deps = {
    now: () => NOW,
    acquireLockImpl: () => ({ ok: true, handle }),
    linkedSessions: async () => [SESSION],
    getDefaultKey: async () => SESSION.key,
    whoamiImpl: async () => ({ valid: true, trackingMode: 'live', backfillCompleted: false }),
    recordWhoamiImpl: () => {},
    readTrackingStateImpl: () => ({ trackingMode: 'live', backfillCompleted: false, linkedAt: new Date(LINKED_AT).toISOString() }),
    listRollouts: () => rollouts,
    resolveTranscriptByCwdImpl: () => null,
    readStateImpl: () => null,
    readChatgptAuthImpl: () => null,
    readBillingConfigImpl: () => null,
    flushQueueImpl: async () => ({ flushed: 0, failed: 0, deferred: 0, unreadable: 0, trackingDisabled: false, lastError: null }),
    fetchCoverageImpl: async () => new Map(),
    loadCoverageCheckpointsImpl: () => ({ version: 1, sessions: {} }),
    saveCoverageCheckpointsImpl: () => true,
    loadLedgerImpl: () => ({ version: 1, identity: null, sessions: {}, unreadable: {}, complete: false, updatedAt: null }),
    saveLedgerImpl: () => {},
    rolloutStartedAtImpl: () => null,
    computeSessionTimelineImpl: () => null,
    postSessionErrorImpl: async () => ({ reported: true }),
    runCheckpointImpl: async (input, _d, options) => {
      options.sink({ segmentId: `${input.session_id}:0-1`, sessionId: input.session_id, remote: 'r', branch: 'main' });
      return { outcome: 'committed', enqueued: 1, flush: null, sessionErrors: [], agents: {}, skipped: { noRemote: 0, emitFailed: 0, deltaFailed: false } };
    },
    flushBackfillChunksImpl: async (groups) => {
      for (const g of groups) posted.push(g.sessionId);
      const bySession = new Map(groups.map((g) => [g.sessionId, { status: BackfillSessionStatus.ACCEPTED, reason: null }]));
      return { chunks: 1, stored: groups.length, skipped: 0, timelines: 0, timelinesDropped: 0, itemErrors: 0, unattributed: 0, permanentRejections: 0, bySession, halt: null, lastError: null };
    },
  };
  return { deps, posted };
}

function quietPair(m) {
  const before = uuid(90);
  const after = uuid(91);
  const rollouts = [[before, LINKED_AT - HOUR], [after, LINKED_AT + HOUR]].map(([id, mtimeMs]) => ({
    sessionId: id, transcriptPath: writeRollout(m, id, { mtimeMs }), cwd: '/repo', mtimeMs, size: 64,
  }));
  return { before, after, rollouts };
}

test('19. a beezi_login-linked machine with idle pre-link history: a tick posts only the post-link session', async (t) => {
  const m = makeMachine(t);
  linkAccount(m.home, TEST_KEY, { linkedAt: new Date(LINKED_AT).toISOString() });
  const { after, rollouts } = quietPair(m);
  const bench = auditBench(rollouts);
  const { deps, calls } = passDeps({
    runAudit: async (_d, options) => { calls.audits.push(options); return runAudit(bench.deps, options); },
  });

  await runWatchPass(deps, opts(m));

  assert.deepEqual(bench.posted, [after]);
});

test('20. "Not now" never gates live: a declined post-link session is still posted', async (t) => {
  const m = makeMachine(t);
  const { after, rollouts } = quietPair(m);
  linkAccount(m.home, TEST_KEY, {
    linkedAt: new Date(LINKED_AT).toISOString(),
    historyOffers: { [`t-${TEST_KEY}`]: { state: OfferState.DECLINED, changedAt: null, offeredIds: [after], declinedIds: [after] } },
  });
  const bench = auditBench(rollouts);
  const { deps, calls } = passDeps({
    runAudit: async (_d, options) => { calls.audits.push(options); return runAudit(bench.deps, options); },
  });

  await runWatchPass(deps, opts(m));

  assert.deepEqual(bench.posted, [after]);
  assert.equal(calls.audits.length, 1);
  assert.equal('declinedSessionIds' in calls.audits[0], false);
});

// ── Path B applies the live cutoff: last write at or after each workspace's link or join ─────

const MINUTE = 60 * 1000;
const linkedAtState = (ms) => () => ({ linkedAt: new Date(ms).toISOString() });

test('21. a session last written 10 minutes before link, then "Not now": the next pass sends nothing of it', async (t) => {
  const m = makeMachine(t);
  const id = uuid(92);
  const link = NOW - 5 * MINUTE;
  writeRollout(m, id, { mtimeMs: link - 10 * MINUTE });
  linkAccount(m.home, TEST_KEY, {
    linkedAt: new Date(link).toISOString(),
    historyOffers: { [`t-${TEST_KEY}`]: { state: OfferState.DECLINED, changedAt: null, offeredIds: [id], declinedIds: [id] } },
  });
  const { deps, calls } = passDeps({ readTrackingState: linkedAtState(link) });

  const out = await runWatchPass(deps, opts(m));

  assert.equal(calls.checkpoints.length, 0, 'a pre-link session is past, not live');
  assert.equal(calls.coverageAsks.length, 0);
  assert.equal(calls.audits.length, 0);
  assert.equal(out.established, 0);
});

test('22. a session written after link is still established and sent', async (t) => {
  const m = makeMachine(t);
  const id = uuid(93);
  const link = NOW - 5 * MINUTE;
  writeRollout(m, id, { mtimeMs: link + 2 * MINUTE });
  const { deps, calls } = passDeps({ readTrackingState: linkedAtState(link) });

  const out = await runWatchPass(deps, opts(m));

  assert.deepEqual(calls.checkpoints.map((c) => c.id), [id]);
  assert.equal(calls.checkpoints[0].options.startCursor, 0);
  assert.equal(out.established, 1);
});

test('23. an unknown link time is past: nothing is established', async (t) => {
  const m = makeMachine(t);
  writeRollout(m, uuid(94), { mtimeMs: NOW - MINUTE });
  const { deps, calls } = passDeps({ readTrackingState: () => null });

  await runWatchPass(deps, opts(m));

  assert.equal(calls.checkpoints.length, 0);
});

test('24. on an account in several workspaces, a later join is that workspace\'s cutoff', async (t) => {
  const m = makeMachine(t);
  const link = NOW - 60 * MINUTE;
  const joined = NOW - 5 * MINUTE;
  const multi = { ...SESSION, tenants: [{ id: 'A' }, { id: 'B', joinedAt: new Date(joined).toISOString() }] };
  const before = uuid(95);
  const after = uuid(96);
  writeRollout(m, before, { mtimeMs: joined - 2 * MINUTE });
  writeRollout(m, after, { mtimeMs: joined + MINUTE });
  const { deps, calls } = passDeps({
    linkedSessions: async () => [multi],
    readTrackingState: linkedAtState(link),
    flushQueue: async () => ({ flushed: 0, failed: 0 }),
  });

  await runWatchPass(deps, opts(m));

  // Only the post-join session reaches the coverage step; the pre-join one is past for B and never asked about.
  assert.deepEqual(Array.from(new Set(calls.coverageAsks.flat())), [after]);
  assert.equal(calls.checkpoints.some((c) => c.id === before), false);
});

// ── Path A cuts each workspace at its own link time ─────────────────────────────────────────

test('25. Path A passes the session\'s last write as writtenAtMs; Path B does not', async (t) => {
  const m = makeMachine(t);
  const established = uuid(97);
  const fresh = uuid(98);
  writeRollout(m, established, { mtimeMs: NOW - 2000 });
  writeCursor(m, established, 4);
  writeRollout(m, fresh, { mtimeMs: NOW - 1000 });
  const { deps, calls } = passDeps({});

  await runWatchPass(deps, opts(m));

  const byId = new Map(calls.checkpoints.map((c) => [c.id, c.options]));
  assert.equal(byId.get(established).writtenAtMs, NOW - 2000);
  assert.equal('writtenAtMs' in byId.get(fresh), false);
});

const KEY_B = 'b2c3d4e5';
const LINK_A = NOW - 60 * MINUTE;
const LINK_B = NOW - 50 * MINUTE;

// The real runCheckpoint behind the watcher's seam, for accounts A and B; reports stay queued and only timeline posts answer.
function twoAccountBench(m) {
  const bearers = [];
  const drained = [];
  const timeline = path.join(m.home, 'timeline.jsonl');
  const record = (minute, type) => ({ timestamp: `2026-01-01T00:0${minute}:00.000Z`, type: 'event_msg', payload: { type, message: 'go' } });
  fs.writeFileSync(timeline, [record(0, 'user_message'), record(1, 'agent_message'), record(2, 'agent_message')]
    .map((r) => JSON.stringify(r)).join('\n') + '\n');
  const accounts = async () => [accountSession(TEST_KEY, 'tok-a'), accountSession(KEY_B, 'tok-b')];
  const seams = {
    linkedSessions: accounts,
    resolveTranscript: (input) => ({ transcriptPath: timeline, sessionId: input.session_id }),
    computeDelta: () => ({ nextCursor: 4, segments: [{
      repoRoot: '/repo', branch: 'main', fromLine: 1, toLine: 4,
      stats: {
        models: { 'gpt-5.2-codex': { token_input: 10, token_output: 5, token_cache_read: 0, token_cache_creation: 0, requests: 1 } },
        token_total: 15, token_input: 10, token_output: 5, token_cache: 0, duration_sec: 12,
        code_changes: { files_changed: 0, lines_added: 0, lines_removed: 0, by_extension: {} },
        operations: {}, started_at: '2026-01-01T00:00:00.000Z', ended_at: '2026-01-01T00:00:12.000Z',
      },
    }], apiErrorEvents: [] }),
    gitImpl: () => 'https://host/org/repo.git',
    fetchImpl: async (url, init) => {
      if (!String(url).endsWith(ENDPOINTS.sessionsTimeline)) throw new Error('offline');
      bearers.push(init.headers.Authorization);
      return { ok: true, status: 200, json: async () => ({}) };
    },
    drainRateLimitSnapshots: async (key) => { drained.push(key); return { posted: 0 }; },
  };
  const { deps } = passDeps({
    linkedSessions: accounts,
    runCheckpoint: (input, d, options) => runCheckpoint(input, { ...d, ...seams }, options),
  });
  return { deps, bearers, drained };
}

const queued = (key) => {
  try { return fs.readdirSync(queueDir(key)); } catch { return []; }
};

function linkTwoAccounts(m, id, mtimeMs) {
  writeTrackingState(TEST_KEY, { linkedAt: new Date(LINK_A).toISOString() });
  writeTrackingState(KEY_B, { linkedAt: new Date(LINK_B).toISOString() });
  writeRollout(m, id, { mtimeMs });
  writeCursor(m, id, 0);
}

test('26. an established session last written between two links is sent to the earlier account only', async (t) => {
  const m = makeMachine(t);
  const id = uuid(99);
  linkTwoAccounts(m, id, LINK_A + 5 * MINUTE);
  const bench = twoAccountBench(m);

  const out = await runWatchPass(bench.deps, opts(m));

  assert.equal(out.succeeded, 1);
  assert.ok(queued(TEST_KEY).length > 0, 'A gets the segments');
  assert.deepEqual(queued(KEY_B), [], 'B, linked after the last write, gets no file');
  assert.deepEqual(bench.bearers, ['Bearer tok-a'], 'the timeline reaches A only');
  assert.deepEqual(bench.drained, [TEST_KEY]);
});

test('27. once the session is written again after the later link, the next pass sends to both', async (t) => {
  const m = makeMachine(t);
  const id = uuid(100);
  linkTwoAccounts(m, id, LINK_A + 5 * MINUTE);
  await runWatchPass(twoAccountBench(m).deps, opts(m));

  writeRollout(m, id, { mtimeMs: LINK_A + 20 * MINUTE });
  const bench = twoAccountBench(m);
  await runWatchPass(bench.deps, opts(m));

  assert.ok(queued(KEY_B).length > 0, 'the resumed session is live for B');
  assert.deepEqual(bench.bearers.slice().sort(), ['Bearer tok-a', 'Bearer tok-b']);
});

test('28. an established session last written before every link is observed without a checkpoint, freeing its slot', async (t) => {
  const m = makeMachine(t);
  const old = uuid(101);
  const recent = uuid(102);
  writeRollout(m, old, { mtimeMs: NOW - 20 * MINUTE });
  writeCursor(m, old, 4);
  writeRollout(m, recent, { mtimeMs: NOW - MINUTE });
  writeCursor(m, recent, 4);
  // recent has an earlier observation, so oldest-observation-first puts old in the first pass's one slot.
  const seeded = loadObservations({});
  seeded.sessions[recent] = { mtimeMs: NOW - 5 * MINUTE, size: 0, at: NOW - 5 * MINUTE };
  saveObservations(seeded);
  const { deps, calls } = passDeps({ readTrackingState: linkedAtState(NOW - 10 * MINUTE) });

  await runWatchPass(deps, opts(m, { maxSessions: 1 }));
  assert.deepEqual(calls.checkpoints, []);
  assert.equal(observationFor(loadObservations({}), old).mtimeMs, NOW - 20 * MINUTE);

  await runWatchPass(deps, opts(m, { maxSessions: 1 }));
  assert.deepEqual(calls.checkpoints.map((c) => c.id), [recent]);
});

test('M5: a LINKED account with no usable token right now still holds the settle line at its earlier link', async (t) => {
  const m = makeMachine(t);
  const id = uuid(105);
  const TOKENLESS = 'c3d4e5f6';
  const links = { [TEST_KEY]: NOW - 10 * MINUTE, [TOKENLESS]: NOW - 60 * MINUTE };
  linkAccount(m.home, TEST_KEY);
  linkAccount(m.home, TOKENLESS);
  writeRollout(m, id, { mtimeMs: NOW - 30 * MINUTE });
  writeCursor(m, id, 4);
  const { deps, calls } = passDeps({ readTrackingState: (key) => ({ linkedAt: new Date(links[key]).toISOString() }) });

  await runWatchPass(deps, opts(m));

  assert.deepEqual(calls.checkpoints.map((c) => [c.id, c.options.writtenAtMs]), [[id, NOW - 30 * MINUTE]]);
});

test('29. a child-scheduled root with no stat of its own is cut at its newest moved child\'s write', async (t) => {
  const m = makeMachine(t);
  const root = uuid(103);
  const child = uuid(104);
  writeRollout(m, child, { mtimeMs: NOW - 3000, subagentOf: root });
  writeCursor(m, root, 4);
  const { deps, calls } = passDeps({});

  await runWatchPass(deps, opts(m));

  assert.deepEqual(calls.checkpoints.map((c) => [c.id, c.options.writtenAtMs]), [[root, NOW - 3000]]);
});
