import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { flushQueue } from '../lib/checkpoint.mjs';
import { queueDir } from '../lib/paths.mjs';
import { tmpHome as sandboxHome } from '../tools/suite-fixtures.mjs';
import { linkAccount, accountSession, TEST_KEY } from '../tools/account-fixtures.mjs';

const KEY = TEST_KEY;
const SESSION = accountSession(KEY, 'tok');

function tmpHome(t, files) {
  const dir = sandboxHome(t, 'beezi-throttle-');
  linkAccount(dir, KEY);
  fs.mkdirSync(queueDir(KEY), { recursive: true });
  for (let i = 0; i < files; i += 1) {
    fs.writeFileSync(path.join(queueDir(KEY), `seg-${i}.json`), JSON.stringify({ segmentId: `s:${i}` }));
  }
  return dir;
}

const replyWith = (status) => async () => ({ status, json: async () => ({ message: `m${status}` }) });
const left = () => fs.readdirSync(queueDir(KEY)).length;

const cases = [
  { status: 408, keeps: true, lastError: 'HTTP 408' },
  { status: 409, keeps: true, lastError: 'HTTP 409' },
  { status: 423, keeps: true, lastError: 'HTTP 423' },
  { status: 425, keeps: true, lastError: 'HTTP 425' },
  { status: 429, keeps: true, lastError: 'HTTP 429' },
  { status: 503, keeps: true, lastError: null },
  { status: 400, keeps: false, lastError: 'm400' },
  { status: 422, keeps: false, lastError: 'm422' },
];

for (const { status, keeps, lastError } of cases) {
  test(`HTTP ${status} ${keeps ? 'keeps' : 'deletes'} the queued report`, async (t) => {
    tmpHome(t, 1);
    const result = await flushQueue(KEY, SESSION, { fetchImpl: replyWith(status) });
    assert.equal(left(), keeps ? 1 : 0);
    assert.equal(result.rejected, keeps ? 0 : 1);
    assert.equal(result.failed, keeps ? 1 : 0);
    assert.equal(result.lastError, lastError);
  });
}

test('three consecutive network-class failures stop the drain and defer the rest', async (t) => {
  tmpHome(t, 5);
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { status: 503, json: async () => ({}) }; };
  const result = await flushQueue(KEY, SESSION, { fetchImpl });
  assert.equal(calls, 3);
  assert.equal(result.failed, 3);
  assert.equal(result.deferred, 2);
  assert.equal(left(), 5);
});

test('a thrown fetch counts toward the three-failure stop', async (t) => {
  tmpHome(t, 4);
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('ECONNRESET'); };
  const result = await flushQueue(KEY, SESSION, { fetchImpl });
  assert.equal(calls, 3);
  assert.equal(result.failed, 3);
  assert.equal(result.deferred, 1);
});

test('a success between failures resets the consecutive count', async (t) => {
  tmpHome(t, 6);
  const statuses = [503, 503, 200, 503, 503, 200];
  let i = 0;
  const fetchImpl = async () => ({ status: statuses[i++], json: async () => ({}) });
  const result = await flushQueue(KEY, SESSION, { fetchImpl });
  assert.equal(result.flushed, 2);
  assert.equal(result.failed, 4);
  assert.equal(result.deferred, 0);
});

test('a stalled error body cannot hold the drain past one second', async (t) => {
  tmpHome(t, 1);
  const fetchImpl = async () => ({ status: 422, json: () => new Promise(() => {}) });
  const started = Date.now();
  const result = await flushQueue(KEY, SESSION, { fetchImpl });
  assert.ok(Date.now() - started < 2500, 'body read must be bounded');
  assert.equal(result.rejected, 1);
  assert.equal(result.lastError, 'HTTP 422');
});

test('a stalled error body is cancelled when its read times out', async (t) => {
  tmpHome(t, 1);
  let cancels = 0;
  const body = { cancel: async () => { cancels += 1; } };
  const fetchImpl = async () => ({ status: 422, body, json: () => new Promise(() => {}) });
  const result = await flushQueue(KEY, SESSION, { fetchImpl });
  assert.equal(cancels, 1);
  assert.equal(result.lastError, 'HTTP 422');
});

test('a body cancel that throws does not break the drain', async (t) => {
  tmpHome(t, 1);
  const body = { cancel: () => { throw new Error('locked'); } };
  const fetchImpl = async () => ({ status: 422, body, json: () => new Promise(() => {}) });
  const result = await flushQueue(KEY, SESSION, { fetchImpl });
  assert.equal(result.rejected, 1);
  assert.equal(left(), 0);
});

test('a body read in time is not cancelled', async (t) => {
  tmpHome(t, 1);
  let cancels = 0;
  const body = { cancel: async () => { cancels += 1; } };
  const fetchImpl = async () => ({ status: 422, body, json: async () => ({ message: 'bad' }) });
  await flushQueue(KEY, SESSION, { fetchImpl });
  assert.equal(cancels, 0);
});
