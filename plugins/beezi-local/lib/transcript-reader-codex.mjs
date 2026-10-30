import fs from 'fs';

const MAX_LINE_BYTES = 256 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;
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

// Calls onLine(buf, start, end, oversize, terminated) per `\n`-split line, the unterminated last one included when non-empty.
function forEachLine(transcriptPath, { chunkBytes = CHUNK_BYTES, maxLineBytes = MAX_LINE_BYTES } = {}, onLine) {
  const fd = fs.openSync(transcriptPath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    let buf = Buffer.alloc(chunkBytes);
    let start = 0;
    let end = 0;
    let pos = 0;
    let oversize = false;
    for (;;) {
      const nl = buf.subarray(0, end).indexOf(NEWLINE, start);
      if (nl !== -1) {
        onLine(buf, start, nl, oversize || nl - start > maxLineBytes, true);
        oversize = false;
        start = nl + 1;
        continue;
      }
      if (end - start > maxLineBytes) oversize = true;
      if (oversize) {
        start = 0;
        end = 0;
      } else {
        buf.copy(buf, 0, start, end);
        end -= start;
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
    if (oversize || end > start) onLine(buf, start, end, oversize, false);
  } finally {
    fs.closeSync(fd);
  }
}

// delta-codex.mjs line rules: trailing empty lines drop, other blank or malformed lines give null,
// and an unterminated last line that is neither blank nor JSON is torn: counted but not complete.
export function readRolloutLines(transcriptPath, options) {
  const records = [];
  let pendingEmpty = 0;
  let torn = false;
  forEachLine(transcriptPath, options, (buf, start, end, oversize, terminated) => {
    if (!oversize && start === end) {
      pendingEmpty += 1;
      return;
    }
    for (; pendingEmpty > 0; pendingEmpty -= 1) records.push(null);
    const text = oversize ? null : buf.toString('utf8', start, end);
    const blank = text !== null && !text.trim();
    const record = text === null || blank ? undefined : parseOrUndefined(text);
    if (record === undefined && !blank && !terminated) torn = true;
    else records.push(record === undefined ? null : projectRolloutRecord(record));
  });
  return { lineCount: records.length + (torn ? 1 : 0), completeLines: records.length, records };
}
