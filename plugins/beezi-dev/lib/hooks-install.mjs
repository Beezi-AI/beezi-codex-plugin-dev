import fs from 'fs';
import path from 'path';
import url from 'url';
import { codexHooksFile, hookLauncherDir, environment } from './paths.mjs';
import { readJson } from './fs-store.mjs';
import { UserError } from './friendly-error.mjs';
import { removeFileSync, removeDirSync } from './compat.mjs';

// Codex does not load hooks bundled inside a plugin — the `plugin_hooks` feature is `removed`, and
// an installed plugin contributes zero entries to the engine's `hooks/list`. Only `skills/` and
// `.mcp.json` travel with the package. So Beezi's lifecycle hooks have to be written into the
// user-level registry (`~/.codex/hooks.json`) by this installer, and trusted once via `/hooks`.

// The base label Codex shows next to each entry. A named variant suffixes it (see ownerLabel), so
// a user with two variants installed can tell in `/hooks` which one is which — the same reason the
// variant builder namespaces `.codex-plugin/plugin.json`'s interface.displayName. It is ONE of the
// ways we recognise our own handlers, never the only one: the install flow invites the user to open
// `/hooks` and read (and potentially edit) this text.
export const BEEZI_STATUS_MESSAGE = 'Beezi analytics';

// The one instruction every caller has to pass on: Codex will not run a hook it has not been shown.
export const TRUST_STEP = 'run /hooks in Codex, review the Beezi entries, and trust them';

// The events Beezi registers.
//
// `SessionEnd` is deliberately absent, and out of scope for this release. The reason that holds is
// `Stop`: it already runs the identical checkpoint (timeline included) at every turn end, so a
// `SessionEnd` entry would cost the user one more hook to review and trust for work already done.
// Whether Codex registers `SessionEnd` on current builds is UNMEASURED — it was measured as
// silently dropped from the registry on 2026-07-27 and nothing has re-run that check since, so
// neither "it works now" nor "it still does not exist" is established. See measurement task M-1-1.
// It could not cover a SIGKILL either way, which is the case a last-chance flush would have to
// survive. The residual is real but small: on a mid-turn kill, segments already queued on disk
// survive and the next session's start-up flush retries them (queueDir() is machine-wide, not
// per-project), while the tail since the last checkpoint waits for a later checkpoint of that
// session or for the manual track flow. That is a cost, not "nothing is lost".
//
// SubagentStart/SubagentStop record identity and timing for spawned agents. They do NOT bill them —
// the parent's own checkpoint does that, so the wall-clock union is computed in one process. See
// scripts/subagent-start.mjs for why they are still worth registering.
export const BEEZI_HOOKS = Object.freeze([
  { event: 'SessionStart', script: 'session-start.mjs' },
  { event: 'PostToolUse', script: 'checkpoint.mjs' },
  { event: 'SubagentStart', script: 'subagent-start.mjs' },
  { event: 'SubagentStop', script: 'subagent-stop.mjs' },
  { event: 'Stop', script: 'stop.mjs' },
]);

const BEEZI_EVENTS = BEEZI_HOOKS.map((h) => h.event);
const SCRIPT_NAMES = BEEZI_HOOKS.map((h) => h.script);

// Every tool, because the tool's *name* differs across Codex's two live tool surfaces
// (`shell_command` on the legacy one, `exec` under unified exec) and has not been measured from a
// real payload yet. `checkpoint.mjs` exits before loading the engine unless the payload carries a
// git checkpoint command OR the mid-turn heartbeat's interval has elapsed for this session
// (lib/timing.mjs) — so the common case is still a short-lived process that stats one marker file
// and exits; guessing the name instead would fail silently by never firing.
const MATCH_ALL = '.*';
// The timeout Codex records for each Beezi hook. Exported because the hooks themselves have to
// finish inside it — Codex kills what overruns and reports the kill as a failed hook — so the
// checkpoint's own budget is derived from this number rather than guessed alongside it.
export const HOOK_TIMEOUT_SEC = 10;

// The interpreter for every hook entry: bare `node`, resolved from the hook's PATH at spawn time.
// Deliberately not process.execPath — an absolute interpreter path goes stale the moment the user
// upgrades Node (nvm and installers both move the directory), which is exactly how the previous
// launcher design kept ending up in the `stale` state. Codex command hooks execute a command
// string, so the script path is quoted below as part of that string.
export const HOOK_COMMAND = 'node';

// Older plugin versions wrote per-event launcher scripts (`beezi-<script>.cmd` / `.sh`) into
// hookLauncherDir() and registered those as the command. The prefix and the dir survive only to
// recognise and clean up those installs.
const LAUNCHER_PREFIX = 'beezi-';

// ── owner identity (G-1-7) ──────────────────────────────────────────────────
//
// `~/.codex/hooks.json` is Codex's, not ours, and it is NOT namespaced by BEEZI_ENV the way
// `~/.beezi-codex<suffix>` is — every installed variant merges into the same file. Until this block
// existed, one recogniser matched any variant's handler by the shared status message or by a
// `beezi`-flavoured script path, so installing beezi-staging stripped beezi's entries and vice
// versa (R1 reproduced it). Every mutation below is now scoped to ONE owner.
//
// The owner is the variant's plugin name: 'beezi' | 'beezi-dev' | 'beezi-staging' — the same string
// the variant builder writes into `.codex-plugin/plugin.json` `name`, so the identity a user sees
// in the plugin list is the identity that owns their hook entries.
const UNSUFFIXED_OWNER = 'beezi';

/**
 * The owner this process installs, uninstalls and reports for.
 *
 * Resolved lazily, NEVER at module load: envSuffix() throws on unresolvable variant metadata, and a
 * top-level const would turn that into a throw-on-import for lib/link-status.mjs, scripts/hooks.mjs
 * and scripts/login.mjs. hookLauncherDir() is deferred for exactly the same reason.
 */
export function hookOwner() {
  return UNSUFFIXED_OWNER + environment.envSuffix();
}

// How a named variant tags its handlers: an inert flag appended to the command string.
//
// DELIBERATELY NOT A NEW JSON KEY. R1 refuses unverified extensions to Codex's schemas, and the
// hook registry is read by the same engine as the marketplace: a key its loader rejects could take
// the whole entry with it. A command argument is data, not schema, and none of the five hook
// scripts reads process.argv
// (session-start, checkpoint, subagent-start, subagent-stop, stop), so the tag is inert at runtime
// while being exact, machine-readable, and immune to a label the user reworded.
const OWNER_FLAG = '--beezi-owner=';

// THE UNSUFFIXED BUILD WRITES NO TAG. Production ownership remains implicit, and
// "absent means production" matches env.json's own convention in lib/paths.mjs. It also makes R1's
// "recognise legacy unsuffixed entries only in the unsuffixed migration path" fall out by
// construction: an untagged, unlabelled legacy entry can only ever resolve to 'beezi'.
function quoteCommandArgument(value) {
  const text = String(value);
  // Windows paths cannot contain a double quote. On POSIX, escape the characters that retain
  // special meaning inside double quotes so a plugin path remains one literal argument.
  if (process.platform === 'win32') return '"' + text.replace(/"/g, '\\"') + '"';
  return '"' + text.replace(/([\\$"\x60])/g, '\\$1') + '"';
}

// Codex 0.154.0 on Windows accepts `arguments` in hooks.json but does not pass them to command
// hooks. Keep the interpreter PATH-resolved, but put the complete invocation in `command`.
export function hookCommand(scriptPath, owner = hookOwner()) {
  const parts = [HOOK_COMMAND, quoteCommandArgument(scriptPath)];
  if (owner !== UNSUFFIXED_OWNER) parts.push(OWNER_FLAG + owner);
  return parts.join(' ');
}

/** 'Beezi analytics' for production, 'Beezi analytics (staging)' for a named variant. */
function ownerLabel(owner) {
  if (owner === UNSUFFIXED_OWNER) return BEEZI_STATUS_MESSAGE;
  return `${BEEZI_STATUS_MESSAGE} (${owner.slice(UNSUFFIXED_OWNER.length + 1)})`;
}

/** Every owner name this build considers well formed, driven by paths.mjs's validated list. */
function knownOwners() {
  return environment.KNOWN_ENVIRONMENTS.map(
    (name) => (name === '' ? UNSUFFIXED_OWNER : `${UNSUFFIXED_OWNER}-${name}`),
  );
}

/** The inverse of ownerLabel, so the label and its parser cannot drift apart. */
function ownerFromLabel(label) {
  if (typeof label !== 'string') return null;
  const owners = knownOwners();
  for (let i = 0; i < owners.length; i += 1) {
    if (label === ownerLabel(owners[i])) return owners[i];
  }
  return null;
}

/** The owner tag a named variant wrote into the legacy `arguments` array, or null. */
function ownerFromArguments(handler) {
  if (!Array.isArray(handler.arguments)) return null;
  for (let i = 1; i < handler.arguments.length; i += 1) {
    const arg = String(handler.arguments[i]);
    if (arg.indexOf(OWNER_FLAG) === 0) return arg.slice(OWNER_FLAG.length);
  }
  return null;
}

function ownerFromCommand(handler) {
  const command = handler && typeof handler.command === 'string' ? handler.command : '';
  const match = /(?:^|\s)--beezi-owner=([A-Za-z0-9_-]+)(?:\s|$)/.exec(command);
  return match ? match[1] : null;
}

// Read both the corrected composite-command form and the broken 0.8.x `arguments` form so install
// and uninstall can migrate existing entries without losing ownership information.
function handlerScript(handler) {
  if (!handler || typeof handler !== 'object') return null;
  if (Array.isArray(handler.arguments) && handler.arguments.length) {
    return String(handler.arguments[0]);
  }
  const command = typeof handler.command === 'string' ? handler.command : '';
  const prefix = HOOK_COMMAND + ' "';
  if (command.indexOf(prefix) !== 0) return null;
  let script = '';
  for (let i = prefix.length; i < command.length; i += 1) {
    const char = command[i];
    if (char === '"') return script;
    if (process.platform !== 'win32' && char === '\\' && i + 1 < command.length
      && '\\$"`'.indexOf(command[i + 1]) !== -1) {
      script += command[i + 1];
      i += 1;
    } else {
      script += char;
    }
  }
  return null;
}

/**
 * Which variant owns this handler — 'beezi' or one of the 'beezi-<env>' names knownOwners()
 * derives from paths.mjs KNOWN_ENVIRONMENTS ('beezi-dev', 'beezi-staging', 'beezi-local') — or null.
 *
 * The ORDER is the whole guarantee. The explicit tag is consulted FIRST, so a tagged beezi-staging
 * entry can never be swept up by the unsuffixed build's loose legacy match below. The label is
 * next, so a variant running out of a source checkout — whose script path carries no variant
 * segment — is still attributed to itself. Only then the two legacy anchors, which pre-date
 * variants entirely and therefore attribute to the unsuffixed owner alone.
 */
function handlerOwner(handler, launcherDir) {
  if (!handler || typeof handler !== 'object') return null;

  const tagged = ownerFromArguments(handler);
  if (tagged !== null) return tagged;

  const commandTagged = ownerFromCommand(handler);
  if (commandTagged !== null) return commandTagged;

  const labelled = ownerFromLabel(handler.statusMessage);
  if (labelled !== null) return labelled;

  const script = handlerScript(handler);
  if (script !== null) {
    // Ours by construction: <...beezi...>/scripts/<one of SCRIPT_NAMES>. Both anchors are
    // needed — a user's own checkpoint.mjs may share the name, and a beezi-flavoured path alone
    // (say, a repo checkout with "beezi" in it) is not proof either.
    if (
      SCRIPT_NAMES.indexOf(path.basename(script)) !== -1
      && path.basename(path.dirname(script)) === 'scripts'
      && /beezi/i.test(script)
    ) return UNSUFFIXED_OWNER;
  }

  const command = typeof handler.command === 'string' ? handler.command : handler.commandWindows;
  if (typeof command !== 'string') return null;
  // Anchored to our own directory: a user's ~/bin/beezi-notify.sh is not ours to remove, and
  // uninstall promises it will leave their hooks alone. Launchers only ever existed on the
  // unsuffixed build, and hookLauncherDir() is itself namespaced, so this can only fire for the
  // migration path it exists to serve.
  if (
    path.basename(command).startsWith(LAUNCHER_PREFIX)
    && path.resolve(path.dirname(command)) === path.resolve(launcherDir)
  ) return UNSUFFIXED_OWNER;

  return null;
}

/** Is this handler THIS variant's? A sibling variant's handler answers false. */
function isOwnedHandler(handler, owner, launcherDir) {
  return handlerOwner(handler, launcherDir) === owner;
}

// ── dead entries ────────────────────────────────────────────────────────────
//
// `~/.codex/hooks.json` outlives the install that wrote it. A registered entry whose target file
// is gone is not inert: Codex still spawns it every session, the spawn fails, and the whole event
// is reported as `hook: <Event> Failed`. Measured on a live machine — three launcher-style entries
// left behind by a pre-launcherless production install, pointing into a `~/.beezi-codex/hooks`
// directory that no longer exists. Run through cmd.exe that is exactly
// `The system cannot find the path specified.` and exit 1, on SessionStart, PostToolUse and Stop,
// for every session on that machine, while `hooksStatus()` reported `installed` — because it is
// owner-scoped and the orphans belonged to a DIFFERENT owner.
//
// The scan below is deliberately READ-ONLY and deliberately NOT owner-scoped. Reporting across
// owners is safe; removing across owners is not, and the one-owner-per-mutation rule above stays
// exactly as it is. The repair is the owning variant's own `uninstall`, which already handles it
// correctly — the defect was never that the removal could not be done, only that nothing said it
// needed doing.

/**
 * The filesystem path a handler actually spawns, or null when it names none.
 *
 * Current-format entries keep `node` PATH-resolved and quote the script inside `command`, so the
 * script is the thing to check. Legacy launcher entries put only the launcher path in
 * `command`/`commandWindows`.
 */
function handlerTarget(handler) {
  if (!handler || typeof handler !== 'object') return null;
  const script = handlerScript(handler);
  if (script !== null) return script;
  const command = typeof handler.command === 'string' ? handler.command : handler.commandWindows;
  if (typeof command !== 'string' || command === '') return null;
  // A single-token command (`node`, `pwsh`) is resolved from the hook's PATH at spawn time and is
  // not a path this process can check. Only a command that names a directory is stat-able.
  if (command.indexOf('/') === -1 && command.indexOf('\\') === -1) return null;
  return command;
}

/**
 * Every Beezi-recognised handler in a registry whose target file is missing, across ALL owners.
 *
 * The recogniser is `handlerOwner`, so an entry is only ever claimed by the same three anchors the
 * mutations use. One consequence is worth stating plainly rather than discovering later: the
 * launcher-dir anchor compares against the CALLER's `launcherDir`, which is namespaced per
 * environment, so a legacy production launcher is invisible to a beezi-local process through that
 * anchor and is caught by its `statusMessage` label instead. A user who reworded the label of a
 * sibling variant's dead launcher entry gets no report of it. Accepted: the label is the only
 * cross-owner anchor that exists, and widening the recogniser to "any path with beezi in it" would
 * start claiming entries that are not ours.
 */
export function brokenBeeziEntries(registry, launcherDir = hookLauncherDir()) {
  const out = [];
  const source = registry && registry.hooks && typeof registry.hooks === 'object' ? registry.hooks : {};
  const owners = knownOwners();
  for (const [event, groups] of Object.entries(source)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) continue;
      for (const handler of group.hooks) {
        const owner = handlerOwner(handler, launcherDir);
        if (owner === null || owners.indexOf(owner) === -1) continue;
        const target = handlerTarget(handler);
        if (target === null) continue;
        if (fs.existsSync(target)) continue;
        out.push({ event, owner, target });
      }
    }
  }
  return out;
}

// This module sits in <pluginRoot>/lib, so its own location is the single source of truth for where
// the plugin's scripts are — no caller has to rediscover the layout.
const DEFAULT_SCRIPTS_DIR = path.join(
  path.dirname(path.dirname(url.fileURLToPath(import.meta.url))),
  'scripts',
);

// The exact command that installs the hooks, absolute and copy-pasteable. Every message that asks
// the user to install has to quote this one: their cwd is the repository they are working in, not
// the plugin root, so a relative `scripts/hooks.mjs` resolves to nothing.
export function installCommand(scriptsDir = DEFAULT_SCRIPTS_DIR) {
  return `node "${path.join(scriptsDir, 'hooks.mjs')}" install`;
}

// The same, for the read-only action. Derived rather than hand-written for the reason above: a
// message that reaches the MCP tool is read by a model that will try to RUN what it is given, and
// a relative path — or worse, a `<plugin>` placeholder — resolves to nothing from the user's cwd.
export function statusCommand(scriptsDir = DEFAULT_SCRIPTS_DIR) {
  return `node "${path.join(scriptsDir, 'hooks.mjs')}" status`;
}

// The `{ hooks: { <Event>: [ { matcher, hooks: [handler] } ] } }` fragment for Beezi's events.
// `owner` is injectable for the same reason `hooksFile` and `launcherDir` are: lib/paths.mjs
// freezes the environment at module load, so a both-orders variant matrix would otherwise need one
// child process per variant.
export function buildHookEntries({ scriptsDir = DEFAULT_SCRIPTS_DIR, owner = hookOwner() } = {}) {
  const out = {};
  for (const { event, script } of BEEZI_HOOKS) {
    out[event] = [
      {
        matcher: MATCH_ALL,
        hooks: [
          {
            type: 'command',
            command: hookCommand(path.join(scriptsDir, script), owner),
            statusMessage: ownerLabel(owner),
            timeout: HOOK_TIMEOUT_SEC,
          },
        ],
      },
    ];
  }
  return out;
}

// The events a registry currently carries THIS OWNER's handlers for. A sibling variant's events
// are not listed, so uninstall never reports having removed what it left alone.
function beeziEvents(registry, launcherDir, owner) {
  const out = [];
  const source = registry && registry.hooks ? registry.hooks : {};
  for (const [event, groups] of Object.entries(source)) {
    if (!Array.isArray(groups)) continue;
    if (groups.some((g) => g && Array.isArray(g.hooks)
      && g.hooks.some((h) => isOwnedHandler(h, owner, launcherDir)))) {
      out.push(event);
    }
  }
  return out;
}

// Drop THIS OWNER's handlers from a registry, leaving every other hook — a sibling variant's, the
// user's own, and any unknown top-level key — untouched. Groups are filtered handler-by-handler
// because a user may have hand-merged ours into a group of their own; a group left with no handlers
// is removed, as is an emptied event.
export function removeBeeziHooks(existing, launcherDir = hookLauncherDir(), owner = hookOwner()) {
  const source = existing ? existing.hooks : null;
  if (!source || typeof source !== 'object') return existing || {};
  const hooks = {};
  for (const [event, groups] of Object.entries(source)) {
    if (!Array.isArray(groups)) { hooks[event] = groups; continue; }
    const kept = [];
    for (const group of groups) {
      // A malformed group has no handlers to filter — pass it through rather than reshape it.
      if (!group || !Array.isArray(group.hooks)) { kept.push(group); continue; }
      const handlers = group.hooks.filter((h) => !isOwnedHandler(h, owner, launcherDir));
      if (handlers.length) kept.push({ ...group, hooks: handlers });
    }
    if (kept.length) hooks[event] = kept;
  }
  return { ...existing, hooks };
}

// Re-install is idempotent: strip THIS OWNER's previous entries first, then append the current
// ones. Every other hook — the user's own and any sibling variant's — keeps its position and
// content. Stripping recognises both entry formats, so a re-install on a machine with the old
// launcher-style entries converts them in one write.
export function mergeHooks(existing, beeziHooks, launcherDir = hookLauncherDir(), owner = hookOwner()) {
  const base = removeBeeziHooks(existing, launcherDir, owner);
  const hooks = { ...(base.hooks || {}) };
  for (const [event, groups] of Object.entries(beeziHooks)) {
    hooks[event] = [...(hooks[event] || []), ...groups];
  }
  return { ...base, hooks };
}

// A registry we cannot parse must never be treated as an empty one. The file is the user's — the
// install flow tells them to open and review it — so a stray trailing comma is a realistic state,
// and merging onto `{}` would rewrite the file with the events in BEEZI_HOOKS and nothing else,
// deleting every hook they had configured. Refuse instead, and say which file to fix.
function readRegistry(hooksFile) {
  let raw;
  try { raw = fs.readFileSync(hooksFile, 'utf-8'); } catch { return {}; }
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch { /* fall through to the error below */ }
  throw new UserError(
    `${hooksFile} is not valid JSON. Fix or remove it, then run the install again — refusing to overwrite hooks that cannot be read.`,
  );
}

// Not writeJsonSecure: this file is Codex's, holds no secret, and must stay readable and
// hand-editable — the user is expected to review it before trusting it via `/hooks`.
function writeRegistry(hooksFile, registry) {
  fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
  fs.writeFileSync(hooksFile, `${JSON.stringify(registry, null, 2)}\n`, 'utf-8');
}

/**
 * Is this a launcher entry from a pre-launcherless install whose file is gone?
 *
 * THE ONE CROSS-OWNER REMOVAL THIS MODULE ALLOWS, and it is narrow on purpose. Three independent
 * facts have to hold before an entry qualifies, and together they make "it might still be a live
 * sibling's" impossible rather than unlikely:
 *
 *   1. Legacy FORM — its command is not one of the composite commands parsed by handlerScript(),
 *      so nothing currently installable can be mistaken for one.
 *   2. Our SHAPE — `<home>/.beezi-codex[-env]/hooks/beezi-<name>`. All three segments are checked,
 *      so a user's own `~/bin/beezi-notify.sh` is not ours and is not touched.
 *   3. DEAD — the file is missing. A sibling variant that still works has a file there; an entry
 *      that fails its spawn on every session has nothing left to protect.
 *
 * The owner-scoping rule above is therefore intact in substance: this removes only entries that no
 * owner can still be using. It is done at install time because install is the moment a user is
 * already accepting a registry rewrite and a re-trust — sweeping here costs them nothing extra,
 * and it is what turns "your status now names the orphans" into "the next install clears them".
 */
function isDeadLegacyLauncher(handler) {
  if (!handler || typeof handler !== 'object') return false;
  if (Array.isArray(handler.arguments) && handler.arguments.length) return false;
  if (handlerScript(handler) !== null) return false;

  const command = typeof handler.command === 'string' ? handler.command : handler.commandWindows;
  if (typeof command !== 'string' || command === '') return false;
  if (!path.basename(command).startsWith(LAUNCHER_PREFIX)) return false;

  const dir = path.dirname(command);
  if (path.basename(dir) !== 'hooks') return false;

  // `.beezi-codex` for the unsuffixed build, `.beezi-codex-<env>` for a named variant — the exact
  // set lib/paths.mjs beeziCodexHome() can produce. A BEEZI_CODEX_HOME override renames the root,
  // so an entry written under one is simply not swept; it is still reported by brokenBeeziEntries.
  const root = path.basename(path.dirname(dir));
  if (root !== '.beezi-codex' && root.indexOf('.beezi-codex-') !== 0) return false;

  return !fs.existsSync(command);
}

/** Drop every dead legacy launcher from a registry, leaving everything else exactly where it is. */
export function removeDeadLegacyLaunchers(existing) {
  const source = existing ? existing.hooks : null;
  if (!source || typeof source !== 'object') return existing || {};
  const hooks = {};
  for (const [event, groups] of Object.entries(source)) {
    if (!Array.isArray(groups)) { hooks[event] = groups; continue; }
    const kept = [];
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) { kept.push(group); continue; }
      const handlers = group.hooks.filter((h) => !isDeadLegacyLauncher(h));
      if (handlers.length) kept.push({ ...group, hooks: handlers });
    }
    if (kept.length) hooks[event] = kept;
  }
  return { ...existing, hooks };
}

export function installHooks({
  scriptsDir = DEFAULT_SCRIPTS_DIR,
  hooksFile = codexHooksFile(),
  launcherDir = hookLauncherDir(),
  owner = hookOwner(),
} = {}) {
  writeRegistry(hooksFile, removeDeadLegacyLaunchers(mergeHooks(
    readRegistry(hooksFile),
    buildHookEntries({ scriptsDir, owner }),
    launcherDir,
    owner,
  )));

  // Launchers are no longer written; sweep away the ones an older version left. The directory is
  // hookLauncherDir(), which is namespaced per environment, so it is exclusively THIS variant's by
  // construction and removing it wholesale cannot reach a sibling's.
  removeDirSync(launcherDir);

  return { hooksFile, owner, events: BEEZI_EVENTS };
}

export function uninstallHooks({
  hooksFile = codexHooksFile(),
  launcherDir = hookLauncherDir(),
  owner = hookOwner(),
} = {}) {
  const existing = readJson(hooksFile, null);
  const removed = beeziEvents(existing, launcherDir, owner).length > 0;
  if (existing) {
    const stripped = removeBeeziHooks(existing, launcherDir, owner);
    // If THIS OWNER's entries were the only reason this registry existed, take the file with them —
    // leaving an empty `{"hooks":{}}` behind would misreport as "the user configured hooks". A
    // sibling variant's entries survive removeBeeziHooks, so `hooks` is not empty and the file is
    // kept: uninstalling one variant must never delete the other's registry.
    const empty = Object.keys(stripped.hooks || {}).length === 0 && Object.keys(stripped).every((k) => k === 'hooks');
    if (empty) {
      removeFileSync(hooksFile);
    } else {
      writeRegistry(hooksFile, stripped);
    }
  }
  removeDirSync(launcherDir);
  return { hooksFile, owner, removed };
}

// Is the current install complete and pointing at scripts the current plugin version actually has?
// Everything is read from the registry alone — there are no launcher files left to compare against,
// and the interpreter is bare `node` on PATH, which cannot be verified from here. A plugin upgrade
// moves the versioned cache directory out from under the registered script paths, so a stale
// install is the expected failure and is named as such rather than reported as "not installed".
// `state` is the classifier callers should branch on.
export function hooksStatus({
  scriptsDir = DEFAULT_SCRIPTS_DIR,
  hooksFile = codexHooksFile(),
  launcherDir = hookLauncherDir(),
  owner = hookOwner(),
} = {}) {
  const registry = readJson(hooksFile, null);
  const source = registry && registry.hooks && typeof registry.hooks === 'object' ? registry.hooks : {};

  const registered = [];
  const missingEvents = [];
  const staleEvents = [];
  for (const { event, script } of BEEZI_HOOKS) {
    const groups = Array.isArray(source[event]) ? source[event] : [];
    const handlers = [];
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) continue;
      for (const handler of group.hooks) {
        // Scoped to this owner: a sibling variant's complete install must not make ours read
        // `installed`, and ours must not make the sibling's read `stale`.
        if (isOwnedHandler(handler, owner, launcherDir)) handlers.push(handler);
      }
    }
    if (!handlers.length) { missingEvents.push(event); continue; }
    registered.push(event);
    // Current means new-format and pointing at this plugin version's script. A legacy launcher or
    // the broken node-plus-arguments form fails this check, which is what routes old
    // installs through `stale` → "run install to repair" → migration.
    const expected = path.join(scriptsDir, script);
    const expectedCommand = hookCommand(expected, owner);
    const current = handlers.some((h) => h.command === expectedCommand && !('arguments' in h));
    if (!current) staleEvents.push(event);
  }

  const complete = !missingEvents.length && !staleEvents.length;
  let state;
  if (complete) state = 'installed';
  else if (staleEvents.length) state = 'stale';
  else if (!registered.length) state = 'absent';
  else state = 'partial';

  // Reported alongside `state`, never folded into it. `state` answers "is THIS owner's install
  // usable"; `broken` answers "is anything in this registry failing every session", which a
  // healthy install of ours does not preclude — that gap is the whole reason this scan exists.
  const broken = brokenBeeziEntries(registry, launcherDir);

  return { hooksFile, owner, state, complete, registered, missingEvents, staleEvents, broken };
}
