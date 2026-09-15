import {
  getCredentials as _getCredentials,
  setCredentials as _setCredentials,
  deleteCredentials as _deleteCredentials,
  credentialRevision,
} from './credentials.mjs';
import { refreshTokens as _refreshTokens } from './oauth.mjs';
import { setMachineClientId } from './machine-identity.mjs';
import { recordIssue as _recordIssue, DIAGNOSTIC_CODES } from './diagnostics.mjs';
import { acquireLock, sharedLock } from './single-instance-lock.mjs';
import { orDefault } from './compat.mjs';
import { checkEnvironment, shouldCheckEnvironment } from './env-guard.mjs';

const SKEW_MS = 60_000;
const DEFAULT_EXPIRES_IN_S = 3_600;
const result = (state, reason, accessToken = null) => ({ state, reason, accessToken });
const ready = (creds) => {
  setMachineClientId(creds.client_id);
  return result('ready', null, creds.access_token);
};

// Preserve the reason a token is unavailable for status/login callers. Analytics callers can
// continue using getAccessToken, which projects this result onto token-or-null.
export async function getAuthentication(deps = {}, options = {}) {
  if (shouldCheckEnvironment(deps, 'getCredentials', 'checkEnvironment')) {
    const guard = (deps.checkEnvironment || checkEnvironment)();
    if (guard.status !== 'ok' && guard.status !== 'migrated') return result('unavailable', 'environment-blocked');
  }
  const getCreds = orDefault(deps.getCredentials, _getCredentials);
  const setCreds = orDefault(deps.setCredentials, _setCredentials);
  const deleteCreds = orDefault(deps.deleteCredentials, _deleteCredentials);
  const refresh = orDefault(deps.refreshTokens, _refreshTokens);
  const now = orDefault(deps.now, Date.now);
  const sleep = orDefault(deps.sleep, ms => new Promise(r => setTimeout(r, ms)));
  const recordIssue = orDefault(deps.recordIssue, _recordIssue);
  const fresh = c => c && orDefault(c.expires_at, 0) - now() > SKEW_MS;
  let creds;
  try { creds = await getCreds(deps); } catch { return result('unavailable', 'credential-store'); }
  if (!creds) return result('unlinked', 'no-credentials');
  if (!options.forceRefresh && fresh(creds)) return ready(creds);

  const before = creds;
  const acquired = acquireLock(sharedLock('token-refresh'), { leaseMs: 30_000 });
  if (!acquired.ok) {
    await sleep(750);
    try { creds = await getCreds(deps); } catch { return result('unavailable', 'credential-store'); }
    if (fresh(creds) && (!options.forceRefresh || creds.access_token !== before.access_token)) return ready(creds);
    return result('refreshing', 'refresh-in-progress');
  }
  try {
    // The pre-lock snapshot may already have been rotated by a different hook.
    creds = await getCreds(deps);
    if (!creds) return result('unlinked', 'no-credentials');
    if (fresh(creds) && (!options.forceRefresh || creds.access_token !== before.access_token)) return ready(creds);
    const expectedRevision = credentialRevision(creds);
    const r = await refresh({ tokenEndpoint: creds.token_endpoint,
      clientId: creds.client_id, refreshToken: creds.refresh_token }, deps);
    if (!acquired.handle.verify().ok) return result('unavailable', 'refresh-lock-lost');
    if (r.invalidGrant) {
      await deleteCreds(deps, { expectedRevision });
      return result('reauth_required', 'invalid-grant');
    }
    if (!r.tokens || !r.tokens.access_token) {
      recordIssue({ code: DIAGNOSTIC_CODES.TOKEN_REFRESH_FAILED });
      return result('unavailable', 'refresh-failed');
    }
    const next = { ...creds, access_token: r.tokens.access_token,
      refresh_token: orDefault(r.tokens.refresh_token, creds.refresh_token),
      expires_at: now() + orDefault(r.tokens.expires_in, DEFAULT_EXPIRES_IN_S) * 1000 };
    // Login/logout share the commit lock and change the revision. A delayed response must
    // never replace a later login or recreate a deleted credential set.
    await setCreds(next, deps, { expectedRevision });
    return ready(next);
  } catch (error) {
    if (error && error.code === 'CREDENTIALS_SUPERSEDED') {
      try {
        const current = await getCreds(deps);
        if (fresh(current)) return ready(current);
        if (!current) return result('unlinked', 'no-credentials');
      } catch { /* temporary storage failure */ }
    }
    return result('unavailable', 'credential-or-refresh-failure');
  } finally {
    acquired.handle.release();
  }
}

export async function getAccessToken(deps = {}, options = {}) {
  return (await getAuthentication(deps, options)).accessToken;
}
