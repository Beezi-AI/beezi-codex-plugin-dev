import fs from 'fs';
import path from 'path';
import url from 'url';
import { beeziCodexHome, environment } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { orDefault } from './compat.mjs';
import { fetchCompat, makeAbortController } from './fetch-compat.mjs';

// ── Stale-version check (G-8-4) ─────────────────────────────────────────────────────────────
//
// The audit called this "blocked upstream", and half of that was right: Codex's remote-marketplace
// support is unverified (M-8-3), so NOTHING HERE UPDATES ANYTHING. What was never blocked is the
// part that matters — the plugin has always carried its own version and nothing read it, so a user
// running a six-month-old build had no way to find out.
//
// So this is a reader and a sentence, not an updater. It compares the installed version against
// the version published in the manifest the build was stamped with (env.json updateManifestUrl,
// written by scripts/make-variant.sh for a variant and by scripts/sync-to-github.sh for the public
// build) and says so once a day at most.
//
// R1: "Do not add an unverified `version` property to Codex's marketplace schema. A Beezi-owned
// update manifest or fetching the referenced plugin manifest can serve the update checker." This
// fetches the referenced PLUGIN manifest — `.codex-plugin/plugin.json`, which already has a
// version because Codex's own schema puts one there. Nothing is invented.

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 2000;

const PLUGIN_JSON_FILE = path.join(
  path.dirname(path.dirname(url.fileURLToPath(import.meta.url))),
  '.codex-plugin',
  'plugin.json',
);

/** Where the last check is remembered. Root level: pruneStale() sweeps state/ at 14 days. */
export function updateCheckFile() {
  return path.join(beeziCodexHome(), 'update-check.json');
}

/** This build's own identity, or null when the manifest cannot be read. */
export function installedPlugin(deps = {}) {
  const read = orDefault(deps.readPluginJson, () => {
    try {
      return JSON.parse(fs.readFileSync(PLUGIN_JSON_FILE, 'utf-8'));
    } catch {
      return null;
    }
  });
  const obj = read();
  if (!obj || typeof obj !== 'object') return null;
  if (typeof obj.version !== 'string' || obj.version === '') return null;
  return { name: typeof obj.name === 'string' ? obj.name : 'beezi', version: obj.version };
}

function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
  if (!m) return null;
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] === undefined ? null : m[4].split('.'),
  };
}

function comparePre(a, b) {
  // Semver's own rule, and the one that matters for this plugin's variants: a build stamped
  // `0.7.0-staging.4821` is BEHIND the plain `0.7.0`, and ahead of `0.7.0-staging.4102`. Numeric
  // identifiers compare numerically so `.10` beats `.9`, which a string compare gets backwards on
  // every tenth internal publish.
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1; // numeric identifiers rank lower than alphanumeric ones
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** -1 when a < b, 0 when equal, 1 when a > b. null when either side is not a version. */
export function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return null;
  for (let i = 0; i < 3; i += 1) {
    if (va.core[i] !== vb.core[i]) return va.core[i] < vb.core[i] ? -1 : 1;
  }
  return comparePre(va.pre, vb.pre);
}

/**
 * The published version, from the manifest this build was stamped with.
 *
 * Accepts the plugin manifest shape only. A marketplace.json arriving here answers `null` rather
 * than an invented version: its schema has no version field, and R1 forbids adding one.
 */
export function versionFromManifest(doc, expectedName) {
  if (!doc || typeof doc !== 'object') return null;
  if (typeof doc.version === 'string') {
    // A manifest for a DIFFERENT plugin is not this build's update — the internal repo holds
    // beezi-dev and beezi-staging side by side, and crossing them would nag every staging user
    // about a dev build.
    if (typeof doc.name === 'string' && expectedName && doc.name !== expectedName) return null;
    return doc.version;
  }
  return null;
}

function readState(deps) {
  const read = orDefault(deps.readJson, readJson);
  const file = orDefault(deps.updateCheckFile, updateCheckFile);
  const obj = read(file(), null);
  return obj && typeof obj === 'object' ? obj : {};
}

function writeState(state, deps) {
  const write = orDefault(deps.writeJsonSecure, writeJsonSecure);
  const file = orDefault(deps.updateCheckFile, updateCheckFile);
  try { write(file(), state); } catch { /* best-effort: a nag is never worth failing a hook */ }
}

/**
 * Is there a newer published build than this one?
 *
 * Returns `{ status, current, latest }`, where status is:
 *   'behind'     a newer version is published
 *   'current'    up to date, or ahead (a developer's local build)
 *   'skipped'    checked recently, no manifest URL, or the version could not be established
 *
 * Never throws, never blocks longer than FETCH_TIMEOUT_MS, and writes nothing but its own
 * timestamp. An offline machine is `skipped`, silently: a plugin that complains about its own
 * update check is worse than one that says nothing.
 */
export async function checkForUpdate(deps = {}) {
  const now = orDefault(deps.now, Date.now)();
  const manifestUrl = orDefault(deps.manifestUrl, environmentManifestUrl)();
  if (!manifestUrl) return { status: 'skipped', reason: 'no-manifest' };

  const installed = installedPlugin(deps);
  if (!installed) return { status: 'skipped', reason: 'no-version' };

  const state = readState(deps);
  const force = deps.force === true;
  if (!force && typeof state.checkedAt === 'number' && now - state.checkedAt < CHECK_INTERVAL_MS) {
    // Answer from the remembered result rather than going quiet: the user upgrading is what
    // clears the nag, and that can happen long before the next check is due.
    if (typeof state.latest === 'string') {
      const cmp = compareVersions(installed.version, state.latest);
      if (cmp === -1) return { status: 'behind', current: installed.version, latest: state.latest, cached: true };
    }
    return { status: 'skipped', reason: 'checked-recently' };
  }

  const fetchImpl = orDefault(deps.fetchImpl, fetchCompat);
  const controller = makeAbortController();
  const timer = setTimeout(() => { try { controller.abort(); } catch { /* already settled */ } }, FETCH_TIMEOUT_MS);
  let doc = null;
  try {
    const res = await fetchImpl(manifestUrl, { signal: controller.signal });
    if (res && res.ok) doc = await res.json();
  } catch {
    doc = null;
  } finally {
    clearTimeout(timer);
  }

  // A failed check still stamps the clock. Otherwise an unreachable manifest costs a request on
  // every single session start, inside the hook's budget, forever.
  const latest = versionFromManifest(doc, installed.name);
  writeState({ checkedAt: now, latest: latest === null ? orDefault(state.latest, null) : latest }, deps);
  if (latest === null) return { status: 'skipped', reason: 'no-published-version' };

  const cmp = compareVersions(installed.version, latest);
  if (cmp === -1) return { status: 'behind', current: installed.version, latest };
  return { status: 'current', current: installed.version, latest };
}

/** The manifest URL baked into this build, or null for a build that was never stamped. */
export function environmentManifestUrl() {
  const resolved = environment.resolveEnvironment({
    envJson: environment.readEnvJson(),
    env: process.env,
  });
  if (resolved.error) return null;
  return orDefault(resolved.updateManifestUrl, null);
}

/** One line for SessionStart, or null. Says what to do, because a version number alone does not. */
export function updateNotice(result) {
  if (!result || result.status !== 'behind') return null;
  return `Beezi: version ${result.latest} is published; this machine runs ${result.current}.`
    + ' Update the plugin from the marketplace you installed it from.';
}
