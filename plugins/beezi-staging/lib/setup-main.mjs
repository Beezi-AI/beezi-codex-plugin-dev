import fs from 'fs';
import os from 'os';
import path from 'path';
import { removeDirSync } from './compat.mjs';
import { probeHookTrust } from './hook-trust.mjs';
import { headerLines } from './setup-finale.mjs';
import { createPrompt, openTerminal } from './setup-prompt.mjs';
import { createRunner } from './setup-runner.mjs';
import { canReadKeys, formatLine, paint, terminalStyle } from './setup-style.mjs';
import { AGENT, runSetup } from './setup-wizard.mjs';

// Session-id variables Codex exports to shell commands; the runner drops them from every child's env.
export const SESSION_KEYS = Object.freeze(['CODEX_THREAD_ID', 'CODEX_SESSION_ID']);
export const NO_TERMINAL = '✗ Beezi setup needs a terminal. Ask "Sign me in to Beezi" in a new Codex thread instead.';
export const STOPPED = 'Setup stopped. Ask "Sign me in to Beezi" in a new Codex thread to finish.';
const INTERRUPTED = 130;
const SHOW_CURSOR = '\x1b[?25h';
const MARGIN = '  ';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-setup-'));
}

function onSigint(handler) {
  process.on('SIGINT', handler);
}

function onProcessExit(handler) {
  process.on('exit', handler);
}

// Each non-empty \n-separated row starts at the setup's left margin.
function indent(text) {
  return String(text).split('\n').map((row) => (row === '' ? row : MARGIN + row)).join('\n');
}

// Runs the wizard on the terminal from a fresh temp cwd and resolves its exit code; Ctrl+C exits 130. The header is left to the installer when it ran the setup.
export function setupMain(root, deps) {
  const d = deps || {};
  const stdout = d.stdout || process.stdout;
  const stderr = d.stderr || process.stderr;
  const env = d.env || process.env;
  const style = terminalStyle({ stream: stdout, env });
  if (env.BEEZI_INSTALLER !== '1') headerLines({ agent: AGENT, style }).forEach((line) => { stdout.write(`${line}\n`); });
  const input = (d.openTerminal || openTerminal)();
  if (input === null) {
    stderr.write(`${indent(paint(style, NO_TERMINAL))}\n`);
    return Promise.resolve(1);
  }
  // Shows the cursor again on process exit.
  if (stdout.isTTY) (d.onExit || onProcessExit)(() => { stdout.write(SHOW_CURSOR); });
  // Wrapped to the width left of the margin on a terminal, so the offer shapes still match; a log keeps each line whole.
  const columns = () => (stdout.columns || 80) - MARGIN.length;
  const format = (line) => indent(stdout.isTTY ? formatLine(style, line, columns()) : paint(style, line));
  const print = (line) => { stdout.write(`${format(line)}\n`); };
  const removeDir = d.removeDir || removeDirSync;
  const exit = d.exit || ((code) => process.exit(code));
  const cwd = (d.makeTempDir || makeTempDir)();
  let prompt = null;
  const cleanup = () => {
    prompt.close();
    removeDir(cwd);
  };
  let run = null;
  // Set while catchInterrupt runs its task: Ctrl+C then stops only that task.
  let caught = null;
  // Shared by SIGINT and Ctrl+C inside an arrow-key menu; a drawn activity line is cleared first.
  const stop = () => {
    if (caught !== null) {
      caught.hit = true;
      return;
    }
    if (run !== null) run.clearActivity();
    cleanup();
    print('');
    print(STOPPED);
    exit(INTERRUPTED);
  };
  prompt = (d.createPrompt || createPrompt)({
    input, output: stdout, style, interactive: canReadKeys({ input, output: stdout, env }), onInterrupt: stop, format,
  });
  (d.onInterrupt || onSigint)(stop);
  const activity = stdout.isTTY === true && env.TERM !== 'dumb';
  run = (d.createRunner || createRunner)({
    root, cwd, env, sessionKeys: SESSION_KEYS, paint: format, stdout, stderr,
    output: stdout, activity, margin: MARGIN, accent: style.accent,
  });
  const progress = (label) => { run.setLabel(label); };
  const trust = d.trust || (() => probeHookTrust());
  // Runs task(interrupted) with Ctrl+C ending only the task: interrupted() turns true and setup carries on.
  const catchInterrupt = (task) => {
    const mine = { hit: false };
    caught = mine;
    return task(() => mine.hit).finally(() => { caught = null; });
  };
  return (d.runSetup || runSetup)({
    run, ask: prompt, print, progress, style, trust, output: stdout, activity, format, columns, catchInterrupt,
  }).finally(cleanup);
}
