import fs from 'fs';
import { trackingStateFile } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { orDefault } from './compat.mjs';
import { withLock, sharedLock } from './single-instance-lock.mjs';

const STATE_VERSION = 1;

// How long one tracking.json read-modify-write may hold its lock. The section is a small read, an
// object spread and one atomic write — orders of magnitude under this — so the lease exists to
// bound a crashed holder, not to fit the work.
const TRACKING_LOCK_LEASE_MS = 5_000;

// Mirror of the server's TrackingMode enum — the whoami contract, never string-matched inline.
export const TrackingMode = Object.freeze({
  LIVE: 'live',
  BACKFILL_ONLY: 'backfill_only',
  DISABLED: 'disabled',
});

// Cached tenant tracking state, refreshed from whoami on SessionStart and from any 403
// TRACKING_DISABLED. Lives at the beeziCodexHome() ROOT (beside billing.json) — pruneStale()
// sweeps state/ and queue/ only, and an expiring gate would silently re-enable dark-mode tenants.
//
// The gate is deliberately FAIL-OPEN: a missing/corrupt file or an old server (no trackingMode
// in whoami) means "allow" — the server's TrackingEnabledGuard is the actual boundary, and
// failing closed would dark-mode every fresh install until its first whoami.
export function readTrackingState(deps = {}) {
  const read = orDefault(deps.readJsonImpl, readJson);
  const raw = read(trackingStateFile(), null);
  if (!raw || raw.version !== STATE_VERSION) return null;
  return raw;
}

export function writeTrackingState(state, deps = {}) {
  const write = orDefault(deps.writeJsonImpl, writeJsonSecure);
  // 0600 like every other beeziCodexHome() root file; best-effort — a disk failure must never
  // break a hook.
  try {
    write(trackingStateFile(), { version: STATE_VERSION, ...state });
  } catch { /* best-effort */ }
}

export function isLiveTrackingAllowed(state = readTrackingState()) {
  const mode = orDefault((state || {}).trackingMode, null);
  if (mode === TrackingMode.BACKFILL_ONLY || mode === TrackingMode.DISABLED) return false;
  return true;
}

// Mirrors the server's derivation: every mode except `disabled` is offered the one-time pull
// until it completes — paid tenants included, not just audit ones. A null mode means a
// pre-audit server: it has no backfill routes, so no hint.
export function shouldBackfill(state = readTrackingState()) {
  if (!state) return false;
  if (state.trackingMode == null) return false;
  if (state.backfillCompleted === true) return false;
  return state.trackingMode !== TrackingMode.DISABLED;
}

// The state is machine-global but the server's pull record is per (tenant, user, tool): a
// logout→login into another workspace must not inherit the previous one's flags. The OAuth
// client id changes on every login (dynamic registration), so it is the natural binding key;
// email is the fallback for states recorded before the id was known.
export function matchesIdentity(state, identity) {
  if (!state || !state.identity || !identity) return true;
  return state.identity === identity;
}

// Merge `patch` over the stored state. Every mutator below goes through this: writing a bare
// object instead drops whatever fields the caller did not know about, which is exactly how a
// whoami refresh used to clobber the linkedAt stamp written at login.
//
// ONE rank-3 `shared:tracking` lock around the WHOLE read-modify-write (G-8-3 / R3). The read and
// the write are separately safe — writeJsonSecure is atomic, so a reader never sees a torn file —
// and that is precisely why the hazard is invisible without a lock: two processes that both read
// the same state and then both write it produce two well-formed files, and the second one silently
// erases the first one's field. `markLinked` losing to a concurrent `recordWhoami` is that bug.
// R-numbers cite docs/plans/2026-09-10-sections/REVIEW.md.
//
// Bare READS are deliberately NOT locked. Nothing they could tear, and locking them would nest a
// second rank-3 lock inside this one at flushQueue's `isLiveTrackingAllowed()` — refused as
// 'lock-order', which is a permanent failure, not a busy lock.
//
// Returns the outcome rather than swallowing it: 'held'/'contended' mean another writer has it and
// the next whoami re-writes what we skipped, while 'lock-order' is a bug in the CALLER's
// acquisition sequence that will fail forever and must be visible to whoever wired it.
function patchTrackingState(patch, deps = {}) {
  const run = withLock(
    sharedLock('tracking'),
    { leaseMs: TRACKING_LOCK_LEASE_MS },
    () => writeTrackingState({ ...orDefault(readTrackingState(deps), {}), ...patch }, deps),
  );
  return run.ok
    ? { written: true, skipped: false, reason: null }
    : { written: false, skipped: true, reason: run.reason };
}

// When this machine was linked, as an ISO instant. The audit uses it to skip transcripts that live
// tracking already owns; it used to be approximated by the credentials file's mtime, which is only
// written by the DPAPI/plaintext fallbacks — on any machine with a real credential store (CredMan,
// Keychain, secret-tool) that file never exists and the guard silently never fired.
export function markLinked(deps = {}) {
  return patchTrackingState({ linkedAt: new Date().toISOString() }, deps);
}

// Takes the already-read state so callers that hold one don't re-read the file — and so the audit
// can feed it the same state its other gates key off.
export function linkedAtMs(state) {
  const at = (state || {}).linkedAt;
  if (!at) return null;
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : null;
}

// Persist the whoami verdict. `identity` is the current login's binding key (client id or email).
export function recordWhoami(who, identity, deps = {}) {
  if (!who || who.valid !== true) return { written: false, skipped: false, reason: 'not-valid' };
  return patchTrackingState(
    {
      trackingMode: orDefault(who.trackingMode, null),
      tenantTier: orDefault(who.tenantTier, null),
      backfillCompleted: who.backfillCompleted === true,
      identity: orDefault(identity, null),
      fetchedAt: new Date().toISOString(),
      reason: null,
    },
    deps,
  );
}

// A live endpoint answered 403 TRACKING_DISABLED: the server has spoken — go dark until the
// next whoami says otherwise.
export function markTrackingDisabled(reason, deps = {}) {
  return patchTrackingState(
    {
      trackingMode: TrackingMode.DISABLED,
      fetchedAt: new Date().toISOString(),
      reason: orDefault(reason, null),
    },
    deps,
  );
}

// The pull sealed (locally observed or server-confirmed) — the audit fast path keys off this.
export function markBackfillCompleted(deps = {}) {
  return patchTrackingState({ backfillCompleted: true, fetchedAt: new Date().toISOString() }, deps);
}

export function clearTrackingState() {
  try {
    // unlinkSync instead of rmSync (Node 14.14+): this deletes a single state file, and the
    // catch swallows ENOENT exactly as `force: true` did.
    fs.unlinkSync(trackingStateFile());
  } catch { /* best-effort */ }
}
