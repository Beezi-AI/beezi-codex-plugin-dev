import { ensureEnvironmentMigrated, checkRootWithoutCredentials } from './env-migration.mjs';
import { orDefault } from './compat.mjs';
import { beeziCodexHome } from './paths.mjs';
import { apiOrigin } from './config.mjs';

// ── The entry-point guard (R1) ──────────────────────────────────────────────────────────────
// R-numbers cite docs/plans/2026-09-10-sections/REVIEW.md.
//
// THE RULE, stated once for every entry point: no upload, no drain and no credential work while the
// data root is mid-cutover or its environment cannot be established. Hooks read no credentials, so
// they reach its credential-free form (hookMayProceedLocal(), and checkEnvironmentLocal() with
// noticeFor() at SessionStart); the full guard runs in the upload worker, the MCP server and the CLI
// scripts, which reach it through cliMayProceed() (it prints the reason it refuses).
//
// Validated per OPERATION, within a short memo window: a resident MCP server spans recovery and
// migrations, so a remembered answer must expire on its own. A refused check is retryable and is
// never remembered; authentication must not replace the evidence first.

// ── the memo ────────────────────────────────────────────────────────────────────────────────
//
// The full guard reads one credential blob per linked account, and on Windows each read is a
// PowerShell spawn of about 1.1 s. One hook asks the guard several times (its own entry check,
// then once per account inside getAuthentication), so the answer is remembered for MEMO_TTL_MS.
// A hit is not blind: it re-runs the credential-free checks (binding, journal, barrier, API
// origin) and falls back to the full guard unless they still pass — only the reads are saved.
//
// What is remembered: only 'ok' and 'migrated' (stored as 'ok') — the verdicts that let work
// proceed. 'deferred' and 'blocked' are re-asked every time, so a refusal stays retryable the
// moment its cause clears.
// For how long: 30 s, longer than a hook's whole budget (HOOK_TIMEOUT_SEC = 20) so one hook run
// pays for the guard once, and short enough that a resident process — the MCP server calls this
// on every message — sees a rollback, a re-binding or a stale sign-in within half a minute.
// Keyed by: the deps object. Every production caller passes none and shares one slot; a test
// that injects a root or a reader gets a slot of its own, so two worlds never share an answer.
// The shared slot also records the data root and API origin it was computed for, and is ignored
// when either differs — the two inputs a process can change under it (BEEZI_CODEX_HOME and
// BEEZI_API_URL are read at call time).
const MEMO_TTL_MS = 30_000;
const NO_DEPS = Object.freeze({});
// Frozen: every hit hands out this one object, so no caller may rewrite it for the next.
const REMEMBERED_OK = Object.freeze({ status: 'ok' });
let memo = new WeakMap();

// What the shared slot's answer depends on that the deps object does not show; null when the
// environment cannot even name a root, which the guard itself then refuses — never remembered.
function contextOf(key) {
  if (key !== NO_DEPS) return '';
  try { return `${beeziCodexHome()}|${apiOrigin()}`; } catch { return null; }
}

/** Forget every remembered verdict. For tests, and for nothing else. */
export function resetEnvironmentMemo() {
  memo = new WeakMap();
}

function guarded(run) {
  try {
    return run();
  } catch (err) {
    // A guard that throws would take down a hook that has nothing to do with the migration. An
    // unexpected failure is treated as "cannot establish the environment", which fails CLOSED —
    // the same posture as every other branch here, because the thing being prevented is an upload
    // to the wrong tenant.
    return {
      status: 'blocked',
      reason: 'guard-failed',
      message: `Beezi: the data root could not be checked (${String(err && err.message)}),`
        + ' so nothing is being uploaded.',
    };
  }
}

const proceeds = (result) => result.status === 'ok' || result.status === 'migrated';

export function checkEnvironment(deps) {
  const key = deps || NO_DEPS;
  const now = orDefault(key.now, Date.now)();
  const context = contextOf(key);
  const remembered = memo.get(key);
  // `now >= at` as well as the window: a clock stepped backwards must not stretch the memo.
  if (remembered && context !== null && remembered.context === context
    && now >= remembered.at && now - remembered.at < MEMO_TTL_MS) {
    // A hit still re-runs every check that needs no credential. Another process can rebind the
    // root (migrate-env --rollback), hold the migration barrier or leave an unfinished journal
    // while a resident MCP server keeps asking, and none of that may be answered from the memo:
    // anything but ok drops the slot and the full guard decides, as if nothing were remembered.
    // What the memo saves is the credential reads, and only those.
    if (checkEnvironmentLocal(key === NO_DEPS ? {} : key).status === 'ok') return remembered.result;
    memo.delete(key);
  }
  const ensure = orDefault(key.ensureEnvironmentMigrated, ensureEnvironmentMigrated);
  // A fresh object for the production call: the guard writes into the deps it is given (the
  // barrier's verifyMigration), and the shared key is frozen and outlives this call.
  const result = guarded(() => ensure(key === NO_DEPS ? {} : key));
  // A migration is reported to the caller that ran it, once. What is remembered is what a fresh
  // check of the now-bound root would answer — a plain ok — so the notice is never repeated.
  if (proceeds(result) && context !== null) memo.set(key, { at: now, context, result: REMEMBERED_OK });
  else memo.delete(key);
  return result;
}

/**
 * The credential-free guard, for the hooks (they only record local state) and the watcher's
 * local-only pass.
 *
 * Same verdict shape as checkEnvironment(), computed from the binding, the migration journal,
 * the barrier lock, accounts/data presence and the API origin alone — no credential read and no
 * write. Its limits are listed at checkRootWithoutCredentials() in lib/env-migration.mjs: in
 * short, it answers 'ok' only for a root already bound to this environment, and refuses every
 * root it would need a credential to decide. It is never the authority before an upload; the full
 * guard is, and every path that posts runs it. Not memoized — it costs a few file reads.
 */
export function checkEnvironmentLocal(deps = {}) {
  const check = orDefault(deps.checkRootWithoutCredentials, checkRootWithoutCredentials);
  return guarded(() => check(deps));
}

/**
 * Does this caller want the environment guard run at all?
 *
 * One predicate, two call sites (getAuthentication in lib/token.mjs, keyed on `getCredentials`,
 * and runWatchPass in lib/rollout-watcher.mjs, keyed on `linkedSessions`), because the
 * triple-negated form was duplicated and read backwards.
 * `workKey` is the module's real-work seam and `guardKey` its guard seam: a caller that injected
 * the work seam is a test standing in for the whole operation and skips the guard, UNLESS it also
 * injected a guard of its own, which is the test that wants the refusal exercised. Production
 * injects neither, so the guard always runs.
 */
export function shouldCheckEnvironment(deps, workKey, guardKey) {
  return !deps[workKey] || Boolean(deps[guardKey]);
}

/**
 * The hook form: silent, and never a non-zero exit.
 *
 * A hook that writes to stderr or exits non-zero is reported by Codex as a failed hook, which is
 * a worse user experience than the missing analytics it would be complaining about. A blocked or
 * deferred guard therefore just stops the hook doing work; the message reaches the user through
 * SessionStart's systemMessage, which is the one hook with a channel for it.
 *
 * @returns true when the hook may proceed.
 */
export function hookMayProceed(deps) {
  return proceeds(checkEnvironment(deps));
}

/** hookMayProceed() without a credential read; see checkEnvironmentLocal() for what it cannot see. */
export function hookMayProceedLocal(deps = {}) {
  return proceeds(checkEnvironmentLocal(deps));
}

/**
 * The message a SessionStart should surface, or null. Covers both the one-time migration notice
 * and the standing refusal, because a user whose analytics have silently stopped needs to be told
 * why on every session, not once.
 */
export function environmentNotice(deps) {
  return noticeFor(checkEnvironment(deps));
}

/**
 * The notice for a verdict the caller already holds — SessionStart asks the guard once and takes
 * both whether to proceed and what to tell the user from that one answer.
 */
export function noticeFor(result) {
  if (result.status === 'migrated') return orDefault(result.message, null);
  if (result.status === 'blocked') return orDefault(result.message, null);
  return null;
}

/** Whether a verdict the caller already holds lets a hook proceed. */
export function verdictProceeds(result) {
  return proceeds(result);
}

/**
 * The CLI form: prints the reason and reports whether the command may continue.
 *
 * Unlike a hook, a CLI command is something the user just typed and is watching, so silence is
 * the wrong answer — but the exit code stays with the caller, because `me` wants to keep printing
 * status after a refusal while `sync` must not run at all.
 */
export function cliMayProceed(deps) {
  const result = checkEnvironment(deps);
  if (result.status === 'ok') return true;
  if (result.status === 'migrated') {
    if (result.message) console.log(result.message);
    return true;
  }
  if (result.status === 'deferred') {
    console.error('✗ Beezi is migrating this machine\'s data to the production namespace.'
      + ' Try again in a moment.');
    return false;
  }
  console.error(orDefault(result.message, '✗ Beezi: the data root could not be checked.'));
  return false;
}
