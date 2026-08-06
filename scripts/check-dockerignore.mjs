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
 *      env files, agent/tool workspaces, dependency and build-output dirs) is rejected.
 *   2. Every input the multi-stage build actually needs (package manifests, src/, the dashboard
 *      source, the backport patcher, docker-entrypoint.sh, TS configs) still passes.
 *
 * Run locally: `npm run check:dockerignore`. Runs in CI (lint job).
 */
import { readFileSync } from 'node:fs';

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

// Parse: drop blanks/comments, honor `!` negation, strip surrounding slashes (a trailing slash
// only marks "this is a directory" — Docker ignores it when matching).
const rules = [];
for (const raw of text.split('\n')) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const negate = line.startsWith('!');
  const pattern = (negate ? line.slice(1) : line).replace(/^\/+|\/+$/g, '');
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
  // Build output / local compiler caches
  'dist/main.js',
  'dashboard/dist/index.html',
  'tsconfig.tsbuildinfo',
  // Test coverage
  'coverage/lcov.info',
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
  'dashboard/package.json',
  'dashboard/package-lock.json',
  'dashboard/index.html',
  'dashboard/vite.config.ts',
  'dashboard/src/main.tsx',
  'scripts/postinstall.js',
  'scripts/patch-wwebjs-201832.js',
  'scripts/patch-wwebjs-newsletter-preview.js',
  'scripts/patch-wwebjs-status.js',
  'scripts/patch-wwebjs-ready-sync.js',
  'scripts/wwebjs-201832.patch',
  'docker-entrypoint.sh',
  'docs/01-project-overview.md',
];

const errors = [];
for (const path of mustReject) {
  if (!ignored(path)) {
    errors.push(`.dockerignore does not reject '${path}' — it would leak into the Docker build context/cache/layers.`);
  }
}
for (const path of mustKeep) {
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
console.log(`✓ Docker-context check OK (${rules.length} .dockerignore rules, ${mustReject.length} rejected / ${mustKeep.length} kept paths asserted).`);
