import { readHookInput } from '../lib/hook-input.mjs';
import { appendPermissionMarker } from '../lib/permission-markers-codex.mjs';

// Records the instant Codex is about to put an approval prompt on screen, so the session timeline
// can charge the wait that follows to the human. Codex writes neither the request nor the decision
// to the rollout, so this line is the only evidence an approved prompt ever happened.
//
// SAFETY, read before editing: Codex lets a PermissionRequest hook DECIDE. JSON on stdout carrying
// a decision auto-approves the prompt, and exit code 2 with stderr text denies it. Exit 0 with empty
// stdout is "no decision", which is the only outcome wanted here. So this file prints nothing, ever
// — no console call, no stdout write — and never sets an exit code: it just returns, whether it ran
// directly or was import()ed by scripts/hook-launcher.mjs. Everything is inside try/catch so an
// error cannot escape as an uncaught throw (exit 1 would at least be "no decision", but not by
// design).
//
// Deliberately the leanest hook in the plugin: two imports, no network, no runHook, no env guard.
// The prompt does not appear until this process exits, so every millisecond here is one the human
// spends looking at a frozen terminal. It posts nothing.
try {
  const input = readHookInput();
  if (input && typeof input.session_id === 'string' && input.session_id) {
    appendPermissionMarker(input);
  }
} catch {
  // swallowed on purpose
}
