import path from 'path';
import url from 'url';
import {
  describeTenant,
  isMultiTenant,
  readSessionWorkspace,
  resolveTargets,
  roleLabel,
  tenantById,
} from './workspace.mjs';
import { bindSessionRoutes, createRouteContext, routeKeyForDir, shortLabel } from './workspace-rules.mjs';

// Only a new session or a clear asks; resume and compact never do.
const ASK_SOURCES = ['startup', 'clear'];
// request_user_input is single-choice with a forced "Other", 2-3 options and at most 3 questions; past these caps the ask is a plain sentence.
const TOOL_MAX_WORKSPACES = 2;
const TOOL_MAX_QUESTIONS = 3;
// request_user_input headers are at most 12 characters.
const TOOL_HEADER = 'Beezi';

// Resolved from this module, not cwd: hooks run with the user's repository as their working directory.
export function pluginRoot(deps = {}) {
  const root = deps.pluginRoot != null
    ? deps.pluginRoot
    : path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
  return root.replace(/\\/g, '/');
}

async function linkedRows(deps) {
  const accounts = await import('./accounts.mjs');
  const listAccounts = deps.listAccounts == null ? accounts.listAccounts : deps.listAccounts;
  const rows = await listAccounts(deps);
  return rows.filter((a) => a.status === accounts.AccountStatus.LINKED);
}

// Only rows linkedSessions can produce a token for (runSessionStart's "linked" test): one whose credentials are gone is neither asked nor told.
async function withUsableLogin(rows, deps) {
  // No credential read when there is nothing to ask or tell.
  if (rows.length === 0) return rows;
  const accounts = await import('./accounts.mjs');
  const linkedSessions = deps.linkedSessions == null ? accounts.linkedSessions : deps.linkedSessions;
  let live;
  try { live = await linkedSessions(deps); } catch { live = []; }
  const keys = (Array.isArray(live) ? live : []).map((s) => s.key);
  return rows.filter((row) => keys.indexOf(row.key) !== -1);
}

function inputCwd(input) {
  return typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : process.cwd();
}

// A multi-workspace row's tenantName is the web-side workspace, so accounts are named by email.
function emailOf(row) {
  return row.email || row.key;
}

function nameOf(row, id) {
  const t = tenantById(row, id);
  return t != null && t.name ? t.name : id;
}

function names(row, ids) {
  return ids.map((id) => nameOf(row, id)).join(', ');
}

function lowerFirst(text) {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

// The question wording for this directory: a repo, a folder, or the one "outside a project" place.
function placeOf(key) {
  if (key != null && key.kind === 'outside') {
    return {
      question: 'Where should analytics for sessions outside a project folder go?',
      dontTrack: 'Don\'t track these',
      nothing: 'Nothing from sessions outside a project folder is uploaded',
    };
  }
  const short = shortLabel(key);
  // A folder rule covers everything under it, so its question names the whole path and says so.
  const asked = key != null && key.kind === 'folder' ? `${key.label} (and everything inside it)` : short;
  return {
    question: `Where should analytics for ${asked} go?`,
    dontTrack: key != null && key.kind === 'repo' ? 'Don\'t track this repo' : 'Don\'t track this folder',
    nothing: `Nothing from ${short} is uploaded`,
  };
}

function optionText(o) {
  return o.description ? `"${o.label}" (description "${o.description}")` : `"${o.label}"`;
}

function optionList(options) {
  const texts = options.map(optionText);
  return texts.length === 1 ? texts[0] : `${texts.slice(0, -1).join(', ')}, and ${texts[texts.length - 1]}`;
}

// One account's question (tool form and plain-sentence form) and the command its answer runs.
function accountAsk(row, resolved, place, { sessionId, root, several }) {
  const tenants = resolved.tenants.filter((t) => resolved.askTenants.indexOf(t.id) !== -1);
  const label = (t) => (t.name ? t.name : t.id);
  const suffix = several ? ` (${emailOf(row)})` : '';
  // The plain sentence drops the question mark so the choices can follow a colon.
  const stem = place.question.slice(0, -1);
  return {
    row,
    id: `beezi_workspace_${row.key}`,
    question: `${place.question}${suffix} Pick one, or name several under Other.`,
    options: tenants.map((t) => ({ label: label(t), description: roleLabel(t) }))
      .concat([{ label: place.dontTrack, description: place.nothing }]),
    sentence: `${stem}${suffix}: ${tenants.map((t) => describeTenant(t)).join(', ')} — one or more — or ${lowerFirst(place.dontTrack)}?`,
    fitsTool: tenants.length <= TOOL_MAX_WORKSPACES,
    command: `node "${root}/scripts/workspace.mjs" rule add --current --session ${sessionId} --account ${row.key} <ids>`,
    ids: tenants.map((t) => `${label(t)} = ${t.id}`).join(', '),
    dontTrack: place.dontTrack,
  };
}

// The tool is offered only when every account's question fits it; otherwise every question is a plain sentence.
function promptText(asks) {
  const one = asks.length === 1;
  const parts = ['Beezi is holding this session\'s analytics until the user says where they go.'];
  const toolable = asks.length <= TOOL_MAX_QUESTIONS && asks.every((a) => a.fitsTool);
  if (toolable) {
    const asked = one
      ? `one question, id "${asks[0].id}", header "${TOOL_HEADER}": "${asks[0].question}" with the options ${optionList(asks[0].options)}`
      : `${asks.length} questions in one call, each with header "${TOOL_HEADER}": ${asks.map((a, i) => `question ${i + 1}, id "${a.id}": "${a.question}" with the options ${optionList(a.options)}`).join('; ')}`;
    parts.push(`If a request_user_input tool is available this turn, use it before anything else to ask ${asked}. Use these labels exactly and mark none as recommended. ${one ? 'It allows' : 'Each allows'} one choice; the user can name several workspaces through "Other". Then continue with the user's request.`);
  }
  const sentences = asks.map((a) => `"${a.sentence}"`).join(' ');
  parts.push(`${toolable ? 'Otherwise, do' : 'Do'} the user's request first and end your reply with ${one ? 'this one plain sentence' : 'these plain sentences, one per account'}, with no numbered list or bullet menu: ${sentences}`);
  asks.forEach((a, i) => {
    const lead = one
      ? 'When the answer arrives, run exactly'
      : `${i === 0 ? 'When the answers arrive, for' : 'For'} ${emailOf(a.row)} run exactly`;
    const idsOf = one
      ? 'the chosen workspaces\' ids joined by commas'
      : `the ids of the workspaces chosen for ${emailOf(a.row)} joined by commas`;
    parts.push(`${lead} \`${a.command}\`. \`<ids>\` is ${idsOf} (${a.ids}), or \`none\` when "${a.dontTrack}" is chosen; it wins over the others.`);
  });
  // A hook message carries none of a skill's framing, so the sandbox escalation is spelled out here.
  parts.push(`${one ? 'The command writes' : 'Each command writes'} Beezi's settings under the user's home, outside the workspace: if the sandbox refuses it, run it again with escalated permissions so the user can approve it.`);
  parts.push(one
    ? 'Show the user only the command\'s first line. If the user ignores or declines the question, run nothing and never ask it again in this session.'
    : 'Show the user only the first line of each command\'s output. If the user ignores or declines a question, run nothing for that account and never ask it again in this session.');
  return parts.join(' ');
}

// Binds each multi-workspace account's rule for this directory (null unbinds); the pending rows, or null when none.
export async function markPendingWorkspace(input, deps = {}) {
  if (input == null || typeof input.session_id !== 'string' || input.session_id === '') return null;
  const sessionId = input.session_id;
  const cwd = inputCwd(input);
  const rows = await linkedRows(deps);
  const multi = rows.filter(isMultiTenant);
  if (multi.length === 0) return null;
  const ctx = createRouteContext();
  // Re-matched on every start, resume and compact: a rule added since binds, a removed one unbinds.
  // Written even when nothing is pending: it keeps this the newest session in its directory for the cwd fallback.
  const state = bindSessionRoutes(sessionId, cwd, multi, ctx);
  if (state == null) return null;
  const pending = multi
    .map((row) => ({ row, resolved: resolveTargets(row, state) }))
    .filter((r) => r.resolved.pendingAsk);
  return pending.length === 0 ? null : { pending, cwd, ctx, several: rows.length > 1 };
}

// SessionStart: re-binds on every source; the ask text on startup, clear or no source, or null when nothing is pending.
// `earlier` is this start's first markPendingWorkspace answer: a refused re-bind (a stale workspace lock) asks from it instead.
export async function buildWorkspacePrompt(input, deps = {}, earlier = null) {
  if (input == null || typeof input.session_id !== 'string' || input.session_id === '') return null;
  let marked;
  try {
    marked = await markPendingWorkspace(input, deps);
  } catch (error) {
    if (earlier == null) throw error;
    marked = earlier;
  }
  if (marked == null) return null;
  if (input.source != null && ASK_SOURCES.indexOf(input.source) === -1) return null;
  const usable = await withUsableLogin(marked.pending.map((p) => p.row), deps);
  const pending = marked.pending.filter((p) => usable.indexOf(p.row) !== -1);
  if (pending.length === 0) return null;
  const place = placeOf(routeKeyForDir(marked.cwd, marked.ctx));
  const root = pluginRoot(deps);
  const asks = pending.map(({ row, resolved }) => accountAsk(row, resolved, place, {
    sessionId: input.session_id, root, several: marked.several,
  }));
  return promptText(asks);
}

// SessionStart: one line per multi-workspace account that is not waiting for an answer, or null.
export async function buildTargetsNotice(input, deps = {}) {
  if (input == null || typeof input.session_id !== 'string' || input.session_id === '') return null;
  const rows = await linkedRows(deps);
  const state = readSessionWorkspace(input.session_id);
  const shown = await withUsableLogin(rows.filter(isMultiTenant), deps);
  const ctx = createRouteContext();
  let here = null;
  const place = () => {
    if (here == null) here = shortLabel(routeKeyForDir(state != null && state.cwd != null ? state.cwd : inputCwd(input), ctx));
    return here;
  };
  const lines = shown
    .map((row) => ({ row, resolved: resolveTargets(row, state) }))
    .filter((r) => r.resolved.multi && !r.resolved.pendingAsk)
    .map(({ row, resolved }) => {
      const prefix = rows.length > 1 ? `Beezi (${emailOf(row)})` : 'Beezi';
      const where = resolved.rule != null ? shortLabel(resolved.rule) : place();
      const at = where ? ` · ${where}` : '';
      let text;
      if (resolved.source === 'rule') {
        text = resolved.targets.length > 0 ? `${names(row, resolved.targets)}${at}` : `not tracked${at}`;
      } else if (resolved.source === 'new-folders') {
        text = `${names(row, resolved.targets)}${at} (new folder default)`;
      } else {
        text = `not uploaded${at} (new folders: don't send)`;
      }
      return `${prefix} → ${text}`;
    });
  return lines.length === 0 ? null : lines.join('\n');
}
