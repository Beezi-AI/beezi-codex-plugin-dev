import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { childEnv, createRunner } from '../lib/setup-runner.mjs';

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

function sink() {
  const chunks = [];
  return { chunks, write: (s) => { chunks.push(s); return true; }, text: () => chunks.join('') };
}

// The fake closes with child.code once both streams have ended, like a real ChildProcess.
function setup(script, extra) {
  const calls = [];
  const stdout = sink();
  const stderr = sink();
  const spawn = (cmd, args, options) => {
    const child = fakeChild();
    calls.push({ cmd, args, options });
    let open = 2;
    const ended = () => {
      open -= 1;
      if (open === 0) child.emit('close', child.code);
    };
    child.stdout.on('end', ended);
    child.stderr.on('end', ended);
    setImmediate(() => script(child));
    return child;
  };
  const run = createRunner(Object.assign({
    root: '/plugin', cwd: '/tmp/beezi-setup-x', env: { PATH: '/bin', CLAUDE_PID: '9', KEEP: 'y' },
    sessionKeys: ['CLAUDE_PID'], spawn, execPath: '/usr/bin/node', stdout, stderr,
  }, extra));
  return { run, calls, stdout, stderr };
}

test('childEnv drops session keys, keeps the rest and marks the setup run', () => {
  const env = { A: '1', CODEX_THREAD_ID: 't', CODEX_SESSION_ID: 's' };
  const out = childEnv(env, ['CODEX_THREAD_ID', 'CODEX_SESSION_ID']);
  assert.deepEqual(out, { A: '1', BEEZI_SETUP: '1' });
  assert.deepEqual(env, { A: '1', CODEX_THREAD_ID: 't', CODEX_SESSION_ID: 's' });
});

test('run spawns node on the plugin script with the clean env, temp cwd and ignored stdin', async () => {
  const h = setup((child) => { child.code = 0; child.stdout.end('ok\n'); child.stderr.end(); });
  const result = await h.run('workspace.mjs', ['routes', '--account', 'k1']);
  assert.deepEqual(result, { code: 0, stdout: 'ok\n', stderr: '' });
  const call = h.calls[0];
  assert.equal(call.cmd, '/usr/bin/node');
  assert.deepEqual(call.args, [path.join('/plugin', 'scripts', 'workspace.mjs'), 'routes', '--account', 'k1']);
  assert.equal(call.options.cwd, '/tmp/beezi-setup-x');
  assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.deepEqual(call.options.env, { PATH: '/bin', KEEP: 'y', BEEZI_SETUP: '1' });
  assert.equal(h.stdout.text(), '');
});

test('stream echoes whole lines live, hides matching stdout lines, and still captures them', async () => {
  const h = setup((child) => {
    child.code = 0;
    child.stdout.write('Opening your browser');
    child.stdout.write('…\n✓ linked\naccount=ab12');
    child.stderr.write('warn\n');
    child.stdout.end();
    child.stderr.end();
  });
  const result = await h.run('login.mjs', [], { stream: true, hide: /^account=/ });
  assert.equal(result.stdout, 'Opening your browser…\n✓ linked\naccount=ab12');
  assert.equal(h.stdout.text(), 'Opening your browser…\n✓ linked\n');
  assert.equal(h.stderr.text(), 'warn\n');
});

test('stream flushes a final unterminated line that is not hidden', async () => {
  const h = setup((child) => { child.code = 0; child.stdout.end('Beezi: 3/3 sessions read'); child.stderr.end(); });
  await h.run('backfill.mjs', [], { stream: true });
  assert.equal(h.stdout.text(), 'Beezi: 3/3 sessions read\n');
});

test('a non-zero exit is reported, a signal kill becomes 1, and a spawn error becomes 127', async () => {
  const failed = setup((child) => { child.code = 2; child.stderr.end('✗ boom\n'); child.stdout.end(); });
  assert.deepEqual(await failed.run('x.mjs', []), { code: 2, stdout: '', stderr: '✗ boom\n' });
  const killed = setup((child) => { child.code = null; child.stdout.end(); child.stderr.end(); });
  assert.equal((await killed.run('x.mjs', [])).code, 1);
  const missing = setup((child) => { child.emit('error', new Error('spawn ENOENT')); });
  assert.deepEqual(await missing.run('x.mjs', []), { code: 127, stdout: '', stderr: 'spawn ENOENT' });
});

test('stream paints every echoed stdout and stderr line, but never hidden or captured output', async () => {
  const h = setup((child) => {
    child.code = 0;
    child.stdout.write('✓ linked\naccount=ab12\n');
    child.stderr.write('⚠ slow\n');
    child.stdout.end('tail');
    child.stderr.end();
  }, { paint: (line) => `<${line}>` });
  const result = await h.run('login.mjs', [], { stream: true, hide: /^account=/ });
  assert.equal(h.stdout.text(), '<✓ linked>\n<tail>\n');
  assert.equal(h.stderr.text(), '<⚠ slow>\n');
  assert.equal(result.stdout, '✓ linked\naccount=ab12\ntail');
  assert.equal(result.stderr, '⚠ slow\n');
});

test('a painted run that does not stream echoes nothing', async () => {
  const h = setup((child) => { child.code = 0; child.stdout.end('✓ quiet\n'); child.stderr.end(); }, { paint: (line) => `<${line}>` });
  assert.deepEqual(await h.run('x.mjs', []), { code: 0, stdout: '✓ quiet\n', stderr: '' });
  assert.equal(h.stdout.text(), '');
});

// Timers driven by hand: fireDelay() runs pending timeouts once, tick() runs every live interval once.
function manualTimers() {
  const t = { timeouts: [], intervals: [] };
  return Object.assign(t, {
    setTimeout: (fn, ms) => { const h = { fn, ms, live: true }; t.timeouts.push(h); return h; },
    clearTimeout: (h) => { h.live = false; },
    setInterval: (fn, ms) => { const h = { fn, ms, live: true }; t.intervals.push(h); return h; },
    clearInterval: (h) => { h.live = false; },
    fireDelay: () => t.timeouts.filter((h) => h.live).forEach((h) => { h.live = false; h.fn(); }),
    tick: () => t.intervals.filter((h) => h.live).forEach((h) => h.fn()),
  });
}
const HIDE = '\x1b[?25l';
const SHOW = '\x1b[?25h';
const CLEAR = '\r\x1b[2K';
const LIVE = /^Beezi: (\d+)\/(\d+) sessions read…$/;

test('with activity and a label, the line appears after the 150 ms delay, redraws every 80 ms, and is cleared before the run resolves', async () => {
  const timers = manualTimers();
  const out = sink();
  const h = setup((child) => {
    assert.equal(out.text(), '');
    timers.fireDelay();
    timers.tick();
    child.code = 0; child.stdout.end(); child.stderr.end();
  }, { output: out, activity: true, timers, platform: 'darwin' });
  h.run.setLabel('Checking your plan…');
  await h.run('billing-capture.mjs', []);
  assert.equal(timers.timeouts[0].ms, 150);
  assert.equal(timers.intervals[0].ms, 80);
  assert.equal(out.text(), `${HIDE}${CLEAR}⠋ Checking your plan…${CLEAR}⠙ Checking your plan…${CLEAR}${SHOW}`);
  assert.ok(timers.intervals.every((x) => !x.live));
});

test('a run that ends before the delay draws nothing', async () => {
  const timers = manualTimers();
  const out = sink();
  const h = setup((child) => { child.code = 0; child.stdout.end(); child.stderr.end(); }, { output: out, activity: true, timers, platform: 'darwin' });
  h.run.setLabel('Checking this machine…');
  await h.run('accounts.mjs', ['list']);
  assert.equal(out.text(), '');
  assert.ok(timers.timeouts.every((x) => !x.live));
});

test('streamed lines print above the activity line, which is redrawn after each', async () => {
  const timers = manualTimers();
  const out = sink();
  const h = setup((child) => {
    timers.fireDelay();
    child.stdout.write('Opening your browser…\n');
    child.code = 0; child.stdout.end(); child.stderr.end();
  }, { stdout: out, output: out, activity: true, timers, platform: 'darwin' });
  await h.run('login.mjs', [], { stream: true, label: 'Waiting for you to sign in in your browser…' });
  assert.equal(out.text(), [
    `${HIDE}${CLEAR}⠋ Waiting for you to sign in in your browser…`,
    CLEAR, 'Opening your browser…\n',
    `${CLEAR}⠙ Waiting for you to sign in in your browser…`,
    `${CLEAR}${SHOW}`,
  ].join(''));
});

test('live lines update the activity text instead of printing, and are still captured', async () => {
  const timers = manualTimers();
  const out = sink();
  const h = setup((child) => {
    timers.fireDelay();
    child.stdout.write('Beezi: 1/4 sessions read…\nBeezi: 4/4 sessions read…\n✓ Beezi: uploaded 4 sessions.\n');
    child.code = 0; child.stdout.end(); child.stderr.end();
  }, { stdout: out, output: out, activity: true, timers, platform: 'darwin' });
  const result = await h.run('backfill.mjs', [], { stream: true, label: 'Uploading past sessions…', live: LIVE });
  assert.equal(out.text(), [
    `${HIDE}${CLEAR}⠋ Uploading past sessions…`,
    `${CLEAR}⠙ Uploading past sessions… 1/4`,
    `${CLEAR}⠹ Uploading past sessions… 4/4`,
    CLEAR, '✓ Beezi: uploaded 4 sessions.\n', `${CLEAR}⠸ Uploading past sessions… 4/4`,
    `${CLEAR}${SHOW}`,
  ].join(''));
  assert.equal(result.stdout, 'Beezi: 1/4 sessions read…\nBeezi: 4/4 sessions read…\n✓ Beezi: uploaded 4 sessions.\n');
});

test('without activity, live lines print as before and nothing is drawn', async () => {
  const out = sink();
  const h = setup((child) => {
    child.stdout.write('Beezi: 1/1 sessions read…\n');
    child.code = 0; child.stdout.end(); child.stderr.end();
  }, { stdout: out, output: out, activity: false });
  await h.run('backfill.mjs', [], { stream: true, label: 'Uploading past sessions…', live: LIVE });
  assert.equal(out.text(), 'Beezi: 1/1 sessions read…\n');
});

test('with activity but no label, nothing is drawn', async () => {
  const timers = manualTimers();
  const out = sink();
  const h = setup((child) => { child.code = 0; child.stdout.end(); child.stderr.end(); }, { output: out, activity: true, timers, platform: 'darwin' });
  await h.run('settings.mjs', ['keys']);
  assert.equal(timers.timeouts.length, 0);
  assert.equal(out.text(), '');
});

test('opts.label overrides the label set by setLabel for one run', async () => {
  const timers = manualTimers();
  const out = sink();
  const h = setup((child) => { timers.fireDelay(); child.code = 0; child.stdout.end(); child.stderr.end(); }, { output: out, activity: true, timers, platform: 'darwin' });
  h.run.setLabel('Checking this machine…');
  await h.run('login.mjs', [], { label: 'Waiting for you to sign in in your browser…' });
  assert.ok(out.text().includes('⠋ Waiting for you to sign in in your browser…'));
  assert.ok(!out.text().includes('Checking this machine'));
});

test('clearActivity mid-run clears the line and shows the cursor once; the close adds nothing', async () => {
  const timers = manualTimers();
  const out = sink();
  let h = null;
  h = setup((child) => {
    timers.fireDelay();
    h.run.clearActivity();
    child.code = 0; child.stdout.end(); child.stderr.end();
  }, { output: out, activity: true, timers, platform: 'darwin' });
  h.run.setLabel('Uploading past sessions…');
  await h.run('backfill.mjs', []);
  assert.equal(out.text(), `${HIDE}${CLEAR}⠋ Uploading past sessions…${CLEAR}${SHOW}`);
});

test('on Windows the frames are ASCII, and a long label is cut to the output width with …', async () => {
  const timers = manualTimers();
  const out = sink();
  out.columns = 20;
  const h = setup((child) => { timers.fireDelay(); child.code = 0; child.stdout.end(); child.stderr.end(); }, { output: out, activity: true, timers, platform: 'win32' });
  h.run.setLabel('Looking at your past sessions…');
  await h.run('workspace.mjs', ['routes']);
  assert.equal(out.text(), `${HIDE}${CLEAR}| Looking at your …${CLEAR}${SHOW}`);
});

test('a spawn error stops the activity line before resolving 127', async () => {
  const timers = manualTimers();
  const out = sink();
  const h = setup((child) => { timers.fireDelay(); child.emit('error', new Error('spawn ENOENT')); }, { output: out, activity: true, timers, platform: 'darwin' });
  h.run.setLabel('Checking your plan…');
  assert.equal((await h.run('x.mjs', [])).code, 127);
  assert.ok(out.text().endsWith(`${CLEAR}${SHOW}`));
  assert.ok(timers.intervals.every((x) => !x.live));
});
