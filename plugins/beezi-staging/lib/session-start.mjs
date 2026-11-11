import { consentPrompt, correlationPrompt } from './diagnostics.mjs';
import { fetchCompat } from './fetch-compat.mjs';
import { checkForUpdate as _checkForUpdate, updateNotice, cachedUpdate, installedPlugin } from './update-check.mjs';
import { compareVersions } from './version-compare.mjs';
import fs from 'fs';
import path from 'path';
import { getAuthentication as _getAuthentication } from './token.mjs';
import { updateAccount as _updateAccount, rowSessionFields } from './accounts.mjs';
import { listRecipients, SESSION_LOCK_LEASE_MS } from './checkpoint.mjs';
import { markUploadDue as _markUploadDue } from './upload-due.mjs';
import { readUploadStatus, writeUploadStatus } from './upload-worker.mjs';
import { readSessionStartCache, writeSessionStartCache } from './session-start-upload.mjs';
import { readAuthState } from './telemetry-auth.mjs';
import { git as _git, resolveOriginRemote } from './git.mjs';
import { resolveRepoRoot } from './repo-timeline.mjs';
import {
  loadRepoMap,
  saveRepoMap,
  upsertRoot,
  pruneRepoMap,
  originFromGitConfig,
} from './repo-map.mjs';
import { codexAuthFile, stateDir } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { pruneStale } from './prune.mjs';
import { withLock, sessionLock } from './single-instance-lock.mjs';
import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson } from './http.mjs';
import { whoami } from './whoami.mjs';
import { recordWhoami, readTrackingState, allowsLiveFor } from './tracking.mjs';
import { readSessionWorkspace, expandTargets, isMultiTenant, tenantById, tenantsOf } from './workspace.mjs';
import { placeOfDir } from './route-describe.mjs';
import { createRouteContext } from './workspace-rules.mjs';
import { buildBanner } from './session-banner.mjs';
import { ASK_SOURCES } from './workspace-prompt.mjs';
import { BillingSource } from './billing.mjs';
import {
  readBillingConfig as _readBillingConfig,
  writeBillingConfig as _writeBillingConfig,
  resolveSource as _resolveSource,
  syncBillingSource,
  isStale as _isStale,
  shouldProbeAccount as _shouldProbeAccount,
} from './billing-config.mjs';
import { readChatgptAuth as _readChatgptAuth } from './chatgpt-auth.mjs';
import { orDefault } from './compat.mjs';
import { captureFromCodexAccount } from './billing-capture.mjs';
import { readAccountViaAppServer as _readAccountViaAppServer } from './codex-app-server.mjs';
import { syncAccountIfNeeded as _syncAccountIfNeeded } from './account-sync.mjs';
import { hasKind, kindsOf, sessionAnonymization } from './anonymization.mjs';
import { Kind } from './anonymize.mjs';

// Resume guard: create cursor=0 ONLY if absent; never reset an existing session's cursor.
// Also records where the session lives (cwd + transcript path) so the track script can find
// the transcript after the session cd's away from its launch directory — the mapping is
// refreshed on every start (resume may happen from a different directory).
//
// Under the same rank-2 `session:<id>` lock runCheckpoint takes, and for the same reason (G-8-3 /
// R3). This is the FIFTH writer of state/<id>.json and it is a read-modify-write like the others:
// it reads the file to preserve `cursor` and writes the whole object back. A checkpoint that
// advances the cursor between that read and this write has its advance erased — the session
// re-processes and re-bills a window it already delivered. Resuming a session while a Stop hook
// from the previous turn is still finishing is exactly that interleaving. R-numbers cite
// docs/plans/2026-09-10-sections/REVIEW.md.
//
// Contention DEFERS: the mapping this refreshes is a hint the checkpoint can re-derive, and the
// cursor it was protecting is untouched, which is the whole point of not writing.
export function initSessionState(sessionId, { cwd = null, transcriptPath = null } = {}, deps = {}) {
  const run = withLock(sessionLock(sessionId), { leaseMs: SESSION_LOCK_LEASE_MS }, () => {
    const dir = stateDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const p = path.join(dir, `${sessionId}.json`);
    const state = readJson(p, { cursor: 0 });
    state.cwd = cwd;
    state.transcriptPath = transcriptPath;
    state.updatedAt = new Date().toISOString();
    writeJsonSecure(p, state);
  });
  return run.ok
    ? { written: true, skipped: false, reason: null }
    : { written: false, skipped: true, reason: run.reason };
}

// Pre-warm the persisted repo-map at session start so the checkpoint hot path resolves most dirs
// without shelling git. Resolves the launch cwd's root+origin; when the launch cwd is itself a
// non-repo parent (e.g. a multi-repo workspace folder), shallow-scans its immediate children (one
// level) for a .git and maps each child repo. Best-effort; never throws. Returns the (possibly
// mutated) map plus a dirty flag.
export function discoverRepos(cwd, gitImpl, map, deps = {}) {
  const fsImpl = orDefault(deps.fs, fs);
  let dirty = false;
  if (!cwd) return { map, dirty };
  const cache = new Map();
  const recordRoot = (root) => {
    if (!root) return;
    // Lazy fallback preserved: originFromGitConfig reads the repo's config file and must only
    // run when the remote lookup came back empty.
    let origin = resolveOriginRemote(gitImpl, root);
    if (origin === undefined || origin === null) origin = originFromGitConfig(root);
    upsertRoot(map, root, origin);
    dirty = true;
  };

  const launchRoot = resolveRepoRoot(gitImpl, cwd, cache, map);
  if (launchRoot) {
    recordRoot(launchRoot);
  } else {
    let entries;
    try { entries = fsImpl.readdirSync(cwd, { withFileTypes: true }); } catch { entries = []; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(cwd, entry.name);
      try {
        if (!fsImpl.existsSync(path.join(child, '.git'))) continue;
      } catch { continue; }
      recordRoot(orDefault(resolveRepoRoot(gitImpl, child, cache, map), child));
    }
  }
  return { map, dirty };
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

// The upload worker's /repos/status answer for one target, by the remote it was asked about. The
// repo→project mapping is a fact about a TENANT, so the target's workspace is part of the key.
const repoKey = (target, remote) => `${target.tenantId == null ? '' : target.tenantId}|${remote}`;

// Both branches are informational only. Nothing downstream gates on `connected`: the checkpoint
// reports every branch of every repo, and work with no origin at all under a `local:<folder>`
// remote. Saying "no analytics tracked here" would be false.
function repoLine(answer) {
  return answer.connected
    ? `Beezi: repo connected${answer.projectName ? ` to "${answer.projectName}"` : ''}. Sessions here are tracked.`
    : 'Beezi: this repo is not connected to a Beezi project. Sessions are still tracked, against the repo itself.';
}

const repoAnswersOf = (cache) => (cache && isPlainObject(cache.repos) ? cache.repos : null);

// The line for a target from the last answer the worker cached; none for a remote never asked about.
function cachedRepoLine(cache, target, remote) {
  if (!remote) return null; // not a git repo — silent
  const repos = repoAnswersOf(cache);
  const answer = repos == null ? null : repos[repoKey(target, remote)];
  return isPlainObject(answer) ? repoLine(answer) : null;
}

// The worker side. The remote is resolved ONCE by the caller and handed in: it is a git shell-out
// and it is the same answer for every linked account. postJson, not a bare fetch: a stalled API
// must fail into the silent "offline" null, not hold the worker's run open.
async function probeRepo(remote, session, fetchImpl) {
  try {
    const res = await postJson(`${apiBase()}${ENDPOINTS.reposStatus}`, session, { remote }, { fetchImpl });
    if (!res.ok) return null;
    const body = await res.json();
    return isPlainObject(body) ? body : null;
  } catch { return null; } // offline — silent
}

// The type of the workspace a target sends to ('analytics', a platform type, or null when unknown).
function workspaceType(target) {
  const tenants = tenantsOf(target);
  const t = target.tenantId != null ? tenantById(target, target.tenantId) : (tenants != null && tenants.length === 1 ? tenants[0] : null);
  return t == null || t.type == null ? null : t.type;
}

const ANONYMIZED_LINE = 'Beezi: this workspace is anonymized.';

const isAnonymizedTarget = (target) => kindsOf(sessionAnonymization(target)).length > 0;

// An analytics workspace answers connected for every repo, and one hiding repos is never sent the raw remote.
const probesRepo = (target) => workspaceType(target) !== 'analytics' && !hasKind(sessionAnonymization(target), Kind.REPOS);

// The hook's own cwd only: an unknown one gets no route line. Compact shows none.
function sessionBanner(input, sessions, workspaceState, trackingByKey, ctx) {
  if (input.source === 'compact') return null;
  const place = typeof input.cwd === 'string' && input.cwd !== '' ? placeOfDir(input.cwd, ctx) : null;
  const asking = input.source == null || ASK_SOURCES.indexOf(input.source) !== -1;
  return buildBanner({ sessions, state: workspaceState, place, trackingByKey, asking });
}

// whoami reports invalid for any 401/403, which covers an expired token and a permissions
// or wrong-environment refusal as well as a genuine revocation — too coarse to delete on.
// So this only decides what to *tell* the user; discarding credentials is left to the token
// endpoint naming the grant revoked, or to the user signing in again.
// Offline/unknown (null) still reads as fine, so a check we couldn't run stays silent.
// Returns the whoami answer itself, so the caller can carry a valid answer's identity forward.
async function probeToken(key, session, fetchImpl, deps = {}) {
  const who = await whoami(session, { fetchImpl });
  // Piggyback the tracking-policy refresh on the check we already make: the trackingMode cache
  // goes stale between logins otherwise, and the live gate keys off it. Best-effort — never
  // blocks session start.
  if ((who || {}).valid === true) {
    // The account's OWN client id, carried on the session this whoami was made with — never a
    // process-global, which with several accounts linked would bind one tenant's policy under
    // another's identity and make matchesIdentity discard the wrong cache.
    try { recordWhoami(key, who, orDefault(session.clientId, null)); } catch { /* best-effort */ }
    // And refresh the index row's identity on EVERY valid answer. This is the only place the
    // workspace list (`tenants`) is kept current between logins. It also fills a row whose email is
    // null (migrated from a pre-0.13 install, or linked while the portal was unreachable), which
    // lib/accounts.mjs's findByEmail could never match, so a re-login would mint a second row.
    //
    // AFTER recordWhoami, never inside it. recordWhoami takes `shared:tracking-<key>` and
    // updateAccount takes `shared:accounts-index`; both are rank 3 in LOCK_ORDER and
    // lib/single-instance-lock.mjs refuses a rank-3 lock while this process holds another rank-3
    // lock under a different name. recordWhoami is synchronous and its lock is released by the time
    // it returns, so this call is sequential rather than nested.
    //
    // updateAccount treats null as "leave it alone", so an older portal's null tenant fields or
    // missing workspace list cannot blank a known one.
    const updateAccount = orDefault(deps.updateAccount, _updateAccount);
    try {
      await updateAccount(key, {
        email: who.email, name: who.name, tenantId: who.tenantId, tenantName: who.tenantName,
        tenants: who.tenants, anonymization: who.anonymization,
      }, deps);
    } catch { /* best-effort — a session must not fail because a row could not be labelled */ }
  }
  return who;
}

const isRejected = (who) => (who || {}).valid === false;

// The session carried past the token check: the identity a valid answer just named overlays the
// stored one (null keeps it), and tenantId is always null — only a per-workspace clone sets it.
function overlayWhoami(session, who) {
  const next = { ...session, tenantId: null };
  if ((who || {}).valid !== true) return next;
  if (who.email != null) next.email = String(who.email).toLowerCase();
  for (const field of ['name', 'tenantName', 'tenants', 'anonymization']) {
    if (who[field] != null) next[field] = who[field];
  }
  return next;
}

// How a warning line names an account. Only reached when more than one is linked — with one,
// naming it in every message would be noise about a fact the user already knows. A multi-workspace
// row's tenantName is the web-side workspace, not this session's, so such an account is named by email.
function workspaceLabel(account) {
  if (isMultiTenant(account)) return orDefault(account.email, account.key);
  return orDefault(orDefault(account.tenantName, account.email), account.key);
}

// A repo line for one target clone: a multi-workspace clone names its workspace, plus the account's
// email when several are linked; any other keeps the account prefix it always had.
function announceLine(target, line, many) {
  if (!isMultiTenant(target) || target.tenantId == null) return many ? `${workspaceLabel(target)} — ${line}` : line;
  const tenant = tenantById(target, target.tenantId);
  const workspace = tenant != null && tenant.name ? tenant.name : target.tenantId;
  const who = many ? `${orDefault(target.email, target.key)} · ${workspace}` : workspace;
  return line.replace('Beezi:', `Beezi (${who}):`);
}

// Fail-open like every tracking gate: an unreadable state allows live reporting.
function trackingOf(key) {
  try { return readTrackingState(key); } catch { return null; }
}

// How long the SessionStart hook will wait on `codex app-server` before falling through to the
// auth.json decode. The hook's own budget is 10s and already covers a queue flush and a repo probe.
// MEASURED on Windows with codex-cli 0.154.0: 2929ms cold, ~1050ms warm — the launch is the slow
// part (an npm .cmd shim → node → the platform binary), not the protocol. A 3s bound would have cut
// the cold run off and quietly dropped every first probe on a machine like that.
//
// Shorter than the module's own default: this one is spent inside a hook budget, at most weekly.
const APP_SERVER_TIMEOUT_MS = 5000;

function readAuthFileMtimeMs() {
  try {
    const value = fs.statSync(codexAuthFile()).mtimeMs;
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

const isTemporary = (state) => state === 'unavailable' || state === 'refreshing';

const TEMPORARY_MESSAGE = 'Beezi authentication is temporarily unavailable or refreshing. Your saved link is preserved; analytics will retry.';
const REJECTED_MESSAGE = '⚠ Beezi: this machine’s link was rejected — analytics are NOT being tracked. Ask Beezi to sign you in again.';
export const NOT_LINKED_MESSAGE = '⚠ Beezi: this machine is not linked — analytics are NOT being tracked. Ask Beezi to sign you in.';

// A refusal the worker cached that still describes this link. Login rewrites the verdict on both
// re-login branches; this is the second guard, for a cache written by a worker run that raced the
// login or for a login that could not write it: a refusal reached under another client than the
// row's (a re-login re-arms the key with a new one) or before the account was linked is stale.
function isCurrentRefusal(cache, account) {
  if (cache.verdict !== 'rejected' && cache.verdict !== 'temporary') return false;
  if (cache.clientId != null && account.clientId != null && cache.clientId !== account.clientId) return false;
  const linkedAt = typeof account.linkedAt === 'string' ? Date.parse(account.linkedAt) : NaN;
  return !(isFinite(linkedAt) && linkedAt > Number(cache.checkedAt));
}

const temporaryLine = (account) => `Beezi: ${workspaceLabel(account)} is temporarily unavailable or refreshing — its analytics will retry.`;
const rejectedLine = (account) => `⚠ Beezi: ${workspaceLabel(account)} is not reporting — its link was rejected. Ask Beezi to sign you in again.`;

// Why an account produced no token, from the token module's own record of its last answer
// (accounts/<key>/auth-state.json, written by every getAuthentication — the upload worker's
// included). Reading it is not a credential read. Never recorded reads as ready: a check that
// could not run stays silent, as it always did.
function lastAuthStateOf(key) {
  try {
    const state = readAuthState(key).lastState;
    return typeof state === 'string' ? state : null;
  } catch {
    return null;
  }
}

const producesToken = (state) => state == null || state === 'ready';

/**
 * The linked accounts that can produce a token, as far as their last recorded authentication says
 * — the index and one small file per account, no credential read. Tokenless rows (token: null),
 * for the SessionStart prompts, which only need to know who is linked and usable.
 */
export async function usableSessions(deps = {}) {
  let rows;
  try { rows = orDefault(await listRecipients([], deps), []); } catch { rows = []; }
  return rows.filter((row) => producesToken(lastAuthStateOf(row.key)));
}

// One clone per target workspace that tracks live, and none for an account still waiting for the
// user's answer. Only this session's own rule scopes requests; the row's web-side tenantId never does.
function liveTargets(active, workspaceState, trackingByKey) {
  return expandTargets(active, workspaceState)
    .filter((target) => allowsLiveFor(target, trackingByKey.get(target.key)));
}

/**
 * The migration notice the upload worker recorded when ITS guard migrated this data root, once.
 * The hook runs only the credential-free guard, which never migrates, so this is how a migration
 * the worker performed reaches the user: on the next SessionStart. → the text, or null. Never throws.
 */
export function takeMigrationNotice() {
  try {
    const notice = readUploadStatus().migrationNotice;
    if (typeof notice !== 'string' || notice === '') return null;
    writeUploadStatus({ migrationNotice: null });
    return notice;
  } catch {
    return null;
  }
}

// The update notice from the last check the worker made (update-check.json), with no request: the
// installed version against the last published one it saw. Null unless that one is newer.
function cachedUpdateNotice(deps) {
  try {
    const state = cachedUpdate(deps);
    const installed = installedPlugin(deps);
    if (!installed || typeof state.latest !== 'string') return null;
    if (compareVersions(installed.version, state.latest) !== -1) return null;
    return updateNotice({ status: 'behind', current: installed.version, latest: state.latest });
  } catch {
    return null;
  }
}

// Returns an optional systemMessage string (or null). Never throws for expected failures.
//
// READS NO CREDENTIAL AND MAKES NO REQUEST. What it used to ask the portal — whoami per account,
// the forced renewal, /repos/status, the account check-in, the update check — and the queue drain
// now run in the upload worker (runSessionStartUpload below, and the worker's `queue` step), which
// this hook hands the session to with a `sessionStart` due marker. What it prints from those
// answers is the last one the worker cached, so a change the portal reports shows one session later.
// What stays here is local: state init, the repo-map pre-warm, the banner, the billing realignment
// and its gated `codex app-server` probe (a subprocess, not a credential read), the nudges.
export async function runSessionStart(input, deps = {}) {
  const gitImpl = orDefault(deps.gitImpl, _git);
  const resolveSource = orDefault(deps.resolveSource, _resolveSource);
  const readBillingConfig = orDefault(deps.readBillingConfig, _readBillingConfig);
  const writeBillingConfig = orDefault(deps.writeBillingConfig, _writeBillingConfig);
  const isStale = orDefault(deps.isStale, _isStale);
  const shouldProbeAccount = orDefault(deps.shouldProbeAccount, _shouldProbeAccount);
  const readChatgptAuth = orDefault(deps.readChatgptAuth, _readChatgptAuth);
  // Tier 1 of the plan/account ladder. Threaded like every other reader on this path: a bare call
  // would SPAWN A REAL `codex app-server` from the test suite, which tools/hermetic-env.mjs records
  // as an escape to the developer's own ~/.codex.
  const readAccountViaAppServer = orDefault(deps.readAccountViaAppServer, _readAccountViaAppServer);
  const readAuthMtime = orDefault(deps.readAuthFileMtimeMs, readAuthFileMtimeMs);
  // Threaded rather than read inside the ladder: step 1 of resolveSource is an environment lookup
  // (`resolveSource` in billing-config.mjs) and a caller with a resolved environment must be able
  // to hand it over instead of having the host's consulted behind its back (G-10-1 L3).
  const env = orDefault(deps.env, process.env);
  const markUploadDue = orDefault(deps.markUploadDue, _markUploadDue);

  // Every linked account, tokenless: the index alone (listRecipients), never the credential store.
  // Whether each can produce a token, and what the portal last said about it, is read below from
  // what the token module and the upload worker left on disk.
  let linked;
  try { linked = orDefault(await listRecipients([], deps), []); } catch { linked = []; }
  const many = linked.length > 1;

  // Hand the network half to the upload worker (scripts/session-start.mjs starts it, last). Marked
  // before any answer below, so a machine whose only account is mid-refresh still gets its retry.
  // An unlinked machine owes the worker nothing.
  if (linked.length > 0) {
    try {
      markUploadDue(input.session_id, {
        transcriptPath: orDefault(input.transcript_path, null),
        cwd: orDefault(input.cwd, null),
        timeline: false,
        sessionStart: true,
      });
    } catch { /* best-effort: the session's next hook marks it again */ }
  }

  // An account that produced no token is explained rather than read as "not linked", or a machine
  // whose only account is mid-refresh would send the user to sign in again for nothing. One whose
  // token the portal refused on the worker's last check — still refused after one forced renewal —
  // is named too. Every other account reports, with the identity its last valid whoami named.
  const unresolved = [];
  const refused = [];
  const active = [];
  const caches = new Map();
  for (const account of linked) {
    const state = lastAuthStateOf(account.key);
    if (!producesToken(state)) { unresolved.push({ account, state }); continue; }
    const cache = readSessionStartCache(account.key);
    caches.set(account.key, cache);
    if (isCurrentRefusal(cache, account)) { refused.push({ account, verdict: cache.verdict }); continue; }
    // The row's session fields exactly as linkedSessions shapes them, then the identity overlay.
    active.push(overlayWhoami({ ...account, ...rowSessionFields(account) }, cache.who));
  }

  if (unresolved.length === linked.length) {
    if (unresolved.some((one) => isTemporary(one.state))) return TEMPORARY_MESSAGE;
    if (unresolved.some((one) => one.state === 'reauth_required')) return REJECTED_MESSAGE;
    return NOT_LINKED_MESSAGE;
  }

  // Lines about accounts that will not report this session. With one account linked these are the
  // whole answer; with several they ride alongside the accounts that DID resolve, because one broken
  // workspace must not silence a working one.
  const warnings = [];
  for (const one of unresolved) {
    if (!many) continue;
    warnings.push(isTemporary(one.state) ? temporaryLine(one.account) : rejectedLine(one.account));
  }
  for (const one of refused) {
    if (!many) return one.verdict === 'temporary' ? TEMPORARY_MESSAGE : REJECTED_MESSAGE;
    warnings.push(one.verdict === 'temporary' ? temporaryLine(one.account) : rejectedLine(one.account));
  }
  if (active.length === 0) return warnings.length ? warnings.join('\n') : null;

  // Best-effort like every other write here: writeJsonSecure refuses to overwrite a file it could
  // not replace atomically, and losing this mapping costs one checkpoint's cwd hint — not the
  // repo-map pre-warm or the billing capture below.
  try {
    initSessionState(input.session_id, {
      cwd: orDefault(input.cwd, null),
      transcriptPath: orDefault(input.transcript_path, null),
    });
  } catch { /* best-effort */ }

  // The tracking state is the one the worker's last whoami refreshed.
  let workspaceState = null;
  try { workspaceState = readSessionWorkspace(input.session_id); } catch { workspaceState = null; }
  const trackingByKey = new Map(active.map((session) => [session.key, trackingOf(session.key)]));
  const targetSessions = liveTargets(active, workspaceState, trackingByKey);

  // The repo's origin, one git shell-out for the machine — and only when a probing target has a
  // cached answer the line could come from.
  let remote = null;
  if (targetSessions.some((target) => probesRepo(target) && repoAnswersOf(caches.get(target.key)) != null)) {
    try { remote = resolveOriginRemote(gitImpl, input.cwd); } catch { remote = null; }
  }

  // One line per target clone, in account order: the anonymized notice, or the last /repos/status
  // answer the worker cached for that workspace and remote.
  const announcements = [];
  for (const session of active) {
    for (const target of targetSessions.filter((one) => one.key === session.key)) {
      const line = isAnonymizedTarget(target)
        ? ANONYMIZED_LINE
        : (probesRepo(target) ? cachedRepoLine(caches.get(target.key), target, remote) : null);
      if (line) announcements.push(announceLine(target, line, many));
    }
  }
  try { pruneStale(); } catch { /* best-effort */ }

  // Pre-warm + self-heal the repo-map: discover this session's repo(s) and drop dead roots.
  // Prune and save are seams: both touch the real filesystem (a root's .git, the map file).
  const pruneMap = orDefault(deps.pruneRepoMap, pruneRepoMap);
  const saveMap = orDefault(deps.saveRepoMap, saveRepoMap);
  let warmed = null;
  try {
    const map = loadRepoMap();
    const { dirty } = discoverRepos(input.cwd, gitImpl, map);
    const removed = pruneMap(map);
    // Before the save: a failed write still lets the banner name a repo found this start.
    warmed = map;
    if (dirty || removed > 0) saveMap(map);
  } catch { /* best-effort */ }

  // Built after the pre-warm, on the map it just warmed, so the banner names the place the checkpoint will route.
  let banner = null;
  try {
    const ctx = createRouteContext({ loadRepoMapImpl: () => (warmed == null ? loadRepoMap() : warmed) });
    banner = sessionBanner(input, active, workspaceState, trackingByKey, ctx);
  } catch { /* best-effort */ }

  // The user may have switched auth method since the last session (exporting a key over a ChatGPT
  // sign-in, or back). Realign billing.json to the resolved source before the staleness check
  // reads it — otherwise the stored source stays wrong until the next plan capture. Best-effort:
  // a disk failure must not break session start.
  let billingConfig = null;
  let billingSource = BillingSource.UNKNOWN;
  try {
    billingConfig = readBillingConfig();
    billingSource = resolveSource(billingConfig, env);
    const synced = syncBillingSource(billingConfig, billingSource);
    if (synced) {
      writeBillingConfig(synced);
      billingConfig = synced;
    }

    // Codex rewrites auth.json when the signed-in ChatGPT account changes or its credentials are
    // refreshed. A fresh plan must not hide that newer identity until the weekly plan probe: only
    // a timestamp already attached to a successful capture counts as validated.
    const authFileMtimeMs = readAuthMtime();
    const validatedAuthMtimeMs = (billingConfig || {}).authFileMtimeMs;
    const authFileChanged = typeof authFileMtimeMs === 'number'
      && (typeof validatedAuthMtimeMs !== 'number' || authFileMtimeMs > validatedAuthMtimeMs);
    const authChangeNeedsProbe = authFileChanged
      && (billingSource === BillingSource.SUBSCRIPTION || billingSource === BillingSource.UNKNOWN);

    // Capture the ChatGPT plan ourselves rather than waiting to be asked. Nothing on the automatic
    // path used to read it, so a machine whose user never invoked the login skill reported
    // subscription_plan: null forever while being nudged about it every single session.
    //
    // shouldProbeAccount is THE gate — the single predicate that decides whether this runs at all.
    // Its reasoning is below, at the `if`.
    //
    // The reading and the expired-claim rule live in lib/billing-capture.mjs, shared with
    // scripts/billing-capture.mjs so the two cannot disagree about what an expired claim means.
    //
    // Cost when it runs: ONE SHORT-LIVED `codex app-server` SUBPROCESS (tier 1, bounded by
    // APP_SERVER_TIMEOUT_MS below), one stat, one small read of ~/.codex/auth.json, a base64url
    // decode of the id_token payload, and at most one 0600 write. No network. No token is read.
    //
    // The subprocess is why this gate matters more than it used to. shouldProbeAccount still bounds
    // the work to ~weekly — but the cost behind it is now a process launch rather than a file read,
    // so nothing may move this call out from under the gate, and nothing on the checkpoint hot path
    // may call captureFromCodexAccount at all.
    //
    // It is shouldProbeAccount rather than the old `SUBSCRIPTION && !selfReported && isStale`
    // because THAT TRIO EXCLUDED THE MACHINE TIER 1 EXISTS FOR. With credentials in the OS keychain
    // there is no ~/.codex/auth.json, so the ladder answers `unknown`, `isStale` returns false for
    // every non-subscription source, and the capture that would have resolved it never ran.
    if (authChangeNeedsProbe || shouldProbeAccount(billingConfig, billingSource, Date.now(), { isStale })) {
      // `resolveSource` and `env` travel with it (G-10-1 L1/L3). Without them the capture reached
      // billing-capture.mjs's MODULE-LEVEL resolveSource and the real process.env, so the inner
      // resolution could contradict the outer one on the line above — a machine resolved here as
      // `subscription` could still have its plan fields dropped by a second, unseen resolution
      // reading a different environment and a different auth.json.
      const { config } = await captureFromCodexAccount({
        via: 'session-start',
        existing: billingConfig,
        env: env,
        deps: {
          readChatgptAuth,
          resolveSource,
          readAccountViaAppServer,
          // Shorter than the module default: this sits inside the hook's 10s budget alongside a
          // queue flush and a repo probe, and a machine with no `codex` on its PATH must fall
          // through to tier 2 quickly rather than spending the budget proving it.
          appServerTimeoutMs: APP_SERVER_TIMEOUT_MS,
        },
      });
      if (config) {
        // Advance the marker only after capture succeeded. A transient app-server/auth read failure
        // therefore retries on the next session instead of sealing the stale account indefinitely.
        const captured = typeof authFileMtimeMs === 'number'
          ? { ...config, authFileMtimeMs }
          : config;
        writeBillingConfig(captured);
        billingConfig = captured;
        // RE-RESOLVE on the config we just wrote. The capture can teach the ladder something it
        // did not know a moment ago — step 4b reads the `authType` only a live app-server reading
        // can record — and on a machine with no auth.json that is the difference between
        // `subscription` and `unknown`. Left un-resolved, the nudge below would tell a machine that
        // just captured `plus` that its billing cannot be determined, and the realignment above
        // would have written `unknown` over the source the capture had earned.
        const resolved = resolveSource(billingConfig, env);
        if (resolved !== billingSource) {
          billingSource = resolved;
          const realigned = syncBillingSource(billingConfig, resolved);
          if (realigned) {
            writeBillingConfig(realigned);
            billingConfig = realigned;
          }
        }
      }
    }
  } catch { /* best-effort */ }

  let message = [...warnings, banner, ...announcements].filter(Boolean).join('\n') || null;
  let nudge = null;
  if (billingSource === BillingSource.SUBSCRIPTION && isStale(billingConfig)) {
    // Reached only when the auto-capture above could not name a plan it trusts — so pointing the
    // user at a "refresh" would send them to the command that just failed.
    const expiredAt = (billingConfig || {}).credentialsExpiresAt;
    nudge = (typeof expiredAt === 'number' && expiredAt <= Date.now())
      // Name the date: this is fixable at the source, and "sign in again" is a different and much
      // cheaper action than answering a tier questionnaire.
      ? `Beezi: your Codex sign-in expired on ${new Date(expiredAt).toISOString().slice(0, 10)}, so your plan cannot be read — sign in to Codex again, or ask Beezi to record your plan.`
      : 'Beezi: could not read your ChatGPT plan — usage is reported without a plan. Ask Beezi to sign you in.';
  } else if (billingSource === BillingSource.UNKNOWN) {
    // Reported honestly rather than guessed — but the user can resolve it, so say so.
    nudge = 'Beezi: cannot determine how this machine bills Codex — usage is reported as "unknown". Ask Beezi to sign you in.';
  }
  if (nudge) message = message ? `${message}\n${nudge}` : nudge;

  // The stale-version check (G-8-4), last: it is the only thing here the user can act on outside
  // this session. From the answer the worker's check cached — silent on every outcome except a
  // published version newer than this one.
  const update = cachedUpdateNotice(deps);
  if (update) message = message ? `${message}\n${update}` : update;
  const prompts = [consentPrompt(), correlationPrompt()].filter(Boolean);
  return [message, ...prompts].filter(Boolean).join('\n\n') || null;
}

// ── The worker half (the upload worker's `session-start` due handler) ─────────────────────────────
//
// lib/session-start-upload.mjs loads this on the first session-start marker it handles. It runs
// inside the upload worker, after the worker's full environment guard and with the run's tokened
// sessions (`ctx.sessions`, one credential read per account per run), and leaves on disk what
// runSessionStart above prints next time.

// Per worker run (keyed on the run's `ctx.sessions` array, one per run): each account's token check
// and the update check happen once, however many sessions started.
const uploadRuns = new WeakMap();

function uploadRunOf(ctx) {
  let run = uploadRuns.get(ctx.sessions);
  if (!run) {
    run = { probed: new Map(), updateChecked: false };
    uploadRuns.set(ctx.sessions, run);
  }
  return run;
}

// What a valid whoami said about who the account is: overlaid on the index row by the next start.
function identityOf(who) {
  return {
    valid: true,
    email: orDefault(who.email, null),
    name: orDefault(who.name, null),
    tenantName: orDefault(who.tenantName, null),
    tenants: orDefault(who.tenants, null),
    anonymization: orDefault(who.anonymization, null),
  };
}

// The token check for one account, cached: → the session to report with (the renewed token, the
// whoami identity overlaid), or null when the portal refused it.
//
// whoami reports invalid for any 401/403 — an expired token as well as a permissions or
// wrong-environment refusal — so this only decides what to TELL the user; discarding credentials is
// left to the token endpoint naming the grant revoked. The 401 is the server's verdict on the
// token; expires_at was only ours, and a server that omits expires_in leaves it a guess. So the
// token is renewed once before the link is called bad — otherwise a token that died earlier than
// estimated is never renewed, and every session reports a rejection a single refresh would fix.
// `guardChecked`: the worker ran the full guard before its run, and it passed.
async function checkAccount(session, fetchImpl, deps, now) {
  const authenticate = orDefault(deps.getAuthentication, _getAuthentication);
  let current = session;
  let who = await probeToken(session.key, current, fetchImpl, deps);
  let verdict = 'ok';
  if (isRejected(who)) {
    let retry = null;
    try { retry = await authenticate(session.key, deps, { forceRefresh: true, guardChecked: true }); } catch { retry = null; }
    if (!isPlainObject(retry)) retry = { state: 'unavailable' };
    if (!retry.accessToken && isTemporary(retry.state)) {
      verdict = 'temporary';
    } else {
      const refreshed = retry.accessToken;
      if (refreshed) who = await probeToken(session.key, { ...current, token: refreshed }, fetchImpl, deps);
      if (!refreshed || isRejected(who)) verdict = 'rejected';
      else current = { ...current, token: refreshed };
    }
  }
  // An unreachable whoami (null) still reads as fine, and keeps the identity the last valid one named.
  const valid = (who || {}).valid === true;
  writeSessionStartCache(session.key, {
    checkedAt: now(),
    verdict,
    // The client the verdict was reached under: a re-login re-arms the key with a new one.
    clientId: orDefault(current.clientId, null),
    who: valid ? identityOf(who) : orDefault(readSessionStartCache(session.key).who, null),
  });
  return verdict === 'ok' ? overlayWhoami(current, who) : null;
}

// The sessions whose WHOLE start this account took part in, kept in its cache as `completed`:
// { '<sessionId>': <markedAt of the marker handled> }. Recorded only when the handler finished every
// step for that marker, and keyed on the session because the repo probe is the session's own (its
// cwd): another session's finished start says nothing about it. The marker's `markedAt`, not the
// clock, so a re-mark that lands mid-run is never counted as done. whoami's `checkedAt` is only
// whoami's. At most this many, newest marks kept: dropping one only means its work runs again.
export const START_DONE_MAX = 64;

function startDoneMap(key) {
  const done = readSessionStartCache(key).completed;
  return isPlainObject(done) ? done : {};
}

// → the markedAt this account's last finished start for `sessionId` covered, or NaN.
function startDoneFor(key, sessionId) {
  const done = startDoneMap(key);
  return typeof sessionId === 'string' && Object.prototype.hasOwnProperty.call(done, sessionId) ? Number(done[sessionId]) : NaN;
}

function recordStartDone(key, sessionId, markedAt) {
  if (typeof sessionId !== 'string' || !isFinite(markedAt)) return;
  const merged = Object.assign({}, startDoneMap(key), { [sessionId]: markedAt });
  const newest = Object.keys(merged)
    .filter((id) => isFinite(Number(merged[id])))
    .sort((a, b) => Number(merged[b]) - Number(merged[a]))
    .slice(0, START_DONE_MAX);
  const completed = {};
  for (const id of newest) completed[id] = Number(merged[id]);
  writeSessionStartCache(key, { completed });
}

function cacheRepoAnswer(target, remote, answer, at) {
  const cache = readSessionStartCache(target.key);
  const repos = Object.assign({}, repoAnswersOf(cache), {
    [repoKey(target, remote)]: { connected: Boolean(answer.connected), projectName: orDefault(answer.projectName, null), checkedAt: at },
  });
  writeSessionStartCache(target.key, { repos });
}

/**
 * The network half of one session's start, for a due marker with `sessionStart: true`:
 * (entry, ctx) → { settled }. Unsettled only when the run's deadline cut it short — an offline
 * portal settles (it was silent in the hook too, and the session's next start re-marks).
 *
 * Idempotent across runs: a marker that outlives the run that handled it (kept for its timeline or
 * a checkpoint that did not commit) reaches every later run's handlers, and settles at once when
 * every account finished this session's whole start for this mark or a later one (`completed`). A
 * run cut short after whoami records nothing, so the next run does the rest.
 */
export async function runSessionStartUpload(entry, ctx) {
  const deps = orDefault(ctx.deps, {});
  const now = orDefault(ctx.now, Date.now);
  const deadline = typeof ctx.deadline === 'number' ? ctx.deadline : Infinity;
  const past = () => now() >= deadline;
  const fetchImpl = orDefault(ctx.fetchImpl, fetchCompat);
  const sessions = (Array.isArray(ctx.sessions) ? ctx.sessions : []).filter((s) => s != null && s.token);
  if (sessions.length === 0) return { settled: true };
  const run = uploadRunOf(ctx);
  const markedAt = Number(entry.markedAt);
  if (sessions.every((s) => startDoneFor(s.key, entry.sessionId) >= markedAt)) return { settled: true };
  const complete = () => {
    for (const s of sessions) recordStartDone(s.key, entry.sessionId, markedAt);
    return { settled: true };
  };

  // The token check, per account and SERIALLY: getAuthentication takes `shared:token-refresh-<key>`
  // when it renews, and two rank-3 locks under different names at once in one process is a
  // 'lock-order' refusal rather than a wait.
  const active = [];
  for (const session of sessions) {
    let checked = run.probed.get(session.key);
    if (checked === undefined) {
      if (past()) return { settled: false };
      checked = await checkAccount(session, fetchImpl, deps, now);
      run.probed.set(session.key, checked);
    }
    if (checked !== null) active.push(checked);
  }
  if (active.length === 0) return complete();

  let workspaceState = null;
  try { workspaceState = readSessionWorkspace(entry.sessionId); } catch { workspaceState = null; }
  const trackingByKey = new Map(active.map((session) => [session.key, trackingOf(session.key)]));
  const targetSessions = liveTargets(active, workspaceState, trackingByKey);

  // The repo's origin: one git shell-out, in the session's own cwd (never the worker's), then one
  // probe per platform target.
  let remote = null;
  if (entry.cwd && targetSessions.some(probesRepo)) {
    try { remote = resolveOriginRemote(orDefault(deps.gitImpl, _git), entry.cwd); } catch { remote = null; }
  }
  if (remote) {
    for (const target of targetSessions) {
      if (!probesRepo(target)) continue;
      if (past()) return { settled: false };
      const answer = await probeRepo(remote, target, fetchImpl);
      if (answer) cacheRepoAnswer(target, remote, answer, now());
    }
  }

  // Tell Beezi which ChatGPT account and plan this machine is on (G-2-1). Gated in the module: its
  // steady state — unchanged payload, checked in within the week — is two reads and NO network.
  //   fetchImpl / readChatgptAuth — the run's seams; a bare call would reach the real ones.
  //   timeoutMs: 1500 — a refusal never seals the marker, so an unreachable API costs this every run.
  //   readBillingConfig — billing.json as SessionStart left it (its capture and realignment run in
  //                       the hook), read once; null when unreadable, and the module falls through
  //                       to the id_token decode.
  //   force: false — the payload hash moves on any account or plan change. A capture that learned
  //                  nothing new waits for the weekly resync instead of forcing a check-in.
  // One check-in per target clone, serially: the suppression marker is per account and workspace.
  const syncAccount = orDefault(deps.syncAccount, _syncAccountIfNeeded);
  const readChatgptAuth = orDefault(deps.readChatgptAuth, _readChatgptAuth);
  const readBillingConfig = orDefault(deps.readBillingConfig, _readBillingConfig);
  let billingConfig = null;
  try { billingConfig = readBillingConfig(); } catch { billingConfig = null; }
  for (const target of targetSessions) {
    if (past()) return { settled: false };
    try {
      await syncAccount(target.key, target, { force: false }, {
        fetchImpl,
        readChatgptAuth,
        readBillingConfig: () => billingConfig,
        timeoutMs: 1500,
      });
    } catch { /* best-effort */ }
  }

  // The stale-version check (G-8-4): at most one request an hour (its own gate), once per run.
  if (!run.updateChecked) {
    if (past()) return { settled: false };
    run.updateChecked = true;
    const checkForUpdate = orDefault(deps.checkForUpdate, _checkForUpdate);
    try { await checkForUpdate({ fetchImpl }); } catch { /* best-effort */ }
  }
  return complete();
}
