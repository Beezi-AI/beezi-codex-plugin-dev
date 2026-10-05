// Is this process one of the model's shell commands, running inside Codex's sandbox?
//
// Hooks and the MCP server are spawned by Codex itself and run unsandboxed; a skill's
// `node scripts/<x>.mjs` is spawned by the model and is sandboxed unless the user approved an
// escalation. Codex marks a sandboxed child with CODEX_SANDBOX ('seatbelt' on macOS) and, when the
// sandbox has no network, CODEX_SANDBOX_NETWORK_DISABLED=1.
//
// It matters for the credential store: macOS Seatbelt's base profile has no
// com.apple.SecurityServer lookup (only the network profile adds it), so `security
// find-generic-password` comes back empty — byte-identical to a locked keychain. The OS store is
// fine; the command just has to run outside the sandbox. Sandbox and network settings can differ
// per project, the likely reason the same command works in one directory and not another.
export function inCodexSandbox(env = process.env) {
  if (!env) return false;
  return (typeof env.CODEX_SANDBOX === 'string' && env.CODEX_SANDBOX !== '')
    || env.CODEX_SANDBOX_NETWORK_DISABLED === '1';
}

// Worded for the model as much as for the user: "sandbox" and "run it again with escalated
// permissions" are what the skills and the workspace prompt tell it to retry on.
export const SANDBOXED_CREDENTIAL_STORE_MESSAGE = 'Beezi: this command ran inside the Codex sandbox, which can'
  + ' block access to the system credential store (the macOS keychain), so Beezi could not read its'
  + ' saved sign-in. Nothing was changed. Run it again with escalated permissions so the user can'
  + ' approve it.';
