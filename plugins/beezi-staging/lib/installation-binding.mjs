import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson, POST_TIMEOUT_MS } from './http.mjs';
import { getDefaultKey as _getDefaultKey } from './accounts.mjs';
import {
  recordIssue as _recordIssue,
  DIAGNOSTIC_CODES,
  AUTH_REASONS,
  CORRELATION_CONSENT_VERSION,
  diagnosticsSession,
  isCorrelationGranted,
} from './diagnostics.mjs';
import { ensureInstallationId, markBound, needsBinding, rotateInstallationId } from './installation-id.mjs';

// The one authenticated half of the diagnostics path: associates this machine's random
// installation ID with the caller's account. Only ever called with a session that authenticated
// activity already holds — it never asks for a token, and never refreshes one. postJson's machine
// headers carry X-Beezi-Agent, which is how the portal records the binding as tool=codex.
//
// Nothing here is retried in-band: a failure leaves boundAt null, so the next authenticated
// activity tries again, and until then events stay anonymous.
//
// The diagnostics events carry no explicit source: binding runs on whichever entry point called
// it, and recordIssue inherits that.
export async function bindInstallationIfNeeded(session, deps = {}) {
  const postJsonImpl = deps.postJsonImpl == null ? postJson : deps.postJsonImpl;
  const recordIssue = deps.recordIssue == null ? _recordIssue : deps.recordIssue;
  const now = (deps.now == null ? () => Date.now() : deps.now)();
  if (!session || !session.token || !needsBinding(now)) return { status: 'skipped' };

  const installationId = ensureInstallationId(now);
  if (installationId == null) return { status: 'skipped' };

  let status;
  try {
    // Exactly the two keys the route accepts; user and tenant come from the verified principal
    // and any extra key is a 400.
    const res = await postJsonImpl(
      `${apiBase()}${ENDPOINTS.pluginDiagnosticsInstallation}`,
      session,
      { installationId, consentVersion: CORRELATION_CONSENT_VERSION },
      { fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs },
    );
    status = res == null ? 0 : res.status;
  } catch {
    recordIssue({
      code: DIAGNOSTIC_CODES.INSTALLATION_BINDING_FAILED,
      reason: AUTH_REASONS.PROBE_UNREACHABLE,
    });
    return { status: 'failed' };
  }

  if (status >= 200 && status < 300) {
    markBound(now, installationId);
    return { status: 'bound' };
  }

  if (status === 409) {
    // A binding is never reassigned, so the ID belongs to someone else now. Discard it and let
    // the next authenticated activity mint and bind a fresh one.
    rotateInstallationId();
    recordIssue({
      code: DIAGNOSTIC_CODES.INSTALLATION_BINDING_FAILED,
      reason: AUTH_REASONS.BINDING_CONFLICT,
      httpStatus: 409,
    });
    return { status: 'conflict' };
  }

  recordIssue({
    code: DIAGNOSTIC_CODES.INSTALLATION_BINDING_FAILED,
    httpStatus: status,
  });
  return { status: 'failed' };
}

/**
 * The binding as a reporting path runs it, once its own sends are done: with correlation granted
 * and time left, bind with the default account's tokened session among `sessions` (else the first
 * tokened one), account-wide even when the session is a workspace clone. The non-local checkpoint
 * (track) and the upload worker's `installation-binding` step both call this, so they pick the
 * same account. `deps.deadline` (epoch ms, null = none) bounds it, and the request timeout is cut
 * to what is left of it; `deps.getDefaultKey` is a test seam. Never throws.
 */
export async function bindInstallationForSessions(sessions, deps = {}) {
  const now = deps.now == null ? Date.now : deps.now;
  const deadline = deps.deadline == null ? null : deps.deadline;
  const timeLeft = () => (deadline === null ? null : deadline - now());
  try {
    if (!isCorrelationGranted() || (deadline !== null && timeLeft() <= 0)) return { status: 'skipped' };
    const defaultKey = await (deps.getDefaultKey == null ? _getDefaultKey : deps.getDefaultKey)(deps);
    if (deadline !== null && timeLeft() <= 0) return { status: 'skipped' };
    const timeoutMs = deadline === null ? POST_TIMEOUT_MS : Math.max(1, Math.min(POST_TIMEOUT_MS, timeLeft()));
    const tokened = (Array.isArray(sessions) ? sessions : []).filter((session) => session && session.token);
    const diagnostic = diagnosticsSession(tokened, defaultKey);
    return await bindInstallationIfNeeded(diagnostic && { ...diagnostic, tenantId: null }, { ...deps, timeoutMs });
  } catch {
    return { status: 'failed' };
  }
}
