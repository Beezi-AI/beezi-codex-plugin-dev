---
name: login
description: Link this machine to Beezi (browser sign-in) and choose what it tracks. Use when the user wants to log in / sign in / connect to Beezi, add or switch Beezi accounts, or when a Beezi tool reports that the machine is not linked. For "am I linked?", the default account or refreshing the ChatGPT plan use the `settings` skill; to sign out use the `logout` skill.
---

# Beezi: login

## Finding the scripts

This file is at `<plugin-root>/skills/login/SKILL.md`, so every script below is at
`<plugin-root>/scripts/` — use the absolute path.

Run each command exactly as written. Do not read, open, or inspect any other files, and never echo
a token or the contents of the credentials file.

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

## Logging in

Logging in is these steps, in order. Step 1 links an account; step 2 records which ChatGPT plan pays
for this machine; step 3 asks the one question, what this machine tracks; step 4 uploads the past
sessions that answer covers, turns on crash reports unless the user already chose, and closes.
**Do not stop after step 1** — a linked machine that never answers step 3 reports nothing from its
past sessions.

**Asking.** A question below uses `request_user_input` only when that tool is listed this turn and
the question has 2–3 choices. Otherwise it is one plain sentence naming every choice — never a
bullet menu, and a numbered list only where a step below says so — that ends your reply. Ask one
question at a time. When the answer arrives, carry on from where the question was asked: never start
over from step 1.

**Several Beezi accounts can be linked at once**, and every step after the first is about ONE of
them. Step 1 names which, on its last line, as `account=<key>` — an 8-character key. Carry that key
through steps 2 to 4 as `--account <key>`. If step 1 printed no such line, match its output against
the outcome list below before doing anything else: two of those outcomes mean the sign-in is still
running, not that it failed.

### How the steps run

Every step comes from ONE script, which runs them in order and stops at most once, for the tracking
question. Start at step 1: when a `beezi_login` tool is available, call it first and run the script
with `--account <key>`; run it bare, as below, only without that tool.

```
node "<plugin-root>/scripts/login-flow.mjs"
```

Give it a long timeout (10 minutes) when your shell tool takes one: the sign-in waits for the
browser. Each step's output is a block: a `<name …>` line, the output, then a `</name>` line. Its
LAST line says what to do now: `next=<step> account=<key>`, or just `next=stop` when the sign-in
linked nothing. `<key>` is the account just linked.

| `next=`  | Go to                                                 |
| -------- | ----------------------------------------------------- |
| `stop`   | Step 1: relay the `<sign-in>` block, run nothing else |
| `track`  | Step 3, the tracking question                         |
| `done`   | Step 4                                                |

Output that ends without any `next=` line means the script itself failed or refused to run: show
what it printed verbatim and stop (running this login skill again resumes safely). Never run the
scripts behind the blocks yourself (`login.mjs`, `billing-capture.mjs`, the `workspace.mjs setup`
listing, the past-sessions upload, `telemetry.mjs`, `hooks.mjs`): the blocks hold their output.
Before doing what `next=` says, write out what each block printed this time calls for, in order, as
its step below says.

### Step 1 — sign in

**Prefer the MCP tool.** If a `beezi_login` tool is available, call it — it runs the same browser
sign-in inside the already-running Beezi server, and the Beezi tools become available immediately
afterwards without restarting the session. Takes no arguments. Once it has linked an account, run
the script from step 2 on, with the key it printed:

```
node "<plugin-root>/scripts/login-flow.mjs" --account <key>
```

**Use this plugin's own server.** Each Beezi build has its own MCP server, and every one of them
offers a `beezi_login`, so with production and a variant installed together there are two. The
server key follows the plugin name in this skill's own name: `beezi:login` uses server `beezi`,
`beezi-staging:login` uses `beezi_staging`, `beezi-dev:login` `beezi_dev`, `beezi-local:login`
`beezi_local`. Call the `beezi_login` on that server and no other — the other one signs in to a
different environment. If this plugin's server offers no `beezi_login`, use the script.

If that tool is not available, run `login-flow.mjs` with no arguments (above): its `<sign-in>` block
holds the sign-in's output.

Either way a browser window opens for the user to sign in with their Beezi account. If the browser
does not open, the output contains the URL — pass it to the user verbatim. The flow blocks until
they finish or it times out; say so rather than assuming it failed.

**The browser decides which account signs in.** It signs in as whichever Beezi account it is
already signed in as; to add a different one the user signs out of Beezi in the browser first, or
uses a private window. The output says so before it opens, and names the accounts already linked.

Report the result verbatim, except its last line `account=<key>`, then read it. There are four
outcomes; only the first lets the rest of this flow run, and each is named by a sentence the output
actually carries:

- `account=<key>` on the last line — an account was linked, re-linked, or was already linked. Use
  that key for every step below. With the script, it already went on to the next steps.
- **`The sign-in is still running here`** — only the `beezi_login` tool prints this, and it is
  ordinary rather than exceptional: the tool answers after about 25 seconds, and a real browser
  sign-in routinely takes longer than that. **Nothing has failed.** Relay the text as given,
  including the URL it carries, and wait — do not call the tool again, do not offer to retry, and do
  not run the later steps yet. When the user says they have finished in the browser, call
  `beezi_status`; once it reports the machine linked, **get a key before continuing** — this path
  prints none, and the script refuses to go on without one. Run
  `node "<plugin-root>/scripts/accounts.mjs" list`: every row carries its key in brackets. If more
  than one row is listed, ask the user which account they signed in as rather than guessing — the
  list marks the default and revoked rows, not which row is new. With the key in hand, run the
  script with `--account <key>` as above.
- **`A Beezi sign-in is already in progress`** — only the `beezi_login` tool prints this, and only
  while an earlier call of it is still waiting on the browser. It is a refusal to start a SECOND
  sign-in, not a failed one: the first is still live. Relay the text as given and wait, exactly as
  for the outcome above — do not call the tool again and do not run the later steps yet. When the
  user says they have finished in the browser, pick the key up the same way, from `accounts.mjs list`.
- **Anything else, with no `account=` line** (the script ends `next=stop`) — the sign-in failed. The
  script prints `✗ <reason>`; the tool prints `Beezi sign-in failed: <reason>`. The commonest cause
  is the plainest: the browser tab was never finished and the wait timed out. It can also be an
  unreachable server, a locked keyring, or a pending environment migration. **Relay that line
  verbatim and do not diagnose it** — in particular say nothing about workspaces, other accounts, or
  logging out. Offer to run step 1 again. Do not run the later steps.

If the output ends with steps for installing analytics hooks, repeat them — logging in alone does
not start reporting analytics. The `analytics-hooks` skill covers that. The `/hooks` trust step
comes back as the closing line in step 4 while Codex still needs it.

### Step 2 — the plan

The `<plan>` block: the script captured which ChatGPT plan pays for this machine, on every login
outcome, **including when step 1 said the machine was already linked** (the user's tier may have
changed) and **including when step 1 used the `beezi_login` tool**. Write its lines verbatim. It asks
nothing: a plan it could not detect is set later in the settings skill.

### Step 3 — the tracking question

The script stops with `next=track` only when this account has not chosen what this machine tracks.
The `<track account="<key>">` block is for you only, except the lines named below. Its lines:

- `<checklist>` … `</checklist>` — what past sessions send; absent when there are none;
- `W. <workspace> account=<key> tenant=<id> role=<role>` — one per workspace. `<name>` is the text
  after `W. ` up to ` account=`;
- `T<i>. <short> (<label>), <k> sessions account=<key> kind=<…> now=<ids|none|default> match=<…>` —
  one repo or folder (a `T` line). `<short>` is the text after `T<i>. ` up to ` (` or `,`; `now=` is
  where it goes today: workspace ids, `none` (not tracked) or `default` (no rule);
- `T<i>-command=<command>` — right after its `T` line, ending in a literal `<tenants>`. It is not a
  `T` line;
- `everything-command=<command>` (ending in a literal `<tenants>`) and `chosen-command=<command>`;
- `<n> other past sessions have no recorded folder and are not sent.` (or the one-session form);
- `setup=<M> sessions=<N> workspaces=<W> chosen=no` — always last. `<M>` is the number of `T` lines.

First write the lines between `<checklist>` and `</checklist>` verbatim, in order, inside one plain
fenced code block (```), because Markdown flattens their 2- and 4-space indents; then the
no-recorded-folder line verbatim when there is one. Write nothing else from the block. Then ask ONE
question, by the number of `W.` lines (`<A>` and `<B>` are the first two `W.` lines' names):

| Workspaces | Question                | Choices                                                                                    |
| ---------- | ----------------------- | ------------------------------------------------------------------------------------------ |
| 1          | "What should it track?" | "Everything" ("all <M>, and new ones as you open them"), "Let me choose" ("tick the repos and folders") |
| 2          | "Where should they go?" | "Everything to <A>", "Everything to <B>", "Everything to both", "Let me choose" ("tick repos for each workspace") |
| 3 or more  | "Where should they go?" | "Everything to <A>", "Everything to <B>", "Several workspaces…", "Let me choose" ("tick repos for each workspace") |

With no `T` lines (the script stops then only for several workspaces) the question is "Where should
this machine's analytics go?" and the last choice is "Ask me for each repo" instead of "Let me
choose".

- **`request_user_input`** only for the one-workspace question: header "Beezi", the two choices with
  their descriptions.
- **Otherwise** one plain sentence with the choices as a numbered list: the question without its
  "?", a colon, each choice as "1. Everything to Acme", joined by ", " with "or " before the last,
  then "?". The user answers with a number or a choice's words.

Run no command until every question of this step is answered. A dismissed or unanswered question,
or an answer that is not one of the choices: run nothing, tell the user nothing was set up and to
ask Beezi to sign in again to choose what this machine tracks, and stop — do not run `--from finish`.

- "Several workspaces…" → ask once more as one plain sentence: "Which workspaces should get
  analytics from this machine", a colon, each `W.` line as `<name> (<role>)` (just `<name>` when it
  has no role) joined by ", ", then " — one or more?". For example: "Which workspaces should get
  analytics from this machine: Acme (Owner), Beta (User), Gamma (User) — one or more?". Nothing named
  is a dismissal; otherwise it is the Everything answer below with those workspaces.
- An Everything answer → run the `everything-command=` text EXACTLY ONCE, changing nothing except the
  final `<tenants>`: the chosen workspaces' `tenant=` values joined by commas (e.g. `t1,t2`). With one
  workspace, drop the literal ` <tenants>` instead.
- "Ask me for each repo" → run the `chosen-command=` text EXACTLY ONCE.
- "Let me choose" → the place questions below.

**The place questions.** With one workspace, a `T` line with `now=none` is not offered: say `<short>`
is not tracked today and that the settings skill changes it. The places to offer are the other `T`
lines. One question per workspace, in `W.` order: "Which repos and folders should Beezi track?"
(one workspace) or "Which repos and folders go to <name>?" (several).

- 4 or fewer places → each question lists the places: the question without its "?", a colon, the
  places as "1) <short> (<k> sessions), 2) …", then " — reply with the numbers to include, or none?".
- More than 4 places → first write the places once as a numbered list, `<n>. <short> — <k>
  sessions`, inside one plain fenced code block. Then each question has the choices "All of them"
  ("Every place in the list") and "None of them" ("Nothing in the list"), and the numbers to include
  typed instead: with `request_user_input`, header "Beezi", the question followed by " Pick one, or
  type the numbers under Other."; otherwise the question without its "?", then " — all of them, none
  of them, or the numbers to include?".
- No place to offer → ask nothing.

A number not in the list, or "none" together with a number, makes the answer a dismissal.

A place is ticked for a workspace when that workspace's answer includes it. Then, for each place
whose ticked workspaces differ from its `now=` value as a set (`default` always differs, and `none`
is ticked nowhere), run its `T<i>-command=` text EXACTLY ONCE, changing nothing except the final
`<tenants>`: the ticked workspaces' `tenant=` values joined by commas, or `none` when it is ticked
nowhere. With one workspace, run it only for the places left out, with `none`. Never rebuild a
command or re-quote its path yourself. After those, run the `chosen-command=` text EXACTLY ONCE.

Run these commands one at a time. Of every command's output write only a `✗` line, verbatim. A
command that prints a `✗` line, or fails, stops this login: run no later command, do not run
`--from finish`, and tell the user to ask Beezi to sign in again to choose what this machine tracks.
Otherwise, after the last command, carry on with EXACTLY this, with the same long timeout:

```
node "<plugin-root>/scripts/login-flow.mjs" --account <key> --from finish
```

### Step 4 — the finish

The `<finish>` block (`next=done`): the script uploaded the past sessions the answer covers in the
background, turned on crash reports unless the user already chose, and printed the closing lines.
Write its lines verbatim, blank lines included, and add nothing of your own.

## Logging out

That is the `logout` skill. Do not run `logout.mjs` from here — signing out has its own outcomes to
relay, and it is not what someone asking to "switch accounts" usually wants: logging in again
re-links this machine without unlinking it first.

## Refreshing the captured plan, checking the link

Both are the `settings` skill: refreshing the ChatGPT plan is its Account section, and "am I
linked?" its screen (the `beezi_status` tool also answers). Do not run them from here.

## When something fails

**"not linked" persists after logging in.** The credentials are stored per machine in the OS
keyring, falling back to `~/.beezi-codex/credentials.json` (or `$BEEZI_CODEX_HOME`). If the user is
running Codex with a different `BEEZI_CODEX_HOME`, they are two different machines as far as Beezi
is concerned. `~/.beezi` is the Claude Code plugin's directory and is never read by this plugin —
a link there does not carry over.

**The browser never opens.** Not fatal — the output carries the authorize URL. Give it to the user.

**Network or server errors.** Report them as given. Do not retry a login in a loop; each attempt
opens another browser window.
