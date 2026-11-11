import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ONE DRAINER, pinned on the source: the live queue is sent by the background upload worker and by
// the two terminal drains that hold its lock (track, and sync's drain before reconciliation) —
// never by a hook or the MCP watcher. A behaviour test proves one path; this proves there is no
// other one, including a new caller added later.

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Whole-line comments and trailing ` // …` comments, so prose about flushQueue( never counts.
const stripComments = (src) => src.split('\n')
  .map((line) => (/^\s*(\/\/|\/\*|\*)/.test(line) ? '' : line.replace(/\s\/\/\s.*$/, '')))
  .join('\n');

function sources() {
  const out = [];
  for (const dir of ['lib', 'scripts']) {
    for (const name of fs.readdirSync(path.join(root, dir)).filter((n) => n.endsWith('.mjs'))) {
      out.push({ file: `${dir}/${name}`, src: stripComments(fs.readFileSync(path.join(root, dir, name), 'utf-8')) });
    }
  }
  return out;
}

// Every call matching `name` (a regex source, the callee) in `src`, declarations excluded, with
// its balanced argument text and where it ends.
function calls(src, name) {
  const found = [];
  const re = new RegExp(`\\b${name}\\(`, 'g');
  let m;
  while ((m = re.exec(src)) !== null) {
    if (/function\s+$/.test(src.slice(Math.max(0, m.index - 10), m.index))) continue;
    let depth = 0;
    let end = src.indexOf('(', m.index);
    do {
      if (src[end] === '(') depth += 1;
      if (src[end] === ')') depth -= 1;
      end += 1;
    } while (depth > 0 && end < src.length);
    found.push({ at: m.index, end, text: src.slice(m.index, end).replace(/\s+/g, ' ') });
  }
  return found;
}

// True when `at` lies inside the argument text of a withUploadLock call (imported as is or as `_withUploadLock`).
function insideUploadLock(src, at) {
  return calls(src, '_?withUploadLock').some((c) => at > c.at && at < c.end);
}

// The callers that may send the queue. lib/checkpoint.mjs drains inside a NON-local runCheckpoint,
// which only the worker and the track drain run (pinned below).
const ALLOWED = ['lib/checkpoint.mjs', 'lib/queue-flush.mjs', 'lib/session-audit.mjs', 'lib/upload-worker.mjs'];

test('flushQueue( is called only by the worker, the queue module, the checkpoint and the locked sync drain', () => {
  const callers = sources().filter(({ src }) => calls(src, 'flushQueue').length > 0).map(({ file }) => file);
  // queue-flush.mjs declares it; the other three call it, so the scan is not blind.
  for (const file of ALLOWED.filter((f) => f !== 'lib/queue-flush.mjs')) assert.ok(callers.indexOf(file) !== -1, `${file} still drains`);
  assert.deepEqual(callers.filter((f) => ALLOWED.indexOf(f) === -1), []);
});

test('nothing outside those modules imports flushQueue, so no alias can drain either', () => {
  const importers = sources()
    // A static import of the binding, or the worker's lazy `(await import('./checkpoint.mjs')).flushQueue`.
    .filter(({ src }) => /import\s*\{[^}]*\bflushQueue\b[^}]*\}/.test(src) || /import\([^)]*\)\)\.flushQueue\b/.test(src))
    .map(({ file }) => file);
  assert.deepEqual(importers.filter((f) => ALLOWED.indexOf(f) === -1), []);
});

test("session-audit's drain runs inside withUploadLock", () => {
  const { src } = sources().find((s) => s.file === 'lib/session-audit.mjs');
  const drains = calls(src, 'flushQueue');
  assert.equal(drains.length, 1);
  assert.ok(insideUploadLock(src, drains[0].at), drains[0].text);
});

// A non-local runCheckpoint drains (lib/checkpoint.mjs), so every other caller asks it not to.
test('every runCheckpoint( outside the worker is localOnly or skipFlush, or runs inside withUploadLock', () => {
  const offenders = [];
  let tracked = 0;
  for (const { file, src } of sources()) {
    if (file === 'lib/checkpoint.mjs' || file === 'lib/upload-worker.mjs') continue;
    for (const c of calls(src, 'runCheckpoint')) {
      if (/\blocalOnly: true\b/.test(c.text) || /\bskipFlush: true\b/.test(c.text)) continue;
      if (file === 'lib/track-session.mjs' && insideUploadLock(src, c.at)) { tracked += 1; continue; }
      offenders.push(`${file}: ${c.text}`);
    }
  }
  assert.deepEqual(offenders, []);
  assert.equal(tracked, 1, 'the track drain is the one locked non-local checkpoint');
});

test('the watcher drains nothing: every checkpoint is local-only and its history audits pass drainQueue false', () => {
  const { src } = sources().find((s) => s.file === 'lib/rollout-watcher.mjs');
  assert.equal(calls(src, 'flushQueue').length, 0);
  const audits = calls(src, 'runAudit');
  assert.equal(audits.length, 4);
  assert.deepEqual(audits.filter((c) => !/\bdrainQueue: false, queuedBefore,? \}\)$/.test(c.text)), []);
});

// reconcileSession's drain step defaults to the real flushQueue (lib/checkpoint.mjs), an alias the
// flushQueue( scan above cannot see. So every caller must hand it a drain step of its own.
test('every reconcileSession( caller passes its own flushQueue drain step', () => {
  const found = [];
  for (const { file, src } of sources()) {
    if (file === 'lib/checkpoint.mjs') continue;
    for (const c of calls(src, 'reconcileSession\\)?')) found.push({ file, passes: /\bflushQueue: /.test(c.text) });
  }
  assert.deepEqual(found, [{ file: 'lib/rollout-watcher.mjs', passes: true }]);
});
