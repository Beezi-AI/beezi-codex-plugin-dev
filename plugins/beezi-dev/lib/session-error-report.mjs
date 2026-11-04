import { fetchCompat } from './fetch-compat.mjs';
import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson } from './http.mjs';
import { recordIssue, DIAGNOSTIC_CODES, DIAGNOSTIC_SOURCES } from './diagnostics.mjs';
import { hasKind, sessionAnonymization } from './anonymization.mjs';
import { Kind, scrubSessionError } from './anonymize.mjs';

// POST one session-error record to Beezi. Fire-and-forget by convention; callers
// swallow the result. Returns { reported, status? , reason? }.
//
// A failure here is invisible by design — the caller drops the result — so it is also recorded as a
// diagnostic. What travels is the HTTP status and the error's class/errno, never the payload: the
// payload carries `lastAssistantMessage`, which is model output, and none of it may reach a
// diagnostic. See lib/diagnostics.mjs — consent-gated, default off.
// K7 tells the developer error messages go up as at most 1,000 characters; capped here, the one sender, for every path.
const ERROR_TEXT_MAX = 1000;
const ERROR_TEXT_FIELDS = ['errorDetails', 'lastAssistantMessage'];

function capErrorText(payload) {
  const out = { ...payload };
  for (const field of ERROR_TEXT_FIELDS) {
    if (typeof out[field] === 'string' && out[field].length > ERROR_TEXT_MAX) out[field] = out[field].slice(0, ERROR_TEXT_MAX);
  }
  return out;
}

export async function postSessionError(payload, session, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetchCompat;
  const recordIssueImpl = deps.recordIssue || recordIssue;
  if (!payload || !payload.sessionId || !payload.error) return { reported: false, reason: 'missing-fields' };
  // `session` is { token, clientId }, never a bare token: the client id names the machine row this
  // report belongs to, and with several accounts linked one account's id on another's bearer is a
  // silent misattribution. postJson would throw; answering 'no-token' for an absent one keeps the
  // fire-and-forget contract. A per-workspace clone (tenantId set) reports to that workspace only;
  // the caller fans out and owns any retry bookkeeping.
  if (!session || !session.token) return { reported: false, reason: 'no-token' };
  const body = hasKind(sessionAnonymization(session), Kind.SESSIONS) ? scrubSessionError(payload) : capErrorText(payload);
  try {
    const url = `${apiBase()}${ENDPOINTS.sessionErrors}`;
    // timeoutMs is undefined unless a caller shrinks it to its budget, so postJson keeps its 3s default.
    const options = { fetchImpl, timeoutMs: deps.timeoutMs };
    let res = await postJson(url, session, body, options);
    // Portals deploy independently of the plugin, and one that predates `resetsAt` rejects the
    // unknown key (forbidNonWhitelisted) with a 400. Without this retry the event would park in
    // pendingErrors and be re-sent, and rejected, on every checkpoint.
    if (res.status === 400 && body.resetsAt) {
      const { resetsAt, ...withoutResetsAt } = body;
      res = await postJson(url, session, withoutResetsAt, options);
    }
    const reported = res.status >= 200 && res.status < 300;
    if (!reported) {
      recordIssueImpl({
        code: DIAGNOSTIC_CODES.QUEUE_FLUSH_HTTP_ERROR,
        source: DIAGNOSTIC_SOURCES.REPORT,
        httpStatus: res.status,
      });
    }
    return { reported, status: res.status };
  } catch (error) {
    recordIssueImpl({
      code: DIAGNOSTIC_CODES.QUEUE_FLUSH_HTTP_ERROR,
      source: DIAGNOSTIC_SOURCES.REPORT,
      error,
    });
    return { reported: false, reason: 'network' };
  }
}
