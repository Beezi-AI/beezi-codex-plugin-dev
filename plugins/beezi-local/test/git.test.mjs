import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskFromBranch, sanitizeRemote, canonicalRemote, TASK_BRANCH_RE } from '../lib/git.mjs';

test('taskFromBranch — extracts task token from a task branch', () => {
  assert.equal(taskFromBranch('feature/task-abc-123'), 'task-abc-123');
  assert.equal(taskFromBranch('beezi/task-PROJ_9'), 'task-PROJ_9');
});

test('taskFromBranch — null when the branch does not fit', () => {
  assert.equal(taskFromBranch('main'), null);
  assert.equal(taskFromBranch('feature/no-task-here'), null);
  assert.equal(taskFromBranch('task-abc'), null); // needs a leading segment before task-
  assert.equal(taskFromBranch(''), null);
  assert.equal(taskFromBranch(undefined), null);
});

test('taskFromBranch — agrees with TASK_BRANCH_RE (checkpoint filter)', () => {
  for (const branch of ['x/task-1', 'main', 'feat/task-a_b-c', 'nope']) {
    assert.equal(Boolean(taskFromBranch(branch)), TASK_BRANCH_RE.test(branch));
  }
});

test('sanitizeRemote — strips credentials from the URL', () => {
  assert.equal(
    sanitizeRemote('https://user:tok@host/acme/repo.git'),
    'https://host/acme/repo.git',
  );
});

const REMOTE_CASES = [
  // unchanged today — must stay byte-identical
  ['https://user:tok@host/acme/repo.git', 'https://host/acme/repo.git'],
  ['https://TOKEN@github.com/o/r.git', 'https://github.com/o/r.git'],
  ['https://oauth2:glpat-xxx@gitlab.com/g/r.git', 'https://gitlab.com/g/r.git'],
  ['https://org@dev.azure.com/org/proj/_git/repo', 'https://dev.azure.com/org/proj/_git/repo'],
  ['https://u:p%40x@host/r', 'https://host/r'],
  ['ssh://git@host/o/r.git', 'ssh://host/o/r.git'],
  ['git@github.com:o/r.git', 'git@github.com:o/r.git'],
  ['github.com:o/r.git', 'github.com:o/r.git'],
  ['https://Dev.Azure.com/Org/Proj/_git/Repo', 'https://Dev.Azure.com/Org/Proj/_git/Repo'],
  ['https://host:8443/r.git', 'https://host:8443/r.git'],
  // newly handled
  ['https://host/o/r.git?token=abc', 'https://host/o/r.git'],
  ['https://host/o/r.git?access_token=abc&x=1', 'https://host/o/r.git'],
  ['https://host/o/r.git#tok', 'https://host/o/r.git'],
  ['https://u:t@host/o/r.git?private_token=z', 'https://host/o/r.git'],
  ['C:/Users/me/src/repo', 'local:repo'],
  ['C:\\Users\\me\\src\\repo\\', 'local:repo'],
  ['/home/me/src/repo.git', 'local:repo.git'],
  ['../other', 'local:other'],
  ['file:///home/me/repo', 'local:repo'],
  ['\\\\server\\share\\repo', 'local:repo'],
];
test('sanitizeRemote — table', () => {
  for (const [input, want] of REMOTE_CASES) assert.equal(sanitizeRemote(input), want, input);
});

// The `hashed` values of the repo rows in test/fixtures/anonymization-vectors.json.
const CANONICAL_REMOTE_CASES = [
  ['git@github.com:Acme/Payments.git', 'github.com/acme/payments'],
  ['https://github.com/acme/payments', 'github.com/acme/payments'],
  ['https://user:tok@github.com/acme/payments.git/', 'github.com/acme/payments'],
  ['HTTPS://GitHub.com/Acme/Payments', 'github.com/acme/payments'],
  ['https://www.github.com/acme/payments', 'github.com/acme/payments'],
  ['ssh://git@ssh.github.com:443/acme/payments.git', 'github.com/acme/payments'],
  ['ssh://git@altssh.gitlab.com:443/group/sub/proj.git', 'gitlab.com/group/sub/proj'],
  ['git@ssh.dev.azure.com:v3/org/proj/repo', 'dev.azure.com/org/proj/repo'],
  ['org@vs-ssh.visualstudio.com:v3/org/proj/repo', 'dev.azure.com/org/proj/repo'],
  ['https://org@dev.azure.com/org/proj/_git/repo', 'dev.azure.com/org/proj/repo'],
  ['https://org.visualstudio.com/DefaultCollection/proj/_git/repo', 'dev.azure.com/org/proj/repo'],
  ['https://dev.azure.com/org/_git/repo', 'dev.azure.com/org/repo/repo'],
  ['https://gitlab.example.com:8443/team/app.git?x=1#frag', 'gitlab.example.com/team/app'],
  ['github.com/Acme/Payments.git', 'github.com/acme/payments.git'],
];
test('canonicalRemote — table', () => {
  for (const [input, want] of CANONICAL_REMOTE_CASES) assert.equal(canonicalRemote(input), want, input);
});
