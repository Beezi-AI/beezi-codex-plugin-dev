import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createPrompt, openTerminal, parseNumbers, togglePick } from '../lib/setup-prompt.mjs';
import { createStyle } from '../lib/setup-style.mjs';

const OPTIONS = [
  { label: 'Ask me (recommended)', description: 'Beezi asks once' },
  { label: 'Send to…' },
  { label: "Don't send", description: 'Nothing is uploaded' },
];

function harness(style) {
  const input = new PassThrough();
  const written = [];
  const prompt = createPrompt({ input, output: { write: (s) => { written.push(s); } }, style, format: (line) => `> ${line}` });
  const type = (line) => new Promise((resolve) => {
    setImmediate(() => {
      input.write(`${line}\n`);
      setImmediate(resolve);
    });
  });
  return { input, written, prompt, type, text: () => written.join('') };
}

test('parseNumbers reads comma lists, drops duplicates and rejects out-of-range parts', () => {
  assert.deepEqual(parseNumbers('1, 3', 3), [0, 2]);
  assert.deepEqual(parseNumbers('2,2', 3), [1]);
  assert.deepEqual(parseNumbers('', 3), []);
  assert.equal(parseNumbers('4', 3), null);
  assert.equal(parseNumbers('0', 3), null);
  assert.equal(parseNumbers('1,x', 3), null);
  assert.equal(parseNumbers('1.5', 3), null);
});

test('togglePick unticks a picked row, ticks any other, and leaves its input alone', () => {
  assert.deepEqual(togglePick([0], 0), []);
  assert.deepEqual(togglePick([0], 2), [0, 2]);
  const before = [0];
  togglePick(before, 1);
  assert.deepEqual(before, [0]);
});

test('typed choose prints the lead, ◆ question and numbered options, takes option 1 on Enter, and re-asks a bad answer', async () => {
  const h = harness();
  const first = h.prompt.choose('Where?', OPTIONS, { lead: ['Beezi found 2 sessions'] });
  await h.type('');
  assert.equal(await first, 0);
  assert.equal(h.text(), [
    '',
    '> Beezi found 2 sessions',
    '',
    '  ◆ Where?',
    '    1) Ask me (recommended)  Beezi asks once',
    '    2) Send to…',
    "    3) Don't send  Nothing is uploaded",
    '  Choose 1-3 [1]: ',
  ].join('\n'));
  const second = h.prompt.choose('Q?', OPTIONS);
  await h.type('9');
  await h.type('1,2');
  await h.type('3');
  assert.equal(await second, 2);
  assert.equal(h.text().split('  Enter one number from 1 to 3.\n').length - 1, 2);
  h.prompt.close();
});

test('typed chooseMany keeps the preselected ticks on Enter, takes typed numbers, and re-asks bad input', async () => {
  const h = harness();
  const kept = h.prompt.chooseMany('Which?', OPTIONS, { preselected: [0, 2] });
  await h.type('');
  assert.deepEqual(await kept, [0, 2]);
  assert.match(h.text(), / {2}Choose one or more \(for example 1,2\), or none \[1,3\]: $/);
  const none = h.prompt.chooseMany('Which?', OPTIONS);
  await h.type('');
  assert.deepEqual(await none, []);
  assert.match(h.text(), / {2}Choose one or more \(for example 1,2\), or press Enter for none: $/);
  const retry = h.prompt.chooseMany('Which?', OPTIONS);
  await h.type('7');
  await h.type('3, 1');
  assert.deepEqual(await retry, [2, 0]);
  assert.match(h.text(), / {2}Enter numbers from 1 to 3, separated by commas\.\n/);
  h.prompt.close();
});

test('typed chooseMany takes none for nothing ticked, even with preselected rows', async () => {
  const h = harness();
  const nothing = h.prompt.chooseMany('Which?', OPTIONS, { preselected: [0, 1, 2] });
  await h.type(' None ');
  assert.deepEqual(await nothing, []);
  h.prompt.close();
});

test('typed prompts use the accent ◆ and bold queries, and no cyan or yellow', async () => {
  const h = harness(createStyle({ enabled: true }));
  const answer = h.prompt.choose('Where?', OPTIONS);
  await h.type('9');
  await h.type('2');
  assert.equal(await answer, 1);
  assert.ok(h.text().includes('\n  \x1b[38;5;99m◆\x1b[0m \x1b[1mWhere?\x1b[0m\n'));
  assert.ok(h.text().includes('    1) Ask me (recommended)\x1b[2m  Beezi asks once\x1b[0m\n'));
  assert.ok(h.text().includes('  \x1b[1mChoose 1-3 [1]:\x1b[0m '));
  assert.doesNotMatch(h.text(), /\x1b\[(?:1;)?3[2356]m/);
  h.prompt.close();
});

test('EOF dismisses the pending question and every later one, writing nothing more', async () => {
  const h = harness();
  const pending = h.prompt.choose('Q?', OPTIONS);
  setImmediate(() => h.input.end());
  assert.equal(await pending, null);
  const before = h.text();
  assert.equal(await h.prompt.chooseMany('Q?', OPTIONS), null);
  assert.equal(await h.prompt.choose('Q?', OPTIONS), null);
  assert.equal(h.text(), before);
});

test('lines typed while no question is pending are dropped', async () => {
  const h = harness();
  h.input.write('2\n');
  await new Promise((resolve) => setImmediate(resolve));
  const answer = h.prompt.choose('Q?', OPTIONS);
  await h.type('3');
  assert.equal(await answer, 2);
  h.prompt.close();
});

test('openTerminal prefers a TTY stdin, falls back to /dev/tty off Windows, else null', () => {
  const ttyStdin = { isTTY: true };
  const piped = { isTTY: false };
  const devTty = { fromDevTty: true };
  assert.equal(openTerminal({ stdin: ttyStdin, platform: 'darwin', openTty: () => devTty }), ttyStdin);
  assert.equal(openTerminal({ stdin: piped, platform: 'linux', openTty: () => devTty }), devTty);
  assert.equal(openTerminal({ stdin: piped, platform: 'win32', openTty: () => devTty }), null);
  assert.equal(openTerminal({ stdin: piped, platform: 'linux', openTty: () => { throw new Error('ENXIO'); } }), null);
});
