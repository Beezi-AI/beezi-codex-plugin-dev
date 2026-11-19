import { readProgress, isLive } from './upload-progress.mjs';

const BAR_CELLS = 14;
const GLYPHS = { done: '▓', left: '░' };
const ASCII_GLYPHS = { done: '#', left: '-' };
const POLL_MS = 1000;
const STALE_MS = 120000;
const FRESH_SLACK_MS = 5000;
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const ASCII_FRAMES = ['|', '/', '-', '\\'];
const FINISHING_HEAD = 'Finishing upload to ';

export const REST_LINE = 'Beezi: the rest keeps uploading in the background';
const FINISHING_PLAIN = 'Beezi: all sessions read, finishing upload…';

function spinnerFrame(tick, { ascii = false } = {}) {
  const frames = ascii ? ASCII_FRAMES : FRAMES;
  return frames[tick % frames.length];
}

// Every session is read; what is left is the last batches going up.
function isFinishing({ processed, total }) {
  return total > 0 && processed >= total;
}

const fitName = (name, room) => (name.length <= room ? name : `${name.slice(0, Math.max(0, room - 1))}…`);

export function progressBar(processed, total, { ascii = false } = {}) {
  const glyphs = ascii ? ASCII_GLYPHS : GLYPHS;
  const done = total > 0 ? Math.round(BAR_CELLS * processed / total) : 0;
  return glyphs.done.repeat(done) + glyphs.left.repeat(BAR_CELLS - done);
}

// options.width: the most characters the line may take; a longer workspace name is cut with '…'.
export function barLine(record, options = {}) {
  const { workspace, processed, total } = record;
  const head = 'Uploading past sessions to ';
  const tail = `  ${progressBar(processed, total, options)}  ${processed}/${total}`;
  const room = options.width == null ? Infinity : options.width - head.length - tail.length;
  return head + fitName(workspace, room) + tail;
}

// The bar while sessions are read, then the finishing text; options.width counts the spinner.
export function liveLine(record, { ascii = false, width = Infinity, tick = 0 } = {}) {
  const frame = `${spinnerFrame(tick, { ascii })} `;
  const room = width - frame.length;
  if (!isFinishing(record)) return frame + barLine(record, { ascii, width: room });
  return frame + FINISHING_HEAD + fitName(`${record.workspace}…`, room - FINISHING_HEAD.length);
}

export function plainLine(record) {
  if (isFinishing(record)) return FINISHING_PLAIN;
  return `Beezi: ${record.processed}/${record.total} sessions read…`;
}

export function doneLine(record) {
  const noun = record.sent === 1 ? 'past session' : 'past sessions';
  return `✓ ${record.sent} ${noun} uploaded to ${record.workspace}`;
}

function isFresh(record, sinceMs) {
  return record !== null && Date.parse(record.startedAt) >= sinceMs - FRESH_SLACK_MS;
}

export async function followUploads({
  key, tenantIds, sinceMs, capMs = Infinity, shouldStop = () => false,
  onUpdate, onTick = () => {}, onDone, read = readProgress, now = Date.now, sleep,
}) {
  const startMs = now();
  const finished = [];
  const result = (timedOut, stopped) => ({ finished, timedOut, stopped });
  let index = 0;
  let tick = 0;
  let lastProcessed = null;
  let lastSeenMs = startMs;
  while (index < tenantIds.length) {
    if (shouldStop()) return result(false, true);
    const nowMs = now();
    if (nowMs - startMs >= capMs) return result(true, false);
    const record = read(key, tenantIds[index]);
    // A run that did not end clean has no done line: the rest is left to the worker's retry.
    if (isFresh(record, sinceMs) && record.finishedAt !== null && record.failed === true) return result(false, true);
    if (isFresh(record, sinceMs) && record.finishedAt !== null) {
      onDone(record);
      finished.push(record);
      index += 1;
      lastProcessed = null;
      lastSeenMs = nowMs;
      continue;
    }
    if (isFresh(record, sinceMs) && isLive(record, nowMs)) {
      lastSeenMs = nowMs;
      if (record.processed !== lastProcessed) onUpdate(record);
      lastProcessed = record.processed;
      onTick(record, tick);
      tick += 1;
    }
    if (nowMs - lastSeenMs >= STALE_MS) return result(false, true);
    await sleep(POLL_MS);
  }
  return result(false, false);
}
