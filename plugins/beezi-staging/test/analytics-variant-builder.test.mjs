import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { withoutGuard } from '../tools/hermetic-env.mjs';

// scripts/make-analytics-variant.sh, the staging builder of the beezi-analytics package. The shipped
// heredoc is sliced out and run in-process on a fixture package; argument checks run the script
// itself, and fail before anything is copied. The variant branch of scripts/sync-to-github.sh is run
// against a throwaway source repo; every case stops before its first fetch.

const repoRoot = path.dirname(path.dirname(path.dirname(
  path.dirname(url.fileURLToPath(import.meta.url)),
)));
const BUILDER = path.join(repoRoot, 'scripts', 'make-analytics-variant.sh');
const PIPELINE = path.join(repoRoot, 'azure-pipelines-github-sync.yml');
const SYNC_SCRIPT = path.join(repoRoot, 'scripts', 'sync-to-github.sh');
const require_ = createRequire(import.meta.url);

const PLUGIN_JSON = {
  name: 'beezi-analytics',
  version: '0.1.0',
  description: 'See your Beezi usage analytics.',
  license: 'Apache-2.0',
  extensions: {
    'com.openai': { interface: { displayName: 'Beezi', shortDescription: 'Your AI coding usage and cost' } },
  },
};
const MCP_JSON = {
  $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
  mcpServers: {
    beezi_analytics: {
      type: 'streamable-http',
      url: 'https://api.beezi.ai/api/mcp',
      headers: { 'X-Beezi-Agent': 'codex' },
      extensions: { 'com.openai': { auth: { type: 'oauth', client: { mode: 'dcr' } } } },
    },
  },
};
const ANALYTICS_SKILL = 'Call `get_my_usage_summary` on the `beezi_analytics` MCP server.\n';
const ABOUT_SKILL = '- Reads it through the Beezi MCP server (https://api.beezi.ai/api/mcp) after you sign in.\n';
const README = [
  'codex plugin marketplace add Beezi-AI/beezi-codex-plugin',
  'codex plugin add beezi-analytics@beezi',
  'Codex asks you to connect the `beezi_analytics` MCP',
  'The plugin declares one remote MCP server, `beezi_analytics`, at `https://api.beezi.ai/api/mcp`.',
  'Sign-in goes through `https://clerk.beezi.ai`. The plugin runs no local code, has no hooks, and',
  'The full Beezi plugin, `beezi` in this repository, records your Codex sessions',
  '',
].join('\n');

function builderScript() {
  const text = fs.readFileSync(BUILDER, 'utf-8');
  const start = text.indexOf("<<'NODE'\n");
  assert.notEqual(start, -1, 'make-analytics-variant.sh no longer has a NODE heredoc');
  const bodyStart = start + "<<'NODE'\n".length;
  const end = text.indexOf('\nNODE\n', bodyStart);
  assert.notEqual(end, -1, 'the NODE heredoc is not terminated');
  return text.slice(bodyStart, end);
}

function writeFile(dir, rel, body) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), body);
}

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runHeredoc(dir) {
  let out = '';
  const context = vm.createContext({
    require: require_,
    process: {
      argv: ['node', '-', dir, 'staging', 'https://beezi-api-staging.azurewebsites.net/api', '4242', 'o/internal'],
      stdout: { write: (chunk) => { out += chunk; } },
    },
  });
  vm.runInContext(builderScript(), context, { filename: 'make-analytics-variant.sh:NODE' });
  return out;
}

function build(t) {
  const dir = tempDir(t, 'beezi-analytics-variant-');
  writeFile(dir, 'plugin.json', JSON.stringify(PLUGIN_JSON, null, 2));
  writeFile(dir, 'mcp.json', JSON.stringify(MCP_JSON, null, 2));
  writeFile(dir, 'skills/analytics/SKILL.md', ANALYTICS_SKILL);
  writeFile(dir, 'skills/about/SKILL.md', ABOUT_SKILL);
  writeFile(dir, 'README.md', README);

  const out = runHeredoc(dir);
  const read = (rel) => fs.readFileSync(path.join(dir, rel), 'utf-8');
  return {
    out,
    plugin: JSON.parse(read('plugin.json')),
    mcp: JSON.parse(read('mcp.json')),
    analyticsSkill: read('skills/analytics/SKILL.md'),
    aboutSkill: read('skills/about/SKILL.md'),
    readme: read('README.md'),
  };
}

// These children run the shipped bash scripts and build a throwaway git repo in a mkdtemp dir.
const runBash = (args, options) =>
  withoutGuard(() => spawnSync('bash', args, { encoding: 'utf-8', ...options }));
const runGit = (args, options) =>
  withoutGuard(() => spawnSync('git', args, { encoding: 'utf-8', ...options }));

test('prints the build-stamped version of the staging variant', (t) => {
  assert.equal(build(t).out, '0.1.0-staging.4242\n');
});

test('renames the manifest to beezi-analytics-staging and marks it as the staging build', (t) => {
  assert.deepEqual(build(t).plugin, {
    name: 'beezi-analytics-staging',
    version: '0.1.0-staging.4242',
    description: 'See your Beezi usage analytics. — staging environment build.',
    license: 'Apache-2.0',
    extensions: {
      'com.openai': { interface: { displayName: 'Beezi (staging)', shortDescription: 'Your AI coding usage and cost' } },
    },
  });
});

test('moves the MCP server to its own key, points it at the environment API, keeps its header and drops its extensions', (t) => {
  assert.deepEqual(build(t).mcp, {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
    mcpServers: {
      beezi_analytics_staging: {
        type: 'streamable-http',
        url: 'https://beezi-api-staging.azurewebsites.net/api/mcp',
        headers: { 'X-Beezi-Agent': 'codex' },
      },
    },
  });
});

test('points every skill at the variant server key and the environment MCP URL', (t) => {
  const { analyticsSkill, aboutSkill } = build(t);
  assert.equal(analyticsSkill, 'Call `get_my_usage_summary` on the `beezi_analytics_staging` MCP server.\n');
  assert.equal(
    aboutSkill,
    '- Reads it through the Beezi MCP server (https://beezi-api-staging.azurewebsites.net/api/mcp) after you sign in.\n',
  );
});

test('rewrites the README to the internal marketplace, the variant and its server, without the prod sign-in host', (t) => {
  assert.equal(
    build(t).readme,
    [
      'codex plugin marketplace add o/internal',
      'codex plugin add beezi-analytics-staging@beezi-internal',
      'Codex asks you to connect the `beezi_analytics_staging` MCP',
      'The plugin declares one remote MCP server, `beezi_analytics_staging`, at `https://beezi-api-staging.azurewebsites.net/api/mcp`.',
      'The plugin runs no local code, has no hooks, and',
      'The full Beezi plugin, `beezi-staging` in this repository, records your Codex sessions',
      '',
    ].join('\n'),
  );
});

test('leaves no prod server key, URL, Clerk host, install line or plugin name in the real package texts', (t) => {
  const dir = tempDir(t, 'beezi-analytics-real-');
  fs.cpSync(path.join(repoRoot, 'plugins', 'beezi-analytics'), dir, { recursive: true });
  runHeredoc(dir);
  for (const rel of ['README.md', 'skills/analytics/SKILL.md', 'skills/about/SKILL.md']) {
    const text = fs.readFileSync(path.join(dir, rel), 'utf-8');
    for (const prod of ['api.beezi.ai', 'clerk.beezi.ai', '`beezi` in this repository']) {
      assert.equal(text.includes(prod), false, `${rel}: ${prod}`);
    }
    for (const prod of [
      /marketplace add Beezi-AI\/beezi-codex-plugin(\n|$)/,
      /beezi-analytics@beezi(\n|$)/,
      /beezi_analytics(?!_staging)/,
    ]) {
      assert.doesNotMatch(text, prod, rel);
    }
  }
});

const API = 'https://beezi-api-staging.azurewebsites.net/api';
const REPO = 'o/internal';
const rejected = [
  { args: ['prod', 'https://api.beezi.ai/api', '1', REPO], message: "env 'prod' is not staging" },
  { args: ['dev', 'https://beezi-api-dev.azurewebsites.net/api', '1', REPO], message: "env 'dev' is not staging" },
  { args: ['local', 'https://beezi-api-dev.azurewebsites.net/api', '1', REPO], message: "env 'local' is not staging" },
  { args: ['staging', 'http://beezi-api-staging.azurewebsites.net/api', '1', REPO], message: `api-base 'http://beezi-api-staging.azurewebsites.net/api' must be ${API}` },
  { args: ['staging', 'https://beezi-api-dev.azurewebsites.net/api', '1', REPO], message: `api-base 'https://beezi-api-dev.azurewebsites.net/api' must be ${API}` },
  { args: ['staging', 'https://LOCALHOST/api', '1', REPO], message: `api-base 'https://LOCALHOST/api' must be ${API}` },
  { args: ['staging', 'https://127.1/api', '1', REPO], message: `api-base 'https://127.1/api' must be ${API}` },
  { args: ['staging', 'https://u:tok@host/api', '1', REPO], message: `api-base 'https://u:tok@host/api' must be ${API}` },
  { args: ['staging', 'https://host:5001/api', '1', REPO], message: `api-base 'https://host:5001/api' must be ${API}` },
  { args: ['staging', 'https://host/api?x=1', '1', REPO], message: `api-base 'https://host/api?x=1' must be ${API}` },
  { args: ['staging', 'https://host/v2/api', '1', REPO], message: `api-base 'https://host/v2/api' must be ${API}` },
  { args: ['staging', API, 'x1', REPO], message: "build-id 'x1' must be a number" },
  { args: ['staging', API, '1'], message: 'internal-repo is required (owner/name of the internal marketplace repo)' },
  { args: ['staging', API, '1', 'Beezi-AI'], message: "internal-repo 'Beezi-AI' must be owner/name" },
  { args: ['staging', API, '1', 'Beezi-AI/a/b'], message: "internal-repo 'Beezi-AI/a/b' must be exactly owner/name" },
  { args: ['staging', API, '1', 'Beezi-AI/a b'], message: "internal-repo 'Beezi-AI/a b' has characters no GitHub slug has" },
];
for (const { args, message } of rejected) {
  test(`refuses ${args.join(' ')} before building anything`, (t) => {
    const cwd = tempDir(t, 'beezi-analytics-refuse-');
    const result = runBash([BUILDER, ...args], { cwd });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, `make-analytics-variant: ${message}\n`);
    assert.equal(fs.existsSync(path.join(cwd, 'dist')), false);
  });
}

// sync-to-github.sh reads only `git rev-parse --verify HEAD` before the variant checks and the
// non-production guard, so an empty commit is the whole source repo it needs.
function sourceRepo(t) {
  const dir = tempDir(t, 'beezi-analytics-source-');
  for (const args of [
    ['init', '-q'],
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false',
      'commit', '-q', '--allow-empty', '--no-verify', '-m', 'source'],
  ]) {
    const result = runGit(args, { cwd: dir, env: gitEnv() });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  }
  return dir;
}

function gitEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}

function variantDir(t, name, files) {
  const dir = tempDir(t, 'beezi-analytics-built-');
  for (const [rel, body] of Object.entries(files)) writeFile(dir, path.join('plugins', name, rel), body);
  return dir;
}

function runSync(cwd, variant) {
  return runBash([SYNC_SCRIPT], {
    cwd,
    env: gitEnv({
      GITHUB_PAT: 'fake',
      GITHUB_REPO: 'o/internal',
      PUBLIC_REPO: 'o/public',
      VARIANT_DIR: variant,
      SOURCE_REF: 'HEAD',
      ALLOW_NON_PROD: 'false',
      DRY_RUN: 'false',
    }),
  });
}

test('a beezi-analytics variant with only a root plugin.json passes the manifest check', (t) => {
  const variant = variantDir(t, 'beezi-analytics-staging', {
    'plugin.json': JSON.stringify({ name: 'beezi-analytics-staging' }),
    'mcp.json': JSON.stringify({ mcpServers: { beezi_analytics_staging: { url: 'http://localhost:5001/api/mcp' } } }),
  });
  // The loopback URL stops the run at the non-production guard, after the manifest check and
  // before any fetch.
  const result = runSync(sourceRepo(t), variant);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes('sync-to-github: refusing to publish - non-production connector URL found:'), result.stderr);
  assert.ok(!result.stderr.includes(' has no '), result.stderr);
});

test('a beezi-analytics variant without a root plugin.json is refused', (t) => {
  const variant = variantDir(t, 'beezi-analytics-staging', {
    '.codex-plugin/plugin.json': JSON.stringify({ name: 'beezi-analytics-staging' }),
  });
  const result = runSync(sourceRepo(t), variant);
  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    'sync-to-github: beezi-analytics-staging has no plugin.json - was it built by scripts/make-variant.sh or scripts/make-analytics-variant.sh?\n',
  );
});

test('a beezi-staging variant without .codex-plugin/plugin.json is still refused', (t) => {
  const variant = variantDir(t, 'beezi-staging', { 'plugin.json': JSON.stringify({ name: 'beezi-staging' }) });
  const result = runSync(sourceRepo(t), variant);
  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    'sync-to-github: beezi-staging has no .codex-plugin/plugin.json - was it built by scripts/make-variant.sh or scripts/make-analytics-variant.sh?\n',
  );
});

test('the staging step builds both staging variants and syncs each to the internal repo, in order', () => {
  const pipeline = fs.readFileSync(PIPELINE, 'utf-8');
  const header = pipeline.match(
    /displayName: Publish beezi-staging and beezi-analytics-staging variants to internal GitHub\n\s+condition: eq\(variables\['Build\.SourceBranchName'\], 'staging'\)/,
  );
  assert.ok(header, 'no staging step publishes beezi-analytics-staging');
  const stepStart = pipeline.lastIndexOf('- script: |', header.index);
  assert.notEqual(stepStart, -1);
  const step = pipeline.slice(stepStart, header.index);
  const lines = [
    `bash scripts/make-variant.sh staging "https://beezi-api-staging.azurewebsites.net/api" "$(Build.BuildId)" '$(GITHUB_REPO_INTERNAL)'`,
    `bash scripts/make-analytics-variant.sh staging "https://beezi-api-staging.azurewebsites.net/api" "$(Build.BuildId)" '$(GITHUB_REPO_INTERNAL)'`,
    `export GITHUB_REPO='$(GITHUB_REPO_INTERNAL)'`,
    `export GITHUB_PAT='$(GITHUB_PAT_INTERNAL)'`,
    `export PUBLIC_REPO='$(GITHUB_REPO)'`,
    `export SOURCE_REF='$(Build.SourceVersion)'`,
    'export TARGET_BRANCH=main',
    'VARIANT_DIR=dist/variant bash scripts/sync-to-github.sh',
    'VARIANT_DIR=dist/variant-analytics bash scripts/sync-to-github.sh',
  ];
  let from = 0;
  for (const line of lines) {
    const at = step.indexOf(`\n          ${line}\n`, from);
    assert.notEqual(at, -1, `the staging step lacks, or misorders: ${line}`);
    from = at + 1;
  }
});
