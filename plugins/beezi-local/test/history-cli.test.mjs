import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHome, linkAccount, accountSession, TEST_KEY } from '../tools/account-fixtures.mjs';
import {
  offerCommand, acceptCommand, declineCommand, scanOffers, WRITER_BUSY_LINE, NO_NEW_LINE, ACCEPT_BUSY_LINE,
} from '../lib/history-cli.mjs';
import { startOfferScans } from '../lib/history-trigger.mjs';
import { HISTORY_RETRY_MS } from '../lib/pending-history.mjs';
import { getAccount, recordOffer, setWorkspaceRule, listAccounts, updateAccount } from '../lib/accounts.mjs';
import { OfferState, declineLine, offerToken, CHANGED_LINE } from '../lib/history-offer.mjs';
import { runAudit as realRunAudit } from '../lib/session-audit.mjs';
import { flushBackfillChunks } from '../lib/audit-flush.mjs';
import { HISTORY_WORKER_SCRIPT } from '../lib/history-trigger.mjs';
import { naming } from '../lib/paths.mjs';
import { KINDS } from '../lib/anonymize.mjs';

const T0 = Date.parse('2026-10-22T10:00:00.000Z');
const C = '2026-10-01T00:00:00.000Z';
const WEB = 'github.com/acme/web';
const OFFER = { choice: 'offer', changedAt: C };
const SKIP = { choice: 'skip', changedAt: C };
const day = (m, d) => new Date(2026, m, d, 12).getTime();

const block = (tenantId, on, pastSessions = OFFER) => ({
  tenantId,
  kinds: KINDS.reduce((out, kind) => ({ ...out, [kind]: on.indexOf(kind) !== -1 }), {}),
  key: 'a'.repeat(64),
  machineName: null,
  pastSessions,
});
const tenant = (id, name, on = [], past = OFFER) => ({ id, name, anonymization: block(id, on, past) });
const session = (sessionId, cwd = '/work/web') => ({ sessionId, startedMs: day(7, 12), mtimeMs: day(9, 21), cwd });
const listed = (sessions, over = {}) => ({
  ok: true, reason: null, halt: null, scanned: 5, tooOld: 0, coverageKnown: true, trackingMode: 'live', listed: sessions, ...over,
});
const offers = async () => (await getAccount(TEST_KEY)).historyOffers;
const pendingIds = async () => (await getAccount(TEST_KEY)).pendingHistory.map((e) => [e.tenantId, e.sessionIds]);
const offerLine = (tenant, ids, audit = 'no', kinds = []) => `offer account=${TEST_KEY} tenant=${tenant} sessions=${ids.length} audit=${audit} token=${offerToken(ids, kinds)}`;
const inBackground = (spawns) => ({ spawnImpl: (cmd, args) => { spawns.push(args); return { unref() {} }; } });

function one(t, { past = OFFER, on = [], historyOffers } = {}) {
  linkAccount(makeHome(t), TEST_KEY, { tenantId: 't1', tenants: [tenant('t1', 'Acme', on, past)], historyOffers });
}

function two(t, historyOffers, t1On = [], t2On = []) {
  linkAccount(makeHome(t), TEST_KEY, { tenantId: 't1', tenants: [tenant('t1', 'Acme', t1On), tenant('t2', 'Beta', t2On)], historyOffers });
}

const plan = (routes = new Map(), tenantIds = ['t1', 't2']) => ({
  scanned: 3, routes, counts: { rule: 0, 'new-folders': 0, none: 0, pending: 0 }, tenantIds,
});

// runAudit answers per workspace id (null for a one-workspace run).
function deps(results, over = {}) {
  const audits = [];
  return {
    audits,
    deps: {
      now: () => T0,
      readTrackingState: () => null,
      planWorkspaceRuns: () => plan(),
      runAudit: async (d, options) => {
        audits.push(options);
        const result = results[orNull(options.tenantId)];
        return typeof result === 'function' ? result(d, options) : result;
      },
      ...over,
    },
  };
}

const orNull = (value) => (value == null ? 'null' : value);

function capture(t) {
  const out = [];
  const err = [];
  t.mock.method(console, 'log', (...args) => { out.push(args.join(' ')); });
  t.mock.method(console, 'error', (...args) => { err.push(args.join(' ')); });
  return { out, err };
}

// ── offer ──────────────────────────────────────────────────────────────────────────────────

test('offer --past under skip lists nothing, asks nothing and ends offers=0', async (t) => {
  one(t, { past: SKIP });
  const io = capture(t);
  const h = deps({ null: listed([session('s1')]) });
  const done = await offerCommand({ key: TEST_KEY, past: true }, h.deps);
  assert.equal(h.audits.length, 0);
  assert.ok(!io.out.some((line) => line.startsWith('offer ')));
  assert.equal(io.out[io.out.length - 1], 'offers=0');
  assert.deepEqual(done, { offers: 0, status: 0 });
});

test('the sync offer (no --past) still lists and asks under skip', async (t) => {
  one(t, { past: SKIP });
  const io = capture(t);
  const h = deps({ null: listed([session('s1'), session('s2', '/work/api')]) });
  const done = await offerCommand({ key: TEST_KEY }, h.deps);
  assert.equal(h.audits.length, 1);
  assert.equal(h.audits[0].listOnly, true);
  assert.equal(h.audits[0].scope, 'all');
  assert.equal('mode' in h.audits[0], false);
  assert.equal(h.audits[0].tenantId, null);
  assert.deepEqual(io.out.slice(-3), [
    'Q Upload these 2 sessions to Acme?',
    offerLine('t1', ['s1', 's2']),
    'offers=1',
  ]);
  assert.equal(io.out[0], 'Beezi found 2 past Codex sessions from 12 Aug to 21 Oct in 2 folders: web and api.');
  assert.equal(done.offers, 1);
});

test('printing the question records the decline with the shown ids and the current changedAt', async (t) => {
  one(t, { historyOffers: { t1: { state: OfferState.READY, changedAt: C, offeredIds: ['s1'] } } });
  capture(t);
  const h = deps({ null: listed([session('s1'), session('s2')]) });
  await offerCommand({ key: TEST_KEY, past: true }, h.deps);
  assert.equal(h.audits[0].scope, 'past');
  const record = (await offers()).t1;
  assert.equal(record.state, OfferState.DECLINED);
  assert.deepEqual(record.offeredIds, ['s1', 's2']);
  assert.deepEqual(record.declinedIds, ['s1', 's2']);
  assert.equal(record.changedAt, C);
  assert.deepEqual(record.places, []);
  assert.deepEqual(record.summary, { n: 2, firstMs: day(7, 12), lastMs: day(9, 21), folders: ['web'], audit: false });
  assert.deepEqual(record.shownKinds, []);
});

test('--dry-run prints the summary without its question and records nothing', async (t) => {
  one(t);
  const io = capture(t);
  const done = await offerCommand({ key: TEST_KEY, dryRun: true }, deps({ null: listed([session('s1')]) }).deps);
  assert.ok(io.out[0].startsWith('Beezi found 1 past Codex session'));
  assert.ok(!io.out.some((line) => line.startsWith('Q ') || line.startsWith('offer ')));
  assert.equal(io.out[io.out.length - 1], 'offers=0');
  assert.equal(done.offers, 0);
  assert.equal(await offers(), undefined);
});

test('a settled workspace is not asked again; a ready one is', async (t) => {
  two(t, {
    t1: { state: OfferState.READY, changedAt: C, offeredIds: ['s1'] },
    t2: { state: OfferState.SETTLED, changedAt: C, places: [] },
  });
  const io = capture(t);
  const h = deps({ t1: listed([session('s1')]), t2: listed([session('s2')]) });
  await offerCommand({ key: TEST_KEY, past: true }, h.deps);
  assert.deepEqual(h.audits.map((o) => o.tenantId), ['t1']);
  assert.deepEqual(io.out.filter((line) => line.startsWith('offer ')), [offerLine('t1', ['s1'])]);
  assert.equal((await offers()).t2.state, OfferState.SETTLED);
  assert.equal((await offers()).t1.state, OfferState.DECLINED);
});

test('a re-opened place lists only the sessions routed by it', async (t) => {
  const routes = new Map([
    ['s1', { tenantIds: ['t1'], source: 'rule', key: { kind: 'repo', match: WEB } }],
    ['s2', { tenantIds: ['t1'], source: 'rule', key: { kind: 'repo', match: 'github.com/acme/api' } }],
    ['s3', { tenantIds: ['t1'], source: 'new-folders', key: null }],
  ]);
  for (const [places, expected] of [[[{ kind: 'repo', match: WEB }], ['s1']], [[{ kind: 'new-folders' }], ['s3']]]) {
    await t.test(places[0].kind, async (tt) => {
      two(tt, { t1: { state: OfferState.RESCAN, changedAt: C, places, declinedIds: ['s0'] } });
      capture(tt);
      const h = deps({ t1: listed([session(expected[0])]) }, { planWorkspaceRuns: () => plan(routes, ['t1']) });
      await offerCommand({ key: TEST_KEY, past: true }, h.deps);
      assert.equal(h.audits.length, 1);
      assert.deepEqual(h.audits[0].onlySessionIds, expected);
      assert.deepEqual(h.audits[0].declinedSessionIds, ['s0']);
      assert.equal(h.audits[0].sessionRoutes, routes);
    });
  }
});

test('a one-workspace account\'s re-opened folder lists only that folder\'s sessions', async (t) => {
  linkAccount(makeHome(t), TEST_KEY, {
    tenantId: 't1',
    tenants: [tenant('t1', 'Acme')],
    workspaceRules: [{ kind: 'folder', match: '/work/web', label: 'web', tenantIds: ['t1'], createdAt: C }],
    historyOffers: { t1: { state: OfferState.RESCAN, changedAt: C, places: [{ kind: 'folder', match: '/work/web' }] } },
  });
  const io = capture(t);
  const h = deps({ null: listed([session('s1'), session('s2'), session('s3', '/work/api')]) });
  await offerCommand({ key: TEST_KEY, past: true }, h.deps);
  assert.equal(h.audits[0].onlySessionIds, undefined);
  assert.ok(io.out.includes(offerLine('t1', ['s1', 's2'])));
  assert.deepEqual((await offers()).t1.offeredIds, ['s1', 's2']);
});

test('a later changedAt re-opens the whole offer: declines and places are cleared first', async (t) => {
  one(t, { historyOffers: { t1: { state: OfferState.DECLINED, changedAt: '2026-09-01T00:00:00.000Z', declinedIds: ['s0'], places: [] } } });
  capture(t);
  const h = deps({ null: listed([session('s1')]) });
  await offerCommand({ key: TEST_KEY, past: true }, h.deps);
  assert.equal(h.audits[0].declinedSessionIds, undefined);
  assert.equal(h.audits[0].onlySessionIds, undefined);
  const record = (await offers()).t1;
  assert.deepEqual(record.declinedIds, ['s1']);
  assert.equal(record.changedAt, C);
});

test('two workspaces get one block each, with their own hidden line', async (t) => {
  two(t, undefined, ['repos'], ['hosts']);
  const io = capture(t);
  await offerCommand({ key: TEST_KEY }, deps({ t1: listed([session('s1')]), t2: listed([session('s2'), session('s3')]) }).deps);
  const qs = io.out.map((line, i) => (line.startsWith('Q ') ? i : -1)).filter((i) => i !== -1);
  assert.equal(qs.length, 2);
  const firstL4 = io.out.indexOf('Hidden by your workspace: folder and repository names. Beezi receives made-up names instead.');
  const secondL4 = io.out.indexOf('Hidden by your workspace: computer name. Beezi receives made-up names instead.');
  assert.ok(firstL4 !== -1 && firstL4 < qs[0]);
  assert.ok(secondL4 > qs[0] && secondL4 < qs[1]);
  assert.equal(io.out[qs[1]], 'Q Upload these 2 sessions to Beta?');
  assert.equal(io.out[io.out.length - 1], 'offers=2');
});

test('zero listed with --past settles the workspace and says everything is uploaded', async (t) => {
  one(t);
  const io = capture(t);
  await offerCommand({ key: TEST_KEY, past: true }, deps({ null: listed([]) }).deps);
  assert.deepEqual(io.out, ['✓ Beezi: everything is already uploaded.', 'offers=0']);
  assert.equal((await offers()).t1.state, OfferState.SETTLED);
});

test('a busy run or unknown coverage records nothing', async (t) => {
  for (const result of [listed(null, { reason: 'run-in-progress' }), listed([], { coverageKnown: false })]) {
    await t.test(String(result.reason), async (tt) => {
      one(tt);
      const io = capture(tt);
      await offerCommand({ key: TEST_KEY, past: true }, deps({ null: result }).deps);
      assert.equal(io.out[io.out.length - 1], 'offers=0');
      assert.equal(await offers(), undefined);
    });
  }
});

// ── accept and decline ─────────────────────────────────────────────────────────────────────

test('accept owes exactly the shown ids and uploads only that workspace, with progress', async (t) => {
  one(t);
  const io = capture(t);
  const progress = [];
  const h = deps({ null: listed([session('s1'), session('s2')]) });
  await offerCommand({ key: TEST_KEY }, h.deps);
  const calls = [];
  const runPendingHistory = async (key, d, options) => {
    calls.push({ key, options });
    await d.runAudit({ runCache: 'c' }, { key });
    options.onResult({ tenantId: 't1' }, { ok: true, scanned: 2, sessionsImported: 2, reportsStored: 2, deferred: 0 });
    return [];
  };
  const runAudit = async (d) => { progress.push(typeof d.onProgress); d.onProgress({ processed: 1, total: 2 }); return null; };
  const code = await acceptCommand({ key: TEST_KEY, tenantId: 't1', token: offerToken(['s1', 's2'], []) }, { ...h.deps, runAudit, runPendingHistory });
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options.tenantIds, ['t1']);
  const row = await getAccount(TEST_KEY);
  assert.deepEqual(row.pendingHistory.map((e) => [e.tenantId, e.sessionIds]), [['t1', ['s1', 's2']]]);
  assert.equal(row.historyOffers.t1.state, OfferState.SETTLED);
  assert.deepEqual(progress, ['function']);
  assert.ok(io.out.includes('Beezi: 1/2 sessions read…'));
  assert.ok(io.out.includes('✓ Beezi: uploaded 2 sessions (2 reports stored).'));
});

test('accept --background hands the upload to the history worker', async (t) => {
  one(t);
  const io = capture(t);
  const spawns = [];
  const spawnImpl = (cmd, args) => { spawns.push(args); return { unref() {} }; };
  await offerCommand({ key: TEST_KEY }, deps({ null: listed([session('s1'), session('s2')]) }).deps);
  const code = await acceptCommand({ key: TEST_KEY, tenantId: 't1', token: offerToken(['s1', 's2'], []), background: true }, {
    spawnImpl, runPendingHistory: async () => { throw new Error('must not upload here'); },
  });
  assert.equal(code, 0);
  assert.deepEqual(spawns, [[HISTORY_WORKER_SCRIPT, '--account', TEST_KEY]]);
  assert.equal(io.out[io.out.length - 1], '✓ Beezi: uploading 2 past sessions to Acme in the background.');
});

test('accept with nothing offered exits 1 and says how to see what would be sent', async (t) => {
  one(t);
  const io = capture(t);
  const code = await acceptCommand({ key: TEST_KEY, tenantId: 't1' }, { runPendingHistory: async () => { throw new Error('nothing to run'); } });
  assert.equal(code, 1);
  assert.deepEqual(io.out, [`Beezi: nothing is waiting to upload. Run \`${naming.syncCommand()}\` to see what would be sent.`]);
  assert.equal((await getAccount(TEST_KEY)).pendingHistory, undefined);
});

test('decline on an Audit workspace prints the DA line and keeps the shown ids declined', async (t) => {
  one(t);
  const io = capture(t);
  await offerCommand({ key: TEST_KEY }, deps({ null: listed([session('s1')], { trackingMode: 'backfill_only' }) }).deps);
  assert.equal(io.out[io.out.length - 2], offerLine('t1', ['s1'], 'yes'));
  assert.equal(await declineCommand({ key: TEST_KEY, tenantId: 't1' }), 0);
  assert.equal(io.out[io.out.length - 1], declineLine(true));
  assert.ok(io.out[io.out.length - 1].startsWith('Your audit reads only past sessions'));
  const record = (await offers()).t1;
  assert.equal(record.state, OfferState.DECLINED);
  assert.deepEqual(record.declinedIds, ['s1']);
});

// ── the scan worker ────────────────────────────────────────────────────────────────────────

test('scanOffers settles a workspace with nothing to offer under the current changedAt', async (t) => {
  one(t);
  const h = deps({ null: listed([]) });
  assert.equal(await scanOffers(TEST_KEY, h.deps), 0);
  assert.equal(h.audits[0].scope, 'past');
  assert.equal(h.audits[0].listOnly, true);
  const record = (await offers()).t1;
  assert.equal(record.state, OfferState.SETTLED);
  assert.equal(record.changedAt, C);
  assert.equal(record.scanAt, new Date(T0).toISOString());
});

test('scanOffers records READY with the listed ids and no summary', async (t) => {
  one(t);
  assert.equal(await scanOffers(TEST_KEY, deps({ null: listed([session('s1')]) }).deps), 1);
  const record = (await offers()).t1;
  assert.equal(record.state, OfferState.READY);
  assert.deepEqual(record.offeredIds, ['s1']);
  assert.equal(record.summary, undefined);
});

test('scanOffers leaves a busy workspace\'s record as it was, apart from scanAt', async (t) => {
  const before = { state: OfferState.RESCAN, changedAt: C, places: [{ kind: 'new-folders' }], declinedIds: ['s0'] };
  one(t, { historyOffers: { t1: before } });
  await scanOffers(TEST_KEY, deps({ null: listed(null, { reason: 'run-in-progress' }) }).deps);
  assert.deepEqual((await offers()).t1, { ...before, scanAt: new Date(T0).toISOString() });
});

test('scanOffers skips a workspace that is settled or declined', async (t) => {
  one(t);
  await recordOffer(TEST_KEY, 't1', { state: OfferState.DECLINED, changedAt: C });
  const h = deps({ null: listed([session('s1')]) });
  assert.equal(await scanOffers(TEST_KEY, h.deps), 0);
  assert.equal(h.audits.length, 0);
});

// ── final review fixes ─────────────────────────────────────────────────────────────────────

test('a --tenant offer is replayed at accept: exactly the shown ids go to that workspace, unrouted', async (t) => {
  two(t);
  capture(t);
  const uploaded = { ok: true, scanned: 2, sessionsImported: 2, reportsStored: 2, deferred: 0 };
  const h = deps(
    { t2: (d, o) => (o.listOnly ? listed([session('s1'), session('s2')]) : uploaded) },
    { planWorkspaceRuns: () => plan(new Map(), ['t1']) },
  );
  await offerCommand({ key: TEST_KEY, tenantIds: ['t2'] }, h.deps);
  assert.equal((await offers()).t2.override, true);
  assert.equal(await acceptCommand({ key: TEST_KEY, tenantId: 't2', token: offerToken(['s1', 's2'], []) }, h.deps), 0);
  const upload = h.audits[h.audits.length - 1];
  assert.equal(upload.listOnly, undefined);
  assert.equal(upload.tenantId, 't2');
  assert.deepEqual(upload.onlySessionIds, ['s1', 's2']);
  assert.equal(upload.sessionRoutes, undefined);
});

test('a routed offer printed after a --tenant one clears the override', async (t) => {
  two(t, { t1: { state: OfferState.DECLINED, changedAt: C, offeredIds: ['s0'], override: true } });
  capture(t);
  await offerCommand({ key: TEST_KEY }, deps({ t1: listed([session('s1')]), t2: listed([]) }).deps);
  assert.equal((await offers()).t1.override, false);
});

test('an accept that no run picks up says nothing was uploaded and exits 1', async (t) => {
  two(t, { t2: { state: OfferState.DECLINED, changedAt: C, offeredIds: ['s1'] } });
  const io = capture(t);
  const h = deps({}, { planWorkspaceRuns: () => plan(new Map(), ['t1']) });
  assert.equal(await acceptCommand({ key: TEST_KEY, tenantId: 't2', token: offerToken(['s1'], KINDS) }, h.deps), 1);
  assert.equal(h.audits.length, 0);
  assert.match(io.err[io.err.length - 1], /^✗ Beezi: nothing was uploaded — no rule or New folders setting sends these sessions to Beta now\./);
});

test('"Not now" with no question open writes and prints nothing', async (t) => {
  const cases = [
    ['a scan never printed', { state: OfferState.READY, changedAt: C, offeredIds: ['s1'], declinedIds: ['s0'] }],
    ['a question with no ids', { state: OfferState.DECLINED, changedAt: C, offeredIds: [], declinedIds: ['s0'] }],
    ['no record', undefined],
  ];
  for (const [name, record] of cases) {
    await t.test(name, async (tt) => {
      one(tt, { historyOffers: record == null ? undefined : { t1: record } });
      const io = capture(tt);
      assert.equal(await declineCommand({ key: TEST_KEY, tenantId: 't1' }), 0);
      assert.deepEqual(io.out, []);
      assert.deepEqual(await offers(), record == null ? undefined : { t1: record });
    });
  }
});

test('"Not now" to an open question prints the D line and keeps its ids declined', async (t) => {
  one(t, { historyOffers: { t1: { state: OfferState.DECLINED, changedAt: C, offeredIds: ['s1'] } } });
  const io = capture(t);
  assert.equal(await declineCommand({ key: TEST_KEY, tenantId: 't1' }), 0);
  assert.deepEqual(io.out, [declineLine(false)]);
  const record = (await offers()).t1;
  assert.equal(record.state, OfferState.DECLINED);
  assert.deepEqual(record.declinedIds, ['s1']);
});

test('a yes uploads exactly its own question\'s ids: a second print in another terminal refuses the first token', async (t) => {
  one(t);
  const io = capture(t);
  await offerCommand({ key: TEST_KEY }, deps({ null: listed([session('s1'), session('s2')]) }).deps);
  await offerCommand({ key: TEST_KEY }, deps({ null: listed([session('s3')]) }).deps);
  const spawns = [];
  assert.equal(await acceptCommand({ key: TEST_KEY, tenantId: 't1', token: offerToken(['s1', 's2'], []), background: true }, inBackground(spawns)), 1);
  assert.equal(io.err[io.err.length - 1], CHANGED_LINE);
  assert.deepEqual(spawns, []);
  assert.equal((await getAccount(TEST_KEY)).pendingHistory, undefined);
  const record = (await offers()).t1;
  assert.equal(record.state, OfferState.DECLINED);
  assert.deepEqual(record.offeredIds, ['s3']);
  assert.equal(await acceptCommand({ key: TEST_KEY, tenantId: 't1', token: offerToken(['s3'], []), background: true }, inBackground(spawns)), 0);
  assert.deepEqual(await pendingIds(), [['t1', ['s3']]]);
  assert.equal(spawns.length, 1);
});

test('I1: a re-print of the same ids under fewer hidden kinds refuses the first token', async (t) => {
  one(t, { on: ['hosts'] });
  const io = capture(t);
  const ids = ['s1', 's2'];
  await offerCommand({ key: TEST_KEY }, deps({ null: listed([session('s1'), session('s2')]) }).deps);
  await updateAccount(TEST_KEY, { tenants: [tenant('t1', 'Acme', [])] });
  await offerCommand({ key: TEST_KEY }, deps({ null: listed([session('s1'), session('s2')]) }).deps);
  const first = offerToken(ids, ['hosts']);
  const second = offerToken(ids, []);
  assert.notEqual(first, second);
  assert.deepEqual(io.out.filter((line) => line.startsWith('offer ')), [offerLine('t1', ids, 'no', ['hosts']), offerLine('t1', ids)]);
  const spawns = [];
  assert.equal(await acceptCommand({ key: TEST_KEY, tenantId: 't1', token: first, background: true }, inBackground(spawns)), 1);
  assert.equal(io.err[io.err.length - 1], CHANGED_LINE);
  assert.deepEqual(spawns, []);
  assert.equal((await getAccount(TEST_KEY)).pendingHistory, undefined);
  assert.equal(await acceptCommand({ key: TEST_KEY, tenantId: 't1', token: second, background: true }, inBackground(spawns)), 0);
  const entries = (await getAccount(TEST_KEY)).pendingHistory;
  assert.deepEqual(entries.map((e) => [e.tenantId, e.sessionIds, e.kinds]), [['t1', ids, []]]);
  assert.equal(spawns.length, 1);
});

test('accept without a token uploads nothing and says the sessions changed', async (t) => {
  one(t, { historyOffers: { t1: { state: OfferState.DECLINED, changedAt: C, offeredIds: ['s1'] } } });
  const io = capture(t);
  assert.equal(await acceptCommand({ key: TEST_KEY, tenantId: 't1' }, { runPendingHistory: async () => { throw new Error('nothing to run'); } }), 1);
  assert.deepEqual(io.err, [CHANGED_LINE]);
  assert.equal((await getAccount(TEST_KEY)).pendingHistory, undefined);
  assert.equal((await offers()).t1.state, OfferState.DECLINED);
});

test('a scan worker cannot overwrite a question printed while it was listing', async (t) => {
  one(t, { past: { choice: 'offer', changedAt: null }, historyOffers: { t1: { state: OfferState.RESCAN, changedAt: null, places: [] } } });
  capture(t);
  const h = deps({
    null: async () => {
      await recordOffer(TEST_KEY, 't1', { state: OfferState.DECLINED, offeredIds: ['s2'], changedAt: null, shownKinds: [] });
      return listed([session('s1')]);
    },
  });
  assert.equal(await scanOffers(TEST_KEY, h.deps), 0);
  const record = (await offers()).t1;
  assert.equal(record.state, OfferState.DECLINED);
  assert.deepEqual(record.offeredIds, ['s2']);
  assert.equal(await acceptCommand({ key: TEST_KEY, tenantId: 't1', token: offerToken(['s2'], []), background: true }, inBackground([])), 0);
  assert.deepEqual(await pendingIds(), [['t1', ['s2']]]);
});

test('M2: a scan or a --past offer that lists nothing keeps a question printed while it was listing', async (t) => {
  const printedMeanwhile = async () => {
    await recordOffer(TEST_KEY, 't1', { state: OfferState.DECLINED, offeredIds: ['s2'], changedAt: C, shownKinds: [] });
    return listed([]);
  };
  for (const [name, run] of [
    ['scan worker', (h) => scanOffers(TEST_KEY, h.deps)],
    ['offer --past', (h) => offerCommand({ key: TEST_KEY, past: true }, h.deps)],
  ]) {
    await t.test(name, async (tt) => {
      one(tt, { historyOffers: { t1: { state: OfferState.RESCAN, changedAt: C, places: [] } } });
      capture(tt);
      await run(deps({ null: printedMeanwhile }));
      const record = (await offers()).t1;
      assert.equal(record.state, OfferState.DECLINED);
      assert.deepEqual(record.offeredIds, ['s2']);
      assert.equal(await acceptCommand({ key: TEST_KEY, tenantId: 't1', token: offerToken(['s2'], []), background: true }, inBackground([])), 0);
      assert.deepEqual(await pendingIds(), [['t1', ['s2']]]);
    });
  }
});

// The anonymization vectors' key, remote and branch (test/fixtures/anonymization-vectors.json).
const VECTOR_KEY = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const VECTOR_BRANCH = 'anon:branch:49ed152043496c368ff991f9c951620d';
const keyed = (on) => ({ ...block('t1', on), key: VECTOR_KEY });

// runAudit's seams as session-audit.test.mjs stubs them; the real flush hashes and hands each chunk to `posted`.
function uploadSeams(sessionBlock, posted) {
  return {
    now: () => 10 * 60 * 60 * 1000,
    linkedSessions: async () => [{ ...accountSession(TEST_KEY, 'tok'), anonymization: sessionBlock }],
    getDefaultKey: async () => TEST_KEY,
    whoamiImpl: async () => ({ valid: true, trackingMode: 'live' }),
    recordWhoamiImpl: () => {},
    listRollouts: () => [{
      sessionId: 's1', transcriptPath: 'C:/sessions/2026/01/01/rollout-2026-01-01T00-00-00-s1.jsonl', cwd: 'C:/work/app', mtimeMs: 1_000, size: 1024,
    }],
    resolveTranscriptByCwdImpl: () => null,
    readStateImpl: () => null,
    readChatgptAuthImpl: () => null,
    readBillingConfigImpl: () => null,
    postJsonImpl: async () => ({ ok: true, status: 200, json: async () => ({ accountLinked: true }) }),
    readTrackingStateImpl: () => null,
    statImpl: () => { throw new Error('ENOENT'); },
    rolloutStartedAtImpl: () => null,
    flushQueueImpl: async () => ({ flushed: 0, failed: 0, deferred: 0, unreadable: 0, trackingDisabled: false, lastError: null }),
    fetchCoverageImpl: async () => new Map(),
    loadCoverageCheckpointsImpl: () => ({ version: 1, identity: null, environment: '', apiBase: null, sessions: {}, updatedAt: null }),
    saveCoverageCheckpointsImpl: () => true,
    runCheckpointImpl: async (input, _d, options) => {
      options.sink({ segmentId: `${input.session_id}:0-1`, sessionId: input.session_id, remote: 'git@github.com:Acme/Payments.git', branch: 'feature/ABC-123' });
      return { outcome: 'committed', enqueued: 1, flush: null, sessionErrors: [], agents: {} };
    },
    flushBackfillChunksImpl: (groups, key, session, d, options) => flushBackfillChunks(groups, key, session, {
      ...d,
      postJsonImpl: async (url, _session, body) => {
        posted.push(...body.sessions);
        return { status: 200, text: async () => JSON.stringify({ stored: body.sessions.length, skipped: 0, completed: false, errors: [] }) };
      },
    }, options),
    loadLedgerImpl: () => ({ version: 1, identity: null, sessions: {}, unreadable: {}, updatedAt: null }),
    saveLedgerImpl: () => {},
    computeSessionTimelineImpl: () => ({ periods: [{ state: 'working' }], plan_events: [], subagents: [] }),
    postSessionErrorImpl: async () => ({ reported: true }),
  };
}

test('a kind the question showed as hidden is hashed in the upload, though every kind was off at the yes', async (t) => {
  linkAccount(makeHome(t), TEST_KEY, { tenantId: 't1', tenants: [{ id: 't1', name: 'Acme', anonymization: keyed(['branches']) }] });
  capture(t);
  await offerCommand({ key: TEST_KEY }, deps({ null: listed([session('s1')]) }).deps);
  assert.deepEqual((await offers()).t1.shownKinds, ['branches']);
  await updateAccount(TEST_KEY, { tenants: [{ id: 't1', name: 'Acme', anonymization: keyed([]) }] });
  const allOff = { ...keyed([]), tenantId: null };
  const posted = [];
  const acceptedKinds = [];
  const runAudit = (d, options) => {
    acceptedKinds.push(options.acceptedKinds);
    return realRunAudit({ ...d, ...uploadSeams(allOff, posted) }, options);
  };
  await acceptCommand({ key: TEST_KEY, tenantId: 't1', token: offerToken(['s1'], ['branches']) }, { now: () => T0, runAudit });
  assert.deepEqual(acceptedKinds, [['branches']]);
  assert.deepEqual(posted.map((report) => report.branch), [VECTOR_BRANCH]);
  assert.equal(posted[0].remote, 'git@github.com:Acme/Payments.git');
});

test('a rule added before a never-shown full offer was printed keeps the next offer full', async (t) => {
  linkAccount(makeHome(t), TEST_KEY, {
    tenantId: 't1',
    tenants: [tenant('t1', 'Acme'), tenant('t2', 'Beta')],
    historyOffers: { t1: { state: OfferState.READY, changedAt: C, offeredIds: ['s1', 's2', 's3'] } },
  });
  await setWorkspaceRule(TEST_KEY, { kind: 'repo', match: WEB, tenantIds: ['t1'] });
  const io = capture(t);
  const routes = new Map([['s1', { tenantIds: ['t1'], source: 'rule', key: { kind: 'repo', match: WEB } }]]);
  const h = deps({ t1: listed([session('s1'), session('s2'), session('s3')]) }, { planWorkspaceRuns: () => plan(routes, ['t1']) });
  await offerCommand({ key: TEST_KEY, past: true }, h.deps);
  assert.equal(h.audits[0].onlySessionIds, undefined);
  assert.ok(io.out.includes(offerLine('t1', ['s1', 's2', 's3'])));
});

test('a workspace no route reaches is settled by its scan, so the next session start spawns no scan', async (t) => {
  two(t);
  const h = deps({ t1: listed([]) }, { planWorkspaceRuns: () => plan(new Map(), ['t1']) });
  assert.equal(await scanOffers(TEST_KEY, h.deps), 0);
  assert.deepEqual(h.audits.map((o) => o.tenantId), ['t1']);
  const record = (await offers()).t2;
  assert.equal(record.state, OfferState.SETTLED);
  assert.equal(record.changedAt, C);
  const spawns = [];
  const later = {
    now: () => T0 + 2 * HISTORY_RETRY_MS,
    spawnImpl: (cmd, args) => { spawns.push(args); return { unref() {} }; },
  };
  assert.equal(await startOfferScans(await listAccounts(), later), 0);
  assert.deepEqual(spawns, []);
});

test('an account none of whose past sessions any route reaches settles every workspace', async (t) => {
  two(t);
  const h = deps({}, { planWorkspaceRuns: () => ({ ...plan(), scanned: 0, tenantIds: [] }) });
  await scanOffers(TEST_KEY, h.deps);
  assert.equal(h.audits.length, 0);
  assert.deepEqual([(await offers()).t1.state, (await offers()).t2.state], [OfferState.SETTLED, OfferState.SETTLED]);
});

// ── what the offer lists (I-1, PK2, M-1, M-5, M-6) ─────────────────────────────────────────

const NOT_ACCEPTED = '✗ Beezi: this workspace does not accept history uploads on demand.';

// The real runAudit over idle rollouts s1–s3, each with its last usage line at 7; `stored` is the server's prefix per id.
function coveredAudit(stored) {
  const seams = {
    ...uploadSeams({ ...keyed([]), tenantId: null }, []),
    listRollouts: () => ['s1', 's2', 's3'].map((id) => ({
      sessionId: id, transcriptPath: `C:/sessions/2026/01/01/rollout-2026-01-01T00-00-00-${id}.jsonl`, cwd: 'C:/work/app', mtimeMs: 1_000, size: 1024,
    })),
    fetchCoverageImpl: async () => new Map(Object.entries(stored)),
    lastUsageLineImpl: () => 7,
  };
  return { now: () => T0, readTrackingState: () => null, runAudit: (d, options) => realRunAudit({ ...d, ...seams }, options) };
}

test('a machine whose past sessions Beezi holds in full is asked nothing, and its scan settles', async (t) => {
  one(t);
  const io = capture(t);
  const healthy = coveredAudit({ s1: 7, s2: 7, s3: 7 });
  assert.deepEqual(await offerCommand({ key: TEST_KEY, past: false }, healthy), { offers: 0, status: 0 });
  assert.ok(!io.out.some((line) => line.startsWith('Q ')));
  assert.deepEqual(io.out, ['✓ Beezi: everything is already uploaded.', 'offers=0']);
  assert.equal(await scanOffers(TEST_KEY, healthy), 0);
  assert.equal((await offers()).t1.state, OfferState.SETTLED);
});

test('PK2: session start leaves out declined and fully held sessions; sync leaves out only the fully held', async (t) => {
  const stored = { s1: 0, s2: 0, s3: 7 };
  await t.test('session start and login (--past)', async (tt) => {
    one(tt, { historyOffers: { t1: { state: OfferState.RESCAN, changedAt: C, places: [], declinedIds: ['s1'] } } });
    const io = capture(tt);
    await offerCommand({ key: TEST_KEY, past: true }, coveredAudit(stored));
    assert.deepEqual(io.out.filter((line) => line.startsWith('offer ')), [offerLine('t1', ['s2'])]);
  });
  await t.test('sync', async (tt) => {
    one(tt, { historyOffers: { t1: { state: OfferState.DECLINED, changedAt: C, offeredIds: ['s1'], declinedIds: ['s1'] } } });
    const io = capture(tt);
    await offerCommand({ key: TEST_KEY, past: false }, coveredAudit(stored));
    assert.deepEqual(io.out.filter((line) => line.startsWith('offer ')), [offerLine('t1', ['s1', 's2'])]);
  });
});

test('Codex still saving analytics is a notice naming sync, not "already running"', async (t) => {
  for (const reason of ['active-writer', 'pending-transaction']) {
    await t.test(reason, async (tt) => {
      one(tt);
      const io = capture(tt);
      const done = await offerCommand({ key: TEST_KEY }, deps({ null: { ok: true, reason } }).deps);
      assert.equal(done.status, 0);
      assert.deepEqual(io.out, [WRITER_BUSY_LINE, 'offers=0']);
      assert.ok(WRITER_BUSY_LINE.includes(`\`${naming.syncCommand()}\``));
      assert.ok(!io.out.some((line) => line.includes('already running')));
    });
  }
});

test('M3: another history run holding the lock is a notice that claims no upload', async (t) => {
  one(t);
  const io = capture(t);
  await offerCommand({ key: TEST_KEY }, deps({ null: listed(null, { reason: 'run-in-progress' }) }).deps);
  assert.deepEqual(io.out, ['✓ Beezi: another Beezi history run is using this machine right now — letting it finish.', 'offers=0']);
});

test('M1: unreadable pending analytics is a ✗ line naming the error, listing and uploading nothing', async (t) => {
  one(t);
  const io = capture(t);
  const failed = { ok: true, reason: 'pending-unreadable', lastError: 'EACCES: permission denied' };
  const done = await offerCommand({ key: TEST_KEY }, deps({ null: failed }).deps);
  assert.equal(done.status, 1);
  assert.deepEqual(io.err, ['✗ Beezi: could not read Codex’s pending analytics on this machine (EACCES: permission denied). Nothing was listed or uploaded.']);
  assert.deepEqual(io.out, ['offers=0']);
  assert.equal(await offers(), undefined);
});

test('M1: a busy upload after a yes says nothing was uploaded yet and that Beezi retries on its own', async (t) => {
  for (const reason of ['active-writer', 'pending-transaction', 'run-in-progress']) {
    await t.test(reason, async (tt) => {
      one(tt, { historyOffers: { t1: { state: OfferState.DECLINED, changedAt: C, offeredIds: ['s1'], shownKinds: [] } } });
      const io = capture(tt);
      const runPendingHistory = async (key, d, options) => { options.onResult({ tenantId: 't1' }, { ok: true, reason }); return []; };
      assert.equal(await acceptCommand({ key: TEST_KEY, tenantId: 't1', token: offerToken(['s1'], []) }, { runPendingHistory }), 0);
      assert.deepEqual(io.out, [ACCEPT_BUSY_LINE]);
      assert.deepEqual(io.err, []);
      assert.ok(ACCEPT_BUSY_LINE.includes('nothing was uploaded yet') && ACCEPT_BUSY_LINE.includes('Beezi retries on its own'));
      assert.ok(!ACCEPT_BUSY_LINE.includes(naming.syncCommand()));
    });
  }
});

test('an empty --past list narrowed by declines or a re-opened place says nothing new, and settles', async (t) => {
  const cases = [
    ['remembered declines', { places: [], declinedIds: ['s1', 's2'] }, listed([], { declined: 2 })],
    ['a re-opened folder', { places: [{ kind: 'folder', match: '/work/web' }] }, listed([session('s3', '/work/api')])],
  ];
  for (const [name, record, result] of cases) {
    await t.test(name, async (tt) => {
      one(tt, { historyOffers: { t1: { state: OfferState.RESCAN, changedAt: C, ...record } } });
      const io = capture(tt);
      await offerCommand({ key: TEST_KEY, past: true }, deps({ null: result }).deps);
      assert.deepEqual(io.out, [NO_NEW_LINE, 'offers=0']);
      assert.equal((await offers()).t1.state, OfferState.SETTLED);
    });
  }
  assert.equal(NO_NEW_LINE, `✓ Beezi: no new past sessions to offer. Run \`${naming.syncCommand()}\` to see every past session.`);
});

test('a workspace with tracking off refuses sync on demand and stays quiet at session start; both settle', async (t) => {
  await t.test('sync', async (tt) => {
    one(tt);
    const io = capture(tt);
    const done = await offerCommand({ key: TEST_KEY }, deps({ null: listed([session('s1')], { trackingMode: 'disabled' }) }).deps);
    assert.equal(done.status, 1);
    assert.deepEqual(io.err, [NOT_ACCEPTED]);
    assert.deepEqual(io.out, ['offers=0']);
    assert.equal((await offers()).t1.state, OfferState.SETTLED);
  });
  await t.test('--past', async (tt) => {
    one(tt);
    const io = capture(tt);
    const done = await offerCommand({ key: TEST_KEY, past: true }, deps({ null: listed([session('s1')], { trackingMode: 'disabled' }) }).deps);
    assert.equal(done.status, 0);
    assert.deepEqual(io.err, []);
    assert.deepEqual(io.out, ['offers=0']);
    assert.equal((await offers()).t1.state, OfferState.SETTLED);
  });
});
