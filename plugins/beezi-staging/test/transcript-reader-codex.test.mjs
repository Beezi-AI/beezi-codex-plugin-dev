import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectRolloutRecord, readRolloutLines } from '../lib/transcript-reader-codex.mjs';

// Projection contract read by Task X3:
// - `*_output` payloads: `output` is replaced by `outputBytes` (read by operations-codex.mjs). An output
//   whose parsed object carries `accepted`, `answers` or `error` keeps just those as `output`, for timeline-waits.
// - patch_apply_end `changes` and item_completed FileChange `item.changes`: each change keeps its other fields
//   (type, move_path) and swaps `unified_diff` / `content` for `linesAdded` / `linesRemoved`
//   (read by code-changes-codex.mjs).
// - Dropped from any payload: encrypted_content, replacement_history, images, base_instructions, dynamic_tools.
//   Message content blocks without text keep only their type.
// - item_completed items drop CommandExecution aggregated_output, McpToolCall result, FileChange stdout/stderr and
//   Extension results. Consumers read only type, id, status, changes, server, duration and kind.

const j = (value) => JSON.stringify(value);
const META = j({ timestamp: '2026-10-29T10:00:00.000Z', type: 'session_meta', payload: { id: 's1', cwd: '/repo' } });
const SHORT = j({ type: 'turn_context' });
const TOKENS = j({ timestamp: '2026-10-29T10:00:01.000Z', type: 'event_msg', payload: { type: 'token_count', info: null } });

// Verbatim copy of delta-codex.mjs completeLineCount and the computeDelta parse: the oracle.
function completeLineCount(raw, endsWithNewline) {
  if (raw.length === 0 || endsWithNewline) return raw.length;
  const last = raw[raw.length - 1];
  if (!last.trim()) return raw.length;
  try { JSON.parse(last); } catch { return raw.length - 1; }
  return raw.length;
}

function oldParse(content) {
  const endsWithNewline = /\n$/.test(content);
  const trimmed = content.replace(/\n+$/, '');
  const raw = trimmed === '' ? [] : trimmed.split('\n');
  const completeLines = completeLineCount(raw, endsWithNewline);
  const records = raw.slice(0, completeLines).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  });
  return { lineCount: raw.length, completeLines, records };
}

function tempFile(t, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-codex-reader-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(file, text, 'utf-8');
  return file;
}

const nullPattern = (records) => records.map((r) => r === null);

const INPUTS = {
  empty: '',
  newlinesOnly: '\n\n',
  trailingNewlines: `${META}\n\n\n`,
  leadingNewlines: `\n\n${META}\n`,
  middleBlank: `${META}\n\n   \n\t\n${TOKENS}\n`,
  crlf: `${META}\r\n\r\n${TOKENS}\r\n`,
  malformedMiddle: `${META}\n{"type":"event_msg", broken\n${TOKENS}\n`,
  nullRecord: `null\n${META}\n`,
  tornLast: `${META}\n{"type":"event_m`,
  tornLastAfterBlank: `${META}\n\n{"type":"event_m`,
  malformedLastTerminated: `${META}\n{"type":"event_m\n`,
  validLastUnterminated: `${META}\n${TOKENS}`,
  blankLastUnterminated: `${META}\n  `,
  multiByte: `${j({ type: 'event_msg', payload: { type: 'user_message', message: 'Привіт 👋 світ, ще раз 🚀🚀' } })}\n${TOKENS}\n`,
  longLine: `${j({ type: 'event_msg', payload: { type: 'agent_message', message: 'x'.repeat(200) } })}\n${META}\n`,
};

test('equals the old parse on generated inputs', (t) => {
  for (const [name, text] of Object.entries(INPUTS)) {
    const file = tempFile(t, text);
    const oracle = oldParse(text);
    for (const chunkBytes of [7, 16, 1 << 20]) {
      const label = `${name} chunk ${chunkBytes}`;
      const actual = readRolloutLines(file, { chunkBytes });
      assert.equal(actual.lineCount, oracle.lineCount, label);
      assert.equal(actual.completeLines, oracle.completeLines, label);
      assert.equal(actual.records.length, actual.completeLines, label);
      assert.deepEqual(nullPattern(actual.records), nullPattern(oracle.records), label);
      assert.deepEqual(actual.records, oracle.records.map(projectRolloutRecord), label);
    }
  }
});

test('line over maxLineBytes gives null and the next line keeps its index', (t) => {
  const long = j({ type: 'event_msg', payload: { type: 'agent_message', message: 'y'.repeat(100) } });
  const file = tempFile(t, `${SHORT}\n${long}\n${SHORT}\n`);
  for (const chunkBytes of [7, 16, 1 << 20]) {
    const actual = readRolloutLines(file, { chunkBytes, maxLineBytes: 32 });
    assert.equal(actual.lineCount, 3);
    assert.equal(actual.completeLines, 3);
    assert.deepEqual(actual.records, [{ type: 'turn_context' }, null, { type: 'turn_context' }]);
  }
});

test('an unterminated last line over maxLineBytes is torn', (t) => {
  const file = tempFile(t, `${SHORT}\n${'z'.repeat(100)}`);
  const actual = readRolloutLines(file, { chunkBytes: 16, maxLineBytes: 32 });
  assert.equal(actual.lineCount, 2);
  assert.equal(actual.completeLines, 1);
});

test('throws on an unreadable file', () => {
  assert.throws(() => readRolloutLines(path.join(os.tmpdir(), 'beezi-codex-missing', 'rollout.jsonl')), { code: 'ENOENT' });
});

// Verbatim copy of the outputBytes operations-codex.mjs measured before the projection.
function oldOutputBytes(output) {
  if (typeof output === 'string') return Buffer.byteLength(output, 'utf-8');
  if (output == null) return 0;
  return Buffer.byteLength(JSON.stringify(output), 'utf-8');
}

test('projectRolloutRecord measures output and keeps the wait fields', () => {
  const outputs = ['plain text ✓ output', { content: 'big', exit_code: 0 }, j({ accepted: true, stdout: 'x'.repeat(50) }), undefined];
  for (const output of outputs) {
    for (const type of ['function_call_output', 'custom_tool_call_output']) {
      const record = { timestamp: '2026-10-29T10:00:02.000Z', type: 'response_item', payload: { type, call_id: 'c1', output } };
      const slim = projectRolloutRecord(record);
      assert.equal(slim.payload.outputBytes, oldOutputBytes(output));
      assert.equal(slim.payload.call_id, 'c1');
      assert.equal(slim.timestamp, record.timestamp);
      assert.equal(slim.type, 'response_item');
      assert.equal(slim.payload.type, type);
    }
  }
  const answered = projectRolloutRecord({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'q', output: j({ answers: { a: 1 }, error: 'no', extra: 'drop' }) } });
  assert.deepEqual(answered.payload.output, { answers: { a: 1 }, error: 'no' });
  const plain = projectRolloutRecord({ type: 'response_item', payload: { type: 'function_call_output', output: 'ok' } });
  assert.equal('output' in plain.payload, false);
});

test('projectRolloutRecord drops heavy payloads and keeps the rest', () => {
  const reasoning = projectRolloutRecord({ timestamp: 't', type: 'response_item', payload: { type: 'reasoning', summary: [], encrypted_content: 'gAAA' } });
  assert.deepEqual(reasoning, { timestamp: 't', type: 'response_item', payload: { type: 'reasoning', summary: [] } });

  const meta = projectRolloutRecord({ timestamp: 't', type: 'session_meta', payload: { id: 's1', cwd: '/repo', base_instructions: { text: 'x' }, dynamic_tools: [{}] } });
  assert.deepEqual(meta, { timestamp: 't', type: 'session_meta', payload: { id: 's1', cwd: '/repo' } });

  const compacted = projectRolloutRecord({ timestamp: 't', type: 'compacted', payload: { message: 'm', replacement_history: [{}] } });
  assert.deepEqual(compacted.payload, { message: 'm' });

  const message = projectRolloutRecord({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }, { type: 'input_image', image_url: 'data:...' }] } });
  assert.deepEqual(message.payload.content, [{ type: 'input_text', text: 'hi' }, { type: 'input_image' }]);

  const call = { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command":"ls"}', call_id: 'c1' } };
  assert.deepEqual(projectRolloutRecord(call), call);
  assert.equal(projectRolloutRecord(null), null);
  assert.equal(projectRolloutRecord('text'), 'text');
});

test('projectRolloutRecord swaps change bodies for line counts', () => {
  const changes = {
    '/repo/a.js': { type: 'update', unified_diff: 'preamble\n+not counted\n@@ -1 +1 @@\n-old\n+new\n+more\n context', move_path: '/repo/b.js' },
    '/repo/c.js': { type: 'add', content: 'one\ntwo\n' },
    '/repo/d.js': { type: 'delete', content: 'gone' },
  };
  const expected = {
    '/repo/a.js': { type: 'update', move_path: '/repo/b.js', linesAdded: 2, linesRemoved: 1 },
    '/repo/c.js': { type: 'add', linesAdded: 2, linesRemoved: 0 },
    '/repo/d.js': { type: 'delete', linesAdded: 0, linesRemoved: 1 },
  };
  const patch = projectRolloutRecord({ type: 'event_msg', payload: { type: 'patch_apply_end', call_id: 'c1', success: true, changes } });
  assert.deepEqual(patch.payload, { type: 'patch_apply_end', call_id: 'c1', success: true, changes: expected });

  const item = projectRolloutRecord({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FileChange', id: 'i1', status: 'completed', changes } } });
  assert.deepEqual(item.payload.item, { type: 'FileChange', id: 'i1', status: 'completed', changes: expected });
});

const itemRecord = (item) => ({
  timestamp: 't',
  type: 'event_msg',
  payload: { type: 'item_completed', thread_id: 'th', turn_id: 'tu', started_at_ms: 1, completed_at_ms: 2, item },
});

test('projectRolloutRecord drops heavy item_completed fields and keeps what consumers read', () => {
  const cases = [
    [
      { type: 'CommandExecution', id: 'c1', command: 'ls', cwd: '/repo', parsed_cmd: [], status: 'completed', aggregated_output: 'x'.repeat(500), exit_code: 0, duration: { secs: 1, nanos: 0 } },
      { type: 'CommandExecution', id: 'c1', command: 'ls', cwd: '/repo', parsed_cmd: [], status: 'completed', exit_code: 0, duration: { secs: 1, nanos: 0 } },
    ],
    [
      { type: 'McpToolCall', id: 'call_1', server: 'cua_repl', tool: 'js', arguments: {}, status: 'completed', result: { content: [{ type: 'text', text: 'big' }] }, duration: { secs: 2, nanos: 0 } },
      { type: 'McpToolCall', id: 'call_1', server: 'cua_repl', tool: 'js', arguments: {}, status: 'completed', duration: { secs: 2, nanos: 0 } },
    ],
    [
      { type: 'FileChange', id: 'f1', status: 'completed', changes: { '/repo/a.js': { type: 'add', content: 'a\n' } }, stdout: 'Success.', stderr: '' },
      { type: 'FileChange', id: 'f1', status: 'completed', changes: { '/repo/a.js': { type: 'add', linesAdded: 1, linesRemoved: 0 } } },
    ],
    [
      { type: 'Extension', id: 'e1', kind: 'web_search', query: 'q', results: [{ title: 'big' }] },
      { type: 'Extension', id: 'e1', kind: 'web_search', query: 'q' },
    ],
  ];
  for (const [item, slimItem] of cases) {
    assert.deepEqual(projectRolloutRecord(itemRecord(item)), itemRecord(slimItem), item.type);
  }
});

test('projectRolloutRecord keeps other item_completed items whole', () => {
  const items = [
    { type: 'Plan', id: 'p1', text: '# Plan' },
    { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'hi' }] },
    { type: 'SubAgentActivity', id: 's1', kind: 'completed', agent_thread_id: 'a' },
    { type: 'CollabAgentToolCall', id: 'k1', tool: 'spawn', status: 'completed' },
    { type: 'AgentMessage', id: 'm1', content: [{ type: 'text', text: 'done' }], phase: 'final' },
  ];
  for (const item of items) assert.deepEqual(projectRolloutRecord(itemRecord(item)), itemRecord(item), item.type);
});
