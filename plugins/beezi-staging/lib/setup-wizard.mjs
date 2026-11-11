import { BillingSource, CHATGPT_PLANS } from './billing.mjs';
import { TrustVerdict } from './hook-trust.mjs';
import { PLAN_LABELS } from './settings-cli.mjs';
import { closingLines } from './setup-finale.mjs';
import { askTracking, lastLine, outputLines, report, token } from './setup-routing.mjs';

// One `accounts.mjs list` row: "  <n>. <description> [<key>]", then "  (default, revoked)" marks when any.
const LISTED_ACCOUNT = /^ {2}\d+\. (.+) \[([0-9a-f]{8})\](?: {2}\(([a-z, ]+)\))?$/;
export const ACCOUNT_LINE = /^account=([0-9a-f]{8})$/;
export const AGENT = 'Codex';
const MACHINE_LABEL = 'Checking this machine';
const SIGN_IN_LABEL = 'Waiting for you to sign in in your browser';
const SESSIONS_LABEL = 'Checking past sessions';
// login.mjs lines the setup's own lines replace (signed in, the closing /hooks step); the browser link and failures still show.
const LOGIN_HIDDEN = /^(?:account=|Beezi analytics — link this machine$|✓ (?:Beezi analytics (?:re-)?linked|already linked) as | {2}(?:The analytics skill still reads from|Analytics hooks |One step left — |Another Beezi process is updating the hook registry)|\s*$)/;
const WORKSPACE_AFTER_EMAIL = '> - ';
const WORKSPACE_SEPARATOR = ' - ';
const CAPTURED = / source=(\S+) plan=([^\s.]+)/;
export const PLAN_EXPIRED = /Codex sign-in expired/;
const SOURCE_LABELS = { [BillingSource.OPENAI_API_KEY]: 'API key', [BillingSource.THIRD_PARTY]: 'Third-party provider' };

export function parseLinkedAccounts(text) {
  return outputLines(text)
    .map((line) => LISTED_ACCOUNT.exec(line))
    .filter((found) => found !== null)
    .map((found) => {
      const marks = found[3] === undefined ? [] : found[3].split(', ');
      return {
        description: found[1],
        key: found[2],
        isDefault: marks.indexOf('default') !== -1,
        revoked: marks.indexOf('revoked') !== -1,
      };
    });
}

// The usable linked accounts, the analytics default first, then the rest in listed order.
async function usableAccounts(ctx) {
  const listing = await ctx.run('accounts.mjs', ['list']);
  if (listing.code !== 0) report(ctx, listing);
  const linked = parseLinkedAccounts(listing.stdout).filter((account) => !account.revoked);
  return linked.filter((account) => account.isDefault).concat(linked.filter((account) => !account.isDefault));
}

// Streams login.mjs with the lines the setup replaces hidden; the key is null unless it exited 0 with an `account=` line.
async function signIn(ctx) {
  const result = await ctx.run('login.mjs', [], { stream: true, hide: LOGIN_HIDDEN, label: SIGN_IN_LABEL });
  const last = lastLine(result.stdout, ACCOUNT_LINE);
  return { key: result.code === 0 && last !== null ? ACCOUNT_LINE.exec(last)[1] : null };
}

// The workspace a "<name> <<email>> - <workspace>" description names, or null.
function workspaceOf(description) {
  if (description === null) return null;
  const named = description.indexOf(WORKSPACE_AFTER_EMAIL);
  if (named !== -1) return description.slice(named + WORKSPACE_AFTER_EMAIL.length);
  const at = description.indexOf(WORKSPACE_SEPARATOR);
  return at === -1 ? null : description.slice(at + WORKSPACE_SEPARATOR.length);
}

// "✓ Signed in as <email>", with ", workspace <name>" for a one-workspace account, from its `settings.mjs keys` row.
async function signedInLine(ctx, account) {
  const keys = await ctx.run('settings.mjs', ['keys']);
  const row = outputLines(keys.stdout).filter((line) => line.indexOf(`account=${account.key} `) === 0)[0];
  const email = row === undefined ? null : token(row, 'email');
  const workspace = row !== undefined && token(row, 'workspaces') === '1' ? workspaceOf(account.description) : null;
  const who = email !== null && email !== 'unknown' ? ` as ${ctx.style.bold(email)}` : '';
  return `✓ Signed in${who}${workspace === null ? '' : `, workspace ${ctx.style.bold(workspace)}`}`;
}

// True when the capture line names a priced plan or a billing source that is not a subscription.
export function planSettled(text) {
  const line = lastLine(text, CAPTURED);
  if (line === null) return false;
  const found = CAPTURED.exec(line);
  return CHATGPT_PLANS.indexOf(found[2]) !== -1
    || found[1] === BillingSource.OPENAI_API_KEY
    || found[1] === BillingSource.THIRD_PARTY;
}

// The silent capture; the settled plan's label, or null. Only a failure and the expired sign-in notice print.
export async function capturePlan(ctx, key) {
  const captured = await ctx.run('billing-capture.mjs', ['--from-codex', '--via', 'login', '--account', key]);
  if (captured.code !== 0) {
    report(ctx, captured);
    return null;
  }
  if (planSettled(captured.stdout)) {
    const found = CAPTURED.exec(lastLine(captured.stdout, CAPTURED));
    if (SOURCE_LABELS[found[1]] !== undefined) return SOURCE_LABELS[found[1]];
    return PLAN_LABELS[found[2]] !== undefined ? PLAN_LABELS[found[2]] : found[2];
  }
  const expired = lastLine(captured.stdout, PLAN_EXPIRED);
  if (expired !== null) ctx.print(expired);
  return null;
}

const HOOK_WARNING = /^⚠/;

// Runs `hooks.mjs install`, printing only its ⚠ lines, or its failure; resolves whether it failed.
export async function checkHooks(ctx) {
  const result = await ctx.run('hooks.mjs', ['install']);
  if (result.code !== 0) report(ctx, result);
  else outputLines(result.stdout).filter((line) => HOOK_WARNING.test(line)).forEach((line) => ctx.print(line));
  return result.code !== 0;
}

// Whether Codex still has to trust the hooks, from lib/hook-trust.mjs's verdict (ctx.trust).
export async function trustPending(ctx) {
  const trust = await ctx.trust();
  return trust != null && trust.verdict === TrustVerdict.UNTRUSTED;
}

// Queues the consented upload and says how many sessions are on their way; a failure prints its own lines.
export async function uploadPast(ctx, key) {
  const result = await ctx.run('sync.mjs', ['--offer', '--past', '--account', key, '--consented']);
  if (result.code !== 0) {
    report(ctx, result);
    return;
  }
  const line = lastLine(result.stdout, /^uploading=\d+ /);
  const n = line === null ? 0 : Number(token(line, 'uploading'));
  if (n === 1) ctx.print('✓ 1 past session is uploading in the background');
  if (n > 1) ctx.print(`✓ ${n} past sessions are uploading in the background`);
}

export function crashModeOf(text) {
  const line = lastLine(text, /^crash=/);
  return line === null ? null : token(line, 'crash');
}

// Crash reports on for an undecided machine; resolves whether they are on afterwards.
export async function applyDefaults(ctx) {
  const telemetry = await ctx.run('telemetry.mjs', ['default']);
  if (telemetry.code !== 0) report(ctx, telemetry);
  const keys = await ctx.run('settings.mjs', ['keys']);
  if (keys.code !== 0) report(ctx, keys);
  const mode = crashModeOf(keys.stdout);
  return mode !== null && mode !== 'off';
}

// Account, hooks, plan, tracking, upload, machine defaults, closing block; 1 when no account signed in.
export async function runSetup(ctx) {
  ctx.progress(MACHINE_LABEL);
  const usable = await usableAccounts(ctx);
  let account = usable.length > 0 ? usable[0] : null;
  // The sign-in installs the hooks itself; a reused account checks them here.
  const reused = account !== null;
  if (account === null) {
    const signedIn = await signIn(ctx);
    if (signedIn.key === null) return 1;
    const linked = (await usableAccounts(ctx)).filter((a) => a.key === signedIn.key);
    account = linked.length > 0 ? linked[0] : { key: signedIn.key, description: null };
  }
  ctx.print(await signedInLine(ctx, account));
  const hooksFailed = reused ? await checkHooks(ctx) : false;
  const pending = await trustPending(ctx);
  const plan = await capturePlan(ctx, account.key);
  if (plan !== null) ctx.print(`✓ Plan found: ${plan}`);
  ctx.progress(SESSIONS_LABEL);
  const tracking = await askTracking(ctx, account.key);
  if (tracking !== null && tracking.tracked) await uploadPast(ctx, account.key);
  if (tracking !== null) tracking.trailer.forEach((line) => ctx.print(line));
  ctx.progress(MACHINE_LABEL);
  const crash = await applyDefaults(ctx);
  closingLines({
    agent: AGENT,
    style: ctx.style,
    crash,
    trustPending: pending,
    hooksFailed,
    planFound: plan !== null,
    pastFailed: tracking !== null && tracking.failed === true,
  }).forEach((line) => ctx.print(line));
  return 0;
}
