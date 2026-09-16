import { linkStatus, describeLink, describeReporting } from '../lib/link-status.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';
import { LinkState } from '../lib/link-status.mjs';
import { cliMayProceed } from '../lib/env-guard.mjs';
import { ensureHooks, TRUST_STEP } from '../lib/hooks-install.mjs';

// "Why is nothing being tracked?" is what brings a user here, and the answer used to be a command
// to go and run. Fix it instead, then report. A healthy install is not rewritten — see ensureHooks
// on why that matters for trust — so this is a no-op on every run but the one that needed it.
//
// LINKED MACHINES ONLY, the same rule the MCP bridge follows: nothing writes hook entries on behalf
// of someone who has never signed in. Login installs them at the moment analytics are asked for.
//
// Never lets a hook repair fail a status read: the two are independent, and the link half of the
// answer is still worth printing when the registry cannot be written.
function healHooks() {
  try {
    const result = ensureHooks();
    if (result.repaired) {
      return `  Analytics hooks were ${result.before === 'absent' ? 'installed' : 'repaired'} just now — to finish, ${TRUST_STEP}.`;
    }
    // A launcher-only refresh changes no registry entry, so no re-trust is owed — but the hook
    // state printed above was captured before the file came back, and this line reconciles it.
    if (result.launcherRefreshed) return '  The hook launcher was refreshed just now — no re-trust needed.';
    return null;
  } catch {
    return null;
  }
}

async function main() {
  if (!cliMayProceed()) { process.exitCode = 1; return; }
  const status = await linkStatus();
  // Repaired AFTER the link check, so the state the user is left in is the one being described:
  // `describeReporting` below reads the hook state captured with `status`, which predates the
  // repair, and the line healHooks() returns is what reconciles the two.
  const healed = status.state === LinkState.LINKED ? healHooks() : null;
  console.log(`${status.state === LinkState.LINKED ? '✓' : '•'} Beezi: ${describeLink(status)}`);
  const reporting = describeReporting(status);
  if (reporting) console.log(`  ${reporting}`);
  if (healed) console.log(healed);
}

main().catch((error) => {
  console.error(`\n✗ ${friendlyMessage(error)}`);
  process.exit(1);
});
