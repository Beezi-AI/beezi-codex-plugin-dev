import { naming } from './paths.mjs';

const MARK = [
  '   ▄▄█',
  '▄███▀▀ ▄▄██▄',
  '▀▀ ▄▄███▀▀',
  '▄███▀▀ ▄▄███',
  '      █▀▀▀',
];

const MARK_WIDTH = 12;
const MARK_GAP = '   ';
const WORD_ROW = 1;
const AGENT_ROW = 2;
export const SETTINGS_SKILL = `$${naming.pluginName()}:settings`;
export const NO_PLAN = `Beezi couldn't detect this machine's plan. Set it in ${SETTINGS_SKILL}.`;
const PAST_FAILED = 'Beezi couldn\'t check past sessions. Ask "Sign me in to Beezi" in a new Codex thread to choose what to track.';

// The setup's header: the mark with "beezi" and "for <agent>" beside it, or the plain "Beezi for <agent>" line when colour is off.
export function headerLines(options) {
  const style = options.style;
  if (!style.enabled) return [`Beezi for ${options.agent}`, ''];
  const side = { [WORD_ROW]: style.bold('beezi'), [AGENT_ROW]: style.dim(`for ${options.agent}`) };
  const rows = MARK.map((row, i) => {
    const art = style.mark(i, row.padEnd(MARK_WIDTH));
    return side[i] === undefined ? `  ${art}` : `  ${art}${MARK_GAP}${side[i]}`;
  });
  return [''].concat(rows, ['']);
}

// The closing block: the /hooks trust step, else Ready unless the hooks check failed, then the dim crash, no-plan and past-sessions lines.
export function closingLines(options) {
  const style = options.style;
  const lines = [''];
  if (options.trustPending) lines.push(`${style.bold('One step left.')} In ${options.agent}, run /hooks and trust Beezi.`);
  else if (!options.hooksFailed) lines.push(`${style.bold('Ready.')} Restart ${options.agent} and keep working.`);
  if (options.crash) lines.push(style.dim(`Crash reports are on (${SETTINGS_SKILL})`));
  if (!options.planFound) lines.push(style.dim(NO_PLAN));
  if (options.pastFailed) lines.push(style.dim(PAST_FAILED));
  return lines;
}
