import { linkStatus, describeLink, describeReporting } from '../lib/link-status.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';
import { LinkState } from '../lib/link-status.mjs';
import { cliMayProceed } from '../lib/env-guard.mjs';

async function main() {
  // R1: no upload, no drain and no credential work while the data root is mid-cutover or its
  // environment cannot be established. cliMayProceed() prints the reason it refuses.
  if (!cliMayProceed()) { process.exitCode = 1; return; }
  const status = await linkStatus();
  console.log(`${status.state === LinkState.LINKED ? '✓' : '•'} Beezi: ${describeLink(status)}`);
  const reporting = describeReporting(status);
  if (reporting) console.log(`  ${reporting}`);
}

main().catch((error) => {
  console.error(`\n✗ ${friendlyMessage(error)}`);
  process.exit(1);
});
