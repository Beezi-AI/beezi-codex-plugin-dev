import { ensureHooks, installHooks, uninstallHooks, hooksStatus, TRUST_STEP } from '../lib/hooks-install.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';

// Dead entries are reported in EVERY branch, including `installed`.
//
// Codex spawns a registered hook whether or not its target still exists, and a failed spawn is
// reported as `hook: <Event> Failed` for the whole event — so one orphan left by a variant the
// user has since removed breaks that event's reporting for every session on the machine. This
// block is the only thing that names it: `state` is owner-scoped by design, so the owner that can
// see the orphan is usually not the owner that can remove it.
//
// It no longer asks the user to go and run the OTHER variant's uninstall. That instruction was
// unanswerable in the shape that produced it — the variant that left the orphans was one the user
// had already removed, so there was nothing left to run. `install` sweeps them itself now.
function reportBroken(status) {
  if (!status.broken || !status.broken.length) return;

  console.log('');
  console.log(`⚠ Beezi: ${status.broken.length} registered hook entr${status.broken.length === 1 ? 'y points' : 'ies point'} at a file that no longer exists.`);
  console.log('  Codex runs these every session and every run fails — check `hook: <Event> Failed`.');
  for (const entry of status.broken) {
    console.log(`    ${entry.event} · ${entry.owner} · ${entry.target}`);
  }
  console.log(`  Registry: ${status.hooksFile}`);
  console.log('  Run this script with `install` — it removes them, whichever variant left them.');
}

// What the sweep cleared, named rather than counted: the paths are the only way a user can tell
// this was their stale variant and not something of their own.
function reportSwept(swept) {
  if (!swept || !swept.length) return;
  console.log(`  Removed ${swept.length} dead hook entr${swept.length === 1 ? 'y' : 'ies'} left by an older or deleted install:`);
  for (const entry of swept) {
    console.log(`    ${entry.event} · ${entry.owner} · ${entry.target}`);
  }
}

function reportStatus() {
  const status = hooksStatus();

  if (status.state === 'installed') {
    console.log('✓ Beezi: analytics hooks are installed.');
    console.log(`  Registry: ${status.hooksFile}`);
    console.log(`  Events:   ${status.registered.join(', ')}`);
    console.log(`  If analytics are not arriving, ${TRUST_STEP}.`);
    reportBroken(status);
    return;
  }

  if (status.state === 'absent') {
    console.log('Beezi: analytics hooks are not installed. Run this script with `install`.');
    reportBroken(status);
    return;
  }

  console.log(
    status.state === 'stale'
      ? '⚠ Beezi: the analytics hooks point at an older plugin version.'
      : '⚠ Beezi: the analytics hook install is incomplete.',
  );
  if (status.registered.length) console.log(`  Registered: ${status.registered.join(', ')}`);
  if (status.missingEvents.length) console.log(`  Missing:    ${status.missingEvents.join(', ')}`);
  if (status.staleEvents.length) console.log(`  Stale:      ${status.staleEvents.join(', ')}`);
  console.log('  Run this script with `install` to repair.');
  reportBroken(status);
}

// `install` goes through ensureHooks, so a healthy install is left untouched.
//
// That is not a saved write. Codex records trust against each entry's HASH, so rewriting five
// identical entries revokes the trust the user has already granted and sends them back to `/hooks`
// for nothing. `--force` exists for the one case the no-op cannot serve: a registry that reads as
// installed but that the user wants rewritten anyway.
function runInstall(force) {
  if (force) {
    const forced = installHooks();
    if (forced.skipped) return reportBusy();
    console.log(`✓ Beezi: analytics hooks rewritten in ${forced.hooksFile}`);
    console.log(`  Events: ${forced.events.join(', ')}`);
    reportSwept(forced.swept);
    reportTrust();
    return;
  }

  const result = ensureHooks();
  if (result.skipped) return reportBusy();

  if (!result.repaired) {
    console.log('✓ Beezi: analytics hooks are already installed and current — nothing to change.');
    console.log(`  Registry: ${result.status.hooksFile}`);
    console.log(`  Events:   ${result.status.registered.join(', ')}`);
    console.log('  Left untouched on purpose: a rewrite would change each hook’s hash and revoke the trust you already granted.');
    console.log(`  If analytics still are not arriving, ${TRUST_STEP}.`);
    return;
  }

  console.log(result.before === 'absent'
    ? `✓ Beezi: analytics hooks installed in ${result.status.hooksFile}`
    : `✓ Beezi: analytics hooks repaired in ${result.status.hooksFile} (was ${result.before}).`);
  console.log(`  Events: ${result.status.registered.join(', ')}`);
  reportSwept(result.swept);
  reportTrust();
  reportBroken(result.status);
}

function reportTrust() {
  console.log('');
  console.log('  One more step — Codex will not run a hook it has not been shown:');
  console.log(`    ${TRUST_STEP}.`);
  console.log('  Trust is recorded against each hook’s hash, so repeat this after any upgrade.');
}

// Contention on the registry lock is not a failure: another Beezi process is writing the very same
// entries. Say so plainly rather than reporting success for a write that did not happen.
function reportBusy() {
  console.log('Beezi: another Beezi process is updating the hook registry right now — nothing was changed.');
  console.log('  It is writing the same entries. Re-run this in a moment to see the result.');
}

function main() {
  const action = process.argv[2] || 'status';
  const force = process.argv.indexOf('--force') !== -1;

  if (action === 'status') return reportStatus();
  if (action === 'install') return runInstall(force);

  if (action === 'uninstall') {
    const { hooksFile, removed, skipped } = uninstallHooks();
    if (skipped) return reportBusy();
    console.log(
      removed
        ? `✓ Beezi: analytics hooks removed from ${hooksFile}. Your other hooks were left alone.`
        : 'Beezi: no analytics hooks were installed — nothing to remove.',
    );
    return;
  }

  console.error(`✗ Beezi: unknown action '${action}'. Use install, uninstall, or status.`);
  process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(`\n✗ ${friendlyMessage(error)}`);
  process.exit(1);
}
