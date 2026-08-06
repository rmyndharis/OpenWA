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
 *   4. The runtime/framework majors the READMEs advertise (Node, NestJS, TypeScript) must match
 *      package.json. The NestJS/TypeScript badges track it themselves via the shields
 *      `dependency-version` endpoint, but the Tech Stack table and the Node badge are plain prose —
 *      shields cannot read `engines.node` — so they are gated here instead.
 *   5. SECURITY.md must advertise the current `major.minor.x` line as supported in BOTH the
 *      current-support prose ("currently X.Y.x") and the supported-versions table row
 *      ("| X.Y.x | :white_check_mark: |"), plus the lower-bound row ("< X.Y"). Derived from
 *      package.json so a release cannot ship with a stale supported-version.
 *
 * Run locally: `npm run check:versions`. Runs in CI (lint job).
 */
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');

const pkg = JSON.parse(read('package.json'));
const version = pkg.version;
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

// 4) Runtime/framework majors advertised in the READMEs must match package.json.
const majorOf = (range) => range?.match(/(\d+)/)?.[1];
const stack = [
  ['Node', majorOf(pkg.engines?.node), /node-(\d+)_LTS|Node\.js (\d+) LTS/g],
  ['NestJS', majorOf(pkg.dependencies?.['@nestjs/core']), /NestJS[ -](\d+)\.x/g],
  ['TypeScript', majorOf(pkg.devDependencies?.typescript), /TypeScript[ -](\d+)\.x/g],
];
for (const f of ['README.md', 'docs/README.md']) {
  const text = read(f);
  for (const [name, want, pattern] of stack) {
    if (!want) continue;
    for (const m of text.matchAll(pattern)) {
      const found = m[1] ?? m[2];
      if (found !== want) {
        errors.push(`${f}: advertises ${name} ${found} but package.json declares ${want} — update the doc (or the dependency).`);
      }
    }
  }
}

// 5) SECURITY.md must advertise the current major.minor.x as the supported line.
// Derived from package.json so a release cut cannot leave the supported-version stale.
const minorMatch = version.match(/^(\d+)\.(\d+)\./);
if (minorMatch) {
  const [, major, minor] = minorMatch;
  const supportedMinor = `${major}.${minor}.x`; // e.g. "0.12.x"
  const security = read('SECURITY.md');

  // 5a) Current-support prose: "...currently X.Y.x".
  const proseRe = new RegExp(`currently ${major}\\.\\d+\\.x`);
  if (!proseRe.test(security)) {
    errors.push(
      `SECURITY.md: current-support prose does not read "(currently ${supportedMinor})" — update it to match package.json.`,
    );
  } else if (!new RegExp(`currently ${supportedMinor.replace('.', '\\.')}`).test(security)) {
    const found = security.match(new RegExp(`currently (${major}\\.\\d+\\.x)`))?.[1];
    errors.push(
      `SECURITY.md: current-support prose advertises ${found} but package.json is ${supportedMinor} — bump the supported line.`,
    );
  }

  // 5b) Supported-versions table row: "| X.Y.x | :white_check_mark: |" (whitespace-flexible for alignment).
  const tableRe = new RegExp(`^\\|\\s+${major}\\.\\d+\\.x\\s+\\|\\s+:white_check_mark:\\s+\\|`, 'm');
  if (!tableRe.test(security)) {
    errors.push(
      `SECURITY.md: supported-versions table is missing a "| ${supportedMinor} | :white_check_mark: |" row — update it to match package.json.`,
    );
  } else if (!new RegExp(`^\\|\\s+${supportedMinor.replace('.', '\\.')}\\s+\\|\\s+:white_check_mark:\\s+\\|`, 'm').test(security)) {
    const found = security.match(new RegExp(`^\\|\\s+(${major}\\.\\d+\\.x)\\s+\\|\\s+:white_check_mark:\\s+\\|`, 'm'))?.[1];
    errors.push(
      `SECURITY.md: supported-versions table row advertises ${found} but package.json is ${supportedMinor} — bump the supported line.`,
    );
  }

  // 5c) Lower-bound row: "| < X.Y | :x: |" (whitespace-flexible for alignment).
  const lowerBound = `${major}.${minor}`;
  const lowerRe = new RegExp(`^\\|\\s+<\\s+\\d+\\.\\d+\\s+\\|\\s+:x:\\s+\\|`, 'm');
  if (!lowerRe.test(security)) {
    errors.push(
      `SECURITY.md: supported-versions table is missing a "| < ${lowerBound} | :x: |" lower-bound row.`,
    );
  } else if (!new RegExp(`^\\|\\s+<\\s+${lowerBound.replace('.', '\\.')}\\s+\\|\\s+:x:\\s+\\|`, 'm').test(security)) {
    const found = security.match(new RegExp(`^\\|\\s+<\\s+(\\d+\\.\\d+)\\s+\\|\\s+:x:\\s+\\|`, 'm'))?.[1];
    errors.push(
      `SECURITY.md: supported-versions lower-bound row advertises < ${found} but package.json is ${supportedMinor} — bump the bound.`,
    );
  }
}

if (errors.length) {
  console.error(`\n✖ Version consistency check failed (package.json = ${version}):`);
  for (const e of errors) console.error(`  - ${e}`);
  console.error('\nFix the above so docs track the release automatically, then re-run `npm run check:versions`.\n');
  process.exit(1);
}
console.log(`✓ Version consistency OK (package.json = ${version}).`);
