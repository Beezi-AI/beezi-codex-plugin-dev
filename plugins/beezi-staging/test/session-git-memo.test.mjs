import '../tools/hermetic-env.mjs';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createGitMemo } from '../lib/session-git-memo.mjs';
import { runCheckpoint } from '../lib/checkpoint.mjs';
import { queueDir } from '../lib/paths.mjs';
import { forgetHeldLocks } from '../lib/single-instance-lock.mjs';
import { tmpHome as sandboxHome } from '../tools/suite-fixtures.mjs';
import { linkAccount, TEST_KEY } from '../tools/account-fixtures.mjs';

// The session's git memo (lib/session-git-memo.mjs): repo root, branch and remote, reused while
// the files git itself answers from are unchanged.

afterEach(() => forgetHeldLocks());

const tmpHome = (t) => sandboxHome(t, 'beezi-gitmemo-');

function gitRepo(home, name = 'repo') {
  const repo = path.join(home, name);
  fs.mkdirSync(path.join(repo, '.git', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(repo, '.git', 'logs', 'HEAD'), 'one\n');
  fs.writeFileSync(path.join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://host/org/repo.git\n');
  return repo;
}

const EVENTS = [{ ms: 1767225600000, from: 'main', to: 'feature' }];

// ── The memo on its own ────────────────────────────────────────────────────────────────────────

test('a remembered root, branch and remote are answered back while the checkout is unchanged', (t) => {
  const home = tmpHome(t);
  const repo = gitRepo(home);
  const sub = path.join(repo, 'src');
  fs.mkdirSync(sub);
  const memo = createGitMemo(undefined);
  memo.setRoot(sub, repo);
  memo.setBranch(repo, 'main', EVENTS);
  memo.setRemote(repo, 'https://host/org/repo.git');

  const again = createGitMemo(JSON.parse(JSON.stringify(memo.value)));

  assert.equal(memo.isDirty(), true);
  assert.equal(again.isDirty(), false);
  assert.equal(again.root(sub), repo);
  assert.deepEqual(again.branch(repo), { branch: 'main', events: EVENTS });
  assert.equal(again.remote(repo), 'https://host/org/repo.git');
});

test('a moved HEAD forgets the branch but keeps the remote', (t) => {
  const home = tmpHome(t);
  const repo = gitRepo(home);
  const memo = createGitMemo(undefined);
  memo.setBranch(repo, 'main', EVENTS);
  memo.setRemote(repo, 'https://host/org/repo.git');
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/feature\n');

  const again = createGitMemo(memo.value);

  assert.equal(again.branch(repo), null);
  assert.equal(again.remote(repo), 'https://host/org/repo.git');
});

test('a changed config forgets the remote but keeps the branch', (t) => {
  const home = tmpHome(t);
  const repo = gitRepo(home);
  const memo = createGitMemo(undefined);
  memo.setBranch(repo, 'main', EVENTS);
  memo.setRemote(repo, 'https://host/org/repo.git');
  fs.appendFileSync(path.join(repo, '.git', 'config'), '[core]\n\tbare = false\n');

  const again = createGitMemo(memo.value);

  assert.equal(again.remote(repo), null);
  assert.deepEqual(again.branch(repo), { branch: 'main', events: EVENTS });
});

test('a directory that became a repository of its own mid-session re-resolves', (t) => {
  const home = tmpHome(t);
  const repo = gitRepo(home);
  const nested = path.join(repo, 'vendor', 'lib');
  fs.mkdirSync(nested, { recursive: true });
  const memo = createGitMemo(undefined);
  memo.setRoot(nested, repo);
  assert.equal(createGitMemo(memo.value).root(nested), repo, 'remembered before the nested .git');
  fs.writeFileSync(path.join(nested, '.git'), 'gitdir: ../../.git/modules/lib\n');

  assert.equal(createGitMemo(memo.value).root(nested), null);
});

// A repository created mid-session BETWEEN the directory and its remembered root owns the directory
// now: outer/nested/src was remembered under outer, and outer/nested became a checkout.
const ANCESTOR_CASES = [
  ['a .git directory', (dir) => fs.mkdirSync(path.join(dir, '.git'))],
  ['a gitdir: pointer file', (dir) => fs.writeFileSync(path.join(dir, '.git'), 'gitdir: ../.git/worktrees/nested\n')],
];
for (const [what, makeGit] of ANCESTOR_CASES) {
  test(`a directory under a new repository between it and its remembered root re-resolves (${what})`, (t) => {
    const home = tmpHome(t);
    const outer = gitRepo(home, 'outer');
    const nested = path.join(outer, 'nested');
    const src = path.join(nested, 'src');
    fs.mkdirSync(src, { recursive: true });
    const memo = createGitMemo(undefined);
    memo.setRoot(src, outer);
    assert.equal(createGitMemo(memo.value).root(src), outer, 'remembered before the nested repository');
    makeGit(nested);

    assert.equal(createGitMemo(memo.value).root(src), null);
  });
}

// A root that is no ancestor of the directory, under either spelling, cannot be checked for a
// repository created in between: it is a miss, and git is asked again.
test('a remembered root that is no ancestor of the directory, even resolved, is a miss', (t) => {
  const home = tmpHome(t);
  const repo = gitRepo(home, 'a');
  const src = path.join(repo, 'src');
  fs.mkdirSync(src);
  const elsewhere = gitRepo(home, 'b');
  const memo = createGitMemo(undefined);
  memo.setRoot(src, elsewhere);

  assert.equal(createGitMemo(memo.value).root(src), null);
});

test('a remembered directory that no longer exists is a miss', (t) => {
  const home = tmpHome(t);
  const repo = gitRepo(home, 'a');
  const other = gitRepo(home, 'b');
  const gone = path.join(other, 'gone');
  const memo = createGitMemo({ dirs: { [gone]: repo }, roots: {} });

  assert.equal(memo.root(gone), null);
});

// A directory reached through a junction (Windows) or a symlink: the cwd is spelled through the
// alias and git answers the real root, so no textual walk joins them. Both are resolved, and the
// walk between them runs on the real paths.
function linkDir(t, target, link) {
  try {
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch (error) {
    if (error && error.code === 'EPERM') { t.skip('this machine cannot create a directory link'); return false; }
    throw error;
  }
}

const ALIAS_CASES = [
  ['the directory is spelled through the alias', ({ alias, real }) => ({ dir: path.join(alias, 'nested', 'src'), root: real })],
  ['the root is spelled through the alias', ({ alias, real }) => ({ dir: path.join(real, 'nested', 'src'), root: alias })],
];
for (const [what, spell] of ALIAS_CASES) {
  test(`a directory under its root through a link stays remembered while nothing changed (${what})`, (t) => {
    const home = tmpHome(t);
    const real = gitRepo(home, 'real');
    fs.mkdirSync(path.join(real, 'nested', 'src'), { recursive: true });
    const alias = path.join(home, 'alias');
    if (!linkDir(t, real, alias)) return;
    const { dir, root } = spell({ alias, real });
    const memo = createGitMemo(undefined);
    memo.setRoot(dir, root);

    assert.equal(createGitMemo(memo.value).root(dir), root);
  });

  test(`a repository created between a linked directory and its root re-resolves (${what})`, (t) => {
    const home = tmpHome(t);
    const real = gitRepo(home, 'real');
    fs.mkdirSync(path.join(real, 'nested', 'src'), { recursive: true });
    const alias = path.join(home, 'alias');
    if (!linkDir(t, real, alias)) return;
    const { dir, root } = spell({ alias, real });
    const memo = createGitMemo(undefined);
    memo.setRoot(dir, root);
    fs.mkdirSync(path.join(real, 'nested', '.git'));

    assert.equal(createGitMemo(memo.value).root(dir), null);
  });
}

test('the root itself is remembered as its own root', (t) => {
  const home = tmpHome(t);
  const repo = gitRepo(home);
  const memo = createGitMemo(undefined);
  memo.setRoot(repo, repo);

  assert.equal(createGitMemo(memo.value).root(repo), repo);
});

test('nothing is remembered for a root without readable git metadata', (t) => {
  const home = tmpHome(t);
  const plain = path.join(home, 'plain');
  fs.mkdirSync(plain);
  const memo = createGitMemo(undefined);
  memo.setRoot(plain, plain);
  memo.setBranch(plain, 'main', EVENTS);
  memo.setRemote(plain, 'https://host/org/repo.git');

  assert.equal(memo.isDirty(), false);
  assert.deepEqual(memo.value, { dirs: {}, roots: {} });
});

test('a worktree is keyed on its own HEAD and on the common config', (t) => {
  const home = tmpHome(t);
  const main = gitRepo(home);
  const wtGit = path.join(main, '.git', 'worktrees', 'wt');
  fs.mkdirSync(path.join(wtGit, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(wtGit, 'HEAD'), 'ref: refs/heads/wt\n');
  fs.writeFileSync(path.join(wtGit, 'commondir'), '../..\n');
  const wt = path.join(home, 'wt');
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${wtGit}\n`);
  const memo = createGitMemo(undefined);
  memo.setBranch(wt, 'wt', []);
  memo.setRemote(wt, 'https://host/org/repo.git');
  fs.appendFileSync(path.join(main, '.git', 'config'), '[core]\n\tbare = false\n');
  fs.writeFileSync(path.join(main, '.git', 'HEAD'), 'ref: refs/heads/other\n');

  const again = createGitMemo(memo.value);

  assert.deepEqual(again.branch(wt), { branch: 'wt', events: [] }, 'the main checkout HEAD is not the worktree HEAD');
  assert.equal(again.remote(wt), null, 'the common config changed');
});

test('a branch with more than 200 checkout events is not remembered', (t) => {
  const home = tmpHome(t);
  const repo = gitRepo(home);
  const memo = createGitMemo(undefined);
  const many = Array.from({ length: 201 }, (_, i) => ({ ms: i, from: 'a', to: 'b' }));
  memo.setBranch(repo, 'main', many);

  assert.equal(memo.branch(repo), null);
});

test('a stored value that is not a memo starts empty', () => {
  for (const stored of [null, 'x', [], { dirs: [] }, { dirs: {}, roots: 3 }]) {
    assert.deepEqual(createGitMemo(stored).value, { dirs: {}, roots: {} });
  }
});

// ── Through the checkpoint ─────────────────────────────────────────────────────────────────────
// Repeated checkpoints of one session must not respawn git for an unchanged checkout.

const seg = (fromLine, toLine) => ({
  repoRoot: '/repo',
  branch: 'main',
  fromLine,
  toLine,
  stats: {
    models: { 'gpt-5.2-codex': { token_input: 10, token_output: 5, token_cache_read: 0, token_cache_creation: 0, requests: 1 } },
    token_total: 15, token_input: 10, token_output: 5, token_cache: 0,
    duration_sec: 12,
    code_changes: { files_changed: 0, lines_added: 0, lines_removed: 0, by_extension: {} },
    operations: {},
    started_at: '2026-01-01T00:00:00.000Z',
    ended_at: '2026-01-01T00:00:12.000Z',
  },
});

const queueFiles = () => fs.readdirSync(queueDir(TEST_KEY)).sort()
  .map((f) => JSON.parse(fs.readFileSync(path.join(queueDir(TEST_KEY), f), 'utf-8')));

function world(home, over = {}) {
  const transcriptPath = path.join(home, 'rollout-s1.jsonl');
  fs.writeFileSync(transcriptPath, '\n');
  return {
    deps: {
      fetchImpl: async () => { throw new Error('offline'); },
      resolveTranscript: () => ({ transcriptPath, sessionId: 's1' }),
      resolveSessionName: () => 'fix the login bug',
      maybeSpawnUploadWorker: () => 'disabled',
      ...over,
    },
  };
}

const POST_TOOL_USE = { localOnly: true, emitTimeline: false, budgetMs: 17500 };

// Answers the four calls a checkpoint makes, and records each one's first two arguments. `repo` is
// the top level git names, or a function answering it per call.
function countingGit(repo, branch = () => 'main') {
  const calls = [];
  const impl = (args) => {
    calls.push(args.slice(0, 2).join(' '));
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return typeof repo === 'function' ? repo() : repo;
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return branch();
    if (args[0] === 'reflog') return '';
    if (args[0] === 'remote') return 'https://host/org/repo.git';
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  impl.calls = calls;
  return impl;
}

// A delta that resolves its one segment's repo and branch through the checkpoint's resolvers, as
// the real computeDelta does per line. Each call bills a fresh window so every run enqueues.
function resolvingDelta(repo) {
  let n = 0;
  return (p, cursor, resolvers) => {
    n += 1;
    const root = resolvers.repoRootOf(repo);
    const branch = resolvers.branchAt(root, Date.parse('2026-01-01T00:00:00.000Z'));
    return { nextCursor: n * 4, segments: [{ ...seg(n * 4 - 3, n * 4), repoRoot: root, branch }], apiErrorEvents: [] };
  };
}

test('a second checkpoint of an unchanged checkout spawns no git', async (t) => {
  const home = tmpHome(t);
  linkAccount(home);
  const repo = gitRepo(home);
  const gitImpl = countingGit(repo);
  const { deps } = world(home, { gitImpl, computeDelta: resolvingDelta(repo) });

  await runCheckpoint({ session_id: 's1', cwd: repo }, deps, POST_TOOL_USE);
  const first = gitImpl.calls.length;
  await runCheckpoint({ session_id: 's1', cwd: repo }, deps, POST_TOOL_USE);

  assert.equal(first, 4);
  assert.equal(gitImpl.calls.length, 4);
  assert.deepEqual(queueFiles().map((p) => `${p.segmentId} ${p.branch} ${p.remote}`), [
    's1:1-4 main https://host/org/repo.git',
    's1:5-8 main https://host/org/repo.git',
  ]);
});

test('a moved HEAD re-reads the branch and the reflog, and nothing else', async (t) => {
  const home = tmpHome(t);
  linkAccount(home);
  const repo = gitRepo(home);
  let branch = 'main';
  const gitImpl = countingGit(repo, () => branch);
  const { deps } = world(home, { gitImpl, computeDelta: resolvingDelta(repo) });

  await runCheckpoint({ session_id: 's1', cwd: repo }, deps, POST_TOOL_USE);
  branch = 'feature';
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/feature\n');
  fs.appendFileSync(path.join(repo, '.git', 'logs', 'HEAD'), 'two\n');
  const before = gitImpl.calls.length;
  await runCheckpoint({ session_id: 's1', cwd: repo }, deps, POST_TOOL_USE);

  assert.deepEqual(gitImpl.calls.slice(before).sort(), ['reflog --date=iso-strict', 'rev-parse --abbrev-ref']);
  assert.deepEqual(queueFiles().map((p) => `${p.segmentId} ${p.branch}`), ['s1:1-4 main', 's1:5-8 feature']);
});

test('a changed repository config re-reads the remote', async (t) => {
  const home = tmpHome(t);
  linkAccount(home);
  const repo = gitRepo(home);
  const gitImpl = countingGit(repo);
  const { deps } = world(home, { gitImpl, computeDelta: resolvingDelta(repo) });

  await runCheckpoint({ session_id: 's1', cwd: repo }, deps, POST_TOOL_USE);
  fs.appendFileSync(path.join(repo, '.git', 'config'), '[core]\n\tbare = false\n');
  const before = gitImpl.calls.length;
  await runCheckpoint({ session_id: 's1', cwd: repo }, deps, POST_TOOL_USE);

  assert.deepEqual(gitImpl.calls.slice(before), ['remote get-url']);
});

test('a repository created between the cwd and its remembered root is asked of git again', async (t) => {
  const home = tmpHome(t);
  linkAccount(home);
  const outer = gitRepo(home, 'outer');
  const nested = path.join(outer, 'nested');
  const src = path.join(nested, 'src');
  fs.mkdirSync(src, { recursive: true });
  let top = outer;
  const gitImpl = countingGit(() => top);
  const seen = [];
  let n = 0;
  const computeDelta = (p, cursor, resolvers) => {
    n += 1;
    seen.push(resolvers.repoRootOf(src));
    return { nextCursor: n * 4, segments: [seg(n * 4 - 3, n * 4)], apiErrorEvents: [] };
  };
  const { deps } = world(home, { gitImpl, computeDelta });

  await runCheckpoint({ session_id: 's1', cwd: src }, deps, POST_TOOL_USE);
  fs.mkdirSync(path.join(nested, '.git', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(nested, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(nested, '.git', 'config'), '');
  top = nested;
  await runCheckpoint({ session_id: 's1', cwd: src }, deps, POST_TOOL_USE);

  assert.deepEqual(seen, [outer, nested]);
  assert.equal(gitImpl.calls.filter((c) => c === 'rev-parse --show-toplevel').length, 2);
});

test('a directory with no readable git metadata is never remembered', async (t) => {
  const home = tmpHome(t);
  linkAccount(home);
  const repo = path.join(home, 'not-a-checkout');
  fs.mkdirSync(repo);
  const gitImpl = countingGit(repo);
  const { deps } = world(home, { gitImpl, computeDelta: resolvingDelta(repo) });

  await runCheckpoint({ session_id: 's1', cwd: repo }, deps, POST_TOOL_USE);
  await runCheckpoint({ session_id: 's1', cwd: repo }, deps, POST_TOOL_USE);

  assert.equal(gitImpl.calls.length, 8);
});

// Minor 2: only an origin read from the repository itself (git, or its config file) is remembered —
// the machine-wide repo map's fallback answers a blocked git and must be asked again next time.
test('an origin that only the repo map knew is not remembered', async (t) => {
  const home = tmpHome(t);
  linkAccount(home);
  const repo = gitRepo(home);
  fs.writeFileSync(path.join(repo, '.git', 'config'), '[core]\n\tbare = false\n');
  const calls = [];
  const gitImpl = (args) => {
    calls.push(args.slice(0, 2).join(' '));
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return repo;
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'main';
    if (args[0] === 'reflog') return '';
    throw new Error('git is blocked');
  };
  const repoMapFile = path.join(home, 'repo-map.json');
  fs.writeFileSync(repoMapFile, JSON.stringify({ version: 1, roots: { [repo.replace(/\\/g, '/')]: { origin: 'https://host/org/mapped.git', lastSeen: '2026-01-01T00:00:00.000Z' } } }));
  const { deps } = world(home, { gitImpl, computeDelta: resolvingDelta(repo) });

  await runCheckpoint({ session_id: 's1', cwd: repo }, deps, POST_TOOL_USE);
  const before = calls.length;
  await runCheckpoint({ session_id: 's1', cwd: repo }, deps, POST_TOOL_USE);

  assert.deepEqual(calls.slice(before), ['remote get-url']);
  assert.deepEqual(queueFiles().map((p) => p.remote), ['https://host/org/mapped.git', 'https://host/org/mapped.git']);
});

// git prints the top level with forward slashes (`C:/…`) while the session cwd is `C:\…`, and the
// root holds a `.git`: the nested-checkout check must compare the two as one path, or the root
// answers a miss — and respawns git — on every checkpoint.
const forwardSlashes = (p) => p.replace(/\\/g, '/');
const lowerDrive = (p) => p.replace(/^([A-Za-z]):/, (m, d) => `${d.toLowerCase()}:`);

const spellings = [{ name: 'forward slashes', spell: forwardSlashes }];
if (process.platform === 'win32') {
  spellings.push({ name: 'forward slashes and a lowercase drive letter', spell: (p) => lowerDrive(forwardSlashes(p)) });
}

for (const { name, spell } of spellings) {
  test(`the root git prints with ${name} is still the cwd's own root`, (t) => {
    const home = tmpHome(t);
    const repo = gitRepo(home);
    const memo = createGitMemo(undefined);
    memo.setRoot(repo, spell(repo));

    assert.equal(createGitMemo(memo.value).root(repo), spell(repo));
  });

  test(`a second checkpoint spawns no git when git prints the root with ${name}`, async (t) => {
    const home = tmpHome(t);
    linkAccount(home);
    const repo = gitRepo(home);
    const gitImpl = countingGit(spell(repo));
    const { deps } = world(home, { gitImpl, computeDelta: resolvingDelta(repo) });

    await runCheckpoint({ session_id: 's1', cwd: repo }, deps, POST_TOOL_USE);
    const first = gitImpl.calls.length;
    await runCheckpoint({ session_id: 's1', cwd: repo }, deps, POST_TOOL_USE);

    assert.equal(first, 4);
    assert.equal(gitImpl.calls.length, 4);
  });
}
