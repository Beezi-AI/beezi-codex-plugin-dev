---
name: track
description: Save Beezi analytics for the current git branch right now, without waiting for a lifecycle hook. Use when the user asks to track, checkpoint, sync, or push this session's token usage to Beezi, or wants analytics captured for work they just finished.
---

# Beezi: track this branch

Checkpoints the current session's token usage and attributes it to the current repository and
branch. This drives the same engine the lifecycle hooks use, so it works whether or not the hooks
are installed and trusted. Work outside a git repo is tracked too, under the folder's name.

## Running it

This file is at `<plugin-root>/skills/track/SKILL.md`, so the script is at
`<plugin-root>/scripts/track.mjs`. Run it from the repository the user is working in — the current
working directory is how it finds the repo, the branch, and this session's transcript:

```
node "<plugin-root>/scripts/track.mjs"
```

Do not read, open, or inspect any other files. Report the output verbatim — the success line, or
the error if the repo or branch does not qualify. Never echo a token.

## What the output means

- **saved for `<label>`** — segments were queued and sent. The count is segments, not tokens. The
  label varies and does not change the outcome: it is the branch's task when there is one, otherwise
  the branch, otherwise the folder's name. A folder name means the work was outside any git repo, or
  in a repo with no `origin` remote — it is still tracked, attributed to a `local:<folder>` stand-in
  remote rather than skipped, and only the folder name is sent, never the path around it. Nothing to
  fix in any of those cases.
- **nothing new to save** — everything up to this point was already reported. Not an error; do not
  re-run hoping for a different answer.
- **not linked** — run the `login` skill first.
- **could not reach the server — analytics will be retried automatically** — a network or API
  failure, not data loss. The work is queued on disk and the next checkpoint (or the next session's
  start-up flush) sends it. Say so; do not imply anything was dropped, and do not re-run to force it.
- **the server rejected this report** (or a specific rejection message in its place) — the only
  outcome worth escalating. The report reached Beezi and was refused. Report the message verbatim
  and stop; re-running will not change the answer.
- **could not find this session's transcript** — Codex writes one rollout per session under
  `~/.codex/sessions/`; a brand-new session with no activity yet has nothing to checkpoint.

## When to suggest the hooks instead

If the user is running this repeatedly, point them at the `analytics-hooks` skill: with hooks
installed and trusted, checkpoints happen automatically at every turn end and around git commits,
and this manual step stops being necessary.

## When to suggest `sync` instead

This skill only ever saves **the session it is run from**. It cannot repair a period that is already
missing from the user's analytics — sessions that ran while the hooks were untrusted or stale after
an upgrade, or on a machine that was offline. That is the `sync` skill's job: it asks Beezi how far
each past session reaches and uploads only the rest. Reach for it whenever the user says analytics
are missing for work they have already finished, rather than re-running this one.
