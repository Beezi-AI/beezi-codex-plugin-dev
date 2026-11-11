import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createPrompt } from '../lib/setup-prompt.mjs';
import { createStyle } from '../lib/setup-style.mjs';

const OPTIONS = [
  { label: 'Ask me (recommended)', description: 'Beezi asks once' },
  { label: 'Send to…' },
  { label: "Don't send", description: 'Nothing is uploaded' },
];
const HIDE = '\x1b[?25l';
const SHOW = '\x1b[?25h';
const ERASE_MENU = '\x1b[6A\x1b[0J';
const UP = '\x1b[A';
const DOWN = '\x1b[B';
const ESC = '\x1b';
const ESC_WAIT_MS = 600;
const COLOR = createStyle({ enabled: true });
const MENU = [
  '',
  '  ◆ Where?',
  '    ❯ Ask me (recommended)   Beezi asks once',
  '      Send to…',
  "      Don't send             Nothing is uploaded",
  '    ↑↓ to move, Enter to choose',
];

const plain = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const count = (text, part) => text.split(part).length - 1;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const places = (n) => Array.from({ length: n }, (_, i) => ({ label: `Place ${i + 1}` }));

// A fake terminal: a TTY input with a setRawMode spy and an output collector with a width.
function terminal(opts) {
  const o = opts || {};
  const input = new PassThrough();
  input.isTTY = true;
  const raw = [];
  input.setRawMode = o.setRawMode || ((on) => { raw.push(on); return input; });
  const written = [];
  const interrupts = [];
  const output = { columns: o.columns || 80, rows: o.rows, write: (s) => { written.push(s); return true; } };
  const prompt = createPrompt({
    input,
    output,
    style: o.style,
    format: o.format,
    interactive: o.interactive === undefined ? true : o.interactive,
    onInterrupt: () => { interrupts.push({ raw: raw.slice(), text: written.join('') }); },
  });
  const press = async (...keys) => {
    for (const key of keys) {
      await tick();
      input.write(key);
      await tick();
    }
  };
  return {
    input, raw, interrupts, prompt, press,
    type: (line) => press(`${line}\n`),
    text: () => written.join(''),
    // The rows of the last frame drawn, escape codes removed.
    frame: () => plain(written.filter((s) => s.indexOf('◆') !== -1).pop()).split('\n'),
  };
}

test('choose draws a blank line, ◆ question, ❯ on the first row and the hint, then folds away on Enter', async () => {
  const t = terminal();
  const answer = t.prompt.choose('Where?', OPTIONS);
  await t.press('\r');
  assert.equal(await answer, 0);
  assert.equal(t.text(), `${HIDE}${MENU.join('\n')}\n${ERASE_MENU}${SHOW}`);
  assert.deepEqual(t.raw, [true, false]);
  t.prompt.close();
});

test('arrows and k/j move the pointer with wrap-around, and Enter submits it', async () => {
  const t = terminal();
  const up = t.prompt.choose('Q?', OPTIONS);
  await t.press(UP, '\r');
  assert.equal(await up, 2);
  const down = t.prompt.choose('Q?', OPTIONS);
  await t.press(DOWN, 'j', 'k', DOWN, DOWN, '\r');
  assert.equal(await down, 0);
  t.prompt.close();
});

test('a digit moves the pointer without submitting, out-of-range digits are ignored, and \\n also submits', async () => {
  const t = terminal();
  const answer = t.prompt.choose('Q?', OPTIONS);
  await t.press('3');
  assert.equal(count(t.text(), ERASE_MENU), 1);
  await t.press('9', '0', '\r');
  assert.equal(await answer, 2);
  const newline = t.prompt.choose('Q?', OPTIONS);
  await t.press('2\n');
  assert.equal(await newline, 1);
  t.prompt.close();
});

test('each change redraws over exactly the rows drawn, and ignored keys draw nothing', async () => {
  const t = terminal();
  const answer = t.prompt.choose('Q?', OPTIONS);
  await t.press(DOWN, 'x', ',', ' ', DOWN, '\r');
  assert.equal(await answer, 2);
  assert.equal(count(t.text(), ERASE_MENU), 3);
  assert.equal((t.text().match(/\x1b\[\d+A/g) || []).length, 3);
  assert.equal(count(t.text(), '  ◆ Q?\n'), 3);
});

test('Esc dismisses neither the question nor a tick list', async () => {
  const t = terminal();
  const one = t.prompt.choose('Q?', OPTIONS);
  await t.press(DOWN, ESC);
  await sleep(ESC_WAIT_MS);
  assert.equal(count(t.text(), ERASE_MENU), 1);
  await t.press('\r');
  assert.equal(await one, 1);
  const ticks = t.prompt.chooseMany('Which?', OPTIONS, { preselected: [0] });
  await t.press(ESC);
  await sleep(ESC_WAIT_MS);
  await t.press('\r');
  assert.deepEqual(await ticks, [0]);
  t.prompt.close();
});

test('lead lines draw above the question through format, and fold away with it, wrapped rows included', async () => {
  const format = (line) => (line === 'long' ? 'long-a\nlong-b' : `> ${line}`);
  const t = terminal({ format });
  const answer = t.prompt.choose('Q?', OPTIONS, { lead: ['Header', 'long'] });
  await t.press(DOWN, '\r');
  assert.equal(await answer, 1);
  assert.ok(t.text().startsWith(`${HIDE}\n> Header\nlong-a\nlong-b\n\n  ◆ Q?\n`));
  assert.equal(count(t.text(), '\x1b[10A\x1b[0J'), 2);
});

test('chooseMany ticks with Space and digits, starts from preselected, and returns sorted picks', async () => {
  const t = terminal();
  const spaced = t.prompt.chooseMany('Which?', OPTIONS, { preselected: [2] });
  assert.deepEqual(t.frame().slice(2, 5), [
    '    ❯ ◯ Ask me (recommended)   Beezi asks once',
    '      ◯ Send to…',
    "      ◉ Don't send             Nothing is uploaded",
  ]);
  assert.equal(t.frame()[5], '    ↑↓ to move, Space to tick, Enter to confirm');
  await t.press(DOWN, ' ', UP, ' ', '\r');
  assert.deepEqual(await spaced, [0, 1, 2]);
  const digits = t.prompt.chooseMany('Which?', OPTIONS, { preselected: [0, 2] });
  await t.press('3', '1', '3', '\r');
  assert.deepEqual(await digits, [2]);
  const none = t.prompt.chooseMany('Which?', OPTIONS);
  await t.press('\r');
  assert.deepEqual(await none, []);
  t.prompt.close();
});

test('consecutive digits compose one option number live, and a longer run undoes its prefix toggle', async () => {
  const twelve = places(12);
  const t = terminal();
  const one = t.prompt.choose('Q?', twelve);
  await t.press('1', '2');
  assert.match(t.frame().join('\n'), /❯ Place 12\n/);
  await t.press('\r');
  assert.equal(await one, 11);
  const restored = t.prompt.chooseMany('Which?', twelve);
  await t.press(DOWN, DOWN, ' ', '1', '2', '\r');
  assert.deepEqual(await restored, [2, 11]);
  t.prompt.close();
});

test('a 14-row tick list shows a 10-row window that follows the pointer', async () => {
  const shown = (t) => t.frame().filter((row) => /Place \d+/.test(row)).map((row) => Number(/Place (\d+)/.exec(row)[1]));
  const t = terminal();
  const answer = t.prompt.chooseMany('Which?', places(14), { preselected: [0] });
  assert.deepEqual(shown(t), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(t.frame().length, 14);
  await t.press(...Array(10).fill(DOWN));
  assert.deepEqual(shown(t), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.match(t.frame().join('\n'), /❯ ◯ Place 11\n/);
  await t.press(UP, UP);
  assert.deepEqual(shown(t), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  await t.press(' ', '\r');
  assert.deepEqual(await answer, [0, 8]);
  const wrapped = t.prompt.chooseMany('Which?', places(14));
  await t.press(UP);
  assert.deepEqual(shown(t), [5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  await t.press(DOWN);
  assert.deepEqual(shown(t), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  await t.press('\r');
  assert.deepEqual(await wrapped, []);
  t.prompt.close();
});

test('at 40 columns every row stays within the width: labels keep their room, long descriptions are cut', async () => {
  const t = terminal({ columns: 40 });
  const track = t.prompt.choose('What should it track?', [
    { label: 'Everything', description: 'all 6, and new ones as you open them' },
    { label: 'Let me choose', description: 'tick the repos and folders' },
  ]);
  assert.deepEqual(t.frame(), [
    '',
    '  ◆ What should it track?',
    '    ❯ Everything      all 6, and new o…',
    '      Let me choose   tick the repos a…',
    '    ↑↓ to move, Enter to choose',
    '',
  ]);
  await t.press('\r');
  assert.equal(await track, 0);
  const ticks = t.prompt.chooseMany('Which repos and folders should Beezi track?', [
    { label: 'github.com/acme/web-app-with-a-long-name', description: '96 sessions' },
    { label: '~/personal/blog', description: '18 sessions' },
  ], { preselected: [0, 1] });
  assert.deepEqual(t.frame(), [
    '',
    '  ◆ Which repos and folders should Bee…',
    '    ❯ ◉ github.com/acme/…   96 sessions',
    '      ◉ ~/personal/blog     18 sessions',
    '    ↑↓ to move, Space to tick, Enter t…',
    '',
  ]);
  t.frame().forEach((row) => assert.ok(Array.from(row).length <= 39, row));
  await t.press('\r');
  assert.deepEqual(await ticks, [0, 1]);
  t.prompt.close();
});

test('wide characters count as two columns, so a CJK label is cut to fit', async () => {
  const t = terminal({ columns: 13 });
  const answer = t.prompt.choose('Q?', [{ label: '工作区名称很长' }, { label: 'B' }]);
  await t.press(DOWN, '\r');
  assert.equal(await answer, 1);
  assert.deepEqual(plain(t.text()).split('\n'), [
    '', '  ◆ Q?', '    ❯ 工作…', '      B', '    ↑↓ to m…',
    '', '  ◆ Q?', '      工作…', '    ❯ B', '    ↑↓ to m…',
    '',
  ]);
  assert.equal(count(t.text(), '\x1b[5A\x1b[0J'), 2);
});

test('a menu taller than the terminal uses the typed prompt for that question only', async () => {
  const short = terminal({ rows: 6 });
  const typed = short.prompt.choose('Q?', OPTIONS);
  await short.type('3');
  assert.equal(await typed, 2);
  assert.match(short.text(), / {2}Choose 1-3 \[1\]: $/);
  assert.deepEqual(short.raw, []);
  short.prompt.close();
  const tall = terminal({ rows: 7 });
  const keyed = tall.prompt.choose('Q?', OPTIONS);
  await tall.press('\r');
  assert.equal(await keyed, 0);
  assert.deepEqual(tall.raw, [true, false]);
  tall.prompt.close();
  const windowed = terminal({ rows: 14 });
  const many = windowed.prompt.chooseMany('Which?', places(30));
  await windowed.press('\r');
  assert.deepEqual(await many, []);
  assert.deepEqual(windowed.raw, [true, false]);
  windowed.prompt.close();
});

test('chooseMany with no options returns [] without drawing or touching raw mode', async () => {
  const keyed = terminal();
  assert.deepEqual(await keyed.prompt.chooseMany('Which?', []), []);
  assert.deepEqual(keyed.raw, []);
  assert.equal(keyed.text(), '');
  keyed.prompt.close();
});

test('an exception inside a key question restores raw mode and the cursor, rejects, and later questions still work', async () => {
  const t = terminal();
  let broken = false;
  const flaky = { get label() { if (broken) throw new Error('bad label'); return 'A'; } };
  const onKey = t.prompt.choose('Q?', [flaky, { label: 'B' }]);
  const onKeyFailed = assert.rejects(onKey, /bad label/);
  broken = true;
  await t.press('j');
  await onKeyFailed;
  assert.deepEqual(t.raw, [true, false]);
  assert.ok(t.text().endsWith(SHOW));
  const later = t.prompt.choose('Q?', OPTIONS);
  await t.press('\r');
  assert.equal(await later, 0);
  t.prompt.close();
});

test('Ctrl+C restores raw mode and the cursor, then calls onInterrupt', async () => {
  const t = terminal();
  const answer = t.prompt.choose('Q?', OPTIONS);
  await t.press('\x03');
  assert.equal(await answer, null);
  assert.equal(t.interrupts.length, 1);
  assert.deepEqual(t.interrupts[0].raw, [true, false]);
  assert.ok(t.interrupts[0].text.endsWith(SHOW));
  t.prompt.close();
});

test('raw mode is on only while a question is open, and lines typed between questions are dropped', async () => {
  const t = terminal();
  const first = t.prompt.choose('One?', OPTIONS);
  await t.press('\r');
  assert.equal(await first, 0);
  assert.deepEqual(t.raw, [true, false]);
  await t.type('stray');
  const second = t.prompt.chooseMany('Two?', OPTIONS, { preselected: [1] });
  assert.deepEqual(t.raw, [true, false, true]);
  await t.press('\r');
  assert.deepEqual(await second, [1]);
  assert.deepEqual(t.raw, [true, false, true, false]);
  assert.equal(count(t.text(), HIDE), 2);
  assert.equal(count(t.text(), SHOW), 2);
  t.prompt.close();
});

test('EOF during a key question restores the terminal and dismisses it and every later one', async () => {
  const t = terminal();
  const pending = t.prompt.choose('Q?', OPTIONS);
  setImmediate(() => t.input.end());
  assert.equal(await pending, null);
  assert.deepEqual(t.raw, [true, false]);
  assert.ok(t.text().endsWith(SHOW));
  const before = t.text();
  assert.equal(await t.prompt.chooseMany('Later?', OPTIONS), null);
  assert.equal(await t.prompt.choose('Later?', OPTIONS), null);
  assert.equal(t.text(), before);
});

test('close dismisses an open question, can be repeated, and stops reading the terminal', async () => {
  const t = terminal();
  const pending = t.prompt.chooseMany('Q?', OPTIONS);
  t.prompt.close();
  assert.equal(await pending, null);
  assert.deepEqual(t.raw, [true, false]);
  assert.ok(t.text().endsWith(SHOW));
  t.prompt.close();
  assert.equal(t.input.isPaused(), true);
  assert.equal(await t.prompt.choose('Later?', OPTIONS), null);
  const fresh = terminal();
  fresh.prompt.close();
  assert.equal(fresh.input.isPaused(), true);
  assert.equal(fresh.input.listenerCount('data'), 0);
});

test('a setRawMode that throws falls back to typed prompts for this and every later question', async () => {
  const calls = [];
  const t = terminal({ setRawMode: (on) => { calls.push(on); throw new Error('EIO'); } });
  const first = t.prompt.choose('Q?', OPTIONS);
  await t.type('2');
  assert.equal(await first, 1);
  const second = t.prompt.chooseMany('Which?', OPTIONS, { preselected: [0] });
  await t.type('');
  assert.deepEqual(await second, [0]);
  assert.deepEqual(calls, [true]);
  assert.equal(count(t.text(), HIDE), 0);
  t.prompt.close();
});

test('non-interactive mode never touches raw mode, even on a TTY', async () => {
  const t = terminal({ interactive: false });
  const answer = t.prompt.choose('Q?', OPTIONS);
  await t.type('3');
  assert.equal(await answer, 2);
  assert.deepEqual(t.raw, []);
  assert.match(t.text(), / {2}Choose 1-3 \[1\]: $/);
  t.prompt.close();
});

test('with colour on: accent ◆, ❯ and ◉, the pointed row bold, other rows and the hint dim', async () => {
  const t = terminal({ style: COLOR });
  const answer = t.prompt.choose('Q?', OPTIONS);
  const one = t.text();
  await t.press('\r');
  assert.equal(await answer, 0);
  assert.ok(one.includes('  \x1b[38;5;99m◆\x1b[0m \x1b[1mQ?\x1b[0m\n'));
  assert.ok(one.includes('    \x1b[38;5;99m❯\x1b[0m \x1b[1mAsk me (recommended)   \x1b[0m\x1b[2mBeezi asks once\x1b[0m\n'));
  assert.ok(one.includes('      \x1b[2mSend to…\x1b[0m\n'));
  assert.ok(one.includes('    \x1b[2m↑↓ to move, Enter to choose\x1b[0m\n'));
  const many = t.prompt.chooseMany('Which?', OPTIONS, { preselected: [1] });
  const ticks = t.text().slice(one.length);
  await t.press('\r');
  assert.deepEqual(await many, [1]);
  assert.ok(ticks.includes('    \x1b[38;5;99m❯\x1b[0m \x1b[2m◯\x1b[0m \x1b[1mAsk me (recommended)   \x1b[0m'));
  assert.ok(ticks.includes('      \x1b[38;5;99m◉\x1b[0m Send to…\n'));
  assert.doesNotMatch(t.text(), /\x1b\[(?:1;)?3[2356]m/);
  t.prompt.close();
});
