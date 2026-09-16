---
name: sync
description: Upload past Codex sessions to Beezi analytics, skipping anything Beezi already has. Use when a period is missing from the user's analytics — because the hooks were never trusted or installed, or the machine was offline — or when the user asks to sync, backfill, re-upload, or repair their Beezi history.
---

# Beezi: sync past sessions

Uploads this machine's past Codex sessions to Beezi, resuming each one from exactly the point
Beezi already has it. It asks the server how far each session reaches before it sends anything, so
running it twice uploads nothing twice and running it often is safe.

## Why a Codex user needs this

Codex hooks do not run until the user trusts them in `/hooks`. So the normal Codex lifecycle
includes stretches where sessions were never reported — between installing the plugin and trusting
the hooks, and any period the machine was offline or the hooks were removed. This is the command
that fills those stretches in. (Trust survives a plugin upgrade, so upgrading no longer opens such
a gap.)

It repairs the symptom. Point the user at the `analytics-hooks` skill as well, so the hooks are
installed and trusted and the gap stops reopening.

## This is NOT the one-time import, and must never be used as a way around it

The `login` skill's one-time history import is once per account and tool, and it refuses to run
again once it has been used. **That refusal is not something sync bypasses.** Sync uploads only what
Beezi is missing above what it already holds; it does not consume, reopen, re-run or stand in for
the one-time import, and it does not change whether that import has been used.

If the user asks you to get around the "already been used" refusal, decline as that skill says, and
offer sync only for what it actually is: filling in sessions Beezi never received.

## Running it

This file is at `<plugin-root>/skills/sync/SKILL.md`, so the script is at
`<plugin-root>/scripts/sync.mjs`. Run exactly one command:

```
node "<plugin-root>/scripts/sync.mjs"
```

**It takes no flags.** Not `--since`, not `--force` — the script rejects both with an explanation,
and neither exists to be worked around. `--since` filters on when a session last ran, which would
skip exactly the old half-uploaded sessions this command is for; `--force` has no seal to force
past on this path. If the user pushes for a flag, say the command takes none.

The scan reads every rollout under `~/.codex/sessions/`, so it can take a few minutes on a machine
with a lot of history and it prints progress as it goes. Let it finish. Report the output verbatim.
Never echo a token.

## What the output means

- **everything is already uploaded** — a **success**, not a failure. Beezi has everything this
  machine can offer right now. Say so and stop; do not re-run hoping for a different answer.
- **uploaded `<n>` sessions** — the repair worked. The counts are sessions and reports, not tokens.
- **nothing new was uploaded — `<n>` sessions were left for a later run** — not the same as
  "everything is already uploaded", and the difference matters. Nothing went wrong and nothing was
  lost, but some history is still outstanding for one of the reasons below. Relay the detail lines
  that follow it and say a later run can pick them up. This is the one outcome where re-running
  later is right.
- **could not reach Beezi to check what it already has** — the server could not be asked how far
  each session reaches, so nothing was uploaded **on purpose**. This is not an error and nothing was
  lost or duplicated; the run refuses to guess rather than risk re-sending. Relay it as a
  "try again in a moment", never as a failure or as data loss.
- **left alone: what Beezi has recorded for them does not line up** — Beezi's record of those
  sessions is inconsistent with what this machine believes it sent, so re-uploading them could
  double-count. They were deliberately skipped and stay eligible for a later run. Report it and move
  on; there is no flag that overrides it and asking for one is asking to double-bill the user.
- **their sub-agent activity was not re-checked** — those sessions resumed partway through, and
  Beezi tracks sub-agents separately from the main session, so their sub-agent work is not repaired
  by a partial resume. The main session's usage was still uploaded.
- **some already-saved analytics have not reached Beezi yet** — there is a delivery backlog on disk.
  Nothing was synced this time because the check would have been answered with stale information.
  The backlog retries itself; suggest running sync again afterwards.
- **this workspace is on an audit-only plan** — the workspace's plan does not accept history uploads
  on demand. Point at upgrading the plan in the Beezi portal. Do not suggest the one-time import as
  a substitute.
- **not linked** — run the `login` skill first.
- **the server does not support history sync yet** — the workspace's Beezi server needs updating.
  No history was lost; it can be run again after the portal update.

## When to suggest the hooks instead

If the user is running this repeatedly, the cause is almost always untrusted or missing hooks. Send
them to the `analytics-hooks` skill: with hooks installed and trusted, sessions report themselves
and sync goes back to being a repair tool rather than a routine one.
