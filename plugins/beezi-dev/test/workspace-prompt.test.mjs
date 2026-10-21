import '../tools/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildJoinedPrompt, buildWorkspacePrompt } from '../lib/workspace-prompt.mjs';
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
  const text = await buildJoinedPrompt({ session_id: 'session-1', source: 'startup' }, {
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
