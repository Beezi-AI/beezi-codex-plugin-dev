import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeSessionTimeline, postSessionTimeline } from '../lib/session-timeline-codex.mjs';

function writeRollout(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-codex-'));
  const file = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

const at = (s) => `2026-01-01T00:${String(s).padStart(2, '0')}:00.000Z`;
const userMsg = (s) => ({ timestamp: at(s), type: 'event_msg', payload: { type: 'user_message', message: 'go' } });
const work = (s) => ({ timestamp: at(s), type: 'event_msg', payload: { type: 'agent_message' } });
const updatePlan = (s, plan) => ({ timestamp: at(s), type: 'response_item', payload: { type: 'function_call', name: 'update_plan', arguments: JSON.stringify({ plan }) } });

test('classifies the gap before a user prompt as waiting_user and work runs as working', () => {
  const tl = computeSessionTimeline(writeRollout([
    userMsg(0),  // prompt at :00
    work(1),     // :00→:01 waiting_user (gap before prompt at :00? gap is between consecutive anchors)
    work(2),
    userMsg(5),  // :02→:05 gap < idle → but cur is prompt → waiting_user
  ]));
  assert.ok(tl);
  const states = tl.periods.map((p) => p.state);
  assert.ok(states.includes('working'));
  assert.ok(states.includes('waiting_user'));
});

test('long gaps become idle periods', () => {
  const tl = computeSessionTimeline(writeRollout([work(0), work(10)])); // 10min gap > 5min idle
  assert.equal(tl.periods.length, 1);
  assert.equal(tl.periods[0].state, 'idle');
});

test('update_plan calls emit plan_start and (when all completed) plan_ready', () => {
  const tl = computeSessionTimeline(writeRollout([
    updatePlan(0, [{ step: 'a', status: 'in_progress' }]),
    work(1),
    updatePlan(2, [{ step: 'a', status: 'completed' }]),
  ]));
  const types = tl.plan_events.map((e) => e.type);
  assert.deepEqual(types, ['plan_start', 'plan_ready']);
});

// ─── G-5-3: plan events on all three Codex surfaces ─────────────────────────
// `update_plan` is legacy (era A/B, 123 local records) and must keep working; `item_completed`/
// `Plan` is the only source any 0.144+ build emits (15 local); `tools.update_plan(` inside an exec
// program is a start marker only (13 local).

const planItem = (s, extra) => ({
  timestamp: at(s),
  type: 'event_msg',
  payload: Object.assign({ type: 'item_completed', item: { type: 'Plan', id: 't-plan', text: '# Plan' } }, extra || {}),
});
const execCall = (s, input) => ({ timestamp: at(s), type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input } });

test('a Plan item is a finished plan document: one plan_start and one plan_ready', () => {
  // There is no per-step status to test on this surface — the item's existence IS the completion.
  const tl = computeSessionTimeline(writeRollout([work(0), planItem(1), work(2)]));
  assert.deepEqual(tl.plan_events, [
    { type: 'plan_start', at: at(1) },
    { type: 'plan_ready', at: at(1) },
  ]);
});

test('a Plan item with no started_at_ms anchors on the record timestamp', () => {
  // started_at_ms is present on 1 of 15 local Plan items; completed_at_ms must not be preferred
  // either, or a re-scan would produce a different key and defeat the idempotent upsert.
  const tl = computeSessionTimeline(writeRollout([
    work(0),
    planItem(3, { completed_at_ms: Date.parse(at(30)) }),
  ]));
  assert.deepEqual(tl.plan_events.map((e) => e.at), [at(3), at(3)]);
});

test('a Plan item and update_plan describing one completion collapse to a single plan_ready', () => {
  // The 0.137.0 shape: one local rollout carries both surfaces. Appending them the way the Claude
  // engine appends its two sources would double-report the same moment.
  const tl = computeSessionTimeline(writeRollout([
    planItem(5),
    updatePlan(5, [{ step: 'a', status: 'completed' }]),
    work(6),
  ]));
  assert.deepEqual(tl.plan_events, [
    { type: 'plan_start', at: at(5) },
    { type: 'plan_ready', at: at(5) },
  ]);
});

test('two genuinely separate plan cycles are not collapsed into one', () => {
  // The collapse suppresses duplicate reports of one moment; it must never merge real cycles.
  // Measured on the co-occurrence rollout: its Plan items and its completing update_plan calls are
  // minutes apart, so all of them are real.
  const tl = computeSessionTimeline(writeRollout([
    planItem(1),
    updatePlan(9, [{ step: 'a', status: 'completed' }]),
  ]));
  assert.deepEqual(tl.plan_events, [
    { type: 'plan_start', at: at(1) },
    { type: 'plan_ready', at: at(1) },
    { type: 'plan_ready', at: at(9) },
  ]);
});

test('tools.update_plan inside an exec program starts a plan but can never complete one', () => {
  // The step list is not recoverable from the program text, so ready is not inferable.
  const tl = computeSessionTimeline(writeRollout([
    work(0),
    execCall(2, 'const r = await tools.update_plan({plan:[{step:"a",status:"in_progress"}]}); text(r);'),
    work(4),
  ]));
  assert.deepEqual(tl.plan_events, [{ type: 'plan_start', at: at(2) }]);
});

test('an exec program that never calls update_plan emits nothing', () => {
  const tl = computeSessionTimeline(writeRollout([
    work(0),
    execCall(2, 'const r = await tools.exec_command({cmd:"echo update_plan"}); text(r);'),
  ]));
  assert.deepEqual(tl.plan_events, []);
});

test('every plan_events row carries exactly the two keys the server accepts', () => {
  const tl = computeSessionTimeline(writeRollout([planItem(1), updatePlan(9, [{ step: 'a', status: 'completed' }])]));
  for (const row of tl.plan_events) assert.deepEqual(Object.keys(row).sort(), ['at', 'type']);
});

// ─── G-3-4: the break state and interrupt handling ──────────────────────────

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const iso = (ms) => new Date(T0 + ms).toISOString();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const BREAK_GAP_MS = 6 * HOUR;
const workAt = (ms) => ({ timestamp: iso(ms), type: 'event_msg', payload: { type: 'agent_message' } });
const promptAt = (ms) => ({ timestamp: iso(ms), type: 'event_msg', payload: { type: 'user_message', message: 'go' } });
const abortAt = (ms) => ({ timestamp: iso(ms), type: 'event_msg', payload: { type: 'turn_aborted', reason: 'interrupted' } });

test('a gap of exactly BREAK_GAP_SEC is a break; just under it is idle', () => {
  // The comparison is >=, so the threshold itself belongs to break. Pin the operator, not just
  // the magnitude.
  const exact = computeSessionTimeline(writeRollout([workAt(0), workAt(BREAK_GAP_MS)]));
  assert.deepEqual(exact.periods.map((p) => p.state), ['break']);
  const under = computeSessionTimeline(writeRollout([workAt(0), workAt(BREAK_GAP_MS - 1)]));
  assert.deepEqual(under.periods.map((p) => p.state), ['idle']);
});

test('break outranks a real user prompt that ends the gap', () => {
  // The ordering risk that matters: place break after the prompt check and a 29-hour absence
  // charts as waiting_user, inflating the very metric break exists to deflate.
  const tl = computeSessionTimeline(writeRollout([workAt(0), promptAt(29 * HOUR)]));
  assert.deepEqual(tl.periods.map((p) => p.state), ['break']);
});

test('a 10-minute gap ended by a prompt is waiting_user, not idle or break', () => {
  const tl = computeSessionTimeline(writeRollout([workAt(0), promptAt(10 * MIN)]));
  assert.deepEqual(tl.periods.map((p) => p.state), ['waiting_user']);
});

test('an interrupt leaves the work before it charted as working, never waiting_user', () => {
  // Esc is not a turn start. Measured: 79 local aborts, 0 arriving as event_msg/user_message, so
  // this is a pin on behaviour that must not regress rather than a reclassification.
  const tl = computeSessionTimeline(writeRollout([workAt(0), workAt(1 * MIN), abortAt(2 * MIN)]));
  assert.deepEqual(tl.periods.map((p) => p.state), ['working']);
});

test('the <turn_aborted> prose form in a developer message is not an interrupt', () => {
  // 54 local occurrences, all on response_item/message and none on event_msg. The rec.type guard
  // is what separates the real event from the prose; a substring match would conflate them.
  const prose = {
    timestamp: iso(2 * MIN),
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<turn_aborted>interrupted</turn_aborted>' }] },
  };
  const tl = computeSessionTimeline(writeRollout([workAt(0), prose, promptAt(3 * MIN)]));
  assert.deepEqual(tl.periods.map((p) => p.state), ['working', 'waiting_user']);
});

test('the new states re-label time without creating or destroying any', () => {
  // Periods must still tile the session end to end: the split is a relabelling, not an accounting
  // change, or the activity breakdown stops summing to the session duration.
  const tl = computeSessionTimeline(writeRollout([
    workAt(0), promptAt(10 * MIN), workAt(11 * MIN), workAt(9 * HOUR), promptAt(9 * HOUR + MIN),
  ]));
  assert.equal(tl.periods[0].started_at, tl.started_at);
  assert.equal(tl.periods[tl.periods.length - 1].ended_at, tl.ended_at);
  let total = 0;
  for (let i = 0; i < tl.periods.length; i++) {
    total += Date.parse(tl.periods[i].ended_at) - Date.parse(tl.periods[i].started_at);
    if (i > 0) assert.equal(tl.periods[i].started_at, tl.periods[i - 1].ended_at, 'periods must be contiguous');
  }
  assert.equal(total, Date.parse(tl.ended_at) - Date.parse(tl.started_at));
});

// ─── G-4-1: planning periods from collaboration_mode ────────────────────────

const turnCtx = (s, mode) => ({ timestamp: at(s), type: 'turn_context', payload: { cwd: '/x', collaboration_mode: { mode, model: 'gpt-5' } } });
const taskStarted = (s, kind) => ({ timestamp: at(s), type: 'event_msg', payload: { type: 'task_started', collaboration_mode_kind: kind } });

test('turn_context collaboration_mode paints a planning band, and code mode returns to working', () => {
  const tl = computeSessionTimeline(writeRollout([
    work(0), work(1), turnCtx(2, 'plan'), work(3), turnCtx(4, 'code'), work(5),
  ]));
  assert.deepEqual(tl.periods.map((p) => p.state), ['working', 'planning', 'working']);
  // The mode-announcing anchor belongs to the mode it announces, so the band boundary sits at the
  // record before it. On real rollouts a turn_context lands within milliseconds of the prompt that
  // opened the turn, so the interval this shifts is negligible; the minute-scale fixture only makes
  // the boundary visible.
  assert.equal(tl.periods[1].started_at, at(1));
  assert.equal(tl.periods[1].ended_at, at(3));
});

test('the mode carries forward until a new one arrives, not just over the next record', () => {
  // A turn_context is emitted once per turn, not once per record; work that follows it inherits
  // the mode, which is the whole mechanism on the 1 545 records that carry a mode with no turn_id.
  const tl = computeSessionTimeline(writeRollout([turnCtx(0, 'plan'), work(1), work(2), work(3)]));
  assert.deepEqual(tl.periods.map((p) => p.state), ['planning']);
});

test('task_started collaboration_mode_kind alone also paints planning', () => {
  // The older-build path: turn_context carries no collaboration block at all on those rollouts.
  const tl = computeSessionTimeline(writeRollout([work(0), work(1), taskStarted(2, 'plan'), work(3), work(4)]));
  assert.deepEqual(tl.periods.map((p) => p.state), ['working', 'planning']);
});

test('a user prompt inside plan mode is waiting_user, not planning', () => {
  // A plan sitting unapproved is the human's time. Rank pin.
  const tl = computeSessionTimeline(writeRollout([turnCtx(0, 'plan'), work(1), userMsg(2)]));
  assert.deepEqual(tl.periods.map((p) => p.state), ['planning', 'waiting_user']);
});

test('a long gap inside plan mode is idle, not planning', () => {
  // Rank pin: put planning above idle and every five-minute pause inside plan mode becomes
  // planning time, inflating a number people make staffing decisions on.
  const tl = computeSessionTimeline(writeRollout([turnCtx(0, 'plan'), work(1), work(20)]));
  assert.deepEqual(tl.periods.map((p) => p.state), ['planning', 'idle']);
});

test('custom, code and default collaboration modes all read as working', () => {
  // 948 local records carry mode 'custom'. Nothing in the record says a custom mode is a planning
  // mode, so it must not be guessed at.
  for (const mode of ['custom', 'code', 'default']) {
    const tl = computeSessionTimeline(writeRollout([turnCtx(0, mode), work(1), work(2)]));
    assert.deepEqual(tl.periods.map((p) => p.state), ['working'], mode);
  }
});

test('the plan-mode match is a substring, so plan_mode and planning also classify', () => {
  // Deliberate latitude, mirroring the Claude engine: a schema rename must not silently drop the
  // dimension back into working.
  for (const mode of ['plan_mode', 'planning', 'PLAN']) {
    const tl = computeSessionTimeline(writeRollout([turnCtx(0, mode), work(1), work(2)]));
    assert.deepEqual(tl.periods.map((p) => p.state), ['planning'], mode);
  }
});

test('a rollout with no collaboration_mode anywhere produces the periods it always did', () => {
  // The regression pin that protects every historical session: the timeline is re-derived and
  // re-upserted at every turn end, so a mis-stamped mode would silently re-label the past.
  const tl = computeSessionTimeline(writeRollout([work(0), work(1), userMsg(2), work(3), work(20)]));
  assert.deepEqual(tl.periods, [
    { state: 'working', started_at: at(0), ended_at: at(1) },
    { state: 'waiting_user', started_at: at(1), ended_at: at(2) },
    { state: 'working', started_at: at(2), ended_at: at(3) },
    { state: 'idle', started_at: at(3), ended_at: at(20) },
  ]);
});

test('every period carries exactly three keys, with no waiting_subtype even on waiting_user', () => {
  // An unknown key is the failure mode that 400s the ingest, and a present-but-null subtype is a
  // false claim: its absence is how the server reads "this plugin predates the field".
  const tl = computeSessionTimeline(writeRollout([
    turnCtx(0, 'plan'), work(1), userMsg(2), turnCtx(3, 'code'), work(4), work(20), workAt(30 * HOUR),
  ]));
  const states = tl.periods.map((p) => p.state);
  assert.deepEqual(states, ['planning', 'waiting_user', 'working', 'idle', 'break']);
  for (const p of tl.periods) assert.deepEqual(Object.keys(p).sort(), ['ended_at', 'started_at', 'state']);
  // Every value must fit the server's @MaxLength(50) bound on the state string.
  for (const s of states) assert.ok(s.length <= 50, s);
});

test('returns null when nothing is timestamped', () => {
  assert.equal(computeSessionTimeline(writeRollout([{ type: 'event_msg', payload: { type: 'agent_message' } }])), null);
});

test('postSessionTimeline guards missing fields and no token', async () => {
  assert.deepEqual(await postSessionTimeline({ periods: [] }, 't'), { reported: false, reason: 'missing-fields' });
  assert.deepEqual(await postSessionTimeline({ sessionId: 's', periods: [] }, null), { reported: false, reason: 'no-token' });
});

// ─── subagent spans ─────────────────────────────────────────────────────────
// They cannot come from the transcript — Codex writes a subagent to its own rollout and this file
// records nothing about it. The SubagentStart/SubagentStop hooks are the source.

const agents = (recs) => ({ readAgents: () => recs });

test('subagent spans come from the hook records, keyed to this session', () => {
  const tl = computeSessionTimeline(writeRollout([userMsg(0), work(1), work(9)]), 'sess-1', agents({
    'agent-a': { agent_id: 'agent-a', agent_type: 'explore', started_at: at(2), ended_at: at(4) },
  }));
  assert.deepEqual(tl.subagents, [{
    agent_id: 'agent-a', agent_type: 'explore', started_at: at(2), ended_at: at(4),
  }]);
});

test('an agent still running is clamped to the session end, never left without one', () => {
  // ended_at is required by the server; omitting it rejects the WHOLE timeline, periods included.
  // The session's own end is the last moment we have evidence anything was alive.
  const tl = computeSessionTimeline(writeRollout([userMsg(0), work(1), work(9)]), 'sess-1', agents({
    'agent-a': { agent_id: 'agent-a', started_at: at(2), ended_at: null },
  }));
  assert.equal(tl.subagents[0].ended_at, tl.ended_at);
  assert.equal(tl.subagents[0].agent_type, null);
});

test('clock skew can never produce ended_at before started_at', () => {
  const tl = computeSessionTimeline(writeRollout([userMsg(0), work(9)]), 'sess-1', agents({
    'agent-a': { agent_id: 'agent-a', started_at: at(5), ended_at: at(3) },
  }));
  assert.ok(Date.parse(tl.subagents[0].ended_at) >= Date.parse(tl.subagents[0].started_at));
});

test('an agent with no usable start is dropped rather than invented', () => {
  const tl = computeSessionTimeline(writeRollout([userMsg(0), work(9)]), 'sess-1', agents({
    'agent-a': { agent_id: 'agent-a', started_at: 'nonsense' },
    'agent-b': { agent_id: 'agent-b', started_at: at(2), ended_at: at(3) },
  }));
  assert.deepEqual(tl.subagents.map((s) => s.agent_id), ['agent-b']);
});

test('spans are sorted by start and capped at the server limit', () => {
  const many = {};
  for (let i = 0; i < 1200; i++) {
    many[`agent-${i}`] = { agent_id: `agent-${i}`, started_at: new Date(Date.parse(at(1)) + i).toISOString(), ended_at: at(5) };
  }
  const tl = computeSessionTimeline(writeRollout([userMsg(0), work(9)]), 'sess-1', agents(many));
  assert.equal(tl.subagents.length, 1000, 'a runaway fan-out must not 400 the payload');
  const starts = tl.subagents.map((s) => s.started_at);
  assert.deepEqual(starts, [...starts].sort());
});

test('each span carries exactly the four fields the server accepts', () => {
  const tl = computeSessionTimeline(writeRollout([userMsg(0), work(9)]), 'sess-1', agents({
    'agent-a': { agent_id: 'agent-a', agent_type: 'x', started_at: at(2), ended_at: at(3), cursor: 7, transcriptPath: '/tmp/x' },
  }));
  // cursor and transcriptPath are ours; the server rejects any unknown key outright.
  assert.deepEqual(Object.keys(tl.subagents[0]).sort(), ['agent_id', 'agent_type', 'ended_at', 'started_at']);
});

test('no session id means no subagent lookup, and an empty array', () => {
  const tl = computeSessionTimeline(writeRollout([userMsg(0), work(9)]));
  assert.deepEqual(tl.subagents, []);
});
