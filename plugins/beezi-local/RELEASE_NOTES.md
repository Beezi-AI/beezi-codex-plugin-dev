# Beezi plugin release notes

## 0.24.1 (2026-10-23) — Past-sessions checklist

### Improved
- **Past-sessions checklist** — login, sync and the setup wizard show what an upload sends, hides and never sends as a short checklist, and the wizard asks with an Upload now / Not now menu.

## 0.24.0 (2026-10-21) — Anonymized workspaces

### New
- **Past sessions only after a yes** — Past sessions are uploaded only after you say yes; login, sync and the setup wizard now show what would be sent and ask.
- **Anonymized workspaces** — when a workspace has anonymization on, repo, folder, branch, machine, account and session names are replaced with made-up values on this machine before anything is sent, and error text and agent names stay here.
- **Notice at start** — a new Codex thread says "Beezi: this workspace is anonymized." for each workspace that has it on, and the repo check is no longer sent when the workspace hides folder and repository names.
- **Appears as** — the settings skill shows the name an anonymized workspace sees this machine as.

### Improved
- **Clear stop for a missing key** — sync and the history upload say when an anonymized workspace has no key on this machine yet, instead of reporting nothing uploaded.

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
