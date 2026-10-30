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
