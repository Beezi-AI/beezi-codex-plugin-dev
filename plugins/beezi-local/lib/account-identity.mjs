import { readCodexAccount } from './codex-account.mjs';

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

export function readAccountIdentity(deps = {}) {
  try { return accountIdentityFields((deps.readCodexAccount || readCodexAccount)()); }
  catch { return {}; }
}
