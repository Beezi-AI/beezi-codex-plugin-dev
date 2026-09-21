import { runAudit, SYNC_MODE } from '../lib/session-audit.mjs';
import { BackfillHalt } from '../lib/audit-flush.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';
import { orDefault } from '../lib/compat.mjs';
import { cliMayProceed } from '../lib/env-guard.mjs';
import { fail, plural } from '../lib/cli.mjs';

// The repeatable history repair pass (G-3-3 engine, G-9-3 surface).
//
// This is NOT the one-time import. It asks Beezi how far each session already reaches and uploads
// only what is missing above that point, so it is safe to run as often as the user likes and it
// neither consumes nor reopens the one-time backfill's seal.
//
// It reaches back 30 days and no further: MAX_SESSION_AGE_MS in lib/session-audit.mjs is shared
// policy, so a session out of scope for the one-time import is out of scope here too.
//
// It takes NO FLAGS, and both refusals below are mechanical enforcement of that:
//
//   --since filters on the transcript's modification time, which says when a session last RAN, not
//   what Beezi is missing. It would silently exclude exactly the old half-uploaded session this
//   command exists to repair.
//
//   --force exists on the import to skip the LOCAL seal caches. There is no seal on this path to
//   force past, so accepting the flag would only advertise a bypass that does not exist — and
//   invite the model to reach for it the moment the one-time import refuses.

function parseSyncArgs(argv) {
  for (const flag of argv) {
    if (flag === '--since') {
      fail(
        'Beezi: sync takes no --since. It uploads exactly what Beezi is missing from the last 30 '
        + 'days, wherever in that window those sessions ran. Run it with no flags.',
      );
    }
    if (flag === '--force') {
      fail(
        'Beezi: sync takes no --force. There is no one-time seal to force past — sync resumes each '
        + 'session from where Beezi already has it. Run it with no flags.',
      );
    }
  }
  return { mode: SYNC_MODE };
}

async function main() {
  if (!cliMayProceed()) { process.exitCode = 1; return; }
  const options = parseSyncArgs(process.argv.slice(2));

  const result = await runAudit(
    {
      onProgress: ({ processed, total }) => {
        console.log(`Beezi: ${processed}/${total} sessions read…`);
      },
    },
    options,
  );

  if (result.reason === 'no-token') {
    fail('Beezi: this machine is not linked. Sign in to Beezi first (the login skill).');
  }
  if (result.reason === 'lock-order' || result.reason === 'lock-failed') {
    fail(`Beezi: could not start the history sync (${orDefault(result.lastError, 'lock error')}).`);
  }
  if (result.reason === 'run-in-progress') {
    console.log('✓ Beezi: a history upload is already running on this machine — letting it finish.');
    return;
  }
  if (result.reason === 'audit-only') {
    console.log(
      '✓ Beezi: this workspace is on an audit-only plan, so past sessions cannot be uploaded on '
      + 'demand. Upgrade the workspace plan in the Beezi portal to enable live analytics.',
    );
    return;
  }
  // Reports this machine built and Beezi has not received yet. Coverage would be stale by exactly
  // those segments, so the run stops rather than reconcile against an answer it knows is behind.
  if (result.reason === 'pending-not-drained') {
    console.log(
      '✓ Beezi: nothing was synced this time — some already-saved analytics have not reached Beezi '
      + `yet (${orDefault(result.lastError, 'delivery pending')}). They are queued on disk and retried `
      + 'automatically; run sync again once they are through.',
    );
    return;
  }
  if (result.halt === BackfillHalt.LOCK_LOST) {
    console.log(
      '✓ Beezi: another history upload took over partway through. Nothing was lost — run sync again '
      + 'once it finishes.',
    );
    return;
  }
  if (result.halt === BackfillHalt.NOT_ALLOWED || result.halt === BackfillHalt.ALREADY_COMPLETED) {
    fail('Beezi: this workspace does not accept history uploads on demand.');
  }
  if (result.halt === BackfillHalt.UNSUPPORTED_SERVER) {
    fail(
      'Beezi: your workspace’s Beezi server does not support history sync yet — it needs updating. '
      + 'No history was lost; run this again after the portal update.',
    );
  }
  if (result.halt === BackfillHalt.FORBIDDEN) {
    fail(
      `Beezi: the server refused the upload (${orDefault(result.lastError, 'forbidden')}). `
      + 'Check your seat with your workspace admin, then sign in to Beezi again.',
    );
  }

  // The tri-state, surfaced verbatim: "could not ask" must never be printed as "nothing to do".
  if (result.coverageKnown === false) {
    console.log(
      '✓ Beezi: could not reach Beezi to check what it already has, so nothing was uploaded — '
      + 'and nothing was lost or duplicated. Try again in a moment.',
    );
    return;
  }

  if (result.scanned === 0) {
    console.log('✓ Beezi: no past Codex sessions found on this machine.');
    return;
  }

  // "everything is already uploaded" is the ONE phrase the skill teaches the model to read as
  // final — "do not re-run hoping for a different answer". So it is gated on there being nothing
  // left to come back for. A run that deferred history has to say so first, or the surface tells
  // the user to stop precisely when a later retry is the whole point.
  if (result.sessionsImported === 0 && result.deferred > 0) {
    console.log(
      `✓ Beezi: nothing new was uploaded — ${plural(result.deferred, 'session')} were left for a `
      + 'later run. Details below; run sync again afterwards.',
    );
  } else if (result.sessionsImported === 0) {
    // Qualified when the window bit, because the unqualified phrase is the one the skill teaches
    // the model to read as final — and "everything" would be a false claim about older history.
    console.log(
      result.tooOld > 0
        ? '✓ Beezi: everything from the last 30 days is already uploaded.'
        : '✓ Beezi: everything is already uploaded.',
    );
  } else {
    console.log(
      `✓ Beezi: uploaded ${plural(result.sessionsImported, 'session')} `
      + `(${plural(result.reportsStored, 'report')} stored).`,
    );
  }

  // The window is a hard floor on this path too: unlike a deferral, a later run will not reach them.
  if (result.tooOld > 0) {
    console.log(
      `  ${plural(result.tooOld, 'session')} ran more than 30 days ago — sync only reaches back 30 `
      + 'days, so they will not be uploaded by a later run either.',
    );
  }
  if (result.pendingDrained > 0) {
    console.log(`  ${plural(result.pendingDrained, 'saved report')} were delivered before the check.`);
  }
  // Deferred history, split by cause, because the two causes need different follow-up.
  if (result.deferredGap > 0) {
    console.log(
      `  ${plural(result.deferredGap, 'session')} were left alone: what Beezi has recorded for them `
      + 'does not line up with what this machine sent, so re-uploading could double-count. They stay '
      + 'eligible — run sync again later.',
    );
  }
  if (result.deferredOverlap > 0) {
    console.log(
      `  ${plural(result.deferredOverlap, 'session')} were left alone because the resume point could `
      + 'not be honoured. Nothing was sent for them.',
    );
  }
  if (result.childrenDeferred > 0) {
    console.log(
      `  ${plural(result.childrenDeferred, 'session')} were resumed partway, so their sub-agent `
      + 'activity was not re-checked — Beezi records sub-agents separately from the main session.',
    );
  }
  if (result.itemErrors > 0) {
    console.log(`  ${plural(result.itemErrors, 'report')} skipped — their repository is not connected to Beezi.`);
  }
  if (result.reportsFailed > 0 || result.unattributed > 0 || result.permanentRejections > 0) {
    const reason = result.lastError ? ` (last error: ${result.lastError})` : '';
    console.log(
      `  ${plural(result.reportsFailed, 'report')} could not be delivered${reason} — run sync again to retry them.`,
    );
  }
  if (result.unreadable > 0) {
    console.log(`  ${plural(result.unreadable, 'session')} could not be read — not uploaded.`);
  }
  console.log('  Plan and billing details reflect your current setup, not the plan you were on at the time.');
}

main().catch((error) => fail(friendlyMessage(error)));
