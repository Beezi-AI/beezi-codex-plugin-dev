import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHATGPT_PLANS } from '../lib/billing.mjs';
import { parseLinkedAccounts, planSettled } from '../lib/setup-wizard.mjs';

const KEY = 'a1b2c3d4';
const OTHER = '99887766';
const LIST = [
  'Beezi: 3 accounts linked. The default is the account the analytics skill reads from.',
  `  1. Ann <ann@example.com> - Acme [${OTHER}]`,
  `  2. Bob [ops] <bob@example.com> - Beta [${KEY}]  (default)`,
  '  3. old@example.com [0badc0de]  (revoked)',
].join('\n');
const captured = (source, plan, via = ' via=app-server') => `✓ Beezi billing captured: source=${source} plan=${plan}${via}.`;

test('parseLinkedAccounts reads each row with its key and marks and skips every other line', () => {
  assert.deepEqual(parseLinkedAccounts(`Beezi: this machine's data moved.\n${LIST}\n`), [
    { description: 'Ann <ann@example.com> - Acme', key: OTHER, isDefault: false, revoked: false },
    { description: 'Bob [ops] <bob@example.com> - Beta', key: KEY, isDefault: true, revoked: false },
    { description: 'old@example.com', key: '0badc0de', isDefault: false, revoked: true },
  ]);
  assert.deepEqual(parseLinkedAccounts(`  1. Cy - Gamma [${KEY}]  (default, revoked)\r\n`), [
    { description: 'Cy - Gamma', key: KEY, isDefault: true, revoked: true },
  ]);
  assert.deepEqual(parseLinkedAccounts('No Beezi accounts are linked on this machine.\n'), []);
});

test('planSettled accepts a priced plan or a non-subscription source and nothing else', () => {
  for (const plan of CHATGPT_PLANS) assert.equal(planSettled(captured('subscription', plan)), true, plan);
  assert.equal(planSettled(captured('subscription', 'plus', '')), true);
  assert.equal(planSettled(captured('openai_api_key', 'n/a', ' via=auth-json')), true);
  assert.equal(planSettled(captured('third_party', 'n/a')), true);
  assert.equal(planSettled(captured('subscription', 'unknown')), false);
  assert.equal(planSettled(captured('unknown', 'n/a')), false);
  assert.equal(planSettled('Beezi: Codex named no ChatGPT account — nothing captured. Run `codex login` if you meant to be signed in.'), false);
  assert.equal(planSettled('Beezi: ChatGPT account info still does not name a plan — keeping the self-reported plan.'), false);
  assert.equal(planSettled(''), false);
});
