import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NO_TERMINAL, SESSION_KEYS, STOPPED, setupMain } from '../lib/setup-main.mjs';

const ESC = /\x1b\[/;
const SGR = /\x1b\[[0-9;]*m/g;
const INSTALLER = { PATH: '/bin', BEEZI_INSTALLER: '1' };

function sink() {
  const chunks = [];
  return { chunks, write: (s) => { chunks.push(s); return true; }, text: () => chunks.join('') };
}

function harness(over) {
  const seen = {
    closed: 0, removed: [], runner: null, run: null, prompt: null, ctx: null, exit: null, interrupt: null, exitHandlers: [], labels: [], cleared: 0,
  };
  const stdout = sink();
  const stderr = sink();
  const terminal = { isTTY: true };
  const deps = {
    stdout,
    stderr,
    env: { PATH: '/bin', BEEZI_INSTALLER: '1', CODEX_THREAD_ID: 'thread-1' },
    openTerminal: () => terminal,
    makeTempDir: () => '/tmp/beezi-setup-x1',
    removeDir: (dir) => { seen.removed.push(dir); },
    createPrompt: (io) => { seen.prompt = io; return { close: () => { seen.closed += 1; } }; },
    createRunner: (options) => {
      seen.runner = options;
      const run = () => Promise.resolve({ code: 0, stdout: '', stderr: '' });
      run.setLabel = (label) => { seen.labels.push(label); };
      run.clearActivity = () => { seen.cleared += 1; };
      seen.run = run;
      return run;
    },
    runSetup: (ctx) => { seen.ctx = ctx; return Promise.resolve(0); },
    onInterrupt: (handler) => { seen.interrupt = handler; },
    onExit: (handler) => { seen.exitHandlers.push(handler); },
    exit: (code) => { seen.exit = code; },
    ...over,
  };
  return { deps, seen, stdout, stderr, terminal };
}

// A colour terminal: TTY stdout of the given width, and a terminal that can read raw keys.
function colourTerminal(h, columns) {
  h.stdout.isTTY = true;
  h.stdout.columns = columns;
  h.terminal.setRawMode = () => {};
  return h;
}

test('SESSION_KEYS are the two variables Codex exports with the session id', () => {
  assert.deepEqual(SESSION_KEYS, ['CODEX_THREAD_ID', 'CODEX_SESSION_ID']);
});

test('a standalone run starts with the header; under the installer it does not', async () => {
  const standalone = harness({ env: { PATH: '/bin' } });
  assert.equal(await setupMain('/plugin', standalone.deps), 0);
  assert.equal(standalone.stdout.text(), 'Beezi for Codex\n\n');
  const coloured = colourTerminal(harness({ env: { PATH: '/bin' } }), 80);
  assert.equal(await setupMain('/plugin', coloured.deps), 0);
  assert.equal(coloured.stdout.text().replace(SGR, ''), [
    '',
    '     ▄▄█      ',
    '  ▄███▀▀ ▄▄██▄   beezi',
    '  ▀▀ ▄▄███▀▀     for Codex',
    '  ▄███▀▀ ▄▄███',
    '        █▀▀▀  ',
    '',
    '',
  ].join('\n'));
  const installer = colourTerminal(harness({ env: INSTALLER }), 80);
  assert.equal(await setupMain('/plugin', installer.deps), 0);
  assert.equal(installer.stdout.text(), '');
});

test('without a terminal it says how to sign in instead and exits 1 before touching anything', async () => {
  const h = harness({ openTerminal: () => null });
  assert.equal(await setupMain('/plugin', h.deps), 1);
  assert.equal(h.stderr.text(), `  ${NO_TERMINAL}\n`);
  assert.equal(NO_TERMINAL, '✗ Beezi setup needs a terminal. Ask "Sign me in to Beezi" in a new Codex thread instead.');
  assert.equal(h.seen.runner, null);
  assert.equal(h.seen.interrupt, null);
  assert.deepEqual(h.seen.exitHandlers, []);
  assert.deepEqual(h.seen.removed, []);
});

test('on a colour terminal the no-terminal ✗ is red and its line bold, at the margin', async () => {
  const h = colourTerminal(harness({ openTerminal: () => null }), 100);
  assert.equal(await setupMain('/plugin', h.deps), 1);
  assert.equal(h.stderr.text(), '  \x1b[31m✗\x1b[0m\x1b[1m Beezi setup needs a terminal. Ask "Sign me in to Beezi" in a new Codex thread instead.\x1b[0m\n');
});

test('on process exit a TTY stdout gets the cursor shown again, and piped stdout registers nothing', async () => {
  const tty = colourTerminal(harness({}), 100);
  assert.equal(await setupMain('/plugin', tty.deps), 0);
  assert.equal(tty.seen.exitHandlers.length, 1);
  tty.stdout.chunks.length = 0;
  tty.seen.exitHandlers[0]();
  assert.equal(tty.stdout.text(), '\x1b[?25h');
  const piped = harness({});
  assert.equal(await setupMain('/plugin', piped.deps), 0);
  assert.deepEqual(piped.seen.exitHandlers, []);
});

test('it runs the wizard from a fresh temp cwd with the session keys stripped, a margined spinner and the style, then cleans up', async () => {
  const h = harness({});
  assert.equal(await setupMain('/plugin', h.deps), 0);
  const { paint: runnerPaint, accent, ...runner } = h.seen.runner;
  assert.deepEqual(runner, {
    root: '/plugin', cwd: '/tmp/beezi-setup-x1', env: h.deps.env, sessionKeys: SESSION_KEYS,
    stdout: h.stdout, stderr: h.stderr, output: h.stdout, activity: false, margin: '  ',
  });
  assert.equal(runnerPaint('✓ done'), '  ✓ done');
  assert.equal(accent('⠋'), '⠋');
  assert.equal(h.seen.prompt.input, h.terminal);
  assert.equal(h.seen.prompt.output, h.stdout);
  assert.equal(h.seen.prompt.format('✓ done'), '  ✓ done');
  assert.equal(h.seen.ctx.run, h.seen.run);
  assert.equal(h.seen.ctx.style.enabled, false);
  assert.equal(typeof h.seen.ctx.ask.close, 'function');
  assert.equal(typeof h.seen.ctx.trust, 'function');
  h.stdout.chunks.length = 0;
  h.seen.ctx.print('✓ done');
  h.seen.ctx.print('');
  assert.equal(h.stdout.text(), '  ✓ done\n\n');
  assert.equal(h.seen.closed, 1);
  assert.deepEqual(h.seen.removed, ['/tmp/beezi-setup-x1']);
});

test('the wizard reads hook trust through the injected probe', async () => {
  const verdict = { verdict: 'trusted', untrusted: [], disabled: [] };
  const h = harness({ trust: () => Promise.resolve(verdict) });
  assert.equal(await setupMain('/plugin', h.deps), 0);
  assert.equal(await h.seen.ctx.trust(), verdict);
});

test("the wizard's exit code passes through with nothing printed after it, and a crash still closes the prompt and removes the temp dir", async () => {
  const signInFailed = harness({ runSetup: () => Promise.resolve(1) });
  assert.equal(await setupMain('/plugin', signInFailed.deps), 1);
  assert.deepEqual(signInFailed.seen.removed, ['/tmp/beezi-setup-x1']);
  assert.equal(signInFailed.stdout.text(), '');
  const crashed = harness({ runSetup: () => Promise.reject(new Error('boom')) });
  await assert.rejects(setupMain('/plugin', crashed.deps), /boom/);
  assert.equal(crashed.seen.closed, 1);
  assert.deepEqual(crashed.seen.removed, ['/tmp/beezi-setup-x1']);
  assert.equal(crashed.stdout.text(), '');
});

test('Ctrl+C closes the prompt, removes the temp dir, says how to finish in a Codex thread and exits 130', () => {
  const h = harness({ runSetup: () => new Promise(() => {}) });
  setupMain('/plugin', h.deps);
  h.seen.interrupt();
  assert.equal(h.stdout.text(), '\n  Setup stopped. Ask "Sign me in to Beezi" in a new Codex thread to finish.\n');
  assert.equal(STOPPED, 'Setup stopped. Ask "Sign me in to Beezi" in a new Codex thread to finish.');
  assert.equal(h.seen.exit, 130);
  assert.equal(h.seen.closed, 1);
  assert.deepEqual(h.seen.removed, ['/tmp/beezi-setup-x1']);
});

test('Ctrl+C inside a menu takes the same stop path, with the stop line plain', () => {
  const h = colourTerminal(harness({ runSetup: () => new Promise(() => {}) }), 100);
  setupMain('/plugin', h.deps);
  assert.equal(typeof h.seen.prompt.onInterrupt, 'function');
  assert.equal(h.seen.prompt.onInterrupt, h.seen.interrupt);
  h.seen.prompt.onInterrupt();
  assert.equal(h.stdout.text(), `\n  ${STOPPED}\n`);
  assert.equal(h.seen.exit, 130);
  assert.equal(h.seen.closed, 1);
  assert.deepEqual(h.seen.removed, ['/tmp/beezi-setup-x1']);
});

test('colour and truecolor follow stdout, COLORTERM and NO_COLOR; arrow-key menus need raw key reading on a TTY', async () => {
  const cases = [
    { name: 'colour terminal', env: {}, accent: '\x1b[38;5;99m✓\x1b[0m', interactive: true },
    { name: 'truecolor terminal', env: { COLORTERM: 'truecolor' }, accent: '\x1b[38;2;135;91;247m✓\x1b[0m', interactive: true },
    { name: 'NO_COLOR', env: { NO_COLOR: '1', COLORTERM: 'truecolor' }, accent: '✓', interactive: true },
    { name: 'TERM=dumb', env: { TERM: 'dumb' }, accent: '✓', interactive: false },
    { name: 'no raw mode', env: {}, raw: false, accent: '\x1b[38;5;99m✓\x1b[0m', interactive: false },
    { name: 'piped stdout', env: {}, tty: false, accent: '✓', interactive: false },
  ];
  for (const c of cases) {
    const h = colourTerminal(harness({ env: { ...INSTALLER, ...c.env } }), 100);
    if (c.raw === false) delete h.terminal.setRawMode;
    if (c.tty === false) h.stdout.isTTY = false;
    assert.equal(await setupMain('/plugin', h.deps), 0, c.name);
    assert.equal(h.seen.prompt.style.enabled, c.accent !== '✓', c.name);
    assert.equal(h.seen.prompt.interactive, c.interactive, c.name);
    assert.equal(h.seen.runner.paint('✓ ok'), `  ${c.accent} ok`, c.name);
  }
});

test('every printed line starts at the margin, is painted by its leading mark, and stays plain under NO_COLOR', async () => {
  const lines = ['✓ Tracking all 6 repos and folders', '⚠ Beezi: 1 hook entry is broken.', '✗ Something went wrong.', '', 'Ready. Restart Codex and keep working.'];
  const printAll = (ctx) => {
    lines.forEach((line) => ctx.print(line));
    return Promise.resolve(1);
  };
  const colour = colourTerminal(harness({ runSetup: printAll }), 100);
  assert.equal(await setupMain('/plugin', colour.deps), 1);
  assert.equal(colour.stdout.text(), [
    '  \x1b[38;5;99m✓\x1b[0m Tracking all 6 repos and folders',
    '  \x1b[38;5;99m⚠\x1b[0m Beezi: 1 hook entry is broken.',
    '  \x1b[31m✗\x1b[0m\x1b[1m Something went wrong.\x1b[0m',
    '',
    '  Ready. Restart Codex and keep working.',
    '',
  ].join('\n'));
  const plain = colourTerminal(harness({ env: { ...INSTALLER, NO_COLOR: '1' }, runSetup: printAll }), 100);
  assert.equal(await setupMain('/plugin', plain.deps), 1);
  assert.equal(plain.stdout.text(), `${lines.map((line) => (line === '' ? '' : `  ${line}`)).join('\n')}\n`);
  assert.doesNotMatch(plain.stdout.text(), ESC);
});

test('a checklist line shown above the question keeps its accent ✓ under the margin', async () => {
  const h = colourTerminal(harness({}), 100);
  assert.equal(await setupMain('/plugin', h.deps), 0);
  assert.equal(h.seen.prompt.format('    ✓ dates, duration, models, tokens, cost'), '      \x1b[38;5;99m✓\x1b[0m dates, duration, models, tokens, cost');
  assert.equal(h.seen.prompt.format('  Never sent'), '    \x1b[2mNever sent\x1b[0m');
});

test('by default the cwd is a new, empty beezi-setup- folder in the OS temp dir, deleted afterwards', async () => {
  let cwd = null;
  const h = harness({
    makeTempDir: undefined,
    removeDir: undefined,
    createRunner: (options) => { cwd = options.cwd; return 'run-fn'; },
    runSetup: () => {
      assert.equal(path.dirname(cwd), os.tmpdir());
      assert.match(path.basename(cwd), /^beezi-setup-/);
      assert.deepEqual(fs.readdirSync(cwd), []);
      return Promise.resolve(0);
    },
  });
  assert.equal(await setupMain('/plugin', h.deps), 0);
  assert.equal(fs.existsSync(cwd), false);
});

test('the runner gets the output and an activity line only on a TTY whose TERM is not dumb', async () => {
  const tty = colourTerminal(harness(), 100);
  assert.equal(await setupMain('/plugin', tty.deps), 0);
  assert.equal(tty.seen.runner.output, tty.stdout);
  assert.equal(tty.seen.runner.activity, true);
  assert.equal(tty.seen.runner.accent('⠋'), '\x1b[38;5;99m⠋\x1b[0m');
  const dumb = colourTerminal(harness({ env: { ...INSTALLER, TERM: 'dumb' } }), 100);
  assert.equal(await setupMain('/plugin', dumb.deps), 0);
  assert.equal(dumb.seen.runner.activity, false);
  const piped = harness();
  piped.stdout.isTTY = false;
  assert.equal(await setupMain('/plugin', piped.deps), 0);
  assert.equal(piped.seen.runner.activity, false);
});

test('ctx.progress sets the runner label', async () => {
  const h = colourTerminal(harness({ runSetup: (ctx) => { ctx.progress('Checking this machine'); return Promise.resolve(1); } }), 100);
  assert.equal(await setupMain('/plugin', h.deps), 1);
  assert.deepEqual(h.seen.labels, ['Checking this machine']);
});

test('print and streamed lines wrap within a 40-column terminal with a hanging indent under the margin', async () => {
  const long = '✓ History import is now closed for this account: past sessions on other machines can no longer be imported.';
  const h = colourTerminal(harness({ env: { ...INSTALLER, NO_COLOR: '1' }, runSetup: (ctx) => { ctx.print(long); return Promise.resolve(1); } }), 40);
  assert.equal(await setupMain('/plugin', h.deps), 1);
  h.stdout.text().split('\n').forEach((row) => assert.ok(Array.from(row).length <= 39, row));
  assert.ok(h.stdout.text().startsWith('  ✓ History import is now closed for\n    this account:'));
  assert.equal(h.seen.runner.paint(long), h.stdout.text().replace(/\n$/, ''));
});

test('a bold Ready line fits one row at 44 columns: colour codes take no width', async () => {
  const h = colourTerminal(harness({ runSetup: (ctx) => { ctx.print(`${ctx.style.bold('Ready.')} Restart Codex and keep working.`); return Promise.resolve(0); } }), 44);
  assert.equal(await setupMain('/plugin', h.deps), 0);
  assert.equal(h.stdout.text(), '  \x1b[1mReady.\x1b[0m Restart Codex and keep working.\n');
});

test('the stop path clears the activity line before printing the stop line', async () => {
  // The fake clearActivity marks the output stream, so the order of the clear and the stop line shows.
  const h = colourTerminal(harness({
    runSetup: () => new Promise(() => {}),
    createRunner: () => {
      const run = () => Promise.resolve({ code: 0, stdout: '', stderr: '' });
      run.setLabel = () => {};
      run.clearActivity = () => { h.stdout.chunks.push('clear'); };
      return run;
    },
  }), 100);
  setupMain('/plugin', h.deps);
  await new Promise((resolve) => setImmediate(resolve));
  h.seen.interrupt();
  const clear = h.stdout.chunks.indexOf('clear');
  const stop = h.stdout.chunks.findIndex((s) => s.includes('Setup stopped.'));
  assert.ok(clear >= 0, 'clears the activity line');
  assert.ok(stop > clear, 'prints the stop line after the clear');
  assert.equal(h.seen.exit, 130);
});

test('Ctrl+C while an upload is followed ends only the following; afterwards it stops the setup again', async () => {
  const h = harness();
  assert.equal(await setupMain('/plugin', h.deps), 0);
  h.seen.closed = 0;
  h.seen.removed.length = 0;
  let shouldStop = null;
  let finish = null;
  const following = h.seen.ctx.catchInterrupt((stop) => {
    shouldStop = stop;
    return new Promise((resolve) => { finish = resolve; });
  });
  assert.equal(shouldStop(), false);
  h.seen.interrupt();
  assert.equal(shouldStop(), true);
  assert.equal(h.seen.exit, null);
  assert.equal(h.stdout.text(), '');
  assert.equal(h.seen.closed, 0);
  finish('done');
  assert.equal(await following, 'done');
  h.seen.interrupt();
  assert.equal(h.seen.exit, 130);
  assert.equal(h.stdout.text(), `\n  ${STOPPED}\n`);
});

test('by default every SIGINT reaches the stop path, so a second Ctrl+C after a followed upload still exits', async (t) => {
  // Raw listeners, called as an emit would: a once() wrapper removes itself on its first call.
  const before = process.rawListeners('SIGINT');
  const h = harness({ onInterrupt: undefined });
  assert.equal(await setupMain('/plugin', h.deps), 0);
  const added = process.rawListeners('SIGINT').filter((l) => before.indexOf(l) === -1);
  t.after(() => added.forEach((l) => process.removeListener('SIGINT', l)));
  assert.equal(added.length, 1);
  await h.seen.ctx.catchInterrupt((stop) => {
    added[0]();
    assert.equal(stop(), true);
    return Promise.resolve();
  });
  assert.equal(h.seen.exit, null);
  assert.equal(process.rawListeners('SIGINT').indexOf(added[0]) !== -1, true);
  added[0]();
  assert.equal(h.seen.exit, 130);
});

test('ctx.columns is the stdout width less the margin, 80 when the width is unknown', async () => {
  const wide = colourTerminal(harness(), 120);
  assert.equal(await setupMain('/plugin', wide.deps), 0);
  assert.equal(wide.seen.ctx.columns(), 118);
  const unknown = harness();
  assert.equal(await setupMain('/plugin', unknown.deps), 0);
  assert.equal(unknown.seen.ctx.columns(), 78);
});
