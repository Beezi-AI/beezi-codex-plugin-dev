---
name: analytics-hooks
description: Install, repair, remove, or check Beezi's Codex analytics hooks. Use when the user wants to start (or stop) reporting per-branch token analytics to Beezi, asks why their Beezi analytics are empty, or after a Beezi plugin upgrade.
---

# Beezi: analytics hooks

Codex does not load hooks bundled inside a plugin — its `plugin_hooks` feature is `removed`, so an
installed plugin contributes nothing to the hook engine. Beezi's lifecycle hooks are therefore
written into the user-level registry `~/.codex/hooks.json` by the script below.

## The rule

**Never hand the user a hooks command to run.** Installing, repairing and clearing out entries left
by an old version are all things this skill does for them. The only step that cannot be automated is
trusting the hooks in `/hooks`, because Codex has no non-interactive way to grant that trust.

## Finding the script

This file is at `<plugin-root>/skills/analytics-hooks/SKILL.md`, so the script is at
`<plugin-root>/scripts/hooks.mjs`. Use the absolute path.

## Commands

| The user wants | Do |
| --- | --- |
| to start reporting, or to repair anything | `node "<plugin-root>/scripts/hooks.mjs" install` |
| to know the current state, or asks why analytics are empty | call the **`beezi_status` tool** |
| to stop reporting | `node "<plugin-root>/scripts/hooks.mjs" uninstall` |

`install` is safe to run at any time and is the answer to every broken state — absent, stale,
partial, or a registry full of dead entries from a variant that is no longer installed. It:

- removes this variant's previous entries, in either the current or the old launcher format;
- removes dead entries left by **any** Beezi variant — an entry whose script file is gone belongs to
  no working install, and Codex fails its spawn on every session until it is removed;
- writes the current entries;
- **changes nothing at all when the install is already healthy.** That is deliberate: Codex keys
  hook trust to each entry's hash, so a pointless rewrite would revoke trust the user has already
  granted. Use `install --force` only if the user explicitly asks for a rewrite.

## When the user is just asking

`beezi_status` is the read for any "is it working?" question — it reports the hook state *and* the
link state, and answering "why is nothing tracked?" needs both. It also repairs the hooks itself
before it answers, so its verdict describes the state the user is left in.

If it reports anything other than a healthy install, **run `install` straight away** — do not
report the problem back and wait for permission. `node "<plugin-root>/scripts/hooks.mjs" status`
gives the hook half only, changes nothing, and exists for terminal use.

## The one step that is still theirs

After an install or a repair actually wrote something, tell the user exactly this, once:

> Run `/hooks` in Codex, review the Beezi entries, and trust them.

There is no non-interactive way to grant that trust — do not try to bypass it, and do not claim
analytics are working until the user confirms they have done it. Trust is recorded against each
hook's **hash**, so it has to be repeated after any change to the hooks, including a plugin upgrade.

When `install` reports that nothing changed, the user's existing trust is intact — do not send them
to `/hooks` for no reason. Mention it only as the thing to check if analytics still are not arriving.

## Upgrades repair themselves

Each registry entry carries the absolute path of the plugin version's hook script, so an upgrade
moves the scripts out from under them and the entries go `stale`. Beezi now fixes that without being
asked: the MCP server starts in every session and repairs the registry on the session's first
message, and `login` and `me` do the same. What the user still has to do after an upgrade is
re-trust, because the new entries hash differently.

## Reading the status output

- **installed** — every event's entry points at this plugin version's scripts. If analytics still
  are not arriving, the likely cause is the missing trust step above, or that the machine is not
  linked (see the `me` and `login` skills).
- **absent**, **stale**, **partial** — run `install`. It handles all three identically.

## What the hooks do

One entry per lifecycle event: `SessionStart`, `PostToolUse`, `Stop`, and — for tracking spawned
subagents — `SubagentStart` and `SubagentStop`. `install` and `status` both print the list back, so
check `/hooks` against what the script named rather than against a count.

The two subagent hooks only record which agent ran and when. A subagent's *usage* is billed by the
parent session's own checkpoint, which finds subagent rollouts itself. So if the user trusts only
some of the entries, subagent tokens are still reported; what is lost is the agent's task name and
its exact span on the session timeline.

## Scope of what is written

`install` writes `~/.codex/hooks.json` only. Each entry runs `node` from PATH with the hook
script's quoted absolute path in `command` — no launcher scripts are written any more, and `install`
sweeps away the `~/.beezi-codex/hooks/` launchers an older plugin version left. It **merges**:
any hooks the user configured themselves keep their place and content, and a *working* sibling
variant's entries are left alone — only dead ones are swept. `uninstall` removes only this variant's
entries, and deletes the registry file only if they were the only thing in it. Report this if the
user is worried about their own hooks.

## Reporting without hooks

If the user does not want hooks installed, analytics can still be captured on demand — the `track`
skill checkpoints the current branch and needs no hooks at all.
