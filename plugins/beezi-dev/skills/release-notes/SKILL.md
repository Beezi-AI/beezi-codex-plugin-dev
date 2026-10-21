---
name: release-notes
description: Show what changed in the Beezi plugin — the installed version's release notes, every release, or one named version. Use when the user asks what's new in Beezi, for the Beezi changelog or release notes, or what changed in a Beezi version. For the installed version and whether an update is out, `beezi_status` answers too.
---

# Beezi: release notes

Prints the release notes for the installed Beezi plugin, with a short table of the releases before
it and, when a newer version is published, how to update. It reads the notes shipped with the
plugin and the last update check this machine saved; it calls no server.

**Check this session first.** Before the first Beezi script in this session, run
`node "<plugin-root>/scripts/preflight.mjs"` as it is, inside the sandbox and not escalated: it only
reads this Codex session's own log, and it is the one script that needs nothing the sandbox blocks.
Its `preflight=` line is for you only. On `preflight=blocked` it first prints lines starting `✗`:
show them verbatim and run no other Beezi script, because this session cannot let them out of the
sandbox and those lines tell the user how to change that. A blocked answer holds only until then:
the user may switch with `/permissions`, so run the preflight again before the next Beezi script. On
`preflight=unknown`, judge from your own permissions instructions: an approval policy of `never`
under a sandbox is the same answer, so tell the user to restart Codex with
`codex --sandbox workspace-write --ask-for-approval on-request` (or, only on a machine they trust,
`codex --dangerously-bypass-approvals-and-sandbox`) and run no Beezi script. Otherwise carry on.

**Run every other script outside the sandbox.** Every other `node "<plugin-root>/scripts/…"` command
in this skill reads Beezi's sign-in from the system credential store (Windows Credential Manager, the
macOS keychain), reads and writes Beezi's data under the user's home folder, outside the
workspace, and most of them call the Beezi server. The Codex sandbox blocks all three, so a
sandboxed run fails, or can report a wrong answer such as "no account linked". Run each of them
with escalated permissions from the first attempt, never in the sandbox first: set
`sandbox_permissions` to `"require_escalated"` (or use whatever escalation your shell tool offers)
with a one-sentence `justification` saying what the command does, so the user can approve it.
When this session has no sandbox (full access), run the commands as they are. If the user declines
the approval, run nothing further from this skill and say the step needs their approval. A command
that ran in the sandbox and prints a line naming it is run once more, escalated; one that already
ran escalated and still fails is not retried: show its line and stop.

## Running it

This file is at `<plugin-root>/skills/release-notes/SKILL.md`, so the script is at
`<plugin-root>/scripts/release-notes.mjs` — use the absolute path. Run exactly one command:

```
node "<plugin-root>/scripts/release-notes.mjs"
```

Add `all` when the user asks for every release, or the version when they name one, exactly as
digits and dots like `0.22.8`. Never pass anything else.

```
node "<plugin-root>/scripts/release-notes.mjs" all
node "<plugin-root>/scripts/release-notes.mjs" <version>
```

Do not read, open or inspect any other file, and do not ask the user anything first.

## Showing the answer

Copy the command's whole output into your reply exactly as printed. It is markdown, so write it as
markdown, NOT in a code block, and never summarize or paraphrase it. Add nothing else.

A `✗` line or the usage line is shown verbatim too; then stop.

Never run the update steps it names (`codex plugin marketplace upgrade`) yourself, even if the user
asks in the same message: the upgrade replaces the plugin under the running thread, so the user runs
it and then starts a new Codex thread.
