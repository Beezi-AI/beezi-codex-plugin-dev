import os from 'os';
import path from 'path';
import {
  AccountStatus, getDefaultKey, listAccounts, markTenantsReviewed, parseAccountFlag, removeWorkspaceRule, restoreRouting,
  rowSessionFields, setNewFolders, setWorkspaceRule,
} from './accounts.mjs';
import { clearUndo, readUndo, recordUndo, routingOf, sameRouting } from './rule-undo.mjs';
import { placeOfDir, routeOfDir, sameKey } from './route-describe.mjs';
import { pastSessions } from './past-sessions.mjs';
import {
  currentSession,
  initSessionWorkspace,
  isMultiTenant,
  isSingleTenant,
  joinTenantNames,
  listSessionWorkspaces,
  newFoldersOf,
  newTenantsOf,
  readSessionWorkspace,
  recordReadTenant,
  recordSessionRoute,
  resolveTargets,
  resolveTenantRef,
  roleLabel,
  tenantById,
  tenantsOf,
} from './workspace.mjs';
import { releaseHeldQueue } from './workspace-queue.mjs';
import { pluginRoot } from './workspace-prompt.mjs';
import {
  bindSessionRoutes, createRouteContext, displayPath, keepCurrentRules, outsideKey, placeNow, planReviewPlaces, planUnruledRoutes,
  routeForDir, routeKeyForDir, rulesOf, rulesTableLines, shortLabel, usableIds,
} from './workspace-rules.mjs';
import { canonicalRemote } from './git.mjs';
import { normPath, pathHasPrefix } from './repo-map.mjs';
import { listAllRollouts as _listAllRollouts } from './transcript-index-codex.mjs';
import { UserError, friendlyMessage } from './friendly-error.mjs';
import { getAuthentication as _getAuthentication } from './token.mjs';
import { syncAccountIfNeeded as _syncAccountIfNeeded } from './account-sync.mjs';
import { sharedLock, withLock } from './single-instance-lock.mjs';
import { orDefault } from './compat.mjs';
import { takeDeferFlag } from './history-trigger.mjs';

// What scripts/workspace.mjs runs for the settings, login, sync and analytics skills: rules, New
// folders, the past-session routes pass and the read workspace. Line 1 of each command is for the
// user; `key=value` lines are for the model. Lives in lib/ so a test drives it without spawning.

const USAGE = 'Usage: workspace.mjs rules [--table] [--session <id>] [--account <ref>]'
  + ' | rule add (--current | --repo <url> | --folder <path> | --outside) (<id|name|n>… | none) [--session <id>] [--account <ref>]'
  + ' | rule set <n> (<id|name|n>… | none) [--account <ref>]'
  + ' | rule remove <n> [--account <ref>]'
  + ' | rule add-all (<id|name|n>… | none) [--session <id>] [--account <ref>]'
  + ' | routes [--session <id>] [--account <ref>]'
  + ' | joined [add-all | done | pick (--repo <url> | --folder <path> | --outside) <id|name|n>] [--session <id>] [--account <ref>]'
  + ' | new-folders [ask | send <id|name|n>… | none] [--history] [--session <id>] [--account <ref>]'
  + ' | read <id|name|n> [--session <id>] [--account <ref>]'
  + ' | undo [--session <id>]'
  + ' | places [--account <ref>] [--session <id>]';
const NOT_LINKED = 'Beezi: this machine is not linked. Use the login skill to link an account.';
const TARGET_FLAGS = ['--current', '--repo', '--folder', '--outside'];
// The ids sessionWorkspaceFile accepts; anything else could name a file outside state/.
const SESSION_ID_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const QUEUE_LOCK_LEASE_MS = 30_000;
const UNDO_HINT = ' Undo: ask the settings skill to undo.';
// The folder picker offers at most this many places: request_user_input takes up to 3 options.
const PICKER_PLACES = 3;

function context(deps) {
  return {
    env: orDefault(deps.env, process.env),
    cwd: () => (deps.cwd != null ? deps.cwd : process.cwd()),
    listAllRollouts: orDefault(deps.listAllRollouts, _listAllRollouts),
    getAuthentication: orDefault(deps.getAuthentication, _getAuthentication),
    syncAccountIfNeeded: orDefault(deps.syncAccountIfNeeded, _syncAccountIfNeeded),
    lines: [],
    stderr: [],
  };
}

// Printed commands spell the script path out, so the model can run them from any directory.
function scriptCommand() {
  return `node "${pluginRoot()}/scripts/workspace.mjs"`;
}

const deferText = (cx) => (cx.deferUpload ? ' --defer-upload' : '');

function parseSessionFlag(argv) {
  const rest = [];
  let session = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--session') {
      session = argv[++i];
      if (session == null || !SESSION_ID_RE.test(session)) throw new UserError('--session needs a Codex session id.');
      continue;
    }
    rest.push(argv[i]);
  }
  return { session, rest };
}

// --session, then the thread id Codex exports to shell commands, then the newest session recorded for this directory.
// An id is used even before its state file exists; writes create it (withSessionState).
function resolveSession(cx, flag) {
  if (flag != null) return { sessionId: flag, state: readSessionWorkspace(flag) };
  return currentSession(cx.cwd(), cx.env);
}

// A session with no state yet (a login's own session, say) is bound here as SessionStart would bind it: this directory's rules, plus the directory.
// Runs before a change, so `before` targets are the old ones.
async function withSessionState(cx, current, ctx) {
  if (current.sessionId == null || current.state != null) return current;
  const linked = (await listAccounts()).filter((a) => a.status === AccountStatus.LINKED);
  return { sessionId: current.sessionId, state: bindSessionRoutes(current.sessionId, cx.cwd(), linked, ctx) };
}

function accountLabel(row) {
  if (row.email) return row.email;
  return row.name ? row.name : row.key;
}

// --account, then the default, then the only linked account.
async function resolveAccount(key) {
  const accounts = await listAccounts();
  const linked = accounts.filter((a) => a.status === AccountStatus.LINKED);
  if (accounts.length === 0) throw new UserError('This machine is not linked. Use the login skill to link an account.');
  let chosen = key;
  if (chosen == null) chosen = await getDefaultKey();
  if (chosen == null && linked.length === 1) chosen = linked[0].key;
  if (chosen == null) {
    throw new UserError('Several accounts are linked and none is the default. Pass --account <ref>, or choose a default in the settings skill (Account).');
  }
  const row = accounts.find((a) => a.key === chosen);
  if (row == null) throw new UserError('No such linked account.');
  return row;
}

// --account's row, else every linked account.
async function selectedRows(account) {
  return account == null
    ? (await listAccounts()).filter((a) => a.status === AccountStatus.LINKED)
    : [await resolveAccount(account)];
}

function choiceDir(cx, state) {
  return state != null && state.cwd != null ? state.cwd : cx.cwd();
}

function tenantName(row, id) {
  const t = tenantById(row, id);
  return t != null && t.name ? t.name : id;
}

function tenantNames(row, ids) {
  return ids.map((id) => tenantName(row, id)).join(', ');
}

function sendList(row, ids) {
  return ids.length === 0 ? 'not tracked' : tenantNames(row, ids);
}

function idList(ids) {
  return ids.length === 0 ? 'none' : ids.join(',');
}

function sessionsCount(n) {
  return `${n} session${n === 1 ? '' : 's'}`;
}

function newFoldersLabel(row) {
  const newFolders = newFoldersOf(row);
  if (newFolders.mode === 'send') return `Send to ${tenantNames(row, newFolders.tenantIds)}`;
  return newFolders.mode === 'none' ? 'Don\'t send' : 'Ask me';
}

// A rule's place in a sentence: its short name, or "sessions outside a project".
function placeOf(key) {
  return key.kind === 'outside' ? 'sessions outside a project' : shortLabel(key);
}

// Where a write sends, in a confirmation line: "Acme and Northwind" or "not tracked".
function targetWords(row, ids) {
  return ids.length === 0 ? 'not tracked' : joinTenantNames(row, ids);
}

// Pushes a write's confirmation (the undo hint unless the flow defers its upload) and records it as the change undo reverts.
// `change` is the undo line's wording of it (default: the line without "✓ "), `was` a set's old target.
function confirmChange(cx, fresh, line, before, { change = line.slice('✓ '.length), was = null } = {}) {
  cx.lines.push(`${line}${cx.deferUpload ? '' : UNDO_HINT}`);
  recordUndo({ account: fresh.key, summary: line.slice('✓ '.length), change, was, before, after: routingOf(fresh) });
}

// joined pick's confirmation; joined writes record no undo.
function ruleDone(row, key, tenantIds) {
  if (tenantIds.length > 0) return `✓ Analytics for ${placeOf(key)} now go to ${tenantNames(row, tenantIds)}.`;
  return `✓ ${key.kind === 'outside' ? 'Sessions outside a project are' : `${placeOf(key)} is`} now not tracked.`;
}

function requireMulti(row) {
  if (!isMultiTenant(row)) {
    throw new UserError(`${accountLabel(row)} has one workspace (or its workspaces are not known yet), so there is nothing to choose.`);
  }
}

// Same refusal as requireMulti, but only for workspaces that aren't known yet: a one-workspace account may still pass none.
function requireKnownWorkspaces(row) {
  const tenants = tenantsOf(row);
  if (tenants == null || tenants.length === 0) {
    throw new UserError(`${accountLabel(row)}'s workspaces are not known yet. Start a new Codex session, then try again.`);
  }
}

// A one-workspace account's rule refs may only be `none`: there is nothing else to choose.
function requireNoneForSingle(row, refs) {
  if (!isSingleTenant(row)) return;
  const values = refValues(refs);
  if (values.length === 1 && values[0].toLowerCase() === 'none') return;
  throw new UserError(`${accountLabel(row)} has one workspace, so a rule can only stop tracking a repo or folder. Pass none.`);
}

// The workspaces to offer, one line each; role= is last and may be empty.
function printWorkspaces(cx, row) {
  for (const t of tenantsOf(row)) cx.lines.push(`W. ${t.name ? t.name : t.id} account=${row.key} tenant=${t.id} role=${roleLabel(t)}`);
}

// The forced check-in a session holds back until it knows where it sends: one clone carrying just this workspace's tenantId, never the row's own.
async function checkIn(cx, row, tenantId) {
  try {
    const auth = await cx.getAuthentication(row.key);
    if (!auth || auth.state !== 'ready' || !auth.accessToken) return;
    const clientId = auth.clientId == null ? orDefault(row.clientId, null) : auth.clientId;
    const session = { key: row.key, token: auth.accessToken, clientId, tenantId, ...rowSessionFields(row) };
    await cx.syncAccountIfNeeded(row.key, session, { force: true, via: 'workspace' });
  } catch (error) {
    cx.stderr.push(`Beezi: workspace check-in skipped (${friendlyMessage(error)}).`);
  }
}

// Under the drain's own queue lock, and nothing else inside it; a busy queue is left to that drain, which releases by the state just bound.
function releaseHeld(row, sessionId) {
  withLock(sharedLock(`queue-${row.key}`), { leaseMs: QUEUE_LOCK_LEASE_MS }, () => releaseHeldQueue(row, sessionId));
}

function refValues(refs) {
  const values = [];
  for (const ref of refs) for (const part of String(ref).split(',')) if (part.trim() !== '') values.push(part.trim());
  return values;
}

// Ids/names/positions (comma lists too) in row order; `none` anywhere wins and means send nowhere.
function selection(row, refs) {
  const values = refValues(refs);
  if (values.length === 0) throw new UserError(USAGE);
  if (values.some((v) => v.toLowerCase() === 'none')) return [];
  const picked = values.map((v) => resolveTenantRef(row, v));
  return tenantsOf(row).map((t) => t.id).filter((id) => picked.indexOf(id) !== -1);
}

function homeDir() {
  return normPath(os.homedir());
}

// `/`, a drive root, home or a folder above it (e.g. /Users): a folder rule there would catch every session.
function isHomeOrRoot(p) {
  const home = homeDir();
  return p === '/' || /^[a-z]:\/?$/i.test(p) || (home != null && pathHasPrefix(home, p));
}

// Binds open sessions whose directory now routes to one of `indices`: the current one always, others when unbound or bound to that rule.
// Each bound session's held reports are released, and each workspace it newly sends to gets one check-in.
async function bindOpenSessions(cx, row, indices, current, ctx) {
  const checkedIn = [];
  const target = (dir) => {
    const route = dir == null ? null : routeForDir(row, dir, ctx);
    return route != null && indices.indexOf(route.index) !== -1 ? route : null;
  };
  const bind = async (sid, prior, route, dir) => {
    const before = resolveTargets(row, prior).targets;
    // Records the directory too, so a session with no state yet can be found by folder later.
    initSessionWorkspace(sid, { cwd: dir, routes: { [row.key]: route } });
    releaseHeld(row, sid);
    for (const id of resolveTargets(row, readSessionWorkspace(sid)).targets) {
      if (before.indexOf(id) !== -1 || checkedIn.indexOf(id) !== -1) continue;
      checkedIn.push(id);
      await checkIn(cx, row, id);
    }
  };
  if (current.sessionId != null) {
    const dir = choiceDir(cx, current.state);
    const route = target(dir);
    if (route != null) await bind(current.sessionId, current.state, route, dir);
  }
  for (const entry of listSessionWorkspaces()) {
    if (entry.sessionId === current.sessionId) continue;
    const route = target(entry.state.cwd);
    if (route == null) continue;
    const bound = entry.state.route[row.key];
    if (bound != null && (bound.kind !== route.kind || bound.match !== route.match)) continue;
    await bind(entry.sessionId, entry.state, route, entry.state.cwd);
  }
}

// A rule or place in a machine line: its short name, then its full label in parentheses (none for outside).
function labeled(key) {
  return key.kind === 'outside' ? shortLabel(key) : `${shortLabel(key)} (${key.label})`;
}

// The `here:` line: this directory's place, its rule, where it sends now (now=), its path, then the machine fields with match= last.
export function hereLine(row, dir, ctx) {
  const key = routeKeyForDir(dir, ctx);
  if (key == null) return `here: none account=${row.key}`;
  const rule = routeForDir(row, dir, ctx);
  const now = routeOfDir(row, dir, ctx);
  const place = key.kind === 'outside' ? null : placeOfDir(dir, ctx);
  const where = place == null || place.path == null ? '' : ` path=${place.path}`;
  const ruleText = rule == null ? 'no rule' : `R${rule.index}`;
  return `here: ${labeled(key)} → ${ruleText} now=${now.reason.kind === 'pending' ? 'pending' : idList(now.ids)}${where} account=${row.key} rule=${rule == null ? 'none' : rule.index} kind=${key.kind} match=${key.match}`;
}

async function rules(cx, argv) {
  const { session, rest: afterSession } = parseSessionFlag(argv);
  const { account, rest: afterAccount } = await parseAccountFlag(afterSession);
  const table = afterAccount.indexOf('--table') !== -1;
  const rest = afterAccount.filter((a) => a !== '--table');
  if (rest.length !== 0) throw new UserError(USAGE);
  const rows = await selectedRows(account);
  if (rows.length === 0) {
    cx.lines.push(NOT_LINKED);
    return;
  }
  const current = resolveSession(cx, session);
  const dir = choiceDir(cx, current.state);
  const ctx = createRouteContext();
  if (table) {
    const options = { entries: cx.listAllRollouts(), liveSessionId: current.sessionId };
    for (const line of rulesTableLines(rows, dir, ctx, options)) cx.lines.push(line);
    return;
  }
  for (const row of rows) {
    const tenants = tenantsOf(row);
    if (tenants == null || tenants.length === 0) {
      cx.lines.push(`${accountLabel(row)}: workspaces not known yet; rules do not apply account=${row.key}`);
      continue;
    }
    if (isSingleTenant(row)) {
      const stored = rulesOf(row);
      const members = tenants.map((t) => t.id);
      cx.lines.push(`${accountLabel(row)}: ${stored.length} rule(s) account=${row.key} workspaces=1`);
      for (const r of stored) {
        // A leftover rule whose stored workspace(s) are all gone is skipped by routing and must not
        // say "tracked" (M-6): the folder is actually not tracked by it.
        const usable = usableIds(r, members);
        const label = usable === null ? 'ignored (workspace left)' : (usable.length === 0 ? 'not tracked' : 'tracked');
        cx.lines.push(`R${r.index}. ${labeled(r)} → ${label} account=${row.key} rule=${r.index} kind=${r.kind} tenants=${idList(r.tenantIds)} match=${r.match}`);
      }
      cx.lines.push(hereLine(row, dir, ctx));
      continue;
    }
    const stored = rulesOf(row);
    cx.lines.push(`${accountLabel(row)}: ${stored.length} rule(s) account=${row.key}`);
    printWorkspaces(cx, row);
    for (const r of stored) {
      cx.lines.push(`R${r.index}. ${labeled(r)} → ${sendList(row, r.tenantIds)} account=${row.key} rule=${r.index} kind=${r.kind} tenants=${idList(r.tenantIds)} match=${r.match}`);
    }
    cx.lines.push(hereLine(row, dir, ctx));
  }
}

// The rule's key from --current (the session's directory; home, / and temp give `outside`), --repo, --folder or --outside.
function ruleKey(cx, target, dir, ctx) {
  if (target.flag === '--outside') return outsideKey();
  if (target.flag === '--current') {
    const key = routeKeyForDir(dir, ctx);
    if (key == null) throw new UserError('No folder is known for this session. Pass --repo <url>, --folder <path> or --outside.');
    return key;
  }
  if (target.flag === '--repo') {
    const canon = canonicalRemote(target.value);
    if (canon == null) throw new UserError(`"${target.value}" is not a repository remote URL.`);
    return { kind: 'repo', match: canon, label: canon };
  }
  const raw = target.value === '~' || target.value.indexOf('~/') === 0 ? path.join(os.homedir(), target.value.slice(1)) : target.value;
  const folder = normPath(path.resolve(cx.cwd(), raw));
  if (folder == null || isHomeOrRoot(folder)) {
    throw new UserError('A folder rule can\'t be your home folder, a folder above it, or /: it would catch every session. Use --outside for sessions there.');
  }
  return { kind: 'folder', match: folder, label: displayPath(folder) };
}

function findRule(row, ref) {
  const n = Number(String(ref).replace(/^R/i, ''));
  const found = rulesOf(row).find((r) => r.index === n);
  if (found == null) throw new UserError(`There is no rule ${ref}. Ask the settings skill to list the rules.`);
  return found;
}

// Pulls the one rule target flag (--current/--repo/--folder/--outside) out of argv; everything else is workspace refs.
function parseTarget(argv) {
  let target = null;
  const refs = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (TARGET_FLAGS.indexOf(arg) === -1) {
      refs.push(arg);
      continue;
    }
    if (target != null) throw new UserError('Pass only one of --current, --repo <url>, --folder <path> or --outside.');
    const bare = arg === '--current' || arg === '--outside';
    const value = bare ? null : argv[++i];
    if (!bare && (value == null || value.trim() === '')) throw new UserError(`${arg} needs a value.`);
    target = { flag: arg, value };
  }
  return { target, refs };
}

async function ruleAdd(cx, argv) {
  const { session, rest: afterSession } = parseSessionFlag(argv);
  const { account, rest } = await parseAccountFlag(afterSession);
  const { target, refs } = parseTarget(rest);
  if (target == null || refs.length === 0) throw new UserError(USAGE);
  const row = await resolveAccount(account);
  requireKnownWorkspaces(row);
  requireNoneForSingle(row, refs);
  const ctx = createRouteContext();
  const current = await withSessionState(cx, resolveSession(cx, session), ctx);
  const key = ruleKey(cx, target, choiceDir(cx, current.state), ctx);
  const tenantIds = selection(row, refs);
  const before = routingOf(row);
  const n = (await setWorkspaceRule(row.key, { kind: key.kind, match: key.match, label: key.label, tenantIds })).index;
  const fresh = await resolveAccount(row.key);
  confirmChange(cx, fresh, `✓ ${placeOf(key)} → ${targetWords(row, tenantIds)} (rule R${n}).`, before);
  await bindOpenSessions(cx, fresh, [n], current, ctx);
  cx.lines.push(`rule=${n}`);
}

async function ruleSet(cx, argv) {
  const { session, rest: afterSession } = parseSessionFlag(argv);
  const { account, rest } = await parseAccountFlag(afterSession);
  if (rest.length < 2) throw new UserError(USAGE);
  const row = await resolveAccount(account);
  requireKnownWorkspaces(row);
  const found = findRule(row, rest[0]);
  requireNoneForSingle(row, rest.slice(1));
  const tenantIds = selection(row, rest.slice(1));
  const ctx = createRouteContext();
  const current = await withSessionState(cx, resolveSession(cx, session), ctx);
  const before = routingOf(row);
  await setWorkspaceRule(row.key, { kind: found.kind, match: found.match, label: found.label, tenantIds });
  const fresh = await resolveAccount(row.key);
  const change = `${placeOf(found)} → ${targetWords(row, tenantIds)} (rule R${found.index}).`;
  const was = targetWords(row, found.tenantIds);
  confirmChange(cx, fresh, `✓ ${change} Before: ${was}.`, before, { change, was });
  await bindOpenSessions(cx, fresh, [found.index], current, ctx);
  cx.lines.push(`rule=${found.index}`);
}

async function ruleRemove(cx, argv) {
  const { account, rest } = await parseAccountFlag(argv);
  if (rest.length !== 1) throw new UserError(USAGE);
  const row = await resolveAccount(account);
  const before = routingOf(row);
  const removed = await removeWorkspaceRule(row.key, String(rest[0]).replace(/^R/i, ''));
  const fresh = await resolveAccount(row.key);
  const ruleText = `rule R${removed.index} (${placeOf(removed)}).`;
  confirmChange(cx, fresh, isSingleTenant(row)
    ? `✓ Removed ${ruleText} It's tracked again unless another rule covers it.`
    : `✓ Removed ${ruleText} New sessions there follow the default (${newFoldersLabel(row)}).`, before, { change: `removed ${ruleText}` });
  cx.lines.push(`removed=${removed.index}`);
  await rerouteGone(cx, fresh, [removed], createRouteContext());
}

// Sessions bound to a rule that is gone would keep sending by it: re-bind each to whatever still applies (none unbinds to New folders).
// On a multi-workspace account each one's held reports are released and workspaces it newly reaches check in once.
async function rerouteGone(cx, fresh, gone, ctx) {
  const checkedIn = [];
  for (const entry of listSessionWorkspaces()) {
    const bound = entry.state.route[fresh.key];
    if (bound == null || !gone.some((r) => r.kind === bound.kind && r.match === bound.match)) continue;
    const prior = resolveTargets(fresh, entry.state).targets;
    recordSessionRoute(entry.sessionId, fresh.key, routeForDir(fresh, entry.state.cwd, ctx));
    if (!isMultiTenant(fresh)) continue;
    releaseHeld(fresh, entry.sessionId);
    for (const id of resolveTargets(fresh, readSessionWorkspace(entry.sessionId)).targets) {
      if (prior.indexOf(id) !== -1 || checkedIn.indexOf(id) !== -1) continue;
      checkedIn.push(id);
      await checkIn(cx, fresh, id);
    }
  }
}

// One rule per repo or folder that `routes` lists, all sending to the same workspaces.
async function ruleAddAll(cx, argv) {
  const { session, rest: afterSession } = parseSessionFlag(argv);
  const { account, rest } = await parseAccountFlag(afterSession);
  if (rest.length === 0) throw new UserError(USAGE);
  const row = await resolveAccount(account);
  requireMulti(row);
  const tenantIds = selection(row, rest);
  const ctx = createRouteContext();
  const current = await withSessionState(cx, resolveSession(cx, session), ctx);
  const groups = planUnruledRoutes(row, cx.listAllRollouts(), ctx, { liveSessionId: current.sessionId });
  const before = routingOf(row);
  const added = [];
  for (const g of groups) {
    added.push((await setWorkspaceRule(row.key, { kind: g.kind, match: g.match, label: g.label, tenantIds })).index);
  }
  const n = added.length;
  if (n === 0) {
    cx.lines.push('✓ No repos or folders are waiting for a rule.');
  } else {
    const those = n === 1 ? 'that repo or folder' : 'those repos and folders';
    const where = tenantIds.length === 0 ? `${those} ${n === 1 ? 'is' : 'are'} not tracked` : `${those} → ${joinTenantNames(row, tenantIds)}`;
    const fresh = await resolveAccount(row.key);
    const rulesText = `${n} rule${n === 1 ? '' : 's'}: ${where}.`;
    confirmChange(cx, fresh, `✓ Added ${rulesText}`, before, { change: `added ${rulesText}` });
    await bindOpenSessions(cx, fresh, added, current, ctx);
  }
  cx.lines.push(`rules-added=${n}`);
}

async function rule(cx, argv) {
  const [sub, ...rest] = argv;
  if (sub === 'add') { await ruleAdd(cx, rest); return; }
  if (sub === 'set') { await ruleSet(cx, rest); return; }
  if (sub === 'remove') { await ruleRemove(cx, rest); return; }
  if (sub === 'add-all') { await ruleAddAll(cx, rest); return; }
  throw new UserError(USAGE);
}

// The rule-add target flag for a place; single quotes keep $, backticks, " and \ in the match literal.
function ruleTargetFlag(place) {
  return place.kind === 'outside' ? '--outside' : `--${place.kind} '${place.match.replace(/'/g, "'\\''")}'`;
}

// Past sessions waiting under New folders = Ask me, grouped by repo or folder, for the planning questions.
async function routes(cx, argv) {
  const { session, rest: afterSession } = parseSessionFlag(argv);
  const { account, rest } = await parseAccountFlag(afterSession);
  if (rest.length !== 0) throw new UserError(USAGE);
  const rows = await selectedRows(account);
  const { sessionId } = resolveSession(cx, session);
  const ctx = createRouteContext();
  const script = scriptCommand();
  let entries = null;
  let total = 0;
  for (const row of rows) {
    if (row.status !== AccountStatus.LINKED || !isMultiTenant(row) || newFoldersOf(row).mode !== 'ask') continue;
    if (entries == null) entries = cx.listAllRollouts();
    const groups = planUnruledRoutes(row, entries, ctx, { liveSessionId: sessionId });
    if (groups.length > 0) {
      const count = groups.reduce((sum, g) => sum + g.sessions, 0);
      const places = groups.length === 1 ? '1 repo or folder has' : `${groups.length} repos or folders have`;
      cx.lines.push(`${accountLabel(row)}: ${places} past sessions with no rule (${sessionsCount(count)}) account=${row.key}`);
      printWorkspaces(cx, row);
      for (const g of groups) {
        total += 1;
        cx.lines.push(`P${total}. ${labeled(g)}, ${sessionsCount(g.sessions)} account=${row.key} kind=${g.kind} match=${g.match}`);
        const where = ruleTargetFlag(g);
        cx.lines.push(`P${total}-command=${script} rule add ${where} --account ${row.key}${deferText(cx)} <tenants>`);
      }
      cx.lines.push(`all-command=${script} rule add-all --account ${row.key}${deferText(cx)} <tenants>`);
    }
    const lost = groups.noDirectory;
    if (lost > 0) {
      cx.lines.push(lost === 1
        ? '1 other past session has no recorded folder and is not sent.'
        : `${lost} other past sessions have no recorded folder and are not sent.`);
    }
  }
  cx.lines.push(`routes=${total}`);
  return total;
}

// A match or label holding a control character could forge a machine line, so `joined` leaves such a place out.
const UNSAFE_LINE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

// Accounts that joined a workspace since their last re-pick here: every place to re-pick, with where it sends now (login step 4a, sync step 1).
async function joined(cx, argv) {
  const [sub, ...after] = argv;
  if (sub === 'add-all') { await joinedAddAll(cx, after); return; }
  if (sub === 'done') { await joinedDone(cx, after); return; }
  if (sub === 'pick') { await joinedPick(cx, after); return; }
  const { session, rest: afterSession } = parseSessionFlag(argv);
  const { account, rest } = await parseAccountFlag(afterSession);
  if (rest.length !== 0) throw new UserError(USAGE);
  const rows = await selectedRows(account);
  const { sessionId } = resolveSession(cx, session);
  const ctx = createRouteContext();
  const script = scriptCommand();
  let entries = null;
  let total = 0;
  for (const row of rows) {
    if (row.status !== AccountStatus.LINKED) continue;
    const newIds = newTenantsOf(row);
    if (newIds.length === 0) continue;
    if (entries == null) entries = cx.listAllRollouts();
    const places = planReviewPlaces(row, entries, ctx, { liveSessionId: sessionId })
      .filter((place) => !UNSAFE_LINE.test(place.match) && !UNSAFE_LINE.test(place.label));
    if (places.length === 0) continue;
    const count = places.length === 1 ? '1 repo or folder' : `${places.length} repos or folders`;
    cx.lines.push(`${accountLabel(row)}: you joined ${joinTenantNames(row, newIds)} — ${count} to review account=${row.key} new=${newIds.join(',')}`);
    for (const t of tenantsOf(row)) {
      cx.lines.push(`W. ${t.name ? t.name : t.id} account=${row.key} tenant=${t.id} new=${newIds.indexOf(t.id) === -1 ? 'no' : 'yes'} role=${roleLabel(t)}`);
    }
    for (const place of places) {
      total += 1;
      const now = placeNow(row, place, newIds);
      const where = now.pending ? 'no rule yet' : sendList(row, now.ids);
      cx.lines.push(`J${total}. ${labeled(place)}, ${sessionsCount(place.sessions)}, now: ${where} account=${row.key} kind=${place.kind} match=${place.match} now=${now.pending ? 'pending' : idList(now.ids)}`);
      cx.lines.push(`J${total}-command=${script} joined pick ${ruleTargetFlag(place)} --account ${row.key}${deferText(cx)} <tenant>`);
    }
    cx.lines.push(`add-all-command=${script} joined add-all --account ${row.key}${deferText(cx)}`);
    cx.lines.push(`done-command=${script} joined done --account ${row.key}${deferText(cx)}`);
  }
  cx.lines.push(`joined=${total}`);
  return total;
}

// The ids a place should hold once addIds join it: its current targets (pending counts as empty), plus addIds, kept to current members and order.
function extendedTenantIds(row, place, addIds, newIds) {
  const members = tenantsOf(row).map((t) => t.id);
  const now = placeNow(row, place, newIds);
  const base = now.pending ? [] : now.ids;
  return members.filter((id) => base.indexOf(id) !== -1 || addIds.indexOf(id) !== -1);
}

// Adds one joined workspace to one place, extending its current targets (empty and pending places kept, since the user chose them). Does not mark the join reviewed.
async function joinedPick(cx, argv) {
  const { session, rest: afterSession } = parseSessionFlag(argv);
  const { account, rest } = await parseAccountFlag(afterSession);
  const { target, refs } = parseTarget(rest);
  if (target == null || target.flag === '--current' || refs.length !== 1) throw new UserError(USAGE);
  const row = await resolveAccount(account);
  requireMulti(row);
  const ctx = createRouteContext();
  const current = await withSessionState(cx, resolveSession(cx, session), ctx);
  const place = ruleKey(cx, target, choiceDir(cx, current.state), ctx);
  const newIds = newTenantsOf(row);
  const tenantId = resolveTenantRef(row, refs[0]);
  const tenantIds = extendedTenantIds(row, place, [tenantId], newIds);
  const n = (await setWorkspaceRule(row.key, { kind: place.kind, match: place.match, label: place.label, tenantIds })).index;
  cx.lines.push(ruleDone(row, place, tenantIds));
  await bindOpenSessions(cx, await resolveAccount(row.key), [n], current, ctx);
  cx.lines.push(`rule=${n}`);
}

// Adds the new workspaces to every listed place that already sends somewhere; Don't-track and no-rule-yet places stay as they are. Then marks the join reviewed.
async function joinedAddAll(cx, argv) {
  const { session, rest: afterSession } = parseSessionFlag(argv);
  const { account, rest } = await parseAccountFlag(afterSession);
  if (rest.length !== 0) throw new UserError(USAGE);
  const row = await resolveAccount(account);
  requireMulti(row);
  const newIds = newTenantsOf(row);
  if (newIds.length === 0) {
    cx.lines.push('✓ No new workspaces are waiting for a review.');
    cx.lines.push('rules-added=0');
    return;
  }
  const ctx = createRouteContext();
  const current = await withSessionState(cx, resolveSession(cx, session), ctx);
  const added = [];
  for (const place of planReviewPlaces(row, cx.listAllRollouts(), ctx, { liveSessionId: current.sessionId })) {
    const now = placeNow(row, place, newIds);
    if (now.pending || now.ids.length === 0) continue;
    const tenantIds = extendedTenantIds(row, place, newIds, newIds);
    added.push((await setWorkspaceRule(row.key, { kind: place.kind, match: place.match, label: place.label, tenantIds })).index);
  }
  await markTenantsReviewed(row.key, newIds);
  const n = added.length;
  const names = joinTenantNames(row, newIds);
  cx.lines.push(n === 0
    ? `✓ Nothing to add: no repo or folder sends anywhere yet. ${names} won't be asked about again.`
    : `✓ ${names} now ${newIds.length === 1 ? 'gets' : 'get'} analytics from ${n === 1 ? '1 repo or folder' : `${n} repos and folders`}.`);
  if (n > 0) await bindOpenSessions(cx, await resolveAccount(row.key), added, current, ctx);
  cx.lines.push(`rules-added=${n}`);
}

// Under Ask me, pins every rule-less place to where it sends now (so unpicked places keep sending), then marks the new workspaces reviewed.
async function joinedDone(cx, argv) {
  const { session, rest: afterSession } = parseSessionFlag(argv);
  const { account, rest } = await parseAccountFlag(afterSession);
  if (rest.length !== 0) throw new UserError(USAGE);
  const row = await resolveAccount(account);
  const newIds = newTenantsOf(row);
  const kept = [];
  let ctx = null;
  let current = null;
  if (newIds.length > 0 && newFoldersOf(row).mode === 'ask') {
    ctx = createRouteContext();
    current = await withSessionState(cx, resolveSession(cx, session), ctx);
    const places = planReviewPlaces(row, cx.listAllRollouts(), ctx, { liveSessionId: current.sessionId })
      .filter((place) => !UNSAFE_LINE.test(place.match) && !UNSAFE_LINE.test(place.label));
    for (const r of keepCurrentRules(row, places, newIds)) kept.push((await setWorkspaceRule(row.key, r)).index);
  }
  await markTenantsReviewed(row.key, newIds);
  cx.lines.push(newIds.length === 0 ? '✓ No new workspaces were waiting for a review.' : `✓ Done reviewing ${joinTenantNames(row, newIds)}.`);
  cx.lines.push(`reviewed=${idList(newIds)}`);
  if (kept.length > 0) await bindOpenSessions(cx, await resolveAccount(row.key), kept, current, ctx);
  cx.lines.push(`kept=${kept.length}`);
}

async function newFolders(cx, argv) {
  const history = argv.indexOf('--history') !== -1;
  const { session, rest: afterSession } = parseSessionFlag(argv.filter((arg) => arg !== '--history'));
  const { account, rest } = await parseAccountFlag(afterSession);
  const row = await resolveAccount(account);
  if (rest.length === 0) {
    if (!isMultiTenant(row)) {
      cx.lines.push(`new-folders=n/a multi=no account=${row.key}`);
      return;
    }
    const several = (await listAccounts()).length > 1;
    const newFoldersNow = newFoldersOf(row);
    cx.lines.push(`New folders${several ? ` (${accountLabel(row)})` : ''}: ${newFoldersLabel(row)}`);
    printWorkspaces(cx, row);
    if (history) printHistory(cx, row);
    cx.lines.push(`new-folders=${newFoldersNow.mode} set=${newFoldersNow.set ? 'yes' : 'no'} multi=yes account=${row.key}`);
    return;
  }
  requireMulti(row);
  const mode = String(rest[0]).toLowerCase();
  if ((mode !== 'ask' && mode !== 'send' && mode !== 'none') || (mode !== 'send' && rest.length > 1) || history) throw new UserError(USAGE);
  const tenantIds = mode === 'send' ? selection(row, rest.slice(1)) : [];
  if (mode === 'send' && tenantIds.length === 0) throw new UserError('Send needs at least one workspace; use none to send nowhere.');
  const current = await withSessionState(cx, resolveSession(cx, session), createRouteContext());
  const prior = resolveTargets(row, current.state);
  const before = routingOf(row);
  await setNewFolders(row.key, { mode, tenantIds });
  const fresh = await resolveAccount(row.key);
  let line = '✓ New folders: Ask me — Beezi asks once per repo or folder.';
  if (mode === 'send') line = `✓ New folders → ${joinTenantNames(row, tenantIds)}.`;
  if (mode === 'none') line = '✓ New folders: not tracked.';
  confirmChange(cx, fresh, line, before);
  await followNewFolders(cx, fresh, current, prior);
  cx.lines.push(`new-folders=${mode}`);
}

// The setup's preview: past sessions the upload would send and the places they come from. A count that fails prints
// nothing, so the question still stands without numbers.
function printHistory(cx, row) {
  let counts = null;
  try { counts = pastSessions(row, null, { cwd: cx.cwd(), env: cx.env }); } catch { counts = null; }
  if (counts != null) cx.lines.push(`history=${counts.sessions} places=${counts.places}`);
}

// A session here with no rule follows the new New folders now: its held reports go out and workspaces it newly sends to check in.
async function followNewFolders(cx, fresh, current, prior) {
  if (current.sessionId == null || prior.rule != null) return;
  releaseHeld(fresh, current.sessionId);
  for (const id of resolveTargets(fresh, current.state).targets) {
    if (prior.targets.indexOf(id) === -1) await checkIn(cx, fresh, id);
  }
}

function sameRule(a, b) {
  return a.kind === b.kind && a.match === b.match && JSON.stringify(a.tenantIds) === JSON.stringify(b.tenantIds);
}

// Puts back the rules and New folders from before the last recorded change, unless something changed them since.
// With no session known (no thread id, nothing recorded for this folder) only the re-bind of the current session is skipped.
async function undo(cx, argv) {
  const { session, rest } = parseSessionFlag(argv);
  if (rest.length !== 0) throw new UserError(USAGE);
  const last = readUndo();
  if (last == null) {
    cx.lines.push('Nothing to undo.');
    cx.lines.push('undone=0');
    return;
  }
  const row = (await listAccounts()).find((a) => a.key === last.account && a.status === AccountStatus.LINKED);
  const ctx = createRouteContext();
  // Read-only: a refused undo writes nothing, session state included.
  const current = resolveSession(cx, session);
  const result = row == null ? 'missing' : await restoreRouting(row.key, { expected: last.after, before: last.before });
  clearUndo();
  if (result !== 'restored') {
    cx.lines.push(result === 'changed' ? 'Nothing undone: the rules changed after that change.' : 'Nothing to undo: that account is no longer linked.');
    cx.lines.push('undone=0');
    return;
  }
  const back = last.was == null ? '' : ` It's back to ${last.was}.`;
  cx.lines.push(`✓ Undid your last change: ${last.change}${back} Sessions already uploaded stay where they went.`);
  const fresh = await resolveAccount(row.key);
  // Rules that came back (or got their old workspaces back) re-bind their sessions; rules that went away re-route theirs.
  const undone = rulesOf({ workspaceRules: last.after.workspaceRules });
  const restored = rulesOf(fresh).filter((r) => !undone.some((u) => sameRule(u, r)));
  if (restored.length > 0) await bindOpenSessions(cx, fresh, restored.map((r) => r.index), current, ctx);
  await rerouteGone(cx, fresh, undone.filter((u) => !rulesOf(fresh).some((r) => r.kind === u.kind && r.match === u.match)), ctx);
  if (!sameRouting(last.before.newFolders, last.after.newFolders)) {
    await followNewFolders(cx, fresh, current, resolveTargets(row, current.state));
  }
  cx.lines.push('undone=1');
}

// The folder picker's places: recent repos and folders with no rule of their own, other than this directory's, most sessions first.
export function pickerPlaces(row, entries, dir, ctx, options = {}) {
  const here = dir == null ? null : routeForDir(row, dir, ctx) || routeKeyForDir(dir, ctx);
  const stored = rulesOf(row);
  return planReviewPlaces(row, entries, ctx, options)
    .filter((place) => !UNSAFE_LINE.test(place.match) && !UNSAFE_LINE.test(place.label))
    .filter((place) => !sameKey(place, here) && !stored.some((r) => sameKey(r, place)))
    .slice(0, PICKER_PLACES);
}

// The picker's lines: a header, then per place its F line and the rule-add command to finish with <tenants>.
export function pickerLines(row, places, flags = { deferUpload: false }) {
  if (places.length === 0) return [];
  const script = scriptCommand();
  const count = places.length === 1 ? '1 repo or folder' : `${places.length} repos or folders`;
  const lines = [`${accountLabel(row)}: ${count} with recent sessions account=${row.key}`];
  places.forEach((place, i) => {
    lines.push(`F${i + 1}. ${labeled(place)}, ${sessionsCount(place.sessions)} account=${row.key} kind=${place.kind} match=${place.match}`);
    lines.push(`F${i + 1}-command=${script} rule add ${ruleTargetFlag(place)} --account ${row.key}${deferText(flags)} <tenants>`);
  });
  return lines;
}

async function places(cx, argv) {
  const { session, rest: afterSession } = parseSessionFlag(argv);
  const { account, rest } = await parseAccountFlag(afterSession);
  if (rest.length !== 0) throw new UserError(USAGE);
  const row = await resolveAccount(account);
  const tenants = tenantsOf(row);
  const current = resolveSession(cx, session);
  const found = tenants == null || tenants.length === 0
    ? []
    : pickerPlaces(row, cx.listAllRollouts(), choiceDir(cx, current.state), createRouteContext(), { liveSessionId: current.sessionId });
  for (const line of pickerLines(row, found, cx)) cx.lines.push(line);
  cx.lines.push(`places=${found.length}`);
}

async function read(cx, argv) {
  const { session, rest: afterSession } = parseSessionFlag(argv);
  const { account, rest } = await parseAccountFlag(afterSession);
  if (rest.length !== 1) throw new UserError(USAGE);
  const row = await resolveAccount(account);
  const tenantId = resolveTenantRef(row, rest[0]);
  const { sessionId } = await withSessionState(cx, resolveSession(cx, session), createRouteContext());
  if (sessionId == null || recordReadTenant(sessionId, row.key, tenantId) == null) {
    throw new UserError('No Codex session found. Run this inside a Codex session or pass --session <id>.');
  }
  cx.lines.push(`✓ Reading from ${tenantName(row, tenantId)} in this session.`);
  cx.lines.push(`read=${tenantId}`);
}

// `{ ok, lines, stderr }` — never throws, never prints; lines go to stdout, stderr lines (check-in notes, the ✗ line) to stderr.
// The `joined` and `routes` listings add `count`: their J or P lines. Lines printed before a failure are kept: a
// rule saved before a later step failed still says so.
export async function workspaceCommand(argv, deps = {}) {
  const taken = takeDeferFlag(Array.isArray(argv) ? argv : []);
  const cx = context(deps);
  cx.deferUpload = taken.deferUpload;
  const [cmd, ...rest] = taken.argv;
  let count;
  try {
    if (cmd === 'rules') await rules(cx, rest);
    else if (cmd === 'rule') await rule(cx, rest);
    else if (cmd === 'routes') count = await routes(cx, rest);
    else if (cmd === 'joined') count = await joined(cx, rest);
    else if (cmd === 'new-folders') await newFolders(cx, rest);
    else if (cmd === 'read') await read(cx, rest);
    else if (cmd === 'undo') await undo(cx, rest);
    else if (cmd === 'places') await places(cx, rest);
    else throw new UserError(cmd == null ? USAGE : `Unknown command "${cmd}". ${USAGE}`);
    const result = { ok: true, lines: cx.lines, stderr: cx.stderr };
    if (count !== undefined) result.count = count;
    return result;
  } catch (error) {
    cx.stderr.push(`\n✗ ${friendlyMessage(error)}`);
    return { ok: false, lines: cx.lines, stderr: cx.stderr };
  }
}

// sync --review's listings in its own call, each a <joined>/<routes> block, then `review=<n>`: the J or P lines that
// need an answer. `routes` is skipped when `joined` asks something, because a J answer can give its places a rule.
// A failed listing keeps its ✗ line in its block and asks nothing. `fromRoutes` starts at `routes`.
export async function syncReview(fromRoutes, account, deps = {}) {
  const flags = (account == null ? [] : ['--account', account]).concat(['--defer-upload']);
  const lines = [];
  let review = 0;
  for (const tag of fromRoutes ? ['routes'] : ['joined', 'routes']) {
    const result = await workspaceCommand([tag].concat(flags), deps);
    const notes = result.stderr.map((line) => line.trim()).filter((line) => line !== '');
    lines.push(`<${tag}>`, ...result.lines, ...notes, `</${tag}>`);
    review = result.ok ? result.count : 0;
    if (review > 0) break;
  }
  lines.push(`review=${review}`);
  return { lines, review };
}
