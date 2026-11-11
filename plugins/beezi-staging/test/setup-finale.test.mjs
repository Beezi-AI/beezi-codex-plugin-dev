import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closingLines, headerLines } from '../lib/setup-finale.mjs';
import { createStyle } from '../lib/setup-style.mjs';

const PLAIN = createStyle({ enabled: false });
const COLOUR = createStyle({ enabled: true });
const SGR = /\x1b\[[0-9;]*m/g;

test('with colour off the header is the plain "Beezi for Codex" line', () => {
  assert.deepEqual(headerLines({ agent: 'Codex', style: PLAIN }), ['Beezi for Codex', '']);
});

test('with colour on the header is the five mark rows, beezi beside row 2 and for Codex beside row 3', () => {
  const rows = headerLines({ agent: 'Codex', style: COLOUR });
  assert.deepEqual(rows.map((row) => row.replace(SGR, '')), [
    '',
    '     ▄▄█      ',
    '  ▄███▀▀ ▄▄██▄   beezi',
    '  ▀▀ ▄▄███▀▀     for Codex',
    '  ▄███▀▀ ▄▄███',
    '        █▀▀▀  ',
    '',
  ]);
  assert.ok(rows[2].endsWith('   \x1b[1mbeezi\x1b[0m'));
  assert.ok(rows[3].endsWith('   \x1b[2mfor Codex\x1b[0m'));
  rows.forEach((row) => assert.ok(Array.from(row.replace(SGR, '')).length <= 40, row));
});

test('the mark rows follow the 256-colour violet ramp', () => {
  const rows = headerLines({ agent: 'Codex', style: COLOUR });
  assert.equal(rows[1], '  \x1b[38;5;69m   ▄▄█      \x1b[0m');
  assert.ok(rows[5].startsWith('  \x1b[38;5;99m'));
});

test('in truecolor the mark runs left to right from #6F8DFF to #6938EF', () => {
  const rows = headerLines({ agent: 'Codex', style: createStyle({ enabled: true, truecolor: true }) });
  assert.ok(rows[2].startsWith('  \x1b[38;2;111;141;255m▄\x1b[0m'));
  assert.ok(rows[4].includes('\x1b[38;2;105;56;239m█\x1b[0m'));
});

const closingCases = [
  { crash: true, trustPending: false, lines: ['', 'Ready. Restart Codex and keep working.', 'Crash reports are on ($beezi:settings)'] },
  { crash: false, trustPending: false, lines: ['', 'Ready. Restart Codex and keep working.'] },
  { crash: true, trustPending: true, lines: ['', 'One step left. In Codex, run /hooks and trust Beezi.', 'Crash reports are on ($beezi:settings)'] },
  { crash: false, trustPending: true, lines: ['', 'One step left. In Codex, run /hooks and trust Beezi.'] },
];
const failedHooksCases = [
  { trustPending: false, lines: ['', 'Crash reports are on ($beezi:settings)'] },
  { trustPending: true, lines: ['', 'One step left. In Codex, run /hooks and trust Beezi.', 'Crash reports are on ($beezi:settings)'] },
];
for (const c of failedHooksCases) {
  test(`a failed hooks check never closes with Ready, trustPending=${c.trustPending}`, () => {
    assert.deepEqual(closingLines({ agent: 'Codex', style: PLAIN, crash: true, trustPending: c.trustPending, hooksFailed: true, planFound: true }), c.lines);
  });
}

for (const c of closingCases) {
  test(`closing lines with crash=${c.crash} trustPending=${c.trustPending}`, () => {
    assert.deepEqual(closingLines({ agent: 'Codex', style: PLAIN, crash: c.crash, trustPending: c.trustPending, planFound: true }), c.lines);
  });
}

test('an undetected plan adds its dim line last, and Ready. is bold', () => {
  assert.deepEqual(closingLines({ agent: 'Codex', style: COLOUR, crash: true, trustPending: false, planFound: false }), [
    '',
    '\x1b[1mReady.\x1b[0m Restart Codex and keep working.',
    '\x1b[2mCrash reports are on ($beezi:settings)\x1b[0m',
    "\x1b[2mBeezi couldn't detect this machine's plan. Set it in $beezi:settings.\x1b[0m",
  ]);
});

test('past sessions that could not be checked add their dim line last, and One step left. is bold', () => {
  assert.deepEqual(closingLines({ agent: 'Codex', style: COLOUR, crash: false, trustPending: true, planFound: false, pastFailed: true }), [
    '',
    '\x1b[1mOne step left.\x1b[0m In Codex, run /hooks and trust Beezi.',
    "\x1b[2mBeezi couldn't detect this machine's plan. Set it in $beezi:settings.\x1b[0m",
    '\x1b[2mBeezi couldn\'t check past sessions. Ask "Sign me in to Beezi" in a new Codex thread to choose what to track.\x1b[0m',
  ]);
});
