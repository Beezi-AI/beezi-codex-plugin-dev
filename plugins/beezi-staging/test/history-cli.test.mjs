import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHome, linkAccount, accountSession, TEST_KEY } from '../tools/account-fixtures.mjs';
import {
  offerCommand, acceptCommand, declineCommand, scanOffers, WRITER_BUSY_LINE, NO_NEW_LINE, ACCEPT_BUSY_LINE,
} from '../lib/history-cli.mjs';
import { startOfferScans } from '../lib/history-trigger.mjs';
import { HISTORY_RETRY_MS, historyDue } from '../lib/pending-history.mjs';
import { getAccount, recordOffer, setWorkspaceRule, listAccounts, updateAccount, settlePendingHistory } from '../lib/accounts.mjs';
import { OfferState, declineLine, offerToken, CHANGED_LINE } from '../lib/history-offer.mjs';
import { runAudit as realRunAudit } from '../lib/session-audit.mjs';
import { flushBackfillChunks } from '../lib/audit-flush.mjs';
import { HISTORY_WORKER_SCRIPT } from '../lib/history-trigger.mjs';
import { naming } from '../lib/paths.mjs';
import { createProgressWriter, readProgress } from '../lib/upload-progress.mjs';
import { followUploads } from '../lib/upload-progress-view.mjs';
import { KINDS } from '../lib/anonymize.mjs';
import { compressedSkippedLine } from '../lib/rollout-file.mjs';

const T0 = Date.parse('2026-10-22T10:00:00.000Z');
const C = '2026-10-01T00:00:00.000Z';
const WEB = 'github.com/acme/web';
const OFFER = { choice: 'offer', changedAt: C };
const SKIP = { choice: 'skip', changedAt: C };
const UPLOAD = { choice: 'upload', changedAt: C };
const ALWAYS_SENT = '  Always sent: dates, duration, models, tokens, cost, tool, skill and MCP names';
const NO_ASK_GROUP = '  Uploading without a question — these workspaces chose that';
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
const NOT_FOLLOWED = { finished: [], timedOut: false, stopped: false };
// A spawn that works, and a follower that returns at once: the worker's record is not what these tests are about.
const inBackground = (spawns) => ({ spawnImpl: (cmd, args) => { spawns.push(args); return { unref() {} }; }, follow: async () => NOT_FOLLOWED });

function one(t, { past = OFFER, on = [], historyOffers } = {}) {
  linkAccount(makeHome(t), TEST_KEY, { tenantId: 't1', tenants: [tenant('t1', 'Acme', on, past)], historyOffers });
}

function two(t, historyOffers, t1On = [], t2On = []) {
  linkAccount(makeHome(t), TEST_KEY, { tenantId: 't1', tenants: [tenant('t1', 'Acme', t1On), tenant('t2', 'Beta', t2On)], historyOffers });
}

// One account in a workspace per [id, name, pastSessions, hidden kinds].
function workspaces(t, specs) {
  linkAccount(makeHome(t), TEST_KEY, { tenantId: specs[0][0], tenants: specs.map(([id, name, past, on = []]) => tenant(id, name, on, past)) });
}

const imported = (n) => ({ ok: true, reason: null, halt: null, scanned: n, sessionsImported: n, reportsStored: n, deferred: 0, coverageKnown: true });

// A runPendingHistory that uploads `counts[tenantId]` sessions for each workspace it is handed.
function uploads(counts) {
  const calls = [];
  const runPendingHistory = async (key, d, options) => {
    calls.push(options.tenantIds);
    options.tenantIds.forEach((id) => options.onResult({ tenantId: id }, imported(counts[id])));
    return [];
  };
  return { calls, runPendingHistory };
}

const plan = (routes = new Map(), tenantIds = ['t1', 't2']) => ({
  scanned: 3, routes, counts: { rule: 0, 'new-folders': 0, none: 0, pending: 0 }, tenantIds,
});

// The linked row's own workspaces as a whoami answer: the server agrees with the cache.
const echoWhoami = async () => {
  const row = await getAccount(TEST_KEY);
  return { valid: true, tenants: row.tenants, anonymization: row.anonymization };
};

// runAudit answers per workspace id (null for a one-workspace run); a list run asks whoami first, as the real one does.
function deps(results, over = {}) {
  const audits = [];
  return {
    audits,
    deps: {
      now: () => T0,
      readTrackingState: () => null,
      planWorkspaceRuns: () => plan(),
      whoamiImpl: echoWhoami,
      runAudit: async (d, options) => {
        audits.push(options);
        if (options.listOnly === true && d.whoamiImpl != null) await d.whoamiImpl({}, {}).catch(() => null);
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
    'Q Upload 2 sessions to Acme?',
    offerLine('t1', ['s1', 's2']),
    'offers=1',
  ]);
  assert.deepEqual(io.out.slice(0, 2), ['Beezi found 2 past Codex sessions (12 Aug – 21 Oct, 2 folders)', '  in web, api']);
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
      const io = capture(tt);
      const h = deps({ t1: listed([session('s1'), session('s2'), session('s3')]) }, { planWorkspaceRuns: () => plan(routes, ['t1']) });
      await offerCommand({ key: TEST_KEY, past: true }, h.deps);
      assert.equal(h.audits.length, 1);
      assert.ok(io.out.includes(offerLine('t1', expected)));
      assert.deepEqual(h.audits[0].declinedSessionIds, ['s0']);
      assert.equal(h.audits[0].sessionRoutes, routes);
    });
  }
});

test('a multi-workspace re-opened folder lists the sessions its rule routes by prefix, a repo under it included', async (t) => {
  const routes = new Map([
    ['s1', { tenantIds: ['t1'], source: 'rule', key: { kind: 'repo', match: 'github.com/acme/api' } }],
    ['s2', { tenantIds: ['t1'], source: 'rule', key: { kind: 'folder', match: '/work/notes/x' } }],
    ['s3', { tenantIds: ['t1'], source: 'new-folders', key: { kind: 'folder', match: '/other' } }],
  ]);
  two(t, { t1: { state: OfferState.RESCAN, changedAt: C, places: [{ kind: 'folder', match: '/work' }] } });
  const io = capture(t);
  const h = deps(
    { t1: listed([session('s1', '/work/api'), session('s2', '/work/notes/x'), session('s3', '/other')]) },
    { planWorkspaceRuns: () => plan(routes, ['t1']) },
  );
  await offerCommand({ key: TEST_KEY, past: true }, h.deps);
  assert.ok(io.out.includes(offerLine('t1', ['s1', 's2'])));
  assert.deepEqual((await offers()).t1.offeredIds, ['s1', 's2']);
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

test('the later-changedAt clear keeps declines another writer recorded after this run read the account', async (t) => {
  const stale = { state: OfferState.DECLINED, changedAt: '2026-09-01T00:00:00.000Z', declinedIds: ['s0'], places: [] };
  const home = makeHome(t);
  const link = (record) => linkAccount(home, TEST_KEY, { tenantId: 't1', tenants: [tenant('t1', 'Acme')], historyOffers: { t1: record } });
  link(stale);
  capture(t);
  let wrote = false;
  // Runs after offerCommand read the account and before the clear: another writer's decline under the current changedAt.
  const readTrackingState = () => {
    if (!wrote) link({ state: OfferState.DECLINED, changedAt: C, declinedIds: ['s9'], places: [] });
    wrote = true;
    return null;
  };
  await offerCommand({ key: TEST_KEY, past: true }, deps({ null: listed([session('s1')]) }, { readTrackingState }).deps);
  assert.deepEqual((await offers()).t1.declinedIds, ['s9', 's1']);
});

test('two ask-first workspaces share one summary, then QM and a Q/offer pair for each', async (t) => {
  two(t, undefined, ['repos'], ['hosts']);
  const io = capture(t);
  await offerCommand({ key: TEST_KEY }, deps({ t1: listed([session('s1')]), t2: listed([session('s2'), session('s3')]) }).deps);
  assert.deepEqual(io.out, [
    'Beezi found 3 past Codex sessions (12 Aug – 21 Oct)',
    ALWAYS_SENT,
    '  Asks you first',
    '    ? Acme · 1 session · made-up names for repos',
    '    ? Beta · 2 sessions · made-up names for computer names',
    'QM Upload your past sessions to Acme and Beta?',
    'QM-all=Upload to both',
    'Q Upload this session to Acme?',
    offerLine('t1', ['s1'], 'no', ['repos']),
    'Q Upload 2 sessions to Beta?',
    offerLine('t2', ['s2', 's3'], 'no', ['hosts']),
    'offers=2',
  ]);
  assert.deepEqual([(await offers()).t1.state, (await offers()).t2.state], [OfferState.DECLINED, OfferState.DECLINED]);
});

// ── upload without asking ──────────────────────────────────────────────────────────────────

test('no-ask block records SETTLED, never DECLINED, and leaves a pending entry', async (t) => {
  one(t, { past: UPLOAD });
  capture(t);
  const up = uploads({ t1: 2 });
  await offerCommand({ key: TEST_KEY, past: true }, deps({ null: listed([session('s1'), session('s2')]) }, { runPendingHistory: up.runPendingHistory }).deps);
  const record = (await offers()).t1;
  assert.equal(record.state, OfferState.SETTLED);
  assert.equal(record.changedAt, C);
  assert.deepEqual(record.declinedIds, []);
  assert.deepEqual(await pendingIds(), [['t1', ['s1', 's2']]]);
  assert.deepEqual(up.calls, [['t1']]);
});

test('no-ask prints checklist + notice + Uploaded, offers=0 notices=1', async (t) => {
  one(t, { past: UPLOAD });
  const io = capture(t);
  const up = uploads({ t1: 2 });
  await offerCommand({ key: TEST_KEY, past: true }, deps({ null: listed([session('s1'), session('s2')]) }, { runPendingHistory: up.runPendingHistory }).deps);
  assert.equal(io.out[0], 'Beezi found 2 past Codex sessions (12 Aug – 21 Oct, 1 folder)');
  assert.ok(io.out.includes('  Sent'));
  assert.deepEqual(io.out.slice(-5), [
    'Acme uploads past sessions without asking, so there\'s no question.',
    'Uploading 2 sessions to Acme…',
    '✓ Uploaded 2 sessions to Acme.',
    'notices=1',
    'offers=0',
  ]);
  assert.ok(!io.out.some((line) => line.startsWith('Q') || line.startsWith('offer ')));
});

test('all-no-ask two workspaces: one notice, one Uploaded line, no Q/QM', async (t) => {
  workspaces(t, [['t1', 'Acme', UPLOAD, ['repos', 'branches']], ['t2', 'Beta', UPLOAD]]);
  const io = capture(t);
  const up = uploads({ t1: 2, t2: 2 });
  const h = deps({ t1: listed([session('s1'), session('s2')]), t2: listed([session('s2'), session('s3')]) }, { runPendingHistory: up.runPendingHistory });
  await offerCommand({ key: TEST_KEY, past: true }, h.deps);
  assert.deepEqual(io.out, [
    'Beezi found 3 past Codex sessions (12 Aug – 21 Oct)',
    ALWAYS_SENT,
    NO_ASK_GROUP,
    '    ✓ Acme · 2 sessions · made-up names for repos and branches',
    '    ✓ Beta · 2 sessions · names and titles as they are',
    'Uploading 4 sessions to Acme and Beta…',
    '✓ Uploaded 2 sessions to Acme and 2 to Beta.',
    'notices=2',
    'offers=0',
  ]);
  assert.deepEqual(up.calls, [['t1', 't2']]);
  assert.deepEqual(await pendingIds(), [['t1', ['s1', 's2']], ['t2', ['s2', 's3']]]);
});

test('mixed: notice, then QM plus a Q/offer pair for each', async (t) => {
  const gammaKinds = ['repos', 'accounts', 'sessions'];
  workspaces(t, [['t1', 'Acme', UPLOAD], ['t2', 'Beta', UPLOAD], ['t3', 'Gamma', OFFER, gammaKinds], ['t4', 'Delta', OFFER]]);
  const io = capture(t);
  const up = uploads({ t1: 1, t2: 1 });
  const h = deps(
    { t1: listed([session('s1')]), t2: listed([session('s2')]), t3: listed([session('s3'), session('s4')]), t4: listed([session('s5')]) },
    { runPendingHistory: up.runPendingHistory, planWorkspaceRuns: () => plan(new Map(), ['t1', 't2', 't3', 't4']) },
  );
  await offerCommand({ key: TEST_KEY, past: true }, h.deps);
  assert.deepEqual(io.out, [
    'Beezi found 5 past Codex sessions (12 Aug – 21 Oct)',
    ALWAYS_SENT,
    NO_ASK_GROUP,
    '    ✓ Acme · 1 session · names and titles as they are',
    '    ✓ Beta · 1 session · names and titles as they are',
    '  Asks you first',
    '    ? Gamma · 2 sessions · made-up names for repos and accounts, titles never sent',
    '    ? Delta · 1 session · names and titles as they are',
    'Uploading 2 sessions to Acme and Beta…',
    '✓ Uploaded 1 session to Acme and 1 to Beta.',
    'QM Upload your past sessions to Gamma and Delta too?',
    'QM-all=Upload to both',
    'Q Upload 2 sessions to Gamma?',
    offerLine('t3', ['s3', 's4'], 'no', gammaKinds),
    'Q Upload this session to Delta?',
    offerLine('t4', ['s5']),
    'notices=2',
    'offers=2',
  ]);
  const states = await offers();
  assert.deepEqual(['t1', 't2', 't3', 't4'].map((id) => states[id].state), [OfferState.SETTLED, OfferState.SETTLED, OfferState.DECLINED, OfferState.DECLINED]);
  assert.deepEqual(up.calls, [['t1', 't2']]);
});

test('one ask-first among no-ask: Q only, no QM', async (t) => {
  workspaces(t, [['t1', 'Acme', UPLOAD], ['t2', 'Beta', OFFER]]);
  const io = capture(t);
  const up = uploads({ t1: 1 });
  await offerCommand({ key: TEST_KEY, past: true }, deps({ t1: listed([session('s1')]), t2: listed([session('s2')]) }, { runPendingHistory: up.runPendingHistory }).deps);
  assert.deepEqual(io.out.slice(-5), ['✓ Uploaded 1 session to Acme.', 'Q Upload this session to Beta?', offerLine('t2', ['s2']), 'notices=1', 'offers=1']);
  assert.ok(!io.out.some((line) => line.startsWith('QM')));
});

test('sync no-ask uploads without question; skip still asks; --tenant always asks', async (t) => {
  await t.test('upload', async (tt) => {
    one(tt, { past: UPLOAD });
    const io = capture(tt);
    const up = uploads({ t1: 1 });
    await offerCommand({ key: TEST_KEY }, deps({ null: listed([session('s1')]) }, { runPendingHistory: up.runPendingHistory }).deps);
    assert.deepEqual(up.calls, [['t1']]);
    assert.ok(!io.out.some((line) => line.startsWith('Q ')));
    assert.ok(io.out.includes('✓ Uploaded 1 session to Acme.'));
  });
  await t.test('skip', async (tt) => {
    one(tt, { past: SKIP });
    const io = capture(tt);
    await offerCommand({ key: TEST_KEY }, deps({ null: listed([session('s1')]) }).deps);
    assert.deepEqual(io.out.slice(-2), [offerLine('t1', ['s1']), 'offers=1']);
  });
  await t.test('--tenant', async (tt) => {
    workspaces(tt, [['t1', 'Acme', UPLOAD], ['t2', 'Beta', UPLOAD]]);
    const io = capture(tt);
    await offerCommand({ key: TEST_KEY, tenantIds: ['t2'] }, deps({ t2: listed([session('s1')]) }).deps);
    assert.deepEqual(io.out.slice(-3), ['Q Upload this session to Beta?', offerLine('t2', ['s1']), 'offers=1']);
    assert.equal((await offers()).t2.state, OfferState.DECLINED);
  });
});

test('--background spawns once, prints the progress line then the background line', async (t) => {
  workspaces(t, [['t1', 'Acme', UPLOAD], ['t2', 'Beta', UPLOAD]]);
  const io = capture(t);
  const spawns = [];
  const h = deps({ t1: listed([session('s1')]), t2: listed([session('s2')]) }, {
    ...inBackground(spawns), runPendingHistory: async () => { throw new Error('must not upload here'); },
  });
  await offerCommand({ key: TEST_KEY, past: true, background: true }, h.deps);
  assert.deepEqual(spawns, [[HISTORY_WORKER_SCRIPT, '--account', TEST_KEY]]);
  assert.deepEqual(io.out.slice(-4), [
    'Uploading 2 sessions to Acme and Beta…',
    '✓ Beezi: uploading 2 past sessions to Acme and Beta in the background.',
    'notices=2',
    'offers=0',
  ]);
  assert.equal(io.out.filter((line) => line.startsWith('Uploading ')).length, 1);
  assert.deepEqual(await pendingIds(), [['t1', ['s1']], ['t2', ['s2']]]);
});

test('--dry-run on a no-ask workspace prints the notice without upload lines and records nothing', async (t) => {
  one(t, { past: UPLOAD });
  const io = capture(t);
  await offerCommand({ key: TEST_KEY, dryRun: true }, deps({ null: listed([session('s1')]) }, { runPendingHistory: async () => { throw new Error('no upload'); } }).deps);
  assert.deepEqual(io.out.slice(-3), ['Acme uploads past sessions without asking, so there\'s no question.', 'notices=1', 'offers=0']);
  assert.equal(await offers(), undefined);
  assert.equal((await getAccount(TEST_KEY)).pendingHistory, undefined);
});

test('failed no-ask upload stays SETTLED and is due for retry', async (t) => {
  one(t, { past: UPLOAD });
  const io = capture(t);
  // The real runPendingHistory, over a listing that lists and an upload that fails.
  const h = deps({ null: (d, o) => (o.listOnly ? listed([session('s1')]) : null) });
  assert.equal((await offerCommand({ key: TEST_KEY, past: true }, h.deps)).status, 1);
  assert.deepEqual(io.err, ['✗ Beezi: the upload stopped with an error. Beezi tries it again at the next session start.']);
  const row = await getAccount(TEST_KEY);
  assert.equal(row.historyOffers.t1.state, OfferState.SETTLED);
  assert.deepEqual(row.pendingHistory.map((e) => [e.tenantId, e.sessionIds]), [['t1', ['s1']]]);
  assert.equal(historyDue(row, T0 + HISTORY_RETRY_MS), true);
  io.out.length = 0;
  await offerCommand({ key: TEST_KEY, past: true }, h.deps);
  assert.deepEqual(io.out, ['offers=0']);
});

test('R17: a cached upload choice the run\'s own whoami does not confirm asks first', async (t) => {
  const answers = [
    ['the server now says offer', async () => ({ valid: true, tenants: [tenant('t1', 'Acme', [], OFFER)] })],
    ['the server now says skip', async () => ({ valid: true, tenants: [tenant('t1', 'Acme', [], SKIP)] })],
    ['no answer', async () => null],
    ['a failed request', async () => { throw new Error('offline'); }],
    ['a refused token', async () => ({ valid: false })],
  ];
  for (const [name, whoamiImpl] of answers) {
    for (const past of [true, false]) {
      await t.test(`${name}, ${past ? '--past' : 'sync'}`, async (tt) => {
        one(tt, { past: UPLOAD });
        const io = capture(tt);
        const h = deps({ null: listed([session('s1')]) }, { whoamiImpl, runPendingHistory: async () => { throw new Error('no upload'); } });
        await offerCommand({ key: TEST_KEY, past }, h.deps);
        assert.deepEqual(io.out.slice(-3), ['Q Upload this session to Acme?', offerLine('t1', ['s1']), 'offers=1']);
        assert.ok(!io.out.some((line) => line.startsWith('notices=') || line.includes('without asking')));
        assert.equal((await offers()).t1.state, OfferState.DECLINED);
        assert.equal((await getAccount(TEST_KEY)).pendingHistory, undefined);
      });
    }
  }
});

test('R17: the run\'s own whoami saying upload skips the question for that workspace only', async (t) => {
  workspaces(t, [['t1', 'Acme', UPLOAD], ['t2', 'Beta', UPLOAD]]);
  const io = capture(t);
  const up = uploads({ t1: 1 });
  const whoamiImpl = async () => ({ valid: true, tenants: [tenant('t1', 'Acme', [], UPLOAD), tenant('t2', 'Beta', [], OFFER)] });
  await offerCommand({ key: TEST_KEY, past: true }, deps({ t1: listed([session('s1')]), t2: listed([session('s2')]) }, { whoamiImpl, runPendingHistory: up.runPendingHistory }).deps);
  assert.deepEqual(up.calls, [['t1']]);
  assert.deepEqual(io.out.slice(-5), ['✓ Uploaded 1 session to Acme.', 'Q Upload this session to Beta?', offerLine('t2', ['s2']), 'notices=1', 'offers=1']);
});

test('R18: sync asks first in a no-ask workspace with declines under the current changedAt; an older decline does not count', async (t) => {
  await t.test('current', async (tt) => {
    one(tt, { past: UPLOAD, historyOffers: { t1: { state: OfferState.DECLINED, changedAt: C, offeredIds: ['s1'], declinedIds: ['s1'] } } });
    const io = capture(tt);
    await offerCommand({ key: TEST_KEY }, deps({ null: listed([session('s1'), session('s2')]) }, { runPendingHistory: async () => { throw new Error('no upload'); } }).deps);
    assert.deepEqual(io.out.slice(-3), ['Q Upload 2 sessions to Acme?', offerLine('t1', ['s1', 's2']), 'offers=1']);
    assert.equal((await getAccount(TEST_KEY)).pendingHistory, undefined);
  });
  await t.test('older', async (tt) => {
    one(tt, { past: UPLOAD, historyOffers: { t1: { state: OfferState.DECLINED, changedAt: '2026-09-01T00:00:00.000Z', offeredIds: ['s1'], declinedIds: ['s1'] } } });
    const io = capture(tt);
    const up = uploads({ t1: 2 });
    await offerCommand({ key: TEST_KEY }, deps({ null: listed([session('s1'), session('s2')]) }, { runPendingHistory: up.runPendingHistory }).deps);
    assert.deepEqual(up.calls, [['t1']]);
    assert.ok(!io.out.some((line) => line.startsWith('Q ')));
  });
});

test('a decline under a never-changed offer, then the owner switching to upload: the next offer uploads with the notice', async (t) => {
  for (const past of [true, false]) {
    await t.test(past ? '--past' : 'sync', async (tt) => {
      one(tt, { past: { choice: 'offer', changedAt: null } });
      const io = capture(tt);
      await offerCommand({ key: TEST_KEY }, deps({ null: listed([session('s1')]) }).deps);
      await declineCommand({ key: TEST_KEY, tenantId: 't1' });
      assert.equal((await offers()).t1.state, OfferState.DECLINED);
      assert.equal((await offers()).t1.changedAt, null);
      await updateAccount(TEST_KEY, { tenants: [tenant('t1', 'Acme', [], UPLOAD)] });
      io.out.length = 0;
      const up = uploads({ t1: 1 });
      const done = await offerCommand({ key: TEST_KEY, past }, deps({ null: listed([session('s1')]) }, { runPendingHistory: up.runPendingHistory }).deps);
      assert.equal(done.status, 0);
      assert.deepEqual(io.out.slice(-5), [
        'Acme uploads past sessions without asking, so there\'s no question.',
        'Uploading 1 session to Acme…',
        '✓ Uploaded 1 session to Acme.',
        'notices=1',
        'offers=0',
      ]);
      assert.deepEqual(up.calls, [['t1']]);
      const record = (await offers()).t1;
      assert.equal(record.state, OfferState.SETTLED);
      assert.equal(record.changedAt, C);
      assert.deepEqual(record.declinedIds, []);
    });
  }
});

test('F1: a no-ask run with undelivered reports prints accept\'s failure lines and exits 1', async (t) => {
  one(t, { past: UPLOAD });
  const io = capture(t);
  const runPendingHistory = async (key, d, options) => {
    options.onResult({ tenantId: 't1' }, { ...imported(2), reportsFailed: 1, lastError: 'boom' });
    return [];
  };
  const done = await offerCommand({ key: TEST_KEY, past: true }, deps({ null: listed([session('s1'), session('s2')]) }, { runPendingHistory }).deps);
  assert.equal(done.status, 1);
  assert.ok(io.out.includes('✓ Beezi: uploaded 2 sessions (2 reports stored).'));
  assert.ok(io.out.includes('  1 report could not be delivered (last error: boom) — run sync again to retry them.'));
  assert.ok(!io.out.some((line) => line.startsWith('✓ Uploaded')));
  assert.deepEqual(io.out.slice(-2), ['notices=1', 'offers=0']);
});

test('#D: a no-ask run\'s last error prints on one line, so it cannot forge a machine line', async (t) => {
  one(t, { past: UPLOAD });
  const io = capture(t);
  const runPendingHistory = async (key, d, options) => {
    options.onResult({ tenantId: 't1' }, { ...imported(2), reportsFailed: 1, lastError: 'boom\nQ forged\r\noffers=9' });
    return [];
  };
  await offerCommand({ key: TEST_KEY, past: true }, deps({ null: listed([session('s1'), session('s2')]) }, { runPendingHistory }).deps);
  assert.ok(io.out.includes('  1 report could not be delivered (last error: boom Q forged offers=9) — run sync again to retry them.'));
  assert.ok(!io.out.some((line) => line.includes('\n') || line.includes('\r')));
});

test('F1: a busy no-ask run says each workspace is queued, the skipped one too, and exits 0 with both still owed', async (t) => {
  workspaces(t, [['t1', 'Acme', UPLOAD], ['t2', 'Beta', UPLOAD]]);
  const io = capture(t);
  const busyRun = (s) => (d, o) => (o.listOnly ? listed([session(s)]) : { ok: true, reason: 'run-in-progress' });
  // The real runPendingHistory: t1's run is busy, so t2 is skipped without a result.
  const done = await offerCommand({ key: TEST_KEY, past: true }, deps({ t1: busyRun('s1'), t2: busyRun('s2') }).deps);
  assert.equal(done.status, 0);
  assert.deepEqual(io.err, []);
  assert.deepEqual(io.out.slice(-5), [
    'Uploading 2 sessions to Acme and Beta…',
    'Beezi: another upload is running, so Acme\'s past sessions are queued and upload later.',
    'Beezi: another upload is running, so Beta\'s past sessions are queued and upload later.',
    'notices=2',
    'offers=0',
  ]);
  assert.deepEqual(await pendingIds(), [['t1', ['s1']], ['t2', ['s2']]]);
});

test('F3: a no-ask upload hides what the fresh answer hides, though the cached row hides nothing', async (t) => {
  one(t, { past: UPLOAD });
  const io = capture(t);
  const whoamiImpl = async () => ({ valid: true, tenants: [tenant('t1', 'Acme', ['repos'], UPLOAD)] });
  const up = uploads({ t1: 1 });
  await offerCommand({ key: TEST_KEY, past: true }, deps({ null: listed([session('s1')]) }, { whoamiImpl, runPendingHistory: up.runPendingHistory }).deps);
  assert.ok(io.out.includes('  Hidden by your workspace — Beezi gets made-up names'));
  assert.ok(io.out.includes('    ◆ folder and repository names'));
  assert.ok(!io.out.some((line) => line.includes('folder and repository names, ') && line.includes('as they are')));
  assert.deepEqual((await getAccount(TEST_KEY)).pendingHistory[0].kinds, ['repos']);
});

test('F3: a no-ask workspace shows and owes the fresh hidden kinds, though the cached row hid more (R5)', async (t) => {
  workspaces(t, [['t1', 'Acme', UPLOAD, ['branches']], ['t2', 'Beta', OFFER]]);
  const io = capture(t);
  const whoamiImpl = async () => ({ valid: true, tenants: [tenant('t1', 'Acme', ['repos'], UPLOAD), tenant('t2', 'Beta', [], OFFER)] });
  const up = uploads({ t1: 1 });
  await offerCommand({ key: TEST_KEY, past: true }, deps({ t1: listed([session('s1')]), t2: listed([session('s2')]) }, { whoamiImpl, runPendingHistory: up.runPendingHistory }).deps);
  assert.ok(io.out.includes('    ✓ Acme · 1 session · made-up names for repos'));
  assert.deepEqual((await getAccount(TEST_KEY)).pendingHistory[0].kinds, ['repos']);
});

test('F4: a no-ask owe settles under the fresh whoami\'s changedAt', async (t) => {
  const C2 = '2026-10-15T00:00:00.000Z';
  one(t, { past: UPLOAD });
  capture(t);
  const whoamiImpl = async () => ({ valid: true, tenants: [tenant('t1', 'Acme', [], { choice: 'upload', changedAt: C2 })] });
  await offerCommand({ key: TEST_KEY, past: true }, deps({ null: listed([session('s1')]) }, { whoamiImpl, runPendingHistory: uploads({ t1: 1 }).runPendingHistory }).deps);
  const record = (await offers()).t1;
  assert.equal(record.state, OfferState.SETTLED);
  assert.equal(record.changedAt, C2);
});

test('F5: sync asks first only when a listed session was declined under the fresh changedAt', async (t) => {
  const C2 = '2026-10-15T00:00:00.000Z';
  const cases = [
    ['a current decline of a session not listed', { declinedIds: ['s0'], offeredIds: ['s0'] }, echoWhoami],
    ['a decline current under the cache, stale under the fresh answer', { declinedIds: ['s1'], offeredIds: ['s1'] },
      async () => ({ valid: true, tenants: [tenant('t1', 'Acme', [], { choice: 'upload', changedAt: C2 })] })],
  ];
  for (const [name, record, whoamiImpl] of cases) {
    await t.test(name, async (tt) => {
      one(tt, { past: UPLOAD, historyOffers: { t1: { state: OfferState.DECLINED, changedAt: C, ...record } } });
      const io = capture(tt);
      const up = uploads({ t1: 1 });
      await offerCommand({ key: TEST_KEY }, deps({ null: listed([session('s1')]) }, { whoamiImpl, runPendingHistory: up.runPendingHistory }).deps);
      assert.deepEqual(up.calls, [['t1']]);
      assert.ok(!io.out.some((line) => line.startsWith('Q ')));
      assert.ok(io.out.includes('✓ Uploaded 1 session to Acme.'));
    });
  }
});

test('#B: a no-ask owe waits, unsettled, while a --tenant entry is pending, and is noticed once that entry settles', async (t) => {
  const entry = { tenantId: 't1', sessionIds: ['s0'], override: true, kinds: [], requestedAt: new Date(T0).toISOString(), attempts: 0, lastAttemptAt: null, inFlight: false, sent: 0, skipped: 0, retryNoticed: false };
  linkAccount(makeHome(t), TEST_KEY, { tenantId: 't1', tenants: [tenant('t1', 'Acme', [], UPLOAD)], pendingHistory: [entry] });
  const io = capture(t);
  const up = uploads({ t1: 1 });
  const h = deps({ null: listed([session('s1')]) }, { runPendingHistory: up.runPendingHistory });
  const first = await offerCommand({ key: TEST_KEY }, h.deps);
  assert.equal(first.status, 0);
  assert.deepEqual(up.calls, []);
  assert.equal(io.out[io.out.length - 1], 'offers=0');
  assert.ok(!io.out.some((line) => line.startsWith('notices=') || line.startsWith('Uploading ') || line.includes('without asking')));
  const [after] = (await getAccount(TEST_KEY)).pendingHistory;
  assert.deepEqual(after.sessionIds, ['s0']);
  assert.equal(after.override, true);
  assert.equal(((await offers()) || {}).t1, undefined, 'left unsettled');
  await settlePendingHistory(TEST_KEY, 't1', { outcome: 'clean', sent: 1, skipped: 0 }, { plannedAtMs: T0 + 1000, nowMs: T0 + 1000 });
  io.out.length = 0;
  await offerCommand({ key: TEST_KEY }, h.deps);
  assert.deepEqual(up.calls, [['t1']]);
  assert.deepEqual(io.out.slice(-2), ['notices=1', 'offers=0']);
  assert.deepEqual(await pendingIds(), [['t1', ['s1']]]);
});

test('F7: a no-ask workspace nothing was owed for gets no upload lines and is not counted', async (t) => {
  await t.test('one of two left the account', async (tt) => {
    workspaces(tt, [['t1', 'Acme', UPLOAD], ['t2', 'Beta', UPLOAD]]);
    const io = capture(tt);
    const up = uploads({ t1: 1 });
    // The account leaves t2 after t2's list read whoami, so t2 is still no-ask but owes nothing.
    const leaveT2 = async () => {
      await updateAccount(TEST_KEY, { tenants: [tenant('t1', 'Acme', [], UPLOAD)] });
      return listed([session('s2')]);
    };
    const done = await offerCommand({ key: TEST_KEY, past: true }, deps({ t1: listed([session('s1')]), t2: leaveT2 }, { runPendingHistory: up.runPendingHistory }).deps);
    assert.equal(done.status, 0);
    assert.deepEqual(io.err, []);
    assert.deepEqual(io.out.slice(-4), ['Uploading 1 session to Acme…', '✓ Uploaded 1 session to Acme.', 'notices=1', 'offers=0']);
    assert.deepEqual(up.calls, [['t1']]);
  });
  await t.test('the only one left the account', async (tt) => {
    one(tt, { past: UPLOAD });
    const io = capture(tt);
    const leave = async () => {
      await updateAccount(TEST_KEY, { tenants: [tenant('t9', 'Other', [], UPLOAD)] });
      return listed([session('s1')]);
    };
    const done = await offerCommand({ key: TEST_KEY, past: true }, deps({ null: leave }, { runPendingHistory: async () => { throw new Error('no upload'); } }).deps);
    assert.equal(done.status, 0);
    assert.deepEqual(io.err, []);
    assert.equal(io.out[io.out.length - 1], 'offers=0');
    assert.ok(!io.out.some((line) => line.startsWith('notices=') || line.startsWith('Uploading ') || line.includes('without asking')));
  });
});

test('a no-ask upload prints its sessions read, and the shown count in Uploaded', async (t) => {
  one(t, { past: UPLOAD });
  const io = capture(t);
  const runPendingHistory = async (key, d, options) => {
    await d.runAudit({}, { tenantId: null });
    options.onResult({ tenantId: 't1' }, imported(5));
    return [];
  };
  const h = deps({ null: (d, o) => (o.listOnly ? listed([session('s1'), session('s2')]) : d.onProgress({ processed: 1, total: 2 })) }, { runPendingHistory });
  await offerCommand({ key: TEST_KEY, past: true }, h.deps);
  assert.deepEqual(io.out.slice(-5), ['Uploading 2 sessions to Acme…', 'Beezi: 1/2 sessions read…', '✓ Uploaded 2 sessions to Acme.', 'notices=1', 'offers=0']);
});

test('a no-ask upload no run picks up says nothing was uploaded and exits 1', async (t) => {
  one(t, { past: UPLOAD });
  const io = capture(t);
  const done = await offerCommand({ key: TEST_KEY, past: true }, deps({ null: listed([session('s1')]) }, { runPendingHistory: async () => [] }).deps);
  assert.equal(done.status, 1);
  assert.deepEqual(io.err, [
    `✗ Beezi: nothing was uploaded — no rule or New folders setting sends these sessions to Acme now. Run \`${naming.syncCommand()}\` to see what would be sent.`,
  ]);
  assert.ok(!io.out.some((line) => line.startsWith('✓ Uploaded')));
  assert.deepEqual(await pendingIds(), [['t1', ['s1']]]);
});

test('offer→upload changedAt re-opens a decline and uploads', async (t) => {
  one(t, { past: UPLOAD, historyOffers: { t1: { state: OfferState.DECLINED, changedAt: '2026-09-01T00:00:00.000Z', offeredIds: ['s1'], declinedIds: ['s1'] } } });
  const io = capture(t);
  const up = uploads({ t1: 1 });
  const h = deps({ null: listed([session('s1')]) }, { runPendingHistory: up.runPendingHistory });
  await offerCommand({ key: TEST_KEY, past: true }, h.deps);
  assert.equal(h.audits[0].declinedSessionIds, undefined);
  assert.ok(io.out.includes('Acme uploads past sessions without asking, so there\'s no question.'));
  const record = (await offers()).t1;
  assert.equal(record.state, OfferState.SETTLED);
  assert.equal(record.changedAt, C);
  assert.deepEqual(record.declinedIds, []);
  assert.deepEqual(await pendingIds(), [['t1', ['s1']]]);
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

const ACME_PROGRESS = { key: TEST_KEY, tenantId: 't1', workspace: 'Acme', processed: 1, total: 3, sent: 1 };

// Accepts s1 and s2 with --background; `scripted` stands in for the follower (the real one when omitted).
async function acceptInBackground(t, scripted, over = {}) {
  one(t);
  const io = capture(t);
  const spawns = [];
  const follows = [];
  await offerCommand({ key: TEST_KEY }, deps({ null: listed([session('s1'), session('s2')]) }).deps);
  const follow = scripted == null ? undefined : async (options) => { follows.push(options); return scripted(options); };
  const code = await acceptCommand({ key: TEST_KEY, tenantId: 't1', token: offerToken(['s1', 's2'], []), background: true }, {
    ...inBackground(spawns),
    now: () => T0,
    runPendingHistory: async () => { throw new Error('must not upload here'); },
    follow,
    ...over,
  });
  return { code, io, spawns, follows };
}

test('accept --background starts the history worker and follows its record for the accepted workspace', async (t) => {
  const run = await acceptInBackground(t, async () => NOT_FOLLOWED);
  assert.equal(run.code, 0);
  assert.deepEqual(run.spawns, [[HISTORY_WORKER_SCRIPT, '--account', TEST_KEY]]);
  assert.equal(run.follows.length, 1);
  assert.equal(run.follows[0].key, TEST_KEY);
  assert.deepEqual(run.follows[0].tenantIds, ['t1']);
  assert.equal(run.follows[0].sinceMs, T0);
  assert.equal(run.follows[0].capMs, 100000);
});

test('accept --background prints a line per change, then the done line, and marks the record reported', async (t) => {
  const record = { ...ACME_PROGRESS, processed: 2, total: 2, sent: 2 };
  const run = await acceptInBackground(t, async (options) => {
    // Written here, once the test's home exists, as the worker would have.
    createProgressWriter({ key: TEST_KEY, tenantId: 't1', workspace: 'Acme', now: () => T0 }).finish({ processed: 2, total: 2, sent: 2 });
    options.onUpdate({ ...ACME_PROGRESS, total: 2 });
    options.onUpdate(record);
    options.onDone(record);
    return { finished: [record], timedOut: false, stopped: false };
  });
  assert.equal(run.code, 0);
  assert.deepEqual(run.io.out.slice(-3), ['Beezi: 1/2 sessions read…', 'Beezi: all sessions read, finishing upload…', '✓ 2 past sessions uploaded to Acme']);
  assert.equal(readProgress(TEST_KEY, 't1').reported, true);
});

test('accept --background at the cap says how far it got and that the rest keeps uploading', async (t) => {
  const run = await acceptInBackground(t, async (options) => {
    options.onUpdate(ACME_PROGRESS);
    return { finished: [], timedOut: true, stopped: false };
  });
  assert.equal(run.code, 0);
  assert.deepEqual(run.io.out.slice(-2), ['Beezi: 1/3 sessions read…', '✓ 1 of 3 past sessions uploaded to Acme; the rest keeps uploading in the background']);
});

test('accept --background with no record ever written says the rest keeps uploading', async (t) => {
  const run = await acceptInBackground(t, async () => ({ finished: [], timedOut: true, stopped: false }));
  assert.equal(run.io.out[run.io.out.length - 1], 'Beezi: the rest keeps uploading in the background');
});

test('accept --background follows through the real follower on the injected clock, never sleeping for real', async (t) => {
  let nowMs = T0;
  const sleeps = [];
  const run = await acceptInBackground(t, null, {
    now: () => nowMs,
    sleep: async (ms) => { sleeps.push(ms); nowMs += ms; },
  });
  assert.equal(run.code, 0);
  assert.equal(sleeps.length, 100);
  assert.equal(run.io.out[run.io.out.length - 1], 'Beezi: the rest keeps uploading in the background');
});

test('accept --background follows nothing when the worker did not start, and uploads here instead', async (t) => {
  one(t);
  const io = capture(t);
  await offerCommand({ key: TEST_KEY }, deps({ null: listed([session('s1'), session('s2')]) }).deps);
  const ran = [];
  const code = await acceptCommand({ key: TEST_KEY, tenantId: 't1', token: offerToken(['s1', 's2'], []), background: true }, {
    spawnImpl: () => { throw new Error('no node'); },
    follow: async () => { throw new Error('must not follow'); },
    runPendingHistory: async (key, d, options) => {
      ran.push(options.tenantIds);
      options.onResult({ tenantId: 't1' }, imported(2));
      return [];
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(ran, [['t1']]);
  // The skill shows only the last line, so the result line comes after the plan note.
  assert.equal(io.out[io.out.length - 2], '  Plan and billing details reflect your current setup, not the plan you were on at the time.');
  assert.equal(io.out[io.out.length - 1], '✓ Beezi: uploaded 2 sessions (2 reports stored).');
});

test('accept --background whose run stopped without a done line ends on the rest-keeps-uploading line', async (t) => {
  const run = await acceptInBackground(t, async (options) => {
    options.onUpdate(ACME_PROGRESS);
    return { finished: [], timedOut: false, stopped: true };
  });
  assert.equal(run.code, 0);
  assert.deepEqual(run.io.out.slice(-2), ['Beezi: 1/3 sessions read…', 'Beezi: the rest keeps uploading in the background']);
});

test('accept --background through the real follower: a failed record prints no done line and is not marked reported', async (t) => {
  const run = await acceptInBackground(t, null, {
    follow: async (options) => {
      createProgressWriter({ key: TEST_KEY, tenantId: 't1', workspace: 'Acme', now: () => T0 }).finish({ processed: 1, total: 40, sent: 1 }, true);
      return followUploads(options);
    },
  });
  assert.equal(run.code, 0);
  assert.equal(run.io.out[run.io.out.length - 1], 'Beezi: the rest keeps uploading in the background');
  assert.equal(run.io.out.indexOf('✓ 1 past session uploaded to Acme'), -1);
  assert.equal(readProgress(TEST_KEY, 't1').reported, false);
});

test('accept with nothing offered exits 1 and says how to see what would be sent', async (t) => {
  one(t);
  const io = capture(t);
  const code = await acceptCommand({ key: TEST_KEY, tenantId: 't1' }, { runPendingHistory: async () => { throw new Error('nothing to run'); } });
  assert.equal(code, 1);
  assert.deepEqual(io.out, [`Beezi: nothing is waiting to upload. Run \`${naming.syncCommand()}\` to see what would be sent.`]);
  assert.equal((await getAccount(TEST_KEY)).pendingHistory, undefined);
});

test('an Audit workspace whose whoami answers upload uploads without asking (R6)', async (t) => {
  one(t, { past: UPLOAD });
  const io = capture(t);
  const up = uploads({ t1: 1 });
  await offerCommand({ key: TEST_KEY }, deps({ null: listed([session('s1')], { trackingMode: 'backfill_only' }) }, { runPendingHistory: up.runPendingHistory }).deps);
  assert.deepEqual(up.calls, [['t1']]);
  assert.ok(!io.out.some((line) => line.startsWith('Q ') || line.startsWith('offer ')));
  assert.ok(io.out.includes('✓ Uploaded 1 session to Acme.'));
  assert.deepEqual(await pendingIds(), [['t1', ['s1']]]);
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

// The anonymization vectors' key (test/fixtures/anonymization-vectors.json).
const VECTOR_KEY = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const keyed = (on) => ({ ...block('t1', on), key: VECTOR_KEY });

// runAudit's seams as session-audit.test.mjs stubs them; the real flush hashes and hands each chunk to `posted`. `who` is
// the run's own whoami answer, by default agreeing with the cached block.
function uploadSeams(sessionBlock, posted, who = { valid: true, trackingMode: 'live', anonymization: sessionBlock }) {
  return {
    now: () => 10 * 60 * 60 * 1000,
    linkedSessions: async () => [{ ...accountSession(TEST_KEY, 'tok'), anonymization: sessionBlock }],
    getDefaultKey: async () => TEST_KEY,
    whoamiImpl: async () => who,
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

test('a kind the question showed as hidden goes up raw when the owner turned it off before the yes (R5)', async (t) => {
  linkAccount(makeHome(t), TEST_KEY, { tenantId: 't1', tenants: [{ id: 't1', name: 'Acme', anonymization: keyed(['branches']) }] });
  capture(t);
  await offerCommand({ key: TEST_KEY }, deps({ null: listed([session('s1')]) }).deps);
  assert.deepEqual((await offers()).t1.shownKinds, ['branches']);
  await updateAccount(TEST_KEY, { tenants: [{ id: 't1', name: 'Acme', anonymization: keyed([]) }] });
  const allOff = { ...keyed([]), tenantId: null };
  const posted = [];
  const runAudit = (d, options) => realRunAudit({ ...d, ...uploadSeams(allOff, posted) }, options);
  await acceptCommand({ key: TEST_KEY, tenantId: 't1', token: offerToken(['s1'], ['branches']) }, { now: () => T0, runAudit });
  assert.deepEqual(posted.map((report) => report.branch), ['feature/ABC-123']);
  assert.equal(posted[0].remote, 'git@github.com:Acme/Payments.git');
});

test('an owed upload hashes with the run\'s own whoami block: a kind the owner turned on since the cache goes up made-up (R5)', async (t) => {
  linkAccount(makeHome(t), TEST_KEY, { tenantId: 't1', tenants: [{ id: 't1', name: 'Acme', anonymization: keyed([]) }] });
  capture(t);
  await offerCommand({ key: TEST_KEY }, deps({ null: listed([session('s1')]) }).deps);
  const cached = { ...keyed([]), tenantId: null };
  const fresh = { valid: true, trackingMode: 'live', anonymization: { ...keyed(['repos']), tenantId: null } };
  const posted = [];
  const runAudit = (d, options) => realRunAudit({ ...d, ...uploadSeams(cached, posted, fresh) }, options);
  await acceptCommand({ key: TEST_KEY, tenantId: 't1', token: offerToken(['s1'], []) }, { now: () => T0, runAudit });
  assert.deepEqual(posted.map((report) => report.remote), ['anon:repo:5c565a8dd7e9ae8c634d8776d5892e65']);
  assert.equal(posted[0].branch, 'feature/ABC-123');
});

test('an owed upload whose run gets no whoami answer sends nothing and stays owed (R5, fail closed)', async (t) => {
  linkAccount(makeHome(t), TEST_KEY, { tenantId: 't1', tenants: [{ id: 't1', name: 'Acme', anonymization: keyed([]) }] });
  const io = capture(t);
  await offerCommand({ key: TEST_KEY }, deps({ null: listed([session('s1')]) }).deps);
  const posted = [];
  const runAudit = (d, options) => realRunAudit({ ...d, ...uploadSeams({ ...keyed([]), tenantId: null }, posted, null) }, options);
  await acceptCommand({ key: TEST_KEY, tenantId: 't1', token: offerToken(['s1'], []) }, { now: () => T0, runAudit });
  assert.deepEqual(posted, []);
  assert.deepEqual(await pendingIds(), [['t1', ['s1']]]);
  assert.ok(io.out.includes('✓ Beezi: could not reach Beezi to check what this workspace hides, so nothing was uploaded. '
    + 'The sessions stay waiting and upload on a later retry.'));
});

test('an ask-first offer shows and binds the kinds the run\'s own whoami hides, though the cached row hides nothing', async (t) => {
  one(t);
  const io = capture(t);
  const whoamiImpl = async () => ({ valid: true, tenants: [tenant('t1', 'Acme', ['repos'], OFFER)] });
  await offerCommand({ key: TEST_KEY }, deps({ null: listed([session('s1')]) }, { whoamiImpl, runPendingHistory: async () => { throw new Error('no upload'); } }).deps);
  assert.ok(io.out.includes('    ◆ folder and repository names'));
  assert.deepEqual(io.out.slice(-3), ['Q Upload this session to Acme?', offerLine('t1', ['s1'], 'no', ['repos']), 'offers=1']);
  assert.deepEqual((await offers()).t1.shownKinds, ['repos']);
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

// ── compressed rollouts this Node cannot read ──────────────────────────────────────────────

const SKIPPED_TWO = `  ${compressedSkippedLine(2)}`;

test('an offer with sessions to show still says how many compressed sessions were skipped, once', async (t) => {
  one(t);
  const io = capture(t);
  await offerCommand({ key: TEST_KEY }, deps({ null: listed([session('s1')], { compressedUnsupported: 2 }) }).deps);
  assert.equal(io.out.filter((line) => line === SKIPPED_TWO).length, 1);
  assert.ok(io.out.indexOf(SKIPPED_TWO) < io.out.indexOf('Q Upload this session to Acme?'));
});

test('an empty list says how many compressed sessions were skipped', async (t) => {
  one(t);
  const io = capture(t);
  await offerCommand({ key: TEST_KEY, past: true }, deps({ null: listed([], { compressedUnsupported: 2 }) }).deps);
  assert.deepEqual(io.out, ['✓ Beezi: everything is already uploaded.', SKIPPED_TWO, 'offers=0']);
});

test('a routed multi-workspace offer says how many compressed sessions were skipped once for the account', async (t) => {
  two(t);
  const io = capture(t);
  const h = deps(
    { t1: listed([session('s1')]), t2: listed([session('s2')]) },
    { planWorkspaceRuns: () => ({ ...plan(), compressedUnsupported: 2 }) },
  );
  await offerCommand({ key: TEST_KEY }, h.deps);
  assert.equal(io.out.filter((line) => line === SKIPPED_TWO).length, 1);
});

test('an upload result with skipped compressed sessions says how many', async (t) => {
  one(t);
  const io = capture(t);
  await offerCommand({ key: TEST_KEY }, deps({ null: listed([session('s1')]) }).deps);
  const runPendingHistory = async (key, d, options) => {
    options.onResult({ tenantId: 't1' }, { ...imported(1), compressedUnsupported: 2 });
    return [];
  };
  const code = await acceptCommand({ key: TEST_KEY, tenantId: 't1', token: offerToken(['s1'], []) }, { runPendingHistory });
  assert.equal(code, 0);
  assert.ok(io.out.includes(SKIPPED_TWO));
});

// ── one drainer: the upload worker (or a migration) holding the upload lock ─────────────────────

const UPLOAD_BUSY_TEXT = `✓ Beezi: Beezi is busy on this machine right now (a background upload or a data migration), so nothing was synced this time. Run \`${naming.syncCommand()}\` again in a minute.`;

test('an upload-busy run is its own notice: busy uploading, and run sync again', async (t) => {
  one(t);
  const io = capture(t);
  const done = await offerCommand({ key: TEST_KEY }, deps({ null: { ok: true, reason: 'upload-busy', lastError: 'the background upload is sending' } }).deps);
  assert.equal(done.status, 0);
  assert.deepEqual(io.out, [UPLOAD_BUSY_TEXT, 'offers=0']);
});

test('a busy upload lock stops a multi-workspace offer after the first workspace instead of waiting once per workspace', async (t) => {
  two(t);
  const io = capture(t);
  const h = deps({ t1: { ok: true, reason: 'upload-busy' }, t2: listed([session('s2')]) });
  await offerCommand({ key: TEST_KEY }, h.deps);
  assert.deepEqual(h.audits.map((o) => o.tenantId), ['t1']);
  assert.equal(io.out.filter((line) => line === UPLOAD_BUSY_TEXT).length, 1);
  assert.ok(!io.out.some((line) => line.startsWith('offer ')));
});
