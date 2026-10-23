import path from 'path';
import { fileURLToPath } from 'url';
import { spawnDetached } from './background-spawn.mjs';
import { historyDue, workspaceIdOf } from './pending-history.mjs';
import { OfferCheck, offerCheck, offerRecordOf, offerTrackingDisabled } from './history-offer.mjs';
import { anonymizationFor } from './anonymization.mjs';
import { readTrackingState } from './tracking.mjs';
import { tenantsOf } from './workspace.mjs';
import { orDefault } from './compat.mjs';

export const HISTORY_WORKER_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'history-worker.mjs');

const DEFER_FLAG = '--defer-upload';

// --defer-upload: a flow (sync, login, the setup wizard) runs the write: its line carries no undo hint, and the commands it prints keep the flag.
export function takeDeferFlag(argv) {
  return { deferUpload: argv.indexOf(DEFER_FLAG) !== -1, argv: argv.filter((arg) => arg !== DEFER_FLAG) };
}

async function linkedIndexRows(deps) {
  const accounts = await import('./accounts.mjs');
  const listAccounts = deps.listAccounts == null ? accounts.listAccounts : deps.listAccounts;
  return (await listAccounts(deps)).filter((a) => a.status === accounts.AccountStatus.LINKED);
}

// The retry path (SessionStart): one worker per account whose pending history is due. Never throws.
export async function maybeStartPendingHistory(deps = {}) {
  const nowMs = deps.now == null ? Date.now() : deps.now();
  let started = 0;
  try {
    for (const row of await linkedIndexRows(deps)) {
      if (historyDue(row, nowMs) && spawnDetached(HISTORY_WORKER_SCRIPT, deps, ['--account', row.key]) === true) started += 1;
    }
  } catch { /* best-effort: the next session start retries */ }
  return started;
}

// Every workspace an offer can be made for: the account's workspaces, or an older portal's one.
export function offerWorkspaceIds(row) {
  const tenants = tenantsOf(row);
  if (tenants != null && tenants.length > 0) return tenants.map((t) => t.id);
  const id = workspaceIdOf(row);
  return id == null ? [] : [id];
}

// Each workspace's offer check from the index row alone, plus at most one tracking-file read.
export function offerChecksOf(row, nowMs, deps = {}) {
  const read = orDefault(deps.readTrackingStateImpl, readTrackingState);
  const readTracking = (key) => read(key, deps);
  return offerWorkspaceIds(row).map((tenantId) => {
    const block = anonymizationFor(row, tenantId);
    const check = offerCheck({ block, trackingDisabled: offerTrackingDisabled(row, block, readTracking), record: offerRecordOf(row, tenantId), nowMs });
    return { tenantId, check };
  });
}

// Each row's offer checks by account key, computed once per session start and shared by the offer and the scans.
export function offerChecksByRow(rows, nowMs, deps = {}) {
  return new Map(rows.map((row) => [row.key, offerChecksOf(row, nowMs, deps)]));
}

// A row's checks from `checks` when given (a row it lacks has none), else computed now.
export function offerChecksFor(row, nowMs, deps, checks) {
  if (checks == null) return offerChecksOf(row, nowMs, deps);
  return orDefault(checks.get(row.key), []);
}

// The rows a scan worker may start for: none once this start emitted any offer instruction, since a scan would take the
// machine-wide history lock the model's listing needs; every row is scanned at the next start.
export function scanRows(rows, offeredKeys) {
  return offeredKeys.length > 0 ? [] : rows;
}

// SessionStart: one offer-scan worker per account with a workspace to scan, its workspaces stamped in one write; skips
// an account maybeStartPendingHistory starts. Never throws.
export async function startOfferScans(rows, deps = {}, { checks = null } = {}) {
  const nowMs = deps.now == null ? Date.now() : deps.now();
  let started = 0;
  for (const row of rows) {
    try {
      if (historyDue(row, nowMs)) continue;
      const tenantIds = offerChecksFor(row, nowMs, deps, checks).filter((c) => c.check === OfferCheck.SCAN).map((c) => c.tenantId);
      if (tenantIds.length === 0) continue;
      const recordOffers = deps.recordOffers == null ? (await import('./accounts.mjs')).recordOffers : deps.recordOffers;
      await recordOffers(row.key, tenantIds, { scanAt: new Date(nowMs).toISOString() }, deps);
      if (spawnDetached(HISTORY_WORKER_SCRIPT, deps, ['--offer', '--account', row.key]) === true) started += 1;
    } catch { /* best-effort: the next session start retries */ }
  }
  return started;
}
