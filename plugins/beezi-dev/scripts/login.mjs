import { performLogin } from '../lib/login.mjs';
import url from 'url';
import { ensureHooks, TRUST_STEP } from '../lib/hooks-install.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';
import { cliMayProceed } from '../lib/env-guard.mjs';

function onStep(step) {
  if (step.type === 'already-linked') {
    console.log(`\n✓ This machine is already linked to Beezi${step.account ? ` as ${step.account}` : ''}.`);
    return;
  }
  if (step.type === 'authorize-url') {
    console.log('\nBeezi analytics — link this machine\n');
    console.log('Opening your browser to sign in with your Beezi account…');
    console.log(`If it does not open, go to:\n  ${step.url}\n`);
    return;
  }
  // The launcher failed — a sandboxed shell, no http association, no PowerShell. Say so plainly
  // instead of leaving the user watching a prompt that looks like it is still working.
  if (step.type === 'browser-failed') {
    console.log('✗ Could not open a browser automatically'
      + `${step.detail ? ` (${step.detail})` : ''}.`);
    console.log(`  Open this URL yourself to finish signing in:\n  ${step.url}\n`);
    console.log('  Waiting for you to complete the sign-in…\n');
    return;
  }
  if (step.type === 'linked') {
    console.log(`\n✓ Beezi analytics linked${step.account ? ` as ${step.account}` : ''}. Credentials stored in ${step.storedIn}.`);
  }
}

// Linking is only half of setup: Codex refuses to load hooks bundled in a plugin, so nothing is
// reported until the hooks are installed into ~/.codex/hooks.json and trusted once.
//
// So install them HERE, rather than printing the command and leaving the user to run it. Signing in
// is an unambiguous "I want my analytics reported" — there is no version of this flow where the
// answer to "install the hooks?" is no, and the step the user was being handed is one they can only
// get wrong by forgetting it. ensureHooks() is a no-op on a healthy install, so a repeat login does
// not rewrite the registry and does not revoke trust.
//
// This runs after the credentials are stored, so a failure here must never fail the login.
function reportHookStep() {
  let result = null;
  try {
    result = ensureHooks();
  } catch {
    return;
  }
  if (result.skipped) {
    console.log('  Another Beezi process is updating the hook registry; it will be current in a moment.');
    return;
  }
  if (!result.repaired) {
    console.log(`  Analytics hooks are installed. If nothing arrives, ${TRUST_STEP}.`);
    return;
  }
  console.log(result.before === 'absent'
    ? '\n  Analytics hooks installed for you.'
    : `\n  Analytics hooks repaired for you (they were ${result.before}).`);
  // The one thing that cannot be done for them: Codex has no non-interactive way to grant trust.
  console.log(`  One step left — ${TRUST_STEP}.`);
}

// R1 names login first among the things the guard precedes, and for the sharpest reason: a
// production sign-in on a machine whose queue was captured against staging is the exact sequence
// that flushes one tenant's segments to another. The migration therefore happens BEFORE the browser
// opens, not after the token lands. R-numbers cite docs/plans/2026-09-10-sections/REVIEW.md.
if (!cliMayProceed()) process.exit(1);

performLogin({ onStep })
  .then(() => {
    reportHookStep();
    console.log('');
  })
  .catch((error) => {
    console.error(`\n✗ ${friendlyMessage(error)}`);
    process.exit(1);
  });
