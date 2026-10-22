import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// "Don't track" and "None of these" stand alone: every agent surface re-asks an answer that mixes one with other picks.

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => fs.readFileSync(path.join(pluginRoot, ...parts), 'utf-8');
const flat = (text) => text.replace(/\s+/g, ' ');

const LEAD = '"Don\'t track" can\'t be combined with a workspace — pick one or the other.';
const NONE_LEAD = '"None of these" can\'t be combined with repos — pick one or the other.';
const WINS = /wins over the others|\(it wins\)|alone or with other choices, wins/;
const SURFACES = [['skills', 'login', 'SKILL.md'], ['skills', 'sync', 'SKILL.md'], ['skills', 'settings', 'SKILL.md'], ['skills', 'track', 'SKILL.md'], ['lib', 'workspace-prompt.mjs']];
const count = (text, s) => flat(text).split(s).length - 1;

test('no agent surface lets an exclusive choice win over the others', () => {
  for (const file of SURFACES) assert.doesNotMatch(flat(read(...file)), WINS, file.join('/'));
});

test('every place and workspace question re-asks a Don\'t track mix with the fixed lead', () => {
  assert.equal(count(read('skills', 'login', 'SKILL.md'), LEAD), 2);
  assert.equal(count(read('skills', 'sync', 'SKILL.md'), LEAD), 1);
  assert.equal(count(read('skills', 'settings', 'SKILL.md'), LEAD), 1);
  assert.equal(count(read('skills', 'track', 'SKILL.md'), LEAD), 1);
  for (const f of ['login', 'sync', 'settings', 'track']) assert.ok(flat(read('skills', f, 'SKILL.md')).includes('only when the last choice is the whole answer'), f);
  for (const file of SURFACES) assert.equal(count(read(...file), `\`${LEAD}\``), count(read(...file), LEAD), file.join('/'));
  assert.ok(flat(read('skills', 'settings', 'SKILL.md')).includes('A second mixed answer runs nothing.'));
  assert.ok(flat(read('skills', 'track', 'SKILL.md')).includes('A second mixed answer counts as a declined question.'));
});

test('the joined repo picks re-ask a None of these mix, inside the range the SessionStart joined pass quotes', () => {
  const sync = flat(read('skills', 'sync', 'SKILL.md'));
  assert.equal(count(read('skills', 'login', 'SKILL.md'), NONE_LEAD), 1);
  assert.equal(count(read('skills', 'sync', 'SKILL.md'), NONE_LEAD), 1);
  const at = sync.indexOf(NONE_LEAD);
  assert.ok(at > sync.indexOf('Its output is for you only. For an account that joined'));
  assert.ok(at < sync.indexOf('**Then, repos and folders with no rule.**'));
  for (const f of ['login', 'sync']) assert.ok(flat(read('skills', f, 'SKILL.md')).includes('so no `done-command` runs'), f);
  for (const f of ['login', 'sync']) assert.ok(flat(read('skills', f, 'SKILL.md')).includes(`\`${NONE_LEAD}\``), f);
});

test('the joined review runs done-command only after every new workspace\'s question is answered, never after a mix', () => {
  const DONE = 'After every new workspace\'s question has been answered ("None of these" alone is an answer; skipped, dismissed or mixed is not), run the `done-command=` text EXACTLY ONCE; otherwise run no `done-command`';
  const sync = flat(read('skills', 'sync', 'SKILL.md'));
  for (const f of ['login', 'sync']) {
    assert.ok(flat(read('skills', f, 'SKILL.md')).includes(DONE), f);
    assert.ok(!flat(read('skills', f, 'SKILL.md')).includes('After the last `new=yes` workspace\'s question'), f);
  }
  const at = sync.indexOf(DONE);
  assert.ok(at > sync.indexOf('Its output is for you only. For an account that joined'));
  assert.ok(at < sync.indexOf('**Then, repos and folders with no rule.**'));
});
