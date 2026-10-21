import { withoutGuard } from '../tools/hermetic-env.mjs';
import { settledHome } from '../tools/spawn-fixtures.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseVersion, bulletsOf, formatAll, formatCurrent, formatVersion, parseNotes, releaseNotes, updateLine, USAGE } from '../scripts/release-notes.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/release-notes.mjs', import.meta.url));
const NOTES = fs.readFileSync(fileURLToPath(new URL('../RELEASE_NOTES.md', import.meta.url)), 'utf8');
const PACKAGE_JSON = fileURLToPath(new URL('../package.json', import.meta.url));
const PLUGIN_JSON = fileURLToPath(new URL('../.codex-plugin/plugin.json', import.meta.url));

const SAMPLE = [
  '# Beezi plugin release notes',
  '',
  '## 0.3.0 (2026-10-20) — Third',
  '',
  '### Fixed',
  '- **f1** — fixed',
  '',
  '### New',
  '- **n1** — new',
  '- **n2** — new | piped',
  '',
  '## 0.2.1 (2026-10-16) — Second',
  '',
  '- b1',
  '',
  '## 0.2.0 (2026-10-14) — Two',
  '',
  '### Improved',
  '- two',
  '',
  '## 0.1.1 (2026-10-13) — One | one',
  '',
  '### Improved',
  '- one one',
  '',
  '## 0.1.0 (2026-09-01) — First',
  '',
  '### Improved',
  '- a1',
  '',
].join('\n');
const sample = () => parseNotes(SAMPLE);
const update = { installed: '0.3.0', latest: '0.4.0', checkedAt: '2026-10-21T09:00:00.000Z' };
const HINT = '*Every release: ask the release-notes skill for all · one release: name its version*';
const UPDATE = '> **Update available** — 0.4.0 is out. Run `codex plugin marketplace upgrade`, then start a new Codex thread.';

// releaseNotes deps: this build's plugin.json and the cached update reading, both injected.
const deps = (version, cached = {}) => ({
  text: SAMPLE,
  readPluginJson: () => ({ name: 'beezi', version }),
  readJson: () => cached,
});

const compare = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  }
  return 0;
};

test('every heading in RELEASE_NOTES.md parses, newest first, unique, each with bullets in known sections', () => {
  const entries = parseNotes(NOTES);
  const headings = NOTES.split('\n').filter((l) => l.startsWith('## '));
  assert.equal(entries.length, headings.length);
  assert.ok(entries.length > 0);
  const versions = entries.map((e) => e.version);
  assert.equal(new Set(versions).size, versions.length);
  for (let i = 1; i < entries.length; i++) {
    assert.ok(compare(versions[i - 1], versions[i]) > 0, `${versions[i - 1]} before ${versions[i]}`);
    assert.ok(entries[i - 1].date >= entries[i].date, `${versions[i - 1]} dated on or after ${versions[i]}`);
  }
  entries.forEach((e) => {
    assert.ok(bulletsOf(e).length > 0, `${e.version} has bullets`);
    e.sections.forEach((s) => assert.ok(['New', 'Improved', 'Fixed'].includes(s.name), `${e.version}: section ${s.name}`));
    bulletsOf(e).forEach((b) => assert.match(b, /^\*\*.+?\*\* — \S/, `${e.version}: "${b}" leads with a bold phrase`));
  });
});

test('the current package.json and plugin.json versions have an entry', () => {
  const versions = parseNotes(NOTES).map((e) => e.version);
  assert.ok(versions.includes(JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8')).version));
  assert.ok(versions.includes(JSON.parse(fs.readFileSync(PLUGIN_JSON, 'utf8')).version));
});

test('parseNotes reads heading parts and sections; bullets before any section go under Improved', () => {
  assert.deepEqual(sample()[0], {
    version: '0.3.0', date: '2026-10-20', title: 'Third',
    sections: [{ name: 'Fixed', bullets: ['**f1** — fixed'] }, { name: 'New', bullets: ['**n1** — new', '**n2** — new | piped'] }],
  });
  assert.deepEqual(sample()[1].sections, [{ name: 'Improved', bullets: ['b1'] }]);
});

test('no argument shows the installed release with its sections in order, then the three before it', () => {
  assert.equal(formatCurrent(sample(), '0.3.0', null), [
    '# ✦ Beezi 0.3.0',
    '**Third**',
    '*Released October 20, 2026 · installed on this machine*',
    '',
    '### ✨ New',
    '- **n1** — new',
    '- **n2** — new | piped',
    '',
    '### 🐛 Fixed',
    '- **f1** — fixed',
    '',
    '---',
    '',
    '### Earlier releases',
    '| Version | Date | What changed |',
    '|---|---|---|',
    '| **0.2.1** | Oct 16 | Second |',
    '| **0.2.0** | Oct 14 | Two |',
    '| **0.1.1** | Oct 13 | One \\| one |',
    '',
    HINT,
    '',
  ].join('\n'));
});

test('an older installed version lists only the releases before it', () => {
  assert.match(formatCurrent(sample(), '0.1.1', null), /\| \*\*0\.1\.0\*\* \| Sep 1 \| First \|\n\n\*Every release/);
  assert.doesNotMatch(formatCurrent(sample(), '0.1.0', null), /Earlier releases/);
});

test('a newer published version adds the update callout first', () => {
  assert.ok(formatCurrent(sample(), '0.3.0', update).startsWith(`${UPDATE}\n\n# ✦ Beezi 0.3.0\n`));
});

test('the update callout appears only for a published newer version', () => {
  assert.equal(updateLine(null), null);
  assert.equal(updateLine({ ...update, latest: '0.3.0' }), null);
  assert.equal(updateLine({ ...update, latest: '0.2.1' }), null);
  assert.equal(updateLine({ ...update, latest: null }), null);
  assert.equal(updateLine({ ...update, installed: null }), null);
  // A variant build compares in full: behind on its own channel is still behind.
  assert.ok(updateLine({ installed: '0.3.0-dev.12', latest: '0.3.0-dev.15' }).startsWith('> **Update available** — 0.3.0-dev.15 is out.'));
});

test('a variant build reads the notes of its release', () => {
  assert.equal(baseVersion('0.3.0-dev.12'), '0.3.0');
  assert.equal(baseVersion('0.3.0'), '0.3.0');
  assert.equal(baseVersion(null), null);
  const out = releaseNotes(undefined, deps('0.3.0-dev.12'));
  assert.ok(out.startsWith('# ✦ Beezi 0.3.0\n**Third**\n*Released October 20, 2026 · installed on this machine*\n'));
  assert.match(releaseNotes('all', deps('0.2.0-staging.4')), /^## 0\.2\.0 — Two\n\*October 14, 2026 · installed\*$/m);
});

test('a release with no entry yet shows the newest and says so', () => {
  const out = releaseNotes(undefined, deps('0.4.0-local.3'));
  assert.ok(out.startsWith('> No notes for 0.4.0 yet, so these are the newest.\n\n# ✦ Beezi 0.3.0\n**Third**\n*Released October 20, 2026*\n'));
});

test('all lists every release newest first, marking the installed one', () => {
  const out = formatAll(sample(), '0.2.0');
  assert.ok(out.startsWith('# ✦ Beezi release notes\n\n## 0.3.0 — Third\n*October 20, 2026*\n'));
  assert.deepEqual(out.split('\n').filter((l) => l.startsWith('## ')), [
    '## 0.3.0 — Third', '## 0.2.1 — Second', '## 0.2.0 — Two', '## 0.1.1 — One | one', '## 0.1.0 — First',
  ]);
  assert.match(out, /^## 0\.2\.0 — Two\n\*October 14, 2026 · installed\*$/m);
  assert.equal(out.split('\n---\n').length, 5);
});

test('a known version shows only its release; an unknown one names the newest five', () => {
  assert.equal(formatVersion(sample(), '0.2.1', '0.3.0'), [
    '# ✦ Beezi 0.2.1', '**Second**', '*Released October 16, 2026*', '', '### ⚡ Improved', '- b1', '', '---', '', HINT, '',
  ].join('\n'));
  assert.equal(formatVersion(sample(), '9.9.9'),
    '> No release notes for **9.9.9**. The newest are `0.3.0`, `0.2.1`, `0.2.0`, `0.1.1`, `0.1.0` — ask the release-notes skill for all.\n');
});

test('the update callout comes from the cached reading only; none cached, none shown', () => {
  assert.ok(releaseNotes(undefined, deps('0.3.0', { checkedAt: 1, latest: '0.4.0' })).startsWith(`${UPDATE}\n\n`));
  assert.ok(releaseNotes(undefined, deps('0.3.0', {})).startsWith('# ✦ Beezi 0.3.0\n'));
  assert.ok(releaseNotes(undefined, { ...deps('0.3.0'), readJson: () => null }).startsWith('# ✦ Beezi 0.3.0\n'));
});

function run(t, args) {
  const home = settledHome(t, 'beezi-release-notes-');
  const env = { ...process.env, HOME: home, USERPROFILE: home, BEEZI_CODEX_HOME: home, CODEX_HOME: path.join(home, '.codex') };
  delete env.NODE_TEST_CONTEXT;
  const result = withoutGuard(() => spawnSync(process.execPath, [SCRIPT, ...args], { env, cwd: home, encoding: 'utf8', timeout: 60_000 }));
  return { code: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

test('release-notes.mjs with no argument prints the installed version\'s notes and no update line', (t) => {
  const version = JSON.parse(fs.readFileSync(PLUGIN_JSON, 'utf8')).version;
  const result = run(t, []);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, formatCurrent(parseNotes(NOTES), version, null));
  assert.ok(result.stdout.startsWith(`# ✦ Beezi ${version}\n`));
});

test('release-notes.mjs all, a version, and a bad argument', (t) => {
  assert.ok(run(t, ['all']).stdout.startsWith('# ✦ Beezi release notes\n'));
  const one = run(t, ['0.22.8']);
  assert.equal(one.code, 0, one.stderr);
  assert.ok(one.stdout.startsWith('# ✦ Beezi 0.22.8\n**Pick repos for each workspace you join**\n*Released October 14, 2026'));
  const unknown = run(t, ['0.0.1']);
  assert.equal(unknown.code, 0);
  assert.match(unknown.stdout, /^> No release notes for \*\*0\.0\.1\*\*\. The newest are /);
  const bad = run(t, ['latest']);
  assert.equal(bad.code, 1);
  assert.equal(bad.stdout, '');
  assert.equal(bad.stderr.trim(), USAGE);
});
