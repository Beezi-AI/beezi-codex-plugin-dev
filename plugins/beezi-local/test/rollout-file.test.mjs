import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import {
  ROLLOUT_RE,
  rolloutIdFromName,
  isZstdBuffer,
  zstdSupported,
  readRolloutBuffer,
  readRolloutText,
  readRolloutHeadBuffer,
  compressedSkippedLine,
  resolveRolloutPath,
  rolloutContentSize,
} from '../lib/rollout-file.mjs';

const NO_ZSTD = { skip: typeof zlib.zstdCompressSync !== 'function' };
const ID = '01a1530c-555b-7681-a2d9-bc7adf66b723';
const NAME = `rollout-2026-10-19T10-24-39-${ID}.jsonl`;
const TEXT = '{"type":"session_meta","payload":{"id":"x"}}\n{"type":"event_msg"}\n{"type":"turn_context"}\n';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-file-'));
}

test('round trip: plain and zst give the same text', NO_ZSTD, () => {
  const d = tmp();
  const plain = path.join(d, NAME);
  const zst = plain + '.zst';
  fs.writeFileSync(plain, TEXT);
  fs.writeFileSync(zst, zlib.zstdCompressSync(Buffer.from(TEXT)));
  assert.equal(readRolloutText(plain), TEXT);
  assert.equal(readRolloutText(zst), TEXT);
});

test('decompress null: zst unreadable, plain still read', NO_ZSTD, () => {
  const d = tmp();
  const plain = path.join(d, NAME);
  const zst = plain + '.zst';
  fs.writeFileSync(plain, TEXT);
  fs.writeFileSync(zst, zlib.zstdCompressSync(Buffer.from(TEXT)));
  assert.equal(readRolloutText(zst, { decompress: null }), null);
  assert.equal(readRolloutBuffer(zst, { decompress: null }), null);
  assert.equal(readRolloutText(plain, { decompress: null }), TEXT);
});

test('detection is by magic bytes, not name', NO_ZSTD, () => {
  const d = tmp();
  const p = path.join(d, NAME);
  fs.writeFileSync(p, zlib.zstdCompressSync(Buffer.from(TEXT)));
  assert.equal(readRolloutText(p), TEXT);
});

test('injected decompress is used', () => {
  const d = tmp();
  const p = path.join(d, NAME);
  fs.writeFileSync(p, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3]));
  assert.equal(readRolloutText(p, { decompress: () => Buffer.from('hi') }), 'hi');
});

test('corrupt zst returns null without throwing', NO_ZSTD, () => {
  const d = tmp();
  const p = path.join(d, NAME + '.zst');
  fs.writeFileSync(p, Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from('garbage garbage garbage')]));
  assert.equal(readRolloutText(p), null);
});

test('missing file throws like readFileSync', () => {
  assert.throws(() => readRolloutBuffer(path.join(tmp(), 'nope.jsonl')), { code: 'ENOENT' });
});

test('rolloutIdFromName', () => {
  assert.equal(rolloutIdFromName(NAME), ID);
  assert.equal(rolloutIdFromName(NAME + '.zst'), ID);
  assert.equal(rolloutIdFromName(path.join('some', 'dir', NAME + '.zst')), ID);
  assert.equal(rolloutIdFromName(`rollout-x-${ID.toUpperCase()}.jsonl`), ID.toUpperCase());
  assert.equal(rolloutIdFromName('notes.txt'), null);
  assert.equal(rolloutIdFromName('rollout-2026.jsonl'), null);
  assert.equal(rolloutIdFromName(null), null);
});

test('ROLLOUT_RE', () => {
  assert.ok(ROLLOUT_RE.test(NAME));
  assert.ok(ROLLOUT_RE.test(NAME + '.zst'));
  assert.ok(!ROLLOUT_RE.test('rollout-x.json'));
  assert.ok(!ROLLOUT_RE.test('rollout-x.jsonl.tmp'));
});

test('isZstdBuffer', () => {
  assert.equal(isZstdBuffer(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0])), true);
  assert.equal(isZstdBuffer(Buffer.from('{"a"')), false);
  assert.equal(isZstdBuffer(Buffer.alloc(2)), false);
  assert.equal(isZstdBuffer(null), false);
});

test('zstdSupported', () => {
  assert.equal(zstdSupported({ decompress: null }), false);
  assert.equal(zstdSupported({ decompress: () => null }), true);
  assert.equal(zstdSupported(), typeof zlib.zstdDecompressSync === 'function');
});

test('resolveRolloutPath', NO_ZSTD, () => {
  const d = tmp();
  const plain = path.join(d, NAME);
  fs.writeFileSync(plain, TEXT);
  assert.equal(resolveRolloutPath(plain), plain);
  fs.rmSync(plain);
  fs.writeFileSync(plain + '.zst', 'x');
  assert.equal(resolveRolloutPath(plain), plain + '.zst');
  fs.writeFileSync(plain, TEXT);
  fs.rmSync(plain + '.zst');
  assert.equal(resolveRolloutPath(plain + '.zst'), plain);
  fs.rmSync(plain);
  assert.equal(resolveRolloutPath(plain), null);
  assert.equal(resolveRolloutPath(plain + '.zst'), null);
  assert.equal(resolveRolloutPath(''), null);
  assert.equal(resolveRolloutPath(null), null);
});

test('rolloutContentSize', NO_ZSTD, () => {
  const d = tmp();
  const plain = path.join(d, NAME);
  fs.writeFileSync(plain, TEXT);
  assert.equal(rolloutContentSize(plain), Buffer.byteLength(TEXT));
  for (const n of [0, 1, 200, 300, 70000]) {
    const body = Buffer.from('a'.repeat(n));
    const zst = path.join(d, `s${n}.jsonl.zst`);
    fs.writeFileSync(zst, zlib.zstdCompressSync(body));
    assert.equal(rolloutContentSize(zst), n, `size ${n}`);
  }
});

test('rolloutContentSize falls back to stat.size when frame has no content size', () => {
  const d = tmp();
  const p = path.join(d, 'x.jsonl.zst');
  // descriptor 0x00: no single-segment, fcs flag 0 -> size unknown; window byte follows
  fs.writeFileSync(p, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x58, 1, 2, 3]));
  assert.equal(rolloutContentSize(p), 9);
});

// --- readRolloutHeadBuffer ---
function bigText() {
  const lines = [];
  for (let i = 0; i < 12000; i += 1) lines.push(JSON.stringify({ type: 'event_msg', i, pad: 'x'.repeat(60 + (i % 37)) }));
  return lines.join('\n') + '\n';
}

test('readRolloutHeadBuffer: plain file reads at most maxBytes', () => {
  const d = tmp();
  const f = path.join(d, NAME);
  fs.writeFileSync(f, TEXT);
  assert.equal(readRolloutHeadBuffer(f, 10).toString('utf-8'), TEXT.slice(0, 10));
  assert.equal(readRolloutHeadBuffer(f, 1 << 20).toString('utf-8'), TEXT);
});

test('readRolloutHeadBuffer: large zst gives the first maxBytes of the raw text', NO_ZSTD, () => {
  const d = tmp();
  const raw = bigText();
  assert.ok(raw.length > 1 << 20);
  const f = path.join(d, NAME + '.zst');
  fs.writeFileSync(f, zlib.zstdCompressSync(raw));
  for (const max of [100, 64 * 1024, 1 << 20]) {
    assert.equal(readRolloutHeadBuffer(f, max).toString('utf-8'), raw.slice(0, max), `max=${max}`);
  }
});

test('readRolloutHeadBuffer: maxBytes beyond the raw size returns the whole text', NO_ZSTD, () => {
  const d = tmp();
  const raw = bigText();
  const f = path.join(d, NAME + '.zst');
  fs.writeFileSync(f, zlib.zstdCompressSync(raw));
  assert.equal(readRolloutHeadBuffer(f, raw.length * 2).toString('utf-8'), raw);
});

test('readRolloutHeadBuffer: a decompress seam that ignores opts still gives a correct head', NO_ZSTD, () => {
  const d = tmp();
  const raw = bigText();
  const f = path.join(d, NAME + '.zst');
  fs.writeFileSync(f, zlib.zstdCompressSync(raw));
  const out = readRolloutHeadBuffer(f, 4096, { decompress: (b) => zlib.zstdDecompressSync(b) });
  assert.equal(out.toString('utf-8'), raw.slice(0, 4096));
});

test('readRolloutHeadBuffer: no zstd support gives null; corrupt frame gives null', NO_ZSTD, () => {
  const d = tmp();
  const f = path.join(d, NAME + '.zst');
  fs.writeFileSync(f, zlib.zstdCompressSync(TEXT));
  assert.equal(readRolloutHeadBuffer(f, 100, { decompress: null }), null);
  const bad = path.join(d, 'bad.jsonl.zst');
  fs.writeFileSync(bad, Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.alloc(64, 7)]));
  assert.equal(readRolloutHeadBuffer(bad, 100), null);
});

// One definition of the line sync and backfill print. Node 23.0-23.7 have no zstd, so "22.15 or
// newer" was wrong for them.
test('compressedSkippedLine: the exact CLI line, defined once', () => {
  assert.equal(compressedSkippedLine(3),
    'Skipped 3 compressed Codex sessions: reading them needs Node 22.15+ (or 23.8+).');
  const scripts = fileURLToPath(new URL('../scripts/', import.meta.url));
  for (const name of ['sync.mjs', 'backfill.mjs']) {
    const src = fs.readFileSync(path.join(scripts, name), 'utf-8');
    assert.ok(src.indexOf('compressed Codex sessions') === -1, `${name} defines its own copy`);
    assert.ok(src.indexOf('compressedSkippedLine(') !== -1, `${name} uses the shared line`);
  }
});
