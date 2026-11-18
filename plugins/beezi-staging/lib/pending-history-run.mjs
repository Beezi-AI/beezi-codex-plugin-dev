import { runAudit as _runAudit, planWorkspaceRuns as _planWorkspaceRuns, createRunCache as _createRunCache, dontTrackSessionIds } from './session-audit.mjs';
import { BackfillHalt } from './audit-flush.mjs';
import { isMultiTenant, tenantById } from './workspace.mjs';
import { usesRules } from './workspace-rules.mjs';
import { rolloutStartedAt as _rolloutStartedAt } from './subagent-codex.mjs';
import { pendingHistoryOf, historyDue, waitingOnRecent, RunOutcome, SettleState } from './pending-history.mjs';
import { createProgressWriter as _createProgressWriter } from './upload-progress.mjs';

// A live checkpoint transaction or a run that took the lock over is busy, not a failure.
const BUSY_REASONS = ['run-in-progress', 'upload-busy', 'active-writer', 'pending-transaction'];
const BUSY_HALTS = [BackfillHalt.LOCK_LOST];
const REFUSED_REASONS = ['workspace-required', 'audit-only'];
const REFUSED_HALTS = [BackfillHalt.NOT_ALLOWED, BackfillHalt.FORBIDDEN, BackfillHalt.UNSUPPORTED_SERVER];
const BUSY_WAIT_MS = 30_000;
const BUSY_RETRIES = 6;

// One history run's meaning for the marker; `waiting` = a recent session predates the request.
export function classifyRun(result, waiting) {
  if (result == null) return RunOutcome.FAILED;
  if (BUSY_REASONS.indexOf(result.reason) !== -1 || BUSY_HALTS.indexOf(result.halt) !== -1) return RunOutcome.BUSY;
  if (REFUSED_REASONS.indexOf(result.reason) !== -1 || REFUSED_HALTS.indexOf(result.halt) !== -1) return RunOutcome.REFUSED;
  if (result.ok !== true || result.reason != null || result.halt != null) return RunOutcome.FAILED;
  if (result.reportsFailed > 0 || result.deferredUnavailable > 0) return RunOutcome.FAILED;
  if (result.coverageKnown === false && result.candidates > 0) return RunOutcome.FAILED;
  return waiting ? RunOutcome.WAITING : RunOutcome.CLEAN;
}

export function workspaceName(row, tenantId) {
  const t = tenantById(row, tenantId);
  if (t != null && t.name) return t.name;
  return !isMultiTenant(row) && row.tenantName ? row.tenantName : tenantId;
}

// runAudit also writing the run's progress record through `writer`, marked failed unless the run ended clean; a busy run
// leaves the record to the run that owns it.
async function runWithProgress(runAudit, runDeps, options, writer) {
  let counts = { processed: 0, total: 0, sent: 0 };
  const onProgress = (p) => {
    counts = { processed: p.processed, total: p.total, sent: p.sessionsImported };
    writer.update(counts);
  };
  const result = await runAudit({ ...runDeps, onProgress }, options).catch(() => null);
  const outcome = classifyRun(result, false);
  if (outcome !== RunOutcome.BUSY) writer.finish(counts, outcome !== RunOutcome.CLEAN);
  return result;
}

function startedAtMs(recent, startedAt) {
  try {
    const ms = startedAt(recent.path);
    return typeof ms === 'number' && Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

// Each pending workspace's runAudit options, limited to the sessions the developer accepted and hashed with the run's own
// whoami block (history): a --tenant override runs unrouted, the rest as sync plans them; null when no route reaches it.
function plannedRuns(row, entries, planRuns) {
  const accepted = (entry) => ({ onlySessionIds: entry.sessionIds, history: true });
  if (!isMultiTenant(row)) {
    const options = { tenantId: null };
    if (usesRules(row)) options.excludedSessionIds = dontTrackSessionIds(planRuns(row));
    return entries.slice(0, 1).map((entry) => ({ entry, options: { ...options, ...accepted(entry) } }));
  }
  const plan = planRuns(row);
  return entries.map((entry) => {
    if (entry.override === true) return { entry, options: { tenantId: entry.tenantId, ...accepted(entry) } };
    return {
      entry,
      options: plan.tenantIds.indexOf(entry.tenantId) === -1
        ? null
        : { tenantId: entry.tenantId, sessionRoutes: plan.routes, ...accepted(entry) },
    };
  });
}

// Runs every pending workspace of one account (or only `tenantIds`) once, reports each run to `onResult` and settles each entry.
export async function runPendingHistory(key, deps = {}, { tenantIds = null, onResult = null } = {}) {
  const accounts = deps.accounts == null ? await import('./accounts.mjs') : deps.accounts;
  const runAudit = deps.runAudit == null ? _runAudit : deps.runAudit;
  const planRuns = deps.planWorkspaceRuns == null ? _planWorkspaceRuns : deps.planWorkspaceRuns;
  const startedAt = deps.rolloutStartedAt == null ? _rolloutStartedAt : deps.rolloutStartedAt;
  const createWriter = deps.createProgressWriter == null ? _createProgressWriter : deps.createProgressWriter;
  const now = deps.now == null ? () => Date.now() : deps.now;
  // Before the read: a rule landing after it must not count as covered by this plan.
  const plannedAtMs = now();
  const row = (await accounts.listAccounts()).find((a) => a.key === key && a.status === accounts.AccountStatus.LINKED);
  if (row == null) return [];
  const entries = pendingHistoryOf(row).filter((e) => tenantIds == null || tenantIds.indexOf(e.tenantId) !== -1);
  if (entries.length === 0) return [];
  await accounts.notePendingAttempt(key, entries.map((e) => e.tenantId), new Date(plannedAtMs).toISOString());
  const done = [];
  let busy = false;
  // One git cache for every workspace pass, so each rollout's repository is resolved once.
  const runCache = (deps.createRunCache == null ? _createRunCache : deps.createRunCache)();
  for (const { entry, options } of plannedRuns(row, entries, planRuns)) {
    let run = { outcome: busy ? RunOutcome.BUSY : RunOutcome.CLEAN, sent: 0, skipped: 0 };
    if (!busy && options != null) {
      // A throwing run settles as failed (classifyRun(null)) rather than leaving later entries unsettled.
      const writer = createWriter({ key, tenantId: entry.tenantId, workspace: workspaceName(row, entry.tenantId) });
      const result = await runWithProgress(runAudit, { runCache }, { ...options, key }, writer);
      if (onResult != null) onResult(entry, result);
      const ran = result == null ? {} : result;
      const recent = Array.isArray(ran.recent) ? ran.recent.map((r) => startedAtMs(r, startedAt)) : [];
      run = {
        outcome: classifyRun(result, waitingOnRecent(recent, entry.requestedAt)),
        sent: ran.sessionsImported || 0,
        skipped: (ran.deferredGap || 0) + (ran.deferredSplit || 0) + (ran.deferredOverlap || 0),
      };
      // Busy behind an upload that keeps failing: retried at the busy delay, charged as a failure.
      if (run.outcome === RunOutcome.BUSY && ran.uploadFailing === true) run.failing = true;
      busy = run.outcome === RunOutcome.BUSY;
    }
    // A busy index lock leaves this entry for the next pass instead of abandoning the rest.
    const state = await accounts.settlePendingHistory(key, entry.tenantId, run, { plannedAtMs, nowMs: now() }).catch(() => SettleState.MISSING);
    done.push({ tenantId: entry.tenantId, outcome: run.outcome, state });
  }
  return done;
}

const busyIds = (done) => done.filter((d) => d.outcome === RunOutcome.BUSY).map((d) => d.tenantId);

// Reruns only the busy workspaces while another writer holds the lock: up to `retries` more passes, `waitMs` apart,
// each pass's results replacing the earlier ones for its workspaces.
export async function runPendingHistoryPatiently(key, deps = {}, { waitMs = BUSY_WAIT_MS, retries = BUSY_RETRIES } = {}) {
  const sleep = deps.sleep == null ? (ms) => new Promise((resolve) => setTimeout(resolve, ms)) : deps.sleep;
  let done = await runPendingHistory(key, deps);
  let busy = busyIds(done);
  for (let left = retries; left > 0 && busy.length > 0; left -= 1) {
    await sleep(waitMs);
    const again = await runPendingHistory(key, deps, { tenantIds: busy });
    done = done.filter((d) => busy.indexOf(d.tenantId) === -1).concat(again);
    busy = busyIds(again);
  }
  return done;
}

// The watcher's retry: every linked account whose pending history is due, one after another.
// Reads the index as written: an unmigrated install has no marker, and its migration may reach the keyring.
// Credential-free: is any linked account's pending history due? The watcher folds this into its guard-or-idle decision.
export async function pendingHistoryDueNow(deps = {}) {
  const accounts = deps.accounts == null ? await import('./accounts.mjs') : deps.accounts;
  const nowMs = deps.now == null ? Date.now() : deps.now();
  return accounts.listAccountsSync().some((a) => a.status === accounts.AccountStatus.LINKED && historyDue(a, nowMs));
}

export async function runDuePendingHistory(deps = {}) {
  const accounts = deps.accounts == null ? await import('./accounts.mjs') : deps.accounts;
  const nowMs = deps.now == null ? Date.now() : deps.now();
  const rows = accounts.listAccountsSync().filter((a) => a.status === accounts.AccountStatus.LINKED && historyDue(a, nowMs));
  const done = [];
  for (const row of rows) {
    if (deps.shouldStop != null && deps.shouldStop()) break;
    for (const item of await runPendingHistory(row.key, deps)) done.push(item);
  }
  return done;
}
