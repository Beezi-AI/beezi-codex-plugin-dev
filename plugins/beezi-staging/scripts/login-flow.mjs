import path from 'path';
import url from 'url';
import childProcess from 'child_process';
import { getAccount, parseAccountFlag } from '../lib/accounts.mjs';
import { isMultiTenant, newFoldersOf, roleLabel, tenantsOf } from '../lib/workspace.mjs';
import { pastSessions } from '../lib/past-sessions.mjs';
import { lastLine, setupOptions } from '../lib/setup-routing.mjs';
import { ACCOUNT_LINE, planSettled } from '../lib/setup-wizard.mjs';
import { workspaceCommand } from '../lib/workspace-cli.mjs';
import { UserError, friendlyMessage } from '../lib/friendly-error.mjs';
import { cliMayProceed } from '../lib/env-guard.mjs';

// The login skill's commands in as few calls as its questions allow: each call runs from the sign-in (or
// `--from <step>`) up to the next question, printing every output as a block and `next=<step>` last.
const SCRIPTS_DIR = path.dirname(url.fileURLToPath(import.meta.url));
const FROM_STEPS = ['setup', 'here', 'plan', 'joined', 'routes'];
const USAGE = 'Usage: login-flow.mjs [--account <ref> --from <setup|here|plan|joined|routes>]';
// Writes made between calls leave the upload to the login skill's backfill.
const DEFER = '--defer-upload';

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
  console.log([`<${tag}>`].concat(text === '' ? [] : [text], [`</${tag}>`]).join('\n'));
}

// A workspace.mjs listing's lines, then its ✗ line (stderr, without the blank line before it).
function printListing(tag, key, result) {
  const errors = result.stderr.map((line) => line.trim()).filter((line) => line !== '');
  console.log([`<${tag} account="${key}">`].concat(result.lines, errors, [`</${tag}>`]).join('\n'));
}

// A listing in-process, as a block; one that fails keeps its ✗ line there and the later steps still run.
async function listing(tag, key, deps) {
  const result = await deps.workspace([tag, '--account', key, DEFER], { cwd: deps.cwd });
  printListing(tag, key, result);
  return result;
}

// The listing's `<name>=<n>` count, 0 when it has none.
function countOf(result, name) {
  const line = lastLine(result.lines.join('\n'), new RegExp(`^${name}=\\d+$`));
  return line === null ? 0 : Number(line.slice(name.length + 1));
}

function next(step, key) {
  console.log(key == null ? `next=${step}` : `next=${step} account=${key}`);
}

// Step 1w's one question: the workspaces, the counts, then the options. A count that fails prints its ✗ line and
// the options without counts: the question still stands.
function setupQuestion(row, deps) {
  const tenants = tenantsOf(row);
  const lines = tenants.map((t) => `W. ${t.name ? t.name : t.id} account=${row.key} tenant=${t.id} role=${roleLabel(t)}`);
  let history = null;
  try {
    history = deps.pastSessions(row);
    lines.push(`sessions=${history.sessions} places=${history.places}`);
  } catch (error) {
    lines.push(`✗ ${friendlyMessage(error)}`);
  }
  setupOptions(tenants.map((t) => ({ name: t.name ? t.name : t.id })), history)
    .forEach((option, i) => lines.push(`O${i + 1}. ${option.label} — ${option.description}`));
  console.log([`<setup account="${row.key}">`].concat(lines, ['</setup>']).join('\n'));
}

// The `here:` line's rule= value, read from its fixed tail: the label and path= before it may hold " rule=" themselves.
function hereRule(line, key) {
  const found = new RegExp(` account=${key} rule=(\\S+) kind=(?:repo|folder|outside) match=`).exec(line);
  return found ? found[1] : null;
}

// Under Ask me, this session's folder with no rule (the rules listing's `here:` line says rule=none) is asked about
// next. The listing is shown only then, or when it failed.
async function hereStops(row, deps) {
  if (!isMultiTenant(row) || newFoldersOf(row).mode !== 'ask') return false;
  const result = await deps.workspace(['rules', '--account', row.key], { cwd: deps.cwd });
  const here = lastLine(result.lines.join('\n'), /^here: /);
  const stops = result.ok && here !== null && hereRule(here, row.key) === 'none';
  if (stops || !result.ok) printListing('rules', row.key, result);
  return stops;
}

// Step 2: the capture; true when it settled no plan, so step 3's tier question comes next.
function tierNeeded(key, deps) {
  const capture = deps.run('billing-capture.mjs', ['--from-codex', '--via', 'login', '--account', key]);
  block('capture', capture);
  return !planSettled(capture.stdout);
}

// From `from` on, each step's output, stopping at the first one that needs a question; 'backfill' when none does.
async function fromStep(from, key, deps) {
  const row = await getAccount(key);
  if (row == null) throw new UserError('That account is not linked on this machine. Run the login skill again.');
  for (const step of FROM_STEPS.slice(FROM_STEPS.indexOf(from))) {
    if (step === 'setup' && isMultiTenant(row) && !newFoldersOf(row).set) {
      setupQuestion(row, deps);
      return 'setup';
    }
    if (step === 'here' && await hereStops(row, deps)) return 'here';
    if (step === 'plan' && tierNeeded(key, deps)) return 'tier';
    if (step === 'joined' && countOf(await listing('joined', key, deps), 'joined') > 0) return 'joined';
    if (step === 'routes' && countOf(await listing('routes', key, deps), 'routes') > 0) return 'routes';
  }
  return 'backfill';
}

// Step 1: the key login.mjs linked, or null when the sign-in failed.
async function signIn(deps) {
  console.log('<sign-in>');
  const result = await deps.live('login.mjs', []);
  console.log('</sign-in>');
  const line = lastLine(result.stdout, ACCOUNT_LINE);
  if (result.code !== 0 || line === null) {
    process.exitCode = 1;
    return null;
  }
  return ACCOUNT_LINE.exec(line)[1];
}

const DEFAULTS = {
  run: runScript,
  live: runLive,
  workspace: workspaceCommand,
  pastSessions,
  cwd: null,
};

// deps: `run` (captured script), `live` (streamed script), `workspace` (workspaceCommand), `pastSessions(row)`
// ({ sessions, places }) for the setup question, and `cwd` (this session's directory; null = the process's).
export async function loginFlow(argv, deps = {}) {
  const all = { ...DEFAULTS, ...deps };
  const { account, rest } = await parseAccountFlag(argv);
  if (rest.length === 0 && account == null) {
    const key = await signIn(all);
    if (key === null) next('stop');
    else next(await fromStep('setup', key, all), key);
    return;
  }
  if (account == null || rest.length !== 2 || rest[0] !== '--from' || FROM_STEPS.indexOf(rest[1]) === -1) throw new UserError(USAGE);
  next(await fromStep(rest[1], account, all), account);
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
  // Gate first: the in-process listings read the index and session state a pending migration may still move.
  if (!cliMayProceed()) {
    process.exitCode = 1;
  } else {
    loginFlow(process.argv.slice(2)).catch((error) => {
      console.error(`\n✗ ${friendlyMessage(error)}`);
      process.exit(1);
    });
  }
}
