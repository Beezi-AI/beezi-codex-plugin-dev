import fs from 'fs';
import path from 'path';
import { gitDirsOf, samePath } from './repo-map.mjs';

// The session's git memo — across checkpoints, unlike lib/git-memo.mjs, which memoizes git calls
// within ONE history run. A checkpoint resolves each directory's repo root, each root's branch
// (HEAD plus the checkout reflog) and its origin remote — four git spawns, ~50-100 ms each on
// Windows, on every checkpoint that read new lines. lib/checkpoint.mjs keeps them in the session
// state (`state.gitMemo`) and reuses them while the files git itself answers from are unchanged:
// the HEAD file and the HEAD reflog for the branch (a commit, checkout or switch appends to the
// reflog, so a boundary always invalidates it), the repository config for the remote. Anything that
// cannot be read means no memo, and the caller takes the git path. `.git` may be a worktree's or a
// submodule's `gitdir:` pointer file (gitDirsOf in lib/repo-map.mjs).
//
// What the caller remembers is its own decision: it should only set a value git (or the repo's own
// files) answered, never a fallback that stands in for a failed git.

export const GIT_MEMO_MAX_DIRS = 32;
export const GIT_MEMO_MAX_ROOTS = 8;
// More checkout events than this and the branch is not remembered: the memo is rewritten with the
// state on every checkpoint, and the reflog read holds up to 1000.
export const GIT_MEMO_MAX_EVENTS = 200;

const isRecord = (value) => value != null && typeof value === 'object' && !Array.isArray(value);

// size:mtime, 'none' for a file that does not exist (a repo with no reflog yet), null when unreadable.
function fileSignature(file) {
  try {
    const stat = fs.statSync(file);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch (error) {
    return error && error.code === 'ENOENT' ? 'none' : null;
  }
}

// { head, config } for a repo root, or null when its git metadata cannot be read.
export function gitSignature(root) {
  const dirs = gitDirsOf(root);
  if (dirs === null) return null;
  let head;
  try { head = fs.readFileSync(path.join(dirs.gitDir, 'HEAD'), 'utf-8').trim(); } catch { return null; }
  const log = fileSignature(path.join(dirs.gitDir, 'logs', 'HEAD'));
  const config = fileSignature(path.join(dirs.commonDir, 'config'));
  if (log === null || config === null) return null;
  return { head: `${head}|${log}`, config };
}

// The directories from `dir` up to, not including, `root`; null when `root` is not one of `dir`'s
// textual ancestors (or `dir` itself). Pure string work, no filesystem call.
function levelsBelow(dir, root) {
  const levels = [];
  let current = dir;
  while (!samePath(current, root)) {
    levels.push(current);
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return levels;
}

function realPathOf(p) {
  try { return fs.realpathSync.native(p); } catch { return null; }
}

// Whether `root` may no longer own `dir`: a `.git` (a directory, or a worktree's or submodule's
// pointer file) exists in `dir` or in any directory between it and `root` — one existsSync per
// level — or the two cannot be shown to be ancestor and descendant. A root spelled differently
// from `dir` (a junction, a symlink, a subst drive, an 8.3 name, git's realpath) is no textual
// ancestor, so only then are both resolved and the walk runs on the real paths; a walk on the
// spellings as given would reach the repository's own `.git` under the other spelling, or never
// look at the directories in between. Ancestry still unknown, or a path that no longer resolves,
// is a miss: git is asked again.
function newCheckoutBelow(dir, root) {
  let levels = levelsBelow(dir, root);
  if (levels === null) {
    const realDir = realPathOf(dir);
    const realRoot = realPathOf(root);
    if (realDir === null || realRoot === null) return true;
    levels = levelsBelow(realDir, realRoot);
    if (levels === null) return true;
  }
  return levels.some((level) => fs.existsSync(path.join(level, '.git')));
}

// The memo over a stored value (anything else starts empty). `isDirty()` once something was
// learned; the caller writes `value` back into the state then. Signatures are read once per memo,
// so one memo serves one checkpoint run.
export function createGitMemo(stored) {
  const value = isRecord(stored) && isRecord(stored.dirs) && isRecord(stored.roots)
    ? { dirs: { ...stored.dirs }, roots: { ...stored.roots } }
    : { dirs: {}, roots: {} };
  const signatures = new Map();
  let dirty = false;
  const signatureOf = (root) => {
    if (!signatures.has(root)) signatures.set(root, gitSignature(root));
    return signatures.get(root);
  };
  // Oldest entry out when a new key would pass the cap.
  const makeRoom = (object, key, max) => {
    const keys = Object.keys(object);
    if (!Object.prototype.hasOwnProperty.call(object, key) && keys.length >= max) delete object[keys[0]];
  };
  const entryFor = (root) => {
    if (!isRecord(value.roots[root])) {
      makeRoom(value.roots, root, GIT_MEMO_MAX_ROOTS);
      value.roots[root] = {};
    }
    return value.roots[root];
  };
  const fresh = (root) => {
    const signature = signatureOf(root);
    const entry = signature === null ? null : value.roots[root];
    return isRecord(entry) ? { signature, entry } : null;
  };
  return {
    value,
    isDirty: () => dirty,
    // The remembered root for `dir`, while that root still has readable git metadata and neither
    // `dir` nor any directory between it and the root has become a checkout of its own (a nested
    // repo, worktree or submodule created mid-session).
    root(dir) {
      const root = value.dirs[dir];
      if (typeof root !== 'string' || signatureOf(root) === null) return null;
      if (newCheckoutBelow(dir, root)) return null;
      return root;
    },
    setRoot(dir, root) {
      if (typeof root !== 'string' || root === '' || value.dirs[dir] === root || signatureOf(root) === null) return;
      makeRoom(value.dirs, dir, GIT_MEMO_MAX_DIRS);
      value.dirs[dir] = root;
      dirty = true;
    },
    branch(root) {
      const known = fresh(root);
      if (known === null || known.entry.head !== known.signature.head) return null;
      if (typeof known.entry.branch !== 'string' || !Array.isArray(known.entry.events)) return null;
      return { branch: known.entry.branch, events: known.entry.events };
    },
    setBranch(root, branch, events) {
      const signature = signatureOf(root);
      if (signature === null || events.length > GIT_MEMO_MAX_EVENTS) return;
      const entry = entryFor(root);
      entry.head = signature.head;
      entry.branch = branch;
      entry.events = events;
      dirty = true;
    },
    remote(root) {
      const known = fresh(root);
      if (known === null || known.entry.config !== known.signature.config) return null;
      return typeof known.entry.remote === 'string' ? known.entry.remote : null;
    },
    setRemote(root, remote) {
      const signature = signatureOf(root);
      if (signature === null) return;
      const entry = entryFor(root);
      entry.config = signature.config;
      entry.remote = remote;
      dirty = true;
    },
  };
}
