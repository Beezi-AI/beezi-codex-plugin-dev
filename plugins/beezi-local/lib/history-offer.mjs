// Pure helpers for the past-sessions offer: its record, token, whether to show, scan or skip it, and its K7 copy; no I/O.
import crypto from 'crypto';
import { PastSessionsChoice, anonymizationFor, isLaterChange, pastSessionsOf } from './anonymization.mjs';
import { HISTORY_RETRY_MS } from './pending-history.mjs';
import { naming } from './paths.mjs';
import { TrackingMode } from './tracking.mjs';
import { isMultiTenant } from './workspace.mjs';

export const OfferState = Object.freeze({ READY: 'ready', DECLINED: 'declined', SETTLED: 'settled', RESCAN: 'rescan' });

export const OfferCheck = Object.freeze({
  SKIP_CHOICE: 'skip-choice', TRACKING_OFF: 'tracking-off', DECLINED: 'declined', SETTLED: 'settled',
  SHOW: 'show', SCAN_WAIT: 'scan-wait', SCAN: 'scan',
});

const MAX_FOLDERS = 5;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TITLE_NOTE = ' (the thread title Codex shows, which is the start of your first message until Codex names the thread)';
const SUBAGENT_TEXT = 'subagent names';
// L3 / L4 items in K7 order, each with the kind that hides it.
const FIELD_NAMES = [
  ['repos', 'folder and repository names'],
  ['branches', 'branch names'],
  ['hosts', 'computer name'],
  ['accounts', 'account email'],
];

const orNull = (value) => (value == null ? null : value);

export const CHANGED_LINE = `✗ Beezi: these past sessions changed after the question was shown, so nothing was uploaded. Run \`${naming.syncCommand()}\` to see them again.`;

// sha256 over the shown ids, newline-joined, then NUL and the sorted shown kinds, comma-joined; cut to 12 hex characters.
export function offerToken(ids, shownKinds) {
  const preimage = `${ids.join('\n')}\0${shownKinds.slice().sort().join(',')}`;
  return crypto.createHash('sha256').update(preimage).digest('hex').slice(0, 12);
}

// The account's offer records by workspace; {} when absent or malformed.
export function offerMapOf(row) {
  const offers = row.historyOffers;
  return offers != null && typeof offers === 'object' && !Array.isArray(offers) ? offers : {};
}

export function offerRecordOf(row, tenantId) {
  return orNull(offerMapOf(row)[tenantId]);
}

export function offerIdsOf(list) {
  return Array.isArray(list) ? list.filter((id) => typeof id === 'string') : [];
}

export function changedAtOf(row, tenantId) {
  return orNull(pastSessionsOf(anonymizationFor(row, tenantId)).changedAt);
}

// Only a linked one-workspace account whose choice is not skip has its own tracking file to read.
export function offerTrackingDisabled(row, block, readTrackingState) {
  if (isMultiTenant(row) || row.key == null || pastSessionsOf(block).choice === PastSessionsChoice.SKIP) return false;
  const state = readTrackingState(row.key);
  return state != null && state.trackingMode === TrackingMode.DISABLED;
}

// A scan stamped within the retry window, and not in the future, is still running or just ran.
function scanPending(scanAt, nowMs) {
  const scanMs = typeof scanAt === 'string' ? Date.parse(scanAt) : NaN;
  return Number.isFinite(scanMs) && scanMs <= nowMs && nowMs - scanMs < HISTORY_RETRY_MS;
}

// Cheapest first: the choice, tracking, a remembered decline or settle, a ready offer, then a scan.
export function offerCheck({ block, trackingDisabled, record, nowMs }) {
  const past = pastSessionsOf(block);
  if (past.choice === PastSessionsChoice.SKIP) return OfferCheck.SKIP_CHOICE;
  if (trackingDisabled) return OfferCheck.TRACKING_OFF;
  const current = orNull(past.changedAt);
  if (record != null) {
    const stale = isLaterChange(current, record.changedAt);
    if (record.state === OfferState.DECLINED && !stale) return OfferCheck.DECLINED;
    if (record.state === OfferState.SETTLED && !stale) return OfferCheck.SETTLED;
    if (record.state === OfferState.READY && orNull(record.changedAt) === current) return OfferCheck.SHOW;
    if (scanPending(record.scanAt, nowMs)) return OfferCheck.SCAN_WAIT;
  }
  return OfferCheck.SCAN;
}

// `a`, `a and b`, `a, b and c`.
function joinList(items) {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// "1 session" / "2 sessions": naive -s pluralisation, which is all the counted nouns here need.
export function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// `D Mon` in local time, with the year when the range crosses one.
function dateRange(firstMs, lastMs) {
  const first = new Date(firstMs);
  const last = new Date(lastMs);
  const withYear = first.getFullYear() !== last.getFullYear();
  const label = (d) => `${d.getDate()} ${MONTHS[d.getMonth()]}${withYear ? ` ${d.getFullYear()}` : ''}`;
  return sameDay(first, last) ? `on ${label(first)}` : `from ${label(first)} to ${label(last)}`;
}

function folderClause(folders) {
  const distinct = folders.filter((f, i) => folders.indexOf(f) === i);
  if (distinct.length === 0) return '';
  const shown = distinct.slice(0, MAX_FOLDERS);
  const more = distinct.length - shown.length;
  const names = more > 0 ? shown.concat([`${more} more`]) : shown;
  return ` in ${plural(distinct.length, 'folder')}: ${joinList(names)}`;
}

// The K7 lines L1–L5 for one workspace; `folders` are local base names, `kinds` the workspace's hidden kinds.
export function offerLines({ n, firstMs, lastMs, folders, kinds }) {
  const hidden = FIELD_NAMES.filter(([kind]) => kinds.indexOf(kind) !== -1).map(([, name]) => name);
  const shown = FIELD_NAMES.filter(([kind]) => kinds.indexOf(kind) === -1).map(([, name]) => name);
  const lines = [
    `Beezi found ${plural(n, 'past Codex session')} ${dateRange(firstMs, lastMs)}${folderClause(folders)}.`,
    'Uploading sends dates, duration, models, tokens, cost, and tool, skill and MCP names for each session.',
  ];
  if (shown.length > 0) lines.push(`Sent as they are: ${joinList(shown)}.`);
  if (hidden.length > 0) lines.push(`Hidden by your workspace: ${joinList(hidden)}. Beezi receives made-up names instead.`);
  lines.push(kinds.indexOf('sessions') !== -1
    ? `Session titles, error messages and ${SUBAGENT_TEXT} are not sent.`
    : `Also sent as written: session titles${TITLE_NOTE}, error messages (up to 1,000 characters) and ${SUBAGENT_TEXT}.`);
  return lines;
}

export function questionText(n, workspace) {
  return n === 1 ? `Upload this session to ${workspace}?` : `Upload these ${n} sessions to ${workspace}?`;
}

// D, or DA for an Audit workspace.
export function declineLine(audit) {
  const command = `\`${naming.syncCommand()}\``;
  return audit
    ? `Your audit reads only past sessions, so it stays empty until you upload. Run ${command} any time.`
    : `Not uploaded. Run ${command} any time to upload them.`;
}
