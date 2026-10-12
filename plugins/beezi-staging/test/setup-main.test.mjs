import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NO_TERMINAL, SESSION_KEYS, STOPPED, setupMain } from '../lib/setup-main.mjs';

function sink() {
  const chunks = [];
  return { chunks, write: (s) => { chunks.push(s); return true; }, text: () => chunks.join('') };
}

function harness(over) {
  const seen = { closed: 0, removed: [], runner: null, prompt: null, ctx: null, exit: null, interrupt: null };
  const stdout = sink();
  const stderr = sink();
  const terminal = { isTTY: true };
  const deps = {
    stdout,
    stderr,
    env: { PATH: '/bin', CODEX_THREAD_ID: 'thread-1' },
    openTerminal: () => terminal,
    makeTempDir: () => '/tmp/beezi-setup-x1',
    removeDir: (dir) => { seen.removed.push(dir); },
    createPrompt: (io) => { seen.prompt = io; return { close: () => { seen.closed += 1; } }; },
    createRunner: (options) => { seen.runner = options; return 'run-fn'; },
    runSetup: (ctx) => { seen.ctx = ctx; return Promise.resolve(0); },
    onInterrupt: (handler) => { seen.interrupt = handler; },
    exit: (code) => { seen.exit = code; },
    ...over,
  };
  return { deps, seen, stdout, stderr, terminal };
}

test('SESSION_KEYS are the two variables Codex exports with the session id', () => {
  assert.deepEqual(SESSION_KEYS, ['CODEX_THREAD_ID', 'CODEX_SESSION_ID']);
});

test('without a terminal it says how to sign in instead and exits 1 before touching anything', async () => {
  const h = harness({ openTerminal: () => null });
  assert.equal(await setupMain('/plugin', h.deps), 1);
  assert.equal(h.stderr.text(), `${NO_TERMINAL}\n`);
  assert.equal(NO_TERMINAL, '✗ Beezi setup needs a terminal. Ask "Sign me in to Beezi" in a new Codex thread instead.');
  assert.equal(h.seen.runner, null);
  assert.equal(h.seen.interrupt, null);
  assert.deepEqual(h.seen.removed, []);
});

test('it runs the wizard from a fresh temp cwd with the session keys stripped, then cleans up', async () => {
  const h = harness({});
  assert.equal(await setupMain('/plugin', h.deps), 0);
  assert.deepEqual(h.seen.runner, { root: '/plugin', cwd: '/tmp/beezi-setup-x1', env: h.deps.env, sessionKeys: SESSION_KEYS });
  assert.equal(h.seen.prompt.input, h.terminal);
  assert.equal(h.seen.prompt.output, h.stdout);
  assert.equal(h.seen.ctx.run, 'run-fn');
  assert.equal(typeof h.seen.ctx.ask.close, 'function');
  h.seen.ctx.print('✓ done');
  assert.equal(h.stdout.text(), '✓ done\n');
  assert.equal(h.seen.closed, 1);
  assert.deepEqual(h.seen.removed, ['/tmp/beezi-setup-x1']);
});

test("the wizard's exit code passes through, and a crash still closes the prompt and removes the temp dir", async () => {
  const signInFailed = harness({ runSetup: () => Promise.resolve(1) });
  assert.equal(await setupMain('/plugin', signInFailed.deps), 1);
  assert.deepEqual(signInFailed.seen.removed, ['/tmp/beezi-setup-x1']);
  const crashed = harness({ runSetup: () => Promise.reject(new Error('boom')) });
  await assert.rejects(setupMain('/plugin', crashed.deps), /boom/);
  assert.equal(crashed.seen.closed, 1);
  assert.deepEqual(crashed.seen.removed, ['/tmp/beezi-setup-x1']);
});

test('Ctrl+C closes the prompt, removes the temp dir, says how to finish and exits 130', () => {
  const h = harness({ runSetup: () => new Promise(() => {}) });
  setupMain('/plugin', h.deps);
  h.seen.interrupt();
  assert.equal(h.stdout.text(), `\n${STOPPED}\n`);
  assert.equal(STOPPED, 'Setup stopped. Run the installer again, or ask "Sign me in to Beezi" in a new Codex thread, to finish.');
  assert.equal(h.seen.exit, 130);
  assert.equal(h.seen.closed, 1);
  assert.deepEqual(h.seen.removed, ['/tmp/beezi-setup-x1']);
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
