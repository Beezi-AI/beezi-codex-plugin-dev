import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('sync.mjs starts no history worker: past sessions go up only after a yes', () => {
  assert.ok(!source('scripts/sync.mjs').includes('startHistoryWorker'), 'scripts/sync.mjs must not start the history worker');
});

test('history-worker.mjs runs the offer scan with --offer and the accepted uploads without it', () => {
  const text = source('scripts/history-worker.mjs');
  assert.ok(text.includes("import { scanOffers } from '../lib/history-cli.mjs';"));
  assert.ok(text.includes("process.argv.indexOf('--offer') === -1 ? runPendingHistoryPatiently : scanOffers"));
});
