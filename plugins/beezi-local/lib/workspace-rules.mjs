import os from 'os';
import { loadRepoMap, normPath, pathHasPrefix, resolveRepoForRouting } from './repo-map.mjs';
import { canonicalRemote } from './git.mjs';
import { isMultiTenant, isSingleTenant, joinTenantNames, tenantsOf, resolveTargets, readSessionWorkspace, newFoldersOf, initSessionWorkspace } from './workspace.mjs';
import { loadLedger, isImported } from './audit-ledger.mjs';
import { listAllRollouts } from './transcript-index-codex.mjs';
import { isLiveTrackingAllowed } from './tracking.mjs';
import { defaultRoute, kindWords, placeOfDir, routeOfDir, routeTarget, sameKey } from './route-describe.mjs';

export const ACTIVE_SESSION_WINDOW_MS = 30 * 60 * 1000;
export const MAX_SESSION_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const OUTSIDE_LABEL = 'outside a project';

function stringIds(value) {
  return Array.isArray(value) ? value.filter((id) => typeof id === 'string' && id !== '') : null;
}

// The key of every home (or above), / or temp directory: one askable place with its own rule.
export function outsideKey() {
  return { kind: 'outside', match: 'outside', label: OUTSIDE_LABEL };
}

function normalizeRule(raw, index) {
  if (raw == null || typeof raw !== 'object') return null;
  if (raw.kind === 'outside') {
    const ids = stringIds(raw.tenantIds);
    if (ids == null) return null;
    return { index, ...outsideKey(), tenantIds: ids, createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null };
  }
  if ((raw.kind !== 'repo' && raw.kind !== 'folder') || typeof raw.match !== 'string' || raw.match === '') return null;
  const tenantIds = stringIds(raw.tenantIds);
  if (tenantIds == null) return null;
  return {
    index,
    kind: raw.kind,
    match: raw.match,
    label: typeof raw.label === 'string' && raw.label !== '' ? raw.label : raw.match,
    tenantIds,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
  };
}

// The account's rules; `index` is the 1-based position in the stored list, so dropped entries leave gaps.
export function rulesOf(row) {
  if (row == null || !Array.isArray(row.workspaceRules)) return [];
  const out = [];
  row.workspaceRules.forEach((raw, i) => {
    const rule = normalizeRule(raw, i + 1);
    if (rule != null) out.push(rule);
  });
  return out;
}

// Whether a row's rules can route anything: always for multi-workspace, else only with at least one rule.
export function usesRules(row) {
  return isMultiTenant(row) || (isSingleTenant(row) && rulesOf(row).length > 0);
}

// One repo map load and one key per directory for a whole pass.
export function createRouteContext({ loadRepoMapImpl = loadRepoMap } = {}) {
  let map = null;
  return {
    map() {
      if (map == null) {
        try { map = loadRepoMapImpl(); } catch { map = null; }
        if (map == null) map = { version: 1, roots: {} };
      }
      return map;
    },
    keyCache: new Map(),
  };
}

function homePath() {
  return normPath(os.homedir());
}

const TEMP_ROOTS = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders'];

// `/`, a drive root, home or a folder above it would catch every session by prefix, and temp dirs hold throwaway sessions: these key as `outside`.
function isUnsafeKeyPath(p) {
  const n = normPath(p);
  if (n == null || n === '/' || /^[a-z]:\/?$/i.test(n)) return true;
  const temps = TEMP_ROOTS.concat([normPath(os.tmpdir())]);
  if (temps.some((t) => t != null && pathHasPrefix(n, t))) return true;
  const home = homePath();
  // Home inside it: home itself or an ancestor such as /Users.
  return home != null && pathHasPrefix(home, n);
}

export function displayPath(p) {
  const home = homePath();
  return home != null && pathHasPrefix(p, home) ? `~${p.slice(home.length)}` : p;
}

// The key a rule for this directory would use: its repo's canonical remote, else its repo root or the folder itself; home (or above), / and temp are `outside`; null only without a directory.
export function routeKeyForDir(dir, ctx) {
  const d = normPath(dir);
  if (d == null) return null;
  if (isUnsafeKeyPath(d)) return outsideKey();
  const context = ctx == null ? createRouteContext() : ctx;
  if (context.keyCache.has(d)) return context.keyCache.get(d);
  const found = resolveRepoForRouting(d, context.map());
  // A repo rooted at home (dotfiles) would key every session under it, so it counts as no repo.
  const inRepo = found.root != null && !isUnsafeKeyPath(found.root);
  const canon = inRepo ? canonicalRemote(found.remote) : null;
  let key;
  if (canon != null) {
    key = { kind: 'repo', match: canon, label: canon };
  } else {
    const folder = inRepo ? normPath(found.root) : d;
    key = { kind: 'folder', match: folder, label: displayPath(folder) };
  }
  context.keyCache.set(d, key);
  return key;
}

// A rule's short name: a repo's last path segment, a folder's basename, or "outside a project".
export function shortLabel(rule) {
  if (rule == null) return '';
  if (rule.kind === 'outside') return OUTSIDE_LABEL;
  const match = typeof rule.match === 'string' ? rule.match : '';
  const parts = match.replace(/\\/g, '/').split('/').filter((p) => p !== '');
  if (parts.length > 0) return parts[parts.length - 1];
  return typeof rule.label === 'string' && rule.label !== '' ? rule.label : match;
}

// A rule whose workspaces the account has all left is skipped (null); one stored with [] still matches.
export function usableIds(rule, members) {
  const ids = rule.tenantIds.filter((id) => members.indexOf(id) !== -1);
  return rule.tenantIds.length === 0 || ids.length > 0 ? ids : null;
}

function toRoute(rule, ids) {
  return { index: rule.index, kind: rule.kind, match: rule.match, label: rule.label, tenantIds: ids };
}

// The first usable repo rule for a canonical remote, or null.
function repoRoute(rules, members, canon) {
  for (const rule of rules) {
    if (rule.kind !== 'repo' || rule.match.toLowerCase() !== canon) continue;
    const ids = usableIds(rule, members);
    if (ids != null) return toRoute(rule, ids);
  }
  return null;
}

// The rule a queued report that records no directory follows, from its remote: routeForDir on this
// machine's known checkouts of that repo (so a folder rule applies as live routing applies it), when
// they agree; else the repo rule alone. Null when none.
export function routeForRemote(row, remote, ctx) {
  const canon = canonicalRemote(remote);
  if (canon == null || !isMultiTenant(row)) return null;
  const context = ctx == null ? createRouteContext() : ctx;
  const roots = context.map().roots || {};
  let found;
  let agreed = true;
  for (const root of Object.keys(roots)) {
    const entry = roots[root];
    if (entry == null || canonicalRemote(entry.origin) !== canon) continue;
    const route = routeForDir(row, root, context);
    if (found === undefined) found = route;
    else if ((found == null ? null : found.index) !== (route == null ? null : route.index)) agreed = false;
  }
  if (found !== undefined && agreed) return found;
  return repoRoute(rulesOf(row), tenantsOf(row).map((t) => t.id), canon);
}

// The rule this directory follows: the repo rule for its remote, else the longest folder prefix, else (home or above, / or temp only) the outside rule; tenantIds limited to current workspaces.
export function routeForDir(row, dir, ctx) {
  const rules = rulesOf(row);
  const tenants = tenantsOf(row);
  if (rules.length === 0 || tenants == null || tenants.length === 0) return null;
  const d = normPath(dir);
  if (d == null) return null;
  const members = tenants.map((t) => t.id);
  const usable = (rule) => usableIds(rule, members);
  if (rules.some((r) => r.kind === 'repo')) {
    const key = routeKeyForDir(d, ctx);
    if (key != null && key.kind === 'repo') {
      const route = repoRoute(rules, members, key.match);
      if (route != null) return route;
    }
  }
  const folders = rules
    .filter((r) => r.kind === 'folder' && pathHasPrefix(d, r.match))
    .sort((a, b) => normPath(b.match).length - normPath(a.match).length);
  for (const rule of folders) {
    const ids = usable(rule);
    if (ids != null) return toRoute(rule, ids);
  }
  // Never a catch-all: only directories no repo or folder rule could key reach it.
  if (!isUnsafeKeyPath(d)) return null;
  for (const rule of rules.filter((r) => r.kind === 'outside')) {
    const ids = usable(rule);
    if (ids != null) return toRoute(rule, ids);
  }
  return null;
}

// A segment's route: its own directory's rule when there is one, else the session's route (null when none).
export function routeForSegment(row, dir, sessionRoute, ctx) {
  const own = routeForDir(row, dir, ctx);
  if (own != null) return own;
  return sessionRoute == null ? null : sessionRoute;
}

// Binds each row whose rules can route (null unbinds) for cwd on the session and records cwd; the saved state, or null when none qualify.
export function bindSessionRoutes(sessionId, cwd, rows, ctx) {
  const context = ctx == null ? createRouteContext() : ctx;
  const routes = {};
  let any = false;
  for (const row of rows) {
    if (!usesRules(row)) continue;
    any = true;
    routes[row.key] = routeForDir(row, cwd, context);
  }
  if (!any) return null;
  return initSessionWorkspace(sessionId, { cwd, routes });
}

// A past session's workspaces: the rule for its directory now, else New folders; source is 'single'|'rule'|'new-folders'|'none'|'pending'.
// `key` is the directory's route key when the account has rules and the directory is known, else null.
export function routePastSession(row, { state = null, readCwd = null } = {}, ctx) {
  if (!usesRules(row)) return { tenantIds: [null], source: 'single', pending: false, key: null };
  if (isSingleTenant(row)) {
    const context = ctx == null ? createRouteContext() : ctx;
    const known = state != null && typeof state.cwd === 'string' && state.cwd !== '';
    const cwd = known ? state.cwd : (typeof readCwd === 'function' ? readCwd() : null);
    const key = cwd == null ? null : routeKeyForDir(cwd, context);
    // M1/M8: the session's bound [] route counts only while the same [] rule is still stored.
    const bound = resolveTargets(row, state);
    if (bound.source === 'rule' && bound.targets.length === 0) {
      return { tenantIds: [], source: 'rule', pending: false, key };
    }
    const rule = routeForDir(row, cwd, context);
    if (rule != null && rule.tenantIds.length === 0) return { tenantIds: [], source: 'rule', pending: false, key };
    return { tenantIds: [null], source: 'single', pending: false, key: null };
  }
  let key = null;
  if (rulesOf(row).length > 0) {
    const context = ctx == null ? createRouteContext() : ctx;
    const known = state != null && typeof state.cwd === 'string' && state.cwd !== '';
    const cwd = known ? state.cwd : (typeof readCwd === 'function' ? readCwd() : null);
    key = cwd == null ? null : routeKeyForDir(cwd, context);
    const rule = routeForDir(row, cwd, context);
    if (rule != null) {
      const tenantIds = resolveTargets(row, { route: { [row.key]: rule } }).targets;
      return { tenantIds, source: 'rule', pending: false, key };
    }
  }
  const fallback = resolveTargets(row, null);
  return { tenantIds: fallback.targets, source: fallback.source, pending: fallback.pendingAsk, key };
}

function safeReadState(readState, sessionId) {
  try { return readState(sessionId); } catch { return null; }
}

// A rollout entry's directory: readCwd(transcriptPath) when given, else the session_meta cwd listAllRollouts already read.
function entryCwdReader(readCwd, entry) {
  if (typeof readCwd === 'function') return () => readCwd(entry.transcriptPath);
  return () => (typeof entry.cwd === 'string' && entry.cwd !== '' ? entry.cwd : null);
}

// sessionId → routePastSession result for every listAllRollouts entry; readState(sessionId), readCwd(transcriptPath).
export function planSessionRoutes(row, entries, ctx, { readState = readSessionWorkspace, readCwd = null } = {}) {
  const context = ctx == null ? createRouteContext() : ctx;
  const needsState = usesRules(row);
  const routes = new Map();
  for (const entry of entries || []) {
    if (entry == null || entry.sessionId == null) continue;
    const state = needsState ? safeReadState(readState, entry.sessionId) : null;
    const route = routePastSession(row, { sessionId: entry.sessionId, state, readCwd: entryCwdReader(readCwd, entry) }, context);
    routes.set(entry.sessionId, route);
  }
  return routes;
}

// The one "waiting" test, shared by `routes` and the backfill seal hold so a pull is held only for what `routes` asks about: New folders is Ask me, settled, within the 30-day upload window, readable, pending, and in no workspace's ledger nor the account's legacy one.
// Map<sessionId, key> plus `noDirectory` (waiting with no recorded directory); `routes` option reuses planSessionRoutes results.
export function waitingRoutes(row, entries, ctx, {
  liveSessionId = null,
  now = Date.now,
  loadLedgerImpl = loadLedger,
  readState = readSessionWorkspace,
  readCwd = null,
  routes = null,
} = {}) {
  const waiting = new Map();
  waiting.noDirectory = 0;
  if (!isMultiTenant(row) || newFoldersOf(row).mode !== 'ask') return waiting;
  const context = ctx == null ? createRouteContext() : ctx;
  const identity = row.clientId == null ? null : row.clientId;
  // The tenant-less audit-ledger.json too: history imported before the account had a second workspace is not waiting.
  const ledgers = [loadLedgerImpl(row.key, identity)].concat(tenantsOf(row).map((t) => loadLedgerImpl(row.key, identity, t.id)));
  const nowMs = typeof now === 'function' ? now() : now;
  for (const entry of entries || []) {
    if (entry == null || entry.sessionId == null) continue;
    if (liveSessionId != null && entry.sessionId === liveSessionId) continue;
    if (nowMs - entry.mtimeMs < ACTIVE_SESSION_WINDOW_MS) continue;
    // Too old for runAudit to upload, whatever rule it gets.
    if (nowMs - entry.mtimeMs > MAX_SESSION_AGE_MS) continue;
    if (ledgers.some((ledger) => isImported(ledger, entry.sessionId))) continue;
    const readEntryCwd = entryCwdReader(readCwd, entry);
    let cwd = null;
    let cwdRead = false;
    const cwdOnce = () => {
      if (!cwdRead) { cwdRead = true; cwd = readEntryCwd(); }
      return cwd;
    };
    let state;
    const stateOnce = () => {
      if (state === undefined) state = safeReadState(readState, entry.sessionId);
      return state;
    };
    const route = routes != null && routes.has(entry.sessionId)
      ? routes.get(entry.sessionId)
      : routePastSession(row, { sessionId: entry.sessionId, state: stateOnce(), readCwd: cwdOnce }, context);
    if (route.source !== 'pending') continue;
    let key = route.key;
    if (key == null) {
      const known = stateOnce();
      const dir = known != null && typeof known.cwd === 'string' && known.cwd !== '' ? known.cwd : cwdOnce();
      key = dir == null ? null : routeKeyForDir(dir, context);
    }
    if (key == null) { waiting.noDirectory += 1; continue; }
    waiting.set(entry.sessionId, key);
  }
  return waiting;
}

// Repos/folders (and `outside`) whose waiting past sessions (see waitingRoutes) have no rule, most sessions first.
// Returns [{kind, match, label, sessions (count)}]; the array's `noDirectory` counts sessions with no recorded directory.
export function planUnruledRoutes(row, entries, ctx, options = {}) {
  const waiting = waitingRoutes(row, entries, ctx, options);
  const groups = [];
  groups.noDirectory = waiting.noDirectory;
  const byKey = new Map();
  for (const key of waiting.values()) {
    const id = `${key.kind}\n${key.match}`;
    let group = byKey.get(id);
    if (group == null) {
      group = { kind: key.kind, match: key.match, label: key.label, sessions: 0 };
      byKey.set(id, group);
      groups.push(group);
    }
    group.sessions += 1;
  }
  groups.sort((a, b) => b.sessions - a.sessions || (a.label < b.label ? -1 : (a.label > b.label ? 1 : 0)));
  return groups;
}

// The re-pick pass's places: the rule or rule-less place of every session the upload could send (no ledger filter, most sessions first), then stored rules with none.
// Returns [{kind, match, label, sessions}].
export function planReviewPlaces(row, entries, ctx, {
  liveSessionId = null,
  now = Date.now,
  readState = readSessionWorkspace,
  readCwd = null,
} = {}) {
  const context = ctx == null ? createRouteContext() : ctx;
  const nowMs = typeof now === 'function' ? now() : now;
  const places = [];
  const byKey = new Map();
  const add = (key, n) => {
    const id = `${key.kind}\n${key.match}`;
    let place = byKey.get(id);
    if (place == null) {
      place = { kind: key.kind, match: key.match, label: key.label, sessions: 0 };
      byKey.set(id, place);
      places.push(place);
    }
    place.sessions += n;
  };
  for (const entry of entries || []) {
    if (entry == null || entry.sessionId == null) continue;
    if (liveSessionId != null && entry.sessionId === liveSessionId) continue;
    if (nowMs - entry.mtimeMs < ACTIVE_SESSION_WINDOW_MS) continue;
    if (nowMs - entry.mtimeMs > MAX_SESSION_AGE_MS) continue;
    const state = safeReadState(readState, entry.sessionId);
    const dir = state != null && typeof state.cwd === 'string' && state.cwd !== '' ? state.cwd : entryCwdReader(readCwd, entry)();
    if (dir == null) continue;
    const key = routeForDir(row, dir, context) || routeKeyForDir(dir, context);
    if (key != null) add(key, 1);
  }
  places.sort((a, b) => b.sessions - a.sessions || (a.label < b.label ? -1 : (a.label > b.label ? 1 : 0)));
  for (const rule of rulesOf(row)) add(rule, 0);
  return places;
}

// Where a place sends today: its rule (unless every workspace it names was left), else New folders, else under Ask me the one workspace the account had before the new ones, else pending.
export function placeNow(row, place, newIds) {
  const members = (tenantsOf(row) || []).map((t) => t.id);
  for (const rule of rulesOf(row)) {
    if (rule.kind !== place.kind || rule.match !== place.match) continue;
    const ids = rule.tenantIds.filter((id) => members.indexOf(id) !== -1);
    if (rule.tenantIds.length === 0 || ids.length > 0) return { ids, pending: false };
  }
  const newFolders = newFoldersOf(row);
  if (newFolders.mode === 'send') return { ids: newFolders.tenantIds, pending: false };
  if (newFolders.mode === 'none') return { ids: [], pending: false };
  const before = members.filter((id) => newIds.indexOf(id) === -1);
  return before.length === 1 ? { ids: before, pending: false } : { ids: [], pending: true };
}

// Under Ask me, the rules that pin each rule-less place to where it sends now, so finishing a join review holds nothing back.
export function keepCurrentRules(row, places, newIds) {
  if (newIds.length === 0 || newFoldersOf(row).mode !== 'ask') return [];
  const rules = rulesOf(row);
  const members = (tenantsOf(row) || []).map((t) => t.id);
  const live = (r) => r.tenantIds.length === 0 || r.tenantIds.some((id) => members.indexOf(id) !== -1);
  const out = [];
  for (const place of places) {
    if (rules.some((r) => r.kind === place.kind && r.match === place.match && live(r))) continue;
    const now = placeNow(row, place, newIds);
    if (now.pending || now.ids.length === 0) continue;
    out.push({ kind: place.kind, match: place.match, label: place.label, tenantIds: now.ids });
  }
  return out;
}

const cell = (text) => String(text).replace(/\|/g, '\\|');
// An empty cell stays one space wide, so the header's unnamed column reads `| |`.
const tableRow = (cells) => `|${cells.map((c) => (c === '' ? ' ' : ` ${cell(c)} `)).join('|')}|`;
const sessionsText = (n) => `${n} session${n === 1 ? '' : 's'}`;
const HERE_MARK = '← you\'re here';

// Last-30-days sessions from planReviewPlaces: { rules: Map<index, n>, default: n }; a place equal to a stored rule counts for it, the rest for Default.
// A rule whose workspaces were all left counts none: routing skips it, so its sessions go to the next rule or Default.
export function ruleSessionCounts(row, places) {
  const stored = rulesOf(row);
  const members = (tenantsOf(row) || []).map((t) => t.id);
  const live = stored.filter((r) => usableIds(r, members) !== null);
  const counts = { rules: new Map(stored.map((r) => [r.index, 0])), default: 0 };
  for (const place of places) {
    const rule = live.find((r) => sameKey(r, place));
    if (rule == null) counts.default += place.sessions;
    else counts.rules.set(rule.index, counts.rules.get(rule.index) + place.sessions);
  }
  return counts;
}

// "You're in **labacus-suite**, a git repo at /work/labacus-suite." and why its analytics go where they go.
export function hereSentences(row, place, route) {
  const at = place.path == null ? '' : ` at ${place.path}`;
  const first = place.kind === 'outside'
    ? 'You\'re outside a project folder (home, / or a temp folder).'
    : `You're in **${place.short}**, ${kindWords(place)}${at}.`;
  return [first, whySentence(row, route)];
}

function whySentence(row, route) {
  const reason = route.reason;
  const to = routeTarget(row, route);
  // Audit mode or disabled: a one-workspace account sends no new sessions, whatever the default says.
  if (isSingleTenant(row) && route.ids.length > 0 && !isLiveTrackingAllowed(row.key)) {
    return 'Live tracking is off for this workspace, so new sessions are not sent; these rules apply when history is uploaded.';
  }
  if (reason.kind === 'pending') return 'It has no rule yet. Beezi asks where its analytics go when a session starts here.';
  if (reason.kind === 'rule') {
    const wider = reason.own === false;
    const name = wider ? `Rule R${reason.index} for ${reason.short} covers it` : `Rule R${reason.index}`;
    if (route.ids.length === 0) return wider ? `${name}: nothing is sent.` : `${name} stops tracking it: nothing is sent.`;
    return wider ? `${name} and sends its analytics to ${to}.` : `${name} sends its analytics to ${to}.`;
  }
  if (!isMultiTenant(row)) return `Its sessions send analytics to ${to}, the default for every repo and folder.`;
  return route.ids.length === 0
    ? 'It has no rule of its own, and the default is Don\'t send: nothing is sent.'
    : `It has no rule of its own, so the default applies: analytics go to ${to}.`;
}

// Where Default sends: the one workspace, New folders' workspaces, "not tracked" or "ask me".
export function defaultTarget(row) {
  const route = defaultRoute(row);
  return route.reason.kind === 'pending' ? 'ask me' : routeTarget(row, route);
}

// A rule's "Sends to" cell; routing skips a rule whose workspaces were all left (usableIds → null), so it reads ignored (M-6).
function ruleTarget(row, rule, members) {
  if (usableIds(rule, members) === null) return 'Ignored (workspace left)';
  return rule.tenantIds.length === 0 ? 'not tracked' : joinTenantNames(row, rule.tenantIds);
}

// The user-facing rules table, as lines: accounts with known workspaces, no machine fields.
// options: `entries` (rollouts; default every one on this machine) and planReviewPlaces' own options.
export function rulesTableLines(rows, dir, ctx, options = {}) {
  const known = rows.filter((row) => isMultiTenant(row) || isSingleTenant(row));
  if (known.length === 0) return ['Rules need the account\'s workspaces, which are not known yet. Start a new Codex thread and try again.'];
  const { entries = null, ...planOptions } = options;
  const rollouts = entries == null ? listAllRollouts() : entries;
  const context = ctx == null ? createRouteContext() : ctx;
  const place = placeOfDir(dir, context);
  const out = [];
  known.forEach((row, i) => {
    if (known.length > 1) {
      if (i > 0) out.push('');
      out.push(`**${row.email || row.name || row.key}**`, '');
    }
    const route = place == null ? null : routeOfDir(row, dir, context);
    if (route != null) out.push(...hereSentences(row, place, route), '');
    const hereRule = route != null && route.reason.kind === 'rule' ? route.reason.index : null;
    const mark = (isHere) => (route == null ? [] : [isHere ? HERE_MARK : '']);
    const counts = ruleSessionCounts(row, planReviewPlaces(row, rollouts, context, planOptions));
    const members = tenantsOf(row).map((t) => t.id);
    const header = ['Rule', 'Repo or folder', 'Path or remote', 'Sends to', 'Last 30 days'].concat(route == null ? [] : ['']);
    out.push(tableRow(header), `|${header.map(() => '---').join('|')}|`);
    for (const r of rulesOf(row)) {
      const where = r.kind === 'outside' ? 'home, / or temp folders' : r.label;
      out.push(tableRow([`R${r.index}`, shortLabel(r), where, ruleTarget(row, r, members), sessionsText(counts.rules.get(r.index))].concat(mark(hereRule === r.index))));
    }
    const scope = isMultiTenant(row) ? 'new repos and folders' : 'every repo and folder';
    out.push(tableRow(['Default', scope, '', defaultTarget(row), sessionsText(counts.default)].concat(mark(hereRule == null))));
  });
  return out;
}
