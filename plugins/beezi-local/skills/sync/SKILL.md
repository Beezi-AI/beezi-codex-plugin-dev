---
name: sync
description: Upload past Codex sessions to Beezi analytics, skipping anything Beezi already has. Use when a period is missing from the user's analytics — because the hooks were never trusted or installed, or the machine was offline — or when the user asks to sync, backfill, re-upload, or repair their Beezi history.
---

# Beezi: sync past sessions

Shows what an upload of this machine's past Codex sessions would send, asks, and uploads only the
sessions it showed, and only after the user answers Upload. Running this skill is not a yes: nothing
is sent until that answer. The upload resumes each session from exactly the point Beezi already has
it. It asks the server how far each session reaches before it sends anything, so running it twice
uploads nothing twice and running it often is safe.

**It reaches back 30 days and no further.** Sessions that ran longer ago are never uploaded, by
this command or by the `login` skill — the window is the same for both. If the
run reports sessions skipped for age, tell the user plainly that a later run will not pick them up.

## Why a Codex user needs this

Codex hooks do not run until the user trusts them in `/hooks`. So the normal Codex lifecycle
includes stretches where sessions were never reported — between installing the plugin and trusting
the hooks, and any period the machine was offline or the hooks were removed. This is the command
that fills those stretches in. (Trust survives a plugin upgrade, so upgrading no longer opens such
a gap.)

It repairs the symptom. Point the user at the `analytics-hooks` skill as well, so the hooks are
installed and trusted and the gap stops reopening.

## Running sync is not a yes

Running this skill, or showing its summary, uploads nothing. Past sessions go up only after the user
answers Upload to a question this skill showed, and only the sessions that question counted. Never
run `--accept` for a question the user did not answer with Upload, and never to get round a "Not now"
the user gave before: run sync again so the user is asked again.

Each upload resumes every session from exactly the point Beezi already has it, so nothing Beezi holds
is sent twice.

## Running it

This file is at `<plugin-root>/skills/sync/SKILL.md`, so the scripts are at `<plugin-root>/scripts/`
— use the absolute path. Two steps, in order. Do not read, open, or inspect any other files.

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

**Asking.** A question below uses `request_user_input` only when that tool is listed this turn and
the question has 2–3 choices. Otherwise it is one plain sentence naming every choice — never a
numbered list or a bullet menu — that ends your reply; when the answer arrives, run its command and
carry on from the next question, then step 2. Ask one question at a time. A skipped question runs
nothing.

### Step 1 — new workspaces, then repos and folders with no rule, then the summary

Run this one command, adding `--account <account>` when the user named an account (and step 2's
`--tenant` override when the user asked for it):

```
node "<plugin-root>/scripts/sync.mjs" --review
```

It prints a `<joined>` block (new workspaces, below) and stops there when that block's last line is
not `joined=0`. Otherwise it prints a `<routes>` block (repos and folders with no rule, below) and
stops there when its last line is not `routes=0`. Its next line, `review=<n>`, is for you only: the
number of `J` or `P` lines waiting for an answer. On `review=0` it goes straight on to the sync:
everything after that line is step 2's output, and no other command runs. A listing that fails shows
a `✗` line inside its block instead and counts as nothing to ask: write that line verbatim.

**First, new workspaces.** The `<joined>` block is what `workspace.mjs joined` prints.

Its output is for you only. For an account that joined a workspace since it was last reviewed on this
machine, it lists every repo and folder with where its analytics go now. Its lines:

- `<email>: you joined <names> — <N> repos or folders to review account=<key> new=<ids>` — starts the
  block; `<names>` names the new workspaces;
- `W. <workspace> account=<key> tenant=<id> new=<yes|no> role=<role>` — one per workspace; `new=yes`
  is one just joined;
- `J<i>. <short> (<full label>), <k> sessions, now: <where> account=<key> kind=<repo|folder> match=<match> now=<ids|none|pending>`
  — one repo or folder (a `J` line). `<where>` is where its analytics go today: workspace names, `not
  tracked`, or `no rule yet`. `J<i>. outside a project, <k> sessions, now: <where> … kind=outside match=outside`
  is one too: sessions in the home folder, `/` or a temp folder;
- `J<i>-command=<command>` — right after its `J` line: the command that adds one workspace to it,
  ending in a literal `<tenant>`. It is not a `J` line;
- `add-all-command=<command>` — adds the new workspaces to every listed repo and folder that already
  sends somewhere;
- `done-command=<command>` — records that the new workspaces were reviewed, and keeps every repo and folder
  the user did not pick sending where it sends now;
- `joined=<total>` — the number of `J` lines, always last.

Run the printed commands unchanged. They only set where analytics go and upload nothing: step 2
asks about past sessions.

`joined=0` → nothing to ask: the same call already printed the `<routes>` block; go to "Then, repos
and folders with no rule" below.

For each account with `J` lines (with several accounts, end every question with " (<email>)"), using
that account's `W.` lines and commands:

More than 4 `J` lines → first ask "You joined <names>. Where should analytics for these <N> repos and
folders go?" (`<N>` = that account's number of `J` lines)
with the choices "Add <names> to all <N>" (described "Repos you don't track, and ones with no rule
yet, stay as they are"), "Choose repos" ("Pick which repos and folders go to each new workspace") and
"Leave them as they are" ("Nothing changes, and you're not asked about <names> again").

- "Add <names> to all <N>" → run the `add-all-command=` text EXACTLY ONCE.
- "Choose repos" → the per-workspace repo picks below.
- "Leave them as they are" → run the `done-command=` text EXACTLY ONCE.
- A skipped question → nothing; the next sync asks again.

4 or fewer `J` lines → the per-workspace repo picks.

**The per-workspace repo picks** — one question per `new=yes` `W.` line (a workspace just joined), in
turn. Each question offers that account's `J` lines as its choices and asks which repos and folders
should also send analytics to that one workspace. `<short>` is the `J` line's text after `J<i>. ` up to
` (` or `,`, and `<where>` the text after `now: ` up to ` account=`. The question:

"Which repos and folders should also send analytics to <workspace>?" — `<workspace>` is the `new=yes`
line's name (the text after `W. ` up to ` account=`).

Choices: one per `J` line — its `<short>`, described by its `<where>` ("Now: <where>", e.g. "Now:
Acme" or "Now: no rule yet"). Several repos and folders may be chosen.

- `request_user_input` only with at most 2 `J` lines and at most 3 `new=yes` `W.` lines (so at most 3
  choices and 3 questions): header "Beezi", the question followed by " Pick one, or name several under
  Other.", a last choice "None of these" (described "This workspace gets none of them"), the labels
  exactly as above.
- Otherwise the plain sentence: the question without its "?", a colon, the `J` lines as a numbered
  list "1) <short> (Now: <where>), 2) …", then " — reply with the numbers to send, or none?". For
  example: "Which repos and folders should also send analytics to NewCo: 1) acme-api (Now: Acme),
  2) notes (Now: no rule yet) — reply with the numbers to send, or none?"

For each repo and folder the user picked for a workspace, run its `J<i>-command=` text EXACTLY ONCE,
changing nothing except the final `<tenant>`: that workspace's `tenant=` value (its `W.` line's
`tenant=`, e.g. `t2`). Map each answered position to the `J` line it listed, then run that line's
own `J<i>-command=` (J numbers are global across accounts and need not start at 1); never rebuild the
command or re-quote its path yourself. A repo the
user did not pick for a workspace runs nothing for that workspace. After the last `new=yes` workspace's
question has been answered (not skipped or dismissed), run the `done-command=` text EXACTLY ONCE;
otherwise run no `done-command`, and the next login or sync asks again.

Write each command's first line verbatim.

**Then, repos and folders with no rule.**

Run nothing for them after `joined=0`: the step 1 command already printed the `<routes>` block.
After the `J` questions (answered or skipped) and their commands, run, with the same `--account`
and `--tenant` as step 1's command:

```
node "<plugin-root>/scripts/sync.mjs" --review-routes
```

It prints the `<routes>` block and `review=<n>`, and on `review=0` goes straight on to the summary
as step 1's command does.

The `<routes>` block is what `workspace.mjs routes` prints. It is for you only, except the one line
named below. It lists, per account in several workspaces whose New folders setting is Ask me, the
repos and folders whose past sessions have no rule yet. Its lines:

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

Not linked, or `routes=0` → nothing to ask: the summary already ran in the same call; go to step 2
for its output.

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
choice, described "Not tracked: nothing from <short> is sent" ("Not tracked: nothing from sessions
outside a project folder is sent" for `outside`). Several workspaces may be chosen.

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

Write each command's first line verbatim.

### Step 2 — the summary, then the question

When the last listing printed `review=0`, the summary already ran: its output is everything after
that `review=0` line. Do not run it again. Only after the `P` questions (answered or skipped) and their
commands, run, with the same `--account` and `--tenant` as step 1's command:

```
node "<plugin-root>/scripts/sync.mjs"
```

Either way, its output is what an upload would send, per workspace, then that workspace's question.
Nothing has been uploaded. Its lines:

- `Q <question>` — one per workspace: the question to ask;
- `offer account=<key> tenant=<id> sessions=<n> audit=<yes|no> token=<token>` — right after its `Q` line, for you
  only;
- `offers=<n>` — the number of questions, always last, for you only;
- every other line (the summary, a heading, an outcome below) — write it verbatim, in order.

`offers=0` → nothing to ask. Otherwise ask exactly as the `login` skill's step 4b does, whatever the
workspace's past-sessions setting is and even when the user said not now before: each `Q` line's
question (its text after `Q `), with the choices "Upload" (described "Send these sessions now") and
"Not now" (described "Nothing is sent"):

- **`request_user_input`** only when that tool is listed this turn and there are at most 3 `Q` lines:
  one call, header "Beezi", one question per `Q` line. A typed answer (Other) counts as a dismissal.
- **Otherwise**, end your reply with one plain sentence per `Q` line: the question, then
  ` Reply upload or not now.` This is the one place this skill asks several questions at once. An
  answer that does not clearly say upload for a question is not now for it.

Then, for each question, with `<key>`, `<id>` and `<token>` the `account=`, `tenant=` and `token=` values
of its `offer` line:

- "Upload" → run

  ```
  node "<plugin-root>/scripts/sync.mjs" --accept --account <key> --tenant <id> --token <token>
  ```

  with a long timeout (10 minutes) when your shell tool takes one: the upload prints progress lines
  as it goes. Relay its output verbatim.
- "Not now", a dismissal, or anything else → run
  `node "<plugin-root>/scripts/sync.mjs" --decline --account <key> --tenant <id>` and relay its line.

No answer means no upload.

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

**It takes no other flags** than `--account`, `--tenant`, step 1's `--review` or `--review-routes`,
the answer commands' `--accept` (with its `--token`) and `--decline`, and `--dry-run` when the user
asks for a preview only. Not `--since`, not `--force` — the
script rejects both with an explanation, and neither exists to be worked around. `--since` filters on
when a session last ran, which would skip exactly the old half-uploaded sessions this command is for;
`--force` has nothing to force past. If the user pushes for either, say the command
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
- **these past sessions changed after the question was shown, so nothing was uploaded** — from an
  Upload answer: the sessions that question counted are no longer the ones waiting (another sync
  showed a newer question, or that question was already answered). Nothing was sent. Relay it, then
  run step 2's command again so the user is asked about what is there now. Never retry `--accept`
  with that token or any other.
- **Codex is still saving analytics on this machine, so nothing was listed this time** — a Codex
  session is writing right now, so the run stopped before listing or uploading anything. Not a
  failure and nothing was lost. Relay it and suggest running sync again in a minute; do not retry in a
  loop.
- **could not read Codex’s pending analytics on this machine** — a `✗` line, with the error in
  brackets: Beezi could not read the folder where Codex keeps its unfinished analytics, so nothing was
  listed or uploaded. This is a fault on this machine (for example its permissions), not a busy
  writer, so running sync again soon gives the same answer. Relay it with the error. After an Upload
  answer the yes stays saved and Beezi retries it on its own. Do not retry in a loop.
- **your yes is saved, but this machine is busy, so nothing was uploaded yet** — from an Upload
  answer: Codex was saving analytics or another Beezi history run held the machine, so the upload
  waits. Beezi retries it on its own. Relay it; do not run sync or `--accept` again for it.
- **this workspace does not accept history uploads on demand** — a `✗` line: the workspace has
  tracking off (or does not take uploads on demand), so nothing was listed or sent for it and there
  is no question to ask. Relay it; the workspace admin decides this, and no flag changes it.
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
- **`--dry-run`** — only when the user asked for a preview: the summary step 2 shows, without its
  question, ending `offers=0`; nothing is recorded or sent. Relay it and ask nothing; to upload, run
  sync again without `--dry-run` so the user is asked.
- **some already-saved analytics have not reached Beezi yet** — there is a delivery backlog on disk.
  Nothing was synced this time because the check would have been answered with stale information.
  The backlog retries itself; suggest running sync again afterwards.
- **not linked** — run the `login` skill first.
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
