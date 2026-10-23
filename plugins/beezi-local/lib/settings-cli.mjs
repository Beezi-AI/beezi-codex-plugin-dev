import { getDefaultKey, listAccounts } from './accounts.mjs';
import { accountHealth, healHooks } from './me.mjs';
import { currentSession, describeTenant, isMultiTenant, isSingleTenant, joinTenantNames, newFoldersOf, tenantById, tenantsOf } from './workspace.mjs';
import { createRouteContext, rulesOf, rulesTableLines } from './workspace-rules.mjs';
import { kindWords, placeOfDir, routeOfDir, routeTarget, routeText } from './route-describe.mjs';
import { workspaceCommand } from './workspace-cli.mjs';
import { readBillingConfig, resolveSource } from './billing-config.mjs';
import { BillingSource } from './billing.mjs';
import { isLiveTrackingAllowed } from './tracking.mjs';
import { crashMode } from './diagnostics.mjs';
import { hasKind } from './anonymization.mjs';
import { Kind } from './anonymize.mjs';
import { UserError, friendlyMessage } from './friendly-error.mjs';

// What the settings skill reads, in one call per view: the screen, the machine-readable `keys`, and
// every block the next question needs.
//
// It lives here rather than in scripts/settings.mjs for the reason lib/accounts-cli.mjs does:
// tools/hermetic-env.mjs guards child_process, so the output is only testable in-process. Every
// function returns lines; the script prints them.

const LABEL_WIDTH = 16;
const NOT_LINKED = 'Beezi · not linked — use the login skill';
export const USAGE = 'Usage: settings.mjs [menu | rules | new-folders | account | privacy | all | keys]';

function field(label, value) {
  return `  ${label.padEnd(LABEL_WIDTH)}${value}`;
}

function names(row, ids) {
  return ids.map((id) => {
    const t = tenantById(row, id);
    return t != null && t.name ? t.name : id;
  }).join(', ');
}

function newFoldersLabel(row) {
  const newFolders = newFoldersOf(row);
  if (newFolders.mode === 'send') return `Send to ${names(row, newFolders.tenantIds)}`;
  return newFolders.mode === 'none' ? 'Don\'t send' : 'Ask me';
}

// "labacus-suite → Acme (default)": where this folder's analytics go, and why.
function thisFolder(row, dir, ctx) {
  const place = placeOfDir(dir, ctx);
  return place == null ? null : `${place.short} ${routeText(row, routeOfDir(row, dir, ctx))}`;
}

function rulesCount(n) {
  if (n === 0) return 'none yet';
  return n === 1 ? '1 repo/folder' : `${n} repos/folders`;
}

// Skipped for a one-workspace account when live tracking is off (audit mode or disabled): "→ Acme" would be wrong there.
function hereShown(row) {
  return !isSingleTenant(row) || isLiveTrackingAllowed(row.key);
}

// On several workspaces the value names the top-level block's workspace.
function appearsAsField(row) {
  const block = row.anonymization;
  if (!hasKind(block, Kind.HOSTS) || !block.machineName) return null;
  const tenant = isMultiTenant(row) ? tenantById(row, block.tenantId) : null;
  return field('Appears as', tenant != null && tenant.name ? `${block.machineName} in ${tenant.name}` : block.machineName);
}

// accountHealth's lines folded into one: "Beezi: " dropped, sentences joined.
function signInField(lines) {
  const text = lines.map((l) => l.trim()).join(' ').replace(/^Beezi: /, '');
  return field('Sign-in', text.charAt(0).toUpperCase() + text.slice(1));
}

// SERIAL, never Promise.all: two token refreshes at once in one process are refused as lock-order.
async function healthByKey(accounts, deps) {
  const health = {};
  for (const a of accounts) {
    try {
      health[a.key] = await accountHealth(a, deps);
    } catch (error) {
      health[a.key] = { ok: false, lines: [friendlyMessage(error)] };
    }
  }
  return health;
}

// Everything the sections read, loaded once; health checks only when a section shows sign-in.
async function loadView(withHealth, deps) {
  const accounts = await listAccounts(deps);
  const health = withHealth ? await healthByKey(accounts, deps) : {};
  // Health checks refresh each account's workspaces, so the index is read again after.
  const rows = withHealth && accounts.length > 0 ? await listAccounts(deps) : accounts;
  const cwd = deps.cwd != null ? deps.cwd : process.cwd();
  const session = currentSession(cwd, deps.env != null ? deps.env : process.env);
  const dir = session.state != null && session.state.cwd != null ? session.state.cwd : cwd;
  return { rows, health, def: await getDefaultKey(deps), dir, ctx: createRouteContext(), liveSessionId: session.sessionId, deps };
}

function screen(view) {
  const machine = [field('Crash reports', crashMode() === 'off' ? 'Off' : 'On')];
  const { rows, health, def, dir, ctx } = view;
  if (rows.length === 0) return [NOT_LINKED].concat(machine);
  // The hook repair the removed `me` skill ran, on linked machines only; a healthy install is left untouched.
  const healed = rows.some((a) => health[a.key] != null && health[a.key].ok) ? healHooks(view.deps) : null;
  const several = rows.length > 1;
  const out = [];
  rows.forEach((row, i) => {
    if (several && i > 0) out.push('');
    out.push(`Beezi · ${row.email || row.name || 'linked account'}${several && row.key === def ? ' (default)' : ''}`);
    const h = health[row.key];
    if (h != null && !h.ok && h.lines.length > 0) out.push(signInField(h.lines));
    const appearsAs = appearsAsField(row);
    if (appearsAs != null) out.push(appearsAs);
    if (isMultiTenant(row)) {
      const here = thisFolder(row, dir, ctx);
      if (here != null) out.push(field('This folder', here));
      out.push(field('Rules', rulesCount(rulesOf(row).length)));
      out.push(field('New folders', newFoldersLabel(row)));
      return;
    }
    if (!isSingleTenant(row)) return;
    const here = hereShown(row) ? thisFolder(row, dir, ctx) : null;
    if (here != null) out.push(field('This folder', here));
    const ruleCount = rulesOf(row).length;
    if (ruleCount > 0) out.push(field('Rules', rulesCount(ruleCount)));
  });
  if (several) out.push('', 'This machine');
  return healed ? out.concat(machine, [healed]) : out.concat(machine);
}

// Known workspace count; 0 when unknown.
function workspaceCount(row) {
  const tenants = tenantsOf(row);
  return tenants == null ? 0 : tenants.length;
}

// The sections that apply here, in menu order.
function menuLabels(rows) {
  const menu = [];
  if (rows.some((a) => workspaceCount(a) >= 1)) menu.push('Rules');
  if (rows.some((a) => isMultiTenant(a))) menu.push('New folders');
  menu.push('Account', 'Crash reports');
  return menu;
}

// One menu option label per `menu=` label, in order, each with its current state when one account decides it.
export function menuLabelLines(view) {
  const { rows, dir, ctx } = view;
  return menuLabels(rows).map((label) => {
    if (label === 'Rules') {
      const ruled = rows.filter((a) => workspaceCount(a) >= 1);
      if (ruled.length !== 1 || !hereShown(ruled[0]) || placeOfDir(dir, ctx) == null) return label;
      return `Rules: here → ${routeTarget(ruled[0], routeOfDir(ruled[0], dir, ctx))}`;
    }
    if (label === 'New folders') {
      const multi = rows.filter((a) => isMultiTenant(a));
      if (multi.length !== 1) return label;
      const nf = newFoldersOf(multi[0]);
      if (nf.mode === 'send') return `New folders: send to ${joinTenantNames(multi[0], nf.tenantIds)}`;
      return nf.mode === 'none' ? 'New folders: don\'t send' : 'New folders: ask me';
    }
    if (label === 'Account') {
      if (rows.length === 0) return label;
      return rows.length === 1 ? `Account: ${rows[0].email || rows[0].name || rows[0].key}` : `Account: ${rows.length} linked`;
    }
    return `Crash reports ${crashMode() === 'off' ? 'off' : 'on'}`;
  });
}

// For the skill's routing only; never shown. The setup wizard parses `keys` too (test/setup-contract.test.mjs).
function keyLines(view) {
  const { rows, def } = view;
  const out = [`menu=${menuLabels(rows).join('|')}`];
  for (const a of rows) {
    out.push(`account=${a.key} default=${a.key === def ? 'yes' : 'no'} multi=${isMultiTenant(a) ? 'yes' : 'no'} workspaces=${workspaceCount(a)} status=${a.status || 'linked'} email=${a.email || 'unknown'}`);
  }
  out.push(`crash=${crashMode()}`);
  return out;
}

export async function keysLines(deps = {}) {
  return keyLines({ rows: await listAccounts(deps), def: await getDefaultKey(deps) });
}

const PLAN_LABELS = {
  free: 'Free', plus: 'Plus', pro_5x: 'Pro 5x', pro_20x: 'Pro 20x', go: 'Go', team: 'Team',
  business: 'Business', enterprise: 'Enterprise', edu: 'Edu',
};

// The source is resolveSource's answer, the one every report carries; the plan is billing.json's.
function chatgptPlan() {
  const config = readBillingConfig();
  const source = resolveSource(config);
  if (source === BillingSource.OPENAI_API_KEY) return 'API key';
  if (source === BillingSource.THIRD_PARTY) return 'Third-party provider';
  const plan = config != null && typeof config.plan === 'string' ? config.plan : '';
  if (plan === '' || plan === 'unknown') return 'not captured yet — refresh it in the settings skill';
  return Object.prototype.hasOwnProperty.call(PLAN_LABELS, plan) ? PLAN_LABELS[plan] : plan;
}

function workspaceList(row) {
  return (tenantsOf(row) || []).map(describeTenant).join(', ');
}

function heading(section, row, several) {
  return several ? `${section} · ${row.email || row.name || row.key}` : section;
}

const NEW_FOLDERS_TEXT = {
  ask: 'Ask me — Beezi asks once per repo or folder, when a session starts there',
  none: 'Don\'t send — nothing from a repo or folder with no rule is sent',
};

function rulesSection(view) {
  if (view.rows.length === 0) return [NOT_LINKED];
  // The live session is still running, so it is left out of the counts, as `workspace.mjs rules --table` leaves it.
  const entries = view.deps.listAllRollouts == null ? null : view.deps.listAllRollouts();
  return rulesTableLines(view.rows, view.dir, view.ctx, { entries, liveSessionId: view.liveSessionId });
}

const CARD_FOOTER = {
  repo: ['The rule follows the repo, so every', 'clone of it stops sending too.'],
  folder: ['The rule covers this folder and', 'everything inside it.'],
  outside: ['The rule covers every session in your', 'home folder, / or a temp folder.'],
};

// The `<here-card>`: where this folder is, where it sends now, and for one workspace what Don't track changes.
export function hereCardLines(row, dir, ctx) {
  if (!hereShown(row)) return null;
  const place = placeOfDir(dir, ctx);
  if (place == null) return null;
  const route = routeOfDir(row, dir, ctx);
  const out = ['● You\'re here', `  ${place.kind === 'outside' ? 'outside a project folder' : `${place.short}, ${kindWords(place)}`}`];
  if (place.path != null) out.push(`  ${place.path}`);
  if (place.remote != null) out.push(`  ${place.remote}`);
  out.push('', `Now     ${routeText(row, route)}`);
  if (isSingleTenant(row) && route.ids.length > 0) out.push('After   → not tracked (new rule)', '', ...CARD_FOOTER[place.kind]);
  return out;
}

function newFoldersSection(view) {
  const rows = view.rows.filter((row) => isMultiTenant(row));
  if (rows.length === 0) return ['New folders applies only to an account in several workspaces.'];
  const out = [];
  rows.forEach((row, i) => {
    if (i > 0) out.push('');
    out.push(heading('New folders', row, rows.length > 1));
    const nf = newFoldersOf(row);
    out.push(field('Setting', nf.mode === 'send' ? `Send to ${names(row, nf.tenantIds)}` : NEW_FOLDERS_TEXT[nf.mode]));
    out.push(field('Workspaces', workspaceList(row)));
    const here = thisFolder(row, view.dir, view.ctx);
    if (here != null) out.push(field('This folder', here));
  });
  return out;
}

function accountSection(view) {
  const { rows, health, def } = view;
  const machine = ['This machine', field('ChatGPT plan', chatgptPlan())];
  if (rows.length === 0) return [NOT_LINKED, ''].concat(machine);
  const several = rows.length > 1;
  const out = [];
  rows.forEach((row) => {
    out.push(`Account · ${row.email || row.name || row.key}${several && row.key === def ? ' (default)' : ''}`);
    const h = health[row.key];
    if (h != null && !h.ok && h.lines.length > 0) out.push(signInField(h.lines));
    else out.push(field('Sign-in', 'OK'));
    const tenants = tenantsOf(row) || [];
    if (tenants.length > 0) out.push(field(tenants.length > 1 ? 'Workspaces' : 'Workspace', workspaceList(row)));
    const appearsAs = appearsAsField(row);
    if (appearsAs != null) out.push(appearsAs);
    if (several) out.push(field('Analytics reads', row.key === def ? 'yes (default account)' : 'no'));
    out.push('');
  });
  return out.concat(machine);
}

function crashText(mode) {
  if (mode === 'correlate') return 'On, with an installation ID so support can find your reports';
  if (mode === 'on') return 'On, without an installation ID (that choice stays open)';
  if (mode === 'anonymous') return 'Anonymous, without an installation ID (never offered again)';
  return 'Off';
}

function privacySection() {
  return [field('Crash reports', crashText(crashMode()))];
}

function allSections(view) {
  const parts = [
    ['Rules', rulesSection(view)],
    ['New folders', newFoldersSection(view)],
    ['Account', accountSection(view)],
    ['Crash reports', privacySection()],
  ];
  const out = [];
  parts.forEach(([title, lines], i) => {
    if (i > 0) out.push('');
    out.push(`## ${title}`, '');
    // The heading already names the section.
    out.push(...(lines[0] === title ? lines.slice(1) : lines));
  });
  return out;
}

function block(tag, lines) {
  return [`<${tag}>`].concat(lines, [`</${tag.split(' ')[0]}>`]);
}

// A workspace.mjs listing run in-process; a failure's ✗ line stays inside the block for the skill to show.
async function listingBlock(tag, argv, deps) {
  const result = await workspaceCommand(argv, deps);
  return block(tag, result.ok ? result.lines : result.lines.concat(result.stderr.map((l) => l.trim())));
}

// The skill's one read call per view: what to show, the routing keys, and every listing the next question needs.
// listings: 'rules' and/or 'new-folders' blocks per account; labels: the menu's option labels; hereCards: one card per Rules account.
const VIEWS = {
  menu: { show: screen, health: true, listings: ['rules', 'new-folders'], labels: true, hereCards: true },
  rules: { show: rulesSection, health: false, listings: ['rules'], hereCards: true },
  'new-folders': { show: newFoldersSection, health: false, listings: ['new-folders'] },
  account: { show: accountSection, health: true, listings: [] },
  privacy: { show: privacySection, health: false, listings: [] },
  all: { show: allSections, health: true, listings: [] },
};

async function viewLines(spec, deps) {
  const view = await loadView(spec.health, deps);
  let out = block('show', spec.show(view)).concat(block('keys', keyLines(view)));
  if (spec.labels) out = out.concat(block('labels', menuLabelLines(view)));
  const ruled = view.rows.filter((r) => workspaceCount(r) >= 1);
  if (spec.listings.indexOf('rules') !== -1) {
    for (const row of ruled) out = out.concat(await listingBlock(`rules account="${row.key}"`, ['rules', '--account', row.key], deps));
  }
  if (spec.hereCards) {
    for (const row of ruled) {
      const card = hereCardLines(row, view.dir, view.ctx);
      if (card != null) out = out.concat(block(`here-card account="${row.key}"`, card));
    }
  }
  if (spec.listings.indexOf('new-folders') !== -1) {
    for (const row of view.rows.filter((r) => isMultiTenant(r))) {
      out = out.concat(await listingBlock(`new-folders account="${row.key}"`, ['new-folders', '--account', row.key], deps));
    }
  }
  return out;
}

// `cmd` is the script's first argument; none is the menu. `keys` alone prints bare lines, as the setup wizard parses them.
export async function settingsLines(cmd, deps = {}) {
  if (cmd === 'keys') return keysLines(deps);
  const view = cmd == null ? 'menu' : cmd;
  if (!Object.prototype.hasOwnProperty.call(VIEWS, view)) throw new UserError(USAGE);
  return viewLines(VIEWS[view], deps);
}
