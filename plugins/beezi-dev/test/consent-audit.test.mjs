import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../lib/billing-capture.mjs';
import { LOCAL_TOOLS } from '../lib/mcp-bridge.mjs';
import { runPendingHistory } from '../lib/pending-history-run.mjs';

// PK5 and PK6 (decisions 2026-10-22): no typed account identifier is ever sent, and no history run uploads a session
// the developer did not say yes to, outside live tracking. The one upload without a yes is a workspace whose fresh
// answer (the run's own whoami) is `upload`, or the setup's consented run after the developer answered what to track.

const libDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib');
const readLib = (name) => fs.readFileSync(path.join(libDir, name), 'utf-8');

test('PK5: billing-capture takes no email or account flag', () => {
  assert.deepEqual(parseArgs(['--email', 'a@b.c']), {});
  assert.deepEqual(parseArgs(['--account-email', 'a@b.c', '--account', 'a@b.c']), {});
});

test('PK5: the check-in posts only checkInBody\'s output, hashed under accounts', () => {
  const src = readLib('account-sync.mjs');
  assert.ok(src.includes('const body = checkInBody(payload, session);'));
  assert.equal(src.split('postJson(').length - 1, 1, 'one post');
  assert.ok(src.includes('await postJson(`${apiBase()}${accountSyncPath()}`, session, body, postDeps);'));
});

test('PK5: the MCP bridge\'s own tools take no arguments, so no email', () => {
  assert.ok(LOCAL_TOOLS.length > 0);
  for (const tool of LOCAL_TOOLS) {
    assert.deepEqual(Object.keys(tool.inputSchema.properties), [], tool.name);
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
  }
  const schemas = readLib('mcp-bridge.mjs').match(/inputSchema: \{[^}]*\}[^}]*\}/g);
  assert.deepEqual(new Set(schemas), new Set(["inputSchema: { type: 'object', properties: {}, additionalProperties: false }"]));
});

const stripComments = (src) => src.split('\n')
  .map((line) => (/^\s*(\/\/|\/\*|\*)/.test(line) ? '' : line))
  .join('\n');

// Every `runAudit(` call in lib/, with its balanced argument text.
function runAuditCalls() {
  const calls = [];
  for (const name of fs.readdirSync(libDir).filter((n) => n.endsWith('.mjs'))) {
    const src = stripComments(readLib(name));
    let at = src.indexOf('runAudit(');
    while (at !== -1) {
      if (!src.slice(Math.max(0, at - 9), at).endsWith('function ')) {
        let depth = 0;
        let end = at + 'runAudit'.length;
        do {
          if (src[end] === '(') depth += 1;
          if (src[end] === ')') depth -= 1;
          end += 1;
        } while (depth > 0);
        calls.push({ name, text: src.slice(at, end).replace(/\s+/g, ' ') });
      }
      at = src.indexOf('runAudit(', at + 1);
    }
  }
  return calls;
}

// The option names it after its last spread, so no spread can override it.
const setsLast = (text, option) => text.indexOf(option) > text.lastIndexOf('...');

const AuditForm = Object.freeze({
  LIST_ONLY: 'listOnly',
  LIVE: 'live',
  CONSENTED: 'consented',
  FORWARDER: 'forwarder',
});

function formOf({ name, text }) {
  if (name === 'history-cli.mjs' && setsLast(text, 'listOnly: true')) return AuditForm.LIST_ONLY;
  if (name === 'rollout-watcher.mjs' && setsLast(text, 'scope: HistoryScope.LIVE')) return AuditForm.LIVE;
  if (name === 'pending-history-run.mjs' && text === 'runAudit({ runCache }, { ...options, key })') return AuditForm.CONSENTED;
  if (name === 'history-cli.mjs' && text === 'runAudit({ ...auditDeps, onProgress: printProgress }, auditOptions)') return AuditForm.FORWARDER;
  return null;
}

test('PK6: every runAudit call in lib/ lists only, runs LIVE, or uploads a consented entry\'s ids', () => {
  const calls = runAuditCalls();
  const forms = calls.map((call) => ({ ...call, form: formOf(call) }));
  assert.deepEqual(forms.filter((c) => c.form == null), [], 'an unclassified runAudit call');
  const count = (form) => forms.filter((c) => c.form === form).length;
  assert.deepEqual(
    { listOnly: count(AuditForm.LIST_ONLY), live: count(AuditForm.LIVE), consented: count(AuditForm.CONSENTED), forwarder: count(AuditForm.FORWARDER) },
    { listOnly: 1, live: 3, consented: 1, forwarder: 1 },
  );
});

test('PK6: the accept forwarder only hands its options to runPendingHistory', () => {
  const src = readLib('history-cli.mjs');
  assert.ok(src.includes('const runAudit = (auditDeps, auditOptions) => seam.runAudit({ ...auditDeps, onProgress: printProgress }, auditOptions);'));
  assert.ok(src.includes('  return { ...deps, runAudit };\n}'));
  assert.ok(src.includes('await seam.runPendingHistory(key, withProgress(seam, deps), { tenantIds: [tenantId], onResult });'));
});

// The `<fn>(` calls in lib/ that are not its definition, each with the file they are in.
function callsOf(fn) {
  const calls = [];
  for (const name of fs.readdirSync(libDir).filter((n) => n.endsWith('.mjs'))) {
    const src = stripComments(readLib(name));
    let at = src.indexOf(`${fn}(`);
    while (at !== -1) {
      // A longer name ending in `fn` is not a call of it.
      const named = at === 0 || !/[\w$]/.test(src[at - 1]);
      if (named && !src.slice(Math.max(0, at - 9), at).endsWith('function ')) calls.push({ name, at, src });
      at = src.indexOf(`${fn}(`, at + 1);
    }
  }
  return calls;
}

// The source of `async function <fn>(` in `src`, up to its closing brace at column 0.
const bodyOf = (src, fn) => {
  const start = src.indexOf(`async function ${fn}(`);
  return start === -1 ? '' : src.slice(start, src.indexOf('\n}\n', start));
};

test('PK6: owePastSessions, the owe without an offer, is called only by uploadNoAsk and the setup\'s consentedCommand', () => {
  const calls = callsOf('owePastSessions');
  assert.deepEqual(calls.map((c) => c.name), ['history-cli.mjs', 'history-cli.mjs']);
  assert.ok(bodyOf(calls[0].src, 'uploadNoAsk').includes('owePastSessions('));
  const consented = bodyOf(calls[0].src, 'consentedCommand');
  assert.ok(consented.includes('owePastSessions('));
  // It owes only from the answered listing record, and only the recorded ids among those routed there now.
  assert.ok(consented.includes('const listing = await takeAnsweredListing(row.key);\n  if (listing === null) return printUploading([], 0);'));
  assert.ok(consented.includes('const shownIds = offerIdsOf(listing.sessionIds);'));
  assert.ok(consented.includes('const listedIds = consentedIds(row, run.id, result.listed).filter((id) => shownIds.indexOf(id) !== -1);'));
  assert.ok(consented.includes('owePastSessions(row.key, run.id, listedIds, kinds, nowIso, changedAt)'));
  assert.ok(consented.indexOf('takeAnsweredListing(') < consented.indexOf('owePastSessions('));
});

// The name of the function declared last before `at` in `src`.
const enclosingFn = (src, at) => {
  const re = /(?:^|\n)(?:export )?(?:async )?function (\w+)\(/g;
  let name = null;
  let m = re.exec(src);
  while (m != null && m.index < at) {
    name = m[1];
    m = re.exec(src);
  }
  return name;
};

test('PK6: requestHistory is called only from owe, and owe only from acceptOffer and owePastSessions', () => {
  const where = (fn) => callsOf(fn).map((c) => `${c.name}:${enclosingFn(c.src, c.at)}`).sort();
  assert.deepEqual(where('requestHistory'), ['accounts.mjs:owe']);
  assert.deepEqual(where('owe'), ['accounts.mjs:acceptOffer', 'accounts.mjs:owePastSessions']);
});

test('PK6: uploadNoAsk gets only the no-ask offers, and nothing assigns noAsk', () => {
  for (const name of fs.readdirSync(libDir).filter((n) => n.endsWith('.mjs'))) {
    assert.ok(!/\.noAsk\s*=(?!=)/.test(stripComments(readLib(name))), name);
  }
  const calls = callsOf('uploadNoAsk');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].src.slice(calls[0].at, calls[0].at + 'uploadNoAsk(row, noAsk,'.length), 'uploadNoAsk(row, noAsk,');
  const body = bodyOf(calls[0].src, enclosingFn(calls[0].src, calls[0].at));
  assert.ok(body.includes('const noAsk = offers.filter((o) => o.noAsk);'));
  assert.equal(body.split('const noAsk =').length - 1, 1);
});

test('PK6: noAsk is set only from the run\'s own whoami answering upload', () => {
  const sets = [];
  for (const name of fs.readdirSync(libDir).filter((n) => n.endsWith('.mjs'))) {
    for (const line of stripComments(readLib(name)).split('\n')) if (line.includes('noAsk:')) sets.push(line.trim());
  }
  assert.deepEqual(sets.sort(), [
    'const entries = offers.map((o) => ({ name: o.name, n: o.summary.n, kinds: o.kinds, noAsk: o.noAsk }));',
    'noAsk: run.override !== true && !asksFirst(freshBlock, summary.audit) && !declined,',
  ].sort());
  const src = readLib('history-cli.mjs');
  assert.ok(src.includes('const freshBlock = fresh != null && fresh.valid === true ? anonymizationFor(fresh, run.id) : null;'));
  assert.ok(src.includes("fresh = who; return who;"));
});

test('PK6: every withProgress call is the second argument of seam.runPendingHistory', () => {
  const calls = callsOf('withProgress');
  assert.ok(calls.length >= 2);
  for (const { name, at, src } of calls) {
    assert.equal(name, 'history-cli.mjs');
    assert.match(src.slice(Math.max(0, at - 60), at), /seam\.runPendingHistory\([\w.]+, $/);
  }
});

test('PK6: a pending run uploads exactly each entry\'s accepted ids and drops entries without them', async () => {
  const row = {
    key: 'k1',
    status: 'linked',
    tenants: [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
    pendingHistory: [
      { tenantId: 'A', sessionIds: ['s1'] },
      { tenantId: 'B', sessionIds: ['s2'], override: true },
      { tenantId: 'C' },
      { tenantId: 'A', sessionIds: [] },
    ],
  };
  const audits = [];
  await runPendingHistory('k1', {
    accounts: {
      AccountStatus: { LINKED: 'linked' },
      listAccounts: async () => [row],
      notePendingAttempt: async () => {},
      settlePendingHistory: async () => 'cleared',
    },
    now: () => 0,
    planWorkspaceRuns: () => ({ tenantIds: ['A', 'C'], routes: new Map() }),
    runAudit: async (_deps, options) => { audits.push(options); return { ok: true, reason: null, halt: null, recent: [] }; },
    rolloutStartedAt: () => null,
  });
  assert.deepEqual(audits.map((o) => [o.tenantId, o.onlySessionIds]), [['A', ['s1']], ['B', ['s2']]]);
});
