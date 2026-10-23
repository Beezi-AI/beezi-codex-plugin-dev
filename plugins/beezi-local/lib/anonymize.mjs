import crypto from 'crypto';
import { sanitizeRemote, canonicalRemote } from './git.mjs';

export const PRIVATE_MARK = 'beeziPrivate';
export const Kind = Object.freeze({ REPOS: 'repos', BRANCHES: 'branches', SESSIONS: 'sessions', HOSTS: 'hosts', ACCOUNTS: 'accounts' });
export const KINDS = Object.freeze(Object.values(Kind));

const ANON_VALUE_RE = /^anon:(repo|folder|branch|host|account|session):[0-9a-f]{32}$/;
const LOCAL_RE = /^local:/i;
const LOCAL_PREFIX_LENGTH = 'local:'.length;
const PASS_THROUGH_REMOTES = ['local:copilot-chats', 'local:unknown', 'local:'];
const PASS_THROUGH_BRANCHES = ['(unknown)', 'HEAD', ''];
const HEX_LENGTH = 32;

export function isAnonValue(v) {
  return typeof v === 'string' && ANON_VALUE_RE.test(v);
}

export function anonValue(keyHex, kind, input) {
  const hex = crypto
    .createHmac('sha256', Buffer.from(keyHex, 'hex'))
    .update(`${kind}\0${input}`, 'utf8')
    .digest('hex')
    .slice(0, HEX_LENGTH);
  return `anon:${kind}:${hex}`;
}

// The repo identity a remote hashes from: the anon value itself, `local:<name>`, the canonical address, or ''.
function remoteScope(remote) {
  const value = typeof remote === 'string' ? remote.trim() : '';
  if (value === '' || isAnonValue(value)) return value;
  const clean = sanitizeRemote(value);
  return LOCAL_RE.test(clean) ? clean : canonicalRemote(clean);
}

function isUnhashedScope(scope) {
  return scope === '' || isAnonValue(scope) || PASS_THROUGH_REMOTES.includes(scope);
}

function anonScope(keyHex, scope) {
  if (LOCAL_RE.test(scope)) return anonValue(keyHex, 'folder', scope.slice(LOCAL_PREFIX_LENGTH));
  return anonValue(keyHex, 'repo', scope);
}

export function anonRemote(keyHex, remote) {
  const scope = remoteScope(remote);
  return isUnhashedScope(scope) ? remote : anonScope(keyHex, scope);
}

function branchScope(keyHex, remote) {
  const scope = remoteScope(remote);
  return isUnhashedScope(scope) ? scope : anonScope(keyHex, scope);
}

export function anonBranch(keyHex, remote, branch) {
  if (typeof branch !== 'string' || isAnonValue(branch) || PASS_THROUGH_BRANCHES.includes(branch)) return branch;
  return anonValue(keyHex, 'branch', `${branchScope(keyHex, remote)}\0${branch}`);
}

function anonLowercased(keyHex, kind, value) {
  if (typeof value !== 'string' || isAnonValue(value)) return value;
  return anonValue(keyHex, kind, value.toLowerCase().trim());
}

export function anonHost(keyHex, hostname) {
  return anonLowercased(keyHex, 'host', hostname);
}

export function anonAccount(keyHex, value) {
  return anonLowercased(keyHex, 'account', value);
}

export function anonSession(keyHex, sessionId) {
  if (typeof sessionId !== 'string' || isAnonValue(sessionId)) return sessionId;
  return anonValue(keyHex, 'session', sessionId);
}

function withAnonAccount(body, field, keyHex, kinds) {
  const out = { ...body };
  if (kinds.includes(Kind.ACCOUNTS) && out[field] != null) out[field] = anonAccount(keyHex, out[field]);
  return out;
}

export function anonymizeReport(payload, keyHex, kinds) {
  const { [PRIVATE_MARK]: marker, ...rest } = payload;
  const out = withAnonAccount(rest, 'account_email', keyHex, kinds);
  if (kinds.includes(Kind.REPOS)) out.remote = anonRemote(keyHex, rest.remote);
  if (kinds.includes(Kind.BRANCHES)) out.branch = anonBranch(keyHex, rest.remote, rest.branch);
  if (kinds.includes(Kind.SESSIONS)) {
    delete out.agent_name;
    if (out.session_name != null) out.session_name = anonSession(keyHex, rest.sessionId);
  }
  return out;
}

export function anonymizeUsage(body, keyHex, kinds) {
  return withAnonAccount(body, 'account_email', keyHex, kinds);
}

export function anonymizeAccountSync(body, keyHex, kinds) {
  return withAnonAccount(body, 'email', keyHex, kinds);
}

export function scrubSessionError(body) {
  const { errorDetails, lastAssistantMessage, ...rest } = body;
  return rest;
}
