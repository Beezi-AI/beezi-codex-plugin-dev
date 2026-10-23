import test from 'node:test';
import assert from 'node:assert/strict';
import { runPendingHistory, runPendingHistoryPatiently, runDuePendingHistory, classifyRun } from '../lib/pending-history-run.mjs';
import { RunOutcome, SettleState, settleHistory } from '../lib/pending-history.mjs';
import { BackfillHalt } from '../lib/audit-flush.mjs';

const T0 = Date.parse('2026-10-13T10:00:00.000Z');
const REQ = new Date(T0 - 1000).toISOString();
const clean = (over = {}) => ({
  ok: true, reason: null, halt: null, reportsFailed: 0, coverageKnown: true, candidates: 3, sessionsImported: 3, recent: [],
  deferredGap: 0, deferredSplit: 0, deferredOverlap: 0, deferredUnavailable: 0, ...over,
});

function harness({ row, results, plan, starts = {} }) {
  const audits = [];
  const auditDeps = [];
  const settled = [];
  const accounts = {
    AccountStatus: { LINKED: 'linked' },
    listAccounts: async () => [row],
    notePendingAttempt: async () => {},
    settlePendingHistory: async (key, tenantId, run) => { settled.push({ tenantId, ...run }); return 'cleared'; },
  };
  const deps = {
    accounts,
    now: () => T0,
    planWorkspaceRuns: () => plan,
    runAudit: async (d, options) => { audits.push(options); auditDeps.push(d); return results.shift(); },
    rolloutStartedAt: (p) => (starts[p] == null ? null : starts[p]),
  };
  return { deps, audits, auditDeps, settled };
}

const multiRow = (pending) => ({ key: 'k1', status: 'linked', tenants: [{ id: 'A' }, { id: 'B' }], pendingHistory: pending });

test('runs only the pending workspace, routed by the sync plan', async () => {
  const routes = new Map();
  const h = harness({ row: multiRow([{ tenantId: 'B', sessionIds: ['s1'], requestedAt: REQ }]), results: [clean()], plan: { tenantIds: ['A', 'B'], routes } });
  await runPendingHistory('k1', h.deps);
  assert.equal(h.audits.length, 1);
  assert.equal(h.audits[0].tenantId, 'B');
  assert.equal(h.audits[0].sessionRoutes, routes);
  assert.equal('mode' in h.audits[0], false);
  assert.equal(h.audits[0].key, 'k1');
  assert.deepEqual(h.settled, [{ tenantId: 'B', outcome: RunOutcome.CLEAN, sent: 3, skipped: 0 }]);
});

test('the worker never asks for liveOnly, so an audit workspace\'s history goes up through sync', async () => {
  const h = harness({ row: multiRow([{ tenantId: 'B', sessionIds: ['s1'], requestedAt: REQ }]), results: [clean()], plan: { tenantIds: ['B'], routes: new Map() } });
  await runPendingHistory('k1', h.deps);
  assert.equal(h.audits[0].liveOnly, undefined);
  assert.deepEqual(h.settled, [{ tenantId: 'B', outcome: RunOutcome.CLEAN, sent: 3, skipped: 0 }]);
});

test('a recent session that predates the request keeps the marker waiting', async () => {
  const result = clean({ recent: [{ sessionId: 's-old', path: '/t/old.jsonl' }] });
  const h = harness({ row: multiRow([{ tenantId: 'B', sessionIds: ['s1'], requestedAt: REQ }]), results: [result], plan: { tenantIds: ['B'], routes: new Map() }, starts: { '/t/old.jsonl': T0 - 3600 * 1000 } });
  await runPendingHistory('k1', h.deps);
  assert.equal(h.settled[0].outcome, RunOutcome.WAITING);
});

test('a recent session started after the request does not', async () => {
  const result = clean({ recent: [{ sessionId: 's-new', path: '/t/new.jsonl' }] });
  const h = harness({ row: multiRow([{ tenantId: 'B', sessionIds: ['s1'], requestedAt: REQ }]), results: [result], plan: { tenantIds: ['B'], routes: new Map() }, starts: { '/t/new.jsonl': T0 } });
  await runPendingHistory('k1', h.deps);
  assert.equal(h.settled[0].outcome, RunOutcome.CLEAN);
});

test('an unreadable start time counts as after the request', async () => {
  const result = clean({ recent: [{ sessionId: 's-bad', path: '/t/bad.jsonl' }] });
  const h = harness({ row: multiRow([{ tenantId: 'B', sessionIds: ['s1'], requestedAt: REQ }]), results: [result], plan: { tenantIds: ['B'], routes: new Map() } });
  h.deps.rolloutStartedAt = () => { throw new Error('EACCES'); };
  await runPendingHistory('k1', h.deps);
  assert.equal(h.settled[0].outcome, RunOutcome.CLEAN);
});

test('busy settles every remaining entry as busy without another run', async () => {
  const row = multiRow([{ tenantId: 'A', sessionIds: ['s1'], requestedAt: REQ }, { tenantId: 'B', sessionIds: ['s1'], requestedAt: REQ }]);
  const h = harness({ row, results: [{ ok: true, reason: 'run-in-progress' }], plan: { tenantIds: ['A', 'B'], routes: new Map() } });
  await runPendingHistory('k1', h.deps);
  assert.equal(h.audits.length, 1);
  assert.deepEqual(h.settled.map((s) => s.outcome), [RunOutcome.BUSY, RunOutcome.BUSY]);
});

test('a throwing run settles as failed', async () => {
  const row = multiRow([{ tenantId: 'A', sessionIds: ['s1'], requestedAt: REQ }, { tenantId: 'B', sessionIds: ['s1'], requestedAt: REQ }]);
  const h = harness({ row, results: [clean()], plan: { tenantIds: ['A', 'B'], routes: new Map() } });
  const runAudit = h.deps.runAudit;
  let calls = 0;
  h.deps.runAudit = async (d, options) => {
    calls += 1;
    if (calls === 1) throw new Error('boom');
    return runAudit(d, options);
  };
  await runPendingHistory('k1', h.deps);
  assert.deepEqual(h.settled, [
    { tenantId: 'A', outcome: RunOutcome.FAILED, sent: 0, skipped: 0 },
    { tenantId: 'B', outcome: RunOutcome.CLEAN, sent: 3, skipped: 0 },
  ]);
});

test('a settle that throws (index lock busy) does not stop the pass', async () => {
  const row = multiRow([{ tenantId: 'A', sessionIds: ['s1'], requestedAt: REQ }, { tenantId: 'B', sessionIds: ['s1'], requestedAt: REQ }]);
  const h = harness({ row, results: [clean(), clean()], plan: { tenantIds: ['A', 'B'], routes: new Map() } });
  const settle = h.deps.accounts.settlePendingHistory;
  h.deps.accounts.settlePendingHistory = async (key, tenantId, run, timing) => {
    if (tenantId === 'A') throw new Error('Accounts are being updated');
    return settle(key, tenantId, run, timing);
  };
  const done = await runPendingHistory('k1', h.deps);
  assert.equal(h.audits.length, 2);
  assert.deepEqual(done.map((d) => [d.tenantId, d.state]), [['A', SettleState.MISSING], ['B', 'cleared']]);
});

test('the plan time is taken before the account row is read', async () => {
  const h = harness({ row: multiRow([{ tenantId: 'B', sessionIds: ['s1'], requestedAt: REQ }]), results: [clean()], plan: { tenantIds: ['B'], routes: new Map() } });
  let clock = T0;
  h.deps.now = () => clock;
  const list = h.deps.accounts.listAccounts;
  // A rule write landing during the index read is later than the plan time.
  h.deps.accounts.listAccounts = async () => { clock = T0 + 5000; return list(); };
  const timings = [];
  h.deps.accounts.settlePendingHistory = async (key, tenantId, run, timing) => { timings.push(timing); return 'kept'; };
  await runPendingHistory('k1', h.deps);
  assert.equal(timings[0].plannedAtMs, T0);
});

test('a workspace no route reaches clears with nothing sent', async () => {
  const h = harness({ row: multiRow([{ tenantId: 'B', sessionIds: ['s1'], requestedAt: REQ }]), results: [], plan: { tenantIds: ['A'], routes: new Map() } });
  await runPendingHistory('k1', h.deps);
  assert.equal(h.audits.length, 0);
  assert.deepEqual(h.settled, [{ tenantId: 'B', outcome: RunOutcome.CLEAN, sent: 0, skipped: 0 }]);
});

test('a one-workspace account runs headerless with its Don\'t-track exclusions', async () => {
  const row = { key: 'k1', status: 'linked', tenants: [{ id: 'A' }], workspaceRules: [{ kind: 'folder', match: '/x', tenantIds: [] }], pendingHistory: [{ tenantId: 'A', sessionIds: ['s1'], requestedAt: REQ }] };
  const routes = new Map([['s1', { source: 'rule', tenantIds: [] }], ['s2', { source: 'single', tenantIds: [null] }]]);
  const h = harness({ row, results: [clean()], plan: { tenantIds: [], routes } });
  await runPendingHistory('k1', h.deps);
  assert.equal(h.audits[0].tenantId, null);
  assert.equal(h.audits[0].key, 'k1');
  assert.deepEqual([...h.audits[0].excludedSessionIds], ['s1']);
});

test('every workspace pass shares one run cache built once', async () => {
  const row = multiRow([{ tenantId: 'A', sessionIds: ['s1'], requestedAt: REQ }, { tenantId: 'B', sessionIds: ['s1'], requestedAt: REQ }]);
  const h = harness({ row, results: [clean(), clean()], plan: { tenantIds: ['A', 'B'], routes: new Map() } });
  const cache = { git: () => '', gitRoots: new Map() };
  let built = 0;
  h.deps.createRunCache = () => { built += 1; return cache; };
  await runPendingHistory('k1', h.deps);
  assert.equal(built, 1);
  assert.equal(h.auditDeps.length, 2);
  assert.equal(h.auditDeps[0].runCache, cache);
  assert.equal(h.auditDeps[1].runCache, cache);
});

test('without an override the real factory builds the shared cache', async () => {
  const row = multiRow([{ tenantId: 'A', sessionIds: ['s1'], requestedAt: REQ }, { tenantId: 'B', sessionIds: ['s1'], requestedAt: REQ }]);
  const h = harness({ row, results: [clean(), clean()], plan: { tenantIds: ['A', 'B'], routes: new Map() } });
  await runPendingHistory('k1', h.deps);
  assert.ok(h.auditDeps[0].runCache != null);
  assert.ok(h.auditDeps[0].runCache.gitRoots instanceof Map);
  assert.equal(h.auditDeps[1].runCache, h.auditDeps[0].runCache);
});

test('classifyRun — Codex reasons', () => {
  assert.equal(classifyRun({ ok: true, reason: 'run-in-progress' }, false), RunOutcome.BUSY);
  assert.equal(classifyRun({ ok: true, reason: 'active-writer' }, false), RunOutcome.BUSY);
  assert.equal(classifyRun({ ok: true, reason: 'pending-transaction' }, false), RunOutcome.BUSY);
  assert.equal(classifyRun({ ok: true, reason: 'audit-only' }, false), RunOutcome.REFUSED);
  assert.equal(classifyRun({ ok: true, reason: 'workspace-required' }, false), RunOutcome.REFUSED);
  assert.equal(classifyRun({ ok: true, reason: 'pending-not-drained' }, false), RunOutcome.FAILED);
  assert.equal(classifyRun({ ok: true, reason: 'pending-unreadable', lastError: 'EACCES' }, false), RunOutcome.FAILED);
  assert.equal(classifyRun(clean({ deferredUnavailable: 1 }), false), RunOutcome.FAILED);
  assert.equal(classifyRun(clean({ halt: BackfillHalt.LOCK_LOST }), false), RunOutcome.BUSY);
  assert.equal(classifyRun(clean({ halt: BackfillHalt.ALREADY_COMPLETED }), false), RunOutcome.FAILED);
  assert.equal(classifyRun(clean({ halt: BackfillHalt.NOT_ALLOWED }), false), RunOutcome.REFUSED);
  assert.equal(classifyRun(clean(), false), RunOutcome.CLEAN);
});

test('classifyRun — failures and waiting', () => {
  assert.equal(classifyRun(null, false), RunOutcome.FAILED);
  assert.equal(classifyRun(clean({ halt: BackfillHalt.FORBIDDEN }), false), RunOutcome.REFUSED);
  assert.equal(classifyRun(clean({ halt: BackfillHalt.UNSUPPORTED_SERVER }), false), RunOutcome.REFUSED);
  assert.equal(classifyRun(clean({ reportsFailed: 1 }), false), RunOutcome.FAILED);
  assert.equal(classifyRun(clean({ coverageKnown: false }), false), RunOutcome.FAILED);
  assert.equal(classifyRun(clean({ coverageKnown: false, candidates: 0 }), false), RunOutcome.CLEAN);
  assert.equal(classifyRun({ ok: false, reason: 'no-token' }, false), RunOutcome.FAILED);
  assert.equal(classifyRun(clean(), true), RunOutcome.WAITING);
});

test('skipped counts gap, split and overlap deferrals', async () => {
  const result = clean({ sessionsImported: 4, deferredGap: 2, deferredSplit: 1, deferredOverlap: 1, deferredUnavailable: 0 });
  const h = harness({ row: multiRow([{ tenantId: 'B', sessionIds: ['s1'], requestedAt: REQ }]), results: [result], plan: { tenantIds: ['B'], routes: new Map() } });
  await runPendingHistory('k1', h.deps);
  assert.deepEqual(h.settled[0], { tenantId: 'B', outcome: RunOutcome.CLEAN, sent: 4, skipped: 4 });
});

test('runDuePendingHistory runs only due accounts and stops when asked', async () => {
  const fresh = new Date(T0 - 60 * 1000).toISOString();
  const rows = [
    { key: 'due', status: 'linked', tenants: [{ id: 'A' }, { id: 'B' }], pendingHistory: [{ tenantId: 'B', sessionIds: ['s1'], requestedAt: fresh, lastAttemptAt: null }] },
    { key: 'recent', status: 'linked', tenants: [{ id: 'A' }, { id: 'B' }], pendingHistory: [{ tenantId: 'B', sessionIds: ['s1'], requestedAt: fresh, lastAttemptAt: fresh }] },
  ];
  const h = harness({ row: rows[0], results: [clean()], plan: { tenantIds: ['B'], routes: new Map() } });
  h.deps.accounts.listAccounts = async () => rows;
  h.deps.accounts.listAccountsSync = () => rows;
  await runDuePendingHistory(h.deps);
  assert.deepEqual(h.audits.map((o) => o.key), ['due']);
  assert.deepEqual(await runDuePendingHistory({ ...h.deps, shouldStop: () => true }), []);
});

test('each run is limited to the sessions the developer accepted', async () => {
  const row = multiRow([{ tenantId: 'A', sessionIds: ['s1', 's2'], requestedAt: REQ }, { tenantId: 'B', sessionIds: ['s3'], requestedAt: REQ }]);
  const h = harness({ row, results: [clean(), clean()], plan: { tenantIds: ['A', 'B'], routes: new Map() } });
  await runPendingHistory('k1', h.deps);
  assert.deepEqual(h.audits.map((o) => o.onlySessionIds), [['s1', 's2'], ['s3']]);
});

test('a one-workspace run is limited to its accepted sessions too', async () => {
  const row = { key: 'k1', status: 'linked', tenants: [{ id: 'A' }], pendingHistory: [{ tenantId: 'A', sessionIds: ['s1'], requestedAt: REQ }] };
  const h = harness({ row, results: [clean()], plan: { tenantIds: [], routes: new Map() } });
  await runPendingHistory('k1', h.deps);
  assert.deepEqual(h.audits[0].onlySessionIds, ['s1']);
});

test('an entry a rule write left without session ids is never run', async () => {
  const row = multiRow([{ tenantId: 'A', requestedAt: REQ }, { tenantId: 'B', sessionIds: [], requestedAt: REQ }]);
  const h = harness({ row, results: [clean(), clean()], plan: { tenantIds: ['A', 'B'], routes: new Map() } });
  assert.deepEqual(await runPendingHistory('k1', h.deps), []);
  assert.equal(h.audits.length, 0);
  assert.deepEqual(h.settled, []);
});

test('tenantIds runs only those workspaces and onResult sees each run', async () => {
  const row = multiRow([{ tenantId: 'A', sessionIds: ['s1'], requestedAt: REQ }, { tenantId: 'B', sessionIds: ['s2'], requestedAt: REQ }]);
  const result = clean();
  const h = harness({ row, results: [result], plan: { tenantIds: ['A', 'B'], routes: new Map() } });
  const seen = [];
  const done = await runPendingHistory('k1', h.deps, { tenantIds: ['B'], onResult: (entry, ran) => seen.push([entry.tenantId, ran]) });
  assert.deepEqual(h.audits.map((o) => o.tenantId), ['B']);
  assert.deepEqual(seen, [['B', result]]);
  assert.deepEqual(done.map((d) => d.tenantId), ['B']);
});

test('onResult gets null for a run that threw', async () => {
  const h = harness({ row: multiRow([{ tenantId: 'B', sessionIds: ['s1'], requestedAt: REQ }]), results: [], plan: { tenantIds: ['B'], routes: new Map() } });
  h.deps.runAudit = async () => { throw new Error('boom'); };
  const seen = [];
  await runPendingHistory('k1', h.deps, { onResult: (entry, ran) => seen.push([entry.tenantId, ran]) });
  assert.deepEqual(seen, [['B', null]]);
});

test('a --tenant override entry runs unrouted for exactly its ids, even where no route reaches it', async () => {
  const routes = new Map();
  const row = multiRow([{ tenantId: 'B', sessionIds: ['s1', 's2'], override: true, requestedAt: REQ }, { tenantId: 'A', sessionIds: ['s3'], requestedAt: REQ }]);
  const h = harness({ row, results: [clean(), clean()], plan: { tenantIds: ['A'], routes } });
  await runPendingHistory('k1', h.deps);
  assert.deepEqual(h.audits.map((o) => [o.tenantId, o.onlySessionIds, o.sessionRoutes]), [['B', ['s1', 's2'], undefined], ['A', ['s3'], routes]]);
});

test('each run applies the kinds hidden when the developer said yes', async () => {
  const row = multiRow([{ tenantId: 'A', sessionIds: ['s1'], kinds: ['repos', 'hosts'], requestedAt: REQ }, { tenantId: 'B', sessionIds: ['s2'], requestedAt: REQ }]);
  const h = harness({ row, results: [clean(), clean()], plan: { tenantIds: ['A', 'B'], routes: new Map() } });
  await runPendingHistory('k1', h.deps);
  assert.deepEqual(h.audits.map((o) => o.acceptedKinds), [['repos', 'hosts'], []]);
});

function patientHarness(results) {
  const row = multiRow([{ tenantId: 'B', sessionIds: ['s1'], requestedAt: REQ }]);
  const h = harness({ row, results, plan: { tenantIds: ['B'], routes: new Map() } });
  h.deps.accounts.settlePendingHistory = async (key, tenantId, run, timing) => settleHistory(row, tenantId, run, timing);
  const waits = [];
  h.deps.sleep = async (ms) => { waits.push(ms); };
  return { ...h, row, waits };
}

const busy = () => ({ ok: true, reason: 'run-in-progress' });

test('a busy lock is waited out, 30 seconds a pass, until the run goes through', async () => {
  const h = patientHarness([busy(), busy(), clean()]);
  const done = await runPendingHistoryPatiently('k1', h.deps);
  assert.equal(h.audits.length, 3);
  assert.deepEqual(h.waits, [30000, 30000]);
  assert.deepEqual(done.map((d) => d.outcome), [RunOutcome.CLEAN]);
});

test('a lock busy on every pass stops after six retries and leaves the entry pending', async () => {
  const h = patientHarness([busy(), busy(), busy(), busy(), busy(), busy(), busy(), clean()]);
  const done = await runPendingHistoryPatiently('k1', h.deps);
  assert.equal(h.audits.length, 7);
  assert.equal(h.waits.length, 6);
  assert.deepEqual(done.map((d) => [d.outcome, d.state]), [[RunOutcome.BUSY, SettleState.KEPT]]);
  assert.deepEqual(h.row.pendingHistory.map((e) => e.tenantId), ['B']);
});

test('a first pass that is not busy runs once and never waits', async () => {
  const h = patientHarness([clean()]);
  const done = await runPendingHistoryPatiently('k1', h.deps);
  assert.equal(h.audits.length, 1);
  assert.deepEqual(h.waits, []);
  assert.deepEqual(done.map((d) => d.outcome), [RunOutcome.CLEAN]);
});

test('M4: a retry reruns only the busy workspace, so a failed one is not counted again', async () => {
  const row = multiRow([{ tenantId: 'A', sessionIds: ['s1'], requestedAt: REQ }, { tenantId: 'B', sessionIds: ['s2'], requestedAt: REQ }]);
  const h = harness({ row, results: [{ ok: true, reason: 'pending-not-drained' }, busy(), clean()], plan: { tenantIds: ['A', 'B'], routes: new Map() } });
  h.deps.sleep = async () => {};
  const done = await runPendingHistoryPatiently('k1', h.deps);
  assert.deepEqual(h.audits.map((o) => o.tenantId), ['A', 'B', 'B']);
  assert.deepEqual(h.settled.map((s) => [s.tenantId, s.outcome]), [['A', RunOutcome.FAILED], ['B', RunOutcome.BUSY], ['B', RunOutcome.CLEAN]]);
  assert.deepEqual(done.map((d) => [d.tenantId, d.outcome]), [['A', RunOutcome.FAILED], ['B', RunOutcome.CLEAN]]);
});
