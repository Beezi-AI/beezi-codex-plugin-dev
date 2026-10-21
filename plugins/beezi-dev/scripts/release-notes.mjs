import fs from 'fs';
import path from 'path';
import url from 'url';
import { pluginInfo } from '../lib/status-extra.mjs';
import { compareVersions } from '../lib/version-compare.mjs';

// The release-notes skill's one command. Reads RELEASE_NOTES.md, the installed version and the cached
// update reading only: no network, no credentials, so it needs no environment guard.

const NOTES_PATH = url.fileURLToPath(new URL('../RELEASE_NOTES.md', import.meta.url));
const HEADING = /^## (\S+) \((\d{4}-\d{2}-\d{2})\) — (.+)$/;
const SECTION = /^### (.+)$/;
const VERSION_ARG = /^\d+(\.\d+)+$/;
const EARLIER_COUNT = 3;
const KNOWN_COUNT = 5;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// Rendered in this order, each under its icon; a section the file doesn't name keeps its own text.
const SECTIONS = [['New', '✨'], ['Improved', '⚡'], ['Fixed', '🐛']];
const DEFAULT_SECTION = 'Improved';
const HINT = '*Every release: ask the release-notes skill for all · one release: name its version*';

export const USAGE = 'Usage: release-notes.mjs [all | <version>]';

// [{ version, date, title, sections: [{ name, bullets }] }], in file order; bullets before any `###` go under Improved.
export function parseNotes(text) {
  const entries = [];
  let section = null;
  text.split(/\r?\n/).forEach((line) => {
    const heading = HEADING.exec(line);
    if (heading != null) {
      entries.push({ version: heading[1], date: heading[2], title: heading[3].trim(), sections: [] });
      section = null;
      return;
    }
    const entry = entries[entries.length - 1];
    if (entry == null) return;
    const named = SECTION.exec(line);
    if (named != null) {
      section = { name: named[1].trim(), bullets: [] };
      entry.sections.push(section);
    } else if (line.startsWith('- ')) {
      if (section == null) {
        section = { name: DEFAULT_SECTION, bullets: [] };
        entry.sections.push(section);
      }
      section.bullets.push(line.slice(2).trim());
    }
  });
  return entries;
}

export function bulletsOf(entry) {
  return entry.sections.reduce((all, s) => all.concat(s.bullets), []);
}

// A variant build (`0.23.0-dev.12`) reads the notes of its release (`0.23.0`).
export function baseVersion(version) {
  return version == null ? null : version.split('-')[0];
}

function longDate(date) {
  const [year, month, day] = date.split('-').map(Number);
  return `${MONTHS[month - 1]} ${day}, ${year}`;
}

function shortDate(date) {
  const [, month, day] = date.split('-').map(Number);
  return `${MONTHS[month - 1].slice(0, 3)} ${day}`;
}

function sectionTitle(name) {
  const known = SECTIONS.find(([n]) => n === name);
  return known == null ? name : `${known[1]} ${name}`;
}

// The entry's sections in New, Improved, Fixed order, then any others as written.
function sectionLines(entry) {
  const rank = (s) => {
    const at = SECTIONS.findIndex(([n]) => n === s.name);
    return at === -1 ? SECTIONS.length : at;
  };
  const out = [];
  entry.sections.filter((s) => s.bullets.length > 0).sort((a, b) => rank(a) - rank(b)).forEach((s) => {
    out.push('', `### ${sectionTitle(s.name)}`, ...s.bullets.map((b) => `- ${b}`));
  });
  return out;
}

// One release on its own: the version as the heading, its title, the date (and `installed`), then its sections.
function entryPage(entry, installed) {
  const when = `*Released ${longDate(entry.date)}${entry.version === installed ? ' · installed on this machine' : ''}*`;
  return [`# ✦ Beezi ${entry.version}`, `**${entry.title}**`, when, ...sectionLines(entry)];
}

// `info` is pluginInfo(): the raw installed version against the cached published one, as beezi_status compares them.
export function updateLine(info) {
  if (info == null || info.installed == null || info.latest == null) return null;
  if (compareVersions(info.installed, info.latest) !== -1) return null;
  return `> **Update available** — ${info.latest} is out. Run \`codex plugin marketplace upgrade\`, then start a new Codex thread.`;
}

function cell(text) {
  return String(text).replace(/\|/g, '\\|');
}

function earlierTable(entries) {
  return [
    '### Earlier releases',
    '| Version | Date | What changed |',
    '|---|---|---|',
    ...entries.map((e) => `| **${e.version}** | ${shortDate(e.date)} | ${cell(e.title)} |`),
  ];
}

export function formatCurrent(entries, installed, info) {
  const out = [];
  const update = updateLine(info);
  if (update != null) out.push(update, '');
  let at = entries.findIndex((e) => e.version === installed);
  if (at === -1) {
    at = 0;
    out.push(`> No notes for ${installed || 'this build'} yet, so these are the newest.`, '');
  }
  out.push(...entryPage(entries[at], installed));
  const earlier = entries.slice(at + 1, at + 1 + EARLIER_COUNT);
  out.push('', '---', '');
  if (earlier.length > 0) out.push(...earlierTable(earlier), '');
  out.push(HINT);
  return `${out.join('\n')}\n`;
}

export function formatAll(entries, installed = null) {
  const out = ['# ✦ Beezi release notes'];
  entries.forEach((e, i) => {
    if (i > 0) out.push('', '---');
    const mark = e.version === installed ? ' · installed' : '';
    out.push('', `## ${e.version} — ${e.title}`, `*${longDate(e.date)}${mark}*`, ...sectionLines(e));
  });
  return `${out.join('\n')}\n`;
}

export function formatVersion(entries, version, installed = null) {
  const entry = entries.find((e) => e.version === version);
  if (entry != null) return `${[...entryPage(entry, installed), '', '---', '', HINT].join('\n')}\n`;
  const known = entries.slice(0, KNOWN_COUNT).map((e) => `\`${e.version}\``).join(', ');
  return `> No release notes for **${version}**. The newest are ${known} — ask the release-notes skill for all.\n`;
}

// deps: `text` (the notes file's contents), plus pluginInfo's `readPluginJson`, `readJson` and `updateCheckFile`.
export function releaseNotes(arg, deps = {}) {
  const entries = parseNotes(deps.text == null ? fs.readFileSync(NOTES_PATH, 'utf8') : deps.text);
  const info = pluginInfo(deps);
  const installed = baseVersion(info.installed);
  if (arg === 'all') return formatAll(entries, installed);
  if (arg != null) return formatVersion(entries, arg, installed);
  return formatCurrent(entries, installed, info);
}

// Run only when this file IS the entry point. Importing it must not execute it.
function isDirectRun() {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry === '') return false;
  try {
    return path.resolve(entry) === path.resolve(url.fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

function main() {
  const args = process.argv.slice(2);
  const arg = args[0];
  if (args.length > 1 || (arg != null && arg !== 'all' && !VERSION_ARG.test(arg))) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(releaseNotes(arg));
}

if (isDirectRun()) {
  try {
    main();
  } catch (error) {
    console.error(`✗ Beezi: could not show the release notes (${error.message})`);
    process.exitCode = 1;
  }
}
