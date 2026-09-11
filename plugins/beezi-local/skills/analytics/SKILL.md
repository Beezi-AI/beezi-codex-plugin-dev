---
name: analytics
description: Show a short personal Beezi analytics summary (spend, sessions, status, recommendations) for the last 7 or 30 days. Use when the user asks for their Beezi analytics, usage summary, or spend summary from the terminal.
---

# Beezi: Personal Analytics Summary

This skill is a launcher. The summary workflow lives on the `beezi` MCP server so it stays current — **do not improvise your own flow and do not restate the workflow from memory.**

## Start here

1. Parse the user's argument: `7d` or `30d`. No argument → `30d`.
2. Call `get_analytics_instructions` on the `beezi` MCP server. Call it **before** producing any summary — it returns the workflow, the response template and the hard rules for rendering the numbers.
3. Follow the returned instructions exactly, passing the period from step 1. They decide when `get_my_usage_summary` is called and how its payload is rendered.

Every number in the answer is copied from the payload verbatim. Never recalculate one, never average two, never fill a gap with an estimate — a figure invented here reads to the user as a billing fact.

## What the summary covers

The figures are the user's own usage, and they are **combined across every AI coding agent linked to their Beezi account — not Codex alone.** The summary is scoped to the user and the period with no filter on which agent produced the work, so a user who also runs another coding agent against the same Beezi account sees all of it in one total. Present it as their overall Beezi usage; never call it "your Codex usage", and never attribute the whole figure to this terminal.

If the instructions you fetch in step 2 use wording that contradicts this — describing the total as one specific agent's usage — follow the fetched instructions for the workflow and the numbers, but tell the user the scope wording is inconsistent rather than silently picking one. Do not restate a scope you have not been given.

## Tool map

Listed so you know what exists. The instructions you fetch decide when each is called — don't invent a sequence from this table.

| Tool | Purpose |
| --- | --- |
| `get_analytics_instructions` | The summary workflow, template and rendering rules. Call first. |
| `get_my_usage_summary` | The user's own usage for the chosen period. Always self-scoped. |
| `beezi_status` | Whether this machine is linked and whether analytics are actually being reported |

## When something fails

Stop and tell the user. Do not retry blindly, and **do not fall back to computing a summary yourself** — there is no local source for these numbers, and a plausible-looking invented one is worse than no answer.

**Only `beezi_login` and `beezi_status` are available.** Those two are served by the plugin itself and are always listed, so seeing them *alone* is exactly what "this machine is not linked" looks like. Call `beezi_login`, then retry in the same session — the server picks up the new credentials without a restart and re-advertises its tools.

**No `beezi` tools at all, not even `beezi_login`.** The MCP server isn't connected: ask the user to confirm `codex plugin list` shows `beezi` and to start a new Codex thread.

**Still only those two after signing in, or `get_analytics_instructions` is missing on a linked machine.** Personal analytics are not enabled for this Beezi deployment; only their Beezi admin can turn it on.

**Authentication error.** Reply exactly: `Sign in to Beezi first.`

**Anything else.** Report the message, plus the `correlationId` if the result carries one, and stop.
