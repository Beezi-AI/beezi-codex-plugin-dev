import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  PLAN_HANDOFF_PREFIX, PLAN_MATCH_CHARS, BREAK_GAP_MS, handoffPlanText, trailingPlanWait, samePlan,
  findPlanSuccessor, findPlanPredecessor,
} from '../lib/plan-handoff-codex.mjs';
import { BREAK_GAP_SEC } from '../lib/session-timeline-codex.mjs';

const T0 = Date.parse('2026-05-01T10:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const rec = (ms, type, payload) => ({ timestamp: iso(ms), type, payload });
const meta = (ms, cwd = 'C:\\proj\\app') => rec(ms, 'session_meta', { id: `id-${ms}`, cwd });
const prompt = (ms, text) => rec(ms, 'event_msg', {
  type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text }] } });
const legacyPrompt = (ms, message) => rec(ms, 'event_msg', { type: 'user_message', message });
const plan = (ms, text) => rec(ms, 'event_msg', { type: 'item_completed', item: { type: 'Plan', id: 'p', text } });
const done = (ms) => rec(ms, 'event_msg', { type: 'task_complete' });
const tokens = (ms) => rec(ms, 'event_msg', { type: 'token_count' });
const handoff = (text) => `${PLAN_HANDOFF_PREFIX}\n\n${text}`;

const PLAN = '# Plan\n' + 'step '.repeat(80);
const oldRecords = (cwd) => [meta(T0, cwd), prompt(T0 + 1000, 'do it'), plan(T0 + 5000, PLAN), done(T0 + 6000), tokens(T0 + 6001)];
const WAIT = T0 + 6000;
const newRecords = (planText, delay = 26000, cwd = 'C:\\proj\\app') =>
  [meta(WAIT + delay - 1000, cwd), prompt(WAIT + delay, handoff(planText))];

const OLD = 'C:\\s\\old.jsonl';
const mk = (files, extra = {}) => ({
  platform: 'linux',
  listRollouts: () => Object.keys(files),
  statMtimeMs: (p) => orMtime(files[p]),
  readHead: (p) => files[p].records,
  readAll: (p) => files[p].records,
  ...extra,
});
function orMtime(f) { return f.mtimeMs === undefined ? Date.now() : f.mtimeMs; }

test('handoffPlanText', () => {
  assert.equal(handoffPlanText([meta(T0), prompt(T0 + 1, handoff(PLAN))]), PLAN);
  assert.equal(handoffPlanText([meta(T0), legacyPrompt(T0 + 1, handoff(PLAN))]), PLAN);
  assert.equal(handoffPlanText([meta(T0), prompt(T0 + 1, 'hello')]), null);
  assert.equal(handoffPlanText([meta(T0), prompt(T0 + 1, 'hello'), prompt(T0 + 2, handoff(PLAN))]), null);
  assert.equal(handoffPlanText([]), null);
});

test('trailingPlanWait', () => {
  assert.deepEqual(trailingPlanWait(oldRecords()), { planText: PLAN, waitStartMs: WAIT });
  assert.equal(trailingPlanWait([...oldRecords(), prompt(T0 + 9000, 'go')]), null);
  assert.equal(trailingPlanWait([meta(T0), prompt(T0 + 1, 'x'), done(T0 + 2)]), null);
  assert.equal(trailingPlanWait([meta(T0), plan(T0 + 1, PLAN)]), null);
});

// Bookkeeping Codex writes after a turn ends (isBookkeeping in timeline-waits-codex.mjs) does not
// hide the plan wait; a task_started after task_complete is a new turn and still does.
test('trailingPlanWait: tolerates bookkeeping after task_complete', () => {
  const tail = [
    rec(T0 + 6002, 'turn_context', { cwd: 'C:\\proj\\app' }),
    rec(T0 + 6003, 'world_state', {}),
    rec(T0 + 6004, 'event_msg', { type: 'thread_settings_applied' }),
    tokens(T0 + 6005),
  ];
  assert.deepEqual(trailingPlanWait([...oldRecords(), ...tail]), { planText: PLAN, waitStartMs: WAIT });
  assert.equal(trailingPlanWait([...oldRecords(), rec(T0 + 7000, 'event_msg', { type: 'task_started' })]), null);
  assert.equal(trailingPlanWait([meta(T0), plan(T0 + 5000, PLAN), done(T0 + 6000), done(T0 + 6001)]), null);
});

// The tail real Codex writes after a Plan (measured on every Plan session in ~/.codex/sessions):
// Plan item -> assistant final_answer message -> token_usage_record -> token_count -> task_complete.
// The final_answer is not bookkeeping, so the wait must be found by turn, not by adjacency.
const TURN = '01a07b66-aaaa-7bbb-8ccc-000000000001';
const realPlan = (ms, text, turn = TURN) => rec(ms, 'event_msg', {
  type: 'item_completed', thread_id: 't', turn_id: turn, item: { type: 'Plan', id: 'p', text } });
const finalAnswer = (ms, text) => rec(ms, 'response_item', {
  type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text }] });
const usageRecord = (ms, turn = TURN) => ({ timestamp: iso(ms), type: 'token_usage_record', payload: { turn_id: turn } });
const realDone = (ms, turn = TURN) => rec(ms, 'event_msg', { type: 'task_complete', turn_id: turn });
const started = (ms, turn = TURN) => rec(ms, 'event_msg', { type: 'task_started', turn_id: turn });
const realTail = (planMs, turn = TURN) => [
  realPlan(planMs, PLAN, turn),
  finalAnswer(planMs + 26, `<proposed_plan>\n${PLAN}\n</proposed_plan>`),
  usageRecord(planMs + 41, turn),
  tokens(planMs + 59),
  realDone(planMs + 611, turn),
];
const realOld = (cwd) => [meta(T0, cwd), started(T0 + 500), prompt(T0 + 1000, 'do it'), ...realTail(T0 + 5000)];
const REAL_WAIT = T0 + 5611;

test('trailingPlanWait: the real Codex tail (final_answer, token_usage_record, token_count)', () => {
  assert.deepEqual(trailingPlanWait(realOld()), { planText: PLAN, waitStartMs: REAL_WAIT });
});

test('trailingPlanWait: reasoning, assistant messages and tool calls between Plan and task_complete', () => {
  const between = [
    rec(T0 + 5001, 'event_msg', { type: 'item_completed', turn_id: TURN, item: { type: 'Reasoning' } }),
    rec(T0 + 5002, 'response_item', { type: 'reasoning' }),
    rec(T0 + 5003, 'response_item', { type: 'function_call', name: 'shell', call_id: 'c1', arguments: '{}' }),
    rec(T0 + 5004, 'response_item', { type: 'function_call_output', call_id: 'c1', output: 'ok' }),
    finalAnswer(T0 + 5005, 'done'),
    tokens(T0 + 5006),
    realDone(T0 + 5600),
  ];
  const recs = [meta(T0), started(T0 + 500), prompt(T0 + 1000, 'do it'), realPlan(T0 + 5000, PLAN), ...between];
  assert.deepEqual(trailingPlanWait(recs), { planText: PLAN, waitStartMs: T0 + 5600 });
});

test('trailingPlanWait: a prompt after the Plan in the same turn means no trailing wait', () => {
  const recs = [meta(T0), started(T0 + 500), prompt(T0 + 1000, 'do it'), realPlan(T0 + 5000, PLAN),
    prompt(T0 + 5100, 'actually, change step 2'), finalAnswer(T0 + 5200, 'ok'), realDone(T0 + 5600)];
  assert.equal(trailingPlanWait(recs), null);
});

// M8: Codex writes a raw response_item user message next to the UserMessage item. After the Plan it
// is a prompt, not bookkeeping — inside the turn and after task_complete alike.
test('trailingPlanWait: a raw user message after the Plan counts as a prompt', () => {
  const raw = (ms) => rec(ms, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] });
  const inTurn = [meta(T0), started(T0 + 500), prompt(T0 + 1000, 'do it'), realPlan(T0 + 5000, PLAN),
    raw(T0 + 5100), realDone(T0 + 5600)];
  assert.equal(trailingPlanWait(inTurn), null);
  assert.equal(trailingPlanWait([...realOld(), raw(REAL_WAIT + 9000)]), null);
  // Developer / system messages after task_complete stay bookkeeping.
  const dev = rec(REAL_WAIT + 9000, 'response_item', { type: 'message', role: 'developer', content: [] });
  assert.deepEqual(trailingPlanWait([...realOld(), dev]), { planText: PLAN, waitStartMs: REAL_WAIT });
});

test('trailingPlanWait: only the last turn counts', () => {
  // A Plan in an earlier turn, then a turn that ends without one.
  const later = [started(T0 + 9000, 'turn-2'), prompt(T0 + 9001, 'thanks'), finalAnswer(T0 + 9500, 'np'),
    realDone(T0 + 9600, 'turn-2')];
  assert.equal(trailingPlanWait([...realOld(), ...later]), null);
  // A Plan whose turn_id differs from the task_complete's is not this turn's Plan.
  const mismatched = [meta(T0), prompt(T0 + 1000, 'do it'), realPlan(T0 + 5000, PLAN, 'turn-x'),
    finalAnswer(T0 + 5026, 'p'), realDone(T0 + 5611, 'turn-y')];
  assert.equal(trailingPlanWait(mismatched), null);
});

test('findPlanSuccessor and findPlanPredecessor match across the real tail', () => {
  const files = { [OLD]: { records: realOld(), mtimeMs: REAL_WAIT + 100 }, 'new.jsonl': { records: newRecords(PLAN) } };
  const succ = findPlanSuccessor(OLD, realOld(), mk(files));
  assert.equal(succ.transcriptPath, 'new.jsonl');
  const pred = findPlanPredecessor('new.jsonl', newRecords(PLAN), mk(files));
  assert.deepEqual(pred, { transcriptPath: OLD, sessionId: `id-${T0}`, waitStartMs: REAL_WAIT });
});

// The local constant exists only because importing BREAK_GAP_SEC would form an import cycle
// (session-timeline-codex.mjs imports this module); this pins the two together.
test('BREAK_GAP_MS equals session-timeline BREAK_GAP_SEC', () => {
  assert.equal(BREAK_GAP_MS, BREAK_GAP_SEC * 1000);
});

test('samePlan', () => {
  assert.equal(samePlan(' abc ', 'abc'), true);
  assert.equal(samePlan('', ''), false);
  assert.equal(samePlan('a', 'b'), false);
  assert.equal(PLAN_MATCH_CHARS, 200);
});

test('findPlanSuccessor: match, firstPromptMs', () => {
  const files = { [OLD]: { records: oldRecords() }, 'new.jsonl': { records: newRecords(PLAN) } };
  const r = findPlanSuccessor(OLD, oldRecords(), mk(files));
  assert.deepEqual(r, { transcriptPath: 'new.jsonl', sessionId: `id-${WAIT + 25000}`, firstPromptMs: WAIT + 26000 });
});

test('findPlanSuccessor: rejections', () => {
  const run = (head, extra) => findPlanSuccessor(OLD, oldRecords(), mk({ 'n.jsonl': { records: head, ...extra } }));
  assert.equal(run(newRecords(PLAN, 26000, 'C:\\other')), null);
  assert.equal(run(newRecords(PLAN, 6 * 3600 * 1000 + 1000)), null);
  assert.equal(run(newRecords('X' + PLAN)), null);
  assert.equal(run(newRecords(PLAN), { mtimeMs: WAIT - 1 }), null);
  assert.equal(run([meta(WAIT - 5), prompt(WAIT - 4, handoff(PLAN))]), null);
  assert.equal(findPlanSuccessor(OLD, [meta(T0), prompt(T0 + 1, 'x')], mk({})), null);
  assert.equal(findPlanSuccessor(OLD, oldRecords().slice(1), mk({})), null);
});

test('findPlanSuccessor: differs only after 200 chars matches; earliest wins; skips self', () => {
  const tail = PLAN.slice(0, PLAN_MATCH_CHARS) + ' DIFFERENT';
  const files = {
    [OLD]: { records: newRecords(PLAN, 1000) },
    late: { records: newRecords(PLAN, 90000) },
    early: { records: newRecords(tail, 20000) },
  };
  const r = findPlanSuccessor(OLD, oldRecords(), mk(files));
  assert.equal(r.transcriptPath, 'early');
  assert.equal(r.firstPromptMs, WAIT + 20000);
});

test('findPlanPredecessor: match and rejections', () => {
  const nw = newRecords(PLAN);
  const base = (cwd) => ({ [OLD]: { records: oldRecords(cwd), mtimeMs: WAIT + 100 } });
  assert.deepEqual(findPlanPredecessor('new.jsonl', nw, mk(base())),
    { transcriptPath: OLD, sessionId: `id-${T0}`, waitStartMs: WAIT });
  assert.equal(findPlanPredecessor('new.jsonl', nw, mk(base('C:\\other'))), null);
  assert.equal(findPlanPredecessor('new.jsonl', newRecords('Z' + PLAN), mk(base())), null);
  assert.equal(findPlanPredecessor('new.jsonl', [meta(T0), prompt(T0 + 1, 'x')], mk(base())), null);
  assert.equal(findPlanPredecessor('new.jsonl', nw, mk({ [OLD]: { records: oldRecords(), mtimeMs: WAIT - 7 * 3600 * 1000 } })), null);
  const answered = [...oldRecords(), prompt(WAIT + 2000, 'continue')];
  assert.equal(findPlanPredecessor('new.jsonl', nw, mk({ [OLD]: { records: answered, mtimeMs: WAIT + 100 } })), null);
  assert.equal(findPlanPredecessor('new.jsonl', nw, mk({ 'new.jsonl': { records: nw } })), null);
});

// The whole-file read is the expensive part, and it runs inside the Stop hook: a candidate whose
// head already shows another project or an out-of-window session_meta is never read in full.
test('findPlanPredecessor: head prefilter skips the full read for other projects', () => {
  const fullReads = [];
  const files = {
    other: { records: oldRecords('C:\\elsewhere'), mtimeMs: WAIT + 100 },
    stale: { records: [meta(WAIT - 7 * 3600 * 1000), plan(WAIT - 100, PLAN), done(WAIT)], mtimeMs: WAIT + 100 },
    [OLD]: { records: oldRecords(), mtimeMs: WAIT + 100 },
  };
  const r = findPlanPredecessor('new.jsonl', newRecords(PLAN),
    mk(files, { readAll: (p) => { fullReads.push(p); return files[p].records; } }));
  assert.equal(r.transcriptPath, OLD);
  assert.deepEqual(fullReads, [OLD]);
});

test('findPlanPredecessor: latest waitStart wins', () => {
  const mid = (ms) => [meta(ms - 5000), plan(ms - 100, PLAN), done(ms)];
  const files = { a: { records: mid(WAIT - 3000), mtimeMs: WAIT }, b: { records: mid(WAIT), mtimeMs: WAIT } };
  const r = findPlanPredecessor('n', newRecords(PLAN), mk(files));
  assert.equal(r.transcriptPath, 'b');
});

test('cwd case: only equal on win32', () => {
  const files = { 'n.jsonl': { records: newRecords(PLAN, 26000, 'c:\\PROJ\\app') } };
  assert.ok(findPlanSuccessor(OLD, oldRecords(), mk(files, { platform: 'win32' })));
  assert.equal(findPlanSuccessor(OLD, oldRecords(), mk(files, { platform: 'linux' })), null);
});

const scratch = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-handoff-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const jsonl = (records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

// The default readAll goes through the zstd-aware reader: Codex compresses rollouts older than 7 days.
test('findPlanPredecessor: default readAll reads a .zst predecessor', {
  skip: typeof zlib.zstdCompressSync !== 'function' ? 'zstd not available on this Node' : false,
}, (t) => {
  const dir = scratch(t);
  const cwd = path.join(dir, 'proj');
  const zst = path.join(dir, 'rollout-old.jsonl.zst');
  fs.writeFileSync(zst, zlib.zstdCompressSync(Buffer.from(jsonl(oldRecords(cwd)), 'utf-8')));
  const deps = { listRollouts: () => [zst], statMtimeMs: () => WAIT + 100 };
  assert.deepEqual(findPlanPredecessor('new.jsonl', newRecords(PLAN, 26000, cwd), deps),
    { transcriptPath: zst, sessionId: `id-${T0}`, waitStartMs: WAIT });
});

test('findPlanPredecessor: an undecodable candidate is skipped, not fatal', (t) => {
  const dir = scratch(t);
  const cwd = path.join(dir, 'proj');
  const bad = path.join(dir, 'rollout-bad.jsonl.zst');
  // zstd magic followed by garbage: the reader answers null or throws, either way no match.
  fs.writeFileSync(bad, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3, 4]));
  const good = path.join(dir, 'rollout-good.jsonl');
  fs.writeFileSync(good, jsonl(oldRecords(cwd)));
  const deps = { listRollouts: () => [bad, good], statMtimeMs: () => WAIT + 100 };
  const r = findPlanPredecessor('new.jsonl', newRecords(PLAN, 26000, cwd), deps);
  assert.equal(r.transcriptPath, good);
});

test('findPlanSuccessor: default readHead reads a real file', (t) => {
  const dir = scratch(t);
  const cwd = path.join(dir, 'proj');
  const file = path.join(dir, 'rollout-new.jsonl');
  fs.writeFileSync(file, jsonl([...newRecords(PLAN, 26000, cwd), prompt(WAIT + 90000, 'second')]));
  const deps = { listRollouts: () => [file], statMtimeMs: () => WAIT + 100000 };
  assert.deepEqual(findPlanSuccessor(OLD, oldRecords(cwd), deps),
    { transcriptPath: file, sessionId: `id-${WAIT + 25000}`, firstPromptMs: WAIT + 26000 });
});

// The filename carries the session's start (local time): rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl[.zst].
// Candidates whose name lies far outside the window are dropped before any stat or read; a day of
// slack on each side covers the timezone. Names are built from the UTC fields so the in-window ones
// stay in window on any machine timezone.
const UUID = '01a07b74-76fc-7693-b0ba-528eb88265f2';
const pad = (n) => String(n).padStart(2, '0');
const rolloutName = (msUtc, ext = '.jsonl.zst') => {
  const d = new Date(msUtc);
  return `rollout-${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(d.getUTCSeconds())}-${UUID}${ext}`;
};
const DAY = 24 * 3600 * 1000;
const counting = (files) => {
  const touched = [];
  return {
    touched,
    deps: mk(files, {
      statMtimeMs: (p) => { touched.push(p); return orMtime(files[p]); },
      readHead: (p) => { touched.push(p); return files[p].records; },
      readAll: (p) => { touched.push(p); return files[p].records; },
    }),
  };
};

test('findPlanSuccessor: a filename far outside the window is never stat-ed or read', () => {
  const inWindow = path.join('s', rolloutName(WAIT + 25000));
  const early = path.join('s', rolloutName(WAIT - 5 * DAY));
  const late = path.join('s', rolloutName(WAIT + 5 * DAY, '.jsonl'));
  const files = {
    [early]: { records: newRecords(PLAN) },
    [late]: { records: newRecords(PLAN) },
    [inWindow]: { records: newRecords(PLAN) },
    'unparsed.jsonl': { records: newRecords('other plan entirely') },
  };
  const c = counting(files);
  const r = findPlanSuccessor(OLD, oldRecords(), c.deps);
  assert.equal(r.transcriptPath, inWindow);
  assert.ok(!c.touched.includes(early) && !c.touched.includes(late), `touched ${c.touched}`);
  // A name that does not parse falls back to the mtime path.
  assert.ok(c.touched.includes('unparsed.jsonl'));
});

test('findPlanSuccessor: the window keeps names up to 6 h + 1 day after the wait', () => {
  // session_meta decides the match; the name only gates the read. A successor whose name is a few
  // hours off its session_meta (timezone) is still found.
  const shifted = path.join('s', rolloutName(WAIT + 6 * 3600 * 1000 + 8 * 3600 * 1000));
  const files = { [shifted]: { records: newRecords(PLAN) } };
  assert.equal(findPlanSuccessor(OLD, oldRecords(), mk(files)).transcriptPath, shifted);
});

test('findPlanPredecessor: a filename far outside the window is never stat-ed or read', () => {
  const NEW_META = WAIT + 25000;
  const good = path.join('s', rolloutName(T0));
  const old = path.join('s', rolloutName(NEW_META - 6 * 3600 * 1000 - 3 * DAY));
  const future = path.join('s', rolloutName(NEW_META + 3 * DAY));
  const files = {
    [old]: { records: oldRecords(), mtimeMs: WAIT + 100 },
    [future]: { records: oldRecords(), mtimeMs: WAIT + 100 },
    [good]: { records: oldRecords(), mtimeMs: WAIT + 100 },
  };
  const c = counting(files);
  const r = findPlanPredecessor('new.jsonl', newRecords(PLAN), c.deps);
  assert.equal(r.transcriptPath, good);
  assert.ok(!c.touched.includes(old) && !c.touched.includes(future), `touched ${c.touched}`);
});
