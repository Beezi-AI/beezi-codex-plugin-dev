import { ensureEnvironmentMigrated } from './env-migration.mjs';
import { orDefault } from './compat.mjs';

// ── The entry-point guard (R1) ──────────────────────────────────────────────────────────────
//
// Validate each operation: resident MCP processes may span recovery and migrations.
// A refused check is retryable; authentication must not replace the evidence before this check.

export function checkEnvironment(deps = {}) {
  // Resident MCP processes can span recovery or a migration. Revalidate every operation.
  const ensure = orDefault(deps.ensureEnvironmentMigrated, ensureEnvironmentMigrated);
  let result;
  try {
    result = ensure(deps);
  } catch (err) {
    // A guard that throws would take down a hook that has nothing to do with the migration. An
    // unexpected failure is treated as "cannot establish the environment", which fails CLOSED —
    // the same posture as every other branch here, because the thing being prevented is an upload
    // to the wrong tenant.
    result = {
      status: 'blocked',
      reason: 'guard-failed',
      message: `Beezi: the data root could not be checked (${String(err && err.message)}),`
        + ' so nothing is being uploaded.',
    };
  }
  return result;
}

/** Test seam only: forget the memoized answer. */
export function resetEnvironmentCheck() {
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
export function hookMayProceed(deps = {}) {
  const result = checkEnvironment(deps);
  return result.status === 'ok' || result.status === 'migrated';
}

/**
 * The message a SessionStart should surface, or null. Covers both the one-time migration notice
 * and the standing refusal, because a user whose analytics have silently stopped needs to be told
 * why on every session, not once.
 */
export function environmentNotice(deps = {}) {
  const result = checkEnvironment(deps);
  if (result.status === 'migrated') return orDefault(result.message, null);
  if (result.status === 'blocked') return orDefault(result.message, null);
  return null;
}

/**
 * The CLI form: prints the reason and reports whether the command may continue.
 *
 * Unlike a hook, a CLI command is something the user just typed and is watching, so silence is
 * the wrong answer — but the exit code stays with the caller, because `me` wants to keep printing
 * status after a refusal while `sync` must not run at all.
 */
export function cliMayProceed(deps = {}) {
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
