import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import {
  KINDS,
  isAnonValue,
  anonValue,
  anonRemote,
  anonBranch,
  anonHost,
  anonAccount,
  anonSession,
  anonymizeReport,
  anonymizeUsage,
  anonymizeAccountSync,
  scrubSessionError,
} from '../lib/anonymize.mjs';

const testDir = path.dirname(url.fileURLToPath(import.meta.url));
const vectors = JSON.parse(
  fs.readFileSync(path.join(testDir, 'fixtures', 'anonymization-vectors.json'), 'utf8'),
);
const KEY = vectors.keyHex;

const RUNNERS = {
  remote: (c) => anonRemote(KEY, c.input),
  branch: (c) => anonBranch(KEY, c.remote, c.branch),
  host: (c) => anonHost(KEY, c.input),
  account: (c) => anonAccount(KEY, c.input),
  session: (c) => anonSession(KEY, c.input),
};

function expectedFor(match) {
  return vectors.cases.find((c) => Object.keys(match).every((k) => c[k] === match[k])).expected;
}

const RAW_REMOTE = 'git@github.com:Acme/Payments.git';
const RAW_BRANCH = 'feature/ABC-123';
const SESSION_ID = '0b6f2c1e-3c1a-4f7e-9a51-2d9c1f0e7a11';

function rawReport(over = {}) {
  return {
    segmentId: `${SESSION_ID}:0-10`,
    sessionId: SESSION_ID,
    remote: RAW_REMOTE,
    branch: RAW_BRANCH,
    session_name: 'Fix the payments retry loop',
    account_uuid: 'acct-uuid-1',
    account_email: ' Dev@example.com ',
    agent_name: 'Scout',
    beeziPrivate: ['tenant-1'],
    token_total: 42,
    ...over,
  };
}

test('anonymize — every shared vector case', () => {
  for (const c of vectors.cases) {
    assert.equal(RUNNERS[c.fn](c), c.expected, JSON.stringify(c));
  }
});

test('anonValue — anon:<kind>:<32 lowercase hex>', () => {
  assert.match(anonValue(KEY, 'repo', 'github.com/acme/payments'), /^anon:repo:[0-9a-f]{32}$/);
});

test('isAnonValue — only the exact wire shape of a known kind', () => {
  assert.equal(isAnonValue('anon:repo:5c565a8dd7e9ae8c634d8776d5892e65'), true);
  assert.equal(isAnonValue('anon:repo:5C565A8DD7E9AE8C634D8776D5892E65'), false);
  assert.equal(isAnonValue('anon:team:5c565a8dd7e9ae8c634d8776d5892e65'), false);
  assert.equal(isAnonValue('anon:repo:5c565a8d'), false);
  assert.equal(isAnonValue(null), false);
});

test('anon helpers — already anonymized values pass through', () => {
  const branch = expectedFor({ fn: 'branch', remote: RAW_REMOTE, branch: RAW_BRANCH });
  const host = expectedFor({ fn: 'host' });
  const session = expectedFor({ fn: 'session' });
  assert.equal(anonBranch(KEY, RAW_REMOTE, branch), branch);
  assert.equal(anonHost(KEY, host), host);
  assert.equal(anonSession(KEY, session), session);
});

test('anonRemote — the local: prefix is case-insensitive', () => {
  assert.equal(anonRemote(KEY, 'LOCAL:My Project'), anonValue(KEY, 'folder', 'My Project'));
});

test('anonBranch — an anonymized remote scopes the branch by its own value', () => {
  const anonRepo = anonRemote(KEY, RAW_REMOTE);
  assert.equal(anonBranch(KEY, anonRepo, 'main'), anonValue(KEY, 'branch', `${anonRepo}\0main`));
});

test('anonBranch — no remote scopes the branch by the empty string', () => {
  assert.equal(anonBranch(KEY, null, 'main'), anonValue(KEY, 'branch', '\0main'));
  assert.equal(anonBranch(KEY, RAW_REMOTE, ''), '');
});

test('anonymizeReport — vector values, no agent_name or marker, opaque uuid kept', () => {
  const out = anonymizeReport(rawReport(), KEY, KINDS);
  assert.equal(out.remote, expectedFor({ fn: 'remote', input: RAW_REMOTE }));
  assert.equal(out.branch, expectedFor({ fn: 'branch', remote: RAW_REMOTE, branch: RAW_BRANCH }));
  assert.equal(out.session_name, expectedFor({ fn: 'session', input: SESSION_ID }));
  assert.equal(out.account_email, expectedFor({ fn: 'account', input: ' Dev@example.com ' }));
  assert.equal(out.sessionId, SESSION_ID);
  assert.equal(out.account_uuid, 'acct-uuid-1');
  assert.equal(out.token_total, 42);
  assert.equal('agent_name' in out, false);
  assert.equal('beeziPrivate' in out, false);
});

test('anonymizeReport — returns a copy and leaves the input untouched', () => {
  const raw = rawReport();
  const before = JSON.parse(JSON.stringify(raw));
  anonymizeReport(raw, KEY, KINDS);
  assert.deepEqual(raw, before);
});

test('anonymizeReport — idempotent on its own output', () => {
  const once = anonymizeReport(rawReport(), KEY, KINDS);
  assert.deepEqual(anonymizeReport(once, KEY, KINDS), once);
});

test('anonymizeReport — a null or absent session_name and account_email stay as they are', () => {
  const nulled = anonymizeReport(rawReport({ session_name: null, account_email: null }), KEY, KINDS);
  assert.equal(nulled.session_name, null);
  assert.equal(nulled.account_email, null);
  const { session_name, account_email, ...bare } = rawReport();
  const absent = anonymizeReport(bare, KEY, KINDS);
  assert.equal('session_name' in absent, false);
  assert.equal('account_email' in absent, false);
});

test('anonymizeReport — pass-through remote and branch stay raw', () => {
  const out = anonymizeReport(rawReport({ remote: 'local:unknown', branch: 'HEAD' }), KEY, KINDS);
  assert.equal(out.remote, 'local:unknown');
  assert.equal(out.branch, 'HEAD');
});

function kindsReport() {
  return {
    sessionId: SESSION_ID,
    remote: RAW_REMOTE,
    branch: RAW_BRANCH,
    session_name: 'x',
    account_email: 'Dev@example.com',
    agent_name: 'Euclid',
    beeziPrivate: { t1: ['repos'] },
  };
}

test('KINDS — the five wire keys in order, frozen', () => {
  assert.deepEqual([...KINDS], ['repos', 'branches', 'sessions', 'hosts', 'accounts']);
  assert.equal(Object.isFrozen(KINDS), true);
});

test('anonBranch — a raw or anonymized remote gives the same branch value', () => {
  const anonFolder = anonRemote(KEY, 'local:my-project');
  assert.equal(anonBranch(KEY, RAW_REMOTE, RAW_BRANCH), anonBranch(KEY, anonRemote(KEY, RAW_REMOTE), RAW_BRANCH));
  assert.equal(anonBranch(KEY, 'local:my-project', 'main'), anonBranch(KEY, anonFolder, 'main'));
});

test('anonymizeReport — only branches on hashes the branch alone and drops the marker', () => {
  const out = anonymizeReport(kindsReport(), KEY, ['branches']);
  assert.equal(out.remote, RAW_REMOTE);
  assert.equal(out.branch, 'anon:branch:49ed152043496c368ff991f9c951620d');
  assert.equal(out.session_name, 'x');
  assert.equal(out.agent_name, 'Euclid');
  assert.equal(out.account_email, 'Dev@example.com');
  assert.equal('beeziPrivate' in out, false);
});

test('anonymizeReport — every kind on hashes each field and drops agent_name', () => {
  const out = anonymizeReport(kindsReport(), KEY, KINDS);
  assert.equal(out.remote, 'anon:repo:5c565a8dd7e9ae8c634d8776d5892e65');
  assert.equal(out.branch, 'anon:branch:49ed152043496c368ff991f9c951620d');
  assert.equal(out.account_email, 'anon:account:23ec58d88a2c08f9f953d5430218b2d7');
  assert.equal(out.session_name, expectedFor({ fn: 'session', input: SESSION_ID }));
  assert.equal('agent_name' in out, false);
  assert.equal('beeziPrivate' in out, false);
});

test('anonymizeReport — no kinds on returns the payload without the marker', () => {
  const { beeziPrivate, ...expected } = kindsReport();
  assert.deepEqual(anonymizeReport(kindsReport(), KEY, []), expected);
});

test('anonymizeReport — sessions alone hashes session_name and drops agent_name only', () => {
  const out = anonymizeReport(kindsReport(), KEY, ['sessions']);
  assert.equal(out.session_name, expectedFor({ fn: 'session', input: SESSION_ID }));
  assert.equal('agent_name' in out, false);
  assert.equal(out.remote, RAW_REMOTE);
  assert.equal(out.branch, RAW_BRANCH);
  assert.equal(out.account_email, 'Dev@example.com');
});

test('anonymizeUsage and anonymizeAccountSync — the email stays raw without accounts', () => {
  assert.deepEqual(anonymizeUsage({ account_email: 'a@b.c' }, KEY, ['repos']), { account_email: 'a@b.c' });
  assert.deepEqual(anonymizeAccountSync({ email: 'a@b.c' }, KEY, ['repos', 'hosts']), { email: 'a@b.c' });
});

test('anonymizeUsage — hashes account_email and keeps the rest', () => {
  const body = { account_uuid: 'acct-uuid-1', account_email: ' Dev@example.com ', primary_used_percent: 12 };
  assert.deepEqual(anonymizeUsage(body, KEY, KINDS), {
    account_uuid: 'acct-uuid-1',
    account_email: expectedFor({ fn: 'account', input: ' Dev@example.com ' }),
    primary_used_percent: 12,
  });
  assert.equal(body.account_email, ' Dev@example.com ');
  assert.deepEqual(anonymizeUsage({ account_uuid: 'acct-uuid-1' }, KEY, KINDS), { account_uuid: 'acct-uuid-1' });
});

test('anonymizeAccountSync — hashes email to the same value as a report account_email', () => {
  const body = { accountUuid: 'acct-uuid-1', email: 'dev@EXAMPLE.com', subscriptionType: 'plus' };
  assert.deepEqual(anonymizeAccountSync(body, KEY, KINDS), {
    accountUuid: 'acct-uuid-1',
    email: expectedFor({ fn: 'account', input: ' Dev@example.com ' }),
    subscriptionType: 'plus',
  });
  assert.deepEqual(anonymizeAccountSync({ accountUuid: 'acct-uuid-1' }, KEY, KINDS), { accountUuid: 'acct-uuid-1' });
});

test('scrubSessionError — drops both text fields and keeps resetsAt', () => {
  const body = {
    sessionId: SESSION_ID,
    error: 'rate_limit',
    occurredAt: '2026-10-21T10:00:00.000Z',
    resetsAt: '2026-10-21T13:30:00.000Z',
    errorDetails: 'You hit your limit',
    lastAssistantMessage: 'Working on payments…',
  };
  assert.deepEqual(scrubSessionError(body), {
    sessionId: SESSION_ID,
    error: 'rate_limit',
    occurredAt: '2026-10-21T10:00:00.000Z',
    resetsAt: '2026-10-21T13:30:00.000Z',
  });
  assert.equal(body.errorDetails, 'You hit your limit');
});
