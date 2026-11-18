import '../tools/hermetic-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  progressPath, createProgressWriter, readProgress, isLive, markReported,
} from '../lib/upload-progress.mjs';
import { makeHome } from '../tools/account-fixtures.mjs';

const K = 'a1b2c3d4';

const T0 = Date.parse('2026-11-18T10:00:00.000Z');
const clock = (start = T0) => {
  let t = start;
  const now = () => t;
  now.set = (v) => { t = v; };
  return now;
};
const readFile = (home, name) => JSON.parse(fs.readFileSync(path.join(home, 'state', 'upload-progress', name), 'utf-8'));
const writeRecord = (key, tenantId, now = clock()) => {
  const writer = createProgressWriter({ key, tenantId, workspace: 'Acme', now });
  writer.finish({ processed: 3, total: 3, sent: 3 });
};

test('the record path is upload-progress/<key>-<tenant>.json under the state dir', (t) => {
  const home = makeHome(t, 'upload-progress-');
  assert.equal(progressPath(K, 'A'), path.join(home, 'state', 'upload-progress', 'a1b2c3d4-A.json'));
});

test('the first update writes the whole record with startedAt and no finishedAt', (t) => {
  const home = makeHome(t, 'upload-progress-');
  createProgressWriter({ key: K, tenantId: 'A', workspace: 'Acme', now: clock() })
    .update({ processed: 30, total: 100, sent: 28 });
  assert.deepEqual(readFile(home, 'a1b2c3d4-A.json'), {
    key: K,
    tenantId: 'A',
    workspace: 'Acme',
    processed: 30,
    total: 100,
    sent: 28,
    startedAt: '2026-11-18T10:00:00.000Z',
    updatedAt: '2026-11-18T10:00:00.000Z',
    finishedAt: null,
    reported: false,
  });
});

test('updates within a second of the last write are skipped, and one a second later is written', (t) => {
  const home = makeHome(t, 'upload-progress-');
  const now = clock();
  const writer = createProgressWriter({ key: K, tenantId: 'A', workspace: 'Acme', now });
  writer.update({ processed: 1, total: 10, sent: 1 });
  now.set(T0 + 500);
  writer.update({ processed: 2, total: 10, sent: 2 });
  now.set(T0 + 999);
  writer.update({ processed: 3, total: 10, sent: 3 });
  assert.equal(readFile(home, 'a1b2c3d4-A.json').processed, 1);
  now.set(T0 + 1000);
  writer.update({ processed: 4, total: 10, sent: 4 });
  const record = readFile(home, 'a1b2c3d4-A.json');
  assert.equal(record.processed, 4);
  assert.equal(record.updatedAt, '2026-11-18T10:00:01.000Z');
  assert.equal(record.startedAt, '2026-11-18T10:00:00.000Z');
});

test('finish writes finishedAt and the final counts even inside the throttle window', (t) => {
  const home = makeHome(t, 'upload-progress-');
  const now = clock();
  const writer = createProgressWriter({ key: K, tenantId: 'A', workspace: 'Acme', now });
  writer.update({ processed: 1, total: 3, sent: 1 });
  now.set(T0 + 200);
  writer.finish({ processed: 3, total: 3, sent: 2 });
  const record = readFile(home, 'a1b2c3d4-A.json');
  assert.equal(record.finishedAt, '2026-11-18T10:00:00.200Z');
  assert.equal(record.processed, 3);
  assert.equal(record.total, 3);
  assert.equal(record.sent, 2);
  assert.equal(record.startedAt, '2026-11-18T10:00:00.000Z');
});

test('readProgress returns the record written for that workspace', (t) => {
  makeHome(t, 'upload-progress-');
  writeRecord(K, 'A');
  assert.equal(readProgress(K, 'A').sent, 3);
});

test('readProgress returns null when the file is missing', (t) => {
  makeHome(t, 'upload-progress-');
  assert.equal(readProgress(K, 'A'), null);
});

test('readProgress returns null when the file is malformed', (t) => {
  makeHome(t, 'upload-progress-');
  fs.mkdirSync(path.dirname(progressPath(K, 'A')), { recursive: true });
  fs.writeFileSync(progressPath(K, 'A'), '{"key":');
  assert.equal(readProgress(K, 'A'), null);
});

test('readProgress returns null when the file holds JSON that is not an object', (t) => {
  makeHome(t, 'upload-progress-');
  fs.mkdirSync(path.dirname(progressPath(K, 'A')), { recursive: true });
  fs.writeFileSync(progressPath(K, 'A'), '42');
  assert.equal(readProgress(K, 'A'), null);
});

test('a running record is live up to 120000 ms after its last update', () => {
  const record = { finishedAt: null, updatedAt: '2026-11-18T10:00:00.000Z' };
  assert.equal(isLive(record, T0 + 120000), true);
});

test('a running record is not live 120001 ms after its last update', () => {
  const record = { finishedAt: null, updatedAt: '2026-11-18T10:00:00.000Z' };
  assert.equal(isLive(record, T0 + 120001), false);
});

test('a finished record is not live', () => {
  const record = { finishedAt: '2026-11-18T10:00:00.000Z', updatedAt: '2026-11-18T10:00:00.000Z' };
  assert.equal(isLive(record, T0), false);
});

test('a missing record is not live', () => {
  assert.equal(isLive(null, T0), false);
});

test('markReported sets reported on that workspace only', (t) => {
  const home = makeHome(t, 'upload-progress-');
  writeRecord(K, 'A');
  writeRecord(K, 'B');
  markReported(K, 'A');
  assert.equal(readFile(home, 'a1b2c3d4-A.json').reported, true);
  assert.equal(readFile(home, 'a1b2c3d4-A.json').sent, 3);
  assert.equal(readFile(home, 'a1b2c3d4-B.json').reported, false);
});

test('markReported leaves a missing record missing', (t) => {
  makeHome(t, 'upload-progress-');
  markReported(K, 'A');
  assert.equal(fs.existsSync(progressPath(K, 'A')), false);
});

test('readProgress returns null for a key that is not an account key, without throwing', (t) => {
  makeHome(t, 'upload-progress-');
  assert.equal(readProgress('k1', 'A'), null);
});

test('markReported with a key that is not an account key writes nothing and never throws', (t) => {
  const home = makeHome(t, 'upload-progress-');
  markReported('k1', 'A');
  assert.equal(fs.existsSync(path.join(home, 'state', 'upload-progress')), false);
});

test('the record path refuses a key that is not an account key', () => {
  assert.throws(() => progressPath('../accounts', 'A'), /invalid Beezi account key/);
});

test('a tenant id with path characters stays inside the progress folder', (t) => {
  const home = makeHome(t, 'upload-progress-');
  assert.equal(
    progressPath(K, '/../../../accounts/a1b2c3d4/credentials'),
    path.join(home, 'state', 'upload-progress', 'a1b2c3d4-__________accounts_a1b2c3d4_credentials.json'),
  );
});

test('markReported with a crafted tenant id writes nothing outside the progress folder', (t) => {
  const home = makeHome(t, 'upload-progress-');
  const crafted = '/../../../accounts/a1b2c3d4/credentials';
  fs.mkdirSync(path.join(home, 'accounts', K), { recursive: true });
  fs.writeFileSync(path.join(home, 'accounts', K, 'credentials.json'), '{"token":"x"}');
  writeRecord(K, crafted);
  markReported(K, crafted);
  assert.equal(fs.readFileSync(path.join(home, 'accounts', K, 'credentials.json'), 'utf-8'), '{"token":"x"}');
  assert.equal(readFile(home, 'a1b2c3d4-__________accounts_a1b2c3d4_credentials.json').reported, true);
});

test('a writer with a bad key writes nothing and never throws', (t) => {
  const home = makeHome(t, 'upload-progress-');
  const writer = createProgressWriter({ key: 'nope', tenantId: 'A', workspace: 'Acme', now: clock() });
  writer.update({ processed: 1, total: 2, sent: 1 });
  writer.finish({ processed: 2, total: 2, sent: 2 }, true);
  assert.equal(fs.existsSync(path.join(home, 'state', 'upload-progress')), false);
});

test('finish of a run that did not end clean writes failed: true', (t) => {
  const home = makeHome(t, 'upload-progress-');
  createProgressWriter({ key: K, tenantId: 'A', workspace: 'Acme', now: clock() }).finish({ processed: 1, total: 40, sent: 1 }, true);
  assert.deepEqual(readFile(home, 'a1b2c3d4-A.json'), {
    key: 'a1b2c3d4',
    tenantId: 'A',
    workspace: 'Acme',
    processed: 1,
    total: 40,
    sent: 1,
    startedAt: '2026-11-18T10:00:00.000Z',
    updatedAt: '2026-11-18T10:00:00.000Z',
    finishedAt: '2026-11-18T10:00:00.000Z',
    reported: false,
    failed: true,
  });
});

test('finish of a clean run writes no failed field', (t) => {
  const home = makeHome(t, 'upload-progress-');
  createProgressWriter({ key: K, tenantId: 'A', workspace: 'Acme', now: clock() }).finish({ processed: 3, total: 3, sent: 3 });
  assert.equal('failed' in readFile(home, 'a1b2c3d4-A.json'), false);
});
