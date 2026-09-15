---
name: me
description: Show this machine's Beezi link status — whether it is linked, to which account, against which Beezi API, and whether the analytics hooks are installed. Use when the user asks "am I linked / signed in to Beezi", who they are linked as, or why their Beezi analytics look empty.
---

# Beezi: me

Read-only. Changes nothing, so it is safe to run whenever the request is ambiguous.

## Answering it

**Use the `beezi_status` tool.** It takes no arguments and reports whether the machine is linked, to
which account, which Beezi API it checked against, and whether the analytics hooks are installed —
all from the process that actually holds the credentials.

Do **not** answer this from a script if the tool is available. The MCP server inherits
`BEEZI_API_URL` and the credential store from Codex; a shell command may not, so the two can
disagree. If they do, trust the tool and say the script ran with a different environment.

If the tool is not available, this file is at `<plugin-root>/skills/me/SKILL.md`, so the fallback
script is:

```
node "<plugin-root>/scripts/me.mjs"
```

Report the output verbatim, and never echo a token or the contents of the credentials file.

## Reading the answer

The answer is normally **two lines**, and both matter. The first is the link verdict; the second is a
separate reporting verdict — whether analytics are actually being reported right now. Relay both.
A machine can be linked and still be reporting nothing, which is the whole reason the second line
exists.

If only the link line comes back, the hook registry could not be read. That is not a malformed
answer and not an error to escalate — report the link verdict alone, and offer the `analytics-hooks`
skill if the user wants the hook half checked.

### Line 1 — the link

- **linked** — the machine is linked and the account is named. If analytics are still empty, the
  hooks are the other half: see the `analytics-hooks` skill.
- **not linked** — run the `login` skill.
- **revoked** — the link was revoked from the Beezi portal. Logging in again re-links it; no need to
  log out first.
- **could not reach Beezi** — says nothing about the link itself. The credentials may be fine and
  the hooks may be reporting from a process that can see the API; queued reports are retried
  automatically. Check the connection, or `BEEZI_API_URL` if the address in the answer is wrong.

### Line 2 — is anything actually being reported

Hook state comes back in the same answer, folded into this second line. **installed** does not mean
analytics are flowing — Codex also requires the user to trust the hooks once via `/hooks`, and the
answer says so explicitly when the hooks are installed but nothing is arriving. That combination —
linked, hooks installed, still no data — is the platform's most common failure, and the trust step
is the fix.

The other reporting verdicts name their own remedy: hooks **not installed** and **hooks pointing at
an older plugin version** (after an upgrade) both print the exact install command to run, followed
by re-trusting via `/hooks`; an **incomplete install** does the same. When the link could not be
verified, reporting status is reported as *unknown* rather than broken — queued reports are retried
automatically once the API is reachable. The `analytics-hooks` skill covers the install/repair side.

## What this answer does not cover

Neither line says anything about **crash reporting** — a separate local setting, off by default and
never implied by being linked. Send any question about crash reports, error reporting, diagnostics
or telemetry to the `telemetry` skill rather than guessing: a link verdict is not a consent verdict.
