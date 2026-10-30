import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timelineWaits, isTimelineUserPrompt } from '../lib/timeline-waits-codex.mjs';
import { toolNamesFromProgram } from '../lib/exec-program.mjs';

// Oracle: the O(spans x records) timelineWaits and its private helpers, verbatim from before the
// sorted-index rewrite. The rewrite must return the same Map, entry for entry, in the same order.
function argsOf(raw) {
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

function callName(p) {
  if (p.type !== 'custom_tool_call' || p.name !== 'exec') return p.name;
  const names = toolNamesFromProgram(p.input);
  return names.length === 1 ? names[0] : null;
}

function callWait(p) {
  const args = argsOf(p.arguments) || {};
  const name = callName(p);
  if (name === 'request_user_input') return { state: 'waiting_user', subtype: 'question_answer' };
  if (name === 'request_permissions') return { state: 'waiting_user', subtype: 'command_approval' };
  if (name === 'wait_agent' || name === 'wait' || name === 'write_stdin') {
    if (name === 'write_stdin') {
      if (p.type === 'function_call') {
        if (!args.session_id || (args.chars || '') !== '') return null;
      } else {
        const match = typeof p.input === 'string' && p.input.match(/tools\.write_stdin\s*\(\s*\{([^{}]*)\}\s*\)/);
        if (!match) return null;
        const fields = match[1].split(',').map((s) => s.trim()).filter(Boolean);
        if (!fields.some((s) => /^session_id\s*:\s*\d+$/.test(s)) || !fields.every((s) =>
          /^(session_id|yield_time_ms|max_output_tokens)\s*:\s*\d+$/.test(s)
          || /^chars\s*:\s*(""|'')$/.test(s))) return null;
      }
    }
    if (name === 'wait' && p.type === 'function_call' && !args.cell_id && !Array.isArray(args.ids)) return null;
    return { state: 'idle', subtype: null };
  }
  return null;
}

function isBookkeeping(rec) {
  const p = rec.payload || {};
  const completion = rec.type === 'event_msg' && p.type === 'item_completed' && p.item
    && ['CommandExecution', 'CollabAgentToolCall', 'McpToolCall', 'FileChange', 'ImageView'].indexOf(p.item.type) !== -1;
  return rec.type === 'token_usage_record' || rec.type === 'world_state'
    || completion
    || (rec.type === 'response_item' && p.type === 'message'
      && (p.role === 'user' || p.role === 'developer' || p.role === 'system'))
    || rec.type === 'turn_context' || rec.type === 'inter_agent_communication_metadata'
    || (rec.type === 'event_msg' && (p.type === 'token_count' || p.type === 'task_complete' || p.type === 'task_started'
      || p.type === 'thread_settings_applied'));
}

function oracleTimelineWaits(records) {
  const timed = records.filter((r) => Number.isFinite(Date.parse(r.timestamp)))
    .slice().sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const calls = new Map();
  const asyncQuestions = new Set();
  const spans = [];
  let presentedPlan = false;
  let pendingQuestion = false;
  let betweenTurns = null;
  for (const rec of timed) {
    const ms = Date.parse(rec.timestamp);
    const p = rec.payload || {};
    const event = rec.type === 'event_msg';
    const response = rec.type === 'response_item';
    if (event && p.type === 'task_started') presentedPlan = false;
    if ((event && p.type === 'item_completed' && p.item && p.item.type === 'Plan')
      || (response && p.type === 'message' && p.role === 'assistant' && p.phase === 'final_answer'
        && Array.isArray(p.content) && p.content.some((b) => typeof b.text === 'string'
          && b.text.indexOf('<proposed_plan>') !== -1))) presentedPlan = true;

    if (betweenTurns) {
      if (isTimelineUserPrompt(rec)) {
        spans.push({ start: betweenTurns.start, end: ms, state: 'waiting_user', subtype: betweenTurns.subtype });
        betweenTurns = null;
      } else if (!isBookkeeping(rec)) {
        betweenTurns = null;
      }
    }
    if (isTimelineUserPrompt(rec)) pendingQuestion = false;
    if (event && p.type === 'task_complete') {
      if (!betweenTurns) betweenTurns = { start: ms, subtype: pendingQuestion ? 'question_answer'
        : presentedPlan ? 'plan_approval' : 'next_instruction' };
    }
    if (response && (p.type === 'function_call' || p.type === 'custom_tool_call')) {
      if (callName(p) === 'request_user_input_async' && p.call_id) asyncQuestions.add(p.call_id);
      const wait = callWait(p);
      if (wait && p.call_id) calls.set(p.call_id, { start: ms, state: wait.state, subtype: wait.subtype });
    }
    if (response && (p.type === 'function_call_output' || p.type === 'custom_tool_call_output')) {
      if (asyncQuestions.has(p.call_id)) {
        asyncQuestions.delete(p.call_id);
        const output = argsOf(p.output);
        if (output && output.accepted === true) pendingQuestion = true;
      }
      const call = calls.get(p.call_id);
      if (call) {
        calls.delete(p.call_id);
        const output = argsOf(p.output);
        const answered = call.subtype !== 'question_answer' || (output && output.answers
          && typeof output.answers === 'object' && Object.keys(output.answers).length > 0);
        const human = call.subtype !== 'command_approval' || ms - call.start >= 1000;
        if (answered && human && !(output && output.error)) spans.push({ ...call, end: ms });
      }
    }
  }

  const waits = new Map();
  for (const span of spans) {
    let start = span.start;
    for (const rec of timed) {
      const ms = Date.parse(rec.timestamp);
      if (ms <= span.start || ms >= span.end) continue;
      if (!isBookkeeping(rec)) start = ms;
    }
    for (const rec of timed) {
      const ms = Date.parse(rec.timestamp);
      if (ms <= start || ms > span.end) continue;
      const existing = waits.get(ms);
      if (!existing || span.state === 'waiting_user') waits.set(ms, { state: span.state, subtype: span.subtype });
    }
  }
  return waits;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BASE = Date.parse('2026-10-29T10:00:00.000Z');
const ev = (payload) => ({ type: 'event_msg', payload });
const resp = (payload) => ({ type: 'response_item', payload });
const call = (name, args, id) => resp({ type: 'function_call', name, arguments: JSON.stringify(args), call_id: id });

// Every record shape timelineWaits branches on: turn bounds, prompts and notifications, plan
// markers, every wait-producing call (and near-misses that are not waits), outputs that answer,
// fail or are missing, and the bookkeeping that does not end a blocking span.
const MAKERS = [
  () => ev({ type: 'task_started' }),
  () => ev({ type: 'task_complete' }),
  () => ev({ type: 'user_message', message: 'next step' }),
  () => ev({ type: 'user_message', message: '<task-notification>done</task-notification>' }),
  () => ev({ type: 'item_completed', item: { type: 'UserMessage' } }),
  () => ev({ type: 'item_completed', item: { type: 'Plan' } }),
  () => resp({ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ text: '<proposed_plan>x</proposed_plan>' }] }),
  () => resp({ type: 'message', role: 'assistant', content: [{ text: 'working' }] }),
  () => resp({ type: 'message', role: 'user', content: [{ text: 'raw prompt' }] }),
  () => resp({ type: 'agent_message' }),
  () => ev({ type: 'token_count' }),
  () => ev({ type: 'item_completed', item: { type: 'CommandExecution' } }),
  () => ({ type: 'turn_context', payload: {} }),
  () => ({ type: 'token_usage_record' }),
  () => resp({ type: 'reasoning' }),
  (id) => call('wait_agent', { ids: ['a'] }, id),
  (id) => call('wait', { cell_id: 'c1' }, id),
  (id) => call('wait', {}, id),
  (id) => call('write_stdin', { session_id: 7, chars: '' }, id),
  (id) => call('write_stdin', { session_id: 7, chars: 'y\n' }, id),
  (id) => call('request_user_input', { questions: [] }, id),
  (id) => call('request_permissions', {}, id),
  (id) => call('request_user_input_async', {}, id),
  (id) => call('exec_command', { cmd: 'ls' }, id),
  (id) => resp({ type: 'custom_tool_call', name: 'exec', input: 'await tools.write_stdin({session_id: 3, chars: ""})', call_id: id }),
  (id) => resp({ type: 'custom_tool_call', name: 'exec', input: 'await tools.wait_agent({}); await tools.exec_command({cmd:"ls"})', call_id: id }),
  (id) => resp({ type: 'function_call_output', call_id: id, output: 'ok' }),
  (id) => resp({ type: 'function_call_output', call_id: id, output: JSON.stringify({ answers: { q: 'yes' } }) }),
  (id) => resp({ type: 'function_call_output', call_id: id, output: JSON.stringify({ answers: {} }) }),
  (id) => resp({ type: 'function_call_output', call_id: id, output: JSON.stringify({ error: 'denied' }) }),
  (id) => resp({ type: 'function_call_output', call_id: id, output: JSON.stringify({ accepted: true }) }),
  (id) => resp({ type: 'custom_tool_call_output', call_id: id, output: 'done' }),
];

function generate(rand) {
  const count = 1 + Math.floor(rand() * 120);
  // A narrow clock forces equal timestamps; a wide one crosses the 1 s approval threshold.
  const stepMs = rand() < 0.5 ? 400 : 3000;
  const records = [];
  let t = BASE;
  for (let i = 0; i < count; i++) {
    if (rand() < 0.7) t += Math.floor(rand() * stepMs);
    const rec = MAKERS[Math.floor(rand() * MAKERS.length)]('c' + Math.floor(rand() * 6));
    rec.timestamp = rand() < 0.03 ? 'not a date' : new Date(t).toISOString();
    records.push(rec);
  }
  // Out-of-order input exercises the stable sort on equal timestamps.
  if (rand() < 0.3) {
    for (let i = records.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = records[i];
      records[i] = records[j];
      records[j] = tmp;
    }
  }
  return records;
}

test('timelineWaits returns the same Map, in the same order, as the per-span full scan', () => {
  const rand = mulberry32(0xbee21);
  let nonEmpty = 0;
  const states = new Set();
  for (let n = 0; n < 3000; n++) {
    const records = generate(rand);
    const expected = [...oracleTimelineWaits(records)];
    assert.deepEqual([...timelineWaits(records)], expected, 'case ' + n);
    if (expected.length) nonEmpty += 1;
    for (const [, w] of expected) states.add(w.state + '/' + w.subtype);
  }
  // The generator must actually produce waits of every kind, or equality proves little.
  assert.ok(nonEmpty > 300, 'non-empty cases: ' + nonEmpty);
  for (const kind of ['idle/null', 'waiting_user/question_answer', 'waiting_user/command_approval',
    'waiting_user/next_instruction', 'waiting_user/plan_approval']) {
    assert.ok(states.has(kind), 'never produced ' + kind);
  }
});

test('timelineWaits handles 200k records with 2k spans quickly', () => {
  const records = [];
  let t = BASE;
  for (let s = 0; s < 2000; s++) {
    const id = 'w' + s;
    records.push(Object.assign(call('wait_agent', { ids: ['a'] }, id), { timestamp: new Date(t++).toISOString() }));
    for (let k = 0; k < 98; k++) records.push(Object.assign(ev({ type: 'token_count' }), { timestamp: new Date(t++).toISOString() }));
    records.push(Object.assign(resp({ type: 'function_call_output', call_id: id, output: 'ok' }), { timestamp: new Date(t++).toISOString() }));
  }
  assert.equal(records.length, 200000);
  const started = Date.now();
  const waits = timelineWaits(records);
  const elapsed = Date.now() - started;
  assert.equal(waits.size, 2000 * 99);
  assert.ok(elapsed < 2000, 'took ' + elapsed + ' ms');
});
