// Imported first, and for its side effect as much as its exports: it redirects every root the
// plugin can resolve into a per-process sandbox and deletes OPENAI_API_KEY from process.env.
// See tools/hermetic-env.mjs for the three leak channels this file used to sit on top of.
import { withCodexAuth, underCodexAuth } from '../tools/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, buildConfig, shouldKeepExisting, captureFromCodexAccount } from '../lib/billing-capture.mjs';
import { readCodexAuthSignals } from '../lib/codex-account.mjs';

// Force the subscription branch deterministically: a CODEX_HOME with no auth.json, so step 4 of
// the ladder (billing-config.mjs:110-118) has nothing to say and the selfReported declaration at
// step 5 decides. Closes L2 for the `plan:` call sites, which pass no deps to buildConfig and
// would otherwise read whatever ~/.codex/auth.json the author happens to have.
const withSubscriptionEnv = (fn) => underCodexAuth(null, fn);

test('parseArgs reads --from-codex and flags', () => {
  assert.deepEqual(parseArgs(['--from-codex', '--via', 'login']), { fromCodex: true, via: 'login' });
});

test('--from-codex and --plan are mutually exclusive', () => {
  assert.throws(() => parseArgs(['--from-codex', '--plan', 'pro']), /mutually exclusive/);
});

test('a self-reported plan builds a subscription config', () => {
  withSubscriptionEnv(() => {
    const cfg = buildConfig({ plan: 'plus', via: 'login-user' }, {}, new Date('2026-01-01T00:00:00Z'));
    assert.equal(cfg.source, 'subscription');
    assert.equal(cfg.plan, 'plus');
    assert.equal(cfg.subscriptionType, 'plus');
    assert.equal(cfg.selfReported, true);
    assert.equal(cfg.capturedBy, 'login-user');
  });
});

test('an unknown self-reported plan is rejected', () => {
  assert.throws(() => buildConfig({ plan: 'ultra' }, {}), /Unknown plan/);
});

test('api-key billing carries no plan', () => {
  const cfg = buildConfig({ plan: 'plus' }, { OPENAI_API_KEY: 'sk-x' });
  assert.equal(cfg.source, 'openai_api_key');
  assert.equal(cfg.plan, null);
  assert.equal(cfg.subscriptionType, null);
});

test('shouldKeepExisting protects a self-reported plan from an unknown re-capture', () => {
  const fresh = { plan: 'unknown' };
  const existing = { plan: 'pro', selfReported: true };
  assert.equal(shouldKeepExisting(fresh, existing), true);
  assert.equal(shouldKeepExisting({ plan: 'team' }, existing), false);
});

test('every ChatGPT tier the API prices can be self-reported', () => {
  // The list used to stop at `enterprise`, so a Go or Edu user picking their real tier hit
  // "Unknown plan" and captured nothing — worse than not asking them at all.
  // L2: inside withSubscriptionEnv, because buildConfig gets no deps and would otherwise resolve
  // step 4 against the author's own ~/.codex/auth.json — three of these fail on an api-key machine.
  withSubscriptionEnv(() => {
    for (const plan of ['free', 'plus', 'pro_5x', 'pro_20x', 'go', 'team', 'business', 'enterprise', 'edu']) {
      const cfg = buildConfig({ plan, via: 'login-user' }, {});
      assert.equal(cfg.plan, plan, `${plan} is accepted`);
      assert.equal(cfg.source, 'subscription');
      assert.equal(cfg.selfReported, true);
    }
  });
});

test('a self-reported tier named the way Codex names it is accepted, not rejected', () => {
  // The user reads their plan off ChatGPT, which still calls the $200 tier "Pro". Rejecting the
  // word they have in front of them captures nothing, which is the outcome this path exists to fix.
  withSubscriptionEnv(() => { // L2 — see above
    assert.equal(buildConfig({ plan: 'pro' }, {}).plan, 'pro_20x');
    assert.equal(buildConfig({ plan: 'prolite' }, {}).plan, 'pro_5x');
  });
});

test('free is offerable — the API prices it like any other tier', () => {
  // Was rejected while the API required a paid plan; that restriction is gone, and refusing the
  // tier the user actually has forced them into either lying or capturing nothing.
  withSubscriptionEnv(() => { // L2 — see above
    const cfg = buildConfig({ plan: 'free', via: 'login-user' }, {});
    assert.equal(cfg.plan, 'free');
    assert.equal(cfg.source, 'subscription');
  });
});

test('the rejection message lists every value the user may pick', () => {
  assert.throws(() => buildConfig({ plan: 'nope' }, {}), (e) => {
    for (const v of ['free', 'plus', 'pro_5x', 'pro_20x', 'go', 'team', 'business', 'enterprise', 'edu', 'api_key']) {
      assert.match(e.message, new RegExp(v));
    }
    return true;
  });
});

// captureFromCodexAccount is shared by the SessionStart hook and scripts/billing-capture.mjs. It
// exists because the expired-claim rule once lived in only one of them, and the nudge that rule
// produces sent the user straight to the caller that lacked it.
const account = (over = {}) => () => ({ authMode: 'chatgpt', subscriptionType: 'pro_20x', plan: 'pro_20x', expiresAt: null, ...over });

// Both tests below assert a SUBSCRIPTION outcome, which the ladder can only reach through step 4.
// `env: {}` closes L3 (captureFromCodexAccount's `env = process.env` default, billing-capture.mjs:135,
// which an exported OPENAI_API_KEY would win at step 1); withCodexAuth closes L1 (the un-threaded
// `deps` that makes step 4 open the real ~/.codex/auth.json). Both are needed — either alone
// still leaves the answer up to the machine the suite happens to run on.
test('captureFromCodexAccount records a valid claim as-is', (t) => {
  withCodexAuth(t, { auth_mode: 'chatgpt' });
  const { config, reason } = captureFromCodexAccount({ via: 'login', env: {}, deps: { readCodexAccount: account() } });
  assert.equal(reason, 'captured');
  assert.equal(config.plan, 'pro_20x');
  assert.equal(config.capturedBy, 'login');
});

test('captureFromCodexAccount keeps the expiry of an expired claim but not its plan label', (t) => {
  withCodexAuth(t, { auth_mode: 'chatgpt' });
  const expiresAt = Date.now() - 42 * 24 * 60 * 60 * 1000;
  const { config, reason } = captureFromCodexAccount({
    via: 'login',
    env: {},
    deps: { readCodexAccount: account({ subscriptionType: 'free', plan: 'free', expiresAt }) },
  });
  assert.equal(reason, 'expired-claim');
  assert.equal(config.plan, 'unknown', 'a six-week-stale "free" must not be believed');
  assert.equal(config.credentialsExpiresAt, expiresAt, 'the expiry is what makes it revisitable');
});

test('captureFromCodexAccount reports an absent account rather than writing one', () => {
  assert.deepEqual(
    captureFromCodexAccount({ via: 'login', deps: { readCodexAccount: () => null } }),
    { config: null, reason: 'no-account' },
  );
});

// ─── G-10-1: the deps seam, and the field that decides whether it ships broken ────────────────

// Step 4 of the ladder is now answered from the account already read, so nothing here opens a real
// ~/.codex/auth.json. `underCodexAuth(null, …)` proves it: there is no file to read at all.
test('the source ladder resolves from the account, with no auth.json on disk', () => {
  underCodexAuth(null, () => {
    const { config } = captureFromCodexAccount({
      via: 'login', env: {}, deps: { readCodexAccount: account() },
    });
    assert.equal(config.source, 'subscription');
    assert.equal(config.plan, 'pro_20x');
  });
});

// THE way this fix ships broken. auth_mode is null under a ChatGPT sign-in, so billing-config.mjs:118
// is genuinely reached with authMode === null; signals synthesized without `hasStoredApiKey` resolve
// a machine holding a stored key to `unknown`, and syncBillingSource writes that wrong source into
// billing.json. The two sides are asserted to agree, not just to be non-unknown.
test('a machine whose auth_mode is null resolves by its stored key, not to unknown', () => {
  const auth = {
    auth_mode: null,
    OPENAI_API_KEY: 'sk-live-not-a-real-key',
    tokens: { id_token: 'header.not-decodable.sig' },
  };
  underCodexAuth(auth, () => {
    // From the account object (what captureFromCodexAccount synthesizes) …
    const fromAccount = captureFromCodexAccount({
      via: 'login',
      env: {},
      deps: { readCodexAccount: account({ authMode: null, hasStoredApiKey: true }) },
    });
    assert.equal(fromAccount.config.source, 'openai_api_key', 'not "unknown"');
    assert.equal(fromAccount.config.plan, null, 'a key bills per token — there is no tier to state');

    // … and from the real reader over the same file. They must agree.
    const fromFile = captureFromCodexAccount({
      via: 'login',
      env: {},
      deps: {
        readCodexAccount: account({ authMode: null, hasStoredApiKey: true }),
        readCodexAuthSignals: readCodexAuthSignals,
      },
    });
    assert.equal(fromFile.config.source, fromAccount.config.source);
  });
});

// runSessionStart resolves the source once, then captures the plan. Before the seam was threaded
// the capture reached billing-capture.mjs's MODULE-LEVEL resolveSource, so the second, unseen
// resolution could contradict the first and drop the plan fields the first had just earned.
test('an injected resolveSource reaches the inner resolution too', () => {
  underCodexAuth({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-x' }, () => {
    const { config } = captureFromCodexAccount({
      via: 'session-start',
      env: {},
      deps: { readCodexAccount: account(), resolveSource: () => 'subscription' },
    });
    assert.equal(config.source, 'subscription', 'the injected ladder decided, not the file on disk');
    assert.equal(config.plan, 'pro_20x');
  });
});

test('buildConfig threads its deps into both resolveSource call sites', () => {
  // The `--plan` branch (declaredSource) and the auto-capture branch, in that order.
  const declared = buildConfig({ plan: 'plus' }, {}, new Date(), null, { resolveSource: () => 'openai_api_key' });
  assert.equal(declared.source, 'openai_api_key');
  assert.equal(declared.plan, null, 'a declared subscription cannot outrank a live key');
  const captured = buildConfig({ subscriptionType: 'plus' }, {}, new Date(), null, { resolveSource: () => 'subscription' });
  assert.equal(captured.source, 'subscription');
  assert.equal(captured.plan, 'plus');
});

test('captureFromCodexAccount never overwrites a self-reported plan with unknown', () => {
  const { config, reason } = captureFromCodexAccount({
    via: 'refresh',
    existing: { source: 'subscription', plan: 'team', selfReported: true },
    deps: { readCodexAccount: account({ subscriptionType: null, plan: 'unknown' }) },
  });
  assert.equal(reason, 'kept-self-reported');
  assert.equal(config, null);
});
