import { readHookInput } from '../lib/hook-input.mjs';
import { runHook, importHookModule } from '../lib/hook-runner.mjs';
import { DIAGNOSTIC_SOURCES } from '../lib/diagnostics.mjs';
import { checkEnvironmentLocal, verdictProceeds, noticeFor } from '../lib/env-guard.mjs';
import { maybeSpawnUploadWorker } from '../lib/upload-trigger.mjs';
import { markUploadDue } from '../lib/upload-due.mjs';
import { listAccountsSync } from '../lib/accounts.mjs';
import { markPendingWorkspace, buildWorkspacePrompt, buildJoinedPrompt, buildHistoryNotice, buildHistoryOffer, usableRows } from '../lib/workspace-prompt.mjs';
import { maybeStartPendingHistory, startOfferScans, offerChecksByRow, scanRows } from '../lib/history-trigger.mjs';

const input = readHookInput();
if (!input) process.exit(0);
// startup | resume | clear | compact; may be missing on an older Codex.
const source = input.source;

// The production cutover guard (R1), in its credential-free form: this hook reads no credential.
// It answers 'ok' only for a root already bound to this environment and refuses every other; a
// refusal is shown exactly as the full guard's was ('blocked' says why, 'deferred' says nothing).
// The migration itself runs where the full guard runs: the MCP server (every session's first
// message), the CLI scripts and the upload worker. A migration the WORKER ran is told here, once,
// on the next start (takeMigrationNotice). R-numbers cite docs/plans/2026-09-10-sections/REVIEW.md.
// Asked ONCE, and both answers read from that one verdict.
const guard = checkEnvironmentLocal();
const proceed = verdictProceeds(guard);
let notice = noticeFor(guard);

function write({ systemMessage = null, additionalContext = null }) {
  const out = {};
  if (systemMessage) out.systemMessage = systemMessage;
  if (additionalContext) out.hookSpecificOutput = { hookEventName: 'SessionStart', additionalContext };
  if (Object.keys(out).length > 0) process.stdout.write(JSON.stringify(out));
}

// Both can be present: a session that migrated this run still has its own status to report.
function withNotice(message) {
  if (notice && message) return `${notice}\n\n${message}`;
  return notice || message;
}

// The upload worker gets the session marked due. The LAST thing this hook does, so the hook is long
// gone before the worker does anything slow (on Windows a hook killed at its timeout takes its
// detached children with it). Sync, cheap, never throws, no credential read.
function startUploadWorker() {
  try { maybeSpawnUploadWorker(); } catch { /* best-effort: the next hook tries again */ }
}

// The refused start. 'deferred' is a root only the FULL guard can decide (unbound, legacy, a
// migration pending or in progress). This hook used to be where that guard ran and bound or
// migrated it; now the worker is — it runs the full guard, and the migration, before its lock. The
// due marker is what lets the trigger's gate start it with nothing captured yet. Neither upload-due/
// nor upload-worker.json counts as data, so a marked fresh root still binds, and a migration never
// copies them (lib/env-migration.mjs NOT_COPIED). Not marked while a migration holds its barrier:
// that root is mid-copy. Not marked on a fresh empty root either: nothing is linked, so there is no
// SessionStart work, and a marker that waited for a later login would have the worker report a
// session that ran entirely before the link as live — past sessions go through the history offer
// only. The MCP server's and the login's full guard bind that root. A 'blocked' root (a binding or
// API mismatch) is a hard refusal no worker run can change: nothing is marked and nothing starts.
async function refuse() {
  let message = notice;
  // A root with no data, which the full guard would simply bind: it has no linked account, so the
  // whole answer is the one an unlinked machine always got — the hook just does not do the binding.
  if (guard.reason === 'unbound-empty-root') {
    const start = await importHookModule('./session-start.mjs');
    if (start) message = start.NOT_LINKED_MESSAGE;
  }
  write({ systemMessage: message });
  if (guard.status !== 'deferred') return;
  if (guard.reason !== 'migration-barrier' && guard.reason !== 'unbound-empty-root') {
    try {
      markUploadDue(input.session_id, {
        transcriptPath: typeof input.transcript_path === 'string' ? input.transcript_path : null,
        cwd: typeof input.cwd === 'string' ? input.cwd : null,
        timeline: false,
        sessionStart: true,
      });
    } catch { /* best-effort: the next hook marks again */ }
  }
  startUploadWorker();
}

// Resolved once and shared: the asks only need to know which linked accounts are usable, which
// lib/session-start.mjs answers from the index and each account's last recorded authentication —
// tokenless, with no credential read. The index is read as written (listAccountsSync): the async
// reader can run the one-time pre-0.13 conversion, which re-keys the keyring — the worker, the MCP
// server and the CLI still run it.
let mod = null;
let linked = null;
const deps = {
  listAccounts: async () => listAccountsSync(),
  linkedSessions: (d) => {
    if (linked == null) linked = mod == null ? Promise.resolve([]) : mod.usableSessions(d);
    return linked;
  },
};

async function main() {
  // Bound before any network work, so a killed or failed start still leaves the checkpoint its hold.
  // Independent of lib/session-start.mjs: a failed import below still binds and asks.
  let marked = null;
  try { marked = await markPendingWorkspace(input, deps); } catch { /* the ask is best-effort; the session still starts */ }
  mod = await importHookModule('./session-start.mjs');
  let message = null;
  let failure = null;
  if (mod) {
    try { message = await mod.runSessionStart(input, deps); } catch (error) { failure = error; }
    if (notice == null) notice = mod.takeMigrationNotice();
  }
  // Re-binds with the workspaces the index holds (the upload worker's whoami refreshes them); asks only on startup or clear.
  // A refused re-bind asks from the first bind's answer rather than dropping the question.
  let joined = null;
  let workspacePrompt = null;
  try { joined = await buildJoinedPrompt(input, deps); } catch { /* best-effort */ }
  const joinedPrompt = joined == null ? null : joined.context;
  const joinedKeys = joined == null ? [] : joined.keys;
  try { workspacePrompt = await buildWorkspacePrompt(input, deps, marked); } catch { /* best-effort */ }
  let historyNotice = null;
  let historyOffer = null;
  if (source !== 'compact') {
    // Built only when the status line will be written, since building it takes the results.
    if (failure == null) {
      try { historyNotice = await buildHistoryNotice(input, deps); } catch { /* best-effort */ }
      // One offer instruction per account: the joined pass's item (5), else the history offer; neither races a scan worker.
      let rows = [];
      let checks = null;
      try {
        rows = await usableRows(deps);
        checks = offerChecksByRow(rows, Date.now(), deps);
        historyOffer = await buildHistoryOffer(input, deps, { checks, skipKeys: joinedKeys });
      } catch { /* best-effort */ }
      // Awaited: the hook exits once main resolves. Never throws. `deps`: its rows come from the
      // sync listing above, never the async reader that can run the pre-0.13 keyring conversion.
      await maybeStartPendingHistory(deps);
      const offered = historyOffer == null ? joinedKeys : joinedKeys.concat(historyOffer.keys);
      await startOfferScans(scanRows(rows, offered), deps, { checks });
    }
  }
  // The joined re-pick comes first, so the current-folder question sees its answers; the history offer runs last.
  const offerContext = historyOffer == null ? null : historyOffer.context;
  const additionalContext = [joinedPrompt, workspacePrompt, offerContext].filter(Boolean).join('\n\n') || null;
  if (failure != null) {
    write({ systemMessage: notice, additionalContext });
    startUploadWorker();
    throw failure;
  }
  const status = [message, historyNotice].filter((part) => part != null && part !== '').join('\n') || null;
  write({ systemMessage: withNotice(status), additionalContext });
  startUploadWorker();
}

// A hook that exits non-zero is reported by Codex as failed, so a failure still ends in a clean exit.
runHook(DIAGNOSTIC_SOURCES.SESSION_START, proceed ? main : refuse);
