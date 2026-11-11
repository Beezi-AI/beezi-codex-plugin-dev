import { AccountStatus } from './accounts.mjs';
import { placeOfDir, routeOfDir, routeText } from './route-describe.mjs';
import { accountLabel, liveOffNote } from './session-banner.mjs';
import { cachedUpdate, installedPlugin } from './update-check.mjs';
import { compareVersions } from './version-compare.mjs';

// The tail of the beezi_status answer: where this folder's analytics go, per account, and the plugin
// version with how to update it. Codex has no status skill, so this lives in the MCP tool (spec D1).

const PLACE_LABELS = { repo: 'This repo', folder: 'This folder', outside: 'Here' };

// `YYYY-MM-DD HH:MM UTC` — fixed, so the answer reads the same on every machine and locale.
function formatTime(iso) {
  const ms = Date.parse(typeof iso === 'string' ? iso : '');
  if (Number.isNaN(ms)) return null;
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

// Installed version and the cached update reading only: beezi_status never fetches (Review Focus 4).
export function pluginInfo(deps = {}) {
  const plugin = installedPlugin(deps);
  const state = cachedUpdate(deps);
  return {
    installed: plugin == null ? null : plugin.version,
    latest: typeof state.latest === 'string' ? state.latest : null,
    checkedAt: typeof state.checkedAt === 'number' ? new Date(state.checkedAt).toISOString() : null,
  };
}

// "This repo: labacus-suite → Acme (default)", with the banner's note when nothing goes live; null when unknown.
// `who` names the account when several are linked: "This repo (dev@acme.io): …". Throws on an unreadable row.
function placeLine(row, place, dir, ctx, tracking, who) {
  const route = routeOfDir(row, dir, ctx);
  if (route.reason.kind === 'unknown') return null;
  const where = place.kind === 'outside' ? 'sessions outside a project' : place.short;
  const off = liveOffNote(row, tracking, route);
  const label = `${PLACE_LABELS[place.kind] || 'Here'}${who == null ? '' : ` (${who})`}`;
  return `${label}: ${where} ${routeText(row, route)}${off == null ? '' : `, but ${off}`}`;
}

// null when no thread folder is known or it cannot be keyed: then no route line is printed.
function placeOf(dir, ctx) {
  if (dir == null) return null;
  try { return placeOfDir(dir, ctx); } catch { return null; }
}

// Same comparison as checkForUpdate, so this answer and the session-start notice cannot disagree.
function pluginText(plugin) {
  if (plugin.installed == null) return 'unknown (could not read its version)';
  if (plugin.latest == null) return `${plugin.installed} (could not check for updates)`;
  const cmp = compareVersions(plugin.installed, plugin.latest);
  if (cmp === -1) {
    const seen = formatTime(plugin.checkedAt);
    return `${plugin.installed}. Update available: ${plugin.latest}${seen == null ? '' : ` (last checked ${seen})`}`;
  }
  if (cmp === 0) return `${plugin.installed}, the newest`;
  if (cmp === 1) return `${plugin.installed}, newer than the published ${plugin.latest}`;
  return `${plugin.installed} (could not compare it with the published ${plugin.latest})`;
}

// updateNotice's steps, only when a newer version is out.
function updateSteps(plugin) {
  if (plugin.installed == null || plugin.latest == null || compareVersions(plugin.installed, plugin.latest) !== -1) return [];
  return ['', `To update to ${plugin.latest}:`, '  Run: codex plugin marketplace upgrade', '  Then start a new Codex thread to apply it.'];
}

// ── the background upload ───────────────────────────────────────────────────────────────────────
// The hooks only capture; the upload worker (lib/upload-worker.mjs) sends. A worker that keeps
// failing is otherwise invisible, so this answer reports its last run from upload-worker.json and,
// when something needs the user, ONE warning that says what to do. The status record is not a
// liveness signal (a killed worker leaves `state: 'running'`), so `state` is never reported.

const DAY_MS = 24 * 60 * 60 * 1000;

// What each recorded outcome means, as the end of "last run <time>, …".
const OUTCOME_TEXT = {
  empty: 'everything was sent',
  deadline: 'stopped at its time limit with more to send; the next run continues',
  'lock-lost': 'handed over to another upload run',
  // A run that sent some and then idled on the rest is recorded `stalled` too.
  stalled: 'could not send everything',
  crash: 'crashed',
  watchdog: 'was stopped for running too long',
  'lock-failed': 'could not start, because its lock file could not be written',
  'tracking-disabled': 'sent nothing because tracking is off',
  'no-accounts': 'sent nothing because no linked account could sign in',
};

// The outcomes that need the user, each with what to do. `retry` is " after <time>" while the
// worker's backoff runs, else "". tracking-disabled is written both when the server says every
// account is dark and when the environment guard refused, so its wording covers both.
const OUTCOME_WARNINGS = {
  stalled: (retry) => 'Warning: the last background upload could not send everything it had, usually because there is no network or '
    + 'the sign-in has expired. Check your connection, and if this keeps happening run the login skill. '
    + `Beezi retries on its own${retry}.`,
  crash: (retry) => `Warning: the last background upload crashed. Beezi retries on its own${retry}; to send now and see the error, run the track skill.`,
  watchdog: (retry) => `Warning: the last background upload was stopped for running too long. Beezi retries on its own${retry}; to send now, run the track skill.`,
  'lock-failed': (retry) => 'Warning: the background upload could not write its lock file in Beezi’s data folder. '
    + `Check that the folder is writable and the disk is not full. Beezi retries on its own${retry}.`,
  'tracking-disabled': () => 'Warning: the last background upload sent nothing: tracking is off for every linked account, or this '
    + 'machine’s Beezi data is waiting on an environment check. Run the settings skill to see each account’s state.',
  'no-accounts': () => 'Warning: the last background upload found no linked account that could sign in. Run the login skill to sign in again.',
};

const STALE_WARNING = 'Warning: analytics are waiting to upload, but no background upload has finished in the last 24 hours. '
  + 'Run the track skill to send them now.';

function formatMs(ms) {
  return typeof ms === 'number' && isFinite(ms) ? formatTime(new Date(ms).toISOString()) : null;
}

/**
 * The background upload's lines for beezi_status: [] when no run was ever recorded and nothing is
 * waiting, else the last run and at most one warning — a failing outcome first, then a backoff
 * still running, then work waiting with no run finished in the last 24 hours. `status` is
 * readUploadStatus(); `workWaiting` is whether a due marker or a postable queue file exists
 * (hasPostableWork(0)); `now` is epoch ms.
 */
export function uploadStatusLines({ status, now, workWaiting }) {
  const record = status != null && typeof status === 'object' ? status : {};
  const lastRunAt = typeof record.lastRunAt === 'number' && isFinite(record.lastRunAt) ? record.lastRunAt : null;
  const outcome = typeof record.outcome === 'string' ? record.outcome : null;
  if (lastRunAt === null && outcome === null && !workWaiting) return [];

  const what = outcome === null ? null : (OUTCOME_TEXT[outcome] || `ended "${outcome}"`);
  // A lock-failed exit writes no `lastRunAt`, so the one on file is an earlier run's: not this outcome's time.
  const when = outcome === 'lock-failed' ? null : formatMs(lastRunAt);
  let line;
  if (when !== null) line = `Background upload: last run ${when}${what === null ? '' : `, ${what}`}.`;
  else if (what !== null) line = `Background upload: ${what}.`;
  else line = 'Background upload: no run has finished yet.';

  const retryAt = typeof record.retryAfterAt === 'number' && record.retryAfterAt > now ? formatMs(record.retryAfterAt) : null;
  const retry = retryAt === null ? '' : ` after ${retryAt}`;
  let warning = null;
  if (outcome !== null && OUTCOME_WARNINGS[outcome]) warning = OUTCOME_WARNINGS[outcome](retry);
  else if (retryAt !== null) warning = `Warning: background uploads are paused until ${retryAt} after a failed run. Beezi retries on its own then; to send now, run the track skill.`;
  else if (workWaiting && (lastRunAt === null || now - lastRunAt > DAY_MS)) warning = STALE_WARNING;
  return warning === null ? [line] : [line, warning];
}

// `dir` is the thread's recorded folder (null when none); `tracking` is each account's tracking state by key;
// `plugin` is pluginInfo(); `upload` is uploadStatusLines' input, or null when it could not be read. A revoked
// account reports nothing, so it gets no route line, and a machine with no linked account gets no upload lines.
export function statusExtraLines({ rows, dir, ctx, tracking, plugin, upload = null }) {
  const place = placeOf(dir, ctx);
  const linked = rows.filter((row) => row.status !== AccountStatus.REVOKED);
  const lines = [];
  if (place != null) {
    // A row that throws anywhere (route, note, label) drops only its own line; the Plugin line always stays.
    linked.forEach((row) => {
      try {
        const who = linked.length > 1 ? accountLabel(row) : null;
        const line = placeLine(row, place, dir, ctx, tracking == null ? null : tracking[row.key], who);
        if (line != null) lines.push(line);
      } catch { /* this row's line is left out */ }
    });
  }
  if (upload != null && linked.some((row) => row.status === AccountStatus.LINKED)) {
    try { lines.push(...uploadStatusLines(upload)); } catch { /* the upload lines are left out */ }
  }
  return lines.concat([`Plugin: ${pluginText(plugin)}`], updateSteps(plugin));
}
