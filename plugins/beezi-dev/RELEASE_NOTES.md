# Beezi plugin release notes

## 0.27.0 (2026-11-11) — One-question setup

### New
- **One question: what to track** — terminal setup and the login skill show the summary of your past sessions, then ask one question: track everything, or let you choose the repos and folders. With several workspaces it asks where everything goes, or lets you pick repos for each workspace. The answer is your consent: past sessions from what you track upload in the background, and nothing is sent from a repo or folder you left out. A workspace whose owner chose never to upload past sessions still gets none.
- **Asked once per account** — once tracking is set up for an account on this machine, signing in again asks nothing and says it is already set up. Change it any time in the settings skill.

### Improved
- **Fewer questions** — the plan is detected without asking; when it can't be, Beezi says to set it in the settings skill. The questions about this session's folder, new workspaces, repos with no rule, uploading past sessions and the default account are gone from sign-in.
- **Crash reports are on after setup** — terminal setup and the login skill turn crash reports on unless you already chose. The last lines say what is on, or that `/hooks` still needs your trust; the settings skill changes it.
- **Beezi's colours in terminal setup** — the Beezi mark at the top, violet marks for what is done, a shorter closing block, and tick lists that scroll on small terminals. `NO_COLOR` still turns the colours off.

## 0.26.0 (2026-11-03) — Past sessions without a question, and one question for several workspaces

### New
- **Upload without asking** — when a workspace owner chooses to upload past sessions without asking, login, sync, session start and the terminal setup show the same summary as a notice, say which workspace chose it, and upload. One that fails is retried on its own, without a second notice.
- **One question for several workspaces** — in several workspaces, one summary lists what each sends and hides, the no-ask uploads run, and the others are asked once: "Upload to both" (or "Upload to all N"), "Choose for each" or "Not now". The terminal setup asks it as one list with every workspace ticked, and a last "Not now" row.

## 0.25.0 (2026-10-30) — Anonymized workspaces and ask-first past sessions

### New
- **Past sessions after a yes** — Past sessions are uploaded after you say yes, unless the workspace owner chose to upload them without asking (0.26.0); login, sync and the setup wizard now show what would be sent and ask.
- **Anonymized workspaces** — when a workspace has anonymization on, repo, folder, branch, machine, account and session names are replaced with made-up values on this machine, and Beezi stores only the made-up name. The first request after sign-in, or after a settings change, can carry the computer name, which Beezi hashes on arrival. Error text and agent names stay here.
- **Notice at start** — a new Codex thread says "Beezi: this workspace is anonymized." for each workspace that has it on, and the repo check is no longer sent when the workspace hides folder and repository names.
- **Appears as** — the settings skill shows the name an anonymized workspace sees this machine as.

### Improved
- **Clear stop for a missing key** — sync and the history upload say when an anonymized workspace has no key on this machine yet, instead of reporting nothing uploaded.
- **Past-sessions checklist** — login, sync and the setup wizard show what an upload sends, hides and never sends as a short checklist, and the wizard asks with an Upload now / Not now menu.

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
