import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planBatches, BATCH_MAX_ITEMS, BATCH_MAX_BYTES } from '../lib/batch-plan.mjs';

const entry = (over = {}) => ({ tenantId: null, groupKey: null, bytes: 10, ...over });
const entries = (n, over = {}) => Array.from({ length: n }, () => entry(over));
const range = (from, to) => Array.from({ length: to - from }, (_, k) => from + k);

test('the default limits are 50 items and 4 MiB', () => {
  assert.equal(BATCH_MAX_ITEMS, 50);
  assert.equal(BATCH_MAX_BYTES, 4194304);
});

test('an empty queue plans no batch', () => {
  assert.deepEqual(planBatches([], { maxItems: 50, maxBytes: 4194304 }), []);
});

test('50 entries fit one batch', () => {
  assert.deepEqual(planBatches(entries(50), { maxItems: 50, maxBytes: 4194304 }), [range(0, 50)]);
});

test('the 51st entry opens a second batch', () => {
  assert.deepEqual(planBatches(entries(51), { maxItems: 50, maxBytes: 4194304 }), [range(0, 50), [50]]);
});

test('without limits it applies the defaults', () => {
  assert.deepEqual(planBatches(entries(51)), [range(0, 50), [50]]);
});

test('entries summing exactly to maxBytes share one batch', () => {
  const list = [entry({ bytes: 60 }), entry({ bytes: 40 })];
  assert.deepEqual(planBatches(list, { maxItems: 50, maxBytes: 100 }), [[0, 1]]);
});

test('one byte over maxBytes splits the batch', () => {
  const list = [entry({ bytes: 60 }), entry({ bytes: 41 })];
  assert.deepEqual(planBatches(list, { maxItems: 50, maxBytes: 100 }), [[0], [1]]);
});

test('an entry over maxBytes on its own travels alone, and the next entry starts a fresh batch', () => {
  const list = [entry({ bytes: 5 }), entry({ bytes: 150 }), entry({ bytes: 5 })];
  assert.deepEqual(planBatches(list, { maxItems: 50, maxBytes: 100 }), [[0], [1], [2]]);
});

test('a batch carries one tenant only', () => {
  const list = [
    entry({ tenantId: 'ta' }),
    entry({ tenantId: 'tb' }),
    entry({ tenantId: 'ta' }),
    entry({ tenantId: null }),
  ];
  assert.deepEqual(planBatches(list, { maxItems: 50, maxBytes: 4194304 }), [[0, 2], [1], [3]]);
});

test('a scope group moves to the next batch whole rather than split', () => {
  const list = [
    entry({ groupKey: 'a' }),
    entry({ groupKey: 'a' }),
    entry({ groupKey: 'b' }),
    entry({ groupKey: 'b' }),
  ];
  assert.deepEqual(planBatches(list, { maxItems: 3, maxBytes: 4194304 }), [[0, 1], [2, 3]]);
});

test('a scope group gathers its windows even when they are not adjacent', () => {
  const list = [entry({ groupKey: 'a' }), entry({ groupKey: 'b' }), entry({ groupKey: 'a' })];
  assert.deepEqual(planBatches(list, { maxItems: 2, maxBytes: 4194304 }), [[0, 2], [1]]);
});

test('the same groupKey under two tenants is two groups', () => {
  const list = [entry({ groupKey: 'a', tenantId: 'ta' }), entry({ groupKey: 'a', tenantId: 'tb' })];
  assert.deepEqual(planBatches(list, { maxItems: 50, maxBytes: 4194304 }), [[0], [1]]);
});

test('a scope group over maxItems on its own fills consecutive batches of its own', () => {
  const list = [
    entry({ groupKey: 'x' }),
    entry({ groupKey: 'a' }),
    entry({ groupKey: 'a' }),
    entry({ groupKey: 'a' }),
    entry({ groupKey: 'y' }),
  ];
  assert.deepEqual(planBatches(list, { maxItems: 2, maxBytes: 4194304 }), [[0], [1, 2], [3], [4]]);
});

test('a scope group over maxBytes on its own splits on the byte limit', () => {
  const list = [entry({ groupKey: 'a', bytes: 60 }), entry({ groupKey: 'a', bytes: 60 })];
  assert.deepEqual(planBatches(list, { maxItems: 50, maxBytes: 100 }), [[0], [1]]);
});
