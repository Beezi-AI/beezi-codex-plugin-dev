import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHome, linkAccount, TEST_KEY } from '../tools/account-fixtures.mjs';
import {
  getAccount, updateAccount, setWorkspaceRule, removeWorkspaceRule, setNewFolders,
  notePendingAttempt, settlePendingHistory, takeHistoryResults, recordOffer, acceptOffer, AcceptRefusal,
} from '../lib/accounts.mjs';
import { pendingHistoryOf, RunOutcome, SettleState } from '../lib/pending-history.mjs';
import { OfferState, offerToken } from '../lib/history-offer.mjs';
import { parseAnonymization } from '../lib/anonymization.mjs';
import { KINDS } from '../lib/anonymize.mjs';

const TENANTS = [{ id: 't1', name: 'Acme' }, { id: 't2', name: 'NewCo' }];
const WEB = 'github.com/acme/web';
const SETTLED = { state: OfferState.SETTLED, changedAt: null, places: [], declinedIds: ['s9'] };
const setup = (t, over = {}) => linkAccount(makeHome(t), TEST_KEY, { tenants: TENANTS, linkedAt: '2026-10-01T00:00:00.000Z', ...over });
const pending = async () => pendingHistoryOf(await getAccount(TEST_KEY)).map((e) => [e.tenantId, e.sessionIds]);
const offers = async () => (await getAccount(TEST_KEY)).historyOffers;
// `kinds` are the record's shown kinds as CR2 reads them: all five for a record without valid ones.
const accept = (tenantId, ids, { kinds = KINDS, nowIso = new Date().toISOString() } = {}) => acceptOffer(TEST_KEY, tenantId, offerToken(ids, kinds), nowIso);
const accepted = (ids) => ({ ids, refused: null });
const NONE = { ids: [], refused: AcceptRefusal.NONE };
const CHANGED = { ids: [], refused: AcceptRefusal.CHANGED };
const hiding = (on) => parseAnonymization({ kinds: KINDS.reduce((out, kind) => ({ ...out, [kind]: on.indexOf(kind) !== -1 }), {}) }, 't1', null);

test('rule writes never owe history', async (t) => {
  setup(t);
  const { index } = await setWorkspaceRule(TEST_KEY, { kind: 'repo', match: WEB, tenantIds: ['t1'] });
  await setNewFolders(TEST_KEY, { mode: 'send', tenantIds: ['t2'] });
  await removeWorkspaceRule(TEST_KEY, index);
  assert.deepEqual(await pending(), []);
  assert.equal((await getAccount(TEST_KEY)).pendingHistory, undefined);
});

test('a rule add re-opens a settled offer for that rule\'s place only', async (t) => {
  setup(t, { historyOffers: { t2: SETTLED } });
  await setWorkspaceRule(TEST_KEY, { kind: 'repo', match: WEB, tenantIds: ['t2'] });
  await setWorkspaceRule(TEST_KEY, { kind: 'repo', match: WEB, tenantIds: ['t1', 't2'] });
  assert.deepEqual(await offers(), { t2: { ...SETTLED, state: OfferState.RESCAN, places: [{ kind: 'repo', match: WEB }] } });
});

test('New folders sending to a workspace it did not send to before re-opens its offer', async (t) => {
  setup(t, { historyOffers: { t2: SETTLED } });
  await setNewFolders(TEST_KEY, { mode: 'send', tenantIds: ['t2'] });
  assert.deepEqual((await offers()).t2, { ...SETTLED, state: OfferState.RESCAN, places: [{ kind: 'new-folders' }] });
});

test('removing a rule re-opens nothing', async (t) => {
  setup(t, {
    historyOffers: { t2: SETTLED },
    workspaceRules: [{ kind: 'repo', match: WEB, label: WEB, tenantIds: ['t2'], createdAt: '2026-10-01T00:00:00.000Z' }],
    newFolders: { mode: 'send', tenantIds: ['t2'] },
  });
  await removeWorkspaceRule(TEST_KEY, 1);
  assert.deepEqual(await offers(), { t2: SETTLED });
});

test('recordOffer keeps unlisted fields; a decline closes the re-opened places', async (t) => {
  setup(t);
  await recordOffer(TEST_KEY, 't1', { state: OfferState.RESCAN, scanAt: '2026-10-22T09:00:00.000Z', places: [{ kind: 'new-folders' }] });
  await recordOffer(TEST_KEY, 't1', { state: OfferState.READY, changedAt: null, offeredIds: ['s1'] });
  assert.deepEqual((await offers()).t1.places, [{ kind: 'new-folders' }]);
  const record = await recordOffer(TEST_KEY, 't1', { state: OfferState.DECLINED });
  assert.deepEqual(record, {
    state: OfferState.DECLINED, scanAt: '2026-10-22T09:00:00.000Z', places: [], changedAt: null, offeredIds: ['s1'],
  });
});

test('accepting a shown offer owes exactly its ids, and a later skip keeps the entry', async (t) => {
  setup(t);
  await recordOffer(TEST_KEY, 't1', { state: OfferState.DECLINED, changedAt: null, offeredIds: ['s1', 's2'], declinedIds: ['s2', 's3'] });
  assert.deepEqual(await accept('t1', ['s1', 's2']), accepted(['s1', 's2']));
  assert.deepEqual(await pending(), [['t1', ['s1', 's2']]]);
  const record = (await offers()).t1;
  assert.equal(record.state, OfferState.SETTLED);
  assert.deepEqual(record.declinedIds, ['s3']);
  assert.deepEqual(await accept('t1', ['s1', 's2']), CHANGED);
  await updateAccount(TEST_KEY, { anonymization: parseAnonymization(null, 't1', { choice: 'skip', changedAt: '2026-10-22T10:00:00.000Z' }) });
  assert.deepEqual(await pending(), [['t1', ['s1', 's2']]]);
});

test('acceptOffer accepts nothing without a shown offer', async (t) => {
  setup(t, { historyOffers: { t1: { state: OfferState.RESCAN, offeredIds: ['s1'] }, t2: { state: OfferState.DECLINED, offeredIds: [] } } });
  assert.deepEqual(await accept('t1', ['s1']), CHANGED);
  assert.deepEqual(await accept('t2', []), NONE);
  assert.deepEqual(await accept('GONE', ['s1']), NONE);
  assert.deepEqual(await pending(), []);
});

test('a missing or mismatched token writes nothing and settles nothing', async (t) => {
  const record = { state: OfferState.DECLINED, changedAt: null, offeredIds: ['s1', 's2'], declinedIds: ['s1', 's2'], shownKinds: [] };
  setup(t, { historyOffers: { t1: record } });
  for (const token of [null, undefined, '', offerToken(['s2', 's1'], []), offerToken(['s1'], []), offerToken(['s1', 's2'], ['hosts'])]) {
    assert.deepEqual(await acceptOffer(TEST_KEY, 't1', token, new Date().toISOString()), CHANGED, String(token));
  }
  assert.equal((await getAccount(TEST_KEY)).pendingHistory, undefined);
  assert.deepEqual((await offers()).t1, record);
});

test('an older portal (no tenants) accepts for the row\'s workspace', async (t) => {
  setup(t, { tenants: null, tenantId: 't1', historyOffers: { t1: { state: OfferState.DECLINED, changedAt: null, offeredIds: ['s1'], places: [] } } });
  assert.deepEqual(await accept('t1', ['s1']), accepted(['s1']));
  assert.deepEqual(await pending(), [['t1', ['s1']]]);
});

test('attempt, settle and take round-trip; a cleared run settles the offer', async (t) => {
  setup(t, { pendingHistory: [{ tenantId: 't2', sessionIds: ['s1'], requestedAt: new Date(Date.now() - 1000).toISOString(), attempts: 0 }] });
  const now = Date.now();
  await notePendingAttempt(TEST_KEY, ['t2'], new Date(now).toISOString());
  assert.equal((await getAccount(TEST_KEY)).pendingHistory[0].lastAttemptAt, new Date(now).toISOString());
  assert.equal(await settlePendingHistory(TEST_KEY, 't2', { outcome: RunOutcome.CLEAN, sent: 7, skipped: 0 }, { plannedAtMs: now + 1000, nowMs: now + 1000 }), SettleState.CLEARED);
  assert.deepEqual(await takeHistoryResults(TEST_KEY), [{ tenantId: 't2', status: 'sent', sent: 7, skipped: 0 }]);
  assert.deepEqual(await takeHistoryResults(TEST_KEY), []);
  assert.deepEqual(await offers(), { t2: { state: OfferState.SETTLED, changedAt: null, places: [] } });
});

test('a cleared run keeps an offer a rule re-opened meanwhile', async (t) => {
  setup(t);
  await recordOffer(TEST_KEY, 't2', { state: OfferState.DECLINED, changedAt: null, offeredIds: ['s1'] });
  await accept('t2', ['s1'], { nowIso: new Date(Date.now() - 1000).toISOString() });
  await setWorkspaceRule(TEST_KEY, { kind: 'repo', match: WEB, tenantIds: ['t2'] });
  const now = Date.now();
  assert.equal(await settlePendingHistory(TEST_KEY, 't2', { outcome: RunOutcome.CLEAN, sent: 1, skipped: 0 }, { plannedAtMs: now + 1000, nowMs: now + 1000 }), SettleState.CLEARED);
  const record = (await offers()).t2;
  assert.equal(record.state, OfferState.RESCAN);
  assert.deepEqual(record.places, [{ kind: 'repo', match: WEB }]);
});

test('M2: a cleared run keeps a question printed after the yes', async (t) => {
  setup(t);
  await recordOffer(TEST_KEY, 't2', { state: OfferState.DECLINED, changedAt: null, offeredIds: ['s1'], shownKinds: [] });
  await accept('t2', ['s1'], { kinds: [], nowIso: new Date(Date.now() - 1000).toISOString() });
  const asked = { state: OfferState.DECLINED, changedAt: null, offeredIds: ['s2'], shownKinds: [] };
  await recordOffer(TEST_KEY, 't2', asked);
  const now = Date.now();
  assert.equal(await settlePendingHistory(TEST_KEY, 't2', { outcome: RunOutcome.CLEAN, sent: 1, skipped: 0 }, { plannedAtMs: now + 1000, nowMs: now + 1000 }), SettleState.CLEARED);
  const record = (await offers()).t2;
  assert.equal(record.state, OfferState.DECLINED);
  assert.deepEqual(record.offeredIds, ['s2']);
  assert.deepEqual(await accept('t2', ['s2'], { kinds: [] }), accepted(['s2']));
});

test('a READY scan was never printed, so accepting it uploads nothing', async (t) => {
  setup(t, { historyOffers: { t1: { state: OfferState.READY, changedAt: null, offeredIds: ['s1', 's2'] } } });
  assert.deepEqual(await accept('t1', ['s1', 's2']), CHANGED);
  assert.deepEqual(await pending(), []);
  assert.equal((await offers()).t1.state, OfferState.READY);
});

test('a yes records the override and the kinds hidden at that moment on the pending entry', async (t) => {
  const tenants = [
    { id: 't1', name: 'Acme', anonymization: parseAnonymization({ kinds: { repos: true, branches: false, sessions: false, hosts: true, accounts: false } }, 't1', null) },
    { id: 't2', name: 'NewCo' },
  ];
  setup(t, { tenants, historyOffers: { t1: { state: OfferState.DECLINED, changedAt: null, offeredIds: ['s1'], override: true, shownKinds: [] } } });
  assert.deepEqual(await accept('t1', ['s1'], { kinds: [] }), accepted(['s1']));
  const [entry] = (await getAccount(TEST_KEY)).pendingHistory;
  assert.equal(entry.override, true);
  assert.deepEqual(entry.kinds, ['repos', 'hosts']);
});

test('a rule add re-opens a never-shown full offer in full, adding the folder rather than narrowing to it', async (t) => {
  for (const before of [
    { state: OfferState.READY, changedAt: null, offeredIds: ['s1', 's2'] },
    { state: OfferState.RESCAN, changedAt: null, places: [] },
    { scanAt: '2026-10-22T09:00:00.000Z' },
  ]) {
    await t.test(String(before.state), async (tt) => {
      setup(tt, { historyOffers: { t2: before } });
      await setWorkspaceRule(TEST_KEY, { kind: 'repo', match: WEB, tenantIds: ['t2'] });
      const record = (await offers()).t2;
      assert.equal(record.state, OfferState.RESCAN);
      assert.deepEqual(record.places, []);
    });
  }
});

test('a rule add narrows a declined offer to its place, and a second place adds to that scope', async (t) => {
  setup(t, { historyOffers: { t2: { state: OfferState.DECLINED, changedAt: null, places: [], declinedIds: ['s1'] } } });
  await setWorkspaceRule(TEST_KEY, { kind: 'repo', match: WEB, tenantIds: ['t2'] });
  await setNewFolders(TEST_KEY, { mode: 'send', tenantIds: ['t2'] });
  assert.deepEqual((await offers()).t2.places, [{ kind: 'repo', match: WEB }, { kind: 'new-folders' }]);
});


test('the kinds the question showed as hidden are kept although every kind is off at the yes', async (t) => {
  const tenants = [{ id: 't1', name: 'Acme', anonymization: hiding([]) }, { id: 't2', name: 'NewCo' }];
  setup(t, { tenants, historyOffers: { t1: { state: OfferState.DECLINED, changedAt: null, offeredIds: ['s1'], shownKinds: ['branches'] } } });
  assert.deepEqual(await accept('t1', ['s1'], { kinds: ['branches'] }), accepted(['s1']));
  assert.deepEqual((await getAccount(TEST_KEY)).pendingHistory[0].kinds, ['branches']);
});

test('the shown kinds and the kinds at the yes are unioned in KINDS order', async (t) => {
  const tenants = [{ id: 't1', name: 'Acme', anonymization: hiding(['hosts', 'repos']) }, { id: 't2', name: 'NewCo' }];
  setup(t, { tenants, historyOffers: { t1: { state: OfferState.DECLINED, changedAt: null, offeredIds: ['s1'], shownKinds: ['accounts', 'branches'] } } });
  await accept('t1', ['s1'], { kinds: ['accounts', 'branches'] });
  assert.deepEqual((await getAccount(TEST_KEY)).pendingHistory[0].kinds, ['repos', 'branches', 'hosts', 'accounts']);
});

test('a record without valid shown kinds counts as all five hidden (CR2)', async (t) => {
  for (const shown of [{}, { shownKinds: null }, { shownKinds: 'branches' }, { shownKinds: ['branches', 'bogus'] }]) {
    await t.test(JSON.stringify(shown), async (tt) => {
      const tenants = [{ id: 't1', name: 'Acme', anonymization: hiding([]) }, { id: 't2', name: 'NewCo' }];
      setup(tt, { tenants, historyOffers: { t1: { state: OfferState.DECLINED, changedAt: null, offeredIds: ['s1'], ...shown } } });
      assert.deepEqual(await accept('t1', ['s1'], { kinds: [] }), CHANGED);
      assert.deepEqual(await accept('t1', ['s1']), accepted(['s1']));
      assert.deepEqual((await getAccount(TEST_KEY)).pendingHistory[0].kinds, ['repos', 'branches', 'sessions', 'hosts', 'accounts']);
    });
  }
});

test('widening a rule re-opens only the workspaces it gained', async (t) => {
  const API = 'github.com/acme/api';
  setup(t, {
    workspaceRules: [{ kind: 'repo', match: API, label: API, tenantIds: ['t1'], createdAt: '2026-10-01T00:00:00.000Z' }],
    historyOffers: { t1: SETTLED, t2: SETTLED },
  });
  await setWorkspaceRule(TEST_KEY, { kind: 'repo', match: API, tenantIds: ['t1', 't2'] });
  const record = await offers();
  assert.equal(record.t1.state, OfferState.SETTLED);
  assert.deepEqual(record.t1.places, []);
  assert.equal(record.t2.state, OfferState.RESCAN);
  assert.deepEqual(record.t2.places, [{ kind: 'repo', match: API }]);
});

test('any offer write drops pending entries without accepted ids', async (t) => {
  setup(t, { pendingHistory: [{ tenantId: 't1', requestedAt: '2026-10-01T00:00:00Z', attempts: 0 }] });
  await recordOffer(TEST_KEY, 't1', { scanAt: '2026-10-22T09:00:00.000Z' });
  assert.deepEqual((await getAccount(TEST_KEY)).pendingHistory, []);
});

test('recordOffer with a function decides on the fresh record and row; null writes nothing', async (t) => {
  setup(t, { historyOffers: { t1: { state: OfferState.DECLINED, changedAt: null, offeredIds: ['s1'] } } });
  const seen = [];
  assert.equal(await recordOffer(TEST_KEY, 't1', (record, row) => { seen.push([record.state, row.key]); return null; }), null);
  assert.deepEqual(seen, [[OfferState.DECLINED, TEST_KEY]]);
  assert.deepEqual((await offers()).t1, { state: OfferState.DECLINED, changedAt: null, offeredIds: ['s1'] });
  const record = await recordOffer(TEST_KEY, 't2', (fresh) => (fresh == null ? { state: OfferState.RESCAN } : null));
  assert.deepEqual(record, { state: OfferState.RESCAN });
});
