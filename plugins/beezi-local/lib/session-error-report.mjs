import { fetchCompat } from './fetch-compat.mjs';
import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson } from './http.mjs';
import { recordIssue, DIAGNOSTIC_CODES, DIAGNOSTIC_SOURCES } from './diagnostics.mjs';

// POST one session-error record to Beezi. Fire-and-forget by convention; callers
// swallow the result. Returns { reported, status? , reason? }.
//
// A failure here is invisible by design — the caller drops the result — so it is also recorded as a
// diagnostic. What travels is the HTTP status and the error's class/errno, never the payload: the
// payload carries `lastAssistantMessage`, which is model output, and none of it may reach a
// diagnostic. See lib/diagnostics.mjs — consent-gated, default off.
export async function postSessionError(payload, token, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetchCompat;
  const recordIssueImpl = deps.recordIssue || recordIssue;
  if (!payload || !payload.sessionId || !payload.error) return { reported: false, reason: 'missing-fields' };
  if (!token) return { reported: false, reason: 'no-token' };
  try {
    const res = await postJson(`${apiBase()}${ENDPOINTS.sessionErrors}`, token, payload, { fetchImpl });
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
