import { createStyle } from '../lib/setup-style.mjs';

// Scripted ctx for the setup wizard tests: outputs keyed by "<script> <argv…>", queued answers (null once the queue is empty), captured prints.
export const ok = (stdout) => ({ code: 0, stdout, stderr: '' });
export const failed = (stderr) => ({ code: 1, stdout: '', stderr });

// What an unscripted workspace write prints last when it succeeds, as workspace.mjs prints it.
const WRITE_DONE = [
  ['workspace.mjs rule add ', 'rule=1\n'],
  ['workspace.mjs setup everything ', 'setup=everything\n'],
  ['workspace.mjs setup chosen ', 'setup=chosen\n'],
];

function unscripted(command) {
  const done = WRITE_DONE.filter(([prefix]) => command.indexOf(prefix) === 0)[0];
  return ok(done === undefined ? '' : done[1]);
}

// An array value answers successive runs of one command in order; an unscripted write succeeds with its last line,
// any other unscripted command silently. `verdict` is what the hook-trust probe answers.
export function fakeCtx(outputs, answers, verdict = 'trusted') {
  const runs = [];
  const asked = [];
  const printed = [];
  const queue = answers.slice();
  let label = null;
  const answer = (entry) => {
    asked.push(entry);
    return Promise.resolve(queue.length ? queue.shift() : null);
  };
  const opt = (opts, name) => (opts ? opts[name] : undefined);
  return {
    runs,
    asked,
    printed,
    style: createStyle({ enabled: false }),
    print: (line) => { printed.push(line); },
    progress: (next) => { label = next; },
    trust: () => Promise.resolve({ verdict, untrusted: [], disabled: [] }),
    run: (script, argv, opts) => {
      const command = [script].concat(argv).join(' ');
      runs.push({ command, opts: opts || {}, label });
      const scripted = outputs[command];
      const result = Array.isArray(scripted) ? scripted.shift() : scripted;
      return Promise.resolve(result === undefined ? unscripted(command) : result);
    },
    ask: {
      choose: (question, options, opts) => answer({ kind: 'choose', question, options, lead: opt(opts, 'lead') }),
      chooseMany: (question, options, opts) => answer({ kind: 'chooseMany', question, options, preselected: opt(opts, 'preselected') }),
    },
  };
}

export const commands = (ctx) => ctx.runs.map((r) => r.command);
export const labels = (entry) => entry.options.map((o) => o.label);
