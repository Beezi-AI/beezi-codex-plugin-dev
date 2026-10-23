import { friendlyMessage } from '../lib/friendly-error.mjs';
import { orDefault } from '../lib/compat.mjs';
import { cliMayProceed } from '../lib/env-guard.mjs';
import { fail } from '../lib/cli.mjs';
import { AccountStatus, getAccount, listAccounts, parseAccountFlag } from '../lib/accounts.mjs';
import { parseTenantFlags, resolveTenantRef } from '../lib/workspace.mjs';
import { workspaceIdOf } from '../lib/pending-history.mjs';
import { offerCommand, acceptCommand, declineCommand } from '../lib/history-cli.mjs';
import { CHANGED_LINE } from '../lib/history-offer.mjs';
import { syncReview } from '../lib/workspace-cli.mjs';

// The repeatable history repair pass (G-3-3 engine, G-9-3 surface).
//
// It asks Beezi how far each session already reaches and uploads only what is missing above that
// point, so it is safe to run as often as the user likes.
//
// It reaches back 30 days and no further: MAX_SESSION_AGE_MS in lib/session-audit.mjs.
//
// Nothing goes up without a yes. `--offer` (the default) lists what would be sent, prints the summary
// and its question, and records the shown sessions as declined until `--accept --account <key>
// --tenant <id> --token <token>` uploads exactly those (`--background` hands the upload to the history worker);
// `--decline` keeps them declined. `--past` is the session-start offer: past sessions only, skipping
// workspaces that chose skip, declined or settled. `--dry-run` prints the summary without its question and records nothing.
//
// The two refusals below are the mechanical enforcement of the flags it still does not take:
//
//   --since filters on the transcript's modification time, which says when a session last RAN, not
//   what Beezi is missing. It would silently exclude exactly the old half-uploaded session this
//   command exists to repair.
//
//   --force has no seal to force past: sync resumes each session from where Beezi already has it,
//   so accepting the flag would only advertise a bypass that does not exist.
//
// With no --account the offer repeats for EVERY linked account in turn. That is not wasteful
// duplication: /sessions/coverage answers for the account whose bearer asked, so a run for one
// account establishes nothing about what another is missing.
//
// An account in several workspaces repeats once per workspace its rules and New folders reach, for
// the same reason: each workspace answers coverage for itself. `--tenant <workspace[,…]>` (with
// --account when several accounts are linked) overrides that and offers those workspaces every past
// session, unrouted.
//
// `--review` is the sync skill's step 1 in the same call: the joined and routes listings first, and the offer only
// when neither needs an answer. `--review-routes` starts at the routes listing, after the joined questions.

const OFFER = '--offer';
const ACCEPT = '--accept';
const DECLINE = '--decline';
const TOKEN = '--token';
const MODES = [OFFER, ACCEPT, DECLINE];
const REVIEW_FLAGS = ['--review', '--review-routes'];
const FLAGS = MODES.concat(REVIEW_FLAGS, ['--past', '--background', '--dry-run']);

function parseSyncArgs(argv) {
  for (const flag of argv) {
    if (flag === '--since') {
      fail(
        'Beezi: sync takes no --since. It uploads exactly what Beezi is missing from the last 30 '
        + 'days, wherever in that window those sessions ran. Run it with no flags.',
      );
    }
    if (flag === '--force') {
      fail(
        'Beezi: sync takes no --force. There is no one-time seal to force past — sync resumes each '
        + 'session from where Beezi already has it. Run it with no flags.',
      );
    }
  }
  const modes = argv.filter((arg) => MODES.indexOf(arg) !== -1);
  if (modes.length > 1) fail('Beezi: pass one of --offer, --accept or --decline.');
  const mode = modes.length === 0 ? OFFER : modes[0];
  const has = (flag) => argv.indexOf(flag) !== -1;
  if (has('--dry-run') && mode !== OFFER) fail(`Beezi: --dry-run previews the offer only; it does not go with ${mode}.`);
  if (has('--background') && mode !== ACCEPT) fail(`Beezi: --background goes only with --accept, not with ${mode}.`);
  if (has(TOKEN) && mode !== ACCEPT) fail(`Beezi: --token goes only with --accept, not with ${mode}.`);
  const at = argv.indexOf(TOKEN);
  const token = at === -1 || argv[at + 1] == null ? null : argv[at + 1];
  return { mode, past: has('--past'), background: has('--background'), dryRun: has('--dry-run'), token };
}

// argv without the --token pair.
function withoutToken(argv) {
  const at = argv.indexOf(TOKEN);
  return at === -1 ? argv : argv.slice(0, at).concat(argv.slice(at + 2));
}

// The review flag passed, or null.
function reviewFlagOf(argv) {
  const flags = argv.filter((arg) => REVIEW_FLAGS.indexOf(arg) !== -1);
  if (flags.length > 1) fail('Beezi: pass --review or --review-routes, not both.');
  return flags.length === 0 ? null : flags[0];
}

// The --tenant override's workspace ids, read against the named account, else the only linked one.
async function overrideIds(account, rest) {
  if (rest.indexOf('--tenant') === -1) return [];
  if (account !== null) return parseTenantFlags(rest, orDefault(await getAccount(account), { key: account })).tenantIds;
  const linked = (await listAccounts()).filter((a) => a.status === AccountStatus.LINKED);
  // A workspace name means nothing without the account it belongs to.
  if (linked.length > 1) fail('Beezi: --tenant needs --account <account> when several accounts are linked.');
  return parseTenantFlags(rest, linked.length === 1 ? linked[0] : { key: null }).tenantIds;
}

// Accept or decline one shown offer: the account and the workspace id its `offer` line named. → exit status.
async function answer({ mode, background, token }, account, rest) {
  const row = account === null ? null : await getAccount(account);
  const at = rest.indexOf('--tenant');
  if (row == null || at === -1 || rest[at + 1] == null) {
    fail('Beezi: --accept and --decline need --account <account> and --tenant <workspace>.');
  }
  const ref = rest[at + 1];
  // An older portal lists no workspaces, so its one workspace id is matched before resolving.
  const tenantId = ref === workspaceIdOf(row) ? ref : resolveTenantRef(row, ref);
  return mode === ACCEPT
    ? acceptCommand({ key: row.key, tenantId, token, background })
    : declineCommand({ key: row.key, tenantId });
}

async function main() {
  if (!cliMayProceed()) { process.exitCode = 1; return; }
  const argv = process.argv.slice(2);
  // The --since and --force refusals run first, before anything is read, including the accounts index.
  const flags = parseSyncArgs(argv);
  // An accept without the question's token cannot name what was shown, so it uploads nothing.
  if (flags.mode === ACCEPT && flags.token === null) {
    console.error(CHANGED_LINE);
    process.exitCode = 1;
    return;
  }
  const reviewFlag = reviewFlagOf(argv);
  const { account, rest } = await parseAccountFlag(withoutToken(argv).filter((arg) => FLAGS.indexOf(arg) === -1));
  if (flags.mode !== OFFER) {
    process.exitCode = await answer(flags, account, rest);
    return;
  }
  if (reviewFlag !== null) {
    const listed = await syncReview(reviewFlag === '--review-routes', account);
    for (const line of listed.lines) console.log(line);
    // Something to ask: the skill asks, then runs the next step itself.
    if (listed.review > 0) return;
  }
  const tenantIds = await overrideIds(account, rest);
  const { status } = await offerCommand({ key: account, past: flags.past, tenantIds, dryRun: flags.dryRun });
  if (status !== 0) process.exitCode = status;
}

main().catch((error) => fail(friendlyMessage(error)));
