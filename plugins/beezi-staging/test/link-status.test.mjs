import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkStatus, describeLink, describeReporting, LinkState } from '../lib/link-status.mjs';

const HOOKS_ABSENT = () => ({ state: 'absent', registered: [] });

test('no token reads as not_linked without calling whoami', async () => {
  let called = 0;
  const s = await linkStatus({
    getAccessToken: async () => null,
    whoami: async () => { called += 1; return { valid: true }; },
    hooksStatus: HOOKS_ABSENT,
    apiBase: 'https://api.test/api',
  });
  assert.equal(s.state, LinkState.NOT_LINKED);
  assert.equal(called, 0);
});

test('a valid token reports the account and the API it was checked against', async () => {
  const s = await linkStatus({
    getAccessToken: async () => 'tok',
    whoami: async () => ({ valid: true, name: 'Dev', email: 'd@e.f' }),
    hooksStatus: HOOKS_ABSENT,
    apiBase: 'http://localhost:5001/api',
  });
  assert.equal(s.state, LinkState.LINKED);
  assert.equal(s.account, 'Dev');
  assert.match(describeLink(s), /localhost:5001/);
});

test('whoami null is unreachable, not "not linked"', async () => {
  const s = await linkStatus({
    getAccessToken: async () => 'tok',
    whoami: async () => null,
    hooksStatus: HOOKS_ABSENT,
    apiBase: 'https://api.test/api',
  });
  assert.equal(s.state, LinkState.UNREACHABLE);
  // The distinction matters: an unreachable API says nothing about the credentials, and claiming
  // otherwise is what made the status script and the sign-in tool look like they disagreed.
  assert.doesNotMatch(describeReporting(s), /not linked/i);
  assert.match(describeReporting(s), /unknown/i);
});

test('whoami invalid is revoked', async () => {
  const s = await linkStatus({
    getAccessToken: async () => 'tok',
    whoami: async () => ({ valid: false }),
    hooksStatus: HOOKS_ABSENT,
    apiBase: 'https://api.test/api',
  });
  assert.equal(s.state, LinkState.REVOKED);
  assert.match(describeReporting(s), /revoked/i);
});

test('a linked machine with no hooks is told why nothing is reported', async () => {
  const s = await linkStatus({
    getAccessToken: async () => 'tok',
    whoami: async () => ({ valid: true, name: 'Dev' }),
    hooksStatus: HOOKS_ABSENT,
    apiBase: 'https://api.test/api',
  });
  assert.match(describeReporting(s), /NOT being reported/);
  assert.match(describeReporting(s), /not installed/);
});

test('installed hooks still point at the trust step, since untrusted hooks never run', async () => {
  const s = await linkStatus({
    getAccessToken: async () => 'tok',
    whoami: async () => ({ valid: true }),
    hooksStatus: () => ({ state: 'installed', registered: ['SessionStart', 'PostToolUse', 'Stop'] }),
    apiBase: 'https://api.test/api',
  });
  assert.match(describeReporting(s), /\/hooks/);
});

test('a broken hook registry never breaks the link check', async () => {
  const s = await linkStatus({
    getAccessToken: async () => 'tok',
    whoami: async () => ({ valid: true, name: 'Dev' }),
    hooksStatus: () => { throw new Error('registry unreadable'); },
    apiBase: 'https://api.test/api',
  });
  assert.equal(s.state, LinkState.LINKED);
  assert.equal(s.hooks.state, 'unknown');
});

test('no message names a slash command Codex does not have', async () => {
  for (const state of Object.values(LinkState)) {
    const s = { state, account: null, apiBase: 'https://api.test/api', hooks: { state: 'absent', registered: [] } };
    for (const text of [describeLink(s), describeReporting(s)].filter(Boolean)) {
      assert.ok(!/\/beezi:/.test(text), `"${text}" names a command that does not exist`);
    }
  }
});

// Dead registry entries reach every reporting surface.
//
// The measured failure this locks: a machine whose own hooks were complete was told "hooks are
// installed, trust them" while three OTHER entries in the same registry failed on every session.
// `state` could not say so — it is owner-scoped — so the warning has to be orthogonal to it and
// has to survive every branch of describeReporting, not just the unhappy ones.

const DEAD_TWO = [
  { event: 'SessionStart', owner: 'beezi', target: 'C:\gone\beezi-session-start.cmd' },
  { event: 'Stop', owner: 'beezi', target: 'C:\gone\beezi-stop.cmd' },
];

test('a healthy machine is still told about dead entries it does not own', async () => {
  const s = await linkStatus({
    getAccessToken: async () => 'tok',
    whoami: async () => ({ valid: true, name: 'Dev' }),
    hooksStatus: () => ({ state: 'installed', registered: ['SessionStart', 'Stop'], broken: DEAD_TWO }),
    apiBase: 'https://api.test/api',
  });
  const text = describeReporting(s);
  // Both halves, in one answer: ours are fine, and something in the registry is failing anyway.
  assert.match(text, /hooks are installed/i);
  assert.match(text, /2 registered hook entries point at a file that no longer exists/);
  assert.match(text, /SessionStart, Stop/);
  // The repair is ours to do, not the user's to run — every surface that reads this heals the
  // install before it reports. What is still quoted is the read-only path listing, and it has to be
  // runnable from the user's cwd (their repo, not the plugin root): this message reaches the
  // beezi_status MCP tool, whose reader will try to run what it is told.
  assert.match(text, /removed automatically/);
  assert.match(text, /node "[^"]*hooks\.mjs" status/);
  assert.doesNotMatch(text, /Run node "[^"]*hooks\.mjs" install/);
  assert.doesNotMatch(text, /<plugin>/);
});

test('the dead-entry warning survives every branch, including the ones that return early', async () => {
  const hooksStatus = () => ({ state: 'installed', registered: [], broken: DEAD_TWO });
  const cases = [
    { getAccessToken: async () => null },
    { getAccessToken: async () => 'tok', whoami: async () => ({ valid: false }) },
    { getAccessToken: async () => 'tok', whoami: async () => null },
    { getAccessToken: async () => 'tok', whoami: async () => ({ valid: true }) },
  ];
  for (const overrides of cases) {
    const s = await linkStatus({ whoami: async () => ({ valid: true }), ...overrides, hooksStatus, apiBase: 'https://api.test/api' });
    assert.match(describeReporting(s), /no longer exists/, JSON.stringify(s.state));
  }
});

test('a singular dead entry is phrased as one, and a clean registry adds nothing', async () => {
  const one = await linkStatus({
    getAccessToken: async () => 'tok',
    whoami: async () => ({ valid: true }),
    hooksStatus: () => ({ state: 'installed', registered: [], broken: [DEAD_TWO[0]] }),
    apiBase: 'https://api.test/api',
  });
  assert.match(describeReporting(one), /1 registered hook entry points/);

  const none = await linkStatus({
    getAccessToken: async () => 'tok',
    whoami: async () => ({ valid: true }),
    hooksStatus: () => ({ state: 'installed', registered: [], broken: [] }),
    apiBase: 'https://api.test/api',
  });
  assert.doesNotMatch(describeReporting(none), /no longer exists/);
});

test('a hooksStatus that predates `broken` is read as "none", not as a crash', async () => {
  const s = await linkStatus({
    getAccessToken: async () => 'tok',
    whoami: async () => ({ valid: true }),
    hooksStatus: () => ({ state: 'installed', registered: ['Stop'] }),
    apiBase: 'https://api.test/api',
  });
  assert.deepEqual(s.hooks.broken, []);
  assert.doesNotMatch(describeReporting(s), /no longer exists/);
});
