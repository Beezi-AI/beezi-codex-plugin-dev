---
name: login
description: Link this machine to Beezi, or refresh the captured ChatGPT plan. Use when the user wants to log in / sign in / connect to Beezi, switch Beezi accounts, or when a Beezi tool reports that the machine is not linked. For "am I linked?" use the `me` skill; to sign out use the `logout` skill.
---

# Beezi: login

## Finding the scripts

This file is at `<plugin-root>/skills/login/SKILL.md`, so every script below is at
`<plugin-root>/scripts/` — use the absolute path.

Run each command exactly as written. Do not read, open, or inspect any other files, and never echo
a token or the contents of the credentials file.

## Logging in

Logging in is four steps, in order. Step 1 links the machine; steps 2 and 3 record which ChatGPT
plan pays for it; step 4 uploads the machine's past Codex sessions. **Do not stop after step 1** —
a linked machine with no plan reports its usage with no plan attached, which is the single most
common thing users report as "my analytics look wrong". **Step 4 comes last and only after the
plan is settled**: settled means step 2 hit its stop list, or the user answered step 3's question
(or explicitly dismissed it). Jumping to step 4 with the plan question still open is the other way
machines end up with no plan — the backfill output reads like a finished login, so nothing ever
comes back to ask.

### Step 1 — sign in

**Prefer the MCP tool.** If a `beezi_login` tool is available, call it — it runs the same browser
sign-in inside the already-running Beezi server, and the Beezi tools become available immediately
afterwards without restarting the session. Takes no arguments.

If that tool is not available, run:

```
node "<plugin-root>/scripts/login.mjs"
```

Either way a browser window opens for the user to sign in with their Beezi account. If the browser
does not open, the output contains the URL — pass it to the user verbatim. The flow blocks until
they finish or it times out; say so rather than assuming it failed.

Report the result verbatim. If the output ends with steps for installing analytics hooks, repeat
them — logging in alone does not start reporting analytics. The `analytics-hooks` skill covers that.

### Step 2 — capture the ChatGPT plan

Run this after step 1 succeeded, **including when step 1 said the machine was already linked** (the
user's tier may have changed), and **including when step 1 used the `beezi_login` tool** — that tool
links the machine but never reads the plan.

```
node "<plugin-root>/scripts/billing-capture.mjs" --from-codex --via login
```

It asks Codex itself which account it is signed in as (a short-lived `codex app-server` child
process), and falls back to the plan label in `~/.codex/auth.json`. It may take a few seconds the
first time. No token is read and none leaves the machine — only the plan label, the account id and
the address. When a plan is captured the line ends with `via=app-server` or `via=auth-json`, naming
which one answered; the other outcomes below print their own message instead.
Report its one-line output verbatim, then decide:

**Stop here** — the plan is settled, say so and finish — when the output either

- names a real plan (`plan=free`, `plan=plus`, `plan=pro_5x`, `plan=pro_20x`, `plan=go`,
  `plan=team`, `plan=business`, `plan=enterprise`, `plan=edu`), or
- shows `source=openai_api_key` or `source=third_party`. Those machines do not bill a ChatGPT
  subscription, so a tier question does not apply to them.

**If it says the Codex sign-in expired**, that has a cheaper fix than step 3: the stored ChatGPT
token is stale, not the plan unknowable. Tell the user to run `codex login` again — the plan is then
picked up automatically on their next session. Offer step 3 only if they would rather not, or if
signing in again does not clear it.

**Otherwise go to step 3.** That covers every other output, including `nothing captured`,
`keeping the self-reported plan`, `plan=unknown`, `plan=n/a`, and `source=unknown`. Treat this as
"anything not on the stop list" rather than matching a fixed list of failures — a machine whose
output you do not recognise is exactly the machine that needs asking.

### Step 3 — ask the user their tier

If an `AskUserQuestion` tool is available, use it. **Codex normally has no such tool.** In that case
print the list below as plain text, ask, and then **stop and wait for the user's reply** — end the
turn with the question as the last thing said. Do not guess a tier, do not run the capture command
in the same turn, and **do not run step 4 in the same turn either** — an unanswered question
followed by backfill output is how this step gets silently skipped. Both the capture and step 4
happen on the next turn, once the user has answered.

> How does this machine pay for Codex?
>
> 1. ChatGPT Free
> 2. ChatGPT Plus
> 3. ChatGPT Pro — $100/mo (5× Plus usage)
> 4. ChatGPT Pro — $200/mo (20× Plus usage)
> 5. ChatGPT Go
> 6. ChatGPT Team
> 7. ChatGPT Business
> 8. ChatGPT Enterprise
> 9. ChatGPT Edu
> 10. I use an OpenAI API key (no ChatGPT subscription)

The Free and API-key options matter. Without Free, a user on the free tier is forced to claim a paid
plan or answer nothing; without the API-key option, a machine paying per token gets pinned to a
subscription tier it does not have, and its spend is then reported under that plan.

**The two Pro rows are not a duplicate.** Since the 2026-04-09 split OpenAI sells two plans both
named "Pro" — $100/mo and $200/mo — so the price is the only thing that tells them apart, and it is
the number the user can check against their own billing page. Ask which one rather than assuming;
recording the wrong one doubles or halves every spend figure reported for this machine.

Map the answer through this table — no other values are valid:

| Answer                                 | value        |
| -------------------------------------- | ------------ |
| ChatGPT Free                           | `free`       |
| ChatGPT Plus                           | `plus`       |
| ChatGPT Pro — $100/mo (5× Plus usage)  | `pro_5x`     |
| ChatGPT Pro — $200/mo (20× Plus usage) | `pro_20x`    |
| ChatGPT Go                             | `go`         |
| ChatGPT Team                           | `team`       |
| ChatGPT Business                       | `business`   |
| ChatGPT Enterprise                     | `enterprise` |
| ChatGPT Edu                            | `edu`        |
| I use an API key                       | `api_key`    |

Then run exactly this, substituting only `<value>`:

```
node "<plugin-root>/scripts/billing-capture.mjs" --plan <value> --via login-user
```

Report its one-line output. If the user dismisses the question or answers something not in the
table, skip the capture — the link itself already succeeded, say that and continue to step 4.

### Step 4 — upload past sessions (always run this last)

Run this only once the plan is settled (step 2 stopped, or step 3 was answered or dismissed) —
never while step 3's question is still waiting for a reply. With that condition met, it runs on
every login outcome: fresh links, machines that were already linked, **and when step 1 used the
`beezi_login` MCP tool** — that tool links the machine but never uploads history, so this step is
still yours to run.

```
node "<plugin-root>/scripts/backfill.mjs" --via login
```

It is the one-time upload of this machine's past Codex sessions into Beezi and can take several
minutes; it prints progress lines as it goes. It covers the **last 30 days only** — older sessions
are out of scope for this import and for the `sync` skill alike, and no later run reaches them. Report its output verbatim — progress and final
summary, or the error line. It is safe on every login: already-uploaded sessions are skipped, and
if it says nothing new to upload, tell the user their history is up to date. If some sessions could
not be delivered, tell the user that running this login skill again later resumes the upload where
it left off. Never echo any token.

If it reports the one-time import **has already been used**, that is final — the import is once per
account and tool and cannot be re-run. Do NOT retry, do NOT run the script again with different
flags, and refuse politely if the user asks you to bypass it; relay the script's message (including
the upgrade suggestion when it prints one) and stop.

Only when it reports the pull *finalized*, tell the user: the pull is one-time per account and
tool — if they have Codex history on other machines, they should sign in to Beezi there BEFORE it
finalizes; a finalized pull cannot be re-opened.

## Logging out

That is the `logout` skill. Do not run `logout.mjs` from here — signing out has its own outcomes to
relay, and it is not what someone asking to "switch accounts" usually wants: logging in again
re-links this machine without unlinking it first.

## Refreshing the captured plan

```
node "<plugin-root>/scripts/billing-capture.mjs" --from-codex --via refresh
```

Re-reads the ChatGPT plan tier: it asks Codex itself first (a short-lived `codex app-server` child
process, which may take a few seconds), then falls back to `~/.codex/auth.json`. Only the plan
label, the account id and the address are read and stored — no token leaves the machine. Report its
one-line output verbatim.

If it cannot name a plan, do not stop there: fall through to **step 3** of the login flow above and
ask the user their tier. Telling them "your subscription info was not found" and leaving it is what
strands a machine with no plan indefinitely — and for an Enterprise or Edu account, whose tier is
often absent, asking is the only way it will ever be recorded.

**One case has a better fix than asking.** If Beezi reported that the user's *Codex sign-in expired*
on some date, the plan cannot be read because the stored ChatGPT token is stale — not because the
plan is unknowable. Tell them to sign in to Codex again (`codex login`); the plan is then picked up
automatically on their next session with nothing more to answer. Offer step 3 only as the fallback
if they would rather not, or if signing in again does not clear it.

Note that session start now captures the plan by itself whenever it can, so reaching this command at
all usually means neither Codex nor `auth.json` named one and the answer has to come from the user.

## Checking the link

That is the `me` skill. It answers through the `beezi_status` tool, which runs in the process that
actually holds the credentials — do not answer "am I linked?" from a script here.

## When something fails

**"not linked" persists after logging in.** The credentials are stored per machine in the OS
keyring, falling back to `~/.beezi-codex/credentials.json` (or `$BEEZI_CODEX_HOME`). If the user is
running Codex with a different `BEEZI_CODEX_HOME`, they are two different machines as far as Beezi
is concerned. `~/.beezi` is the Claude Code plugin's directory and is never read by this plugin —
a link there does not carry over.

**The browser never opens.** Not fatal — the output carries the authorize URL. Give it to the user.

**Network or server errors.** Report them as given. Do not retry a login in a loop; each attempt
opens another browser window.
