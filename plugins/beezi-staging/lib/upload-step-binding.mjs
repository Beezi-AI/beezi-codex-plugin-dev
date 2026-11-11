// The installation binding as an upload-worker step. It used to run at the end of every non-local
// checkpoint, after that checkpoint's queue flush; the worker's due checkpoints now leave the queue
// to the `queue` step (batched) and skip both, so the worker binds here instead, once per pass,
// with the run's tokened sessions. lib/installation-binding.mjs bindInstallationForSessions is the
// one definition of which account binds; the inline checkpoint (track) still calls it itself.
//
// NO STATIC IMPORTS, as in lib/upload-step-diagnostics.mjs: the hooks import the worker module for
// its status helpers, and must pay for none of this.
//
// ALWAYS `{ progress: 0, remaining: 0 }`: the binding is not an upload. A failure is retried by the
// next pass or run (boundAt stays null), and counted as work left it would stall the run.

const NOTHING = { progress: 0, remaining: 0 };

export const installationBindingStep = {
  name: 'installation-binding',
  async run(ctx) {
    try {
      if (ctx.now() >= ctx.deadline) return NOTHING;
      const { bindInstallationForSessions } = await import('./installation-binding.mjs');
      const deps = { now: ctx.now, deadline: ctx.deadline };
      if (ctx.fetchImpl) deps.fetchImpl = ctx.fetchImpl;
      if (ctx.deps && typeof ctx.deps.getDefaultKey === 'function') deps.getDefaultKey = ctx.deps.getDefaultKey;
      await bindInstallationForSessions(ctx.sessions, deps);
    } catch { /* binding never fails a run */ }
    return NOTHING;
  },
};
