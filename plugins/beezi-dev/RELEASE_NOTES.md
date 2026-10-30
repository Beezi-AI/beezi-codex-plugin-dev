# Beezi plugin release notes

## 0.24.14 (2026-10-30) — Approval waits, clear-context plans and older sessions

### New
- **Approval waits** — time spent waiting on a command or patch approval prompt now shows on the timeline as waiting on you. Trust the new `PermissionRequest` entry once in `/hooks`; until then these waits are not recorded. Note: approval records are kept only on this machine, for 35 days; a backfill after that, or on another machine, shows no approval waits.
- **Clear-context plans** — accepting a plan with "Yes, clear context" now keeps the plan approval wait on the original session instead of losing it to the new thread.

### Fixed
- **Older sessions** — sessions Codex has compressed (older than 7 days) are now read by sync and backfill. They need Node 22.15+ or 23.8+; on an older Node they are skipped and the number skipped is printed.

## 0.24.0 (2026-10-29) — Large sessions upload

### Fixed
- **Large sessions upload** — rollouts over 64 MB are no longer skipped by the history upload or sync, and each turn reads a session once.
- **Subagent forks bill only their own work** — even when the replayed prefix holds a blank or unreadable line.

## 0.23.1 (2026-10-22) — "Don't track" stands alone, and several workspaces at sign-in

### Fixed
- **"Don't track" stands alone** — choosing it together with a workspace no longer saves "not tracked" and drops the workspace: the terminal setup clears the other choices, and Codex asks again.
- **"None of these" stands alone** — after joining a workspace, choosing it together with repos is asked again instead of skipping the repos.

### Improved
- **Several workspaces at sign-in** — "Where should analytics from this machine go?" now offers "Several workspaces…", so everything can go to more than one workspace.

## 0.23.0 (2026-10-21) — Clearer settings, a session banner and one-question sign-in

### New
- **Session banner** — every new Codex thread starts with who you're signed in as, your workspaces, and where this folder's analytics go.
- **Undo** — a rule or New folders change ends with "Undo: ask the settings skill to undo.", and asking puts your last change back.
- **Folder picker** — stop tracking another folder by picking it from your most-used ones instead of typing a path.
- **Release notes** — ask the release-notes skill what changed in each version.

### Improved
- **You're here** — the settings skill's rules table shows where this folder's analytics go, with a Default row, a "← you're here" marker, each rule's path or remote and its sessions over the last 30 days.
- **Clearer settings menu** — each option shows its current state, each view opens in one step, and the Rules menu ends with Close.
- **Status names your folder and version** — Beezi status now says where this folder's analytics go, which plugin version is installed, and how to update when a newer one is out.
- **One-question sign-in** — the login skill and the terminal setup ask one question, "Where should analytics from this machine go?", with how many past sessions go there.
- **Fewer steps** — sync and logout finish in fewer steps when there is nothing to ask.

## 0.22.10 (2026-10-16) — Terminal setup shows its progress

### Improved
- **Progress you can see** — the terminal setup shows a spinner and names each step while it works.
- **Tidy output** — long lines wrap to fit the window.

## 0.22.9 (2026-10-14) — Sync works on audit-only workspaces

### Fixed
- **Sync on audit-only workspaces** — the sync skill now uploads past sessions to a workspace on an audit-only plan instead of refusing.

## 0.22.8 (2026-10-14) — Pick repos for each workspace you join

### New
- **Repos per workspace** — after joining workspaces, choose which repos and folders go to each one, or add them to all.

### Improved
- **Quicker start** — joining several workspaces looks through your repos once, so the upload starts sooner.

## 0.22.7 (2026-10-13) — Faster history upload

### Improved
- **Faster uploads** — uploading past sessions is much faster.
