import '../tools/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouteContext, rulesTableLines } from '../lib/workspace-rules.mjs';
import { TrackingMode, writeTrackingState } from '../lib/tracking.mjs';

const REPO = '/work/labacus-suite';
const REMOTE = 'github.com/acme/labacus-suite';
const MAP = { version: 1, roots: { [REPO]: { origin: `https://${REMOTE}.git` } } };
const ctx = () => createRouteContext({ loadRepoMapImpl: () => MAP });
const A = { id: 'A', name: 'Acme' };
const N = { id: 'N', name: 'Northwind' };
const HEADER = '| Rule | Repo or folder | Path or remote | Sends to | Last 30 days | |';
const SEPARATOR = '|---|---|---|---|---|---|';
const RULES = [
  { kind: 'repo', match: REMOTE, tenantIds: ['A', 'N'] },
  { kind: 'folder', match: '/work/scratch', tenantIds: [] },
];
const SINGLE = 'e5f6a7b8';
const multi = (newFolders, workspaceRules = []) => ({ key: 'a1b2c3d4', status: 'linked', tenants: [A, N], newFolders, workspaceRules });
const now = Date.now();
const entry = (sessionId, cwd) => ({ sessionId, cwd, mtimeMs: now - 2 * 60 * 60 * 1000, size: 10 });

test('the table says where you are, counts recent sessions and marks your row', () => {
  const entries = [entry('s1', `${REPO}/src`), entry('s2', '/work/client'), entry('s3', '/work/scratch/notes')];
  const row = multi({ mode: 'send', tenantIds: ['A'] }, RULES);
  assert.deepEqual(rulesTableLines([row], `${REPO}/src`, ctx(), { entries, now }), [
    `You're in **labacus-suite**, a git repo at ${REPO}.`,
    'Rule R1 sends its analytics to Acme and Northwind.',
    '',
    HEADER, SEPARATOR,
    `| R1 | labacus-suite | ${REMOTE} | Acme and Northwind | 1 session | ← you're here |`,
    '| R2 | scratch | /work/scratch | not tracked | 1 session | |',
    '| Default | new repos and folders | | Acme | 1 session | |',
  ]);
});

test('with no rules the Default row is the whole table, and asking says so', () => {
  assert.deepEqual(rulesTableLines([multi(null)], '/work/client', ctx(), { entries: [] }).slice(0, 2), [
    "You're in **client**, a folder at /work/client.",
    'It has no rule yet. Beezi asks where its analytics go when a session starts here.',
  ]);
  assert.equal(rulesTableLines([multi(null)], '/work/client', ctx(), { entries: [] }).pop(),
    "| Default | new repos and folders | | ask me | 0 sessions | ← you're here |");
});

test('a rule for a workspace the account left still shows, marked ignored', () => {
  const row = multi({ mode: 'send', tenantIds: ['A'] }, [{ kind: 'repo', match: REMOTE, tenantIds: ['GONE'] }]);
  // Routing skips the ignored rule, so its session counts for Default.
  const lines = rulesTableLines([row], REPO, ctx(), { entries: [entry('s1', REPO)], now });
  assert.ok(lines.includes(`| R1 | labacus-suite | ${REMOTE} | Ignored (workspace left) | 0 sessions | |`), lines.join('\n'));
  assert.equal(lines[lines.length - 1], "| Default | new repos and folders | | Acme | 1 session | ← you're here |");
  const single = { key: 'a1b2c3d4', status: 'linked', tenants: [A], workspaceRules: [{ kind: 'repo', match: REMOTE, tenantIds: ['GONE'] }] };
  const one = rulesTableLines([single], REPO, ctx(), { entries: [] });
  assert.ok(one.includes(`| R1 | labacus-suite | ${REMOTE} | Ignored (workspace left) | 0 sessions | |`), one.join('\n'));
  assert.equal(one[one.length - 1], "| Default | every repo and folder | | Acme | 0 sessions | ← you're here |");
});

test('with live tracking off a one-workspace table says new sessions are not sent, and keeps the table', () => {
  writeTrackingState(SINGLE, { trackingMode: TrackingMode.BACKFILL_ONLY });
  const lines = rulesTableLines([{ key: SINGLE, status: 'linked', tenants: [A] }], '/work/client', ctx(), { entries: [] });
  assert.deepEqual(lines, [
    "You're in **client**, a folder at /work/client.",
    'Live tracking is off for this workspace, so new sessions are not sent; these rules apply when history is uploaded.',
    '',
    HEADER, SEPARATOR,
    "| Default | every repo and folder | | Acme | 0 sessions | ← you're here |",
  ]);
  const ruled = rulesTableLines([{ key: SINGLE, status: 'linked', tenants: [A], workspaceRules: [{ ...RULES[0], tenantIds: [] }] }], REPO, ctx(), { entries: [] });
  assert.equal(ruled[1], 'Rule R1 stops tracking it: nothing is sent.');
});

// Spec §5: Codex says "thread" where the other plugins say "session".
test('with no account\'s workspaces known, the table asks for a new Codex thread', () => {
  const unknown = { key: 'a1b2c3d4', status: 'linked', tenants: null, workspaceRules: [] };
  assert.deepEqual(rulesTableLines([unknown], REPO, ctx(), { entries: [] }), [
    'Rules need the account\'s workspaces, which are not known yet. Start a new Codex thread and try again.',
  ]);
});
