import '../tools/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildHistoryNotice, buildJoinedPrompt, buildWorkspacePrompt } from '../lib/workspace-prompt.mjs';
import { createProgressWriter, markReported } from '../lib/upload-progress.mjs';
import { loadRepoMap, saveRepoMap, upsertRoot } from '../lib/repo-map.mjs';
import { tmpHome } from '../tools/suite-fixtures.mjs';

const KEY = 'a1b2c3d4';
const ROW = {
  key: KEY, status: 'linked', email: 'user@example.com',
  tenants: [{ id: 't1', name: 'Data HUB', role: 'owner' }, { id: 't2', name: 'Second tenant', role: 'admin' }],
};
const JOINED_ROW = {
  key: KEY, status: 'linked', email: 'u@example.com', linkedAt: '2026-10-01T00:00:00.000Z',
  tenants: [
    { id: 'A', name: 'Acme', joinedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'B', name: 'NewCo', joinedAt: '2026-10-10T00:00:00.000Z' },
  ],
};

// The answer's command reads the OS credential store (env guard) and writes outside the workspace.
// macOS Seatbelt blocks the first and every Codex sandbox the second, so a sandboxed run never
// succeeds: the hook has to ask for escalation BEFORE the run, not after a refusal the model may
// not recognise — which is how ~/Downloads failed with "Committed credentials could not be read".
test('the workspace ask tells the model to run its command escalated from the start', async (t) => {
  const home = tmpHome(t, 'workspace-prompt-');
  const cwd = path.join(home, 'Downloads');
  fs.mkdirSync(cwd);
  const text = await buildWorkspacePrompt({ session_id: 'session-1', cwd, source: 'startup' }, {
    pluginRoot: '/plugin',
    listAccounts: async () => [ROW],
    linkedSessions: async () => [{ key: KEY }],
  });
  assert.match(text, /scripts\/workspace\.mjs" rule add --current --session session-1 --account a1b2c3d4/);
  assert.match(text, /run it with escalated permissions from the start/);
  assert.doesNotMatch(text, /if the sandbox refuses it/);
});

// The inverted join re-pick asks per new workspace which repos send to it, mapped to `joined pick`;
// past request_user_input's caps the fallback is a numbered list of that one workspace's repos.
test('the joined prompt instructs joined pick and a per-workspace numbered repo list past the caps', async () => {
  const { context: text } = await buildJoinedPrompt({ session_id: 'session-1', source: 'startup' }, {
    pluginRoot: '/plugin',
    listAccounts: async () => [JOINED_ROW],
    linkedSessions: async () => [{ key: KEY }],
  });
  assert.match(text, /runs a `joined pick` command \(the `J<i>-command=` printed for that repo or folder, run unchanged except its final `<tenant>`, which becomes that workspace's `tenant=` id\)/);
  assert.doesNotMatch(text, /rule add/);
  assert.match(text, /one plain sentence \(for a repo pick, one that lists that workspace's repos and folders as a numbered list\)/);
});

// The session-start question names this session's own repo as the one you're in, and its last choice names it too.
test('the workspace question names the repo you are in and what not tracking it means', async (t) => {
  tmpHome(t, 'workspace-prompt-');
  const repo = '/work/labacus-suite';
  saveRepoMap(upsertRoot(loadRepoMap(), repo, 'https://github.com/acme/labacus-suite.git'));
  const text = await buildWorkspacePrompt({ session_id: 'session-1', cwd: repo, source: 'startup' }, {
    pluginRoot: '/plugin',
    listAccounts: async () => [ROW],
    linkedSessions: async () => [{ key: KEY }],
  });
  assert.ok(text.includes('"Where should analytics for labacus-suite, the repo you\'re in, go? Pick one, or name several under Other."'), text);
  assert.ok(text.includes('"Don\'t track labacus-suite" (description "Not tracked: nothing from labacus-suite is sent")'), text);
  assert.ok(text.includes('— one or more — or don\'t track labacus-suite?'), text);
});

// A mixed answer (through Other or the plain sentence) is re-asked once, not resolved as none.
test('a Don\'t track answer mixed with a workspace is asked again, never resolved as none', async (t) => {
  tmpHome(t, 'workspace-prompt-');
  const repo = '/work/labacus-suite';
  saveRepoMap(upsertRoot(loadRepoMap(), repo, 'https://github.com/acme/labacus-suite.git'));
  const text = await buildWorkspacePrompt({ session_id: 'session-1', cwd: repo, source: 'startup' }, {
    pluginRoot: '/plugin',
    listAccounts: async () => [ROW],
    linkedSessions: async () => [{ key: KEY }],
  });
  assert.ok(text.includes('or `none` only when "Don\'t track labacus-suite" is the whole answer.'), text);
  assert.ok(text.includes('starting with: `"Don\'t track" can\'t be combined with a workspace — pick one or the other.` A second'), text);
  assert.ok(text.includes('A second mixed answer counts as declining that question.'), text);
  assert.doesNotMatch(text, /wins over the others/);
});

test('the offer answer steps show the user the last line of the accept output, and keep the Upload now description', async () => {
  const { context: text } = await buildJoinedPrompt({ session_id: 'session-1', source: 'startup' }, {
    pluginRoot: '/plugin',
    listAccounts: async () => [JOINED_ROW],
    linkedSessions: async () => [{ key: KEY }],
  });
  assert.ok(text.includes('Show the user only the last line of the accept command\'s output, and nothing from the decline command.'), text);
  assert.ok(!text.includes('only the first line of the accept command'), text);
  assert.ok(text.includes('"Upload now" (description "Send these sessions now")'), text);
});

// A progress record per workspace; `reported` ones had their done line shown in a session.
function finishedRecord(tenantId, reported) {
  createProgressWriter({ key: KEY, tenantId, workspace: tenantId, now: () => 0 }).finish({ processed: 2, total: 2, sent: 2 });
  if (reported) markReported(KEY, tenantId);
}

const noticeDeps = (results) => ({
  listAccounts: async () => [{ ...JOINED_ROW, historyResults: results }],
  linkedSessions: async () => [{ key: KEY }],
  takeHistoryResults: async () => results,
});
const notice = (results) => buildHistoryNotice({ source: 'startup' }, noticeDeps(results));

test('the history notice skips a sent result whose done line was already shown, and keeps one that was not', async (t) => {
  tmpHome(t, 'workspace-prompt-');
  finishedRecord('A', true);
  finishedRecord('B', false);
  const text = await notice([
    { tenantId: 'A', status: 'sent', sent: 2, skipped: 0 },
    { tenantId: 'B', status: 'sent', sent: 2, skipped: 0 },
  ]);
  assert.equal(text, 'Beezi: sent 2 past sessions to NewCo.');
});

test('the history notice is empty when every sent result was already shown', async (t) => {
  tmpHome(t, 'workspace-prompt-');
  finishedRecord('B', true);
  assert.equal(await notice([{ tenantId: 'B', status: 'sent', sent: 2, skipped: 0 }]), null);
});

test('the history notice never hides a retrying or gave-up result, even beside a reported record', async (t) => {
  tmpHome(t, 'workspace-prompt-');
  finishedRecord('A', true);
  finishedRecord('B', true);
  const text = await notice([
    { tenantId: 'A', status: 'retrying', sent: 0, skipped: 0 },
    { tenantId: 'B', status: 'gave-up', sent: 0, skipped: 0 },
  ]);
  assert.equal(text, "Beezi: couldn't send history to Acme yet, will retry.\nBeezi: couldn't send history to NewCo. Run `$beezi:sync` to try again.");
});

test('the history notice keeps a sent result that has no progress record', async (t) => {
  tmpHome(t, 'workspace-prompt-');
  assert.equal(await notice([{ tenantId: 'B', status: 'sent', sent: 2, skipped: 0 }]), 'Beezi: sent 2 past sessions to NewCo.');
});
