import test from 'node:test';
import assert from 'node:assert/strict';
import {
  maybeStartPendingHistory, startOfferScans, scanRows, takeDeferFlag, offerChecksOf, offerChecksByRow, HISTORY_WORKER_SCRIPT,
} from '../lib/history-trigger.mjs';
import { OfferCheck, OfferState } from '../lib/history-offer.mjs';
import { buildHistoryOffer, usableRows } from '../lib/workspace-prompt.mjs';
import { listAccounts, recordOffer } from '../lib/accounts.mjs';
import { makeHome, linkAccount } from '../tools/account-fixtures.mjs';

const T0 = Date.parse('2026-10-13T10:00:00.000Z');
const row = (key, pending) => ({ key, status: 'linked', tenants: [{ id: 'A' }, { id: 'B' }], pendingHistory: pending });
const spawnLog = () => {
  const calls = [];
  return { calls, spawnImpl: (exe, args) => { calls.push(args); return { unref() {} }; } };
};

test('maybeStartPendingHistory spawns only due accounts', async () => {
  const s = spawnLog();
  const fresh = new Date(T0 - 60 * 1000).toISOString();
  const listAccounts = async () => [
    row('due', [{ tenantId: 'B', sessionIds: ['s1'], requestedAt: fresh, lastAttemptAt: null }]),
    row('recent', [{ tenantId: 'B', sessionIds: ['s1'], requestedAt: fresh, lastAttemptAt: fresh }]),
  ];
  assert.equal(await maybeStartPendingHistory({ listAccounts, spawnImpl: s.spawnImpl, now: () => T0 }), 1);
  assert.deepEqual(s.calls, [[HISTORY_WORKER_SCRIPT, '--account', 'due']]);
});

test('a throwing account list never escapes', async () => {
  const listAccounts = async () => { throw new Error('index locked'); };
  assert.equal(await maybeStartPendingHistory({ listAccounts }), 0);
});

test('takeDeferFlag strips the flag wherever it sits', () => {
  assert.deepEqual(takeDeferFlag(['rule', 'add', '--defer-upload', '--repo', 'x']), { deferUpload: true, argv: ['rule', 'add', '--repo', 'x'] });
  assert.deepEqual(takeDeferFlag(['joined']), { deferUpload: false, argv: ['joined'] });
});

const KEY_A = 'aaaa1111';
const KEY_B = 'bbbb2222';
const offerBlock = (tenantId, choice) => ({
  tenantId,
  kinds: { repos: true, branches: true, sessions: true, hosts: true, accounts: true },
  pastSessions: { choice, changedAt: '2026-10-01T00:00:00.000Z' },
});
const twoWorkspaces = (choice) => ({
  tenants: [{ id: 't1', name: 'Acme', anonymization: offerBlock('t1', choice) }, { id: 't2', name: 'Beta', anonymization: offerBlock('t2', choice) }],
});
// The hook's only allowed reads are the index and tracking files; any scan or network seam fails the test.
function budgetDeps(s, thrown) {
  const fail = (name) => () => { thrown.push(name); throw new Error(`${name} must not run at session start`); };
  return {
    spawnImpl: s.spawnImpl,
    listAllRollouts: fail('listAllRollouts'),
    fetchCoverage: fail('fetchCoverage'),
    fetchImpl: fail('fetchImpl'),
    linkedSessions: async () => [{ key: KEY_A }, { key: KEY_B }],
    now: () => T0,
  };
}

test('session start stays within the hook budget: no scan, no coverage, one stamped spawn per account', async (t) => {
  const home = makeHome(t);
  linkAccount(home, KEY_A, twoWorkspaces('offer'));
  linkAccount(home, KEY_B, twoWorkspaces('offer'));
  const s = spawnLog();
  const thrown = [];
  const deps = budgetDeps(s, thrown);
  assert.equal(await buildHistoryOffer({ source: 'startup' }, deps), null);
  assert.equal(await startOfferScans(await usableRows(deps), deps), 2);
  assert.deepEqual(s.calls, [
    [HISTORY_WORKER_SCRIPT, '--offer', '--account', KEY_A],
    [HISTORY_WORKER_SCRIPT, '--offer', '--account', KEY_B],
  ]);
  const stamp = new Date(T0).toISOString();
  for (const row of await listAccounts()) {
    assert.deepEqual(Object.keys(row.historyOffers).sort(), ['t1', 't2']);
    for (const record of Object.values(row.historyOffers)) assert.equal(record.scanAt, stamp);
  }
  assert.equal(await startOfferScans(await usableRows(deps), deps), 0);
  assert.equal(s.calls.length, 2);
  assert.deepEqual(thrown, []);
});

test('startOfferScans spawns nothing under skip', async (t) => {
  const home = makeHome(t);
  linkAccount(home, KEY_A, twoWorkspaces('skip'));
  const s = spawnLog();
  const deps = budgetDeps(s, []);
  assert.equal(await startOfferScans(await usableRows(deps), deps), 0);
  assert.deepEqual(s.calls, []);
  assert.equal((await listAccounts())[0].historyOffers, undefined);
});

test('startOfferScans never throws', async () => {
  const recordOffers = async () => { throw new Error('index locked'); };
  const rows = [{ key: KEY_A, status: 'linked', ...twoWorkspaces('offer') }];
  assert.equal(await startOfferScans(rows, { recordOffers, spawnImpl: spawnLog().spawnImpl, now: () => T0 }), 0);
});

test('an account whose pending history is due gets no offer scan this start', async (t) => {
  const home = makeHome(t);
  const due = [{ tenantId: 't1', sessionIds: ['s1'], requestedAt: new Date(T0 - 60 * 1000).toISOString(), lastAttemptAt: null }];
  linkAccount(home, KEY_A, { ...twoWorkspaces('offer'), pendingHistory: due });
  const s = spawnLog();
  const deps = budgetDeps(s, []);
  assert.equal(await startOfferScans(await usableRows(deps), deps), 0);
  assert.deepEqual(s.calls, []);
  assert.equal((await listAccounts())[0].historyOffers, undefined);
});

test('offerChecksOf reads tracking once for a one-workspace account, with the hook\'s deps, and never under skip', () => {
  const reads = [];
  const deps = { readTrackingStateImpl: (key, d) => { reads.push([key, d === deps]); return { trackingMode: 'disabled' }; } };
  const one = (choice) => ({ key: KEY_A, status: 'linked', tenants: [{ id: 't1', anonymization: offerBlock('t1', choice) }] });
  assert.deepEqual(offerChecksOf(one('offer'), T0, deps), [{ tenantId: 't1', check: OfferCheck.TRACKING_OFF }]);
  assert.deepEqual(offerChecksOf(one('skip'), T0, deps), [{ tenantId: 't1', check: OfferCheck.SKIP_CHOICE }]);
  assert.deepEqual(offerChecksOf({ key: KEY_A, status: 'linked', ...twoWorkspaces('offer') }, T0, deps).map((c) => c.check), [OfferCheck.SCAN, OfferCheck.SCAN]);
  assert.deepEqual(reads, [[KEY_A, true]]);
});

test('an offer shown to one account this start starts no scan worker for any account; they scan at the next start (M-1, M3)', async (t) => {
  const home = makeHome(t);
  const ready = { state: OfferState.READY, changedAt: '2026-10-01T00:00:00.000Z', offeredIds: ['s1'] };
  linkAccount(home, KEY_A, { ...twoWorkspaces('offer'), historyOffers: { t1: ready } });
  linkAccount(home, KEY_B, { ...twoWorkspaces('offer'), historyOffers: { t1: { state: OfferState.SETTLED, changedAt: '2026-10-01T00:00:00.000Z' } } });
  const s = spawnLog();
  const deps = budgetDeps(s, []);
  const offer = await buildHistoryOffer({ source: 'startup' }, deps);
  assert.deepEqual(offer.keys, [KEY_A]);
  const rows = await usableRows(deps);
  assert.deepEqual(scanRows(rows, offer.keys), []);
  assert.equal(await startOfferScans(scanRows(rows, offer.keys), deps), 0);
  assert.deepEqual(s.calls, []);
  assert.deepEqual((await listAccounts()).find((a) => a.key === KEY_A).historyOffers, { t1: ready });
  assert.equal((await listAccounts()).find((a) => a.key === KEY_B).historyOffers.t2, undefined);

  await recordOffer(KEY_A, 't1', { state: OfferState.DECLINED });
  assert.equal(await buildHistoryOffer({ source: 'startup' }, deps), null);
  assert.equal(scanRows(rows, []), rows);
  assert.equal(await startOfferScans(scanRows(await usableRows(deps), []), deps), 2);
  assert.deepEqual(s.calls, [[HISTORY_WORKER_SCRIPT, '--offer', '--account', KEY_A], [HISTORY_WORKER_SCRIPT, '--offer', '--account', KEY_B]]);
  const offers = (await listAccounts()).find((a) => a.key === KEY_A).historyOffers;
  assert.equal(offers.t2.scanAt, new Date(T0).toISOString());
  assert.equal(offers.t1.scanAt, undefined);
});

test('one start evaluates each row\'s checks once and stamps an account\'s scans in one write (C-8)', async (t) => {
  const home = makeHome(t);
  linkAccount(home, KEY_A, { tenants: [{ id: 't1', anonymization: offerBlock('t1', 'offer') }] });
  linkAccount(home, KEY_B, twoWorkspaces('offer'));
  const s = spawnLog();
  const reads = [];
  const writes = [];
  const deps = {
    ...budgetDeps(s, []),
    readTrackingStateImpl: (key) => { reads.push(key); return null; },
    recordOffers: async (key, tenantIds, patch) => { writes.push([key, tenantIds, patch]); },
  };
  const rows = await usableRows(deps);
  const checks = offerChecksByRow(rows, T0, deps);
  assert.equal(await buildHistoryOffer({ source: 'startup' }, deps, { checks }), null);
  assert.equal(await startOfferScans(rows, deps, { checks }), 2);
  const scanAt = new Date(T0).toISOString();
  assert.deepEqual(writes, [[KEY_A, ['t1'], { scanAt }], [KEY_B, ['t1', 't2'], { scanAt }]]);
  assert.deepEqual(reads, [KEY_A]);
});
