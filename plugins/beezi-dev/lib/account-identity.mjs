import { readCodexAccount } from './codex-account.mjs';
import { readBillingConfig } from './billing-config.mjs';
import { orDefault } from './compat.mjs';

// Only identity fields accepted by both session reports and quota snapshots. Unknown or
// overlong identifiers are omitted, never truncated into a different account's identifier.
export function accountIdentityFields(account) {
  const out = {};
  for (const [source, target, max] of [['accountId', 'account_uuid', 64], ['email', 'account_email', 320]]) {
    const value = account && account[source];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed && trimmed.length <= max) out[target] = trimmed;
  }
  return out;
}

// THE single answer to "which account does this usage row belong to".
//
// billing.json is consulted FIRST because it is the only place a tier-1 (`codex app-server`)
// identity is ever written down: on a machine whose credentials live in the OS keychain, ~/.codex/
// auth.json names no account at all, and the probe that does runs at most weekly behind the
// isStale() gate in lib/session-start.mjs. Reading auth.json first would mean such a machine
// reported no account id on every session except the one that happened to probe.
//
// auth.json remains the fallback, unchanged: it is the answer on a machine that has a sign-in on
// disk but has never captured a plan. Both reads are small and synchronous — THIS RUNS ON THE
// CHECKPOINT HOT PATH and must never spawn anything.
export function readAccountIdentity(deps = {}) {
  const fromConfig = (() => {
    try {
      const config = orDefault(deps.readBillingConfig, readBillingConfig)();
      return accountIdentityFields(config);
    } catch { return {}; }
  })();
  if (fromConfig.account_uuid) return fromConfig;
  let fromAuth = {};
  try { fromAuth = accountIdentityFields((deps.readCodexAccount || readCodexAccount)()); }
  catch { fromAuth = {}; }
  // A config that knew only the address still contributes it; the uuid decides which wins because
  // it is the field the API keys the account row on.
  return Object.keys(fromAuth).length > 0 ? fromAuth : fromConfig;
}
