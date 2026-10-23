import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  ANONYMIZATION_KEY_MISSING, PastSessionsChoice, isId, PRIVATE_MARK, parseAnonymization, anonymizationFor, sessionAnonymization, kindsOf, hasKind, pastSessionsOf,
  isLaterChange, privateKinds, hidesSessions, markPrivate, wireKinds, reportForWire, withoutMarker, withKinds,
} from '../lib/anonymization.mjs';
import { KINDS, Kind, PRIVATE_MARK as DEFINED_MARK, anonymizeReport } from '../lib/anonymize.mjs';
import { whoami } from '../lib/whoami.mjs';
import { addAccount, getAccount, linkedSessions } from '../lib/accounts.mjs';
import { setCredentials } from '../lib/credentials.mjs';
import { makeHome, fakeKeyring, credentialBlob } from '../tools/account-fixtures.mjs';

const KEY = 'a'.repeat(64);
const OTHER_KEY = 'b'.repeat(64);
const OFFER = { choice: 'offer', changedAt: null };
const kindsMap = (on) => Object.fromEntries(KINDS.map((kind) => [kind, on.includes(kind)]));
const block = (tenantId, on, key = KEY, machineName = null, pastSessions = OFFER) => (
  { tenantId, kinds: kindsMap(on), key, machineName, pastSessions }
);
const NONE = [];
const ALL_OFF = kindsMap(NONE);
const ALL_ON = kindsMap(KINDS);

test('PRIVATE_MARK is the local marker key, defined once and re-exported', () => {
  assert.equal(PRIVATE_MARK, 'beeziPrivate');
  assert.equal(PRIVATE_MARK, DEFINED_MARK);
});

test('parseAnonymization answers null only when both blocks are absent', () => {
  assert.equal(parseAnonymization(undefined, 't1', undefined), null);
  assert.equal(parseAnonymization(null, 't1', null), null);
});

test('parseAnonymization with only pastSessions has no kinds and no key', () => {
  const parsed = parseAnonymization(undefined, 't1', { choice: 'skip', changedAt: '2026-10-20T00:00:00Z' });
  assert.deepEqual(parsed, {
    tenantId: 't1', kinds: ALL_OFF, key: null, machineName: null,
    pastSessions: { choice: 'skip', changedAt: '2026-10-20T00:00:00Z' },
  });
});

test('parseAnonymization reads a malformed block as all five kinds on', () => {
  const malformed = [
    'x', true, 1, [], {}, { enabled: false, key: KEY }, { kinds: 'all' }, { kinds: [] }, { kinds: { repos: true } },
    { kinds: { repos: 'yes', branches: true, sessions: true, hosts: true, accounts: true } },
    { kinds: { repos: false, branches: 'x', sessions: false, hosts: false, accounts: false } },
  ];
  for (const raw of malformed) assert.deepEqual(parseAnonymization(raw, 't1').kinds, ALL_ON, JSON.stringify(raw));
});

test('parseAnonymization keeps a valid key on a malformed block and drops it on a non-object', () => {
  assert.equal(parseAnonymization({ enabled: false, key: KEY }, 't1').key, KEY);
  assert.equal(parseAnonymization('x', 't1').key, null);
});

test('parseAnonymization keeps a well-formed block', () => {
  const raw = {
    kinds: { repos: true, branches: false, sessions: false, hosts: false, accounts: false },
    key: KEY, machineName: 'amber-fox-123',
  };
  const parsed = parseAnonymization(raw, 't1', { choice: 'offer', changedAt: null });
  assert.deepEqual(parsed, block('t1', ['repos'], KEY, 'amber-fox-123'));
  assert.deepEqual(kindsOf(parsed), ['repos']);
  assert.equal(parsed.key, KEY);
});

test('parseAnonymization drops a malformed key and keeps the rest', () => {
  for (const key of [null, 'ABC', 'A'.repeat(64), 'a'.repeat(63), `${'a'.repeat(64)}0`, 'g'.repeat(64), 42]) {
    assert.equal(parseAnonymization({ kinds: ALL_OFF, key }, 't1').key, null, String(key));
  }
});

test('parseAnonymization collapses machineName to one line and requires a string tenant id', () => {
  const parsed = parseAnonymization({ kinds: ALL_OFF, key: KEY, machineName: 'amber\nfox\u2028123 ' }, 7);
  assert.equal(parsed.machineName, 'amber fox 123');
  assert.equal(parsed.tenantId, null);
});

test('parseAnonymization reads an absent or malformed pastSessions as offer, never changed', () => {
  for (const raw of [undefined, null, 'x', { choice: 'maybe' }, { changedAt: '2026-10-20T00:00:00Z' }]) {
    assert.deepEqual(parseAnonymization({ kinds: ALL_OFF }, 't1', raw).pastSessions, OFFER, JSON.stringify(raw));
  }
  assert.deepEqual(
    parseAnonymization({ kinds: ALL_OFF }, 't1', { choice: 'skip', changedAt: 'not a date' }).pastSessions,
    { choice: 'skip', changedAt: null },
  );
});

test('kindsOf lists the kinds that are on in KINDS order, fails closed on a present block without valid kinds', () => {
  assert.deepEqual(kindsOf(block('A', ['accounts', 'repos'])), ['repos', 'accounts']);
  assert.deepEqual(kindsOf(block('A', NONE)), []);
  assert.deepEqual(kindsOf(null), []);
  assert.deepEqual(kindsOf({ tenantId: 't', enabled: true, key: KEY }), KINDS.slice());
  assert.deepEqual(kindsOf({ tenantId: 't', kinds: { repos: 'yes' } }), KINDS.slice());
});

test('KINDS lists the Kind values in their wire order', () => {
  assert.deepEqual(KINDS, [Kind.REPOS, Kind.BRANCHES, Kind.SESSIONS, Kind.HOSTS, Kind.ACCOUNTS]);
  assert.deepEqual(KINDS, ['repos', 'branches', 'sessions', 'hosts', 'accounts']);
});

test('the past-sessions choices and the key-missing reason keep their wire values', () => {
  assert.deepEqual({ ...PastSessionsChoice }, { OFFER: 'offer', SKIP: 'skip' });
  assert.equal(ANONYMIZATION_KEY_MISSING, 'anonymization-key-missing');
});

test('isId is true only for a non-empty string', () => {
  assert.equal(isId('t1'), true);
  assert.equal(isId(''), false);
  assert.equal(isId(null), false);
  assert.equal(isId(3), false);
});

const LIB = new URL('../lib/', import.meta.url);
const libSources = () => fs.readdirSync(LIB).filter((name) => name.endsWith('.mjs'))
  .map((name) => ({ name, source: fs.readFileSync(new URL(name, LIB), 'utf8') }));

test('lib/ spells the key-missing reason and the kinds through their constants', () => {
  for (const { name, source } of libSources()) {
    if (name !== 'anonymization.mjs') {
      assert.ok(!/['"`]anonymization-key-missing['"`]/.test(source), `${name} spells the key-missing reason`);
    }
    // One level of nested parens covers hasKind(sessionAnonymization(x), …).
    assert.ok(!/hasKind\((?:[^()]|\([^()]*\))*?,\s*['"`]/.test(source), `${name} passes hasKind a string literal`);
  }
});

test('isId is defined once in lib/, in anonymization.mjs', () => {
  const definitions = libSources().flatMap(({ name, source }) =>
    (source.match(/(const|function) (isId|isTenantId)\b/g) || []).map(() => name));
  assert.deepEqual(definitions, ['anonymization.mjs']);
});

test('hasKind answers for one kind', () => {
  assert.equal(hasKind(block('A', ['sessions']), 'sessions'), true);
  assert.equal(hasKind(block('A', ['repos']), 'sessions'), false);
  assert.equal(hasKind(null, 'repos'), false);
});

test('pastSessionsOf reads the stored choice and defaults to offer', () => {
  const skip = { choice: 'skip', changedAt: '2026-10-20T00:00:00Z' };
  assert.deepEqual(pastSessionsOf(block('A', NONE, KEY, null, skip)), skip);
  assert.deepEqual(pastSessionsOf(null), OFFER);
  assert.deepEqual(pastSessionsOf({ kinds: ALL_OFF }), OFFER);
});

test('isLaterChange is true only for a parseable change newer than the stored one', () => {
  const A = '2026-10-01T00:00:00Z';
  assert.equal(isLaterChange(null, null), false);
  assert.equal(isLaterChange(A, null), true);
  assert.equal(isLaterChange(A, A), false);
  assert.equal(isLaterChange('2026-10-02T00:00:00Z', A), true);
  assert.equal(isLaterChange(A, '2026-10-02T00:00:00Z'), false);
  assert.equal(isLaterChange(null, A), false);
  assert.equal(isLaterChange('garbage', null), false);
});

test('anonymizationFor with a tenant id reads that entry, and the top level only for its own id', () => {
  const session = {
    anonymization: block('t-web', KINDS),
    tenants: [{ id: 'A', anonymization: block('A', KINDS) }, { id: 'B', anonymization: block('B', NONE) }, { id: 'C' }],
  };
  assert.deepEqual(anonymizationFor(session, 'A'), block('A', KINDS));
  assert.deepEqual(anonymizationFor(session, 'B'), block('B', NONE));
  assert.equal(anonymizationFor(session, 'C'), null);
  assert.equal(anonymizationFor(session, 'missing'), null);
  assert.deepEqual(anonymizationFor(session, 't-web'), block('t-web', KINDS));
  assert.equal(anonymizationFor({ anonymization: block(null, KINDS) }, 't-web'), null);
});

test('anonymizationFor headerless reads the single tenant entry, else the top-level block', () => {
  const top = block('t-web', KINDS);
  assert.deepEqual(anonymizationFor({ anonymization: top, tenants: [{ id: 'A', anonymization: block('A', NONE) }] }, null), block('A', NONE));
  assert.deepEqual(anonymizationFor({ anonymization: top, tenants: null }, null), top);
  assert.deepEqual(anonymizationFor({ anonymization: top, tenants: [{ id: 'A' }, { id: 'B' }] }, null), top);
  assert.equal(anonymizationFor({ anonymization: top, tenants: [{ id: 'B' }] }, null), null);
  assert.equal(anonymizationFor(null, null), null);
});

test('sessionAnonymization reads the session\'s own tenant, and an empty tenant id as headerless', () => {
  const session = { anonymization: block('t-web', NONE), tenants: [{ id: 'A', anonymization: block('A', KINDS) }, { id: 'B' }] };
  assert.deepEqual(sessionAnonymization({ ...session, tenantId: 'A' }), block('A', KINDS));
  assert.deepEqual(sessionAnonymization({ ...session, tenantId: '' }), block('t-web', NONE));
  assert.equal(sessionAnonymization(null), null);
});

test('withoutMarker drops only the marker and keeps the key order', () => {
  const payload = { segmentId: 's1:1-4', [PRIVATE_MARK]: { A: ['repos'] }, remote: 'r' };
  assert.equal(JSON.stringify(withoutMarker(payload)), JSON.stringify({ segmentId: 's1:1-4', remote: 'r' }));
  assert.deepEqual(payload[PRIVATE_MARK], { A: ['repos'] });
});

test('a whoami body round-trips into the accounts.json row and the linked session', async (t) => {
  makeHome(t);
  const deps = { run: fakeKeyring().run, platform: 'darwin', checkEnvironment: () => ({ status: 'ok' }) };
  const accountKey = 'a1b2c3d4';
  const skip = { choice: 'skip', changedAt: '2026-10-20T00:00:00Z' };
  const who = await whoami({ token: 'tok', clientId: 'c-1' }, {
    base: 'https://api.test',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        email: 'dev@acme.com',
        tenantId: 'A',
        anonymization: { kinds: ALL_ON, key: KEY, machineName: 'amber-fox-123' },
        pastSessions: skip,
        tenants: [
          { id: 'A', name: 'Acme', anonymization: { kinds: ALL_ON, key: KEY }, pastSessions: skip },
          { id: 'B', name: 'Beta', anonymization: { kinds: ALL_OFF, key: OTHER_KEY } },
        ],
      }),
    }),
  });
  assert.deepEqual(who.anonymization, block('A', KINDS, KEY, 'amber-fox-123', skip));
  assert.deepEqual(who.tenants.map((e) => e.anonymization), [block('A', KINDS, KEY, null, skip), block('B', NONE, OTHER_KEY)]);

  await setCredentials(accountKey, credentialBlob({ client_id: 'c-1' }), deps);
  await addAccount({
    key: accountKey, email: who.email, tenantId: who.tenantId,
    tenants: who.tenants, anonymization: who.anonymization, clientId: 'c-1',
  });

  const row = await getAccount(accountKey);
  assert.deepEqual(row.anonymization, who.anonymization);
  assert.deepEqual(row.tenants, who.tenants);

  const [session] = await linkedSessions(deps);
  assert.deepEqual(session.tenants, who.tenants);
  assert.deepEqual(pastSessionsOf(anonymizationFor(session, 'A')), skip);
  assert.deepEqual(anonymizationFor(session, 'B'), block('B', NONE, OTHER_KEY));
});

const REPORT = {
  segmentId: 's1:1-4', sessionId: 's1', remote: 'https://github.com/acme/api.git', branch: 'main',
  session_name: 'fix the login bug', agent_name: 'reviewer', account_email: 'Dev@Acme.com', token_total: 15,
};
const solo = (anonBlock) => ({ key: 'k1', tenants: [{ id: 'A', anonymization: anonBlock }] });
const pair = (a, b) => ({ key: 'k1', tenants: [{ id: 'A', anonymization: a }, { id: 'B', anonymization: b }] });
const isAnon = (kind) => (value) => typeof value === 'string' && value.startsWith(`anon:${kind}:`);

test('privateKinds maps each target and hold workspace to its kinds, once each, skipping empty ones', () => {
  const session = pair(block('A', ['branches', 'repos']), block('B', NONE));
  assert.deepEqual(privateKinds([{ session, targets: ['A', 'B'], hold: [] }]), { A: ['repos', 'branches'] });
  assert.deepEqual(privateKinds([{ session, targets: [], hold: ['A', 'B'] }]), { A: ['repos', 'branches'] });
  assert.deepEqual(privateKinds([{ session, targets: ['A'], hold: ['A'] }, { session, targets: ['A'], hold: [] }]), { A: ['repos', 'branches'] });
  assert.deepEqual(privateKinds([{ session: pair(block('A', NONE), block('B', NONE)), targets: ['A', 'B'], hold: [] }]), {});
});

test('privateKinds names a headerless target by its resolved block', () => {
  assert.deepEqual(privateKinds([{ session: solo(block('A', ['hosts'])), targets: [null], hold: [] }]), { A: ['hosts'] });
  assert.deepEqual(privateKinds([{ session: { anonymization: block(null, KINDS) }, targets: [null], hold: [] }]), {});
  assert.deepEqual(privateKinds([{ session: { key: 'k1' }, targets: [null], hold: [] }]), {});
});

test('hidesSessions is true when some target or hold workspace has sessions on, headerless included', () => {
  const session = pair(block('A', ['repos']), block('B', ['sessions']));
  assert.equal(hidesSessions([{ session, targets: ['A'], hold: [] }]), false);
  assert.equal(hidesSessions([{ session, targets: ['A', 'B'], hold: [] }]), true);
  assert.equal(hidesSessions([{ session, targets: [], hold: ['B'] }]), true);
  assert.equal(hidesSessions([{ session: { anonymization: block(null, ['sessions']) }, targets: [null], hold: [] }]), true);
  assert.equal(hidesSessions([]), false);
});

test('markPrivate unions kinds per tenant into the marker and returns a copy', () => {
  const marked = { ...REPORT, beeziPrivate: { A: ['repos'] } };
  const out = markPrivate(marked, { A: ['branches'], B: ['hosts'] });
  assert.deepEqual(out.beeziPrivate, { A: ['repos', 'branches'], B: ['hosts'] });
  assert.deepEqual(marked.beeziPrivate, { A: ['repos'] }, 'the input is not mutated');
  assert.deepEqual(markPrivate(REPORT, { A: ['repos'] }), { ...REPORT, beeziPrivate: { A: ['repos'] } });
  assert.deepEqual(markPrivate(marked, {}).beeziPrivate, { A: ['repos'] }, 'an existing marker is kept');
});

test('markPrivate reads a legacy array marker as all five kinds for each id', () => {
  assert.deepEqual(markPrivate({ ...REPORT, beeziPrivate: ['A'] }, { B: ['repos'] }).beeziPrivate, { A: KINDS.slice(), B: ['repos'] });
  assert.deepEqual(markPrivate(REPORT, ['A']).beeziPrivate, { A: KINDS.slice() });
});

test('markPrivate omits the key when the union is empty and drops unknown ids and kinds', () => {
  const out = markPrivate({ ...REPORT, beeziPrivate: { A: [] } }, { '': ['repos'], B: ['nope'] });
  assert.equal(Object.prototype.hasOwnProperty.call(out, 'beeziPrivate'), false);
  assert.deepEqual(out, REPORT);
});

test('wireKinds unions the marker with the current kinds, and reads a legacy array marker as all five', () => {
  const session = solo(block('A', ['branches']));
  assert.deepEqual(wireKinds({ ...REPORT, beeziPrivate: { A: ['repos'] } }, session, 'A'), ['repos', 'branches']);
  assert.deepEqual(wireKinds({ ...REPORT, beeziPrivate: ['A'] }, solo(block('A', NONE)), 'A'), KINDS.slice());
  assert.deepEqual(wireKinds({ ...REPORT, beeziPrivate: { B: ['repos'] } }, solo(block('A', NONE)), 'A'), []);
});

test('reportForWire applies a queued kind and a kind turned on later, both', () => {
  const session = { key: 'k1', tenants: [{ id: 't1', anonymization: block('t1', ['branches']) }] };
  const marked = { ...REPORT, beeziPrivate: { t1: ['repos'] } };
  for (const tenantId of ['t1', null]) {
    const out = reportForWire(marked, session, tenantId);
    assert.ok(isAnon('repo')(out.remote), out.remote);
    assert.ok(isAnon('branch')(out.branch), out.branch);
    assert.equal(out.session_name, REPORT.session_name);
    assert.equal(out.agent_name, REPORT.agent_name);
    assert.equal(out.account_email, REPORT.account_email);
    assert.equal('beeziPrivate' in out, false);
    assert.deepEqual(out, anonymizeReport(REPORT, KEY, ['repos', 'branches']));
  }
});

test('reportForWire drops a marked report whose workspace has no block, headerless or not', () => {
  const marked = { ...REPORT, beeziPrivate: { t1: ['repos'] } };
  assert.equal(reportForWire(marked, { key: 'k1', tenants: [{ id: 't1' }] }, null), null);
  assert.equal(reportForWire(marked, { key: 'k1', tenants: [{ id: 't1' }, { id: 't2' }] }, 't1'), null);
  assert.equal(reportForWire(marked, { key: 'k1', tenants: null }, null), null, 'an unresolved target takes every entry');
});

test('reportForWire answers null when kinds are on and there is no key', () => {
  assert.equal(reportForWire(REPORT, solo(block('A', ['repos'], null)), null), null);
  assert.equal(reportForWire({ ...REPORT, beeziPrivate: { A: ['hosts'] } }, solo(block('A', NONE, null)), 'A'), null);
});

test('reportForWire sends the payload unchanged without the marker when no kind applies', () => {
  assert.equal(JSON.stringify(reportForWire(REPORT, solo(block('A', NONE)), null)), JSON.stringify(REPORT));
  assert.equal(JSON.stringify(reportForWire(REPORT, { key: 'k1' }, null)), JSON.stringify(REPORT));
  const other = { ...REPORT, beeziPrivate: { A: ['repos'] } };
  assert.equal(JSON.stringify(reportForWire(other, pair(block('A', KINDS), block('B', NONE)), 'B')), JSON.stringify(REPORT));
});

test('withKinds adds the accepted kinds to the session\'s own workspace block, keeping its key', () => {
  const session = { key: 'k', tenantId: 't2', tenants: [{ id: 't1', anonymization: block('t1', ['hosts']) }, { id: 't2', anonymization: block('t2', ['repos']) }] };
  const out = withKinds(session, ['accounts', 'repos']);
  assert.deepEqual(kindsOf(sessionAnonymization(out)), ['repos', 'accounts']);
  assert.equal(sessionAnonymization(out).key, KEY);
  assert.deepEqual(kindsOf(anonymizationFor(out, 't1')), ['hosts']);
  assert.deepEqual(kindsOf(sessionAnonymization(session)), ['repos'], 'the input is not mutated');
});

test('withKinds on a session with no block hides the kinds with no key, so nothing goes up raw', () => {
  const out = withKinds({ key: 'k', tenants: [{ id: 't1' }] }, ['sessions']);
  const applied = sessionAnonymization(out);
  assert.deepEqual(kindsOf(applied), ['sessions']);
  assert.equal(applied.key, null);
  assert.equal(applied.tenantId, 't1');
});

test('withKinds keeps the session as it is when nothing is added', () => {
  const session = { key: 'k', anonymization: block(null, ['repos']) };
  assert.equal(withKinds(session, undefined), session);
  assert.equal(withKinds(session, []), session);
  assert.equal(withKinds(session, ['repos']), session);
  assert.deepEqual(kindsOf(sessionAnonymization(withKinds(session, ['hosts']))), ['repos', 'hosts']);
});

