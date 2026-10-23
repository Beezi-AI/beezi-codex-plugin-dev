import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../lib/billing-capture.mjs';
import { LOCAL_TOOLS } from '../lib/mcp-bridge.mjs';
import { runPendingHistory } from '../lib/pending-history-run.mjs';

// PK5 and PK6 (decisions 2026-10-22): no typed account identifier is ever sent, and no history run uploads a session
// the developer did not say yes to, outside live tracking.

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
  assert.ok(src.includes('await seam.runPendingHistory(key, { ...deps, runAudit }, { tenantIds: [tenantId], onResult });'));
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
