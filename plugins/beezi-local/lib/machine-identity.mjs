import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { AGENT } from './config.mjs';
import { readJson } from './fs-store.mjs';
import { hasKind, sessionAnonymization } from './anonymization.mjs';
import { Kind, anonHost } from './anonymize.mjs';

const MAX_HOST_LENGTH = 255;

const PLUGIN_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const MANIFEST_PATH = path.join(PLUGIN_ROOT, '.codex-plugin', 'plugin.json');

let cachedVersion;

// Read the installed manifest, which includes dev/staging build suffixes, once per process.
// package.json only carries the base version.
function pluginVersion() {
  if (cachedVersion !== undefined) return cachedVersion;
  const manifest = readJson(MANIFEST_PATH, null);
  const version = manifest == null || typeof manifest.version !== 'string' ? null : manifest.version;
  cachedVersion = version ? version.slice(0, 255) : null;
  return cachedVersion;
}

// No module-level client id. With several accounts linked, a process-global would attach one
// account's X-Beezi-Client to another account's bearer, and the server would bind the wrong
// machine row. Callers pass the id that belongs to the session they are posting with — it travels
// with the token, through lib/http.mjs's session object, never through this module.
//
// Identifying headers for the portal's linked-machines view (display/bookkeeping only — auth stays
// the bearer token). X-Beezi-Agent tells the server this is the Codex client so it can attribute
// the machine and its analytics distinctly from Claude Code. X-Beezi-Plugin-Version is stored
// on the machine row; absent when the manifest cannot be read. `session` picks the X-Beezi-Host
// value. x-beezi-history-consent tells the portal this plugin asks before uploading past sessions.
export function machineHeaders(clientId, session) {
  const headers = {};
  const host = hostHeaderFor(session);
  if (host !== null) headers['X-Beezi-Host'] = host;
  headers['X-Beezi-Agent'] = AGENT;
  headers['x-beezi-history-consent'] = 'ask-first';
  // Truthiness, not a null check: an empty-string client id names no machine, and sending it
  // would bind a row the portal cannot match back to anything.
  if (clientId) headers['X-Beezi-Client'] = clientId;
  const version = pluginVersion();
  if (version) headers['X-Beezi-Plugin-Version'] = version;
  return headers;
}

// The block `session` answers to, resolved by the same tenantId test authHeaders applies to X-Beezi-Tenant.
// With hosts on: anon:host with a key, null (no header) without one. Otherwise, or with no block yet, the hostname.
function hostHeaderFor(session) {
  const hostname = String(os.hostname());
  const block = sessionAnonymization(session);
  if (!hasKind(block, Kind.HOSTS)) return hostname.slice(0, MAX_HOST_LENGTH);
  return block.key ? anonHost(block.key, hostname).slice(0, MAX_HOST_LENGTH) : null;
}
