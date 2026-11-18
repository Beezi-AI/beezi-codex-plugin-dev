import path from 'path';
import url from 'url';
import childProcess from 'child_process';
import { parseAccountFlag } from '../lib/accounts.mjs';
import { EVERYTHING_DONE, lastLine, parseListing, report, wrote } from '../lib/setup-routing.mjs';
import { ACCOUNT_LINE, AGENT, applyDefaults, capturePlan, checkHooks, trustPending, uploadPast } from '../lib/setup-wizard.mjs';
import { NO_PLAN, SETTINGS_SKILL, closingLines } from '../lib/setup-finale.mjs';
import { createStyle } from '../lib/setup-style.mjs';
import { probeHookTrust } from '../lib/hook-trust.mjs';
import { UserError, friendlyMessage } from '../lib/friendly-error.mjs';
import { cliMayProceed } from '../lib/env-guard.mjs';

// The login skill's commands in two calls: the first runs up to the tracking question, `--from finish` everything
// after it. Each output is a block; `next=<step>` is printed last.
const SCRIPTS_DIR = path.dirname(url.fileURLToPath(import.meta.url));
const USAGE = 'Usage: login-flow.mjs [--account <ref> [--from finish]]';
const PLAIN = createStyle({ enabled: false });

function runScript(script, args) {
  const result = childProcess.spawnSync(process.execPath, [path.join(SCRIPTS_DIR, script)].concat(args), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error != null) throw result.error;
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

// Streams as it runs: the sign-in prints its URL while it waits for the browser. Its stderr stays inside the
// block too, since step 1 relays the ✗ line.
function runLive(script, args) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, [path.join(SCRIPTS_DIR, script)].concat(args), { stdio: ['inherit', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; process.stdout.write(chunk); });
    child.stderr.on('data', (chunk) => { process.stdout.write(chunk); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

function block(tag, result) {
  const text = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}`.trim();
  console.log([`<${tag}>`].concat(text === '' ? [] : [text], [`</${tag.split(' ')[0]}>`]).join('\n'));
}

function next(step, key) {
  console.log(key == null ? `next=${step}` : `next=${step} account=${key}`);
}

// A ctx for the setup helpers that collects what they print; `io` holds the `run` and `trust` deps.
function collector(io, lines) {
  return { run: io.run, trust: io.trust, now: io.now, sleep: io.sleep, print: (line) => { lines.push(line); } };
}

// The silent capture: the plan found, or the line saying it was not, plus any notice the capture printed.
async function planStep(key, io) {
  const lines = [];
  const plan = await capturePlan(collector(io, lines), key);
  lines.push(plan === null ? NO_PLAN : `✓ Plan found: ${plan}`);
  console.log(['<plan>'].concat(lines, ['</plan>']).join('\n'));
}

// The listing, or null when the agent asks the question; else { lead, pastFailed } for the finish step.
async function trackStep(key, io) {
  const result = await io.run('workspace.mjs', ['setup', '--account', key]);
  if (result.code !== 0 || lastLine(result.stdout, /^setup=/) === null) {
    const lead = [];
    report(collector(io, lead), result);
    return { lead, pastFailed: true };
  }
  const listing = parseListing(result.stdout);
  if (listing.chosen) return { lead: [`✓ Tracking is already set up (${SETTINGS_SKILL})`], pastFailed: false };
  if (listing.workspaceCount === 0) return { lead: [], pastFailed: false };
  if (listing.places.length > 0 || listing.workspaceCount > 1) {
    block(`track account="${key}"`, result);
    return null;
  }
  const lead = [];
  const write = await io.run('workspace.mjs', ['setup', 'everything', '--account', key, '--defer-upload']);
  if (wrote(collector(io, lead), write, EVERYTHING_DONE)) lead.push('✓ Tracking every repo and folder you work in');
  return { lead, pastFailed: false };
}

// The lines the agent shows verbatim: `lead`, the upload line, the closing lines; hooks.mjs install checks hooks the sign-in did not install.
async function finish(key, io, lead, options) {
  const lines = lead.slice();
  const ctx = collector(io, lines);
  const hooksFailed = options.signedIn ? false : await checkHooks(ctx);
  const pending = await trustPending(ctx);
  if (options.upload) await uploadPast(ctx, key);
  const crash = await applyDefaults(ctx);
  const closing = closingLines({
    agent: AGENT, style: PLAIN, crash, trustPending: pending, hooksFailed, planFound: true, pastFailed: options.pastFailed,
  });
  console.log(['<finish>'].concat(lines.length === 0 ? closing.slice(1) : lines.concat(closing), ['</finish>']).join('\n'));
  next('done', key);
}

// The plan, then the tracking listing; finishes right away when there is no question to ask.
async function start(key, signedIn, io) {
  await planStep(key, io);
  const done = await trackStep(key, io);
  if (done === null) next('track', key);
  else await finish(key, io, done.lead, { signedIn, upload: false, pastFailed: done.pastFailed });
}

// Step 1: { key } once login.mjs linked an account, or null when the sign-in failed.
async function signIn(live) {
  console.log('<sign-in>');
  const result = await live('login.mjs', []);
  console.log('</sign-in>');
  const line = lastLine(result.stdout, ACCOUNT_LINE);
  if (result.code !== 0 || line === null) {
    process.exitCode = 1;
    return null;
  }
  return { key: ACCOUNT_LINE.exec(line)[1] };
}

// deps: `run` (captured script), `live` (streamed script), `trust` (hook-trust probe). `--account` alone starts after beezi_login.
export async function loginFlow(argv, deps = {}) {
  const all = { run: runScript, live: runLive, trust: () => probeHookTrust(), ...deps };
  const { account, rest } = await parseAccountFlag(argv);
  if (rest.length === 0 && account == null) {
    const linked = await signIn(all.live);
    if (linked === null) next('stop');
    else await start(linked.key, true, all);
    return;
  }
  if (account != null && rest.length === 0) {
    await start(account, false, all);
    return;
  }
  if (account == null || rest.length !== 2 || rest[0] !== '--from' || rest[1] !== 'finish') throw new UserError(USAGE);
  await finish(account, all, [], { signedIn: false, upload: true, pastFailed: false });
}

// Run only when this file IS the entry point. Importing it must not execute it.
function isDirectRun() {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry === '') return false;
  try {
    return path.resolve(entry) === path.resolve(url.fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  // Gate first: the steps read the index and session state a pending migration may still move.
  if (!cliMayProceed()) {
    process.exitCode = 1;
  } else {
    loginFlow(process.argv.slice(2)).catch((error) => {
      console.error(`\n✗ ${friendlyMessage(error)}`);
      process.exit(1);
    });
  }
}
