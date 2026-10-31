#!/usr/bin/env node
/**
 * Docker-context guard.
 *
 * The Dockerfile's builder stage ends with `COPY . .`, so anything the .dockerignore does not
 * reject lands in the build context, the build cache, and a builder layer. This guard parses the
 * committed .dockerignore with Docker's own matching semantics (patterns anchored at the context
 * root, Go filepath.Match wildcards plus `**`, a pattern matching everything under a matched
 * directory, last matching rule wins, `!` re-includes) and asserts two things:
 *
 *   1. Non-build / sensitive material (private working notes, VCS metadata, runtime data, local
 *      env files, agent/tool workspaces, dependency and build-output dirs) is rejected. Dependency,
 *      coverage and compiler-cache trees are checked below the root too, where a bare name in a
 *      Docker rule does not reach.
 *   2. Every input the multi-stage build actually needs (package manifests, src/, the dashboard
 *      source, docker-entrypoint.sh, TS configs, and every file the Dockerfile COPYs or ADDs by
 *      name, derived from it) still passes.
 *
 * Run locally: `npm run check:dockerignore`. Runs in CI (lint job).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { posix } from 'node:path';

const root = new URL('../', import.meta.url);
const text = readFileSync(new URL('.dockerignore', root), 'utf8');

// Translate one .dockerignore pattern to a RegExp. `**/` matches zero or more leading segments,
// `**` any run of characters, `*`/`?` stay within a segment, `[...]` classes pass through, and
// every other regex metacharacter is literal — mirroring Go's filepath.Match plus Docker's `**`.
function globToRegExp(pattern) {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    if (pattern.startsWith('**/', i)) {
      re += '(?:[^/]+/)*';
      i += 3;
    } else if (pattern.startsWith('**', i)) {
      re += '.*';
      i += 2;
    } else if (pattern[i] === '*') {
      re += '[^/]*';
      i += 1;
    } else if (pattern[i] === '?') {
      re += '[^/]';
      i += 1;
    } else if (pattern[i] === '[') {
      const j = pattern.indexOf(']', i + 1);
      if (j === -1) {
        re += '\\[';
        i += 1;
      } else {
        re += pattern.slice(i, j + 1);
        i = j + 1;
      }
    } else {
      re += pattern[i].replace(/[.+^${}()|\\]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

// Parse: drop blanks/comments, honor `!` negation, clean the pattern the way Docker does (filepath.Clean,
// so ./x, x//y and x/./y are x) and strip surrounding slashes (a trailing slash only marks "this is a
// directory"; Docker ignores it when matching).
const rules = [];
for (const raw of text.split('\n')) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const negate = line.startsWith('!');
  const body = (negate ? line.slice(1) : line).trim();
  const pattern = body && posix.normalize(body).replace(/^\/+|\/+$/g, '');
  if (pattern) rules.push({ pattern, negate, re: globToRegExp(pattern) });
}

// Docker matches a pattern against the path AND every parent directory, so `data/` rejects
// `data/main.sqlite` even though the pattern itself has no wildcard.
function matches(re, path) {
  for (let p = path; ; ) {
    if (re.test(p)) return true;
    const cut = p.lastIndexOf('/');
    if (cut === -1) return false;
    p = p.slice(0, cut);
  }
}

function ignored(path) {
  let result = false;
  for (const rule of rules) {
    if (matches(rule.re, path)) result = !rule.negate;
  }
  return result;
}

// Must NEVER reach the build context — grouped by category, mirroring the .dockerignore sections.
const mustReject = [
  // Dependencies (reinstalled via npm ci in the image)
  'node_modules/typescript/package.json',
  'dashboard/node_modules/vite/package.json',
  'scripts/node_modules/zx/package.json',
  'sdk/javascript/node_modules/typescript/package.json',
  'sdk/php/vendor/autoload.php',
  'sdk/python/.venv/pyvenv.cfg',
  'sdk/java/target/openwa.jar',
  // The SDKs (no build step reads them): sources, build output and test caches
  'sdk/javascript/src/index.ts',
  'sdk/javascript/dist/cjs/index.js',
  'sdk/python/dist/openwa-0.7.0-py3-none-any.whl',
  'sdk/python/build/lib/openwa/client.py',
  'sdk/python/src/openwa.egg-info/PKG-INFO',
  'sdk/python/src/openwa/__pycache__/client.cpython-312.pyc',
  'sdk/python/.pytest_cache/v/cache/nodeids',
  'sdk/php/.phpunit.result.cache',
  'sdk/go/coverage.out',
  // Build output / local compiler caches
  'dist/main.js',
  'dashboard/dist/index.html',
  'tsconfig.tsbuildinfo',
  'dashboard/tsconfig.app.tsbuildinfo',
  // Test coverage
  'coverage/lcov.info',
  'dashboard/coverage/lcov.info',
  // Environment files (secrets)
  '.env',
  '.env.minimal',
  '.env.production.local',
  'dashboard/.env.local',
  // Runtime data (sessions, media, databases, keys)
  'data/main.sqlite',
  'data/.api-key',
  'openwa.sqlite',
  'backup.db',
  'uploads/s1/2026/10/photo.jpg',
  // Backup archives and pre-restore snapshots (scripts/backup.sh, scripts/restore.sh)
  'backups/openwa-backup-20260101-000000.tar.gz',
  'data.pre-restore-20260101-000000/.api-key',
  'data.pre-restore-20260101-000000/baileys/s1/creds.json',
  'state/sessions.pre-restore-20260101-000000/session-s1/Default/Cookies',
  // VCS metadata
  '.git/HEAD',
  '.git/hooks/pre-commit',
  // Private working material
  '_docs/notes.md',
  // Agent/tool workspaces and caches
  '.agent/state.json',
  '.claude/settings.json',
  '.kimi-worktrees/build-context/package.json',
  '.playwright-mcp/shot.png',
  '.remember/state.json',
  '.superpowers/config.yml',
  '.worktrees/topic/package.json',
  '.wwebjs_cache/chrome/linux/chrome',
  'CLAUDE.md',
  'docs/plans/plan.md',
  'docs/superpowers/run.md',
  // IDE
  '.vscode/settings.json',
];

// Must STILL reach the build context — the multi-stage build fails without any of these.
const mustKeep = [
  'package.json',
  'package-lock.json',
  'nest-cli.json',
  'tsconfig.json',
  'tsconfig.build.json',
  'src/main.ts',
  // Sources under names a runtime-data rule could also take (media/ is ignored by .gitignore).
  'src/modules/media/media.module.ts',
  'src/common/media/media-url.ts',
  'dashboard/package.json',
  'dashboard/package-lock.json',
  'dashboard/.npmrc',
  'dashboard/index.html',
  'dashboard/vite.config.ts',
  'dashboard/src/main.tsx',
  'scripts/postinstall.js',
  'scripts/patch-wwebjs-201832.js',
  'scripts/patch-wwebjs-newsletter-preview.js',
  'scripts/patch-wwebjs-status.js',
  'scripts/patch-wwebjs-ready-sync.js',
  'scripts/wwebjs-201832.patch',
  'scripts/pgdg-ACCC4CF8.asc',
  'scripts/backup.sh',
  'scripts/restore.sh',
  'scripts/lib-env.sh',
  'docker-entrypoint.sh',
  'docs/01-project-overview.md',
];

const errors = [];

// Everything else the Dockerfile COPYs or ADDs out of the build context is an input too. Derive those
// instead of restating them: a hand-written list lost eight of the patchers, and a rule dropping one of
// them then broke the image build rather than this check. A copy from another stage, a flag, the
// destination, a remote ADD source and `.` (the whole context) are not inputs.
// Comment lines go first, as in BuildKit: a comment is never continued, so one that ends in a backslash must
// not swallow the instruction below it, and one inside a continued instruction drops out of it. A
// continuation is a backslash, optional blanks and CR, the line end, and any blank lines after it.
const dockerfile = readFileSync(new URL('Dockerfile', root), 'utf8')
  .split('\n')
  .filter(line => !/^\s*#/.test(line))
  .join('\n')
  .replace(/\\[ \t\r]*\n(?:[ \t\r]*\n)*/g, ' ');
const wildcard = /[*?[]/;
// user@host:path as BuildKit takes it: a user of letters, digits, _ and -, and a host of letters, digits, . and -.
// A host in brackets is no scp address to it: [::1] is a class of characters, so the source is a pattern over
// the context.
const SCP_ADDRESS = /^[A-Za-z0-9_-]+@[A-Za-z0-9.-]+:/;
function copyInputs(source) {
  // Remote, as BuildKit 0.34 reads it: an http(s) URL in lower case, a git:// or ssh:// URL in any case, or an
  // scp address user@host:path. Anything else, ftp://x/y, s3://x/y, file:///x, HTTPS://x/y or user@host, names
  // a context path.
  if (/^https?:\/\//.test(source) || /^(?:git|ssh):\/\//i.test(source) || SCP_ADDRESS.test(source)) return [];
  // Docker resolves ./x, /x and x//y against the context root, which is the form the rules match.
  const path = posix.normalize(source).replace(/^\/+|\/+$/g, '');
  if (path === '' || path === '.') return [];
  if (!wildcard.test(path)) return [path];
  const cut = path.lastIndexOf('/') + 1;
  const dir = path.slice(0, cut);
  if (wildcard.test(dir)) {
    errors.push(`the Dockerfile reads '${source}', and this check expands a wildcard only in the file name.`);
    return [];
  }
  const name = globToRegExp(path.slice(cut));
  return readdirSync(new URL(dir || './', root))
    .filter(entry => name.test(entry))
    .map(entry => dir + entry);
}
// The words of an instruction's arguments. The exec form, COPY ["src", "dest"], is a JSON array after any
// flags and the only form that can name a path with a blank; text that does not parse as JSON is the shell
// form, as it is in BuildKit.
function argumentWords(args) {
  const text = args.trim();
  const json = /^((?:--\S+\s+)*)(\[.*\])$/.exec(text);
  if (json) {
    try {
      return [...json[1].split(/\s+/).filter(Boolean), ...JSON.parse(json[2]).map(String)];
    } catch {
      // not JSON
    }
  }
  return text.split(/\s+/);
}
const copied = [];
for (const [, args] of dockerfile.matchAll(/^[ \t]*(?:COPY|ADD)[ \t]+(.+)$/gim)) {
  const words = argumentWords(args);
  if (words.some(word => word.startsWith('--from='))) continue;
  const sources = words.filter(word => !word.startsWith('--')).slice(0, -1);
  copied.push(...sources.flatMap(copyInputs));
}
if (copied.length === 0) {
  errors.push('no COPY or ADD source found in the Dockerfile; the parser in this check needs updating.');
}
const keep = [...new Set([...mustKeep, ...copied])];

for (const path of mustReject) {
  if (!ignored(path)) {
    errors.push(`.dockerignore does not reject '${path}' — it would leak into the Docker build context/cache/layers.`);
  }
}
for (const path of keep) {
  if (ignored(path)) {
    errors.push(`.dockerignore rejects '${path}' — the Dockerfile build needs it in the context.`);
  }
}

if (errors.length) {
  console.error('\n✖ Docker-context check failed:');
  for (const e of errors) console.error(`  - ${e}`);
  console.error('\nFix .dockerignore so non-build material stays out and build inputs stay in, then re-run `npm run check:dockerignore`.\n');
  process.exit(1);
}
console.log(`✓ Docker-context check OK (${rules.length} .dockerignore rules, ${mustReject.length} rejected / ${keep.length} kept paths asserted).`);
