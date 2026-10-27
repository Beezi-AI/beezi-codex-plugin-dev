const RESET = '\x1b[0m';
const VIOLETS = [183, 177, 171, 141, 135, 99, 98, 97, 63, 62, 61, 60, 60, 60];

// True when the stream is a terminal, NO_COLOR is unset and TERM is not dumb.
export function colorEnabled(options) {
  return options.stream.isTTY === true && !options.env.NO_COLOR && options.env.TERM !== 'dumb';
}

// True when single keys can be read from input while output is a terminal.
export function canReadKeys(options) {
  return options.input.isTTY === true
    && typeof options.input.setRawMode === 'function'
    && options.output.isTTY === true
    && options.env.TERM !== 'dumb';
}

// ANSI wrappers that return the text unchanged when colour is off.
export function createStyle(options) {
  const enabled = Boolean(options.enabled);
  const wrap = (code) => (text) => (enabled ? `\x1b[${code}m${text}${RESET}` : text);
  return {
    enabled,
    bold: wrap('1'),
    dim: wrap('2'),
    cyan: wrap('36'),
    boldCyan: wrap('1;36'),
    blue: wrap('1;34'),
    green: wrap('32'),
    boldGreen: wrap('1;32'),
    yellow: wrap('33'),
    red: wrap('31'),
    magenta: wrap('35'),
    violet: (level, text) => (enabled ? `\x1b[38;5;${VIOLETS[level]}m${text}${RESET}` : text),
  };
}

const MAX_ROW = 100;

// The style a line's leading ✓, ⚠, ✗ or "Setup stopped" calls for, or null.
function toneOf(body) {
  if (body.startsWith('✓')) return 'green';
  if (body.startsWith('⚠')) return 'yellow';
  if (body.startsWith('✗') || body.startsWith('Setup stopped')) return 'red';
  return null;
}

// Colours a line by its leading ✓, ⚠, ✗, "Setup stopped" or "==> ", keeping its leading whitespace.
export function paint(style, line) {
  const body = line.replace(/^\s+/, '');
  const lead = line.slice(0, line.length - body.length);
  const tone = toneOf(body);
  if (tone !== null) return lead + style[tone](body);
  if (body.startsWith('==> ')) return `${lead}${style.blue('==>')}${body.slice(3)}`;
  return line;
}

// Rows of at most min(columns − 1, 100) characters, broken at spaces: later rows keep the line's indent plus 2; a word longer than a row stays whole.
export function wrapLines(line, columns) {
  const room = Math.min(Math.max((columns || 80) - 1, 20), MAX_ROW);
  if (Array.from(line).length <= room) return [line];
  const body = line.replace(/^\s+/, '');
  const lead = line.slice(0, line.length - body.length);
  const hang = `${lead}  `;
  const rows = [];
  let row = '';
  body.split(' ').forEach((word) => {
    const prefix = rows.length === 0 ? lead : hang;
    if (row === '') {
      row = word;
    } else if (Array.from(`${prefix}${row} ${word}`).length > room) {
      rows.push(prefix + row);
      row = word;
    } else {
      row = `${row} ${word}`;
    }
  });
  rows.push((rows.length === 0 ? lead : hang) + row);
  return rows;
}

// Wrapped rows joined with \n: the first painted as paint() does, every later one in the first row's tone.
export function paintRows(style, rows) {
  const tone = toneOf(rows[0].replace(/^\s+/, ''));
  return rows.map((row, i) => {
    if (i === 0) return paint(style, row);
    if (tone === null) return row;
    const rest = row.replace(/^\s+/, '');
    return row.slice(0, row.length - rest.length) + style[tone](rest);
  }).join('\n');
}

// One printed line wrapped to the terminal and painted; each \n-separated part wraps on its own.
// The K7-C past-sessions lines by exact shape: one tone per capture group, the groups spelling the whole line.
const OFFER_SHAPES = [
  [/^(Beezi found \d+ past [A-Za-z ]+ sessions?)( )(\([^()]+\))$/, ['bold', null, 'dim']],
  [/^( {2})(in)( .+?)( \+\d+ more)?$/, [null, 'dim', null, 'dim']],
  [/^( {2})(Sent)$/, [null, 'green']],
  [/^( {4})(✓)( .+)$/, [null, 'green', null]],
  [/^( {2})(Hidden by your workspace)( — Beezi gets made-up names)$/, [null, 'magenta', 'dim']],
  [/^( {4})(◆)( .+)$/, [null, 'magenta', null]],
  [/^( {2})(Never sent)$/, [null, 'dim']],
  [/^( {4})(✕ .+)$/, [null, 'dim']],
];

// One tone per UTF-16 unit of an offer line, or null when the line has none of the shapes.
function offerTones(line) {
  for (const [shape, tones] of OFFER_SHAPES) {
    const found = shape.exec(line);
    if (found === null) continue;
    const perUnit = [];
    tones.forEach((tone, i) => {
      const part = found[i + 1] === undefined ? '' : found[i + 1];
      for (let k = 0; k < part.length; k += 1) perUnit.push(tone);
    });
    return perUnit;
  }
  return null;
}

// Wraps line[from, to) run by run in each unit's tone.
function paintSpan(style, line, tones, from, to) {
  let out = '';
  let start = from;
  for (let i = from + 1; i <= to; i += 1) {
    if (i < to && tones[i] === tones[start]) continue;
    const text = line.slice(start, i);
    out += tones[start] === null ? text : style[tones[start]](text);
    start = i;
  }
  return out;
}

// Wrapped rows are contiguous slices of the line after their hang, so each row keeps the tones of the units it shows.
export function paintOffer(style, line, columns) {
  const tones = offerTones(line);
  if (tones === null) return null;
  const hang = line.length - line.replace(/^\s+/, '').length + 2;
  let at = 0;
  return wrapLines(line, columns).map((row, i) => {
    const prefix = i === 0 ? '' : row.slice(0, hang);
    const shown = row.length - prefix.length;
    const painted = prefix + paintSpan(style, line, tones, at, at + shown);
    at += shown + 1;
    return painted;
  }).join('\n');
}

export function formatLine(style, line, columns) {
  return String(line).split('\n').map((part) => {
    const offer = paintOffer(style, part, columns);
    return offer === null ? paintRows(style, wrapLines(part, columns)) : offer;
  }).join('\n');
}
