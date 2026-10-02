---
name: sync
description: Upload past Codex sessions to Beezi analytics, skipping anything Beezi already has. Use when a period is missing from the user's analytics — because the hooks were never trusted or installed, or the machine was offline — or when the user asks to sync, backfill, re-upload, or repair their Beezi history.
---

# Beezi: sync past sessions

Uploads this machine's past Codex sessions to Beezi, resuming each one from exactly the point
Beezi already has it. It asks the server how far each session reaches before it sends anything, so
running it twice uploads nothing twice and running it often is safe.

**It reaches back 30 days and no further.** Sessions that ran longer ago are never uploaded, by
this command or by the `login` skill's one-time import — the window is the same for both. If the
run reports sessions skipped for age, tell the user plainly that a later run will not pick them up.

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

This file is at `<plugin-root>/skills/sync/SKILL.md`, so the scripts are at `<plugin-root>/scripts/`
— use the absolute path. Two steps, in order. Do not read, open, or inspect any other files.

**Asking.** A question below uses `request_user_input` only when that tool is listed this turn and
the question has 2–3 choices. Otherwise it is one plain sentence naming every choice — never a
numbered list or a bullet menu — that ends your reply; when the answer arrives, run its command and
carry on from the next question, then step 2. Ask one question at a time. A skipped question runs
nothing.

### Step 1 — repos and folders with no rule

Run, adding `--account <account>` when the user named an account:

```
node "<plugin-root>/scripts/workspace.mjs" routes
```

Its output is for you only, except the one line named below. It lists, per account in several
workspaces whose New folders setting is Ask me, the repos and folders whose past sessions have no
rule yet. Its lines:

- `<email>: <N> repos or folders have past sessions with no rule (<M> sessions) account=<key>` —
  starts one account's block;
- `W. <workspace> account=<key> tenant=<id> role=<role>` — one per workspace of that account;
- `P<i>. <short> (<full label>), <k> sessions account=<key> kind=<repo|folder> match=<match>` — one
  repo or folder (a `P` line). `P<i>. outside a project, <k> sessions account=<key> kind=outside match=outside`
  is one too: every past session in the home folder, `/` or a temp folder;
- `P<i>-command=<command>` — right after its `P` line: the rule command for it, ending in a literal
  `<tenants>`. It is not a `P` line;
- `all-command=<command>` — one per account: the command that gives all of that account's `P` lines
  the same workspaces, ending in a literal `<tenants>`;
- `<n> other past sessions have no recorded folder and are not sent.` (or `1 other past session has
  no recorded folder and is not sent.`) — write this line verbatim, once; there is nothing to ask
  about it;
- `routes=<total>` — the number of `P` lines, always last.

Not linked, or `routes=0` → nothing to ask; go to step 2.

For each account with `P` lines (with several accounts, end every question with " (<email>)"):

More than 4 `P` lines → first ask "Where should analytics for these <N> repos and folders go?"
(`<N>` = that account's number of `P` lines) with the choices "Send all <N> to the same
workspaces…" (described "Pick the workspaces once for all of them"), "Choose per repo" ("One
question per repo or folder") and "Skip" ("Nothing from them is sent this time; you're asked again
next time").

- "Send all <N> to the same workspaces…" → ask "Which workspaces should get analytics for these <N>
  repos and folders?", one choice per `W.` line of that account (named and described as below),
  several allowed — `request_user_input` only with at most 3 `W.` lines, the question followed by
  " Pick one, or name several under Other."; otherwise the plain sentence ending " — one or more?".
  Nothing chosen → run nothing. Otherwise run that account's `all-command=` text EXACTLY ONCE,
  changing nothing except the final `<tenants>`, which becomes the chosen `tenant=` values joined by
  commas.
- "Choose per repo" → the per-repo questions below.
- "Skip" or a skipped question → nothing more for that account.

4 or fewer `P` lines → the per-repo questions.

**The per-repo questions** — one question per `P` line, in turn, numbered across that account's `P`
lines (`i` from 1, `N` = their number). This question counter restarts for each account; the printed
`P` numbers are global across accounts. Preserve each printed `P` number to match its command;
never use the question counter to look up a `P<i>-command`. `<short>` is the `P` line's text after its `P` number up to ` (`
or `,`, and `<label>` the text in the parentheses after it. The question and its last choice follow
the line's `kind=`:

| `kind=`   | Question                                                                     | Last choice               |
| --------- | ---------------------------------------------------------------------------- | ------------------------- |
| `repo`    | "(i of N) Where should analytics for <short> go?"                            | "Don't track this repo"   |
| `folder`  | "(i of N) Where should analytics for <label> (and everything inside it) go?" | "Don't track this folder" |
| `outside` | "(i of N) Where should analytics for sessions outside a project folder go?"  | "Don't track these"       |

Choices: one per `W.` line of that account — the workspace name (the text after `W. ` up to
` account=`), described by the line's `role=` value (nothing when it is empty) — then the last
choice, described "Nothing from <short> is uploaded" ("Nothing from sessions outside a project
folder is uploaded" for `outside`). Several workspaces may be chosen.

- `request_user_input` only with at most 2 `W.` lines (3 choices): header "Beezi", the question
  followed by " Pick one, or name several under Other.", the labels exactly as above.
- Otherwise the plain sentence: the question without its "?", a colon, each workspace as
  "<name> (<role>)" (just "<name>" with no role), then " — one or more — or <last choice, lower-case
  first letter>?". For example: "(1 of 2) Where should analytics for acme-api go: Acme (Owner), Beta
  (User), Gamma (User) — one or more — or don't track this repo?"

Then, for each answered `P` line, run its `P<i>-command=` text EXACTLY ONCE, changing nothing except
the final `<tenants>`: the chosen `tenant=` values joined by commas (e.g. `t1,t2`), or `none` when
the last choice was picked (it wins over the others). Never rebuild the command or re-quote its path
yourself. A `P` line with nothing chosen, or a skipped question, runs nothing: its sessions are not
sent this time, and the next sync asks again.

Write each command's first line verbatim. The rule commands write Beezi's settings under the user's
home, outside the workspace: if the sandbox refuses one, run it again with escalated permissions so
the user can approve it.

### Step 2 — sync

```
node "<plugin-root>/scripts/sync.mjs"
```

**Run it with no flags unless the user names an account.** With none, it runs for every linked
account in turn; with more than one linked it prints a `── Account: … ──` heading before each, and
everything between one heading and the next is that account's outcome. Beezi is asked separately,
per account, how far it already has each session, so one account's run says nothing about what
another is missing.

To scope the run to a single account, add `--account <account>` — a key, an email address, or a
position from `node "<plugin-root>/scripts/accounts.mjs" list`. A value matching no linked account
is refused and the run does not start.

For an account in several workspaces, each past session goes where its own repo or folder routes:
its rule, else the New folders setting ("Send to" workspaces get it; under Ask me or Don't send it is
not sent this time). Add `--tenant <workspace>[,<workspace>…]` only when the user asks to sync
specific workspaces instead: that is an override that sends every past session to those workspaces,
ignoring rules, and with several accounts linked it needs `--account <account>` too.

**It takes no other flags** than `--account` and `--tenant`. Not `--since`, not `--force` — the
script rejects both with an explanation, and neither exists to be worked around. `--since` filters on
when a session last ran, which would skip exactly the old half-uploaded sessions this command is for;
`--force` has no seal to force past on this path. If the user pushes for either, say the command
takes neither.

The scan reads every rollout under `~/.codex/sessions/`, so it can take a few minutes on a machine
with a lot of history and it prints progress as it goes. Let it finish. Report the output verbatim.
Never echo a token.

## What the output means

- **`── Account: <who> [<key>] ──`** — a heading, printed only when more than one account is linked.
  The lines below it are that account's run, and the outcomes in this list are per account: one
  account can report "everything is already uploaded" while the next uploads sessions. Report each
  account's outcome under its own heading.
- **`Beezi (<account>): <R> past sessions follow your rules; …`** — for an account in several
  workspaces: where its past sessions go, by their rules and then by the New folders setting.
  "… not sent this time" is expected after a skipped step 1 question: the next sync asks again, and
  the settings skill's Rules adds a rule from inside that repo or folder. When it is an account's
  only line, the run succeeded with nothing to send.
- **`— <account> · <workspace> —`** — a heading inside an account in several workspaces: the run
  goes once per workspace its sessions reach, and the lines below it are that workspace's outcome.
  Report each under its own heading; one workspace's refusal does not stop the others.
- **this account belongs to several workspaces and none was picked for this run** — nothing was
  uploaded for it. Point at the settings skill (Rules and New folders) to say where analytics go,
  then run sync again.
- **could not use the saved credentials for that account** — that account is linked on this machine
  but no working sign-in could be produced for it, so nothing was uploaded **for it**. Any other
  account in the same run is unaffected — read the headings. Point at the `login` skill, signing in
  as that account. Do not report it as the machine being unlinked; it is not.
- **everything is already uploaded** — a **success**, not a failure. Beezi has everything this
  machine can offer right now. Say so and stop; do not re-run hoping for a different answer.
- **uploaded `<n>` sessions** — the repair worked. The counts are sessions and reports, not tokens.
- **nothing new was uploaded — `<n>` sessions were left for a later run** — not the same as
  "everything is already uploaded", and the difference matters. Nothing went wrong and nothing was
  lost, but some history is still outstanding for one of the reasons below. Relay the detail lines
  that follow it and say a later run can pick them up — except sessions whose history was split
  between workspaces (below), which a later run does not repair. This is the one outcome where
  re-running later is right. When every one of them is split, it reads **nothing new was uploaded —
  `<n>` sessions were left alone** instead: relay it and the detail line, and do not suggest a rerun.
- **could not reach Beezi to check what it already has** — the server could not be asked how far
  each session reaches, so nothing was uploaded **on purpose**. This is not an error and nothing was
  lost or duplicated; the run refuses to guess rather than risk re-sending. Relay it as a
  "try again in a moment", never as a failure or as data loss.
- **left alone: what Beezi has recorded for them does not line up** — Beezi's record of those
  sessions is inconsistent with what this machine believes it sent, so re-uploading them could
  double-count. They were deliberately skipped and stay eligible for a later run. Report it and move
  on; there is no flag that overrides it and asking for one is asking to double-bill the user.
- **left alone: their history was split between workspaces, so what Beezi has for this workspace
  does not prove a safe resume point** — only for an account in several workspaces. Part of such a
  session went to this workspace and a part in between went to another workspace (or was not
  tracked), so Beezi's record for this workspace stops at that gap and cannot say what it holds
  after it; re-uploading could double-count. A later run does not change this. Report it and move
  on; there is no flag that overrides it and asking for one is asking to double-bill the user.
- **sub-agents left alone** — every sync also uploads any sub-agent activity Beezi is missing, but
  these were skipped on purpose: live tracking is still delivering them (it will finish on its own),
  or they ran before 11 September 2026, when sub-agent ids changed, and re-sending them could
  double-count. The main sessions were still checked. Report it and move on.
- **(dry run): sync would send N reports** — only when the user asked for `--dry-run`: a preview.
  Nothing was sent; relay the number and say so.
- **some already-saved analytics have not reached Beezi yet** — there is a delivery backlog on disk.
  Nothing was synced this time because the check would have been answered with stale information.
  The backlog retries itself; suggest running sync again afterwards.
- **this workspace is on an audit-only plan** — the workspace's plan does not accept history uploads
  on demand. Point at upgrading the plan in the Beezi portal. Do not suggest the one-time import as
  a substitute.
- **not linked** — run the `login` skill first.
- **Your one-time history upload stays open until those repos and folders have a rule — run the
  login skill or the sync skill to choose.** — printed by the login skill's one-time upload, not by
  this command; step 1 above is what gives those repos and folders a rule.
- **the server does not support history sync yet** — the workspace's Beezi server needs updating.
  No history was lost; it can be run again after the portal update.

## When to suggest the hooks instead

If the user is running this repeatedly, the cause is almost always untrusted or missing hooks. Send
them to the `analytics-hooks` skill: with hooks installed and trusted, sessions report themselves
and sync goes back to being a repair tool rather than a routine one.

For an account in several workspaces, sync resumes each workspace's sessions from what Beezi
already has, exactly as for one workspace. Only a session whose history for that workspace was split
— another workspace (or no workspace) took a stretch between parts that went to it — is left alone,
because Beezi's record stops at the gap; do not promise that retries will repair those.
