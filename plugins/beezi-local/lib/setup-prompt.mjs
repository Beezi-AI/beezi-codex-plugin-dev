import fs from 'fs';
import readline from 'readline';
import tty from 'tty';

function openDevTty() {
  return new tty.ReadStream(fs.openSync('/dev/tty', 'r'));
}

// stdin when it is a terminal, else /dev/tty off Windows, else null.
export function openTerminal(deps) {
  const d = deps || {};
  const stdin = d.stdin || process.stdin;
  const platform = d.platform || process.platform;
  const openTty = d.openTty || openDevTty;
  if (stdin.isTTY) return stdin;
  if (platform === 'win32') return null;
  try {
    return openTty();
  } catch (error) {
    return null;
  }
}

// "1, 3" → [0, 2]; null when any part is not an option number.
export function parseNumbers(answer, count) {
  const picked = [];
  const parts = answer.split(',').map((part) => part.trim()).filter((part) => part !== '');
  for (let i = 0; i < parts.length; i += 1) {
    if (!/^\d+$/.test(parts[i])) return null;
    const n = Number(parts[i]);
    if (n < 1 || n > count) return null;
    if (picked.indexOf(n - 1) === -1) picked.push(n - 1);
  }
  return picked;
}

export function renderOptions(options, defaultIndex) {
  return options.map((option, i) => {
    const mark = i === defaultIndex ? ' (default)' : '';
    const description = option.description ? ` — ${option.description}` : '';
    return `  ${i + 1}) ${option.label}${mark}${description}`;
  });
}

export function createPrompt(io) {
  const output = io.output;
  const rl = readline.createInterface({ input: io.input, terminal: false });
  let waiting = null;
  let closed = false;

  function settle(value) {
    const resolve = waiting;
    waiting = null;
    resolve(value);
  }

  rl.on('line', (line) => {
    if (waiting !== null) settle(line.trim());
  });
  rl.on('close', () => {
    closed = true;
    if (waiting !== null) settle(null);
  });

  function ask(query) {
    if (closed) return Promise.resolve(null);
    output.write(query);
    return new Promise((resolve) => { waiting = resolve; });
  }

  function showMenu(question, options, defaultIndex) {
    output.write(`\n${question}\n${renderOptions(options, defaultIndex).join('\n')}\n`);
  }

  async function choose(question, options, opts) {
    if (closed) return null;
    const defaultIndex = opts && typeof opts.defaultIndex === 'number' ? opts.defaultIndex : -1;
    showMenu(question, options, defaultIndex);
    const range = `1-${options.length}`;
    const query = defaultIndex === -1 ? `Choose ${range}, or press Enter to skip: ` : `Choose ${range} [${defaultIndex + 1}]: `;
    for (;;) {
      const answer = await ask(query);
      if (answer === null) return null;
      if (answer === '') return defaultIndex === -1 ? null : defaultIndex;
      const picked = parseNumbers(answer, options.length);
      if (picked !== null && picked.length === 1) return picked[0];
      output.write(`Enter one number from 1 to ${options.length}.\n`);
    }
  }

  async function chooseMany(question, options) {
    if (closed) return null;
    showMenu(question, options, -1);
    for (;;) {
      const answer = await ask('Choose one or more (for example 1,3), or press Enter to skip: ');
      if (answer === null) return null;
      const picked = parseNumbers(answer, options.length);
      if (picked !== null) return picked;
      output.write(`Enter numbers from 1 to ${options.length}, separated by commas.\n`);
    }
  }

  async function confirm(question, defaultYes) {
    if (closed) return null;
    const query = `\n${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `;
    for (;;) {
      const answer = await ask(query);
      if (answer === null) return null;
      if (answer === '') return defaultYes;
      if (/^(y|yes)$/i.test(answer)) return true;
      if (/^(n|no)$/i.test(answer)) return false;
      output.write('Answer y or n.\n');
    }
  }

  async function text(question) {
    const answer = await ask(`\n${question} `);
    return answer === null || answer === '' ? null : answer;
  }

  return { choose, chooseMany, confirm, text, close: () => rl.close() };
}
