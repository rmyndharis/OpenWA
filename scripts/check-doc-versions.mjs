#!/usr/bin/env node
/**
 * Version-consistency guard.
 *
 * Stops the recurring "we cut a release but a doc still shows the old version" problem by failing
 * CI when a *current-version* reference drifts from package.json. It does NOT touch historical
 * version mentions (CHANGELOG history, roadmap milestones, example image tags) — only the three
 * places that must always reflect the shipped version:
 *
 *   1. The README version badges (root + docs/) must be the DYNAMIC shields endpoint that reads
 *      package.json automatically — never a hardcoded `badge/version-x.y.z`.
 *   2. src/config/swagger.config.ts must source the version from package.json — never `setVersion('x.y.z')`.
 *   3. CHANGELOG.md must carry a `## [<current version>]` entry (the release notes exist).
 *
 * Run locally: `npm run check:versions`. Runs in CI (lint job).
 */
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');

const version = JSON.parse(read('package.json')).version;
const errors = [];

// 1) README badges must be dynamic, not a pinned `badge/version-x`.
for (const f of ['README.md', 'docs/README.md']) {
  if (/shields\.io\/badge\/version-\d/.test(read(f))) {
    errors.push(`${f}: hardcoded version badge — use the dynamic shields "github/package-json/v" badge so it tracks package.json.`);
  }
}

// 2) Swagger version must come from package.json, not a literal.
if (/setVersion\(\s*['"]\d/.test(read('src/config/swagger.config.ts'))) {
  errors.push("src/config/swagger.config.ts: hardcoded setVersion('x.y.z') — use require('../../package.json').version.");
}

// 3) CHANGELOG must have an entry for the current version.
if (!read('CHANGELOG.md').includes(`## [${version}]`)) {
  errors.push(`CHANGELOG.md: missing a "## [${version}]" entry for the current package.json version — add the release notes before tagging.`);
}

if (errors.length) {
  console.error(`\n✖ Version consistency check failed (package.json = ${version}):`);
  for (const e of errors) console.error(`  - ${e}`);
  console.error('\nFix the above so docs track the release automatically, then re-run `npm run check:versions`.\n');
  process.exit(1);
}
console.log(`✓ Version consistency OK (package.json = ${version}).`);
