import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OfferState, OfferCheck, offerCheck, offerLines, questionText, declineLine, plural, CHANGED_LINE,
  offerToken, offerRecordOf, offerIdsOf, changedAtOf, offerTrackingDisabled,
} from '../lib/history-offer.mjs';
import { parseAnonymization } from '../lib/anonymization.mjs';

const NOW = Date.parse('2026-10-22T12:00:00.000Z');
const MIN = 60 * 1000;
const A = '2026-10-01T00:00:00.000Z';
const B = '2026-10-02T00:00:00.000Z';
const block = (changedAt, choice = 'offer') => parseAnonymization(null, 't1', { choice, changedAt });
const check = (current, record, extra = {}) => offerCheck({ block: block(current), trackingDisabled: false, record, nowMs: NOW, ...extra });
const local = (y, m, d) => new Date(y, m - 1, d, 12).getTime();
const L2 = 'Uploading sends dates, duration, models, tokens, cost, and tool, skill and MCP names for each session.';
const L5A = 'Also sent as written: session titles (the thread title Codex shows, which is the start of your first message until Codex names the thread), error messages (up to 1,000 characters) and subagent names.';
const L5B = 'Session titles, error messages and subagent names are not sent.';
const SUMMARY = { n: 132, firstMs: local(2026, 8, 12), lastMs: local(2026, 10, 21), folders: ['payments-api', 'web', 'infra', 'notes'], workspace: 'Acme' };

test('offerCheck: a skip choice wins over any record', () => {
  const record = { state: OfferState.READY, changedAt: null };
  assert.equal(offerCheck({ block: block(null, 'skip'), trackingDisabled: true, record, nowMs: NOW }), OfferCheck.SKIP_CHOICE);
});

test('offerCheck: disabled tracking comes next', () => {
  assert.equal(check(null, { state: OfferState.READY, changedAt: null }, { trackingDisabled: true }), OfferCheck.TRACKING_OFF);
});

test('offerCheck: a decline holds until changedAt moves later', () => {
  const declined = (changedAt) => ({ state: OfferState.DECLINED, changedAt });
  assert.equal(check(null, declined(null)), OfferCheck.DECLINED);
  assert.equal(check(A, declined(null)), OfferCheck.SCAN);
  assert.equal(check(A, declined(A)), OfferCheck.DECLINED);
  assert.equal(check(B, declined(A)), OfferCheck.SCAN);
  assert.equal(check(A, declined(B)), OfferCheck.DECLINED);
});

test('offerCheck: settled under the same changedAt stays settled', () => {
  assert.equal(check(A, { state: OfferState.SETTLED, changedAt: A }), OfferCheck.SETTLED);
});

test('offerCheck: a ready offer under the current changedAt is shown, a stale one is scanned again', () => {
  assert.equal(check(A, { state: OfferState.READY, changedAt: A }), OfferCheck.SHOW);
  assert.equal(check(null, { state: OfferState.READY, changedAt: null }), OfferCheck.SHOW);
  assert.equal(check(B, { state: OfferState.READY, changedAt: A }), OfferCheck.SCAN);
});

test('offerCheck: a scan stamped within the hour waits; an older one or none scans', () => {
  const rescan = (ago) => ({ state: OfferState.RESCAN, changedAt: null, scanAt: new Date(NOW - ago).toISOString() });
  assert.equal(check(null, rescan(10 * MIN)), OfferCheck.SCAN_WAIT);
  assert.equal(check(null, rescan(120 * MIN)), OfferCheck.SCAN);
  assert.equal(check(null, null), OfferCheck.SCAN);
  assert.equal(offerCheck({ block: null, trackingDisabled: false, record: null, nowMs: NOW }), OfferCheck.SCAN);
});

test('offerLines: the K7 summary with three kinds hidden', () => {
  assert.deepEqual(offerLines({ ...SUMMARY, kinds: ['repos', 'branches', 'hosts'] }), [
    'Beezi found 132 past Codex sessions from 12 Aug to 21 Oct in 4 folders: payments-api, web, infra and notes.',
    L2,
    'Sent as they are: account email.',
    'Hidden by your workspace: folder and repository names, branch names and computer name. Beezi receives made-up names instead.',
    L5A,
  ]);
});

test('offerLines: every kind on drops L3 and says what is not sent', () => {
  const lines = offerLines({ ...SUMMARY, kinds: ['repos', 'branches', 'sessions', 'hosts', 'accounts'] });
  assert.deepEqual(lines.slice(2), [
    'Hidden by your workspace: folder and repository names, branch names, computer name and account email. Beezi receives made-up names instead.',
    L5B,
  ]);
});

test('offerLines: every kind off drops L4', () => {
  assert.deepEqual(offerLines({ ...SUMMARY, kinds: [] }).slice(2), [
    'Sent as they are: folder and repository names, branch names, computer name and account email.',
    L5A,
  ]);
});

test('offerLines: more than five folders name five, then the rest as a count', () => {
  const lines = offerLines({ ...SUMMARY, folders: ['a', 'b', 'c', 'b', 'd', 'e', 'f', 'g'], kinds: [] });
  assert.equal(lines[0], 'Beezi found 132 past Codex sessions from 12 Aug to 21 Oct in 7 folders: a, b, c, d, e and 2 more.');
});

test('offerLines: a range across a year names both years', () => {
  const lines = offerLines({ ...SUMMARY, firstMs: local(2026, 12, 20), lastMs: local(2027, 1, 3), kinds: [] });
  assert.equal(lines[0], 'Beezi found 132 past Codex sessions from 20 Dec 2026 to 3 Jan 2027 in 4 folders: payments-api, web, infra and notes.');
});

test('offerLines: one session on one day in one folder', () => {
  const lines = offerLines({ n: 1, firstMs: local(2026, 9, 3), lastMs: local(2026, 9, 3) + 60 * MIN, folders: ['web'], kinds: [], workspace: 'Acme' });
  assert.equal(lines[0], 'Beezi found 1 past Codex session on 3 Sep in 1 folder: web.');
});

test('offerLines: no folders drops the folder clause', () => {
  const lines = offerLines({ ...SUMMARY, folders: [], kinds: [] });
  assert.equal(lines[0], 'Beezi found 132 past Codex sessions from 12 Aug to 21 Oct.');
});

test('plural adds -s to the singular for any count but one', () => {
  assert.equal(plural(1, 'past Codex session'), '1 past Codex session');
  assert.equal(plural(132, 'folder'), '132 folders');
});

test('questionText: plural and single', () => {
  assert.equal(questionText(132, 'Acme'), 'Upload these 132 sessions to Acme?');
  assert.equal(questionText(1, 'Acme'), 'Upload this session to Acme?');
});

test('declineLine: D, and DA for an Audit workspace', () => {
  assert.equal(declineLine(false), 'Not uploaded. Run `$beezi:sync` any time to upload them.');
  assert.ok(declineLine(true).startsWith('Your audit reads only past sessions'));
  assert.ok(declineLine(true).endsWith('Run `$beezi:sync` any time.'));
});

test('offerToken: the pinned cross-plugin vector, id-order-sensitive, kind-order-free, 12 hex characters', () => {
  assert.equal(offerToken(['s1', 's2'], ['repos', 'hosts']), '02f0d14e702c');
  assert.equal(offerToken(['s1', 's2'], ['hosts', 'repos']), '02f0d14e702c');
  assert.notEqual(offerToken(['s1', 's2'], []), offerToken(['s2', 's1'], []));
  assert.notEqual(offerToken(['s1'], ['hosts']), offerToken(['s1'], []));
  for (const ids of [['s1'], ['s1', 's2'], ['s2', 's1'], []]) assert.match(offerToken(ids, []), /^[0-9a-f]{12}$/);
});

test('CHANGED_LINE names the sync command', () => {
  assert.equal(
    CHANGED_LINE,
    '✗ Beezi: these past sessions changed after the question was shown, so nothing was uploaded. Run `$beezi:sync` to see them again.',
  );
});

test('offerRecordOf and offerIdsOf read malformed fields as absent', () => {
  const record = { state: OfferState.DECLINED };
  assert.equal(offerRecordOf({ historyOffers: { t1: record } }, 't1'), record);
  for (const historyOffers of [undefined, null, [], 'x', { t2: record }]) assert.equal(offerRecordOf({ historyOffers }, 't1'), null);
  assert.deepEqual(offerIdsOf(['s1', 2, null, 's2']), ['s1', 's2']);
  assert.deepEqual(offerIdsOf('s1'), []);
});

test('changedAtOf is the workspace\'s past-sessions changedAt, else null', () => {
  const row = { tenants: [{ id: 't1', anonymization: block(A) }, { id: 't2' }] };
  assert.equal(changedAtOf(row, 't1'), A);
  assert.equal(changedAtOf(row, 't2'), null);
});

test('offerTrackingDisabled reads only for a linked one-workspace account whose choice is not skip', () => {
  const reads = [];
  const read = (key) => { reads.push(key); return { trackingMode: 'disabled' }; };
  const one = { key: 'k1', tenants: [{ id: 't1' }] };
  assert.equal(offerTrackingDisabled(one, block(A), read), true);
  assert.equal(offerTrackingDisabled(one, block(A, 'skip'), read), false);
  assert.equal(offerTrackingDisabled({ ...one, key: null }, block(A), read), false);
  assert.equal(offerTrackingDisabled({ key: 'k1', tenants: [{ id: 't1' }, { id: 't2' }] }, block(A), read), false);
  assert.deepEqual(reads, ['k1']);
  assert.equal(offerTrackingDisabled(one, block(A), () => ({ trackingMode: 'live' })), false);
});

test('the offer record helpers are defined once in lib/, in history-offer.mjs', () => {
  const lib = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib');
  const banned = [/\boffersOf\b/, /\brecordOf\b/, /\bofferRecord\(/, /\bfunction idsOf\b/, /\bfunction currentChangedAt\b/, /\bfunction trackingDisabled\b/];
  for (const name of fs.readdirSync(lib).filter((f) => f.endsWith('.mjs') && f !== 'history-offer.mjs')) {
    const source = fs.readFileSync(path.join(lib, name), 'utf-8');
    for (const pattern of banned) assert.doesNotMatch(source, pattern, `${name} ${pattern}`);
  }
});
