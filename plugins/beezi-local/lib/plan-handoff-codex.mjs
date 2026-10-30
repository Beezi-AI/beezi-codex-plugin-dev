// Links a Codex Plan session to its "Yes, clear context" successor. Accepting a plan with a cleared
// context starts a NEW rollout (no parent id) and writes nothing to the old one, so the plan-approval
// wait is only recoverable by matching the old file's last Plan text against the new file's first
// prompt. Pure matching: file access goes through `deps`, so tests inject fakes.
import fs from 'fs';
import path from 'path';
import { codexSessionsDir } from './paths.mjs';
import { listRolloutFiles } from './transcript-codex.mjs';
import { scanRecords } from './session-name-codex.mjs';
import { isTimelineUserPrompt, isBookkeeping } from './timeline-waits-codex.mjs';
import { readRolloutRecords } from './rollout-file.mjs';
import { orDefault } from './compat.mjs';

export const PLAN_HANDOFF_PREFIX = "A previous agent produced the plan below to accomplish the user's task. Implement the plan in a fresh context. Treat the plan as the source of user intent, re-read files as needed, and carry the work through implementation and verification.";
export const PLAN_MATCH_CHARS = 200;
// BREAK_GAP_SEC * 1000 from session-timeline-codex.mjs. Not imported: that module imports this one
// (computeSessionTimeline appends the handoff wait), so importing back would form a cycle. Exported
// so a test pins the two together.
export const BREAK_GAP_MS = 6 * 60 * 60 * 1000;
// The old file's mtime is its last write, approximately its task_complete time.
const MTIME_SLACK_MS = 60 * 1000;
// Slack on the start time a rollout's filename encodes: the name is LOCAL time, and a day covers any
// timezone (and a clock change) without parsing one.
const NAME_SLACK_MS = 24 * 60 * 60 * 1000;
const NAME_START_RE = /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-/;

function ms(rec) {
  return rec ? Date.parse(rec.timestamp) : NaN;
}

function metaOf(records) {
  for (const r of records) if (r && r.type === 'session_meta') return r;
  return null;
}

// Text of a prompt record: legacy `user_message` or a `UserMessage` item with content blocks.
function promptText(rec) {
  const p = rec.payload || {};
  if (p.type === 'user_message') {
    if (typeof p.message === 'string') return p.message;
    return typeof p.text === 'string' ? p.text : '';
  }
  const c = p.item && p.item.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.filter((b) => b && typeof b.text === 'string').map((b) => b.text).join('');
}

export function handoffPlanText(records) {
  const first = (records || []).find((r) => r && isTimelineUserPrompt(r));
  if (!first) return null;
  const text = promptText(first);
  const lead = PLAN_HANDOFF_PREFIX + '\n\n';
  return text.indexOf(lead) === 0 ? text.slice(lead.length) : null;
}

function eventType(rec) {
  return rec.type === 'event_msg' ? (rec.payload || {}).type : null;
}

function isTaskComplete(rec) {
  return eventType(rec) === 'task_complete';
}

// Records skipped on both sides of task_complete: the bookkeeping Codex writes around a turn end
// (token_count, turn_context, world_state, thread_settings_applied, ...), as the timeline's own
// `isBookkeeping` defines it. That definition also counts task_complete and task_started; both are
// excluded here, because task_complete is the record being looked for and a task_started after it is
// a new turn, which means the plan was answered in this same session.
// A raw user message is excluded too: Codex writes one beside every UserMessage item, so one after
// task_complete is a prompt being answered, not bookkeeping.
function isTailBookkeeping(rec) {
  const t = eventType(rec);
  return isBookkeeping(rec) && t !== 'task_complete' && t !== 'task_started' && !isRawUserMessage(rec);
}

function isRawUserMessage(rec) {
  const p = rec.payload || {};
  return rec.type === 'response_item' && p.type === 'message' && p.role === 'user';
}

function isPlanItem(rec) {
  const p = rec.payload || {};
  return rec.type === 'event_msg' && p.type === 'item_completed' && !!p.item && p.item.type === 'Plan';
}

// The session's last turn ends on a presented Plan nobody answered: the same rule timelineWaits
// applies to `presentedPlan` (reset by task_started, set by a Plan item). The last task_complete,
// with only bookkeeping after it, closes the turn; walking back to that turn's start (its
// task_started, or the previous turn's task_complete) there must be a Plan item and no prompt after
// it. Real Codex writes the assistant's final_answer message, reasoning and tool calls between the
// Plan and task_complete, so anything else in between is allowed. When both carry a turn_id, the
// Plan must belong to the task_complete's turn.
export function trailingPlanWait(records) {
  let i = (records || []).length - 1;
  while (i >= 0 && isTailBookkeeping(records[i])) i--;
  if (i < 1) return null;
  const end = records[i];
  if (!isTaskComplete(end)) return null;
  const waitStartMs = ms(end);
  if (!Number.isFinite(waitStartMs)) return null;
  const turnId = (end.payload || {}).turn_id;
  for (let j = i - 1; j >= 0; j--) {
    const r = records[j];
    if (!r) continue;
    const t = eventType(r);
    if (t === 'task_started' || t === 'task_complete') return null;
    if (isTimelineUserPrompt(r) || isRawUserMessage(r)) return null;
    if (!isPlanItem(r)) continue;
    const p = r.payload;
    if (turnId && p.turn_id && p.turn_id !== turnId) return null;
    if (typeof p.item.text === 'string' && p.item.text.trim()) return { planText: p.item.text, waitStartMs };
    return null;
  }
  return null;
}

export function samePlan(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = a.trim().slice(0, PLAN_MATCH_CHARS);
  return x !== '' && x === b.trim().slice(0, PLAN_MATCH_CHARS);
}

function normCwd(cwd, platform) {
  if (typeof cwd !== 'string' || !cwd) return null;
  const r = path.resolve(cwd);
  return platform === 'win32' ? r.toLowerCase() : r;
}

// Head of a candidate successor, up to and including its first prompt: session_meta and that prompt
// are all the match needs. The ceiling is scanRecords' own default (MAX_SCAN_BYTES in
// session-name-codex.mjs, sized for the first prompt on MCP-heavy machines, where session_meta and the
// permissions preamble push it past 1 MB); the scan stops at the first prompt, so the common case
// reads one chunk. Breaking out of the generator closes its file descriptor.
function readHeadDefault(file) {
  const out = [];
  for (const r of scanRecords(file)) {
    out.push(r);
    if (r && isTimelineUserPrompt(r)) break;
  }
  return out;
}

// Whole-file reader, plain or zstd-compressed (Codex compresses rollouts older than 7 days). A
// rollout this Node cannot decode reads as empty, which skips the candidate.
function readAllDefault(file) {
  let records;
  try { records = readRolloutRecords(file); } catch { return []; }
  return records === null ? [] : records;
}

function mtimeDefault(file) {
  return fs.statSync(file).mtimeMs;
}

function withDefaults(deps) {
  const d = orDefault(deps, {});
  return {
    platform: orDefault(d.platform, process.platform),
    listRollouts: d.listRollouts ? d.listRollouts : () => listRolloutFiles(codexSessionsDir()),
    statMtimeMs: orDefault(d.statMtimeMs, mtimeDefault),
    readHead: orDefault(d.readHead, readHeadDefault),
    readAll: orDefault(d.readAll, readAllDefault),
  };
}

// The session start a rollout's name encodes (rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl[.zst], local
// time), or NaN when the name does not parse. It costs no stat and no read, so on a machine with
// hundreds of (mostly compressed) rollouts it is what keeps a candidate scan from opening them all.
function nameStartMs(file) {
  const m = NAME_START_RE.exec(path.basename(String(file)));
  if (!m) return NaN;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
}

// Could this candidate's session have started in [fromMs, toMs]? A name that does not parse cannot
// be ruled out, so it falls through to the mtime check.
function nameMayStartIn(file, fromMs, toMs) {
  const start = nameStartMs(file);
  return !Number.isFinite(start) || (start >= fromMs - NAME_SLACK_MS && start <= toMs + NAME_SLACK_MS);
}

function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

export function findPlanSuccessor(transcriptPath, records, deps = {}) {
  const wait = trailingPlanWait(records);
  const oldMeta = metaOf(records || []);
  if (!wait || !oldMeta) return null;
  const d = withDefaults(deps);
  const cwd = normCwd((oldMeta.payload || {}).cwd, d.platform);
  if (!cwd) return null;
  let best = null;
  for (const file of safe(() => d.listRollouts(), [])) {
    if (file === transcriptPath) continue;
    // The successor starts within BREAK_GAP_MS after the wait. No upper mtime bound: a long-running
    // successor keeps writing long after it started.
    if (!nameMayStartIn(file, wait.waitStartMs, wait.waitStartMs + BREAK_GAP_MS)) continue;
    const mtime = safe(() => d.statMtimeMs(file), NaN);
    if (!(mtime >= wait.waitStartMs)) continue;
    const head = safe(() => d.readHead(file), []);
    const m = metaOf(head);
    const metaMs = ms(m);
    if (!m || !(metaMs > wait.waitStartMs && metaMs < wait.waitStartMs + BREAK_GAP_MS)) continue;
    if (normCwd((m.payload || {}).cwd, d.platform) !== cwd) continue;
    const planText = handoffPlanText(head);
    if (planText === null || !samePlan(planText, wait.planText)) continue;
    const first = head.find((r) => r && isTimelineUserPrompt(r));
    if (best && metaMs >= best.metaMs) continue;
    best = { metaMs, transcriptPath: file, sessionId: (m.payload || {}).id, firstPromptMs: ms(first) };
  }
  if (!best) return null;
  return { transcriptPath: best.transcriptPath, sessionId: best.sessionId, firstPromptMs: best.firstPromptMs };
}

export function findPlanPredecessor(transcriptPath, records, deps = {}) {
  const planText = handoffPlanText(records || []);
  const newMeta = metaOf(records || []);
  if (planText === null || !newMeta) return null;
  const newMetaMs = ms(newMeta);
  if (!Number.isFinite(newMetaMs)) return null;
  const d = withDefaults(deps);
  const cwd = normCwd((newMeta.payload || {}).cwd, d.platform);
  if (!cwd) return null;
  const metaFits = (m) => {
    const metaMs = ms(m);
    return !!m && metaMs < newMetaMs && metaMs > newMetaMs - BREAK_GAP_MS
      && normCwd((m.payload || {}).cwd, d.platform) === cwd;
  };
  let best = null;
  for (const file of safe(() => d.listRollouts(), [])) {
    if (file === transcriptPath) continue;
    // The same window metaFits applies to session_meta, read off the name before any stat.
    if (!nameMayStartIn(file, newMetaMs - BREAK_GAP_MS, newMetaMs)) continue;
    const mtime = safe(() => d.statMtimeMs(file), NaN);
    if (!(mtime >= newMetaMs - BREAK_GAP_MS && mtime <= newMetaMs + MTIME_SLACK_MS)) continue;
    // This runs inside the Stop hook, and in a busy 6 h window most candidates belong to other
    // projects: session_meta's time and cwd are checked on the head before the whole-file read.
    if (!metaFits(metaOf(safe(() => d.readHead(file), [])))) continue;
    const all = safe(() => d.readAll(file), []);
    const m = metaOf(all);
    if (!metaFits(m)) continue;
    const wait = trailingPlanWait(all);
    if (!wait || !samePlan(wait.planText, planText) || !(wait.waitStartMs < newMetaMs)) continue;
    if (best && wait.waitStartMs <= best.waitStartMs) continue;
    best = { transcriptPath: file, sessionId: (m.payload || {}).id, waitStartMs: wait.waitStartMs };
  }
  return best;
}
