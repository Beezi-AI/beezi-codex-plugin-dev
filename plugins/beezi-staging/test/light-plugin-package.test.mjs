import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..', '..', '..');
const PLUGIN = join(ROOT, 'plugins', 'beezi-analytics');

const read = (rel) => readFileSync(join(PLUGIN, rel), 'utf-8');
const json = (rel) => JSON.parse(read(rel));

const channel = (value) => {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const filesUnder = (dir, prefix = '') => readdirSync(dir, { withFileTypes: true })
  .flatMap((entry) => (entry.isDirectory()
    ? filesUnder(join(dir, entry.name), `${prefix}${entry.name}/`)
    : [`${prefix}${entry.name}`]));

const manifest = () => json('plugin.json');
const ui = () => manifest().extensions['com.openai'].interface;

// manifest

test('manifest names the beezi-analytics plugin at 0.1.0', () => {
  assert.equal(manifest().name, 'beezi-analytics');
  assert.equal(manifest().version, '0.1.0');
});

test('manifest registers no hooks with OpenAI', () => {
  assert.equal('hooks' in manifest().extensions['com.openai'], false);
});

test('interface shows the name Beezi', () => {
  assert.equal(ui().displayName, 'Beezi');
});

test('interface texts stay within the directory limits', () => {
  assert.ok(ui().displayName.length <= 30);
  assert.ok(ui().shortDescription.length <= 30);
  assert.ok(ui().longDescription.length <= 4000);
  assert.ok(ui().developerName.length <= 80);
});

test('interface offers at most three default prompts of at most 128 characters', () => {
  assert.ok(ui().defaultPrompt.length <= 3);
  assert.ok(ui().defaultPrompt.every((p) => p.length <= 128));
});

test('interface links to the Beezi site, support, privacy policy and terms', () => {
  assert.equal(ui().websiteURL, 'https://beezi.ai');
  assert.equal(ui().supportURL, 'https://beezi.ai/contact-us');
  assert.equal(ui().privacyPolicyURL, 'https://beezi.ai/privacy-policy');
  assert.equal(ui().termsOfServiceURL, 'https://beezi.ai/terms-and-conditions');
});

test('brand colour has contrast of at least 2 on white', () => {
  assert.ok(contrast(ui().brandColor, '#FFFFFF') >= 2);
});

test('dark brand colour has contrast of at least 2 on #212121', () => {
  assert.ok(contrast(ui().brandColorDark, '#212121') >= 2);
});

test('logo and composer icon exist inside the package', () => {
  for (const icon of [ui().logo, ui().composerIcon]) {
    assert.ok(existsSync(join(PLUGIN, icon)), icon);
  }
});

test('logo is the 512 by 512 Beezi mark', () => {
  assert.match(read('assets/beezi_logo.svg'), /viewBox="0 0 512 512"/);
});

test('licence and notice are copies of the full plugin files', () => {
  for (const file of ['LICENSE', 'NOTICE']) {
    assert.equal(read(file), readFileSync(join(ROOT, 'plugins', 'beezi', file), 'utf-8'), file);
  }
});

// MCP file

test('mcp.json declares the remote OAuth server under the key beezi_analytics', () => {
  assert.deepEqual(json('mcp.json').mcpServers, {
    beezi_analytics: {
      type: 'streamable-http',
      url: 'https://api.beezi.ai/api/mcp',
      extensions: {
        'com.openai': {
          auth: {
            type: 'oauth',
            client: { mode: 'dcr' },
            baseScopes: ['openid', 'email', 'profile', 'offline_access'],
          },
        },
      },
    },
  });
});

// nothing local, nothing OpenAI rejects

test('package holds exactly the declared files and no stray ones', () => {
  assert.deepEqual(filesUnder(PLUGIN).sort(), [
    'LICENSE',
    'NOTICE',
    'README.md',
    'assets/beezi_logo.svg',
    'mcp.json',
    'plugin.json',
    'skills/about/SKILL.md',
    'skills/analytics/SKILL.md',
  ]);
});

// analytics skill

test('analytics skill is named analytics and has no argument-hint', () => {
  const text = read('skills/analytics/SKILL.md');
  assert.match(text, /^---\nname: analytics\n/);
  assert.equal(text.includes('argument-hint'), false);
});

test('analytics skill description is scoped to Beezi', () => {
  assert.match(
    read('skills/analytics/SKILL.md'),
    /\ndescription: Show a short personal Beezi analytics summary \(spend, sessions, status, recommendations\) for the last 7 or 30 days\. Use when the user asks for their Beezi analytics, or for a usage or spend summary from Beezi\.\n/,
  );
});

test('analytics skill does not call get_analytics_instructions', () => {
  assert.equal(read('skills/analytics/SKILL.md').includes('get_analytics_instructions'), false);
});

test('analytics skill always asks for every coding agent', () => {
  const text = read('skills/analytics/SKILL.md');
  assert.ok(text.includes('{ period, agents: "all" }'));
  assert.equal(text.includes('every coding agent'), false);
  assert.equal(text.includes('all agents'), false);
});

test('analytics skill calls the beezi_analytics server', () => {
  assert.ok(read('skills/analytics/SKILL.md').includes('`beezi_analytics` MCP server'));
});

test('analytics skill carries template version 9.0', () => {
  assert.ok(read('skills/analytics/SKILL.md').includes('Template version: 9.0'));
});

test('analytics skill never names Claude', () => {
  assert.equal(/\bClaude\b/.test(read('skills/analytics/SKILL.md')), false);
});

test('analytics skill gives the Codex example for agent-labelled checks', () => {
  assert.ok(read('skills/analytics/SKILL.md').includes('"Plan limit reached (Codex): "'));
});

test('analytics skill numbers its rules 1 to 20 in order', () => {
  const numbers = read('skills/analytics/SKILL.md')
    .split('\n')
    .filter((line) => /^\d+\. /.test(line))
    .slice(0, 20)
    .map((line) => Number(line.split('.')[0]));
  assert.deepEqual(numbers, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
});

test('analytics skill tells the user how to sign in', () => {
  assert.ok(read('skills/analytics/SKILL.md').includes(
    'Sign in to Beezi first: reconnect the Beezi plugin\'s server, then try again.',
  ));
});

test('analytics skill no_data rule gives two lines: the grade line, then the pointer to about', () => {
  const text = read('skills/analytics/SKILL.md');
  const grade = text.indexOf('Not enough activity to grade this period.');
  const pointer = text.indexOf(
    'This plugin shows analytics and records nothing itself. Ask "about Beezi analytics" to see where the data comes from.',
  );
  assert.notEqual(grade, -1);
  assert.notEqual(pointer, -1);
  assert.ok(grade < pointer);
  assert.ok(text.includes('14. When status is no_data, keep the header and Key numbers, and replace the Recommendations section with exactly these two lines:'));
});

test('analytics skill workflow defaults to 7d and asks for every coding agent', () => {
  const workflow = read('skills/analytics/SKILL.md').split('\nWorkflow:\n')[1].split('\n\nTemplate')[0];
  assert.ok(workflow.includes('1. Pick the period from the user\'s request: "7d" (7 days) or "30d" (30 days). Anything else, or no period named, means "7d".'));
  assert.ok(workflow.includes('2. Call `get_my_usage_summary` on the `beezi_analytics` MCP server with `{ period, agents: "all" }`.'));
  assert.ok(workflow.includes('3. Render the payload with the template below, and stop'));
});

// marketplace

test('marketplace lists beezi then beezi-analytics', () => {
  const marketplace = json('../../.agents/plugins/marketplace.json');
  assert.deepEqual(marketplace.plugins.map((p) => p.name), ['beezi', 'beezi-analytics']);
});

test('marketplace entry for beezi-analytics points at the local folder', () => {
  const entry = json('../../.agents/plugins/marketplace.json').plugins[1];
  assert.deepEqual(entry.source, { source: 'local', path: './plugins/beezi-analytics' });
});

test('marketplace entry for beezi-analytics repeats the policy and category of beezi', () => {
  const [full, light] = json('../../.agents/plugins/marketplace.json').plugins;
  assert.deepEqual(light.policy, { installation: 'AVAILABLE', authentication: 'ON_INSTALL' });
  assert.deepEqual(light.policy, full.policy);
  assert.equal(light.category, 'Productivity');
});

// about skill, README

test('about skill is named about', () => {
  assert.match(read('skills/about/SKILL.md'), /^---\nname: about\n/);
});

test('about skill names no tool and never names Claude', () => {
  const about = read('skills/about/SKILL.md');
  assert.equal(/get_[a-z_]+/.test(about), false);
  assert.equal(/\bClaude\b/.test(about), false);
});

test('about skill links privacy policy, terms and support', () => {
  const about = read('skills/about/SKILL.md');
  for (const url of [
    'https://beezi.ai/privacy-policy',
    'https://beezi.ai/terms-and-conditions',
    'https://beezi.ai/contact-us',
  ]) {
    assert.ok(about.includes(url), url);
  }
});

test('about skill links the docs site', () => {
  assert.ok(read('skills/about/SKILL.md').includes('Docs: https://docs.beezi.ai\n'));
});

test('about skill says it records nothing', () => {
  assert.ok(read('skills/about/SKILL.md').includes('It records nothing.'));
});

test('about skill tells the user how to sign in', () => {
  assert.ok(read('skills/about/SKILL.md').includes(
    'Sign in: connect the Beezi plugin\'s server when your tool asks. You need a Beezi account.',
  ));
});

test('README names the MCP URL', () => {
  assert.ok(read('README.md').includes('https://api.beezi.ai/api/mcp'));
});

test('package README does not tell the reviewer the plugin fails to connect', () => {
  const readme = read('README.md');
  assert.equal(readme.includes('0.167'), false);
  assert.equal(readme.includes('does not connect'), false);
});

test('repo README carries the Codex 0.167 marketplace-install note', () => {
  assert.ok(readFileSync(join(ROOT, 'README.md'), 'utf-8').includes(
    'On Codex 0.167 a marketplace install of it does not connect yet',
  ));
});
