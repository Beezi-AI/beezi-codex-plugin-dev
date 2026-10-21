import { USAGE, settingsLines } from '../lib/settings-cli.mjs';
import { UserError, friendlyMessage } from '../lib/friendly-error.mjs';
import { cliMayProceed } from '../lib/env-guard.mjs';

// A thin wrapper. Every view is composed in lib/settings-cli.mjs, where it can be tested in-process.

async function main() {
  if (!cliMayProceed()) { process.exitCode = 1; return; }
  const [cmd, ...rest] = process.argv.slice(2);
  // One view per call, nothing after it.
  if (rest.length !== 0) throw new UserError(USAGE);
  for (const line of await settingsLines(cmd)) console.log(line);
}

main().catch((error) => {
  console.error(`\n✗ ${friendlyMessage(error)}`);
  process.exit(1);
});
