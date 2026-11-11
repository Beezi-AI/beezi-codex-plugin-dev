// One POST to /sessions/report-batch, its answer read into a verdict. The queue drain's batch path
// (lib/queue-flush.mjs) is its caller.
//
// postReportBatch(reports, session, opts) -> one of
//   { kind: 'results', results: [{ segmentId, status, code }] }  per report, in sent order
//   { kind: 'fallback' }           an answer this plugin does not understand: use the single route
//   { kind: 'unauthorized' }       401: the caller renews the token and may call again
//   { kind: 'tracking-disabled' }  403 TRACKING_DISABLED, with the server's code and message
//   { kind: 'server-error' }       5xx, or a 403 without that code (seat revoked: reversible)
//   { kind: 'throttled' }          408/409/423/425/429 (RETRY_LATER_STATUSES): no report judged
//   { kind: 'too-large' }          413: smaller batches
//   { kind: 'network' }            the request threw (offline, timeout), or timeoutMs ran out before
//                                  the plain resend of a refused gzip body
// Every HTTP-answered verdict also carries `status`; `gzipRefused: true` marks one that came from the
// plain resend of a refused gzip body, so a caller can stop compressing. The whole call, resend
// included, stays inside opts.timeoutMs (opts.now is the clock, Date.now by default).
//
// A results verdict deletes queue files, so only an answer read in full counts: a 2xx, JSON, and a
// `results` array with exactly one known status per report sent, none echoing another report's
// segmentId. Anything else 2xx is a fallback.
// This module renews nothing and reads no credential: the session is the caller's.
import { postJson, sessionOf, POST_TIMEOUT_MS } from './http.mjs';
import { apiBase, ENDPOINTS } from './config.mjs';

// Bound on reading a body once the headers are in: the fetch shim's text() has no timer of its own.
const READ_MS = 2000;
const STATUSES = ['stored', 'rejected', 'retry'];

// Statuses that are the server (or a proxy) saying "not now", never a verdict on the payload: no
// report is judged and every one is kept for a retry. 429 above all — deleting a report because the
// API was busy is data loss. The single route (lib/queue-flush.mjs) keeps on the same list.
export const RETRY_LATER_STATUSES = [408, 409, 423, 425, 429];

// The body as text, bounded in time. Null on any failure; never throws. Reads (and so drains) it.
async function readBounded(res, readMs) {
  if (res == null || typeof res.text !== 'function') return null;
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(() => res.text()).catch(() => null),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), readMs); }),
    ]);
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}

async function readBoundedJson(res, readMs) {
  const raw = await readBounded(res, readMs);
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// [{ segmentId, status, code }] or null unless `body.results` has one item per report with a known
// status. An item echoing a segmentId other than its report's is a misaligned answer: acting on it
// by position would delete the wrong files, so the whole answer is not understood. An item with no
// segmentId is matched by position.
function resultsOf(body, reports) {
  if (body == null || !Array.isArray(body.results) || body.results.length !== reports.length) return null;
  const items = [];
  for (let i = 0; i < body.results.length; i += 1) {
    const item = body.results[i];
    if (item == null || STATUSES.indexOf(item.status) === -1) return null;
    const sent = reports[i] == null ? null : reports[i].segmentId;
    if (typeof item.segmentId === 'string' && item.segmentId !== sent) return null;
    items.push({
      segmentId: typeof item.segmentId === 'string' ? item.segmentId : null,
      status: item.status,
      code: typeof item.code === 'string' ? item.code : null,
    });
  }
  return items;
}

function stringOrNull(value) {
  return typeof value === 'string' ? value : null;
}

export async function postReportBatch(reports, session, opts = {}) {
  // Before any try: a bare token is a caller bug, not a network failure.
  sessionOf(session);
  if (reports.length === 0) return { kind: 'results', results: [] };
  const url = opts.url != null ? opts.url : `${apiBase()}${ENDPOINTS.sessionsReportBatch}`;
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : POST_TIMEOUT_MS;
  const readMs = opts.readMs != null ? opts.readMs : READ_MS;
  const now = opts.now != null ? opts.now : Date.now;
  const startedAt = now();
  const body = { reports };
  let gzip = opts.gzip !== false;
  let gzipRefused = false;

  const verdict = (fields) => (gzipRefused ? { ...fields, gzipRefused: true } : fields);

  for (;;) {
    // The first attempt gets timeoutMs; a resend gets only what is left of it.
    const leftMs = timeoutMs - (now() - startedAt);
    if (leftMs < 1) return verdict({ kind: 'network' });
    let res;
    try {
      res = await postJson(url, session, body, { fetchImpl: opts.fetchImpl, gzip, timeoutMs: leftMs });
    } catch {
      // Never resent plain: offline, that would only spend a second timeout.
      return verdict({ kind: 'network' });
    }
    const status = res.status;
    if (status >= 200 && status < 300) {
      const results = resultsOf(await readBoundedJson(res, readMs), reports);
      return results == null ? verdict({ kind: 'fallback', status }) : verdict({ kind: 'results', results });
    }
    if (status === 403) {
      const parsed = await readBoundedJson(res, readMs);
      const code = parsed == null ? null : stringOrNull(parsed.code);
      const message = parsed == null ? null : stringOrNull(parsed.message);
      return verdict({ kind: code === 'TRACKING_DISABLED' ? 'tracking-disabled' : 'server-error', status, code, message });
    }
    // Drained on every other path, so the connection is released.
    await readBounded(res, readMs);
    if (RETRY_LATER_STATUSES.indexOf(status) !== -1) return verdict({ kind: 'throttled', status });
    if (status === 401) return verdict({ kind: 'unauthorized', status });
    if (status === 413) return verdict({ kind: 'too-large', status });
    // A proxy may refuse a compressed body: resend plain once.
    if (gzip && (status === 400 || status === 415)) {
      gzip = false;
      gzipRefused = true;
      continue;
    }
    if (status >= 500) return verdict({ kind: 'server-error', status });
    // 404/405 (a server without the route), a plain 400/415, any other non-2xx: not understood.
    return verdict({ kind: 'fallback', status });
  }
}
