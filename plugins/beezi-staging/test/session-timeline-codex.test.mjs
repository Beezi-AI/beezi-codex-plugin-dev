import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { computeSessionTimeline, postSessionTimeline } from '../lib/session-timeline-codex.mjs';
import { markerSpans } from '../lib/timeline-waits-codex.mjs';
import { readRolloutLines } from '../lib/transcript-reader-codex.mjs';

function writeRollout(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-codex-'));
  const file = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

const at = (s) => `2026-01-01T00:${String(s).padStart(2, '0')}:00.000Z`;
const userMsg = (s) => ({ timestamp: at(s), type: 'event_msg', payload: { type: 'user_message', message: 'go' } });
const work = (s) => ({ timestamp: at(s), type: 'event_msg', payload: { type: 'agent_message' } });
// update_plan only counts inside plan mode (in default mode it is a todo list), so fixtures that
// assert on it open with a plan-mode task_started.
const planMode = (s) => ({ timestamp: at(s), type: 'event_msg',
  payload: { type: 'task_started', collaboration_mode_kind: 'plan' } });
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
    planMode(0),
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
    planMode(5),
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
    planMode(1),
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
    planMode(0),
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
  const tl = computeSessionTimeline(writeRollout([planMode(1), planItem(1), updatePlan(9, [{ step: 'a', status: 'completed' }])]));
  for (const row of tl.plan_events) assert.deepEqual(Object.keys(row).sort(), ['at', 'type']);
});

test('update_plan outside plan mode is a todo list, not a plan', () => {
  const defaultMode = { timestamp: at(0), type: 'event_msg', payload: { type: 'task_started', collaboration_mode_kind: 'default' } };
  const tl = computeSessionTimeline(writeRollout([
    defaultMode,
    updatePlan(1, [{ step: 'a', status: 'in_progress' }]),
    updatePlan(2, [{ step: 'a', status: 'completed' }]),
    execCall(3, 'const r = await tools.update_plan({plan:[]}); text(r);'),
    work(4),
  ]));
  assert.deepEqual(tl.plan_events, []);
});

// ─── planning skills ────────────────────────────────────────────────────────

const injection = (s, name) => ({ timestamp: at(s), type: 'response_item', payload: { type: 'message', role: 'user',
  content: [{ type: 'input_text', text: `<skill>\n<name>${name}</name>\n<path>C:\\x\\skills\\y\\SKILL.md</path>\n---\n` }] } });
const fileChange = (s, file) => ({ timestamp: at(s), type: 'event_msg', payload: { type: 'item_completed',
  item: { type: 'FileChange', id: `fc-${s}`, status: 'completed', changes: { [file]: { type: 'add', content: 'x\n' } } } } });
const skillReadExec = (s, skill) => execCall(s, `const r = await tools.exec_command({cmd: "Get-Content -Raw 'C:\\\\Users\\\\u\\\\.codex\\\\plugins\\\\cache\\\\m\\\\superpowers\\\\6.3.0\\\\skills\\\\${skill}\\\\SKILL.md'"}); text(r);`);
const rowsOk = (tl) => { for (const row of tl.plan_events) assert.deepEqual(Object.keys(row).sort(), ['at', 'type']); };

test('a planning skill injection opens a cycle; the plan doc write makes it ready; code edit closes it', () => {
  const tl = computeSessionTimeline(writeRollout([
    work(0),
    injection(1, 'superpowers:writing-plans'),
    work(2),
    fileChange(3, 'C:\\repo\\docs\\superpowers\\plans\\2026-09-29-x.md'),
    work(4),
    fileChange(5, 'C:\\repo\\src\\app.js'),
    work(6),
  ]));
  assert.deepEqual(tl.plan_events, [{ type: 'plan_start', at: at(1) }, { type: 'plan_ready', at: at(3) }]);
  rowsOk(tl);
  const planning = tl.periods.filter((p) => p.state === 'planning');
  assert.equal(planning.length, 1);
  // A period is classified by the record that ENDS it (same as plan mode), so the gap leading up
  // to the skill record is the first planning span.
  assert.equal(planning[0].started_at, at(0));
  assert.equal(planning[0].ended_at, at(3));
});

test('a SKILL.md read of brainstorming via exec opens a cycle', () => {
  const tl = computeSessionTimeline(writeRollout([
    work(0),
    skillReadExec(1, 'brainstorming'),
    fileChange(2, 'C:\\repo\\docs\\design.md'),
    work(3),
  ]));
  assert.deepEqual(tl.plan_events, [{ type: 'plan_start', at: at(1) }, { type: 'plan_ready', at: at(2) }]);
  rowsOk(tl);
});

test('listing or searching skill folders emits nothing', () => {
  const dir = 'C:\\\\Users\\\\u\\\\.codex\\\\plugins\\\\cache\\\\m\\\\superpowers\\\\6.3.0\\\\skills';
  const tl = computeSessionTimeline(writeRollout([
    work(0),
    execCall(1, `const r = await tools.exec_command({cmd: "Get-ChildItem -Recurse '${dir}' -Filter SKILL.md"}); text(r);`),
    execCall(2, `const r = await tools.exec_command({cmd: "rg -n brainstorming '${dir}'"}); text(r);`),
    fileChange(3, 'C:\\repo\\docs\\plan.md'),
    work(4),
  ]));
  assert.deepEqual(tl.plan_events, []);
});

test('a planning skill read chained to other work still opens a cycle (the real automatic shape)', () => {
  // Measured: `rg --files docs/gap-analysis; Get-Content …/subagents/SKILL.md; Get-Content
  // …/writing-plans/SKILL.md` — one command, discovery plus several skill reads.
  const tl = computeSessionTimeline(writeRollout([
    work(0),
    execCall(1, 'const r = await tools.exec_command({cmd: "rg --files docs/gap-analysis; Get-Content C:/Users/u/.agents/skills/subagents/SKILL.md; Get-Content C:/Users/u/.codex/plugins/cache/m/superpowers/6.3.0/skills/writing-plans/SKILL.md"}); text(r);'),
    fileChange(2, 'C:\\repo\\docs\\superpowers\\plans\\2026-09-29-x.md'),
    work(3),
  ]));
  assert.deepEqual(tl.plan_events, [{ type: 'plan_start', at: at(1) }, { type: 'plan_ready', at: at(2) }]);
  rowsOk(tl);
});

test('executing-plans closes an open cycle and never opens one', () => {
  const tl = computeSessionTimeline(writeRollout([
    work(0),
    injection(1, 'superpowers:executing-plans'),
    fileChange(2, 'C:\\repo\\docs\\plan.md'),
    injection(3, 'superpowers:writing-plans'),
    fileChange(4, 'C:\\repo\\docs\\plan.md'),
    injection(5, 'superpowers:executing-plans'),
    fileChange(6, 'C:\\repo\\docs\\plan.md'),
    work(7),
  ]));
  assert.deepEqual(tl.plan_events, [{ type: 'plan_start', at: at(3) }, { type: 'plan_ready', at: at(4) }]);
});

test('a planning skill inside built-in plan mode adds no second cycle', () => {
  const tl = computeSessionTimeline(writeRollout([
    planMode(0),
    injection(1, 'superpowers:writing-plans'),
    fileChange(2, 'C:\\repo\\docs\\plan.md'),
    work(3),
  ]));
  assert.deepEqual(tl.plan_events, []);
});

test('a lone planning-skill start with no plan doc paints no planning period', () => {
  const tl = computeSessionTimeline(writeRollout([
    work(0),
    injection(1, 'superpowers:brainstorming'),
    work(2),
    work(3),
  ]));
  assert.deepEqual(tl.plan_events, [{ type: 'plan_start', at: at(1) }]);
  assert.deepEqual(tl.periods.filter((p) => p.state === 'planning'), []);
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
    { state: 'waiting_user', waiting_subtype: 'next_instruction', started_at: at(1), ended_at: at(2) },
    { state: 'working', started_at: at(2), ended_at: at(3) },
    { state: 'idle', started_at: at(3), ended_at: at(20) },
  ]);
});

test('waiting_subtype is emitted only on waiting_user periods', () => {
  const tl = computeSessionTimeline(writeRollout([
    turnCtx(0, 'plan'), work(1), userMsg(2), turnCtx(3, 'code'), work(4), work(20), workAt(30 * HOUR),
  ]));
  const states = tl.periods.map((p) => p.state);
  assert.deepEqual(states, ['planning', 'waiting_user', 'working', 'idle', 'break']);
  for (const p of tl.periods) assert.deepEqual(Object.keys(p).sort(),
    p.state === 'waiting_user' ? ['ended_at', 'started_at', 'state', 'waiting_subtype'] : ['ended_at', 'started_at', 'state']);
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

const callAt = (ms, name, id, args = {}) => ({ timestamp: iso(ms), type: 'response_item',
  payload: { type: 'function_call', name, call_id: id, arguments: JSON.stringify(args) } });
const resultAt = (ms, id, output = {}) => ({ timestamp: iso(ms), type: 'response_item',
  payload: { type: 'function_call_output', call_id: id, output: JSON.stringify(output) } });
const eventAt = (ms, type, extra = {}) => ({ timestamp: iso(ms), type: 'event_msg', payload: { type, ...extra } });
const summarize = (records) => computeSessionTimeline(writeRollout(records)).periods
  .map((p) => [p.state, p.waiting_subtype, Date.parse(p.ended_at) - Date.parse(p.started_at)]);

test('question answers are human time across bookkeeping, even in plan mode and beyond 5 minutes', () => {
  const periods = summarize([
    { ...turnCtx(0, 'plan'), timestamp: iso(0) },
    callAt(MIN, 'request_user_input', 'q'), eventAt(2 * MIN, 'token_count'),
    resultAt(11 * MIN, 'q', { answers: { choice: { answers: ['yes'] } } }),
  ]);
  assert.deepEqual(periods, [['planning', undefined, MIN], ['waiting_user', 'question_answer', 10 * MIN]]);
});

test('question-tool failures do not invent human waits', () => {
  assert.deepEqual(summarize([callAt(0, 'request_user_input', 'q'),
    resultAt(2000, 'q', { error: 'not available' })]), [['working', undefined, 2000]]);
});

test('adjacent question and command decisions keep different subtypes', () => {
  assert.deepEqual(summarize([
    callAt(0, 'request_user_input', 'q'), resultAt(MIN, 'q', { answers: { q: {} } }),
    callAt(MIN, 'request_permissions', 'p'), resultAt(2 * MIN, 'p', { permissions: {} }),
  ]), [['waiting_user', 'question_answer', MIN], ['waiting_user', 'command_approval', MIN]]);
});

test('instant permission resolution does not charge the human', () => {
  assert.deepEqual(summarize([callAt(0, 'request_permissions', 'p'), resultAt(500, 'p')]),
    [['working', undefined, 500]]);
});

test('a presented Plan waits for approval after task completion, across resume metadata', () => {
  assert.deepEqual(summarize([
    eventAt(0, 'item_completed', { item: { type: 'Plan', text: 'plan' } }),
    eventAt(1000, 'task_complete'), eventAt(2 * MIN, 'token_count'),
    eventAt(3 * MIN, 'task_started'), promptAt(3 * MIN + 1),
  ]), [['working', undefined, 1000], ['waiting_user', 'plan_approval', 3 * MIN + 1 - 1000]]);
});

test('ordinary completed turns wait for the next instruction', () => {
  assert.deepEqual(summarize([eventAt(0, 'task_complete'), eventAt(MIN, 'token_count'), promptAt(2 * MIN)]),
    [['waiting_user', 'next_instruction', 2 * MIN]]);
});

test('a plan checklist completion alone is not a plan approval request', () => {
  assert.deepEqual(summarize([
    updatePlan(0, [{ step: 'done', status: 'completed' }]), eventAt(MIN, 'task_complete'), promptAt(2 * MIN),
  ]), [['working', undefined, MIN], ['waiting_user', 'next_instruction', MIN]]);
});

test('background wait tools classify short waits and waits exceeding six hours as idle', () => {
  for (const [name, args] of [['wait_agent', {}], ['wait', { cell_id: 'c' }],
    ['wait', { ids: ['agent'] }], ['write_stdin', { session_id: 1, chars: '' }]]) {
    for (const duration of [1000, 7 * HOUR]) {
      assert.deepEqual(summarize([callAt(0, name, 'w', args), eventAt(500, 'token_count'), resultAt(duration, 'w')]),
        [['idle', undefined, duration]], name);
    }
  }
});

test('sending command stdin and spawning a child are not background waits', () => {
  for (const [name, args] of [['write_stdin', { session_id: 1, chars: 'go\n' }], ['spawn_agent', {}]]) {
    assert.deepEqual(summarize([callAt(0, name, 'w', args), resultAt(MIN, 'w')]), [['working', undefined, MIN]]);
  }
});

test('background notifications are never human prompts, including long waits', () => {
  for (const notification of [
    { timestamp: iso(7 * HOUR), type: 'response_item', payload: { type: 'agent_message', author: 'child' } },
    eventAt(7 * HOUR, 'user_message', { message: '<task-notification>done</task-notification>' }),
  ]) assert.deepEqual(summarize([workAt(0), notification]), [['idle', undefined, 7 * HOUR]]);
});

test('main-thread work during a pending tool keeps its own time', () => {
  assert.deepEqual(summarize([
    callAt(0, 'wait_agent', 'w'), workAt(MIN), eventAt(2 * MIN, 'token_count'), resultAt(3 * MIN, 'w'),
  ]), [['working', undefined, MIN], ['idle', undefined, 2 * MIN]]);
});

test('unrelated result ids do not close waits and unresolved calls do not invent durations', () => {
  assert.deepEqual(summarize([callAt(0, 'wait_agent', 'w'), resultAt(MIN, 'other')]), [['working', undefined, MIN]]);
});

test('exactly five minutes is idle fallback, matching Claude', () => {
  assert.deepEqual(summarize([workAt(0), workAt(5 * MIN)]), [['idle', undefined, 5 * MIN]]);
  assert.deepEqual(summarize([workAt(0), workAt(5 * MIN - 1)]), [['working', undefined, 5 * MIN - 1]]);
});

test('six-hour human waits remain breaks', () => {
  assert.deepEqual(summarize([callAt(0, 'request_user_input', 'q'), resultAt(6 * HOUR, 'q', { answers: { q: {} } })]),
    [['break', undefined, 6 * HOUR]]);
});

test('invalid timestamp records cannot break the timeline', () => {
  assert.deepEqual(summarize([workAt(0), { ...workAt(1), timestamp: 'invalid' }, workAt(MIN)]),
    [['working', undefined, MIN]]);
});

test('modern UserMessage items close next-instruction and plan-approval waits', () => {
  for (const plan of [false, true]) {
    const records = plan ? [eventAt(0, 'item_completed', { item: { type: 'Plan' } })] : [workAt(0)];
    records.push(eventAt(MIN, 'task_complete'), eventAt(2 * MIN, 'task_started'),
      { timestamp: iso(2 * MIN), type: 'response_item', payload: { type: 'message', role: 'user', content: [] } },
      eventAt(2 * MIN + 1, 'item_completed', { item: { type: 'UserMessage', content: [] } }));
    assert.deepEqual(summarize(records), [['working', undefined, MIN],
      ['waiting_user', plan ? 'plan_approval' : 'next_instruction', MIN + 1]]);
  }
});

test('async questions allow continued work and classify only the subsequent turn-end wait', () => {
  assert.deepEqual(summarize([
    callAt(0, 'request_user_input_async', 'q'), resultAt(100, 'q', { accepted: true }),
    workAt(MIN), eventAt(2 * MIN, 'task_complete'), promptAt(3 * MIN),
  ]), [['working', undefined, 2 * MIN], ['waiting_user', 'question_answer', MIN]]);
});

test('wrapped stdin polling includes the CommandExecution completion echo in its idle span', () => {
  const call = { timestamp: iso(0), type: 'response_item', payload: { type: 'custom_tool_call',
    name: 'exec', call_id: 'e', input: 'const r = await tools.write_stdin({session_id: 1,chars:"",yield_time_ms:30000}); text(r.output);' } };
  const result = { timestamp: iso(MIN), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'e', output: [] } };
  assert.deepEqual(summarize([call, eventAt(MIN - 1, 'item_completed', { item: { type: 'CommandExecution' } }), result]),
    [['idle', undefined, MIN]]);
  call.payload.input = 'await tools.write_stdin({session_id: 1,chars:"go"});';
  assert.deepEqual(summarize([call, result]), [['working', undefined, MIN]]);
});

test('modern subagent completion notifications are background waits', () => {
  assert.deepEqual(summarize([workAt(0), eventAt(MIN, 'item_completed',
    { item: { type: 'SubAgentActivity', kind: 'completed' } })]), [['idle', undefined, MIN]]);
});

test('mixed exec work is not charged entirely to a waiting tool', () => {
  const call = { timestamp: iso(0), type: 'response_item', payload: { type: 'custom_tool_call',
    name: 'exec', call_id: 'e', input: 'await tools.exec_command({cmd:"build"}); await tools.request_permissions({});' } };
  assert.deepEqual(summarize([call, { ...resultAt(MIN, 'e'), payload: { type: 'custom_tool_call_output', call_id: 'e', output: '{}' } }]),
    [['working', undefined, MIN]]);
});

test('failed async questions do not turn the next instruction into a question answer', () => {
  assert.deepEqual(summarize([
    callAt(0, 'request_user_input_async', 'q'), resultAt(100, 'q', { error: 'unavailable' }),
    eventAt(MIN, 'task_complete'), promptAt(2 * MIN),
  ]), [['working', undefined, MIN], ['waiting_user', 'next_instruction', MIN]]);
});

// ─── PermissionRequest markers: command_approval waits ──────────────────────
// Codex never writes an approval prompt or its decision to the rollout. A PermissionRequest hook
// marker is the START of a human wait; the rollout says where it ENDS: the approved command's
// started_at_ms, the approved patch's completed_at_ms, a turn_aborted (a "No"), or the next real
// main-thread record.

const policyAt = (ms, approval_policy = 'on-request', approvals_reviewer = 'user') => ({ timestamp: iso(ms),
  type: 'turn_context', payload: { cwd: '/x', approval_policy, ...(approvals_reviewer === undefined ? {} : { approvals_reviewer }) } });
const markerAt = (ms, extra = {}) => ({ ts: T0 + ms, turnId: 't1', agentId: null, toolName: 'exec_command',
  permissionMode: 'default', ...extra });
const commandDoneAt = (ms, startedMs) => eventAt(ms, 'item_completed',
  { item: { type: 'CommandExecution', id: `c-${ms}` }, started_at_ms: T0 + startedMs, completed_at_ms: T0 + ms });
const patchDoneAt = (ms, completedMs) => eventAt(ms, 'item_completed',
  { item: { type: 'FileChange', id: `f-${ms}`, changes: {} }, started_at_ms: T0 + 1500, completed_at_ms: T0 + completedMs });
const markedTimeline = (records, markers, file) => computeSessionTimeline(file || writeRollout(records), 'sess-1',
  { readAgents: () => ({}), readPermissionMarkers: () => markers });
const markedPeriods = (records, markers, file) => markedTimeline(records, markers, file).periods
  .map((p) => [p.state, p.waiting_subtype, Date.parse(p.ended_at) - Date.parse(p.started_at)]);
const approvals = (periods) => periods.filter((p) => p[1] === 'command_approval');

// The canonical exec approval: marker at T=2s, the user approves at T+8s (the command's
// started_at_ms), the command finishes at T+20s. The function_call_output is written before the
// completion echo at the same millisecond, so the end must not hinge on record order.
const execApproval = () => [
  policyAt(0), workAt(1000), callAt(1500, 'exec_command', 'x', { cmd: 'npm test' }),
  resultAt(22000, 'x', { output: 'ok' }), commandDoneAt(22000, 10000),
];

test('an approved command charges marker to started_at_ms as command_approval, the run stays working', () => {
  assert.deepEqual(markedPeriods(execApproval(), [markerAt(2000)]), [
    ['working', undefined, 2000],
    ['waiting_user', 'command_approval', 8000],
    ['working', undefined, 12000],
  ]);
});

test('an approved patch ends its wait at the FileChange completed_at_ms', () => {
  const periods = markedPeriods([policyAt(0), workAt(1000), patchDoneAt(12000, 8000), workAt(13000)],
    [markerAt(2000, { toolName: 'apply_patch' })]);
  assert.deepEqual(approvals(periods), [['waiting_user', 'command_approval', 6000]]);
});

test('a declined prompt (turn_aborted) is command_approval up to the abort, not idle or working', () => {
  assert.deepEqual(markedPeriods([policyAt(0), workAt(1000), abortAt(7000)], [markerAt(2000)]), [
    ['working', undefined, 2000],
    ['waiting_user', 'command_approval', 5000],
  ]);
});

test('a marker is not a human wait when no human could have been asked', () => {
  const cases = [
    ['policy never', [policyAt(0, 'never')].concat(execApproval().slice(1)), markerAt(2000)],
    ['auto reviewer', [policyAt(0, 'on-request', 'auto_review')].concat(execApproval().slice(1)), markerAt(2000)],
    ['bypassPermissions', execApproval(), markerAt(2000, { permissionMode: 'bypassPermissions' })],
    ['subagent prompt', execApproval(), markerAt(2000, { agentId: 'agent-1' })],
    ['no turn_context yet', execApproval().slice(1), markerAt(2000)],
    ['before the first record', execApproval(), markerAt(-5000)],
    ['at the last record', execApproval(), markerAt(22000)],
  ];
  for (const [name, records, marker] of cases) {
    assert.deepEqual(approvals(markedPeriods(records, [marker])), [], name);
  }
});

test('a turn_context without approvals_reviewer (older builds) counts as a human reviewer', () => {
  const records = [policyAt(0, 'on-request', undefined)].concat(execApproval().slice(1));
  assert.deepEqual(approvals(markedPeriods(records, [markerAt(2000)])), [['waiting_user', 'command_approval', 8000]]);
});

test('a granular approval policy asks, so its markers count', () => {
  const records = [policyAt(0, { granular: { sandbox_approval: true, rules: true } })].concat(execApproval().slice(1));
  assert.deepEqual(approvals(markedPeriods(records, [markerAt(2000)])), [['waiting_user', 'command_approval', 8000]]);
});

test('a parallel batch of prompts is one wait: only the earliest marker opens a span', () => {
  const markers = [markerAt(2050), markerAt(2000)];
  assert.deepEqual(markerSpans(execApproval(), markers),
    [{ start: T0 + 2000, end: T0 + 10000, state: 'waiting_user', subtype: 'command_approval' }]);
  assert.deepEqual(approvals(markedPeriods(execApproval(), markers)), [['waiting_user', 'command_approval', 8000]]);
});

test('a sub-second approval is auto-resolved noise and charges nothing', () => {
  const records = [policyAt(0), workAt(1000), commandDoneAt(5000, 2600), workAt(6000)];
  assert.deepEqual(markerSpans(records, [markerAt(2000)]), []);
  assert.deepEqual(approvals(markedPeriods(records, [markerAt(2000)])), []);
});

test('a request_permissions marker adds nothing to the rollout call that already yields the wait', () => {
  const records = [policyAt(0), callAt(1000, 'request_permissions', 'p'),
    resultAt(11000, 'p', { permissions: {} }), workAt(12000)];
  const marker = markerAt(1100, { toolName: 'request_permissions' });
  assert.deepEqual(markerSpans(records, [marker]), []);
  assert.deepEqual(markedPeriods(records, [marker]), [
    ['working', undefined, 1000],
    ['waiting_user', 'command_approval', 10000],
    ['working', undefined, 1000],
  ]);
});

test('an approval left unanswered for six hours is a break, not command_approval', () => {
  assert.deepEqual(markedPeriods([policyAt(0), workAt(1000), promptAt(2000 + BREAK_GAP_MS)], [markerAt(2000)]), [
    ['working', undefined, 2000],
    ['break', undefined, BREAK_GAP_MS],
  ]);
});

test('a marker with no rollout signal after it is never extended to wall-clock now', () => {
  // The marker sits before the last record, but nothing after it ends a wait: only bookkeeping.
  const records = [policyAt(0), workAt(1000), eventAt(9000, 'token_count')];
  assert.deepEqual(markerSpans(records, [markerAt(2000)]), []);
});

test('the interval before the marker keeps the mode in force: planning stays planning', () => {
  const records = [{ ...policyAt(0), payload: { ...policyAt(0).payload, collaboration_mode: { mode: 'plan' } } }]
    .concat(execApproval().slice(1));
  assert.deepEqual(markedPeriods(records, [markerAt(2000)]), [
    ['planning', undefined, 2000],
    ['waiting_user', 'command_approval', 8000],
    ['planning', undefined, 12000],
  ]);
});

test('a zstd-compressed rollout yields the same marker periods as the plain one',
  { skip: typeof zlib.zstdCompressSync !== 'function' }, () => {
    const plain = writeRollout(execApproval());
    const zst = plain + '.zst';
    fs.writeFileSync(zst, zlib.zstdCompressSync(fs.readFileSync(plain)));
    fs.unlinkSync(plain);
    const fromZst = markedTimeline(null, [markerAt(2000)], zst);
    assert.ok(fromZst, 'a .zst rollout must be read, not dropped');
    assert.deepEqual(fromZst.periods, markedTimeline(execApproval(), [markerAt(2000)]).periods);
  });

test('without a session id the marker reader is never called', () => {
  let called = false;
  const tl = computeSessionTimeline(writeRollout(execApproval()), null,
    { readPermissionMarkers: () => { called = true; return [markerAt(2000)]; } });
  assert.equal(called, false);
  assert.deepEqual(tl.periods.filter((p) => p.waiting_subtype === 'command_approval'), []);
});

test('a throwing marker reader degrades to no markers', () => {
  const tl = computeSessionTimeline(writeRollout(execApproval()), 'sess-1',
    { readAgents: () => ({}), readPermissionMarkers: () => { throw new Error('boom'); } });
  assert.deepEqual(tl.periods.map((p) => p.state), ['working']);
});

// ─── Plan clear-context handoff ─────────────────────────────────────────────
// "Yes, clear context" starts a NEW rollout and writes nothing to the old one, so the old
// timeline would end at task_complete. computeSessionTimeline appends the wait up to the
// successor's first prompt, found through deps.planHandoff (fakes here: no FS).

const H0 = Date.parse('2026-05-01T10:00:00.000Z');
const hIso = (ms) => new Date(ms).toISOString();
const hRec = (ms, type, payload) => ({ timestamp: hIso(ms), type, payload });
const HANDOFF_PLAN = '# Plan\n' + 'step '.repeat(80);
const HANDOFF_CWD = path.join(os.tmpdir(), 'handoff-proj');
const HANDOFF_PREFIX = "A previous agent produced the plan below to accomplish the user's task. Implement the plan in a fresh context. Treat the plan as the source of user intent, re-read files as needed, and carry the work through implementation and verification.";
const HWAIT = H0 + 6000;
const oldPlanSession = () => [
  hRec(H0, 'session_meta', { id: 'old-id', cwd: HANDOFF_CWD }),
  hRec(H0 + 1000, 'event_msg', { type: 'user_message', message: 'plan it' }),
  hRec(H0 + 5000, 'event_msg', { type: 'item_completed', item: { type: 'Plan', id: 'p', text: HANDOFF_PLAN } }),
  hRec(HWAIT, 'event_msg', { type: 'task_complete' }),
  // Trailing bookkeeping past task_complete: the appended wait must not overlap the period it ends.
  hRec(HWAIT + 1, 'event_msg', { type: 'token_count' }),
];
// A successor whose session_meta lands metaDelay after the wait and whose first prompt lands promptDelay after.
const successorHead = (metaDelay, promptDelay) => [
  hRec(HWAIT + metaDelay, 'session_meta', { id: 'new-id', cwd: HANDOFF_CWD }),
  hRec(HWAIT + promptDelay, 'event_msg', { type: 'user_message', message: `${HANDOFF_PREFIX}\n\n${HANDOFF_PLAN}` }),
];
const handoffDeps = (head, calls = []) => ({
  readAgents: () => ({}),
  readPermissionMarkers: () => [],
  planHandoff: {
    platform: 'linux',
    listRollouts: () => { calls.push('list'); return ['new.jsonl']; },
    statMtimeMs: () => { calls.push('stat'); return HWAIT + 30000; },
    readHead: () => { calls.push('head'); return head; },
    readAll: () => { calls.push('all'); return []; },
  },
});
const tail = (tl) => {
  const p = tl.periods[tl.periods.length - 1];
  return [p.state, p.waiting_subtype, Date.parse(p.ended_at) - Date.parse(p.started_at)];
};
const assertContiguous = (tl) => {
  for (let i = 1; i < tl.periods.length; i++) {
    assert.ok(Date.parse(tl.periods[i].started_at) >= Date.parse(tl.periods[i - 1].ended_at),
      `period ${i} starts before period ${i - 1} ends`);
  }
};

test('a clear-context successor 26 s later appends the plan_approval wait and moves ended_at', () => {
  const tl = computeSessionTimeline(writeRollout(oldPlanSession()), 'old-id', handoffDeps(successorHead(25000, 26000)));
  assert.deepEqual(tail(tl), ['waiting_user', 'plan_approval', 26000]);
  assert.equal(tl.periods[tl.periods.length - 1].started_at, hIso(HWAIT));
  assert.equal(tl.ended_at, hIso(HWAIT + 26000));
  assertContiguous(tl);
});

// The tail real Codex writes after a Plan: the assistant's final_answer message, a
// token_usage_record and token_count sit between the Plan item and task_complete.
const realPlanSession = () => [
  hRec(H0, 'session_meta', { id: 'old-id', cwd: HANDOFF_CWD }),
  hRec(H0 + 500, 'event_msg', { type: 'task_started', turn_id: 'turn-1' }),
  hRec(H0 + 1000, 'event_msg', { type: 'user_message', message: 'plan it' }),
  hRec(H0 + 5000, 'event_msg', { type: 'item_completed', turn_id: 'turn-1', item: { type: 'Plan', id: 'p', text: HANDOFF_PLAN } }),
  hRec(H0 + 5026, 'response_item', { type: 'message', role: 'assistant', phase: 'final_answer',
    content: [{ type: 'output_text', text: `<proposed_plan>\n${HANDOFF_PLAN}\n</proposed_plan>` }] }),
  hRec(H0 + 5041, 'token_usage_record', { turn_id: 'turn-1' }),
  hRec(H0 + 5059, 'event_msg', { type: 'token_count' }),
  hRec(HWAIT, 'event_msg', { type: 'task_complete', turn_id: 'turn-1' }),
];

test('the real Codex Plan tail still appends the plan_approval wait', () => {
  const tl = computeSessionTimeline(writeRollout(realPlanSession()), 'old-id', handoffDeps(successorHead(25000, 26000)));
  assert.deepEqual(tail(tl), ['waiting_user', 'plan_approval', 26000]);
  assert.equal(tl.periods[tl.periods.length - 1].started_at, hIso(HWAIT));
  assert.equal(tl.ended_at, hIso(HWAIT + 26000));
  assertContiguous(tl);
});

// Bookkeeping can land after the successor's first prompt (a late thread_settings_applied):
// ended_at never moves backward past the rollout's own last record.
test('ended_at never moves backward when the rollout runs past the successor prompt', () => {
  const recs = [...oldPlanSession(), hRec(HWAIT + 60000, 'event_msg', { type: 'thread_settings_applied' })];
  const tl = computeSessionTimeline(writeRollout(recs), 'old-id', handoffDeps(successorHead(25000, 26000)));
  assert.deepEqual(tail(tl), ['waiting_user', 'plan_approval', 26000]);
  assert.equal(tl.ended_at, hIso(HWAIT + 60000));
});

test('a successor whose first prompt is 6 h or more after the wait leaves the timeline unchanged', () => {
  const file = writeRollout(oldPlanSession());
  const SIX_H = 6 * 3600 * 1000;
  // session_meta inside the finder's 6 h window, first prompt past it: only the timeline's own guard rejects.
  const tl = computeSessionTimeline(file, 'old-id', handoffDeps(successorHead(SIX_H - 2000, SIX_H)));
  const base = computeSessionTimeline(file, 'old-id', handoffDeps([]));
  assert.deepEqual(tl.periods, base.periods);
  assert.equal(tl.ended_at, base.ended_at);
  assert.equal(tl.ended_at, hIso(HWAIT + 1));
});

test('no session id: no successor lookup, the timeline is unchanged', () => {
  const calls = [];
  const deps = handoffDeps(successorHead(25000, 26000), calls);
  const tl = computeSessionTimeline(writeRollout(oldPlanSession()), null, deps);
  assert.deepEqual(calls, []);
  assert.equal(tl.ended_at, hIso(HWAIT + 1));
  assert.notDeepEqual(tail(tl), ['waiting_user', 'plan_approval', 26000]);
});

test('a session that does not end on a Plan wait never looks for a successor', () => {
  const calls = [];
  const recs = [...oldPlanSession(), hRec(HWAIT + 9000, 'event_msg', { type: 'user_message', message: 'go on' })];
  computeSessionTimeline(writeRollout(recs), 'old-id', handoffDeps(successorHead(25000, 26000), calls));
  assert.deepEqual(calls, []);
});

test('a throwing successor finder leaves the timeline unchanged', () => {
  const file = writeRollout(oldPlanSession());
  const deps = handoffDeps([]);
  deps.planHandoff.listRollouts = () => { throw new Error('boom'); };
  deps.planHandoff.readHead = () => { throw new Error('boom'); };
  const tl = computeSessionTimeline(file, 'old-id', deps);
  assert.equal(tl.ended_at, hIso(HWAIT + 1));
});

test('computeSessionTimeline with deps.readLines equals the file read', () => {
  const file = writeRollout([
    userMsg(0), planMode(0), updatePlan(1, [{ step: 'a', status: 'completed' }]), work(2), work(10), userMsg(12),
  ]);
  fs.appendFileSync(file, 'NOT JSON\n\n' + JSON.stringify(work(13)) + '\n');
  const lines = readRolloutLines(file);
  const withoutStamp = (tl) => ({ ...tl, generated_at: undefined });
  const expected = withoutStamp(computeSessionTimeline(file));
  fs.unlinkSync(file);
  assert.deepEqual(withoutStamp(computeSessionTimeline(file, null, { readLines: () => lines })), expected);
});
