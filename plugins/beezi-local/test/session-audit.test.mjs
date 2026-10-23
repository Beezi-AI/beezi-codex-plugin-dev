import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAudit, createRunCache, HistoryScope } from '../lib/session-audit.mjs';
import { workspaceLinkMs } from '../lib/tracking.mjs';
import { BackfillSessionStatus, BackfillHalt } from '../lib/audit-flush.mjs';
import { accountSession, TEST_KEY } from '../tools/account-fixtures.mjs';
import { anonAccount } from '../lib/anonymize.mjs';
import { kindsOf, sessionAnonymization } from '../lib/anonymization.mjs';

// The audit uploads ONE account's history per run — `options.key` names it, defaulting to the
// default account — so every seam below is that account's: its session, its ledger, its coverage
// record, its tracking cache.
const KEY = TEST_KEY;
const SESSION = accountSession(KEY, 'tok');

// ─── helpers ────────────────────────────────────────────────────────────────

const rollout = (sessionId, mtimeMs = 1_000) => ({
  sessionId,
  transcriptPath: `C:/sessions/2026/01/01/rollout-2026-01-01T00-00-00-${sessionId}.jsonl`,
  cwd: 'C:/work/app',
  mtimeMs,
  size: 1024,
});

const report = (sessionId) => ({ segmentId: `${sessionId}:0-1`, sessionId, remote: 'r', branch: 'main' });

const flushResult = (over = {}) => ({
  chunks: 1,
  stored: 0,
  skipped: 0,
  timelines: 0,
  timelinesDropped: 0,
  itemErrors: 0,
  retryableFailures: 0,
  permanentRejections: 0,
  unattributed: 0,
  bySession: new Map(),
  halt: null,
  lastError: null,
  ...over,
});

// Sibling of flushResult for the other shape the audit consumes: a test states only the skip
// reason it is about, and a new field costs one edit here instead of one per test.
const checkpointResult = (skipped = {}) => ({
  outcome: 'committed',
  enqueued: 0,
  flush: null,
  sessionErrors: [],
  agents: {},
  skipped: { noRemote: 0, emitFailed: 0, deltaFailed: false, ...skipped },
});

// A flush double that accepts everything it is handed and records the call.
function fakeFlush(statusFor = () => BackfillSessionStatus.ACCEPTED) {
  const calls = [];
  const impl = async (groups, _key, _session, _deps, options) => {
    calls.push({ groups, options });
    const bySession = new Map();
    let stored = 0;
    let retryableFailures = 0;
    for (const g of groups) {
      const status = statusFor(g.sessionId);
      bySession.set(g.sessionId, { status, reason: null });
      if (status === BackfillSessionStatus.ACCEPTED || status === BackfillSessionStatus.PARTIAL) {
        stored += g.reports.length;
      }
      if (status === BackfillSessionStatus.FAILED) retryableFailures += 1;
    }
    return flushResult({ stored, retryableFailures, bySession });
  };
  return { impl, calls };
}

function makeDeps(overrides = {}) {
  const events = [];
  const saved = [];
  const ledger = { version: 1, identity: null, sessions: {}, unreadable: {}, updatedAt: null };
  const deps = {
    now: () => 10 * 60 * 60 * 1000, // fixed clock, far past every fixture mtime + the 30min window
    linkedSessions: async () => [SESSION],
    getDefaultKey: async () => KEY,
    whoamiImpl: async () => ({ valid: true, trackingMode: 'live', backfillCompleted: false }),
    recordWhoamiImpl: () => {},
    listRollouts: () => [rollout('s1')],
    // Stubbed: the real ones read this machine's ~/.beezi-codex and ~/.codex trees.
    resolveTranscriptByCwdImpl: () => null,
    readStateImpl: () => null,
    readChatgptAuthImpl: () => null,
    readBillingConfigImpl: () => null,
    postJsonImpl: async () => ({ ok: true, status: 200, json: async () => ({ accountLinked: true }) }),
    readTrackingStateImpl: () => null,
    statImpl: () => { throw new Error('ENOENT'); },
    rolloutStartedAtImpl: () => null,
    // The run drains the queue and asks coverage first: an empty queue, and a server that holds nothing yet.
    flushQueueImpl: async () => ({ flushed: 0, failed: 0, deferred: 0, unreadable: 0, trackingDisabled: false, lastError: null }),
    fetchCoverageImpl: async () => new Map(),
    loadCoverageCheckpointsImpl: () => ({ version: 1, identity: null, environment: '', apiBase: null, sessions: {}, updatedAt: null }),
    saveCoverageCheckpointsImpl: () => true,
    runCheckpointImpl: async (input, _d, options) => {
      options.sink(report(input.session_id));
      return { outcome: 'committed', enqueued: 1, flush: null, sessionErrors: [], agents: {} };
    },
    flushBackfillChunksImpl: async (groups) => {
      events.push('flush');
      const bySession = new Map(
        groups.map((g) => [g.sessionId, { status: BackfillSessionStatus.ACCEPTED, reason: null }]),
      );
      return flushResult({
        stored: groups.length,
        timelines: groups.filter((g) => g.timeline).length,
        bySession,
      });
    },
    loadLedgerImpl: () => ledger,
    saveLedgerImpl: (_key, l) => saved.push(JSON.parse(JSON.stringify(l))),
    computeSessionTimelineImpl: () => ({ periods: [{ state: 'working' }], plan_events: [], subagents: [] }),
    postSessionErrorImpl: async () => { events.push('error'); return { reported: true }; },
    ...overrides,
  };
  return { deps, events, saved, ledger };
}

test('backfill stamps every historical report with one current subscription account snapshot', async () => {
  const flush = fakeFlush();
  let reads = 0;
  const registrations = [];
  const { deps } = makeDeps({
    listRollouts: () => [rollout('s1'), rollout('s2')],
    readChatgptAuthImpl: () => ({
      authMode: 'chatgpt', accountId: `current-${++reads}`, subscriptionType: 'plus', expiresAt: 99_000_000,
    }),
    postJsonImpl: async (url, token, body) => {
      registrations.push({ url, token, body });
      return { ok: true, status: 200, json: async () => ({ status: 'stored', accountLinked: true }) };
    },
    runCheckpointImpl: async (input, _deps, options) => {
      options.sink({ ...report(input.session_id), account_uuid: 'old-account' });
      options.sink({ ...report(input.session_id), segmentId: `${input.session_id}:child:0-1`, is_subagent: true });
      return checkpointResult();
    },
    flushBackfillChunksImpl: flush.impl,
  });
  await runAudit(deps);
  const reports = flush.calls.flatMap((call) => call.groups.flatMap((group) => group.reports));
  assert.equal(reads, 1);
  assert.equal(registrations.length, 1);
  assert.match(registrations[0].url, /\/me\/cli-agent\/account$/);
  assert.deepEqual(registrations[0].body, { accountUuid: 'current-1', subscriptionType: 'plus' });
  assert.equal(Object.hasOwn(registrations[0].body, 'subscriptionPlan'), false);
  assert.equal(reports.length, 4);
  for (const payload of reports) assert.equal(payload.account_uuid, 'current-1');
});

const ANON_KEY = 'ab'.repeat(32);
const ANON_BLOCK = { tenantId: null, kinds: { repos: true, branches: true, sessions: true, hosts: true, accounts: true }, key: ANON_KEY, machineName: null };

test('an anonymized account registers with a hashed email through the check-in body', async () => {
  const registrations = [];
  const { deps } = makeDeps({
    linkedSessions: async () => [{ ...SESSION, anonymization: ANON_BLOCK }],
    readChatgptAuthImpl: () => ({ authMode: 'chatgpt', accountId: 'current', email: 'dev@example.com', expiresAt: 99_000_000 }),
    postJsonImpl: async (_url, _session, body) => {
      registrations.push(body);
      return { ok: true, status: 200, json: async () => ({ accountLinked: true }) };
    },
  });
  await runAudit(deps);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].email, anonAccount(ANON_KEY, 'dev@example.com'));
  assert.equal(registrations[0].accountUuid, 'current');
});

test('an anonymized account without its key stops before registering or uploading anything', async () => {
  const events = [];
  const { deps } = makeDeps({
    linkedSessions: async () => [{ ...SESSION, anonymization: { ...ANON_BLOCK, key: null } }],
    readChatgptAuthImpl: () => ({ authMode: 'chatgpt', accountId: 'current', email: 'dev@example.com', expiresAt: 99_000_000 }),
    postJsonImpl: async () => { events.push('register'); return { ok: true, status: 200, json: async () => ({ accountLinked: true }) }; },
    flushBackfillChunksImpl: async () => { events.push('flush'); return flushResult(); },
  });
  const result = await runAudit(deps);
  assert.equal(result.reason, BackfillHalt.ANONYMIZATION_KEY_MISSING);
  assert.deepEqual(events, []);
});

test('an accepted upload hides at least the kinds hidden when the developer said yes', async () => {
  const OFF = { ...ANON_BLOCK, kinds: { repos: false, branches: false, sessions: false, hosts: false, accounts: false } };
  const registrations = [];
  const flushed = [];
  const { deps } = makeDeps({
    linkedSessions: async () => [{ ...SESSION, anonymization: OFF }],
    readChatgptAuthImpl: () => ({ authMode: 'chatgpt', accountId: 'current', email: 'dev@example.com', expiresAt: 99_000_000 }),
    postJsonImpl: async (_url, _session, body) => {
      registrations.push(body);
      return { ok: true, status: 200, json: async () => ({ accountLinked: true }) };
    },
    flushBackfillChunksImpl: async (groups, _key, session) => {
      flushed.push(kindsOf(sessionAnonymization(session)));
      const bySession = new Map(groups.map((g) => [g.sessionId, { status: BackfillSessionStatus.ACCEPTED, reason: null }]));
      return flushResult({ stored: groups.length, bySession });
    },
  });
  await runAudit(deps, { acceptedKinds: ['accounts', 'repos'] });
  assert.equal(registrations[0].email, anonAccount(ANON_KEY, 'dev@example.com'));
  assert.deepEqual(flushed, [['repos', 'accounts']]);
});

test('account registration failure leaves history untouched and a later run retries it', async () => {
  const events = [];
  let registrationAttempts = 0;
  const make = () => makeDeps({
    readChatgptAuthImpl: () => ({
      authMode: 'chatgpt', accountId: 'current-account', subscriptionType: 'plus', expiresAt: 1,
    }),
    postJsonImpl: async (_url, _session, body) => {
      events.push(['register', body]);
      registrationAttempts += 1;
      if (registrationAttempts === 1) {
        return { ok: true, status: 200, json: async () => ({ status: 'stored', accountLinked: false }) };
      }
      return { ok: true, status: 200, json: async () => ({ accountLinked: true }) };
    },
    runCheckpointImpl: async (input, _deps, options) => {
      events.push(['checkpoint', input.session_id]);
      options.sink(report(input.session_id));
      return checkpointResult();
    },
    flushBackfillChunksImpl: async (groups) => {
      events.push(['flush', groups[0].reports[0].account_uuid]);
      return flushResult({
        stored: 1,
        bySession: new Map([['s1', { status: BackfillSessionStatus.ACCEPTED, reason: null }]]),
      });
    },
  }).deps;

  const failed = await runAudit(make());
  assert.equal(failed.reason, 'account-registration-failed');
  assert.equal(failed.lastError, 'account was not linked');
  assert.deepEqual(events, [['register', { accountUuid: 'current-account' }]]);

  const retried = await runAudit(make());
  assert.equal(retried.sessionsImported, 1);
  assert.deepEqual(events.slice(1).map(([name]) => name), ['register', 'checkpoint', 'flush']);
  assert.equal(events[1][1].subscriptionType, undefined); // expired plan is not registered
  assert.equal(events[3][1], 'current-account');
});

test('account registration renews a rejected credential and uses the fresh token thereafter', async () => {
  const calls = [];
  let tokenReads = 0;
  const { deps } = makeDeps({
    // The first bearer rides in on the session; only the RENEWAL is a token read now.
    linkedSessions: async () => { calls.push(['token', false]); return [accountSession(KEY, 'stale-token')]; },
    getDefaultKey: async () => KEY,
    getAccessToken: async (_key, _deps, options = {}) => {
      tokenReads += 1;
      calls.push(['token', options.forceRefresh === true]);
      return options.forceRefresh ? 'fresh-token' : 'stale-token';
    },
    readChatgptAuthImpl: () => ({ authMode: 'chatgpt', accountId: 'current-account' }),
    postJsonImpl: async (_url, session) => {
      calls.push(['register', session.token]);
      return session.token === 'stale-token'
        ? { ok: false, status: 401, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => ({ accountLinked: true }) };
    },
    flushBackfillChunksImpl: async (groups, _key, session) => {
      calls.push(['flush', session.token]);
      return flushResult({
        stored: 1,
        bySession: new Map([[groups[0].sessionId, {
          status: BackfillSessionStatus.ACCEPTED, reason: null,
        }]]),
      });
    },
  });
  const result = await runAudit(deps);
  assert.equal(result.sessionsImported, 1);
  assert.equal(tokenReads, 1, 'one forced renewal; the first bearer came with the session');
  assert.deepEqual(calls, [
    ['token', false],
    ['register', 'stale-token'],
    ['token', true],
    ['register', 'fresh-token'],
    ['flush', 'fresh-token'],
  ]);
});

test('backfill still uploads when subscription identity is unavailable', async () => {
  for (const read of [() => null, () => { throw new Error('unreadable'); },
    () => ({ authMode: 'chatgpt', accountId: null, email: null })]) {
    const flush = fakeFlush();
    const { deps } = makeDeps({ readChatgptAuthImpl: read, flushBackfillChunksImpl: flush.impl });
    await runAudit(deps);
    assert.equal(flush.calls.length, 1);
    assert.equal(Object.hasOwn(flush.calls[0].groups[0].reports[0], 'account_uuid'), false);
  }
});

// ─── candidate selection ────────────────────────────────────────────────────

test('5. bails without a token and never scans', async () => {
  const { deps } = makeDeps({ linkedSessions: async () => [], listRollouts: () => { throw new Error('scanned'); } });

  const result = await runAudit(deps, {});

  assert.equal(result.reason, 'no-token');
  assert.equal(result.ok, false);
});

// The live session's hooks own its state file concurrently, and it is already tracked. Codex has
// no session-id env var, so the cwd mapping is the only handle on the current session.
test('6. excludes the live session resolved from the current cwd', async () => {
  const { deps } = makeDeps({
    resolveTranscriptByCwdImpl: () => ({ sessionId: 's1', transcriptPath: 'x' }),
    listRollouts: () => [rollout('s1'), rollout('s2')],
  });

  const result = await runAudit(deps, {});

  assert.equal(result.live, 1);
  assert.equal(result.candidates, 1);
});

// resolveTranscriptByCwd can name the transcript but not the session (the id comes off the
// filename and may be null) — the path match must exclude it anyway.
test('7. excludes the live session by transcript path when its id is unknown', async () => {
  const entries = [rollout('s1'), rollout('s2')];
  const { deps } = makeDeps({
    resolveTranscriptByCwdImpl: () => ({ sessionId: null, transcriptPath: entries[1].transcriptPath }),
    listRollouts: () => entries,
  });

  const result = await runAudit(deps, {});

  assert.equal(result.live, 1);
  assert.equal(result.candidates, 1);
});

// A rollout touched inside the recency window is probably an OPEN session in another window —
// backfilling it would re-segment lines its next live checkpoint also reports.
test('10. skips recently-active rollouts', async () => {
  const NOW = 10 * 60 * 60 * 1000;
  const { deps } = makeDeps({
    now: () => NOW,
    listRollouts: () => [rollout('old', 1_000), rollout('open', NOW - 60_000)],
  });

  const result = await runAudit(deps, {});

  assert.equal(result.active, 1);
  assert.equal(result.candidates, 1);
  assert.deepEqual(result.recent.map((r) => r.sessionId), ['open']);
  assert.equal(typeof result.recent[0].path, 'string');
});

// Every candidate that yields no report used to vanish between `candidates` and
// `sessionsImported` with nothing printed — the run said it read 593 and uploaded 576, and the
// missing 17 had no name anywhere. Each cause now has its own counter.
test('11c. a candidate with no usage data counts as empty, not as a loss', async () => {
  const { deps } = makeDeps({
    listRollouts: () => [rollout('has-usage'), rollout('no-usage')],
    runCheckpointImpl: async (input, _d, options) => {
      if (input.session_id === 'has-usage') options.sink(report(input.session_id));
      return checkpointResult();
    },
  });

  const result = await runAudit(deps, {});

  assert.equal(result.candidates, 2);
  assert.equal(result.sessionsImported, 1);
  assert.equal(result.empty, 1);
  assert.equal(result.noRemote, 0);
  assert.equal(result.unreadable, 0);
});

test('11d. a candidate with no resolvable repository is reported separately from empty', async () => {
  const { deps } = makeDeps({
    listRollouts: () => [rollout('no-remote')],
    runCheckpointImpl: async () => checkpointResult({ noRemote: 2 }),
  });

  const result = await runAudit(deps, {});

  assert.equal(result.noRemote, 1);
  assert.equal(result.empty, 0);
});

test('11e. an unreadable transcript is counted', async () => {
  const { deps } = makeDeps({
    listRollouts: () => [rollout('unreadable')],
    runCheckpointImpl: async () => checkpointResult({ deltaFailed: true }),
  });

  const result = await runAudit(deps, {});

  assert.equal(result.unreadable, 1);
  assert.equal(result.empty, 0);
});

test('11f. a throwing checkpoint counts as unreadable', async () => {
  const { deps } = makeDeps({
    listRollouts: () => [rollout('boom')],
    runCheckpointImpl: async () => { throw new Error('ENOENT'); },
  });

  const result = await runAudit(deps, {});

  assert.equal(result.unreadable, 1);
  assert.equal(result.sessionsImported, 0);
});

// A session we failed to prepare must never be reported as "held no usage data" — that sentence
// is the silent-loss-dressed-as-normal outcome this whole change set exists to end.
test('11h. a session whose segments all failed to emit is not reported as empty', async () => {
  const { deps } = makeDeps({
    listRollouts: () => [rollout('emit-boom')],
    runCheckpointImpl: async () => checkpointResult({ emitFailed: 2 }),
  });

  const result = await runAudit(deps, {});

  assert.equal(result.emitFailed, 1);
  assert.equal(result.empty, 0);
});

test('11g. a transcript that fails twice is reported as unreadable on both runs', async () => {
  const ledger = { version: 1, identity: null, sessions: {}, unreadable: {}, updatedAt: null };
  const make = () =>
    makeDeps({
      listRollouts: () => [rollout('always-broken')],
      runCheckpointImpl: async () => { throw new Error('EACCES'); },
      loadLedgerImpl: () => ledger,
      saveLedgerImpl: () => {},
    }).deps;

  const first = await runAudit(make(), {});
  assert.equal(first.unreadable, 1);

  const second = await runAudit(make(), {});
  assert.equal(second.unreadable, 1, 'still reported to the user');
});

// The 30-day window (MAX_SESSION_AGE_MS) counts what it dropped.
test('12b. drops rollouts older than the 30-day window', async () => {
  const NOW = 100 * 24 * 60 * 60 * 1000;
  const { deps } = makeDeps({
    now: () => NOW,
    listRollouts: () => [
      rollout('ancient', NOW - 31 * 24 * 60 * 60 * 1000),
      rollout('recent', NOW - 2 * 24 * 60 * 60 * 1000),
    ],
  });

  const result = await runAudit(deps, {});

  assert.equal(result.tooOld, 1);
  assert.equal(result.candidates, 1);
});

test('13. skips a rollout too large to parse safely', async () => {
  const { deps } = makeDeps({
    listRollouts: () => [{ ...rollout('huge'), size: 128 * 1024 * 1024 }],
  });

  const result = await runAudit(deps, {});

  assert.equal(result.oversize, 1);
  assert.equal(result.candidates, 0);
});

test('14. an unreadable transcript is skipped without ending the run', async () => {
  const flush = fakeFlush();
  const { deps } = makeDeps({
    listRollouts: () => [rollout('bad'), rollout('good')],
    flushBackfillChunksImpl: flush.impl,
    runCheckpointImpl: async (input, _d, options) => {
      if (input.session_id === 'bad') throw new Error('unreadable');
      options.sink(report(input.session_id));
      return { outcome: 'committed', enqueued: 1, flush: null, sessionErrors: [], agents: {} };
    },
  });

  const result = await runAudit(deps, {});

  assert.equal(result.sessionsImported, 1);
  assert.deepEqual(flush.calls[0].groups.map((g) => g.sessionId), ['good']);
});

// ─── identity binding ───────────────────────────────────────────────────────

// A ledger recorded under another login must be ignored — its deliveries are not the new tenant's.
test('15. a foreign-identity ledger is discarded', async () => {
  let askedIdentity = 'unset';
  const { deps, events } = makeDeps({
    loadLedgerImpl: (_key, identity) => {
      askedIdentity = identity;
      // loadLedger's contract: a mismatched identity yields a FRESH ledger.
      return { version: 1, identity, sessions: {}, updatedAt: null };
    },
    listRollouts: () => [rollout('s1')],
  });

  const result = await runAudit(deps, {});

  assert.equal(askedIdentity, SESSION.clientId,
    'the ledger binds to the account\'s OWN client id, carried on its session');
  assert.equal(result.candidates, 1);
  assert.ok(events.includes('flush'));
});

// ─── whoami ─────────────────────────────────────────────────────────────────

// Offline or pre-audit server: the whoami answer is advisory, so the run proceeds without it.
test('15d. an unreachable whoami never blocks the run', async () => {
  const { deps } = makeDeps({ whoamiImpl: async () => { throw new Error('offline'); } });

  const result = await runAudit(deps, {});

  assert.equal(result.ok, true);
  assert.equal(result.sessionsImported, 1);
});

// ─── delivery + follow-ups ──────────────────────────────────────────────────

// Timelines ride IN the chunk payload: the flush sees them attached to their session group.
test('16. attaches the computed timeline to its session group', async () => {
  let seenGroups = null;
  const { deps, events } = makeDeps();
  const base = deps.flushBackfillChunksImpl;
  deps.flushBackfillChunksImpl = async (groups, ...rest) => {
    seenGroups = groups;
    return base(groups, ...rest);
  };

  const result = await runAudit(deps, {});

  assert.deepEqual(events, ['flush']);
  assert.equal(seenGroups.length, 1);
  assert.equal(seenGroups[0].timeline.sessionId, 's1');
  assert.deepEqual(seenGroups[0].timeline.periods, [{ state: 'working' }]);
  assert.equal(result.timelines, 1);
});

test('17. an empty timeline is not attached at all', async () => {
  let seenGroups = null;
  const { deps } = makeDeps({
    computeSessionTimelineImpl: () => ({ periods: [], plan_events: [], subagents: [] }),
  });
  const base = deps.flushBackfillChunksImpl;
  deps.flushBackfillChunksImpl = async (groups, ...rest) => {
    seenGroups = groups;
    return base(groups, ...rest);
  };

  const result = await runAudit(deps, {});

  assert.equal(seenGroups[0].timeline, null);
  assert.equal(result.timelines, 0);
  assert.equal(result.sessionsImported, 1);
});

// The checkpoint's merged sidecar+sweep agent map feeds the timeline — past sessions' sidecars
// are pruned, so re-reading them would lose every swept agent.
test('17b. the timeline is computed from the checkpoint agent map', async () => {
  let seenAgents = null;
  const { deps } = makeDeps({
    runCheckpointImpl: async (input, _d, options) => {
      options.sink(report(input.session_id));
      return { outcome: 'committed', enqueued: 1, flush: null, sessionErrors: [], agents: { a1: { agent_id: 'a1' } } };
    },
    computeSessionTimelineImpl: (_path, _id, timelineDeps) => {
      seenAgents = timelineDeps.readAgents();
      return { periods: [{ state: 'working' }], plan_events: [], subagents: [] };
    },
  });

  await runAudit(deps, {});

  assert.deepEqual(seenAgents, { a1: { agent_id: 'a1' } });
});

test('18. posts buffered rate-limit errors after the flush', async () => {
  const { deps, events } = makeDeps({
    runCheckpointImpl: async (input, _d, options) => {
      options.sink(report(input.session_id));
      return { outcome: 'committed', enqueued: 1, flush: null, sessionErrors: [{ sessionId: input.session_id, error: 'rate_limit' }], agents: {} };
    },
  });

  const result = await runAudit(deps, {});

  assert.deepEqual(events.slice(0, 2), ['flush', 'error']);
  assert.equal(result.sessionErrors, 1);
});

// Dark-mode tenants: the timeline/errors routes are tracking-gated — their audit is usage-only.
test('19. follow-ups are skipped entirely when tracking is not live', async () => {
  const { deps, events } = makeDeps({
    readTrackingStateImpl: () => ({ trackingMode: 'backfill_only', backfillCompleted: false }),
    runCheckpointImpl: async (input, _d, options) => {
      options.sink(report(input.session_id));
      return { outcome: 'committed', enqueued: 1, flush: null, sessionErrors: [{ sessionId: input.session_id, error: 'rate_limit' }], agents: {} };
    },
  });

  const result = await runAudit(deps, {});

  assert.ok(!events.includes('timeline'));
  assert.ok(!events.includes('error'));
  assert.equal(result.followupsAllowed, false);
  assert.equal(result.sessionsImported, 1);
});

// A broken transcript's timeline must never block the usage upload: the group ships without it.
test('20. a timeline that fails to compute never blocks the upload', async () => {
  let seenGroups = null;
  const { deps } = makeDeps({
    computeSessionTimelineImpl: () => { throw new Error('unparseable transcript'); },
  });
  const base = deps.flushBackfillChunksImpl;
  deps.flushBackfillChunksImpl = async (groups, ...rest) => {
    seenGroups = groups;
    return base(groups, ...rest);
  };

  const result = await runAudit(deps, {});

  assert.equal(seenGroups[0].timeline, null);
  assert.equal(result.sessionsImported, 1);
});

// While a batch is in flight the loop keeps parsing (session 52 here; the 51st only launches the full batch).
test('20b. parsing continues while a dispatched batch is in flight', async () => {
  const order = [];
  const sessions = Array.from({ length: 52 }, (_u, i) => rollout(`s${i}`));
  const { deps } = makeDeps({
    listRollouts: () => sessions,
    runCheckpointImpl: async (input, _d, options) => {
      order.push(`parse:${input.session_id}`);
      options.sink(report(input.session_id));
      return { outcome: 'committed', enqueued: 1, flush: null, sessionErrors: [], agents: {} };
    },
    flushBackfillChunksImpl: async (groups) => {
      order.push(`flush-start:${groups.length}`);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      order.push(`flush-end:${groups.length}`);
      const bySession = new Map(
        groups.map((g) => [g.sessionId, { status: BackfillSessionStatus.ACCEPTED, reason: null }]),
      );
      return flushResult({ stored: groups.length, bySession });
    },
  });

  const result = await runAudit(deps, {});

  assert.equal(result.sessionsImported, 52);
  const firstStart = order.indexOf('flush-start:50');
  const firstEnd = order.indexOf('flush-end:50');
  assert.ok(firstStart >= 0 && firstEnd > firstStart, 'first batch was dispatched');
  const overlapped = order
    .slice(firstStart + 1, firstEnd)
    .some((event) => event.startsWith('parse:'));
  assert.ok(overlapped, 'no session was parsed while the first batch was in flight');
});

test('21. drives runCheckpoint with the audit seams and the discovered cwd', async () => {
  let seen = null;
  const { deps } = makeDeps({
    runCheckpointImpl: async (input, _d, options) => {
      seen = { input, options };
      options.sink(report(input.session_id));
      return { outcome: 'committed', enqueued: 1, flush: null, sessionErrors: [], agents: {} };
    },
  });

  await runAudit(deps, {});

  assert.equal(seen.input.cwd, 'C:/work/app');
  assert.ok(seen.input.transcript_path, 'the discovered path is passed through — no per-session tree walk');
  assert.equal(seen.options.skipFlush, true);
  assert.equal(seen.options.collectSessionErrors, true);
  // The cursor must not advance before delivery is confirmed, or a failed run leaves the session
  // both unledgered and unreadable.
  assert.equal(seen.options.persistState, false);
  // Past sessions' hook sidecars are pruned — the rollout-tree sweep is the only way their
  // subagents are found.
  assert.equal(seen.options.sweepSubagents, true);
  // The audit runs while the tenant gate is closed — the flag must be explicit.
  assert.equal(seen.options.skipLiveTrackingGate, true);
});

// ─── ledger ─────────────────────────────────────────────────────────────────

test('22. ledgers a rejected session so it is not resent every run', async () => {
  const flush = fakeFlush(() => BackfillSessionStatus.REJECTED);
  const { deps, saved } = makeDeps({ flushBackfillChunksImpl: flush.impl });

  await runAudit(deps, {});

  assert.equal(saved.at(-1).sessions['s1'].outcome, BackfillSessionStatus.REJECTED);
});

test('23. does NOT ledger a session the server never judged', async () => {
  const flush = fakeFlush(() => BackfillSessionStatus.FAILED);
  const { deps, saved } = makeDeps({ flushBackfillChunksImpl: flush.impl });

  await runAudit(deps, {});

  assert.equal(saved.at(-1)?.sessions['s1'], undefined);
});

test('35. a session that yields no reports is not sent', async () => {
  const flush = fakeFlush();
  const { deps } = makeDeps({
    flushBackfillChunksImpl: flush.impl,
    runCheckpointImpl: async () => ({ outcome: 'committed', enqueued: 0, flush: null, sessionErrors: [], agents: {} }),
  });

  const result = await runAudit(deps, {});

  assert.equal(flush.calls.length, 0);
  assert.equal(result.sessionsImported, 0);
  assert.equal(result.ok, true);
});

// ─── Wave 1: run cache and yield ────────────────────────────────────────────

// Fifty distinct reports: one session that fills a batch on its own.
const fiftyReports = (sessionId) => Array.from({ length: 50 }, (_u, i) => ({ ...report(sessionId), segmentId: `${sessionId}:${i}-${i + 1}` }));

// Records, in order, every setImmediate that lib/session-audit.mjs itself schedules.
function recordYields(t, events) {
  const original = globalThis.setImmediate;
  globalThis.setImmediate = function recorded(fn, ...args) {
    const caller = (new Error().stack || '').split('\n')[2] || '';
    if (/lib[\\/]session-audit\.mjs/.test(caller)) events.push('yield');
    return original.call(this, fn, ...args);
  };
  t.after(() => { globalThis.setImmediate = original; });
}

// A run lock whose lease renewal always finds another owner.
const lostLease = () => ({
  ok: true,
  handle: { renew: () => ({ ok: false, reason: 'lost' }), verify: () => ({ ok: true }), release: () => ({ ok: true }) },
});

test('37. one run cache per run, handed to every checkpoint, its git memo wrapping deps.gitImpl', async () => {
  const seen = [];
  const asked = [];
  const make = () => makeDeps({
    listRollouts: () => [rollout('s1'), rollout('s2')],
    gitImpl: (args, cwd) => { asked.push(`${args.join(' ')} @ ${cwd}`); return 'main'; },
    runCheckpointImpl: async (input, d, options) => {
      seen.push(d.runCache);
      options.sink(report(input.session_id));
      return checkpointResult();
    },
  }).deps;

  await runAudit(make(), {});
  await runAudit(make(), {});

  assert.equal(seen.length, 4);
  assert.ok(seen[0], 'the history run passes a run cache');
  assert.equal(seen[1], seen[0], 'both sessions of a run share it');
  assert.equal(seen[3], seen[2]);
  assert.notEqual(seen[2], seen[0], 'the next run starts a fresh one');
  assert.deepEqual(Object.keys(seen[0]).sort(), ['git', 'gitRoots']);
  assert.ok(seen[0].gitRoots instanceof Map);
  assert.equal(seen[0].git(['rev-parse', '--abbrev-ref', 'HEAD'], '/r'), 'main');
  assert.equal(seen[0].git(['rev-parse', '--abbrev-ref', 'HEAD'], '/r'), 'main');
  assert.deepEqual(asked, ['rev-parse --abbrev-ref HEAD @ /r'], 'the memo wraps deps.gitImpl and asks it once');
});

test('37b. an injected run cache is handed to every checkpoint across runs instead of a fresh one', async () => {
  const seen = [];
  const asked = [];
  const shared = createRunCache({ gitImpl: (args, cwd) => { asked.push(`${args.join(' ')} @ ${cwd}`); return 'main'; } });
  const make = () => makeDeps({
    listRollouts: () => [rollout('s1'), rollout('s2')],
    runCache: shared,
    runCheckpointImpl: async (input, d, options) => {
      seen.push(d.runCache);
      d.runCache.git(['rev-parse', '--show-toplevel'], '/r');
      options.sink(report(input.session_id));
      return checkpointResult();
    },
  }).deps;

  await runAudit(make(), {});
  await runAudit(make(), {});

  assert.equal(seen.length, 4);
  assert.ok(seen.every((c) => c === shared), 'every checkpoint of both runs gets the injected cache');
  assert.deepEqual(asked, ['rev-parse --show-toplevel @ /r'], 'the second run reuses the first run\'s git answer');
});

test('37c. createRunCache builds the same shape the run builds on its own', () => {
  const asked = [];
  const cache = createRunCache({ gitImpl: (args) => { asked.push(args.join(' ')); return 'x'; } });
  assert.deepEqual(Object.keys(cache).sort(), ['git', 'gitRoots']);
  assert.ok(cache.gitRoots instanceof Map);
  assert.equal(cache.git(['status'], '/r'), 'x');
  assert.equal(cache.git(['status'], '/r'), 'x');
  assert.deepEqual(asked, ['status']);
  assert.notEqual(createRunCache({ gitImpl: () => 'x' }), cache);
});

test('38. no runCheckpoint caller but the history run passes a run cache', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const callers = [];
  for (const dir of ['lib', 'scripts']) {
    for (const name of fs.readdirSync(path.join(root, dir)).filter((n) => n.endsWith('.mjs'))) {
      const file = `${dir}/${name}`;
      const src = fs.readFileSync(path.join(root, dir, name), 'utf-8');
      // checkpoint.mjs reads the cache, and the two shared helpers serve it; none calls runCheckpoint with one.
      if (['lib/checkpoint.mjs', 'lib/repo-root-fast.mjs', 'lib/git-memo.mjs'].indexOf(file) !== -1) continue;
      if (/\brunCheckpoint\b/.test(src) && /\brunCache\b/.test(src)) callers.push(file);
    }
  }
  assert.deepEqual(callers, ['lib/session-audit.mjs']);
});

test('39. the loop yields to pending I/O once per session, before parsing it', async (t) => {
  const events = [];
  recordYields(t, events);
  const { deps } = makeDeps({
    listRollouts: () => [rollout('s1'), rollout('s2'), rollout('s3')],
    runCheckpointImpl: async (input, _d, options) => {
      events.push(`parse:${input.session_id}`);
      options.sink(report(input.session_id));
      return checkpointResult();
    },
  });

  const result = await runAudit(deps, {});

  assert.equal(result.sessionsImported, 3);
  assert.deepEqual(events, ['yield', 'parse:s1', 'yield', 'parse:s2', 'yield', 'parse:s3']);
});

test('40. a halted run still yields before it reads the halt, and parses nothing after it', async (t) => {
  const events = [];
  recordYields(t, events);
  const { deps } = makeDeps({
    acquireLockImpl: lostLease,
    listRollouts: () => [rollout('s1'), rollout('s2'), rollout('s3')],
    runCheckpointImpl: async (input, _d, options) => {
      events.push(`parse:${input.session_id}`);
      for (const payload of fiftyReports(input.session_id)) options.sink(payload);
      return checkpointResult();
    },
  });

  const result = await runAudit(deps, {});

  const parses = events.filter((e) => e.startsWith('parse:')).length;
  assert.equal(result.halt, BackfillHalt.LOCK_LOST);
  assert.ok(parses < 3, 'the loop stopped at the halt');
  assert.equal(events[events.length - 1], 'yield', 'the halt is read after the yield');
  assert.equal(events.filter((e) => e === 'yield').length, parses + 1);
});

test('41. a flight that fails while the loop parses is the run\'s error, never an unhandled rejection', async (t) => {
  const unhandled = [];
  const onUnhandled = (reason) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.removeListener('unhandledRejection', onUnhandled));
  let flushes = 0;
  const { deps } = makeDeps({
    listRollouts: () => [rollout('s1'), rollout('s2'), rollout('s3')],
    runCheckpointImpl: async (input, _d, options) => {
      for (const payload of fiftyReports(input.session_id)) options.sink(payload);
      return checkpointResult();
    },
    flushBackfillChunksImpl: async () => {
      flushes += 1;
      await new Promise((resolve) => setImmediate(resolve));
      throw new Error('boom');
    },
  });

  await assert.rejects(runAudit(deps, {}), /boom/);

  assert.equal(flushes, 1, 'nothing is sent after the failure');
  assert.deepEqual(unhandled, []);
});

test('gzip 1. runAudit hands one shared compression object to every flush of a run, and a fresh one per run', async () => {
  const runOnce = async () => {
    const seen = [];
    const sessions = Array.from({ length: 51 }, (_u, i) => rollout(`s${i}`));
    const { deps } = makeDeps({
      listRollouts: () => sessions,
      flushBackfillChunksImpl: async (groups, _key, _session, flushDeps) => {
        const compression = flushDeps.compression;
        seen.push({ compression, enabled: compression == null ? undefined : compression.enabled });
        // Turns gzip off the way a proxy refusal would; the run's next flush must see it.
        if (compression != null) compression.enabled = false;
        const bySession = new Map(
          groups.map((g) => [g.sessionId, { status: BackfillSessionStatus.ACCEPTED, reason: null }]),
        );
        return flushResult({ stored: groups.length, bySession });
      },
    });
    const result = await runAudit(deps, {});
    assert.equal(result.sessionsImported, 51);
    return seen;
  };

  const first = await runOnce();
  assert.equal(first.length, 2, '51 sessions make two batches');
  assert.deepEqual(first.map((call) => call.enabled), [true, false]);
  assert.strictEqual(first[1].compression, first[0].compression);

  const second = await runOnce();
  assert.equal(second[0].enabled, true);
  assert.notStrictEqual(second[0].compression, first[0].compression);
});

// ─── scope, list-only and the allowlist ─────────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;
const SCOPE_NOW = 10 * DAY;
const L = SCOPE_NOW - 5 * 60 * 60 * 1000;
const linkedTracking = (trackingMode = 'live') => () => ({ trackingMode, backfillCompleted: false, linkedAt: new Date(L).toISOString() });
const BOUNDARY = [rollout('before', L - 1), rollout('at', L), rollout('after', L + 1)];

function scopeDeps(overrides = {}) {
  return makeDeps({
    now: () => SCOPE_NOW,
    readTrackingStateImpl: linkedTracking(),
    listRollouts: () => BOUNDARY,
    ...overrides,
  });
}

const listedIds = (result) => result.listed.map((entry) => entry.sessionId);
const sentIds = (flush) => flush.calls.flatMap((call) => call.groups.map((group) => group.sessionId)).sort();

test('scope 1. PAST lists only what was last written before the link, LIVE uploads the rest, and together they cover all three once', async () => {
  const past = await runAudit(scopeDeps().deps, { scope: HistoryScope.PAST, listOnly: true });
  assert.deepEqual(listedIds(past), ['before']);

  const flush = fakeFlush();
  const live = await runAudit(scopeDeps({ flushBackfillChunksImpl: flush.impl }).deps, { scope: HistoryScope.LIVE });
  assert.deepEqual(sentIds(flush), ['after', 'at']);

  const pastIds = listedIds(past);
  assert.equal(sentIds(flush).filter((id) => pastIds.indexOf(id) !== -1).length, 0, 'disjoint');
  assert.deepEqual([...pastIds, ...sentIds(flush)].sort(), ['after', 'at', 'before']);
});

test('scope 2. an unknown link time makes every session past: PAST lists all, LIVE lists none', async () => {
  const unknown = () => scopeDeps({ readTrackingStateImpl: () => ({ trackingMode: 'live', backfillCompleted: false }) }).deps;
  assert.equal(workspaceLinkMs(SESSION, null, unknown()), null);

  const past = await runAudit(unknown(), { scope: HistoryScope.PAST, listOnly: true });
  assert.deepEqual(listedIds(past), ['before', 'at', 'after']);

  const live = await runAudit(unknown(), { scope: HistoryScope.LIVE, listOnly: true });
  assert.deepEqual(listedIds(live), []);
});

test('scope 3. an Audit workspace (backfill_only) is offered every session, with its tracking mode', async () => {
  const { deps } = scopeDeps({
    readTrackingStateImpl: linkedTracking('backfill_only'),
    whoamiImpl: async () => ({ valid: true, trackingMode: 'backfill_only', backfillCompleted: false }),
  });
  const past = await runAudit(deps, { scope: HistoryScope.PAST, listOnly: true });
  assert.deepEqual(listedIds(past), ['before', 'at', 'after']);
  assert.equal(past.trackingMode, 'backfill_only');
});

test('scope 4. a workspace joined after the link cuts its past at its own join time', async () => {
  // The linkedSessions() shape: no linkedAt on the session, only each workspace's joinedAt.
  const joined = { ...SESSION, tenants: [{ id: 't1' }, { id: 't2', joinedAt: new Date(L + 100).toISOString() }] };
  const deps = () => scopeDeps({ linkedSessions: async () => [joined] }).deps;
  assert.equal(workspaceLinkMs(joined, 't2', deps()), L + 100);
  assert.equal(workspaceLinkMs(joined, 't1', deps()), L);

  const t2 = await runAudit(deps(), { scope: HistoryScope.PAST, listOnly: true, tenantId: 't2' });
  assert.deepEqual(listedIds(t2), ['before', 'at', 'after']);
  const t1 = await runAudit(deps(), { scope: HistoryScope.PAST, listOnly: true, tenantId: 't1' });
  assert.deepEqual(listedIds(t1), ['before']);
});

test('scope 5. a rollout older than 30 days is never listed', async () => {
  const { deps } = scopeDeps({ listRollouts: () => [rollout('ancient', SCOPE_NOW - 31 * DAY), rollout('recent', L - 1)] });
  const past = await runAudit(deps, { scope: HistoryScope.PAST, listOnly: true });
  assert.deepEqual(listedIds(past), ['recent']);
  assert.equal(past.tooOld, 1);
});

test('scope 6. a session started before the link and resumed after it is live, never past', async () => {
  const resumed = rollout('resumed', L + 1);
  const make = (flushImpl) => scopeDeps({
    listRollouts: () => [resumed],
    rolloutStartedAtImpl: () => L - 3 * DAY,
    ...(flushImpl ? { flushBackfillChunksImpl: flushImpl } : {}),
  }).deps;

  const past = await runAudit(make(), { scope: HistoryScope.PAST, listOnly: true });
  assert.deepEqual(listedIds(past), []);

  const flush = fakeFlush();
  await runAudit(make(flush.impl), { scope: HistoryScope.LIVE });
  assert.deepEqual(sentIds(flush), ['resumed']);
});

test('listOnly stops after coverage: no registration, no parse, no chunk, and lists the candidates left', async () => {
  const posts = [];
  const parsed = [];
  const flush = fakeFlush();
  const make = () => scopeDeps({
    readChatgptAuthImpl: () => ({ authMode: 'chatgpt', accountId: 'acct', expiresAt: SCOPE_NOW + DAY }),
    postJsonImpl: async (url) => { posts.push(url); return { ok: true, status: 200, json: async () => ({ accountLinked: true }) }; },
    runCheckpointImpl: async (input, _d, options) => { parsed.push(input.session_id); options.sink(report(input.session_id)); return checkpointResult(); },
    flushBackfillChunksImpl: flush.impl,
    // Our own confirmation runs ahead of an empty server prefix for `at`: coverage defers it as a gap.
    loadCoverageCheckpointsImpl: () => ({ version: 1, identity: null, environment: '', apiBase: null, sessions: { at: { line: 5 } }, updatedAt: null }),
    rolloutStartedAtImpl: (p) => { if (p === BOUNDARY[0].transcriptPath) return L - DAY; throw new Error('EACCES'); },
  }).deps;

  const listed = await runAudit(make(), { listOnly: true });
  assert.equal(listed.ok, true);
  assert.equal(listed.trackingMode, 'live');
  assert.equal(listed.deferredGap, 1);
  assert.equal(listed.candidates, 2);
  assert.deepEqual(listed.listed, [
    { sessionId: 'before', startedMs: L - DAY, mtimeMs: L - 1, cwd: 'C:/work/app' },
    { sessionId: 'after', startedMs: L + 1, mtimeMs: L + 1, cwd: 'C:/work/app' },
  ]);
  assert.deepEqual(posts, []);
  assert.deepEqual(parsed, []);
  assert.equal(flush.calls.length, 0);

  // The same run without listOnly registers and uploads, so the silence above is listOnly's.
  await runAudit(make());
  assert.equal(posts.length, 1);
  assert.deepEqual(sentIds(flush), ['after', 'before']);
});

test('listOnly leaves out a gap-deferred session that split bookkeeping would still parse', async () => {
  const { deps } = scopeDeps({
    loadCoverageCheckpointsImpl: () => ({ version: 1, identity: null, environment: '', apiBase: null, sessions: { at: { line: 5 } }, updatedAt: null }),
  });
  const listed = await runAudit(deps, { listOnly: true, excludedSessionIds: new Set() });
  assert.equal(listed.candidates, 3);
  assert.deepEqual(listedIds(listed), ['before', 'after']);
});

test('allowlist: only the offered session is sent, and one the server already covers is not re-sent', async () => {
  const offered = rollout('s1', L - 1);
  const eligible = rollout('s2', L - 2);
  // The rollout has 10 lines: a replay from the server's prefix emits only what lies past it.
  const tenLines = async (input, _d, options) => {
    if (options.startCursor < 10) options.sink({ ...report(input.session_id), from_line: options.startCursor + 1, to_line: 10 });
    return checkpointResult();
  };

  const flush = fakeFlush();
  const sent = await runAudit(scopeDeps({
    listRollouts: () => [offered, eligible],
    runCheckpointImpl: tenLines,
    flushBackfillChunksImpl: flush.impl,
  }).deps, { scope: HistoryScope.PAST, onlySessionIds: ['s1'] });
  assert.equal(flush.calls.length, 1);
  assert.deepEqual(sentIds(flush), ['s1']);

  const covered = fakeFlush();
  const again = await runAudit(scopeDeps({
    listRollouts: () => [offered, eligible],
    runCheckpointImpl: tenLines,
    flushBackfillChunksImpl: covered.impl,
    fetchCoverageImpl: async () => new Map([['s1', 10]]),
  }).deps, { scope: HistoryScope.PAST, onlySessionIds: new Set(['s1']) });
  assert.equal(covered.calls.length, 0);
  assert.equal(again.sessionsImported, 0);
  assert.equal(again.empty, 1);
});

test('declinedSessionIds leaves out the listed sessions and counts them', async () => {
  const past = await runAudit(scopeDeps({ listRollouts: () => [rollout('a', L - 2), rollout('b', L - 1)] }).deps, {
    scope: HistoryScope.PAST, listOnly: true, declinedSessionIds: ['a'],
  });
  assert.deepEqual(listedIds(past), ['b']);
  assert.equal(past.declined, 1);
});

test('a stored session whose rollout cannot be read is still listed, never counted covered', async () => {
  const { deps } = scopeDeps({
    listRollouts: () => [rollout('s1', L - 1)],
    fetchCoverageImpl: async () => new Map([['s1', 7]]),
    lastUsageLineImpl: () => null,
  });
  const past = await runAudit(deps, { scope: HistoryScope.PAST, listOnly: true });
  assert.deepEqual(listedIds(past), ['s1']);
  assert.equal(past.covered, 0);
});

test('the scope and allowlist skips keep no counters; declined and covered are the ones read', async () => {
  const past = await runAudit(scopeDeps().deps, { scope: HistoryScope.PAST, listOnly: true, onlySessionIds: ['before'] });
  for (const gone of ['liveSide', 'pastSide', 'notOffered']) assert.equal(gone in past, false, gone);
  assert.equal(past.declined, 0);
  assert.equal(past.covered, 0);
});

test('a busy run reaches the caller unsettled, with no list', async () => {
  const { deps } = scopeDeps({ acquireLockImpl: () => ({ ok: false, reason: 'held' }) });
  const result = await runAudit(deps, { scope: HistoryScope.PAST, listOnly: true });
  assert.equal(result.reason, 'run-in-progress');
  assert.equal(result.listed, null);
});

test('the one-time import is gone: lib/ and scripts/ name none of its seal, mode or route', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const gone = ['SYNC_MODE', 'shouldFinalize', 'completeBackfill', 'markBackfillCompleted', 'shouldBackfill', 'sessionsBackfill', '/sessions/backfill'];
  const hits = [];
  for (const dir of ['lib', 'scripts']) {
    for (const name of fs.readdirSync(path.join(root, dir)).filter((n) => n.endsWith('.mjs'))) {
      const src = fs.readFileSync(path.join(root, dir, name), 'utf-8');
      for (const token of gone) if (src.includes(token)) hits.push(`${dir}/${name}: ${token}`);
    }
  }
  assert.deepEqual(hits, []);
});
