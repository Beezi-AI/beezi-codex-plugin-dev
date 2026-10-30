// Evidence for main-thread waits. A running child or process alone is not a wait: the parent
// may be doing useful work in parallel. Match blocking calls by call_id and classify their
// spans, including intervening bookkeeping, only while the main thread is actually blocked.
// Names and waiting subtypes match the Claude timeline contract.
import { toolNamesFromProgram } from './exec-program.mjs';
import { ASKING_POLICIES, approvalLabel } from './codex-permissions.mjs';

// Like Claude permission markers, an approval resolved faster than this was not a human reading a
// prompt. One threshold for both sources of command_approval: request_permissions calls and
// PermissionRequest markers.
const MIN_APPROVAL_WAIT_MS = 1000;

function argsOf(raw) {
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

export function isBackgroundNotification(rec) {
  const p = (rec || {}).payload || {};
  if (rec.type === 'response_item' && p.type === 'agent_message') return true;
  if (rec.type === 'event_msg' && p.type === 'item_completed' && p.item
    && p.item.type === 'SubAgentActivity' && p.item.kind === 'completed') return true;
  // Some builds deliver background task notifications through the user-message surface.
  return rec.type === 'event_msg' && p.type === 'user_message'
    && typeof p.message === 'string' && p.message.trimStart().indexOf('<task-notification>') === 0;
}

export function isTimelineUserPrompt(rec) {
  const p = (rec || {}).payload || {};
  return rec.type === 'event_msg' && (p.type === 'user_message'
    || (p.type === 'item_completed' && p.item && p.item.type === 'UserMessage'))
    && !isBackgroundNotification(rec);
}

function callName(p) {
  if (p.type !== 'custom_tool_call' || p.name !== 'exec') return p.name;
  const names = toolNamesFromProgram(p.input);
  return names.length === 1 ? names[0] : null;
}

function callWait(p) {
  const args = argsOf(p.arguments) || {};
  // Mixed exec programs have no per-inner-call timestamps. Async questions are not blockers.
  const name = callName(p);
  if (name === 'request_user_input') return { state: 'waiting_user', subtype: 'question_answer' };
  if (name === 'request_permissions') return { state: 'waiting_user', subtype: 'command_approval' };
  if (name === 'wait_agent' || name === 'wait' || name === 'write_stdin') {
    // Sending stdin is a command, whereas an empty stdin call waits for a background process.
    // Accept only literal polling arguments in wrapped exec; never evaluate JS or guess a
    // variable's value. These are the numeric/empty-string arguments present in real rollouts.
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

export function isBookkeeping(rec) {
  const p = rec.payload || {};
  // Completion echoes are observations of tools finishing, not fresh main-thread work.
  const completion = rec.type === 'event_msg' && p.type === 'item_completed' && p.item
    && ['CommandExecution', 'CollabAgentToolCall', 'McpToolCall', 'FileChange', 'ImageView'].indexOf(p.item.type) !== -1;
  return rec.type === 'token_usage_record' || rec.type === 'world_state'
    || completion
    // Modern prompts are written first as a raw user message, then as UserMessage. Preambles
    // and settings are also raw input messages; none proves the main agent resumed working.
    || (rec.type === 'response_item' && p.type === 'message'
      && (p.role === 'user' || p.role === 'developer' || p.role === 'system'))
    || rec.type === 'turn_context' || rec.type === 'inter_agent_communication_metadata'
    || (rec.type === 'event_msg' && (p.type === 'token_count' || p.type === 'task_complete' || p.type === 'task_started'
      || p.type === 'thread_settings_applied'));
}

// Records with a usable timestamp, oldest first, and their times. Each timestamp is parsed once;
// the stable sort keeps equal timestamps in input order.
function timedRecords(records) {
  const entries = [];
  for (const rec of records) {
    const ms = Date.parse(rec.timestamp);
    if (Number.isFinite(ms)) entries.push({ rec, ms });
  }
  entries.sort((a, b) => a.ms - b.ms);
  return { timed: entries.map((e) => e.rec), times: entries.map((e) => e.ms) };
}

// Index of the first element of an ascending array strictly greater than `ms`.
export function firstIndexAfter(sorted, ms) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Every instant at which a human approval wait can be seen to end, ascending. Codex persists neither
// the prompt nor the decision, so the end is read off what the decision caused:
//   - a "No" interrupts the turn: `event_msg/turn_aborted`;
//   - an approved command starts only after the prompt closes: CommandExecution `started_at_ms`
//     (the completion record's own timestamp is when the command finished, far too late);
//   - an approved patch is applied inside its FileChange span: `completed_at_ms`;
//   - otherwise, the next main-thread record that is not bookkeeping. The completion echoes above
//     ARE bookkeeping, which is why their start/finish fields are read separately.
// Taking the earliest candidate after a marker, rather than the first record of each kind, keeps
// the answer independent of the file order of records that share a millisecond.
function approvalEnds(timed) {
  const out = [];
  for (const rec of timed) {
    const ms = Date.parse(rec.timestamp);
    const p = rec.payload || {};
    const completed = rec.type === 'event_msg' && p.type === 'item_completed' && p.item ? p.item.type : null;
    if (rec.type === 'event_msg' && p.type === 'turn_aborted') out.push(ms);
    else if (!isBookkeeping(rec)) out.push(ms);
    if (completed === 'CommandExecution' && Number.isFinite(p.started_at_ms)) out.push(p.started_at_ms);
    if (completed === 'FileChange' && Number.isFinite(p.completed_at_ms)) out.push(p.completed_at_ms);
  }
  return out.sort((a, b) => a - b);
}

// Could a human have been looking at this prompt? The hook fires for every approval Codex is about
// to route, including ones nobody sees, so the marker alone is not proof.
function humanWasAsked(marker, ctx) {
  // Approvals bypassed: nothing was put on screen.
  if (marker.permissionMode === 'bypassPermissions') return false;
  // A subagent's prompt: the main thread's own records cannot place its end.
  if (marker.agentId) return false;
  // The rollout's request_permissions call/output pair already yields this exact wait.
  if (marker.toolName === 'request_permissions') return false;
  // No turn_context yet: the policy is unknown, and unknown never charges the human.
  if (!ctx) return false;
  const label = approvalLabel(ctx.approval_policy);
  if (label !== 'granular' && ASKING_POLICIES.indexOf(label) === -1) return false;
  // The hook fires BEFORE the automatic reviewer: under `auto_review` (or a guardian) a machine may
  // settle the request with no human ever seeing it. A turn_context with no `approvals_reviewer` at
  // all comes from a build that predates the field, when only a human could review — so 'user'.
  const reviewer = ctx.approvals_reviewer == null ? 'user' : ctx.approvals_reviewer;
  return reviewer === 'user';
}

function markerSpansOf(timed, markers) {
  if (!Array.isArray(markers) || markers.length === 0 || timed.length === 0) return [];
  const firstMs = Date.parse(timed[0].timestamp);
  const lastMs = Date.parse(timed[timed.length - 1].timestamp);
  const ends = approvalEnds(timed);
  const sorted = markers.filter((m) => m && Number.isFinite(m.ts)).slice().sort((a, b) => a.ts - b.ts);
  const spans = [];
  let ctx = null;
  let next = 0;
  let acceptedEnd = -Infinity;
  for (const marker of sorted) {
    // The turn_context in force at the marker: the latest one at or before it, replaced wholesale.
    while (next < timed.length && Date.parse(timed[next].timestamp) <= marker.ts) {
      if (timed[next].type === 'turn_context') ctx = timed[next].payload || {};
      next += 1;
    }
    if (!humanWasAsked(marker, ctx)) continue;
    // Outside the charted span: a stale marker from before a resume, or one past the last record.
    if (marker.ts < firstMs || marker.ts >= lastMs) continue;
    // A parallel batch prompts several times inside one continuous wait; the earliest opens it.
    if (marker.ts < acceptedEnd) continue;
    const i = firstIndexAfter(ends, marker.ts);
    // No observed end: never extend a wait to wall-clock now.
    if (i === ends.length) continue;
    const end = ends[i];
    if (end - marker.ts < MIN_APPROVAL_WAIT_MS) continue;
    spans.push({ start: marker.ts, end, state: 'waiting_user', subtype: 'command_approval' });
    acceptedEnd = end;
  }
  return spans;
}

// PermissionRequest markers (lib/permission-markers-codex.mjs) as command_approval waits. A marker
// is the START of a human approval wait; the rollout says where it ended. Rollout timing alone
// cannot detect an approval — measured gaps up to 29 s happen without one — so command_approval is
// never inferred without a marker.
export function markerSpans(records, markers) {
  // Most sessions have no markers; skip sorting the whole rollout for them.
  if (!Array.isArray(markers) || markers.length === 0) return [];
  return markerSpansOf(timedRecords(records).timed, markers);
}

// `marked` is markerSpans(records, markers), computed once by buildPeriods, which anchors on the
// same spans.
export function timelineWaits(records, marked = []) {
  const { timed, times } = timedRecords(records);
  const calls = new Map();
  const asyncQuestions = new Set();
  const spans = [];
  let presentedPlan = false;
  let pendingQuestion = false;
  let betweenTurns = null;
  for (let i = 0; i < timed.length; i++) {
    const rec = timed[i];
    const ms = times[i];
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
        // A wake-up without a human is not next-instruction time.
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
        // Failed / unavailable question calls are not evidence of a human answer.
        const output = argsOf(p.output);
        const answered = call.subtype !== 'question_answer' || (output && output.answers
          && typeof output.answers === 'object' && Object.keys(output.answers).length > 0);
        // Like Claude permission markers, suppress near-instant auto-resolved approvals.
        const human = call.subtype !== 'command_approval' || ms - call.start >= MIN_APPROVAL_WAIT_MS;
        if (answered && human && !(output && output.error)) spans.push({ ...call, end: ms });
      }
    }
  }

  for (const span of marked) spans.push(span);

  const recordMs = times;
  // The times buildPeriods will look up: every record, plus the synthetic anchors it adds at each
  // marker span's start and end (neither is a record timestamp when the end is a started_at_ms or
  // completed_at_ms).
  const keys = recordMs.slice();
  for (const span of marked) keys.push(span.start, span.end);
  keys.sort((a, b) => a - b);

  const waits = new Map();
  // Only classify complete observed waits, never extend an unanswered call to wall-clock now.
  // A main-thread work record inside a span ends the inference of continuous blocking. This
  // matters for parallel tool batches and makes async work stay working.
  // Records are sorted by time, so each span scans only the records inside it.
  for (const span of spans) {
    let start = span.start;
    for (let i = firstIndexAfter(recordMs, span.start); i < recordMs.length && recordMs[i] < span.end; i++) {
      if (!isBookkeeping(timed[i])) start = recordMs[i];
    }
    for (let i = firstIndexAfter(keys, start); i < keys.length && keys[i] <= span.end; i++) {
      const existing = waits.get(keys[i]);
      // Human decisions have a more specific cause than a concurrent machine wait.
      if (!existing || span.state === 'waiting_user') waits.set(keys[i], { state: span.state, subtype: span.subtype });
    }
  }
  return waits;
}
