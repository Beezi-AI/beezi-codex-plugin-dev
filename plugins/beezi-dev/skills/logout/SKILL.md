---
name: logout
description: Unlink this machine from Beezi analytics (sign out). Use when the user wants to log out of Beezi, unlink or disconnect this machine, or remove the stored Beezi credentials. To sign in or switch accounts use the `login` skill; to check whether the machine is linked use the `me` skill.
---

# Beezi: logout

## Confirm first

Unlinking is rarely what someone asking to **switch accounts** wants — logging in again re-links the
machine over the old credentials, with no logout needed. Ask before running anything unless the user
clearly asked to sign out or disconnect this machine.

## Finding the script

The command below runs a script under the plugin's `scripts/` directory. That directory is two
levels above this `SKILL.md` — this file is at `<plugin-root>/skills/logout/SKILL.md`, so the script
is at `<plugin-root>/scripts/`. Use the absolute path; `codex plugin list` also prints the plugin
root for `beezi` if you need to confirm it.

There is no MCP logout tool. `beezi_login` and `beezi_status` are the only two the server holds, so
this one is the script.

```
node "<plugin-root>/scripts/logout.mjs"
```

Do not read, open, or inspect any other files, and never echo a token or the contents of the
credentials file. Report the output verbatim.

## Reading the answer

The script never claims a logout it did not perform, and its wording distinguishes a **confirmed
server unlink** from a **local-only** one. Relay that difference — a user who is told "logged out"
when the portal still lists the machine will not go and remove it.

- **`✓ Logged out. This machine is unlinked from Beezi.`** — the portal dropped the machine and its
  OAuth grant. Done, nothing left for the user to do.
- **`✓ Logged out and access revoked.`** — the portal was unreachable, so the grant was revoked at
  the authorization server instead. The credentials are dead, but the machine may still be listed in
  the portal's **Connections** tab; tell the user they can remove it there.
- **`✓ Logged out locally.`** — neither the portal nor the authorization server could be reached.
  The credentials are gone from this machine, so nothing here reports any more, but the link may
  still be live in the portal. Tell the user to remove the machine from the **Connections** tab.
- **`Beezi: this machine is not linked. Nothing to do.`** — there was nothing to unlink. Not an
  error; say so plainly.
- **An error line (`✗ …`), or a refusal to proceed.** The machine is **still linked**. The script
  also refuses while the data root is mid-migration, and prints its own reason. Report the message
  and stop — do not retry in a loop and do not delete any credentials file by hand.

## After logging out

The MCP server keeps running with the tool list it already advertised, so the `beezi` tools may
still be listed in the current session — calls to them now fail with a credentials-rejected error.
`beezi_login` still works: signing in again from the same session re-links the machine, no new
Codex thread needed.

Logging out does not remove the analytics hooks from `~/.codex/hooks.json`. They stay installed and
do nothing while the machine is unlinked — every checkpoint stops at the missing token, so sessions
run while signed out are not captured at all, not merely held back. If the user wants the hooks
gone too, that is the `analytics-hooks` skill.

Whatever was already queued under `~/.beezi-codex` and never sent is left alone — logout deletes
only the credentials. Logging back in on the same machine drains that queue on the next checkpoint.
The plugin does prune queued items older than 14 days, so a long time signed out loses them.

## What this does not do

- It does not delete anything already reported to Beezi. That is an account matter for the portal.
- It does not turn crash reporting on or off — that is a separate, local setting. See the
  `telemetry` skill.
- `~/.beezi` is the Claude Code plugin's directory and is never touched by this plugin. Logging out
  here does not sign the user out of Claude Code's Beezi plugin.
