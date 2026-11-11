import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTranscriptMemo } from '../lib/transcript-memo-codex.mjs';

function countingReader() {
  const calls = [];
  const readLines = (transcriptPath) => {
    calls.push(transcriptPath);
    return { lineCount: 0, completeLines: 0, records: [], path: transcriptPath };
  };
  return { calls, readLines };
}

test('reads once per path', () => {
  const reader = countingReader();
  const memo = createTranscriptMemo({ readLines: reader.readLines });
  const first = memo.readLines('/a.jsonl');
  assert.equal(memo.readLines('/a.jsonl'), first);
  assert.deepEqual(reader.calls, ['/a.jsonl']);
});

test('a failed read is retried', () => {
  let fail = true;
  const memo = createTranscriptMemo({
    readLines: () => {
      if (fail) throw new Error('EBUSY');
      return { lineCount: 0, completeLines: 0, records: [] };
    },
  });
  assert.throws(() => memo.readLines('/a.jsonl'), /EBUSY/);
  fail = false;
  assert.deepEqual(memo.readLines('/a.jsonl'), { lineCount: 0, completeLines: 0, records: [] });
});

test('a second path replaces the first', () => {
  const reader = countingReader();
  const memo = createTranscriptMemo({ readLines: reader.readLines });
  memo.readLines('/a.jsonl');
  assert.equal(memo.readLines('/b.jsonl').path, '/b.jsonl');
  memo.readLines('/b.jsonl');
  memo.readLines('/a.jsonl');
  assert.deepEqual(reader.calls, ['/a.jsonl', '/b.jsonl', '/a.jsonl']);
});

const RESUME = { line: 1, byte: 24, size: 24, head: 'h' };

test('readTail cuts the cached whole read instead of reading again', () => {
  const reader = countingReader();
  const tails = [];
  const sliced = [];
  const memo = createTranscriptMemo({
    readLines: reader.readLines,
    readTail: (p) => { tails.push(p); return null; },
    sliceLines: (lines, resume) => { sliced.push([lines.path, resume.byte]); return { cut: true }; },
  });
  memo.readLines('/a.jsonl');
  assert.deepEqual(memo.readTail('/a.jsonl', RESUME), { cut: true });
  assert.deepEqual(reader.calls, ['/a.jsonl']);
  assert.deepEqual(tails, []);
  assert.deepEqual(sliced, [['/a.jsonl', 24]]);
});

test('readTail without a cached read of that path reads the tail from disk and caches nothing', () => {
  const reader = countingReader();
  const tails = [];
  const memo = createTranscriptMemo({
    readLines: reader.readLines,
    readTail: (p, resume) => { tails.push([p, resume.byte]); return { tail: p }; },
  });
  memo.readLines('/a.jsonl');
  assert.deepEqual(memo.readTail('/b.jsonl', RESUME), { tail: '/b.jsonl' });
  assert.deepEqual(tails, [['/b.jsonl', 24]]);
  assert.equal(memo.peek('/b.jsonl'), null);
  assert.equal(memo.peek('/a.jsonl').path, '/a.jsonl');
});
