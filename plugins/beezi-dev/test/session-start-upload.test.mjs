import '../tools/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sessionStartDueHandler, readSessionStartCache } from '../lib/session-start-upload.mjs';
import { ENDPOINTS } from '../lib/config.mjs';
import { makeHome, linkAccount, accountSession } from '../tools/account-fixtures.mjs';

// The worker half of SessionStart: the `session-start` due handler the upload worker runs for a
// marker with `sessionStart: true`. It owns every request the hook used to make (whoami, the forced
// renewal, /repos/status, the account check-in, the update check) and leaves on disk the answers
// the next SessionStart prints from (accounts/<key>/session-start.json).

const T0 = Date.parse('2026-11-05T10:00:00.000Z'); // 1793872800000
const KEY_A = 'a1b2c3d4';
const KEY_B = '99887766';
const REMOTE = 'https://host/org/repo.git';

const ok = (body = {}) => ({ ok: true, status: 200, json: async () => body });
const status = (code, body = {}) => ({ ok: code < 400, status: code, json: async () => body });

// A fetch double answering whoami and /repos/status independently; every other URL is a 200 {}.
function router({ whoami = () => ok({}), repos = () => ok({ connected: false }) } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, client: init && init.headers ? init.headers['X-Beezi-Client'] : null, auth: init && init.headers ? init.headers.Authorization : null });
    if (u.endsWith(ENDPOINTS.whoami)) return whoami(init, calls);
    if (u.endsWith(ENDPOINTS.reposStatus)) return repos(init, calls);
    return ok({});
  };
  const count = (endpoint) => calls.filter((c) => c.url.endsWith(endpoint)).length;
  return { fetchImpl, calls, count };
}

function syncSpy(impl) {
  const calls = [];
  const spy = async (key, session, options, syncDeps) => {
    calls.push({ key, token: session && session.token, tenantId: session && session.tenantId, options: options || {}, deps: syncDeps || {} });
    return impl ? impl() : { synced: true, status: 200 };
  };
  spy.calls = calls;
  return spy;
}

// A linked machine: every key has its index row and its account directory.
function world(t, keys = [KEY_A]) {
  const home = makeHome(t, 'session-start-upload-');
  for (const key of keys) linkAccount(home, key);
  return home;
}

const entry = (over = {}) => ({
  sessionId: 's1', transcriptPath: null, cwd: null, timeline: false, sessionStart: true,
  markedAt: T0 - 1000, attempts: 0, owedKeys: null, ...over,
});

function ctxOf({ sessions = [accountSession(KEY_A, 'tok')], fetchImpl, deps = {}, now = () => T0, deadline = T0 + 60000 } = {}) {
  return {
    sessions, deadline, now, fetchImpl, batch: true, status: {}, due: [],
    deps: {
      gitImpl: () => { throw new Error('not a git repository'); },
      syncAccount: async () => ({ synced: false }),
      checkForUpdate: async () => ({ status: 'skipped' }),
      readBillingConfig: () => null,
      readChatgptAuth: () => null,
      ...deps,
    },
  };
}

const cacheFile = (home, key) => path.join(home, 'accounts', key, 'session-start.json');
const readCacheFile = (home, key) => JSON.parse(fs.readFileSync(cacheFile(home, key), 'utf-8'));

// ── what runs, and when ─────────────────────────────────────────────────────────────────────────

test('a marker that is not a session start settles at once and makes no request', async (t) => {
  const home = world(t);
  const { fetchImpl, calls } = router();
  assert.deepEqual(await sessionStartDueHandler(entry({ sessionStart: false }), ctxOf({ fetchImpl })), { settled: true });
  assert.deepEqual(calls, []);
  assert.equal(fs.existsSync(cacheFile(home, KEY_A)), false);
});

test('the step calls whoami once per account and writes each account its cache', async (t) => {
  const home = world(t, [KEY_A, KEY_B]);
  const tenants = [{ id: 't-9', name: 'Acme', role: 'User', type: 'platform' }];
  const { fetchImpl, calls, count } = router({
    whoami: (init) => (init.headers['X-Beezi-Client'] === `c-${KEY_A}`
      ? ok({ email: 'Dev@Acme.io', name: 'Dev', tenantName: 'Acme', tenants })
      : ok({ email: 'second@example.com' })),
  });
  const ctx = ctxOf({ sessions: [accountSession(KEY_A, 'tok'), accountSession(KEY_B, 'tok-b')], fetchImpl });

  assert.deepEqual(await sessionStartDueHandler(entry(), ctx), { settled: true });

  assert.equal(count(ENDPOINTS.whoami), 2);
  assert.deepEqual(calls.filter((c) => c.url.endsWith(ENDPOINTS.whoami)).map((c) => c.client), ['c-a1b2c3d4', 'c-99887766'],
    'each whoami carries its own account client id');
  assert.deepEqual(readCacheFile(home, KEY_A), {
    version: 1,
    checkedAt: 1793872800000,
    verdict: 'ok',
    clientId: 'c-a1b2c3d4',
    who: {
      valid: true, email: 'Dev@Acme.io', name: 'Dev', tenantName: 'Acme',
      tenants: [{ id: 't-9', name: 'Acme', role: 'User', type: 'platform', joinedAt: null, anonymization: null }],
      anonymization: null,
    },
    completed: { s1: 1793872799000 },
  });
  assert.deepEqual(readCacheFile(home, KEY_B), {
    version: 1,
    checkedAt: 1793872800000,
    verdict: 'ok',
    clientId: 'c-99887766',
    who: { valid: true, email: 'second@example.com', name: null, tenantName: null, tenants: null, anonymization: null },
    completed: { s1: 1793872799000 },
  });
});

test('two session-start markers in one run probe each account once', async (t) => {
  world(t);
  const { fetchImpl, count } = router();
  const ctx = ctxOf({ fetchImpl });
  await sessionStartDueHandler(entry({ sessionId: 's1' }), ctx);
  await sessionStartDueHandler(entry({ sessionId: 's2' }), ctx);
  assert.equal(count(ENDPOINTS.whoami), 1);
});

test('a marker whose accounts were all refreshed after it was marked settles without a request', async (t) => {
  world(t);
  const first = router();
  await sessionStartDueHandler(entry({ markedAt: T0 - 1000 }), ctxOf({ fetchImpl: first.fetchImpl }));
  // A later run (a new sessions array) of the same marker: parked for its timeline, say.
  const again = router();
  const sync = syncSpy();
  const result = await sessionStartDueHandler(entry({ markedAt: T0 - 1000 }), ctxOf({ fetchImpl: again.fetchImpl, now: () => T0 + 5000, deps: { syncAccount: sync } }));
  assert.deepEqual(result, { settled: true });
  assert.deepEqual(again.calls, []);
  assert.equal(sync.calls.length, 0);
});

test('a re-marked session (marked after the last refresh) is probed again', async (t) => {
  world(t);
  await sessionStartDueHandler(entry({ markedAt: T0 - 1000 }), ctxOf({ fetchImpl: router().fetchImpl }));
  const again = router();
  await sessionStartDueHandler(entry({ markedAt: T0 + 1000 }), ctxOf({ fetchImpl: again.fetchImpl, now: () => T0 + 5000 }));
  assert.equal(again.count(ENDPOINTS.whoami), 1);
});

// whoami records its own `checkedAt` as soon as it answers, before the repo probe, the check-in and
// the update check. A run cut short after it must leave those owed: the next run does them.
test('a run cut by its deadline after whoami leaves the rest owed, and the next run does it before settling', async (t) => {
  const home = world(t);
  let clockAt = T0;
  const first = router({
    whoami: () => { clockAt = T0 + 60000; return ok({ email: 'dev@acme.io', tenants: [{ id: 'A', name: 'Acme', type: 'platform' }] }); },
    repos: () => ok({ connected: true, projectName: 'Apollo' }),
  });
  const firstSync = syncSpy();
  const firstChecks = [];
  const cut = await sessionStartDueHandler(entry({ cwd: home }), ctxOf({
    fetchImpl: first.fetchImpl, now: () => clockAt, deadline: T0 + 60000,
    deps: { gitImpl: () => REMOTE, syncAccount: firstSync, checkForUpdate: async () => { firstChecks.push(1); return { status: 'skipped' }; } },
  }));
  assert.deepEqual(cut, { settled: false });
  assert.equal(first.count(ENDPOINTS.reposStatus), 0);
  assert.equal(firstSync.calls.length, 0);
  assert.deepEqual(firstChecks, []);

  // The next worker run (a new sessions array) of the same marker.
  const again = router({
    whoami: () => ok({ email: 'dev@acme.io', tenants: [{ id: 'A', name: 'Acme', type: 'platform' }] }),
    repos: () => ok({ connected: true, projectName: 'Apollo' }),
  });
  const sync = syncSpy();
  const checks = [];
  const done = await sessionStartDueHandler(entry({ cwd: home }), ctxOf({
    fetchImpl: again.fetchImpl, now: () => T0 + 70000, deadline: T0 + 130000,
    deps: { gitImpl: () => REMOTE, syncAccount: sync, checkForUpdate: async () => { checks.push(1); return { status: 'skipped' }; } },
  }));
  assert.deepEqual(done, { settled: true });
  assert.equal(again.count(ENDPOINTS.reposStatus), 1);
  assert.deepEqual(sync.calls.map((c) => c.key), ['a1b2c3d4']);
  assert.deepEqual(checks, [1]);
});

// Completion is the SESSION's: another session's finished start refreshed the account, not this
// session's repository.
test('a session marked before another session whose start finished still probes its own repository', async (t) => {
  const home = world(t);
  const repoOne = path.join(home, 'one');
  const repoTwo = path.join(home, 'two');
  const remotes = { [repoOne]: 'https://host/org/one.git', [repoTwo]: 'https://host/org/two.git' };
  const gitImpl = (args, dir) => remotes[dir];
  const whoami = () => ok({ email: 'dev@acme.io', tenants: [{ id: 'A', name: 'Acme', type: 'platform' }] });
  await sessionStartDueHandler(entry({ sessionId: 's1', cwd: repoOne, markedAt: T0 - 1000 }), ctxOf({
    fetchImpl: router({ whoami }).fetchImpl, deps: { gitImpl },
  }));

  // A later run handles s2, marked before s1 (an earlier run's deadline cut it short, say).
  const again = router({ whoami, repos: () => ok({ connected: true, projectName: 'Two' }) });
  const done = await sessionStartDueHandler(entry({ sessionId: 's2', cwd: repoTwo, markedAt: T0 - 2000 }), ctxOf({
    fetchImpl: again.fetchImpl, now: () => T0 + 5000, deps: { gitImpl },
  }));
  assert.deepEqual(done, { settled: true });
  assert.equal(again.count(ENDPOINTS.reposStatus), 1);
  assert.deepEqual(readCacheFile(home, KEY_A).repos['|https://host/org/two.git'], { connected: true, projectName: 'Two', checkedAt: 1793872805000 });
});

test('an account refused by the portal still records the finished start, so a later run asks nothing', async (t) => {
  world(t);
  const deps = { getAuthentication: async () => ({ accessToken: 'tok', state: 'ready' }) };
  await sessionStartDueHandler(entry(), ctxOf({ fetchImpl: router({ whoami: () => status(401) }).fetchImpl, deps }));
  const again = router({ whoami: () => status(401) });
  let renewals = 0;
  const result = await sessionStartDueHandler(entry(), ctxOf({
    fetchImpl: again.fetchImpl, now: () => T0 + 5000,
    deps: { getAuthentication: async () => { renewals += 1; return { accessToken: 'tok', state: 'ready' }; } },
  }));
  assert.deepEqual(result, { settled: true });
  assert.deepEqual(again.calls, []);
  assert.equal(renewals, 0);
});

test('the finished-start record keeps the 64 newest marks and drops the oldest', async (t) => {
  const home = world(t);
  const completed = {};
  for (let i = 0; i < 64; i += 1) completed[`old-${i}`] = T0 - 100000 + i;
  fs.writeFileSync(cacheFile(home, KEY_A), JSON.stringify({ version: 1, completed }));
  await sessionStartDueHandler(entry({ sessionId: 'new', markedAt: T0 - 1000 }), ctxOf({ fetchImpl: router().fetchImpl }));
  const kept = readCacheFile(home, KEY_A).completed;
  assert.equal(Object.keys(kept).length, 64);
  assert.equal(kept.new, 1793872799000);
  assert.equal('old-0' in kept, false);
  assert.equal(kept['old-1'], 1793872700001);
  assert.equal(kept['old-63'], 1793872700063);
});

test('at its deadline the step starts nothing and does not settle', async (t) => {
  const home = world(t);
  const { fetchImpl, calls } = router();
  assert.deepEqual(await sessionStartDueHandler(entry(), ctxOf({ fetchImpl, deadline: T0 })), { settled: false });
  assert.deepEqual(calls, []);
  assert.equal(fs.existsSync(cacheFile(home, KEY_A)), false);
});

test('with no tokened account the step has nothing to do and settles', async (t) => {
  world(t);
  const { fetchImpl, calls } = router();
  assert.deepEqual(await sessionStartDueHandler(entry(), ctxOf({ sessions: [], fetchImpl })), { settled: true });
  assert.deepEqual(calls, []);
});

// Offline, so nothing else on the path (recordWhoami's tracking write) has a reason to write there.
test('an account whose directory is gone (logged out meanwhile) is not given one back', async (t) => {
  const home = makeHome(t, 'session-start-upload-');
  const { fetchImpl } = router({ whoami: () => { throw new Error('offline'); } });
  await sessionStartDueHandler(entry(), ctxOf({ fetchImpl }));
  assert.equal(fs.existsSync(path.join(home, 'accounts', KEY_A)), false);
});

// ── the token check ─────────────────────────────────────────────────────────────────────────────

test('a rejected token is renewed once and, recovered, cached as ok', async (t) => {
  const home = world(t);
  const issued = [];
  const { fetchImpl } = router({ whoami: (init) => (init.headers.Authorization === 'Bearer fresh' ? ok({}) : status(401)) });
  await sessionStartDueHandler(entry(), ctxOf({
    sessions: [accountSession(KEY_A, 'stale')], fetchImpl,
    deps: { getAuthentication: async (key, _deps, options) => { issued.push([key, options]); return { accessToken: 'fresh', state: 'ready' }; } },
  }));
  assert.deepEqual(issued, [['a1b2c3d4', { forceRefresh: true, guardChecked: true }]]);
  assert.equal(readCacheFile(home, KEY_A).verdict, 'ok');
});

test('a token still rejected after renewal is cached as rejected, and a 403 never deletes credentials', async (t) => {
  const home = world(t);
  let deleted = false;
  const { fetchImpl } = router({ whoami: () => status(403) });
  await sessionStartDueHandler(entry(), ctxOf({
    fetchImpl,
    deps: {
      getAuthentication: async () => ({ accessToken: 'tok', state: 'ready' }),
      deleteCredentials: async () => { deleted = true; },
    },
  }));
  assert.equal(readCacheFile(home, KEY_A).verdict, 'rejected');
  assert.equal(deleted, false);
});

test('a renewal that is temporarily unavailable is cached as temporary', async (t) => {
  const home = world(t);
  const { fetchImpl } = router({ whoami: () => status(401) });
  await sessionStartDueHandler(entry(), ctxOf({ fetchImpl, deps: { getAuthentication: async () => ({ state: 'refreshing' }) } }));
  assert.equal(readCacheFile(home, KEY_A).verdict, 'temporary');
});

test('an unreachable whoami keeps the last identity and reads as fine', async (t) => {
  const home = world(t);
  await sessionStartDueHandler(entry(), ctxOf({ fetchImpl: router({ whoami: () => ok({ email: 'known@example.com' }) }).fetchImpl }));
  await sessionStartDueHandler(entry({ markedAt: T0 + 1 }), ctxOf({ now: () => T0 + 10, fetchImpl: router({ whoami: () => { throw new Error('offline'); } }).fetchImpl }));
  assert.deepEqual(readCacheFile(home, KEY_A), {
    version: 1, checkedAt: 1793872800010, verdict: 'ok', clientId: 'c-a1b2c3d4',
    who: { valid: true, email: 'known@example.com', name: null, tenantName: null, tenants: null, anonymization: null },
    completed: { s1: 1793872800001 },
  });
});

test('a valid whoami refreshes the index row and the tracking policy', async (t) => {
  world(t);
  const patches = [];
  const { fetchImpl } = router({ whoami: () => ok({ email: 'filled@example.com', name: 'Dev', tenantId: 't-9', tenantName: 'Acme' }) });
  await sessionStartDueHandler(entry(), ctxOf({ fetchImpl, deps: { updateAccount: async (key, patch) => { patches.push({ key, patch }); } } }));
  assert.deepEqual(patches, [{ key: 'a1b2c3d4', patch: {
    email: 'filled@example.com', name: 'Dev', tenantId: 't-9', tenantName: 'Acme', tenants: null, anonymization: null,
  } }]);
});

// ── the repo probe ──────────────────────────────────────────────────────────────────────────────

const platform = [{ id: 'A', name: 'Acme', type: 'platform' }];

// Keyed `<target tenantId>|<remote>`; a single-workspace row's target sends no header, so its id is empty.
test('a platform workspace has its repo status cached under its target workspace and remote', async (t) => {
  const home = world(t);
  const { fetchImpl, count } = router({
    whoami: () => ok({ email: 'dev@acme.io', tenants: platform }),
    repos: () => ok({ connected: true, projectName: 'Apollo' }),
  });
  await sessionStartDueHandler(entry({ cwd: home }), ctxOf({ fetchImpl, deps: { gitImpl: () => REMOTE } }));
  assert.equal(count(ENDPOINTS.reposStatus), 1);
  assert.deepEqual(readCacheFile(home, KEY_A).repos, {
    '|https://host/org/repo.git': { connected: true, projectName: 'Apollo', checkedAt: 1793872800000 },
  });
});

test('an analytics workspace is never probed', async (t) => {
  const home = world(t);
  const { fetchImpl, count } = router({ whoami: () => ok({ email: 'dev@acme.io', tenants: [{ id: 'A', name: 'Acme', type: 'analytics' }] }) });
  await sessionStartDueHandler(entry({ cwd: home }), ctxOf({ fetchImpl, deps: { gitImpl: () => REMOTE } }));
  assert.equal(count(ENDPOINTS.reposStatus), 0);
  assert.equal(readCacheFile(home, KEY_A).repos, undefined);
});

test('a failed repo probe leaves the last cached answer alone', async (t) => {
  const home = world(t);
  await sessionStartDueHandler(entry({ cwd: home }), ctxOf({
    fetchImpl: router({ repos: () => ok({ connected: false }) }).fetchImpl, deps: { gitImpl: () => REMOTE },
  }));
  await sessionStartDueHandler(entry({ cwd: home, markedAt: T0 + 1 }), ctxOf({
    now: () => T0 + 10, fetchImpl: router({ repos: () => { throw new Error('offline'); } }).fetchImpl, deps: { gitImpl: () => REMOTE },
  }));
  assert.deepEqual(readCacheFile(home, KEY_A).repos, {
    '|https://host/org/repo.git': { connected: false, projectName: null, checkedAt: 1793872800000 },
  });
});

// git run with no cwd answers for the WORKER's folder, which is not the session's.
test('a session with no recorded cwd is not probed, even where git would answer', async (t) => {
  world(t);
  let gitCalls = 0;
  const { fetchImpl, count } = router({ whoami: () => ok({ tenants: platform }) });
  await sessionStartDueHandler(entry({ cwd: null }), ctxOf({ fetchImpl, deps: { gitImpl: () => { gitCalls += 1; return REMOTE; } } }));
  assert.equal(gitCalls, 0);
  assert.equal(count(ENDPOINTS.reposStatus), 0);
});

test('a cwd outside any repo is not probed', async (t) => {
  const home = world(t);
  const { fetchImpl, count } = router();
  await sessionStartDueHandler(entry({ cwd: home }), ctxOf({ fetchImpl }));
  assert.equal(count(ENDPOINTS.reposStatus), 0);
});

// ── the account check-in ────────────────────────────────────────────────────────────────────────

test('the check-in rides the token the check ended up with, bounded at 1500ms, never forced', async (t) => {
  world(t);
  const { fetchImpl } = router({ whoami: (init) => (init.headers.Authorization === 'Bearer fresh' ? ok({}) : status(401)) });
  const sync = syncSpy();
  await sessionStartDueHandler(entry(), ctxOf({
    sessions: [accountSession(KEY_A, 'stale')], fetchImpl,
    deps: { syncAccount: sync, getAuthentication: async () => ({ accessToken: 'fresh', state: 'ready' }) },
  }));
  assert.deepEqual(sync.calls.map((c) => [c.key, c.token, c.options, c.deps.timeoutMs]), [['a1b2c3d4', 'fresh', { force: false }, 1500]]);
});

test('the check-in gets the worker run fetch and the account reader, never the module defaults', async (t) => {
  world(t);
  const { fetchImpl } = router();
  const readChatgptAuth = () => null;
  const sync = syncSpy();
  await sessionStartDueHandler(entry(), ctxOf({ fetchImpl, deps: { syncAccount: sync, readChatgptAuth } }));
  assert.equal(sync.calls[0].deps.fetchImpl, fetchImpl);
  assert.equal(sync.calls[0].deps.readChatgptAuth, readChatgptAuth);
});

test('the check-in reads the billing config SessionStart wrote, or null when it cannot be read', async (t) => {
  world(t);
  const stored = { version: 1, source: 'subscription', subscriptionType: 'pro', plan: 'pro' };
  const first = syncSpy();
  await sessionStartDueHandler(entry(), ctxOf({ fetchImpl: router().fetchImpl, deps: { syncAccount: first, readBillingConfig: () => stored } }));
  assert.equal(first.calls[0].deps.readBillingConfig(), stored);
  const second = syncSpy();
  await sessionStartDueHandler(entry({ markedAt: T0 + 1 }), ctxOf({
    now: () => T0 + 10, fetchImpl: router().fetchImpl,
    deps: { syncAccount: second, readBillingConfig: () => { throw new Error('EACCES'); } },
  }));
  assert.equal(second.calls[0].deps.readBillingConfig(), null);
});

test('a rejected account is skipped for the check-in; the other still checks in', async (t) => {
  world(t, [KEY_A, KEY_B]);
  const { fetchImpl } = router({ whoami: (init) => (init.headers.Authorization === 'Bearer tok' ? ok({}) : status(401)) });
  const sync = syncSpy();
  await sessionStartDueHandler(entry(), ctxOf({
    sessions: [accountSession(KEY_A, 'tok'), accountSession(KEY_B, 'tok-b')], fetchImpl,
    deps: { syncAccount: sync, getAuthentication: async () => ({ accessToken: 'tok-b', state: 'ready' }) },
  }));
  assert.deepEqual(sync.calls.map((c) => c.key), ['a1b2c3d4']);
});

test('a check-in that throws still settles the marker', async (t) => {
  world(t);
  const result = await sessionStartDueHandler(entry(), ctxOf({ fetchImpl: router().fetchImpl, deps: { syncAccount: async () => { throw new Error('boom'); } } }));
  assert.deepEqual(result, { settled: true });
});

// ── the update check ────────────────────────────────────────────────────────────────────────────

test('the update check runs once per worker run, on the run fetch', async (t) => {
  world(t);
  const { fetchImpl } = router();
  const checks = [];
  const ctx = ctxOf({ fetchImpl, deps: { checkForUpdate: async (d) => { checks.push(d.fetchImpl); return { status: 'skipped' }; } } });
  await sessionStartDueHandler(entry({ sessionId: 's1' }), ctx);
  await sessionStartDueHandler(entry({ sessionId: 's2' }), ctx);
  assert.deepEqual(checks, [fetchImpl]);
});

// ── the cache reader ────────────────────────────────────────────────────────────────────────────

test('a missing or malformed cache reads as empty', async (t) => {
  const home = world(t);
  assert.deepEqual(readSessionStartCache(KEY_A), {});
  fs.writeFileSync(cacheFile(home, KEY_A), '{"torn');
  assert.deepEqual(readSessionStartCache(KEY_A), {});
  fs.writeFileSync(cacheFile(home, KEY_A), '[1]');
  assert.deepEqual(readSessionStartCache(KEY_A), {});
});
