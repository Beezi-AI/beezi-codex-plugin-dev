import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canReadKeys, colorEnabled, createStyle, formatLine, paint, paintOffer, paintRows, terminalStyle, wrapLines } from '../lib/setup-style.mjs';
import { offerLines } from '../lib/history-offer.mjs';

const on = createStyle({ enabled: true });
const off = createStyle({ enabled: false });
const NAMES = ['bold', 'dim', 'blue', 'red', 'accent'];
const TTY = { isTTY: true };

test('createStyle wraps text in the contract escape codes when enabled, with the 256-colour accent', () => {
  assert.equal(on.enabled, true);
  assert.equal(on.bold('a'), '\x1b[1ma\x1b[0m');
  assert.equal(on.dim('a'), '\x1b[2ma\x1b[0m');
  assert.equal(on.blue('a'), '\x1b[1;34ma\x1b[0m');
  assert.equal(on.red('a'), '\x1b[31ma\x1b[0m');
  assert.equal(on.accent('a'), '\x1b[38;5;99ma\x1b[0m');
});

test('createStyle returns text unchanged when disabled', () => {
  assert.equal(off.enabled, false);
  NAMES.forEach((name) => assert.equal(off[name]('plain'), 'plain', name));
  assert.equal(off.mark(2, 'plain'), 'plain');
});

const terminalCases = [
  { name: 'COLORTERM=truecolor', env: { COLORTERM: 'truecolor' }, accent: '\x1b[38;2;135;91;247m◆\x1b[0m' },
  { name: 'COLORTERM=24bit', env: { COLORTERM: '24bit' }, accent: '\x1b[38;2;135;91;247m◆\x1b[0m' },
  { name: 'no COLORTERM', env: {}, accent: '\x1b[38;5;99m◆\x1b[0m' },
  { name: 'COLORTERM=yes', env: { COLORTERM: 'yes' }, accent: '\x1b[38;5;99m◆\x1b[0m' },
  { name: 'NO_COLOR with truecolor', env: { COLORTERM: 'truecolor', NO_COLOR: '1' }, accent: '◆' },
];
for (const c of terminalCases) {
  test(`terminalStyle accent with ${c.name}`, () => {
    assert.equal(terminalStyle({ stream: TTY, env: c.env }).accent('◆'), c.accent);
  });
}

test('paint colours the leading ✓ and ⚠ glyph in the accent, ✗ red with a bold line, – dim, and keeps the leading whitespace', () => {
  assert.equal(paint(on, '✓ Beezi: uploaded 12 sessions.'), '\x1b[38;5;99m✓\x1b[0m Beezi: uploaded 12 sessions.');
  assert.equal(paint(on, '  ⚠ Slow network'), '  \x1b[38;5;99m⚠\x1b[0m Slow network');
  assert.equal(paint(on, '✗ That step stopped unexpectedly.'), '\x1b[31m✗\x1b[0m\x1b[1m That step stopped unexpectedly.\x1b[0m');
  assert.equal(paint(on, '  – Nothing goes to Acme.'), '  \x1b[2m–\x1b[0m Nothing goes to Acme.');
  assert.equal(paint(on, '==> Checking your plan…'), '\x1b[1;34m==>\x1b[0m Checking your plan…');
  assert.equal(paint(on, '  ==> Looking at your past sessions…'), '  \x1b[1;34m==>\x1b[0m Looking at your past sessions…');
});

test('paint leaves other lines unchanged, the stop line included', () => {
  assert.equal(paint(on, 'Setup stopped. Ask "Sign me in to Beezi" in a new Codex thread to finish.'),
    'Setup stopped. Ask "Sign me in to Beezi" in a new Codex thread to finish.');
  assert.equal(paint(on, 'Beezi: 4/12 sessions read…'), 'Beezi: 4/12 sessions read…');
  assert.equal(paint(on, '==>no space'), '==>no space');
  assert.equal(paint(on, 'Done ✓'), 'Done ✓');
  assert.equal(paint(on, ''), '');
});

test('paint leaves every line unchanged when colour is off', () => {
  ['✓ ok', '  ⚠ warn', '✗ bad', '– none', '==> Checking your plan…', 'plain'].forEach((line) => {
    assert.equal(paint(off, line), line);
  });
});

test('colorEnabled needs a TTY stream, no NO_COLOR and a TERM other than dumb', () => {
  const ttyStream = { isTTY: true };
  assert.equal(colorEnabled({ stream: ttyStream, env: {} }), true);
  assert.equal(colorEnabled({ stream: ttyStream, env: { TERM: 'xterm-256color' } }), true);
  assert.equal(colorEnabled({ stream: { isTTY: false }, env: {} }), false);
  assert.equal(colorEnabled({ stream: {}, env: {} }), false);
  assert.equal(colorEnabled({ stream: ttyStream, env: { NO_COLOR: '1' } }), false);
  assert.equal(colorEnabled({ stream: ttyStream, env: { TERM: 'dumb' } }), false);
});

test('canReadKeys needs a raw-capable TTY input, a TTY output and a TERM other than dumb', () => {
  const input = { isTTY: true, setRawMode: () => {} };
  const output = { isTTY: true };
  assert.equal(canReadKeys({ input, output, env: {} }), true);
  assert.equal(canReadKeys({ input: { isTTY: false, setRawMode: () => {} }, output, env: {} }), false);
  assert.equal(canReadKeys({ input: { isTTY: true }, output, env: {} }), false);
  assert.equal(canReadKeys({ input, output: { isTTY: false }, env: {} }), false);
  assert.equal(canReadKeys({ input, output: {}, env: {} }), false);
  assert.equal(canReadKeys({ input, output, env: { TERM: 'dumb' } }), false);
});

test('wrapLines keeps a line that fits, and breaks a long one at spaces under min(columns − 1, 100)', () => {
  assert.deepEqual(wrapLines('short line', 80), ['short line']);
  assert.deepEqual(wrapLines('Next: restart Claude Code, then run /beezi:login.', 40), ['Next: restart Claude Code, then run', '  /beezi:login.']);
  const long = `${'word '.repeat(40)}end`;
  wrapLines(long, 300).forEach((row) => assert.ok(Array.from(row).length <= 100, row));
});

test('wrapLines indents later rows 2 more than the line, and keeps a long word whole', () => {
  assert.deepEqual(wrapLines('  ✓ History import is now closed for this account', 30), ['  ✓ History import is now', '    closed for this account']);
  assert.deepEqual(wrapLines('⚠ see https://example.com/a/very/long/path/that/does/not/fit', 20), ['⚠ see', '  https://example.com/a/very/long/path/that/does/not/fit']);
});

test('paintRows keeps later rows of a ✗ line bold and leaves the rest plain', () => {
  assert.equal(paintRows(on, ['✓ one', '  two']), '\x1b[38;5;99m✓\x1b[0m one\n  two');
  assert.equal(paintRows(on, ['✗ one', '  two']), '\x1b[31m✗\x1b[0m\x1b[1m one\x1b[0m\n  \x1b[1mtwo\x1b[0m');
  assert.equal(paintRows(on, ['plain', '  rest']), 'plain\n  rest');
  assert.equal(paintRows(off, ['✗ one', '  two']), '✗ one\n  two');
});

test('formatLine wraps and paints each \\n-separated part on its own', () => {
  assert.equal(formatLine(on, '\n✗ Stopped.', 80), '\n\x1b[31m✗\x1b[0m\x1b[1m Stopped.\x1b[0m');
  assert.equal(formatLine(on, '✓ alpha beta gamma delta', 21), '\x1b[38;5;99m✓\x1b[0m alpha beta gamma\n  delta');
  assert.deepEqual(wrapLines('a b c d e f g h i j k l m n o p q r s t u v w x y z', 5), ['a b c d e f g h i j', '  k l m n o p q r s', '  t u v w x y z']);
});

const at = (y, m, d) => new Date(y, m - 1, d, 12).getTime();
const FOLDERS = ['Beezi', 'Drivrr', 'wt'].concat(Array.from({ length: 29 }, (_, i) => `f${i}`));
const HIDDEN_ALL = offerLines({ n: 263, firstMs: at(2026, 9, 21), lastMs: at(2026, 10, 23), folders: FOLDERS, kinds: ['repos', 'branches', 'sessions', 'hosts', 'accounts'] });
const SESSIONS_OFF = offerLines({ n: 263, firstMs: at(2026, 9, 21), lastMs: at(2026, 10, 23), folders: FOLDERS, kinds: ['hosts'] });
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('formatLine styles each K7-C offer line by its shape when colour is on', () => {
  assert.deepEqual(HIDDEN_ALL.map((line) => formatLine(on, line, 200)), [
    '\x1b[1mBeezi found 263 past Codex sessions\x1b[0m \x1b[2m(21 Sep – 23 Oct, 32 folders)\x1b[0m',
    '  \x1b[2min\x1b[0m Beezi, Drivrr, wt\x1b[2m +29 more\x1b[0m',
    '  Sent',
    '    \x1b[38;5;99m✓\x1b[0m dates, duration, models, tokens, cost',
    '    \x1b[38;5;99m✓\x1b[0m tool, skill and MCP names',
    '  Hidden by your workspace\x1b[2m — Beezi gets made-up names\x1b[0m',
    '    \x1b[38;5;99m◆\x1b[0m folder and repository names, branch names',
    '    \x1b[38;5;99m◆\x1b[0m computer name, account email',
    '  \x1b[2mNever sent\x1b[0m',
    '    \x1b[2m✕ session titles, error messages and subagent names\x1b[0m',
  ]);
});

test('formatLine leaves every K7-C offer line plain when colour is off', () => {
  HIDDEN_ALL.concat(SESSIONS_OFF).forEach((line) => assert.equal(formatLine(off, line, 200), wrapLines(line, 200).join('\n')));
});

test('a wrapped ✓ line keeps only its mark in the accent, and its later rows stay plain under the hang', () => {
  const s4 = SESSIONS_OFF.find((line) => line.startsWith('    ✓ session titles'));
  const rows = paintOffer(on, s4, 80).split('\n');
  assert.ok(rows.length > 1);
  assert.ok(rows[0].startsWith('    \x1b[38;5;99m✓\x1b[0m session titles'));
  rows.slice(1).forEach((row) => assert.ok(row.startsWith('      ') && row.indexOf('\x1b') === -1, row));
  assert.equal(strip(rows.join('\n')), wrapLines(s4, 80).join('\n'));
});

test('a wrapped ✕ line stays dim on every row', () => {
  const never = HIDDEN_ALL[HIDDEN_ALL.length - 1];
  const rows = paintOffer(on, never, 30).split('\n');
  assert.ok(rows.length > 1);
  rows.forEach((row) => assert.match(row, /^ +\x1b\[2m[^\x1b]+\x1b\[0m$/));
  assert.equal(strip(rows.join('\n')), wrapLines(never, 30).join('\n'));
});

test("the several-workspaces checklist dims its Always sent line and each workspace's hidden-names part", () => {
  assert.deepEqual([
    '  Always sent: dates, duration, models, tokens, cost, tool, skill and MCP names',
    '  Acme · made-up names for repos and branches',
    '  Side Project · names and titles as they are',
    '  Beta · names as they are, titles never sent',
  ].map((line) => formatLine(on, line, 200)), [
    '\x1b[2m  Always sent: dates, duration, models, tokens, cost, tool, skill and MCP names\x1b[0m',
    '  Acme\x1b[2m · made-up names for repos and branches\x1b[0m',
    '  Side Project\x1b[2m · names and titles as they are\x1b[0m',
    '  Beta\x1b[2m · names as they are, titles never sent\x1b[0m',
  ]);
  assert.equal(paintOffer(on, '  Acme · 3 sessions', 200), null);
});

test('paintOffer matches only the exact K7-C shapes', () => {
  assert.equal(paintOffer(on, '  ✓ Beezi: done', 200), null);
  assert.equal(paintOffer(on, '✓ Beezi: done', 200), null);
  assert.equal(paintOffer(on, 'Beezi found 2 past Codex sessions', 200), null);
  assert.equal(formatLine(on, '  ✓ Beezi: done', 200), '  \x1b[38;5;99m✓\x1b[0m Beezi: done');
});

test('no cyan, yellow, green or magenta escape is left in the setup style', () => {
  const lines = HIDDEN_ALL.map((line) => formatLine(on, line, 200)).concat(['✓ a', '⚠ b', '✗ c', '– d'].map((line) => paint(on, line)));
  lines.forEach((line) => assert.doesNotMatch(line, /\x1b\[(?:1;)?3[2356]m/, line));
});

test('wrapLines measures colour codes as zero width', () => {
  const ready = `${on.bold('Ready.')} Restart Codex and keep working.`;
  assert.deepEqual(wrapLines(ready, 40), [ready]);
  assert.deepEqual(wrapLines(on.dim('Crash reports are on ($beezi:settings) and more words'), 40), [
    '\x1b[2mCrash reports are on ($beezi:settings)',
    '  and more words\x1b[0m',
  ]);
});
