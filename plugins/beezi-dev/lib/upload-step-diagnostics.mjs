// The diagnostics flush as an upload-worker step. The Stop hook used to POST these inline at turn
// end; hooks now capture only (I-local), so the worker — which runs after every turn end that
// marked its session due — delivers them instead. The MCP server keeps its own 15-minute flush.
//
// NO STATIC IMPORTS. lib/upload-worker.mjs imports this module, and lib/upload-trigger.mjs imports
// the worker on every hook for its status helpers: everything here loads inside run(), so a hook
// pays for none of it.
//
// ALWAYS `{ progress: 0, remaining: 0 }`. Diagnostics are not the uploads the run exists for: a
// failed delivery counted as work left would idle the run into `stalled` and back off every
// account's uploads for 5 minutes, and the flush keeps its own backoff (telemetry-flush.mjs).

// The claim lock covers the synchronous claim only, as in scripts/mcp.mjs.
const CLAIM_LEASE_MS = 30000;
// postDiagnostics' own per-request timeout (lib/diagnostics-transport.mjs DEFAULT_TIMEOUT_MS).
const REQUEST_TIMEOUT_MS = 5000;

const NOTHING = { progress: 0, remaining: 0 };

export const diagnosticsStep = {
  name: 'diagnostics',
  async run(ctx) {
    try {
      const { isTelemetryGranted } = await import('./diagnostics.mjs');
      if (ctx.now() >= ctx.deadline || !isTelemetryGranted()) return NOTHING;
      const { claimFlushWindow, flushDiagnostics } = await import('./telemetry-flush.mjs');
      const { postDiagnostics } = await import('./diagnostics-transport.mjs');
      const { sharedLock, withLock } = await import('./single-instance-lock.mjs');
      if (ctx.now() >= ctx.deadline) return NOTHING;
      // The claim keeps every other sender (an MCP server, a second worker) out of this window.
      const claim = withLock(sharedLock('diagnostics-flush'), { leaseMs: CLAIM_LEASE_MS }, () => claimFlushWindow());
      if (!claim.ok || !claim.value) return NOTHING;
      // The worker's own deadline cutting a request short is not a failed delivery: it must not
      // escalate the backoff the MCP server's attempts share. A timeout of the request's own (a
      // slow server) and every other transport error still do.
      const budgetCutoff = { status: 0, retryAfterMs: null, body: null, budgetCutoff: true };
      await flushDiagnostics({
        claimedUntil: claim.value,
        postDiagnosticsImpl: async (url, payload, deps) => {
          const remaining = ctx.deadline - ctx.now();
          if (remaining <= 0) return budgetCutoff;
          const cut = remaining < REQUEST_TIMEOUT_MS;
          const opts = Object.assign({}, deps, cut ? { timeoutMs: remaining } : {});
          if (ctx.fetchImpl) opts.fetchImpl = ctx.fetchImpl;
          try {
            return await postDiagnostics(url, payload, opts);
          } catch (error) {
            if (cut && error && error.name === 'AbortError') return budgetCutoff;
            throw error;
          }
        },
      });
    } catch { /* delivery never fails a run */ }
    return NOTHING;
  },
};
