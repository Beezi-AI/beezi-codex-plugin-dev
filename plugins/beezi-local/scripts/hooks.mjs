import { installHooks, uninstallHooks, hooksStatus, TRUST_STEP } from '../lib/hooks-install.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';

// Dead entries are reported in EVERY branch, including `installed`.
//
// Codex spawns a registered hook whether or not its target still exists, and a failed spawn is
// reported as `hook: <Event> Failed` for the whole event — so one orphan left by a variant the
// user has since removed breaks that event's reporting for every session on the machine. This
// block is the only thing that names it: `state` is owner-scoped by design, so the owner that can
// see the orphan is usually not the owner that can remove it.
function reportBroken(status) {
  if (!status.broken || !status.broken.length) return;

  const owners = [];
  for (const entry of status.broken) {
    if (owners.indexOf(entry.owner) === -1) owners.push(entry.owner);
  }

  console.log('');
  console.log(`⚠ Beezi: ${status.broken.length} registered hook entr${status.broken.length === 1 ? 'y points' : 'ies point'} at a file that no longer exists.`);
  console.log('  Codex runs these every session and every run fails — check `hook: <Event> Failed`.');
  for (const entry of status.broken) {
    console.log(`    ${entry.event} · ${entry.owner} · ${entry.target}`);
  }
  console.log(`  Registry: ${status.hooksFile}`);
  for (const owner of owners) {
    // `install` and `uninstall` are BOTH offered for our own owner, and the order is not a
    // preference. The shape that produced this report on a live machine was a variant the user had
    // stopped running at all — for that, `install` is the wrong answer twice over: it re-registers
    // five hooks they do not want and asks them to trust every one.
    console.log(owner === status.owner
      ? `  Repair (${owner}): run this script with \`install\` to re-point them at this version — or with \`uninstall\` if you no longer run this variant.`
      : `  Repair (${owner}): run that variant's \`node .../scripts/hooks.mjs uninstall\`, or delete the entries above from the registry by hand.`);
  }
  console.log(`  Either way, ${TRUST_STEP}.`);
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

function main() {
  const action = process.argv[2] || 'status';

  if (action === 'status') return reportStatus();

  if (action === 'install') {
    const { hooksFile, events } = installHooks();
    console.log(`✓ Beezi: analytics hooks written to ${hooksFile}`);
    console.log(`  Events: ${events.join(', ')}`);
    console.log('');
    console.log('  One more step — Codex will not run a hook it has not been shown:');
    console.log(`    ${TRUST_STEP}.`);
    console.log('  Trust is recorded against each hook’s hash, so repeat this after any upgrade.');
    return;
  }

  if (action === 'uninstall') {
    const { hooksFile, removed } = uninstallHooks();
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
