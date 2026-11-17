# Beezi analytics for Codex

## What it does

Shows your personal Beezi usage summary in Codex: spend, sessions, status and recommendations for
the last 7 or 30 days. The plugin is read-only. It records nothing and cannot change anything in
Beezi.

## Requirements

A Beezi account. The summary has data only for sessions that Beezi already tracks, for example
through the full Beezi plugin.

## Install

Add Beezi's marketplace, then install the plugin:

```bash
codex plugin marketplace add Beezi-AI/beezi-codex-plugin-dev
codex plugin add beezi-analytics-staging@beezi-internal
```

Start a new Codex thread after installing.

## Sign in

The first time you ask for your analytics, Codex asks you to connect the `beezi_analytics_staging` MCP
server. Follow the browser sign-in with your Beezi account. Nothing is typed in the terminal.

## Usage

Ask in plain words:

- `Show my Beezi analytics for the last 7 days`
- `Show my Beezi analytics for the last 30 days`
- `What does the Beezi analytics plugin do?`

You can also ask for the `analytics` or the `about` skill by name.

The summary covers every coding agent linked to your Beezi account, not Codex alone.

## What it connects to

The plugin declares one remote MCP server, `beezi_analytics_staging`, at `https://beezi-api-staging.azurewebsites.net/api/mcp`.
Its requests carry the header `X-Beezi-Agent: codex`, so Beezi knows they come from Codex.
The plugin runs no local code, has no hooks, and
sends nothing from your conversations to Beezi.

## The full Beezi plugin

The full Beezi plugin, `beezi-staging` in this repository, records your Codex sessions and includes the
same summary, so you do not need both.

## Links

- Website: https://beezi.ai
- Documentation: https://docs.beezi.ai
- Support: https://beezi.ai/contact-us
- Privacy policy: https://beezi.ai/privacy-policy
- Terms: https://beezi.ai/terms-and-conditions

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
