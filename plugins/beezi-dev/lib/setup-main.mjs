import fs from 'fs';
import os from 'os';
import path from 'path';
import { removeDirSync } from './compat.mjs';
import { createPrompt, openTerminal } from './setup-prompt.mjs';
import { createRunner } from './setup-runner.mjs';
import { runSetup } from './setup-wizard.mjs';

// Session-id variables Codex exports to shell commands; the runner drops them from every child's env.
export const SESSION_KEYS = Object.freeze(['CODEX_THREAD_ID', 'CODEX_SESSION_ID']);
export const NO_TERMINAL = '✗ Beezi setup needs a terminal. Ask "Sign me in to Beezi" in a new Codex thread instead.';
export const STOPPED = 'Setup stopped. Run the installer again, or ask "Sign me in to Beezi" in a new Codex thread, to finish.';
const INTERRUPTED = 130;

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-setup-'));
}

function onSigint(handler) {
  process.once('SIGINT', handler);
}

// Runs the wizard on the terminal from a fresh temp cwd and resolves its exit code; Ctrl+C exits 130.
export function setupMain(root, deps) {
  const d = deps || {};
  const stdout = d.stdout || process.stdout;
  const stderr = d.stderr || process.stderr;
  const input = (d.openTerminal || openTerminal)();
  if (input === null) {
    stderr.write(`${NO_TERMINAL}\n`);
    return Promise.resolve(1);
  }
  const removeDir = d.removeDir || removeDirSync;
  const exit = d.exit || ((code) => process.exit(code));
  const cwd = (d.makeTempDir || makeTempDir)();
  const prompt = (d.createPrompt || createPrompt)({ input, output: stdout });
  const cleanup = () => {
    prompt.close();
    removeDir(cwd);
  };
  (d.onInterrupt || onSigint)(() => {
    cleanup();
    stdout.write(`\n${STOPPED}\n`);
    exit(INTERRUPTED);
  });
  const run = (d.createRunner || createRunner)({ root, cwd, env: d.env || process.env, sessionKeys: SESSION_KEYS });
  const print = (line) => { stdout.write(`${line}\n`); };
  return (d.runSetup || runSetup)({ run, ask: prompt, print }).finally(cleanup);
}
