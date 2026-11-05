// The one place that knows a Codex rollout may be plain (`.jsonl`) or zstd-compressed
// (`.jsonl.zst`). Codex compresses rollouts older than 7 days in place — zstd level 3, frame
// header carries the content size, plain file deleted, mtime kept — and decompresses back to the
// same `.jsonl` name when the session is resumed.
//
// Leaf module: imports only fs and zlib. transcript-codex / session-name-codex import this, so it
// must never import them back.
//
// zlib.zstdDecompressSync is absent on most Node versions this plugin supports (Node 13.2 floor),
// so it is reached only through feature detection on a default import — never a named import,
// which would fail to link. `deps.decompress` is the test seam: the key present with `null`
// simulates a Node without zstd.
import fs from 'fs';
import zlib from 'zlib';

export const ROLLOUT_RE = /^rollout-.*\.jsonl(\.zst)?$/;

// rollout-<ISO-with-dashes>-<uuid>.jsonl[.zst] — the session id is the trailing UUID (its internal
// dashes make a greedy suffix capture wrong).
const TRAILING_UUID_RE = /-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl(\.zst)?$/;

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

// Accepts a basename or a full path; the pattern is anchored at the end. Case is preserved.
export function rolloutIdFromName(name) {
  if (typeof name !== 'string') return null;
  const m = TRAILING_UUID_RE.exec(name);
  return m ? m[1] : null;
}

// Compressed by NAME. Listing and dedupe decide on this without opening the file; reading decides
// by magic bytes (isZstdBuffer).
export function isCompressedRolloutName(p) {
  return String(p).endsWith('.zst');
}

// Two rollouts carrying one session id (a Codex resume): does the candidate supersede the current
// pick? A plain file beats a compressed one whatever the mtimes — a resume decompresses back to
// `.jsonl`, so a surviving `.zst` is the stale copy — and between two of a kind the newer wins.
export function rolloutSupersedes(candidatePath, candidateMtimeMs, currentPath, currentMtimeMs) {
  const candidateZ = isCompressedRolloutName(candidatePath);
  const currentZ = isCompressedRolloutName(currentPath);
  return candidateZ !== currentZ ? currentZ : candidateMtimeMs > currentMtimeMs;
}

export function isZstdBuffer(buf) {
  if (!buf || buf.length < 4) return false;
  for (let i = 0; i < 4; i += 1) if (buf[i] !== ZSTD_MAGIC[i]) return false;
  return true;
}

function decompressFn(deps) {
  if (deps && Object.prototype.hasOwnProperty.call(deps, 'decompress')) {
    return typeof deps.decompress === 'function' ? deps.decompress : null;
  }
  return typeof zlib.zstdDecompressSync === 'function' ? zlib.zstdDecompressSync : null;
}

export function zstdSupported(deps = {}) {
  return decompressFn(deps) !== null;
}

// The one line sync and backfill print for the .zst rollouts this Node skipped. zstd arrived in
// Node 22.15 and 23.8: Node 23.0-23.7 have none, so "22.15 or newer" alone would be wrong.
export function compressedSkippedLine(count) {
  return `Skipped ${count} compressed Codex sessions: reading them needs Node 22.15+ (or 23.8+).`;
}

// Whole file as bytes, decompressed when it is a zstd frame (by magic bytes, not by name). Read
// errors propagate like fs.readFileSync. Null when the file is zstd but this Node cannot
// decompress it, or the frame is corrupt.
export function readRolloutBuffer(path, deps = {}) {
  const raw = fs.readFileSync(path);
  if (!isZstdBuffer(raw)) return raw;
  const decompress = decompressFn(deps);
  if (!decompress) return null;
  try {
    return decompress(raw);
  } catch (_) {
    return null;
  }
}

function readPrefix(fd, len) {
  const buf = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const n = fs.readSync(fd, buf, got, len - got, got);
    if (n <= 0) break;
    got += n;
  }
  return got === len ? buf : buf.slice(0, got);
}

// First maxBytes of the decompressed rollout without inflating the whole file. A zstd stream
// decoded from a truncated prefix with ZSTD_e_flush returns what the prefix decodes to instead of
// throwing, so a head scan costs a few hundred KB of work, not the whole session. Null when the
// file is zstd this Node cannot decode, or corrupt. Read errors propagate like fs.readFileSync.
export function readRolloutHeadBuffer(path, maxBytes, deps = {}) {
  const fd = fs.openSync(path, 'r');
  let size;
  let prefix;
  try {
    size = fs.fstatSync(fd).size;
    prefix = readPrefix(fd, Math.min(size, maxBytes));
  } finally {
    fs.closeSync(fd);
  }
  if (!isZstdBuffer(prefix)) return prefix;
  const decompress = decompressFn(deps);
  if (!decompress) return null;
  if (!(zlib.constants && typeof zlib.constants.ZSTD_e_flush === 'number')) {
    const whole = readRolloutBuffer(path, deps);
    return whole === null ? null : whole.subarray(0, maxBytes);
  }
  const opts = { finishFlush: zlib.constants.ZSTD_e_flush };
  let len = prefix.length;
  let buf = prefix;
  for (;;) {
    const complete = len >= size;
    let out = null;
    try {
      out = decompress(buf, opts);
    } catch (_) {
      if (complete) return null;
    }
    if (out !== null && (out.length >= maxBytes || complete)) return out.subarray(0, maxBytes);
    // Short output from a partial prefix (or a decode error on one): widen it. A failed or
    // short prefix of at least the file size cannot happen here, so this always terminates.
    len = out === null ? size : Math.min(size, len * 2);
    const fd2 = fs.openSync(path, 'r');
    try {
      buf = readPrefix(fd2, len);
    } finally {
      fs.closeSync(fd2);
    }
  }
}

export function readRolloutText(path, deps = {}) {
  const buf = readRolloutBuffer(path, deps);
  return buf === null ? null : buf.toString('utf-8');
}

// Every record of a rollout, plain or compressed, oldest first; blank and malformed (torn) lines
// are skipped. Null when the file is zstd this Node cannot decode, or corrupt. Read errors
// propagate like fs.readFileSync.
export function readRolloutRecords(path, deps = {}) {
  const text = readRolloutText(path, deps);
  if (text === null) return null;
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (_) { /* torn or malformed line */ }
  }
  return out;
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (_) {
    return false;
  }
}

// A rollout path that may have flipped between plain and compressed since it was recorded.
export function resolveRolloutPath(p) {
  if (typeof p !== 'string' || !p) return null;
  if (isFile(p)) return p;
  if (p.endsWith('.jsonl') && isFile(p + '.zst')) return p + '.zst';
  if (p.endsWith('.jsonl.zst')) {
    const plain = p.slice(0, -'.zst'.length);
    if (isFile(plain)) return plain;
  }
  return null;
}

// Decompressed size, from the zstd frame header (RFC 8878 §3.1.1.1) so a compressed rollout is
// never inflated just to be measured. Plain file, or a frame with no content size: stat.size.
export function rolloutContentSize(path) {
  const size = fs.statSync(path).size;
  const head = Buffer.alloc(18);
  const fd = fs.openSync(path, 'r');
  let n = 0;
  try {
    n = fs.readSync(fd, head, 0, 18, 0);
  } finally {
    fs.closeSync(fd);
  }
  const buf = head.slice(0, n);
  if (!isZstdBuffer(buf) || n < 5) return size;
  const desc = buf[4];
  const fcsFlag = desc >> 6;
  const single = (desc >> 5) & 1;
  const fcsBytes = fcsFlag === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][fcsFlag];
  if (fcsBytes === 0) return size;
  const dictBytes = [0, 1, 2, 4][desc & 3];
  const off = 5 + (single ? 0 : 1) + dictBytes;
  if (n < off + fcsBytes) return size;
  if (fcsBytes === 1) return buf[off];
  if (fcsBytes === 2) return buf.readUInt16LE(off) + 256;
  if (fcsBytes === 4) return buf.readUInt32LE(off);
  return buf.readUInt32LE(off) + buf.readUInt32LE(off + 4) * 4294967296;
}
