import { trackSession, resolveTrackTarget } from '../lib/track-session.mjs';
import { quarantinePoisonedSessionState } from '../lib/transcript-codex.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';
import { cliMayProceed } from '../lib/env-guard.mjs';
import { fail } from '../lib/cli.mjs';

const cwd = process.cwd();

async function main() {
  if (!cliMayProceed()) { process.exitCode = 1; return; }
  // FIRST, before anything reads state/ or drains queue/. A machine that already ran an older
  // build can hold `state/null.json` and `queue/null_*.json` written by an id-less session; the
  // sweep moves them somewhere inspectable instead of leaving them to be resolved against or
  // posted under a session named "null". No-op on a clean machine, and never fatal — the
  // resolver refuses to answer with a poisoned state file whether or not this succeeds.
  let quarantined = null;
  try { quarantined = quarantinePoisonedSessionState(); } catch { /* best-effort */ }
  if (quarantined && quarantined.moved.length > 0) {
    console.log(
      `Beezi: moved ${quarantined.moved.length} unattributable analytics file${quarantined.moved.length === 1 ? '' : 's'} `
      + `to ${quarantined.dir} (nothing was deleted).`,
    );
  }

  const target = resolveTrackTarget(cwd);
  if (!target.ok) fail(target.message);

  const { ok, message } = await trackSession({
    sessionId: target.sessionId,
    transcriptPath: target.transcriptPath,
    cwd,
  });
  if (!ok) fail(message);
  console.log(`✓ ${message}`);
}

main().catch((error) => fail(friendlyMessage(error)));
