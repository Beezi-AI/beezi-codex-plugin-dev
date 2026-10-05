---
name: settings
description: Show and change Beezi settings on this machine — where analytics go (workspace rules per repo or folder, and the New folders default for a repo or folder with no rule), the linked accounts and the default account the analytics skill reads from, refreshing the captured ChatGPT plan, and plugin crash reports. Use when the user asks for their Beezi settings or account status ("am I linked / signed in to Beezi?", which accounts are linked), where a repo's or folder's analytics go, to add, change or remove a workspace rule, what happens in new folders, to change the default account, to refresh their ChatGPT plan, or to turn crash reports, telemetry or diagnostics on or off. For a quick link check the `beezi_status` tool also answers; to sign in use the `login` skill, to sign out the `logout` skill.
---

# Beezi: settings

## Finding the scripts

This file is at `<plugin-root>/skills/settings/SKILL.md`, so every script below is at
`<plugin-root>/scripts/` — use the absolute path. Run each command exactly as written, substituting
only the `<…>` placeholders. Do not read, open, or inspect any other files, and never echo a token or
the contents of the credentials file.

Output you are told to show is copied into your reply verbatim — exactly as printed, never
summarized, paraphrased or reformatted (a markdown table stays a table). Machine lines (`key=value`
lines, and every line of an output you are told not to show) are never shown. A command that fails
prints a line starting `✗`: show that line verbatim and stop.

The commands that change a setting read Beezi's sign-in from the system credential store and write
Beezi's settings under the user's home, outside the workspace, so the sandbox cannot run them: run
each with escalated permissions from the start so the user can approve it. Any other command here
that prints a `✗` line naming the sandbox: run it again with escalated permissions.

## Asking

Every question below is asked the same way, one question at a time:

- **`request_user_input`** — only when that tool is listed this turn **and** the question has
  2–3 choices. Use the labels and descriptions given, mark none as recommended unless told to, and
  continue with the answer.
- **Otherwise one plain sentence** that names every choice — never a numbered list or a bullet menu of
  options. End your reply with that sentence and stop; when the answer arrives, carry on from that
  question.
- A skipped question, or an answer that picks none of the choices, changes nothing: run nothing and
  say the setting is unchanged.

`<ids>` is always the chosen workspaces' `tenant=` values joined by commas (e.g. `t1,t2`). The user
may name workspaces rather than pick them; match each name to its `W.` line, ignoring case.

## Show

Always run (for you only; do not show it):

```
node "<plugin-root>/scripts/settings.mjs" keys
```

It prints:

- `menu=<label>|<label>…` — the sections that apply here, in order: `Rules` and `New folders` only
  when some linked account is in several workspaces, then `Account` and `Crash reports`;
- one line per linked account: `account=<key> default=<yes|no> multi=<yes|no> status=<…> email=<email>`
  (`multi=yes`: the account is in several workspaces; no such line: nothing is linked);
- `crash=<correlate|on|anonymous|off>`.

Then, by what the user asked:

- **Their settings in general, or their status** ("Beezi settings", "am I linked?", "who am I signed
  in as?") → run the command below and show its output verbatim, first in your reply. It names every
  linked account (or says nothing is linked) and the default, adds a Sign-in line only when a sign-in
  needs attention, and for an account in several workspaces says where this folder's analytics go,
  how many rules it has and its New folders setting. For a status question, stop there; otherwise go
  on to Route.

  ```
  node "<plugin-root>/scripts/settings.mjs"
  ```

- **`show`, `all`, or a request to see everything** → run `node "<plugin-root>/scripts/settings.mjs" all`, show its output
  verbatim, and stop.
- **`<section> show`, or a request to see one section** → run `node "<plugin-root>/scripts/settings.mjs" <section>`, where
  `<section>` is `rules`, `new-folders`, `account` or `privacy` (crash reports), show its output
  verbatim, and stop.
- **To change something in one section** → skip the screen (that section prints its own current
  setting) and go straight to Route.

The screen, `all`, and `account` can refresh account health and workspace membership. After showing
one of them, re-run `settings.mjs keys` privately before offering choices if the flow continues.
The `account=` machine lines always come from `settings.mjs keys`, never from `accounts.mjs list`.

Whether analytics are actually being reported — the hooks installed and trusted, or "why are my
analytics empty?" — is not on this screen: call the `beezi_status` tool, and use the
`analytics-hooks` skill to install or repair the hooks. The screen does repair missing or broken hook
entries on a linked machine by itself; when it did, its last line says so and names the one step left
to the user — it is part of the output, so show it too. With several Beezi builds installed, call
`beezi_status` on this plugin's own MCP server — the key follows this skill's plugin name (`beezi` →
`beezi`, `beezi-staging` → `beezi_staging`); see "Use this plugin's own server" in the `login` skill.

## Route

- Rules, workspace rules, where a repo's or folder's analytics go → **Rules** (an "add" or
  "remove <n>" in the request carries through).
- New folders, or where analytics go for a repo or folder with no rule → **New folders**.
- The default account, or which account the analytics skill reads from → **Default account**.
- Refreshing the plan, or which ChatGPT plan Beezi has → **Refresh my ChatGPT plan**.
- The account in general → **Account**.
- Crash reports, telemetry, diagnostics or error reporting, with or without a mode → **Crash reports**.
- Nothing specific → after the screen, ask "What do you want to change?" with one choice per `menu=`
  label, in its order and with exactly its text. Descriptions: Rules — "Where each repo or folder
  sends its analytics"; New folders — "Where analytics go for a repo or folder with no rule";
  Account — "Refresh your ChatGPT plan" (plus ", or pick the default account" when there are several
  `account=` lines); Crash reports — "Plugin crash reports". With four labels it is the plain
  sentence, e.g. "What do you want to change: Rules, New folders, Account, or Crash reports?" Go to
  the chosen section.

## Choosing the account (Rules and New folders)

Use the `account=` lines with `multi=yes`.

- No `account=` line at all → say this machine is not linked and to use the login skill; stop.
- None with `multi=yes` → say this setting applies only to an account in several workspaces; stop.
- Exactly one → use it.
- Several → ask "Whose rules?" (Rules) or "Whose New folders setting?" (New folders), one choice per
  such line, labelled with its `email=`. An email the user already named picks it without asking.

`<key>` below is the chosen line's `account=` value.

## The workspace question

The same question Beezi asks at a session start, about one repo, folder, or the sessions outside a
project folder. Its line's `kind=` picks the text (`<short>` is the name the line gives, `<label>`
the text in parentheses right after it):

| `kind=`   | Question                                                            | Last choice               |
| --------- | ------------------------------------------------------------------- | ------------------------- |
| `repo`    | "Where should analytics for <short> go?"                            | "Don't track this repo"   |
| `folder`  | "Where should analytics for <label> (and everything inside it) go?" | "Don't track this folder" |
| `outside` | "Where should analytics for sessions outside a project folder go?"  | "Don't track these"       |

Choices: one per `W.` line — the workspace name (the text after `W. ` up to ` account=`), described
by the line's `role=` value (nothing when it is empty) — then the last choice, described "Nothing
from <short> is uploaded" ("Nothing from sessions outside a project folder is uploaded" for
`outside`). Several workspaces may be chosen. When the question changes an existing rule, mark the
workspaces in that rule's `tenants=` (or the last choice, when `tenants=none`) as current: add
", current" to their descriptions.

- **`request_user_input`** only with at most 2 `W.` lines (3 choices): header "Beezi", the question
  followed by " Pick one, or name several under Other.", the labels exactly as above.
- **Otherwise the plain sentence:** the question without its "?", a colon, each workspace as
  "<name> (<role>)" (just "<name>" with no role; "current" joins the parentheses), then
  " — one or more — or <last choice, lower-case first letter>?". For example: "Where should analytics
  for acme-api go: Acme (Owner), Beta (User, current) — one or more — or don't track this repo?"
  When `tenants=none` is current, append " (current)" to the last choice in this sentence too.

`<ids>` = the chosen workspaces' ids, or `none` when the last choice is among the answers (it wins
over the others). Nothing chosen → run nothing.

## Rules

Choose the account, then run and show its output verbatim:

```
node "<plugin-root>/scripts/workspace.mjs" rules --table --account <key>
```

Then run (for you only; do not show it):

```
node "<plugin-root>/scripts/workspace.mjs" rules --account <key>
```

Its lines:

- `W. <workspace> account=<key> tenant=<id> role=<role>` — one per workspace;
- `R<n>. <short> (<label>) → <workspaces | not tracked> account=<key> rule=<n> kind=<…> tenants=<ids|none> match=<…>`
  — one per rule;
- `here: <short> (<label>) → <R<n> | no rule> account=<key> rule=<n|none> kind=<…> match=<…>` — this
  folder, and the rule it follows now (`here: none account=<key>` when this session has no folder).

A `kind=outside` line has no ` (<label>)`. `<here>` = the `here:` line's `<short>`, or "sessions
outside a project" when its `kind=outside`. The `here:` line's rule is its own when that `R<n>.` line
has the same `kind=` and `match=` as the `here:` line; otherwise it is a wider rule (a parent folder)
that covers this repo or folder.

Then by the request:

- `add` → Add.
- `remove <n>` → Remove, with rule `<n>` (drop a leading `R`).
- `remove` → Remove.
- Anything else → ask "What do you want to do with rules?", offering only the choices that apply, in
  this order:
  - "Add a rule for <here>" — the `here:` line has `rule=none`;
  - "Change where <here> goes" ("go" for `outside`) — the `here:` line names its own rule; described
    by that rule's `R<n>.` line up to ` account=`;
  - "Change where <rule short> goes (covers <here>)" — the `here:` line names a wider rule;
    `<rule short>` is that `R<n>.` line's `<short>`, described by that line up to ` account=`;
  - "Add a rule just for <here>" — the `here:` line names a wider rule; described "Only <here>
    changes; R<n> keeps the rest";
  - "Change a rule" — there is an `R<n>.` line;
  - "Remove a rule" — there is an `R<n>.` line;
  - "Done" — only with `request_user_input`, and only when fewer than 3 choices come before it.

  "Done" stops.

**Add, or "Add a rule just for <here>"** — ask the workspace question about the `here:` line, then run:

```
node "<plugin-root>/scripts/workspace.mjs" rule add --current --account <key> <ids>
```

If the machine output instead says `here: none account=<key>`, there is no current folder to add:
say so and stop without asking the workspace question or running `rule add --current`.

**"Change where … goes"** (either form) — ask the workspace question about the `R<n>.` line the
`here:` line names, marking its current workspaces, then run, with its `rule=` value:

```
node "<plugin-root>/scripts/workspace.mjs" rule set <n> <ids> --account <key>
```

**Change a rule** — pick a rule ("Which rule do you want to change?"), ask the workspace question
about its `R<n>.` line, marking its current workspaces, then run the `rule set` command above with its
number.

**Remove** — with no `R<n>.` line, say the account has no rules and stop. With a number from the
request: when no `R<n>.` line has it, say there is no rule R<n> and stop. Without one, pick a rule
("Which rule do you want to remove?"). Then confirm: ask "Remove R<n> (<short>)?" (`<short>` from
that line) with the choices "Yes" (described "Delete the rule; new sessions there follow New
folders") and "No" ("Keep it"); only a yes goes on. Run:

```
node "<plugin-root>/scripts/workspace.mjs" rule remove <n> --account <key>
```

**Picking a rule** — one choice per `R<n>.` line, labelled "R<n>. <short>" and described by the text
after `→ ` up to ` account=`. With only one `R<n>.` line, add the choice "Cancel" ("Change nothing").
The plain sentence names each rule as "R<n> <short> (<what it sends to>)"; the answer may be just the
number (drop a leading `R`). "Cancel" runs nothing.

After `rule add`, `rule set` or `rule remove`, write its first line verbatim (a `✗` line too).

## New folders

First run and show its output verbatim (the current setting):

```
node "<plugin-root>/scripts/settings.mjs" new-folders
```

Choose the account, then run (for you only; do not show it):

```
node "<plugin-root>/scripts/workspace.mjs" new-folders --account <key>
```

Its lines: a summary line, `W.` lines as in Rules, and last
`new-folders=<ask|send|none> set=<yes|no> multi=yes account=<key>`.

Ask "For a repo or folder with no rule, where should analytics go?" with the choices "Ask me"
(described "Beezi asks once per repo or folder, when a session starts there"), "Send to…" ("Pick the
workspaces that get them") and "Don't send" ("Nothing from a repo or folder with no rule is
uploaded"); add " (current)" to the description of the one matching `new-folders=` (`ask`, `send`,
`none`).

- "Ask me" → run `node "<plugin-root>/scripts/workspace.mjs" new-folders ask --account <key>`
- "Don't send" → run `node "<plugin-root>/scripts/workspace.mjs" new-folders none --account <key>`
- "Send to…" → ask "Which workspaces should get analytics for repos and folders with no rule?", one
  choice per `W.` line (named and described as in the workspace question), several allowed —
  `request_user_input` only with at most 3 `W.` lines, the question followed by " Pick one, or name
  several under Other."; otherwise the plain sentence ending " — one or more?". Nothing chosen → run
  nothing. Otherwise run:

  ```
  node "<plugin-root>/scripts/workspace.mjs" new-folders send <ids> --account <key>
  ```

Write the command's first line verbatim (a `✗` line too).

## Account

First run and show its output verbatim (the current account settings):

```
node "<plugin-root>/scripts/settings.mjs" account
```

Then:

- No `account=` line → say this machine is not linked and to use the login skill; stop.
- One `account=` line → go straight to Refresh my ChatGPT plan.
- Several → ask "What do you want to do?" with the choices "Refresh my ChatGPT plan" (described
  "Re-read which ChatGPT plan pays for Codex on this machine") and "Default account" ("Pick which
  account the analytics skill reads from").

### Default account

When the request went straight here, skip the Account screen above. Run and show its output verbatim
(the numbered list the choice refers to; it makes no request):

```
node "<plugin-root>/scripts/accounts.mjs" list
```

If it refuses — a `✗` line, or a block with no list (the environment guard's refusals carry no `✗`
and are often several lines) — stop there, and never edit `accounts.json` by hand.

The list contains numbered rows with bracketed keys, not `account=` lines. Re-run
`node "<plugin-root>/scripts/settings.mjs" keys` privately after the list. Selectable accounts are
those fresh `account=` lines whose `status=` is not `revoked`.

- None → say every linked account's authorization was revoked and to use the login skill; stop.
- Exactly one → use it without asking.
- Several → ask "Which account should the analytics skill read from?", one choice per selectable line,
  labelled with its `email=` and described "current default" when `default=yes`, else "Linked
  account".

Run, with the chosen line's `account=` value (the key, never a list position):

```
node "<plugin-root>/scripts/accounts.mjs" use <key>
```

and show all of its output verbatim: what analytics now read from, a note that a new Codex session
is needed for the tools to match when the workspaces are on different plans, and the reminder that
every linked account still receives this machine's analytics.

Every linked account receives this machine's analytics; the default only decides which account the
analytics tools read from. Say that plainly when the user sounds like they think switching it
redirects their reporting. It does not move analytics already reported. Adding an account is the
login skill; removing one is the logout skill.

### Refresh my ChatGPT plan

```
node "<plugin-root>/scripts/billing-capture.mjs" --from-codex --via refresh
```

It uses the default account; add `--account <key>` only when the user names another one. It re-reads
the ChatGPT plan tier: it asks Codex itself first (a short-lived `codex app-server` child process,
which may take a few seconds), then falls back to `~/.codex/auth.json`. Only the plan label, the
account id and the address are read and stored — no token leaves the machine. Session start
already captures the plan by itself whenever it can, so reaching this command usually means neither
Codex nor `auth.json` named one and the answer has to come from the user. Report its one-line output
verbatim, then decide:

**Done** — the plan is settled — when the output names a real plan (`plan=free`, `plan=plus`,
`plan=pro_5x`, `plan=pro_20x`, `plan=go`, `plan=team`, `plan=business`, `plan=enterprise`,
`plan=edu`), or shows `source=openai_api_key` or `source=third_party` (those machines bill no ChatGPT
subscription).

**If it says the Codex sign-in expired**, the plan cannot be read because the stored ChatGPT token is
stale, not because the plan is unknowable. Tell the user to sign in to Codex again (`codex login`);
the plan is then picked up on their next session with nothing more to answer. Offer the question
below only if they would rather not, or if signing in again does not clear it.

**Otherwise ask the user.** That covers every other output — `nothing captured`, `keeping the
self-reported plan`, `plan=unknown`, `plan=n/a`, `source=unknown`, or anything you do not recognise.
Telling them "your subscription info was not found" and leaving it strands the machine with no plan,
and for an Enterprise or Edu account, whose tier is often absent, asking is the only way it is ever
recorded. It has ten choices, so it is always this one plain sentence, ending your reply:

> How does this machine pay for Codex: ChatGPT Free, ChatGPT Plus, ChatGPT Pro — $100/mo (5× Plus
> usage), ChatGPT Pro — $200/mo (20× Plus usage), ChatGPT Go, ChatGPT Team, ChatGPT Business, ChatGPT
> Enterprise, ChatGPT Edu, or an OpenAI API key (no ChatGPT subscription)?

The two Pro choices are not a duplicate: OpenAI sells two plans named "Pro", and the price is the
only thing that tells them apart — ask which rather than assuming. Map the answer through this table;
no other values are valid:

| Answer                                      | value        |
| ------------------------------------------- | ------------ |
| ChatGPT Free                                | `free`       |
| ChatGPT Plus                                | `plus`       |
| ChatGPT Pro — $100/mo (5× Plus usage)       | `pro_5x`     |
| ChatGPT Pro — $200/mo (20× Plus usage)      | `pro_20x`    |
| ChatGPT Go                                  | `go`         |
| ChatGPT Team                                | `team`       |
| ChatGPT Business                            | `business`   |
| ChatGPT Enterprise                          | `enterprise` |
| ChatGPT Edu                                 | `edu`        |
| An OpenAI API key (no ChatGPT subscription) | `api_key`    |

Then run, substituting only `<value>` (plus the same `--account <key>` when one was named):

```
node "<plugin-root>/scripts/billing-capture.mjs" --plan <value> --via login-user
```

Report its one-line output. An answer not in the table runs nothing; say the plan is unchanged.

## Crash reports

First run and show its output verbatim (the current setting):

```
node "<plugin-root>/scripts/settings.mjs" privacy
```

With a mode in the request ("turn crash reports off", "telemetry correlate"), run it without asking,
then show its output verbatim and stop:

```
node "<plugin-root>/scripts/telemetry.mjs" <correlate|on|anonymous|off>
```

Otherwise ask one question. It has four choices, so it is always the plain sentence:

> How should Beezi crash reports work: Correlate (recommended; attaches an installation ID so support
> can find your report), On (sends reports without an installation ID and leaves that choice open),
> Anonymous (sends reports without an installation ID and never offers one again), or Off (sends
> nothing and deletes pending reports)?

Add ", current setting" inside the parentheses of the choice matching `crash=`. Run the `telemetry.mjs`
command above only when the answer differs from `crash=`, and show its output verbatim; when it is
the current one, say the setting is unchanged.

Only change the mode when the user has said which one they want. Consent is theirs to give: never
infer it, never turn reports on as a favour, and never talk the user out of On or Off — Correlate is
simply the recommended way to turn them on. This works on a machine that is not linked; never send
the user through the login skill first.

If the user asks what a report collects: plugin and Codex versions, the OS, which plugin file failed,
and whether it was signed in. It is structured fields only and cannot carry code, prompts, file
contents, paths outside the plugin, repository or branch names, error messages, stack text or
credentials — the record has no field that could hold them. Correlate adds a random installation ID,
so support can match a report to an account. When binding is needed, it uses the default usable
Beezi account, otherwise the first usable account. Changing the default does not rebind an existing ID.
