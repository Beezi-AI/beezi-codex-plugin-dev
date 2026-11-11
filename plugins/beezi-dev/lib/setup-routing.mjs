import { SETTINGS_SKILL } from './setup-finale.mjs';

const LABEL_END = /\), \d+ sessions?\b/;
const PLAIN_PLACE = /^(.*?), \d+ sessions?\b/;
const SESSIONS = /, (\d+) sessions?$/;
const NO_FOLDER = /^\d+ other past sessions? ha(?:s|ve) no recorded folder and (?:is|are) not sent\.$/;
const CHECKLIST_OPEN = '<checklist>';
const CHECKLIST_CLOSE = '</checklist>';
const MACHINE_LINES = [/^[\w-]+=/, /^[A-Z]\d*\. .* account=/, /-command=/, /^\s*[{[]/, /^<\/?checklist>$/];
const STOPPED = '✗ That step stopped unexpectedly.';
const NOT_TRACKED = 'none';
const NO_RULE = 'default';
// Writes start no upload: the consented upload runs once, after the last write.
const DEFER = '--defer-upload';
// The last line each write prints when it succeeded.
const RULE_DONE = /^rule=\d+$/;
export const EVERYTHING_DONE = /^setup=everything$/;
const CHOSEN_DONE = /^setup=chosen$/;

export function outputLines(text) {
  return String(text || '').split(/\r?\n/);
}

export function lastLine(text, pattern) {
  const matches = outputLines(text).filter((line) => pattern.test(line));
  return matches.length ? matches[matches.length - 1] : null;
}

// Value of the space-free `name=` field; null when the line has none.
export function token(line, name) {
  const found = new RegExp(`(?:^| )${name}=(\\S*)`).exec(line);
  return found ? found[1] : null;
}

function printable(text) {
  return outputLines(text).map((line) => line.trimEnd()).filter((line) => line !== '');
}

export function report(ctx, result) {
  if (result.code === 0) {
    const lines = printable(result.stdout);
    if (lines.length) ctx.print(lines[0]);
    return;
  }
  if (result.stderr.trim() !== '') {
    printable(result.stderr).forEach((line) => ctx.print(line));
    return;
  }
  const human = printable(result.stdout).filter((line) => !MACHINE_LINES.some((pattern) => pattern.test(line)));
  if (human.length === 0) human.push(STOPPED);
  human.forEach((line) => ctx.print(line));
}

function parseWorkspaces(text) {
  return outputLines(text).filter((line) => /^W\. /.test(line)).map((line) => {
    const at = line.indexOf(' account=');
    return { name: line.slice(3, at), tenant: token(line.slice(at), 'tenant') };
  });
}

// Splits "<short> (<label>), <k> sessions" by walking back from the label's closing parenthesis.
function describePlace(body) {
  const end = body.search(LABEL_END);
  if (end !== -1) {
    let depth = 0;
    for (let i = end; i >= 0; i -= 1) {
      if (body[i] === ')') depth += 1;
      if (body[i] === '(') depth -= 1;
      if (depth === 0) return { short: body.slice(0, i).replace(/ $/, ''), label: body.slice(i + 1, end) };
    }
  }
  const plain = PLAIN_PLACE.exec(body);
  return { short: plain ? plain[1] : body, label: null };
}

// The listing's T lines; match runs to the line's end, and the fields before it are read from before it.
function parsePlaces(text) {
  return outputLines(text).filter((line) => /^T\d+\. /.test(line)).map((line) => {
    const at = line.indexOf(' account=');
    const fields = line.slice(at);
    const body = line.slice(0, at).replace(/^T\d+\. /, '');
    const matchAt = fields.indexOf(' match=');
    const head = fields.slice(0, matchAt);
    const place = describePlace(body);
    const sessions = SESSIONS.exec(body);
    return {
      kind: token(head, 'kind'),
      match: fields.slice(matchAt + ' match='.length),
      now: token(head, 'now'),
      name: place.label !== null ? place.label : place.short,
      sessions: sessions ? Number(sessions[1]) : 0,
    };
  });
}

// `workspace.mjs setup` output: the checklist, workspaces, places, the no-folder sentence and the last setup= line.
export function parseListing(text) {
  const lines = outputLines(text);
  const open = lines.indexOf(CHECKLIST_OPEN);
  const close = lines.indexOf(CHECKLIST_CLOSE);
  const last = lastLine(text, /^setup=/);
  return {
    checklist: open !== -1 && close > open ? lines.slice(open + 1, close) : [],
    workspaces: parseWorkspaces(text),
    places: parsePlaces(text),
    noFolder: lastLine(text, NO_FOLDER),
    workspaceCount: last === null ? 0 : Number(token(last, 'workspaces')),
    chosen: last !== null && token(last, 'chosen') === 'yes',
  };
}

export function ruleArgv(place, key, tenants) {
  const target = place.kind === 'outside' ? ['--outside'] : [`--${place.kind}`, place.match];
  return ['rule', 'add'].concat(target, ['--account', key, tenants, DEFER]);
}

// A write succeeded: exit 0 and `done` as its last line; else its failure is shown.
export function wrote(ctx, result, done) {
  const lines = printable(result.stdout);
  if (result.code === 0 && lines.length > 0 && done.test(lines[lines.length - 1])) return true;
  report(ctx, { code: 1, stdout: result.stdout, stderr: result.stderr });
  return false;
}

async function write(ctx, argv, done) {
  return wrote(ctx, await ctx.run('workspace.mjs', argv), done);
}

function everything(ctx, key, tenants) {
  return write(ctx, ['setup', 'everything', '--account', key, DEFER].concat(tenants), EVERYTHING_DONE);
}

function letMeChoose(ctx, key) {
  return write(ctx, ['setup', 'chosen', '--account', key, DEFER], CHOSEN_DONE);
}

// What a failed write leaves: nothing tracked, no tracking line, no upload.
const STOPPED_WRITES = { tracked: false, trailer: [] };

function names(list) {
  return list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

function trackingLine(tracked, total, suffix) {
  const count = tracked === total ? `all ${total}` : `${tracked} of ${total}`;
  return `✓ Tracking ${count} repos and folders${suffix}`;
}

function askedLine(ctx) {
  return `  ${ctx.style.dim('New repos: Beezi asks the first time you work in one.')}`;
}

function notTracked(ctx, places) {
  if (places.length > 0) ctx.print(`  ${ctx.style.dim(`Not tracked: ${places.map((p) => p.name).join(', ')}`)}`);
}

// Whether a list starts with a place ticked: "Don't track" never, a ruled place for its workspaces, else when no earlier list ticked it.
function startsTicked(place, tenant, earlier) {
  if (place.now === NOT_TRACKED) return false;
  if (place.now === NO_RULE) return earlier === 0;
  return place.now.split(',').indexOf(tenant) !== -1;
}

function sameTargets(now, target) {
  return now.split(',').sort().join(',') === target.split(',').sort().join(',');
}

// One rule write per place whose routing changes, stopping at the first that fails; resolves whether all succeeded.
async function writeRules(ctx, key, places, targets) {
  for (let i = 0; i < places.length; i += 1) {
    if (!sameTargets(places[i].now, targets[i]) && !(await write(ctx, ruleArgv(places[i], key, targets[i]), RULE_DONE))) return false;
  }
  return true;
}

function tickOptions(places) {
  const digits = String(Math.max(...places.map((p) => p.sessions))).length;
  return places.map((p) => ({ label: p.name, description: `${String(p.sessions).padStart(digits)} session${p.sessions === 1 ? '' : 's'}` }));
}

// Everything: existing rules stay, so a "Don't track" place is still left out.
async function trackEverything(ctx, key, listing, chosen) {
  const tracked = listing.places.filter((p) => p.now !== NOT_TRACKED);
  if (!(await everything(ctx, key, listing.workspaceCount > 1 ? [chosen.map((w) => w.tenant).join(',')] : []))) return STOPPED_WRITES;
  const suffix = listing.workspaceCount > 1 ? ` in ${ctx.style.bold(names(chosen.map((w) => w.name)))}` : '';
  ctx.print(trackingLine(tracked.length, listing.places.length, suffix));
  notTracked(ctx, listing.places.filter((p) => p.now === NOT_TRACKED));
  return { tracked: tracked.length > 0, trailer: [] };
}

// One workspace: a "Don't track" place is not offered and stays out; an unticked place gets a "Don't track" rule.
async function chooseOne(ctx, key, listing) {
  const places = listing.places;
  const offered = places.filter((p) => p.now !== NOT_TRACKED);
  const tenant = listing.workspaces[0].tenant;
  const preselected = offered.map((p, i) => i).filter((i) => startsTicked(offered[i], tenant, 0));
  const picked = await ctx.ask.chooseMany('Which repos and folders should Beezi track?', tickOptions(offered), { preselected });
  if (picked === null) return null;
  const targets = offered.map((p, i) => (picked.indexOf(i) === -1 ? NOT_TRACKED : p.now));
  if (!(await writeRules(ctx, key, offered, targets)) || !(await letMeChoose(ctx, key))) return STOPPED_WRITES;
  const tracked = offered.filter((p, i) => picked.indexOf(i) !== -1);
  if (tracked.length === 0) {
    ctx.print(`– Nothing is tracked yet. ${SETTINGS_SKILL} adds repos and folders.`);
    return { tracked: false, trailer: [] };
  }
  ctx.print(trackingLine(tracked.length, places.length, ''));
  notTracked(ctx, places.filter((p) => tracked.indexOf(p) === -1));
  return { tracked: true, trailer: [`  ${ctx.style.dim(`New repos are tracked. Leave one out in ${SETTINGS_SKILL}.`)}`] };
}

// One tick list per workspace; nothing is written until the last list is answered.
async function chooseSeveral(ctx, key, listing) {
  const places = listing.places;
  const ticks = places.map(() => []);
  for (const w of listing.workspaces) {
    const preselected = places.map((p, i) => i).filter((i) => startsTicked(places[i], w.tenant, ticks[i].length));
    const picked = await ctx.ask.chooseMany(`Which repos and folders go to ${w.name}?`, tickOptions(places), { preselected });
    if (picked === null) return null;
    picked.forEach((i) => { ticks[i].push(w.tenant); });
    ctx.print(picked.length > 0 ? `✓ ${ctx.style.bold(w.name)} gets ${picked.length} of ${places.length} repos and folders` : `– Nothing goes to ${w.name}.`);
  }
  const targets = ticks.map((t) => (t.length > 0 ? t.join(',') : NOT_TRACKED));
  if (!(await writeRules(ctx, key, places, targets)) || !(await letMeChoose(ctx, key))) return STOPPED_WRITES;
  notTracked(ctx, places.filter((p, i) => ticks[i].length === 0));
  return { tracked: ticks.some((t) => t.length > 0), trailer: [askedLine(ctx)] };
}

// "Everything to <name>" per workspace, then one for all of them.
function everythingOptions(workspaces) {
  const all = workspaces.length === 2 ? 'Everything to both' : `Everything to all ${workspaces.length}`;
  return workspaces.map((w) => ({ label: `Everything to ${w.name}` })).concat([{ label: all }]);
}

// The workspaces an Everything row picked.
function everythingTargets(workspaces, choice) {
  return choice < workspaces.length ? [workspaces[choice]] : workspaces;
}

// The checklist and the no-folder sentence: shown above the question, coloured by the printer, and folded away with it.
function checklistLead(listing) {
  return listing.checklist.concat(listing.noFolder === null ? [] : [listing.noFolder]);
}

// Several workspaces and no past sessions: where new repos go, or ask for each.
async function askNoPlaces(ctx, key, listing) {
  const options = everythingOptions(listing.workspaces).concat([{ label: 'Ask me for each repo' }]);
  const choice = await ctx.ask.choose("Where should this machine's analytics go?", options, { lead: checklistLead(listing) });
  if (choice === null) return;
  if (choice === options.length - 1) {
    if (await letMeChoose(ctx, key)) ctx.print(askedLine(ctx));
    return;
  }
  if (await everything(ctx, key, [everythingTargets(listing.workspaces, choice).map((w) => w.tenant).join(',')])) {
    ctx.print('✓ Tracking every repo and folder you work in');
  }
}

async function askPlaces(ctx, key, listing) {
  const several = listing.workspaceCount > 1;
  const options = several
    ? everythingOptions(listing.workspaces).concat([{ label: 'Let me choose', description: 'tick repos for each workspace' }])
    : [
      { label: 'Everything', description: `all ${listing.places.length}, and new ones as you open them` },
      { label: 'Let me choose', description: 'tick the repos and folders' },
    ];
  const question = several ? 'Where should they go?' : 'What should it track?';
  const choice = await ctx.ask.choose(question, options, { lead: checklistLead(listing) });
  if (choice === null) return null;
  if (choice < options.length - 1) return trackEverything(ctx, key, listing, everythingTargets(listing.workspaces, choice));
  return several ? chooseSeveral(ctx, key, listing) : chooseOne(ctx, key, listing);
}

// The tracking question from `workspace.mjs setup`; { tracked, trailer }, with failed when the listing failed, or null.
export async function askTracking(ctx, key) {
  const result = await ctx.run('workspace.mjs', ['setup', '--account', key]);
  if (result.code !== 0) {
    report(ctx, result);
    return { tracked: false, trailer: [], failed: true };
  }
  const listing = parseListing(result.stdout);
  if (listing.workspaceCount === 0) return null;
  if (listing.chosen) {
    ctx.print(`✓ Tracking is already set up (${SETTINGS_SKILL})`);
    return null;
  }
  if (listing.places.length > 0) return askPlaces(ctx, key, listing);
  if (listing.workspaceCount > 1) {
    await askNoPlaces(ctx, key, listing);
    return null;
  }
  if (await everything(ctx, key, [])) ctx.print('✓ Tracking every repo and folder you work in');
  return null;
}
