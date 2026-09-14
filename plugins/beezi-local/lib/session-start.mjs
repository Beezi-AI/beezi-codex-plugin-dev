import { fetchCompat } from './fetch-compat.mjs';
import { checkForUpdate as _checkForUpdate, updateNotice } from './update-check.mjs';
import fs from 'fs';
import path from 'path';
import { getAccessToken as _getAccessToken, getAuthentication as _getAuthentication } from './token.mjs';
import { flushQueue, SESSION_LOCK_LEASE_MS } from './checkpoint.mjs';
import { git as _git, resolveOriginRemote } from './git.mjs';
import { resolveRepoRoot } from './repo-timeline.mjs';
import {
  loadRepoMap,
  saveRepoMap,
  upsertRoot,
  pruneRepoMap,
  originFromGitConfig,
} from './repo-map.mjs';
import { stateDir } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { pruneStale } from './prune.mjs';
import { withLock, sessionLock } from './single-instance-lock.mjs';
import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson } from './http.mjs';
import { whoami } from './whoami.mjs';
import { recordWhoami } from './tracking.mjs';
import { getMachineClientId } from './machine-identity.mjs';
import { BillingSource } from './billing.mjs';
import {
  readBillingConfig as _readBillingConfig,
  writeBillingConfig as _writeBillingConfig,
  resolveSource as _resolveSource,
  syncBillingSource,
  isStale as _isStale,
  shouldProbeAccount as _shouldProbeAccount,
} from './billing-config.mjs';
import { readCodexAccount as _readCodexAccount } from './codex-account.mjs';
import { orDefault } from './compat.mjs';
import { captureFromCodexAccount } from './billing-capture.mjs';
import { readAccountViaAppServer as _readAccountViaAppServer } from './codex-app-server.mjs';
import { syncAccountIfNeeded as _syncAccountIfNeeded } from './account-sync.mjs';

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
// from the previous turn is still finishing is exactly that interleaving.
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
  }, deps.lockDeps);
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

async function announceRepo(cwd, token, fetchImpl, gitImpl) {
  const remote = resolveOriginRemote(gitImpl, cwd);
  if (!remote) return null; // not a git repo — silent
  try {
    // postJson, not a bare fetch: this runs inside the SessionStart hook's 10s budget, and an
    // unbounded request against a stalled API would hold the whole turn open rather than
    // degrading to the silent "offline" path below.
    const res = await postJson(`${apiBase()}${ENDPOINTS.reposStatus}`, token, { remote }, { fetchImpl });
    if (!res.ok) return null;
    const { connected, projectName } = await res.json();
    // Both branches are informational only. Nothing downstream gates on `connected`: the
    // checkpoint reports every branch of every repo, and work with no origin at all under a
    // `local:<folder>` remote. Saying "no analytics tracked here" would be false.
    return connected
      ? `Beezi: repo connected${projectName ? ` to "${projectName}"` : ''}. Sessions here are tracked.`
      : 'Beezi: this repo is not connected to a Beezi project. Sessions are still tracked, against the repo itself.';
  } catch { return null; } // offline — silent
}

// whoami reports invalid for any 401/403, which covers an expired token and a permissions
// or wrong-environment refusal as well as a genuine revocation — too coarse to delete on.
// So this only decides what to *tell* the user; discarding credentials is left to the token
// endpoint naming the grant revoked, or to the user signing in again.
// Offline/unknown (null) still reads as fine, so a check we couldn't run stays silent.
async function isTokenRejected(token, fetchImpl) {
  const who = await whoami(token, { fetchImpl });
  // Piggyback the tracking-policy refresh on the check we already make: the trackingMode /
  // backfillCompleted cache (tracking.json) goes stale between logins otherwise, and the live
  // gate plus the backfill fast-path both key off it. Best-effort — never blocks session start.
  if ((who || {}).valid === true) {
    try { recordWhoami(who, getMachineClientId()); } catch { /* best-effort */ }
  }
  return (who || {}).valid === false;
}

// How long the SessionStart hook will wait on `codex app-server` before falling through to the
// auth.json decode. The hook's own budget is 10s and already covers a queue flush and a repo probe.
// MEASURED on Windows with codex-cli 0.154.0: 2929ms cold, ~1050ms warm — the launch is the slow
// part (an npm .cmd shim → node → the platform binary), not the protocol. A 3s bound would have cut
// the cold run off and quietly dropped every first probe on a machine like that.
//
// Shorter than the module's own default: this one is spent inside a hook budget, at most weekly.
const APP_SERVER_TIMEOUT_MS = 5000;

// Returns an optional systemMessage string (or null). Never throws for expected failures.
export async function runSessionStart(input, deps = {}) {
  const getAccessToken = orDefault(deps.getAccessToken, _getAccessToken);
  const fetchImpl = deps.fetchImpl || fetchCompat;
  const gitImpl = orDefault(deps.gitImpl, _git);
  const resolveSource = orDefault(deps.resolveSource, _resolveSource);
  const readBillingConfig = orDefault(deps.readBillingConfig, _readBillingConfig);
  const writeBillingConfig = orDefault(deps.writeBillingConfig, _writeBillingConfig);
  const isStale = orDefault(deps.isStale, _isStale);
  const shouldProbeAccount = orDefault(deps.shouldProbeAccount, _shouldProbeAccount);
  const readCodexAccount = orDefault(deps.readCodexAccount, _readCodexAccount);
  // Tier 1 of the plan/account ladder. Threaded like every other reader on this path: a bare call
  // would SPAWN A REAL `codex app-server` from the test suite, which tools/hermetic-env.mjs records
  // as an escape to the developer's own ~/.codex.
  const readAccountViaAppServer = orDefault(deps.readAccountViaAppServer, _readAccountViaAppServer);
  const syncAccount = orDefault(deps.syncAccount, _syncAccountIfNeeded);
  // Threaded rather than read inside the ladder: step 1 of resolveSource is an environment lookup
  // (billing-config.mjs:101-102) and a caller with a resolved environment must be able to hand it
  // over instead of having the host's consulted behind its back (G-10-1 L3).
  const env = orDefault(deps.env, process.env);
  const checkForUpdate = orDefault(deps.checkForUpdate, _checkForUpdate);

  const authenticate = deps.getAuthentication || (deps.getAccessToken
    ? async (options) => ({ accessToken: await getAccessToken({}, options), state: 'unlinked' })
    : async (options) => _getAuthentication({}, options));
  const auth = await authenticate().catch(() => ({ state: 'unavailable' }));
  let token = auth.accessToken;
  if (!token && (auth.state === 'unavailable' || auth.state === 'refreshing')) {
    return 'Beezi authentication is temporarily unavailable or refreshing. Your saved link is preserved; analytics will retry.';
  }
  if (!token)
    return '⚠ Beezi: this machine is not linked — analytics are NOT being tracked. Ask Beezi to sign you in.';

  if (await isTokenRejected(token, fetchImpl)) {
    // The 401 is the server's verdict on the token; expires_at was only ours, and a server that
    // omits expires_in leaves it a guess. Take the server's word and refresh once before
    // declaring the link bad — otherwise a token that died earlier than we estimated is never
    // renewed, and every session reports a rejection that a single refresh would have fixed.
    const retry = await authenticate({ forceRefresh: true }).catch(() => ({ state: 'unavailable' }));
    if (!retry.accessToken && (retry.state === 'unavailable' || retry.state === 'refreshing')) {
      return 'Beezi authentication is temporarily unavailable or refreshing. Your saved link is preserved; analytics will retry.';
    }
    const refreshed = retry.accessToken;
    if (!refreshed || await isTokenRejected(refreshed, fetchImpl)) {
      return '⚠ Beezi: this machine’s link was rejected — analytics are NOT being tracked. Ask Beezi to sign you in again.';
    }
    token = refreshed;
  }

  // Best-effort like every other write here: writeJsonSecure refuses to overwrite a file it could
  // not replace atomically, and losing this mapping costs one checkpoint's cwd hint — not the
  // flush, the repo probe or the billing capture below.
  try {
    initSessionState(input.session_id, {
      cwd: orDefault(input.cwd, null),
      transcriptPath: orDefault(input.transcript_path, null),
    });
  } catch { /* best-effort */ }
  // Independent network I/O on the per-session hot path — flush queued checkpoints
  // and probe repo status concurrently rather than serially.
  //
  // flushQueue takes `shared:queue` itself, so this bare caller needs no lock of its own — and it
  // must not take one: the rank-2 session lock above has already been released by the time this
  // runs, but a rank-3 lock held HERE would be nested inside flushQueue's own and refused.
  const [, systemMessage] = await Promise.all([
    flushQueue(token, { fetchImpl }),
    announceRepo(input.cwd, token, fetchImpl, gitImpl),
  ]);
  try { pruneStale(); } catch { /* best-effort */ }

  // Pre-warm + self-heal the repo-map: discover this session's repo(s) and drop dead roots.
  try {
    const map = loadRepoMap();
    const { dirty } = discoverRepos(input.cwd, gitImpl, map);
    const removed = pruneRepoMap(map);
    if (dirty || removed > 0) saveRepoMap(map);
  } catch { /* best-effort */ }

  // The user may have switched auth method since the last session (exporting a key over a ChatGPT
  // sign-in, or back). Realign billing.json to the resolved source before the staleness check
  // reads it — otherwise the stored source stays wrong until the next plan capture. Best-effort:
  // a disk failure must not break session start.
  let billingConfig = null;
  let billingSource = BillingSource.UNKNOWN;
  // Whether the auto-capture below actually wrote a config. Only the capture sets it: the
  // syncBillingSource realignment preserves the plan fields, so it cannot move the check-in
  // payload, and forcing on it would defeat the resync gate for no news.
  let billingCaptured = false;
  try {
    billingConfig = readBillingConfig();
    billingSource = resolveSource(billingConfig, env);
    const synced = syncBillingSource(billingConfig, billingSource);
    if (synced) {
      writeBillingConfig(synced);
      billingConfig = synced;
    }

    // Capture the ChatGPT plan ourselves rather than waiting to be asked. Nothing on the automatic
    // path used to read it, so a machine whose user never invoked the login skill reported
    // subscription_plan: null forever while being nudged about it every single session.
    //
    // Three gates, in order:
    //   SUBSCRIPTION      — never touch billing.json on an api-key or third-party machine. The
    //                       source ladder already outranks auth.json with env and error evidence,
    //                       so this defers to it rather than going around it.
    //   !selfReported     — a plan the user answered by hand always wins; we do not even look.
    //   isStale           — the exact predicate the nudge below uses, so a capture that succeeds
    //                       silences it in this same run. Normally bounds the work to ~weekly.
    //
    // Capture the ChatGPT plan ourselves rather than waiting to be asked. Nothing on the automatic
    // path used to read it, so a machine whose user never invoked the login skill reported
    // subscription_plan: null forever while being nudged about it every single session.
    //
    // Three gates, in order:
    //   SUBSCRIPTION      — never touch billing.json on an api-key or third-party machine. The
    //                       source ladder already outranks auth.json with env and error evidence,
    //                       so this defers to it rather than going around it.
    //   !selfReported     — a plan the user answered by hand always wins; we do not even look.
    //   isStale           — the exact predicate the nudge below uses, so a capture that succeeds
    //                       silences it in this same run. Normally bounds the work to ~weekly.
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
    if (shouldProbeAccount(billingConfig, billingSource, Date.now(), { isStale })) {
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
          readCodexAccount,
          resolveSource,
          readAccountViaAppServer,
          // Shorter than the module default: this sits inside the hook's 10s budget alongside a
          // queue flush and a repo probe, and a machine with no `codex` on its PATH must fall
          // through to tier 2 quickly rather than spending the budget proving it.
          appServerTimeoutMs: APP_SERVER_TIMEOUT_MS,
        },
      });
      if (config) {
        writeBillingConfig(config);
        billingConfig = config;
        billingCaptured = true;
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

  // Tell Beezi which ChatGPT account and plan this machine is on (G-2-1). Best-effort and gated:
  // its steady state — unchanged payload, checked in within the week — is two reads and NO network.
  //
  // Three things travel that are not optional:
  //   fetchImpl / readCodexAccount — the seams this hook already threads. A bare call would run the
  //                                  real reader and the real fetch, reopening exactly the
  //                                  hermeticity class G-10-1 closed on this path.
  //   timeoutMs: 1500              — a refusal never seals the marker, so an unreachable API would
  //                                  otherwise cost the full POST_TIMEOUT_MS on EVERY session start,
  //                                  forever, inside the hook's 10s budget.
  //   readBillingConfig            — reuses the config this hook just resolved: one fewer read, and
  //                                  the check-in cannot disagree with the hook about the plan. If
  //                                  the billing try threw before its read, billingConfig is null
  //                                  and the module falls through to the id_token decode, which is
  //                                  the correct answer for a machine with no config.
  //
  // `force` is near-redundant here — an account or plan change already moves the payload hash on
  // its own — and is set only when the capture above wrote something, so a machine that just
  // learned its plan reports it in the same run rather than waiting out the resync interval.
  try {
    await syncAccount(token, { force: billingCaptured }, {
      fetchImpl,
      readCodexAccount,
      readBillingConfig: () => billingConfig,
      timeoutMs: 1500,
    });
  } catch { /* best-effort */ }

  let message = systemMessage;
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

  // The stale-version check (G-8-4). Last, and deliberately after everything that reports
  // analytics: it is the only thing here the user can act on outside this session, and it must
  // never be the reason a checkpoint did not flush. At most one request a day, bounded at 2s,
  // and silent on every outcome except a published version newer than this one.
  try {
    const update = updateNotice(await checkForUpdate({ fetchImpl }));
    if (update) message = message ? `${message}\n${update}` : update;
  } catch { /* best-effort */ }
  return message;
}
