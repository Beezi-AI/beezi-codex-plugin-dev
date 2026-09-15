import { apiBase } from './config.mjs';
import { getAccessToken as _getAccessToken } from './token.mjs';
import { getAuthentication as _getAuthentication } from './token.mjs';
import { whoami as _whoami } from './whoami.mjs';
import { hooksStatus as _hooksStatus, statusCommand } from './hooks-install.mjs';

// One answer to "is this machine linked, and is it reporting?".
//
// It exists because there used to be three. `performLogin` asked getCredentials() (raw read, no
// refresh), me.mjs asked getAccessToken() (refresh-aware, wipes on invalid_grant), and each phrased
// the outcome differently — so the MCP tool could say "already linked" in the same minute a script
// said "not linked". Worse, the two run in different environments: the MCP server is spawned by
// Codex and inherits BEEZI_API_URL, while a script the model runs through the shell tool may not,
// leaving them pointed at different APIs with the same credentials. Every answer therefore carries
// the `apiBase` it was computed against, so a disagreement is visible instead of baffling.

export const LinkState = Object.freeze({
  LINKED: 'linked',
  NOT_LINKED: 'not_linked',
  REVOKED: 'revoked',
  UNREACHABLE: 'unreachable',
});

// { state, account, apiBase, hooks } — `hooks` is the analytics-reporting half of the answer,
// because "linked" alone never explains why no analytics are arriving.
export async function linkStatus(deps = {}) {
  const getAccessToken = deps.getAccessToken || _getAccessToken;
  const whoami = deps.whoami || _whoami;
  const base = deps.apiBase || apiBase();

  const auth = deps.getAccessToken && !deps.getAuthentication
    ? { accessToken: await getAccessToken().catch(() => null), state: 'unlinked' }
    : await (deps.getAuthentication || _getAuthentication)().catch(() => ({ state: 'unavailable' }));
  const token = auth.accessToken;
  if (!token) {
    const state = auth.state === 'unlinked' ? LinkState.NOT_LINKED
      : auth.state === 'reauth_required' ? LinkState.REVOKED : LinkState.UNREACHABLE;
    return { state, authState: auth.state, account: null, apiBase: base, hooks: hooks(deps) };
  }

  const who = await whoami(token, { base });
  if (who === null) return { state: LinkState.UNREACHABLE, account: null, apiBase: base, hooks: hooks(deps) };
  if (!who.valid) return { state: LinkState.REVOKED, account: null, apiBase: base, hooks: hooks(deps) };

  return {
    state: LinkState.LINKED,
    account: who.name || who.email || null,
    apiBase: base,
    hooks: hooks(deps),
    // The full whoami verdict rides along so the already-linked login path can refresh the
    // tracking cache (trackingMode / backfillCompleted) without a second round trip.
    who,
  };
}

// Never let a hook-registry read break a link check — the two are independent failures.
//
// `broken` rides along with `state` because the two answer different questions and a machine can
// be in the worst combination of both: `state: 'installed'` while other entries in the same
// registry fail on every session. That combination is not hypothetical — it is the one measured on
// a live machine, and it is why this reader cannot go on returning `state` alone.
function hooks(deps) {
  const read = deps.hooksStatus || _hooksStatus;
  try {
    const s = read();
    return { state: s.state, registered: s.registered, broken: s.broken || [] };
  } catch {
    return { state: 'unknown', registered: [], broken: [] };
  }
}

/**
 * The one sentence about dead registry entries, or null.
 *
 * Separate from the `state` switch below because it is ORTHOGONAL to it: a dead entry fails its
 * spawn whether or not this machine is linked, and whether or not OUR OWN hooks are healthy. The
 * `installed` branch used to be the end of the conversation, which is exactly how a user could be
 * told "hooks are installed, trust them" while three entries had been failing every session for
 * weeks.
 */
function describeBrokenHooks(status) {
  const broken = status.hooks && status.hooks.broken ? status.hooks.broken : [];
  if (!broken.length) return null;

  const events = [];
  for (const entry of broken) {
    if (events.indexOf(entry.event) === -1) events.push(entry.event);
  }
  const plural = broken.length === 1 ? 'entry points' : 'entries point';
  return `Separately: ${broken.length} registered hook ${plural} at a file that no longer exists`
    + ` (${events.join(', ')}), so Codex reports those events as failed on every session.`
    + ` These are removed automatically the next time the hooks are installed or repaired;`
    + ` ${statusCommand()} lists the paths.`;
}

// The single phrasing of each outcome, so the MCP tool, the CLI script and the session banner
// cannot drift apart — and so none of them names a slash command Codex does not have.
export function describeLink(status) {
  switch (status.state) {
    case LinkState.LINKED:
      return `This machine is linked to Beezi${status.account ? ` as ${status.account}` : ''} (API: ${status.apiBase}).`;
    case LinkState.REVOKED:
      return `This machine's Beezi link was revoked (API: ${status.apiBase}). Sign in again to re-link.`;
    case LinkState.UNREACHABLE:
      if (status.authState) return 'Beezi authentication is temporarily unavailable or refreshing. Retry shortly; your saved link has been preserved.';
      return `Could not reach Beezi at ${status.apiBase} to check the link. Check the connection, or BEEZI_API_URL if that address is wrong.`;
    default:
      return 'This machine is not linked to Beezi. Sign in to link it.';
  }
}

// Analytics need both halves: a link and trusted hooks. Returns null when there is nothing to say.
//
// Every branch runs its verdict through `withBroken`, so the dead-entry warning reaches the MCP
// tool, the CLI and the session banner by construction rather than by three call sites remembering
// to ask — the same reason the phrasings live here in the first place.
export function describeReporting(status) {
  const dead = describeBrokenHooks(status);
  const withBroken = (line) => {
    if (!dead) return line;
    return line ? `${line} ${dead}` : dead;
  };

  if (status.state === LinkState.NOT_LINKED) {
    return withBroken('Analytics are NOT being reported — this machine is not linked.');
  }
  if (status.state === LinkState.REVOKED) {
    return withBroken('Analytics are NOT being reported — this machine’s link was revoked.');
  }
  // Unreachable says nothing about the link itself: the credentials may be perfectly good and the
  // hooks may be reporting fine from a process that can see the API. Claiming "not linked" here is
  // what made a status check and the sign-in tool look like they disagreed.
  if (status.state === LinkState.UNREACHABLE) {
    return withBroken('Could not verify the link, so whether analytics are reporting is unknown. Queued reports are retried automatically once the API is reachable.');
  }
  switch (status.hooks.state) {
    case 'installed':
      return withBroken('Analytics hooks are installed. If nothing is arriving, run /hooks in Codex and trust the Beezi entries — Codex will not run a hook it has not been shown.');
    // The three unhealthy states name no command for the user to run. Every surface that reads
    // this — the MCP status tool, the `me` script, the session banner — repairs the install itself
    // before it reports, so quoting `installCommand()` here would hand the user a step that has
    // already been taken. What is left is the trust step, which genuinely cannot be automated.
    case 'absent':
      return withBroken(`Analytics are NOT being reported: the hooks are not installed. Beezi installs them for you — then run /hooks in Codex and trust the Beezi entries.`);
    case 'stale':
      return withBroken('Analytics are NOT being reported: the hooks point at an older plugin version. Beezi repairs them for you — then re-trust via /hooks.');
    case 'partial':
      return withBroken('Analytics may not be reported: the hook install is incomplete. Beezi repairs it for you — then re-trust via /hooks.');
    default:
      return withBroken(null);
  }
}
