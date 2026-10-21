import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PRODUCTION_API_ORIGIN } from '../lib/env-migration.mjs';
import { linkAccount, TEST_KEY } from './account-fixtures.mjs';

// A data root for a SPAWNED script, settled so its environment guard answers ok without migrating or
// printing: link-free (macOS's /var links to /private/var, and the guard refuses linked paths) and
// already bound to production. Pass it to the child as BEEZI_CODEX_HOME; this process's root is untouched.
export function settledHome(t, prefix = 'beezi-spawned-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'environment.json'), JSON.stringify({
    version: 1, root: dir, env: '', apiOrigin: PRODUCTION_API_ORIGIN, source: 'fresh', at: new Date().toISOString(),
  }));
  return dir;
}

// linkAccount for a spawned script: the account's credential record says it holds nothing, so the
// child's environment guard decides without reading the OS credential store.
export function linkWithoutCredential(home, key = TEST_KEY, over = {}) {
  const session = linkAccount(home, key, over);
  fs.writeFileSync(path.join(home, 'accounts', key, 'credential-control.json'),
    JSON.stringify({ version: 1, revision: 'test', backend: null }));
  return session;
}
