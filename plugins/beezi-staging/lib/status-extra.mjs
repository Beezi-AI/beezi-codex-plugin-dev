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

// `dir` is the thread's recorded folder (null when none); `tracking` is each account's tracking state by key;
// `plugin` is pluginInfo(). A revoked account reports nothing, so it gets no route line.
export function statusExtraLines({ rows, dir, ctx, tracking, plugin }) {
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
  return lines.concat([`Plugin: ${pluginText(plugin)}`], updateSteps(plugin));
}
