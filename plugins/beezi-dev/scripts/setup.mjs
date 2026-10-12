import path from 'path';
import url from 'url';
import { setupMain } from '../lib/setup-main.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';

// The installers' terminal setup: the login skill's steps, asked here instead of in a Codex thread.
setupMain(path.dirname(path.dirname(url.fileURLToPath(import.meta.url)))).then(
  (code) => process.exit(code),
  (error) => {
    console.error(`\n✗ ${friendlyMessage(error)}`);
    process.exit(1);
  },
);
