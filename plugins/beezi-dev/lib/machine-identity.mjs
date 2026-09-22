import os from 'os';
import { AGENT } from './config.mjs';

// No module-level client id. With several accounts linked, a process-global would attach one
// account's X-Beezi-Client to another account's bearer, and the server would bind the wrong
// machine row. Callers pass the id that belongs to the session they are posting with — it travels
// with the token, through lib/http.mjs's session object, never through this module.
//
// Identifying headers for the portal's linked-machines view (display/bookkeeping only — auth stays
// the bearer token). X-Beezi-Agent tells the server this is the Codex client so it can attribute
// the machine and its analytics distinctly from Claude Code.
export function machineHeaders(clientId) {
  const headers = {
    'X-Beezi-Host': String(os.hostname()).slice(0, 255),
    'X-Beezi-Agent': AGENT,
  };
  // Truthiness, not a null check: an empty-string client id names no machine, and sending it
  // would bind a row the portal cannot match back to anything.
  if (clientId) headers['X-Beezi-Client'] = clientId;
  return headers;
}
