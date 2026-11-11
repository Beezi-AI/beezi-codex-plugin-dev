import crypto from 'crypto';
import fs from 'fs';
import { isZstdBuffer, readRolloutBuffer } from './rollout-file.mjs';

const MAX_LINE_BYTES = 256 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;
// How much of a rollout's head identifies it to a byte cursor (rolloutHeadHash).
const HEAD_HASH_BYTES = 4096;
const OUTPUT_TYPE_RE = /_output$/;
const FILE_CHANGE = 'FileChange';
// Payload keys no consumer reads: reasoning ciphertext, compaction history, images, session prompts.
const DROPPED_PAYLOAD_KEYS = ['encrypted_content', 'replacement_history', 'images', 'base_instructions', 'dynamic_tools'];
// The result fields timeline-waits-codex.mjs reads from a question or wait call's output.
const WAIT_OUTPUT_KEYS = ['accepted', 'answers', 'error'];
// Heavy item_completed item fields no consumer reads, by item type.
const DROPPED_ITEM_KEYS = new Map([
  ['CommandExecution', ['aggregated_output']],
  ['McpToolCall', ['result']],
  [FILE_CHANGE, ['stdout', 'stderr']],
  ['Extension', ['results']],
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pick(source, keys) {
  const out = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

function omit(source, keys) {
  const out = { ...source };
  for (const key of keys) delete out[key];
  return out;
}

// operations-codex.mjs estimates a call's tokens from this.
function outputBytes(output) {
  if (typeof output === 'string') return Buffer.byteLength(output, 'utf-8');
  if (output == null) return 0;
  return Buffer.byteLength(JSON.stringify(output), 'utf-8');
}

function parseOrUndefined(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

function waitOutput(output) {
  const parsed = isObject(output) ? output : parseOrUndefined(output);
  if (!isObject(parsed)) return undefined;
  const slim = pick(parsed, WAIT_OUTPUT_KEYS);
  return Object.keys(slim).length ? slim : undefined;
}

// Claude's rule: strip exactly one trailing newline, then split.
function lineCount(s) {
  if (typeof s !== 'string' || s === '') return 0;
  return s.replace(/\n$/, '').split('\n').length;
}

// '+'/'-' lines from the first hunk header on; no '+++'/'---' guard inside a hunk, those are real lines.
function unifiedDiffCounts(diff) {
  const counts = { added: 0, removed: 0 };
  if (typeof diff !== 'string' || diff === '') return counts;
  let inHunk = false;
  for (const rawLine of diff.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.startsWith('@@')) { inHunk = true; continue; }
    if (!inHunk) continue;
    if (line.startsWith('+')) counts.added += 1;
    else if (line.startsWith('-')) counts.removed += 1;
  }
  return counts;
}

function changeLineCounts(change) {
  if (change.type === 'update') return unifiedDiffCounts(change.unified_diff);
  if (change.type === 'add') return { added: lineCount(change.content), removed: 0 };
  if (change.type === 'delete') return { added: 0, removed: lineCount(change.content) };
  return { added: 0, removed: 0 };
}

// Each change keeps its type and move_path; the diff or file text becomes linesAdded/linesRemoved.
function projectChanges(changes) {
  const out = {};
  for (const filePath of Object.keys(changes)) {
    const change = changes[filePath];
    if (!isObject(change)) {
      out[filePath] = change;
      continue;
    }
    const { added, removed } = changeLineCounts(change);
    out[filePath] = { ...omit(change, ['unified_diff', 'content']), linesAdded: added, linesRemoved: removed };
  }
  return out;
}

function projectItem(item) {
  const slim = omit(item, DROPPED_ITEM_KEYS.get(item.type) || []);
  if (item.type === FILE_CHANGE && isObject(item.changes)) slim.changes = projectChanges(item.changes);
  return slim;
}

function projectBlock(block) {
  return isObject(block) && typeof block.text !== 'string' ? { type: block.type } : block;
}

function projectPayload(payload) {
  const slim = omit(payload, DROPPED_PAYLOAD_KEYS);
  if (OUTPUT_TYPE_RE.test(payload.type)) {
    delete slim.output;
    slim.outputBytes = outputBytes(payload.output);
    const wait = waitOutput(payload.output);
    if (wait !== undefined) slim.output = wait;
  }
  if (payload.type === 'message' && Array.isArray(payload.content)) slim.content = payload.content.map(projectBlock);
  if (payload.type === 'patch_apply_end' && isObject(payload.changes)) slim.changes = projectChanges(payload.changes);
  if (payload.type === 'item_completed' && isObject(payload.item)) slim.item = projectItem(payload.item);
  return slim;
}

// The record minus what no consumer reads; output sizes and edit line counts ride along precomputed.
export function projectRolloutRecord(record) {
  if (!isObject(record) || !isObject(record.payload)) return record;
  return { ...record, payload: projectPayload(record.payload) };
}

// Calls onLine(buf, start, end, oversize, terminated, lineEnd) per `\n`-split line of the open file
// from byte `fromByte` up to `size`, the unterminated last one included when non-empty. `lineEnd` is
// the absolute offset just past the line's newline, -1 for the unterminated last line. `seed` holds
// bytes already read from `fromByte` on (the head), so they are not read twice.
function forEachLine(fd, size, fromByte, seed, { chunkBytes = CHUNK_BYTES, maxLineBytes = MAX_LINE_BYTES } = {}, onLine) {
  let buf = Buffer.alloc(Math.max(chunkBytes, seed.length));
  seed.copy(buf, 0);
  let start = 0;
  let end = seed.length;
  let pos = fromByte + seed.length;
  // File offset of buf[0].
  let bufBase = fromByte;
  let oversize = false;
  for (;;) {
    const nl = buf.subarray(0, end).indexOf(NEWLINE, start);
    if (nl !== -1) {
      onLine(buf, start, nl, oversize || nl - start > maxLineBytes, true, bufBase + nl + 1);
      oversize = false;
      start = nl + 1;
      continue;
    }
    if (end - start > maxLineBytes) oversize = true;
    if (oversize) {
      start = 0;
      end = 0;
      bufBase = pos;
    } else {
      buf.copy(buf, 0, start, end);
      end -= start;
      bufBase += start;
      start = 0;
      if (end === buf.length) {
        const grown = Buffer.alloc(buf.length * 2);
        buf.copy(grown, 0, 0, end);
        buf = grown;
      }
    }
    if (pos >= size) break;
    const read = fs.readSync(fd, buf, end, Math.min(buf.length - end, size - pos), pos);
    if (read === 0) break;
    pos += read;
    end += read;
  }
  if (oversize || end > start) onLine(buf, start, end, oversize, false, -1);
}

// forEachLine over a rollout already in memory (a decompressed `.jsonl.zst`): the same lines, the
// same oversize rule, the same unterminated last line. No byte offsets: they would be offsets into
// the decompressed stream, which no reader can seek to on disk.
function forEachBufferLine(buf, { maxLineBytes = MAX_LINE_BYTES } = {}, onLine) {
  let start = 0;
  for (;;) {
    const nl = buf.indexOf(NEWLINE, start);
    if (nl === -1) break;
    onLine(buf, start, nl, nl - start > maxLineBytes, true, -1);
    start = nl + 1;
  }
  if (buf.length > start) onLine(buf, start, buf.length, buf.length - start > maxLineBytes, false, -1);
}

// The first HEAD_HASH_BYTES of the file, or all of it when shorter. One read: it is also the zstd
// magic check and, on a whole-file read, the start of the line stream.
function readHead(fd, size) {
  const head = Buffer.alloc(Math.min(HEAD_HASH_BYTES, size));
  let got = 0;
  while (got < head.length) {
    const n = fs.readSync(fd, head, got, head.length - got, got);
    if (n === 0) break;
    got += n;
  }
  return got === head.length ? head : head.subarray(0, got);
}

// The identity of a rollout as a byte cursor sees it: a hash of its first min(4 KiB, cursorByte)
// bytes. Codex only ever appends, so a file whose head still hashes the same is the file the cursor
// was taken on; a rotated or rewritten one is not. Capped at the cursor so a rollout still shorter
// than 4 KiB keeps a stable answer while it grows. Null when `head` holds fewer bytes than that.
export function rolloutHeadHash(head, cursorByte) {
  if (!Buffer.isBuffer(head) || !Number.isInteger(cursorByte) || cursorByte < 0) return null;
  const len = Math.min(HEAD_HASH_BYTES, cursorByte);
  if (head.length < len) return null;
  return crypto.createHash('sha256').update(head.subarray(0, len)).digest('hex');
}

// delta-codex.mjs line rules: trailing empty lines drop, other blank or malformed lines give null,
// and an unterminated last line that is neither blank nor JSON is torn: counted but not complete.
// `lineEnds[i]` is the byte just past records[i]'s newline (-1 unterminated).
function collectLines(iterate) {
  const records = [];
  const lineEnds = [];
  const pendingEnds = [];
  let torn = false;
  iterate((buf, start, end, oversize, terminated, lineEnd) => {
    if (!oversize && start === end) {
      pendingEnds.push(lineEnd);
      return;
    }
    for (let i = 0; i < pendingEnds.length; i += 1) {
      records.push(null);
      lineEnds.push(pendingEnds[i]);
    }
    pendingEnds.length = 0;
    const text = oversize ? null : buf.toString('utf8', start, end);
    const blank = text !== null && !text.trim();
    const record = text === null || blank ? undefined : parseOrUndefined(text);
    if (record === undefined && !blank && !terminated) torn = true;
    else {
      records.push(record === undefined ? null : projectRolloutRecord(record));
      lineEnds.push(lineEnd);
    }
  });
  return { lineCount: records.length + (torn ? 1 : 0), completeLines: records.length, records, lineEnds };
}

function unreadableCompressed() {
  const error = new Error('Transcript is compressed and could not be decompressed');
  error.code = 'ROLLOUT_UNREADABLE';
  return error;
}

// The whole rollout. A plain one streams from disk; a zstd one (Codex compresses rollouts older than
// 7 days) is decompressed whole by rollout-file.mjs and walked in memory, so both count physical
// lines alike. A compressed rollout this Node cannot decompress (or a corrupt frame) is unreadable,
// not empty: throwing keeps a caller's cursor where it is instead of saving one computed from junk.
//
// Besides the lines: `size` and `mtimeMs` (the stat the read was bounded by), `lineEnds`, and `head`
// (the first 4 KiB, for rolloutHeadHash). `lineEnds` and `head` are null on a compressed rollout —
// offsets into a decompressed stream cannot be sought on disk — so no byte cursor is ever saved
// against one.
export function readRolloutLines(transcriptPath, options) {
  const fd = fs.openSync(transcriptPath, 'r');
  let stat;
  try {
    stat = fs.fstatSync(fd);
    const head = readHead(fd, stat.size);
    if (!isZstdBuffer(head.subarray(0, 4))) {
      const out = collectLines((onLine) => forEachLine(fd, stat.size, 0, head, options, onLine));
      return { ...out, size: stat.size, mtimeMs: stat.mtimeMs, head };
    }
  } finally {
    fs.closeSync(fd);
  }
  const buf = readRolloutBuffer(transcriptPath);
  if (buf === null) throw unreadableCompressed();
  const out = collectLines((onLine) => forEachBufferLine(buf, options, onLine));
  return { ...out, lineEnds: null, size: stat.size, mtimeMs: stat.mtimeMs, head: null };
}

// Does the file still continue the one `resume` (a saved byte cursor) was taken on? Only a plain
// rollout that has not shrunk, whose head hashes the same, and whose saved byte sits just past a
// newline. `head` is this file's first 4 KiB; `byteAt(n)` reads one byte.
function resumeHolds(resume, size, head, byteAt) {
  if (!resume || !Number.isInteger(resume.byte) || resume.byte < 0 || !Number.isInteger(resume.size)) return false;
  if (size < resume.size || resume.byte > resume.size) return false;
  if (isZstdBuffer(head.subarray(0, 4))) return false;
  if (rolloutHeadHash(head, resume.byte) !== resume.head) return false;
  return resume.byte === 0 || byteAt(resume.byte - 1) === NEWLINE;
}

// The rollout from `resume.byte` on, shaped like readRolloutLines but with line counts relative to
// the cursor, or null when the cursor does not hold (see resumeHolds) and the caller must read the
// whole file instead. Reads the 4 KiB head, at most one byte before the cursor, and the tail.
export function readRolloutTail(transcriptPath, resume, options) {
  const fd = fs.openSync(transcriptPath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const head = readHead(fd, stat.size);
    const byteAt = (at) => {
      if (at < head.length) return head[at];
      const one = Buffer.alloc(1);
      return fs.readSync(fd, one, 0, 1, at) === 1 ? one[0] : -1;
    };
    if (!resumeHolds(resume, stat.size, head, byteAt)) return null;
    const out = collectLines((onLine) => forEachLine(fd, stat.size, resume.byte, Buffer.alloc(0), options, onLine));
    return { ...out, size: stat.size, mtimeMs: stat.mtimeMs, head };
  } finally {
    fs.closeSync(fd);
  }
}

// readRolloutTail cut from a whole-file read already in memory, or null when the cursor does not
// hold against it — including a saved line that does not end at the saved byte.
export function sliceRolloutLines(lines, resume) {
  if (!lines || !Array.isArray(lines.lineEnds) || !lines.head || !resume) return null;
  const line = resume.line;
  if (!Number.isInteger(line) || line < 0 || line > lines.records.length) return null;
  if ((line === 0 ? 0 : lines.lineEnds[line - 1]) !== resume.byte) return null;
  if (!resumeHolds(resume, lines.size, lines.head, () => NEWLINE)) return null;
  return {
    lineCount: lines.lineCount - line,
    completeLines: lines.completeLines - line,
    records: lines.records.slice(line),
    lineEnds: lines.lineEnds.slice(line),
    size: lines.size,
    mtimeMs: lines.mtimeMs,
    head: lines.head,
  };
}
