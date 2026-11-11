import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderQueueFiles, parseQueueName } from '../lib/queue-order.mjs';

const S1 = '11111111-1111-1111-1111-111111111111';
const S2 = '22222222-2222-2222-2222-222222222222';

const parseCases = [
  {
    name: 'a raw single-workspace payload',
    file: `${S1}_10-80.json`,
    want: { scope: S1, from: 10, to: 80, tenant: null },
  },
  {
    name: 'a subagent payload scoped by agent id',
    file: `${S1}_agent-7_1-5.json`,
    want: { scope: `${S1}_agent-7`, from: 1, to: 5, tenant: null },
  },
  {
    name: 'a raw name whose agent id mapped to a double underscore keeps no tenant',
    file: `${S1}_a__b_3-9.json`,
    want: { scope: `${S1}_a__b`, from: 3, to: 9, tenant: null },
  },
  {
    name: 'a multi-workspace envelope carries its tenant tag',
    file: `${S1}_10-80__t-uuid-1.qjson`,
    want: { scope: S1, from: 10, to: 80, tenant: 't-uuid-1' },
  },
  { name: 'a held Ask envelope is not a postable name', file: `${S1}_10-80__ask.qjson`, want: null },
  { name: 'a legacy held Ask file is not a postable name', file: `${S1}_10-80__ask.json`, want: null },
  { name: 'a temp file left by a hard kill', file: `${S1}_10-80.json.tmp`, want: null },
  { name: 'a quarantined file', file: `${S1}_10-80.json.corrupt`, want: null },
  { name: 'a name truncated past its range', file: `${S1}_agent-very-long-id.json`, want: null },
  { name: 'a non-string', file: null, want: null },
];

for (const c of parseCases) {
  test(`parseQueueName: ${c.name}`, () => {
    assert.deepEqual(parseQueueName(c.file), c.want);
  });
}

test('orders a scope by ascending end line, then descending start line', () => {
  const names = [
    `${S1}_10-120.json`,
    `${S1}_81-120.json`,
    `${S1}_10-80.json`,
    `${S1}_1-9.json`,
  ];
  assert.deepEqual(orderQueueFiles(names), [
    `${S1}_1-9.json`,
    `${S1}_10-80.json`,
    `${S1}_81-120.json`,
    `${S1}_10-120.json`,
  ]);
});

test('interleaves scopes round-robin so one busy session cannot starve another', () => {
  const names = [
    `${S1}_1-10.json`,
    `${S1}_11-20.json`,
    `${S1}_21-30.json`,
    `${S2}_1-4.json`,
    `${S1}_agent-1_1-2.json`,
  ];
  assert.deepEqual(orderQueueFiles(names), [
    `${S1}_agent-1_1-2.json`,
    `${S1}_1-10.json`,
    `${S2}_1-4.json`,
    `${S1}_11-20.json`,
    `${S1}_21-30.json`,
  ]);
});

test('each tenant copy of a scope is its own lane', () => {
  const names = [
    `${S1}_5-9__tb.qjson`,
    `${S1}_1-4__tb.qjson`,
    `${S1}_5-9__ta.qjson`,
    `${S1}_1-4__ta.qjson`,
  ];
  assert.deepEqual(orderQueueFiles(names), [
    `${S1}_1-4__ta.qjson`,
    `${S1}_1-4__tb.qjson`,
    `${S1}_5-9__ta.qjson`,
    `${S1}_5-9__tb.qjson`,
  ]);
});

test('held, temp, quarantined and unknown names go last in lexical order, never interleaved', () => {
  const names = [
    `${S1}_10-80__ask.qjson`,
    'zz-legacy.json',
    `${S1}_1-9.json`,
    `${S1}_1-9.json.tmp`,
    `${S1}_2-3__ask.json`,
    `${S1}_1-9.json.corrupt`,
  ];
  assert.deepEqual(orderQueueFiles(names), [
    `${S1}_1-9.json`,
    `${S1}_1-9.json.corrupt`,
    `${S1}_1-9.json.tmp`,
    `${S1}_10-80__ask.qjson`,
    `${S1}_2-3__ask.json`,
    'zz-legacy.json',
  ]);
});

test('leaves the input array untouched', () => {
  const names = [`${S1}_5-9.json`, `${S1}_1-4.json`];
  orderQueueFiles(names);
  assert.deepEqual(names, [`${S1}_5-9.json`, `${S1}_1-4.json`]);
});

test('an empty list orders to an empty list', () => {
  assert.deepEqual(orderQueueFiles([]), []);
});
