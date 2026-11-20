import { readChatgptAuth } from './chatgpt-auth.mjs';
import { readBillingConfig } from './billing-config.mjs';
import { boundedLabel, orDefault } from './compat.mjs';

// The @MaxLength every DTO states for account_uuid / account_org_uuid (and accountUuid /
// organizationUuid on the check-in). boundedLabel drops an oversized id rather than truncating it.
const MAX_ID = 64;

// Only identity fields accepted by both session reports and quota snapshots. Unknown or
// overlong identifiers are omitted, never truncated into a different account's identifier.
export function chatgptIdentityFields(account) {
  const out = {};
  for (const [source, target, max] of [['accountId', 'account_uuid', 64], ['email', 'account_email', 320]]) {
    const value = account && account[source];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed && trimmed.length <= max) out[target] = trimmed;
  }
  return out;
}

function seatOf(source, workspace) {
  if (!source || boundedLabel(source.accountId, MAX_ID) !== workspace) return null;
  return boundedLabel(source.userId, MAX_ID);
}

// THE single answer to "which subscription is this": the (account_uuid, account_org_uuid) pair every
// report carries — session reports, usage snapshots, and the check-in (lib/account-sync.mjs), which
// must agree because the server links a session to its account once and never moves it.
//
// chatgpt_account_id is the WORKSPACE, and on a Business/Team plan every seat shares it; keyed on it
// alone, two people became one subscription with one person's address. So the seat
// (chatgpt_user_id) is the account and the workspace its organization — the shape the server
// already splits subscriptions on. Without a seat the workspace-only shape every older plugin sent
// is kept, so such a report still lands on the account row it always did.
//
// billing.json first, as everywhere (see readChatgptIdentity). A seat is only ever paired with the
// workspace it was read alongside: auth.json may fill a seat billing.json lacks, but only for the
// same workspace, never across two sign-ins.
export function subscriptionKey(config, account) {
  const workspace = orDefault(
    boundedLabel(config ? config.accountId : null, MAX_ID),
    boundedLabel(account ? account.accountId : null, MAX_ID),
  );
  if (workspace === null) return {};
  const seat = orDefault(seatOf(config, workspace), seatOf(account, workspace));
  return seat === null ? { account_uuid: workspace } : { account_uuid: seat, account_org_uuid: workspace };
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
// disk but has never captured a plan, and it is read every time now because it may also hold the
// seat a pre-seat billing.json lacks. Both reads are small and synchronous — THIS RUNS ON THE
// CHECKPOINT HOT PATH and must never spawn anything.
export function readChatgptIdentity(deps = {}) {
  let config = null;
  try { config = orDefault(deps.readBillingConfig, readBillingConfig)(); } catch { config = null; }
  let auth = null;
  try { auth = (deps.readChatgptAuth || readChatgptAuth)(); } catch { auth = null; }
  const fromConfig = chatgptIdentityFields(config);
  const fromAuth = chatgptIdentityFields(auth);
  // A config that knew only the address still contributes it; the uuid decides which wins because
  // it is the field the API keys the account row on.
  let fields = fromConfig;
  if (!fromConfig.account_uuid && Object.keys(fromAuth).length > 0) fields = fromAuth;
  const out = subscriptionKey(config, auth);
  if (fields.account_email) out.account_email = fields.account_email;
  return out;
}
