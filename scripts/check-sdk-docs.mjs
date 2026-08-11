#!/usr/bin/env node
/**
 * SDK documentation-coverage guard.
 *
 * The SDK surface is enumerated at six independent hand-maintained prose sites while the shipped
 * surface lives in `sdk/javascript/src/resources/*.ts`. Nothing bound the two, so fourteen feature
 * commits drifted them: seven edited only the §18.1 summary row and left the three per-language
 * tables behind, and seven never touched `docs/18` at all — which is how server-side media
 * conversion, presence subscription and session config came to ship in all five clients while the
 * document that calls itself the authoritative surface said they did not exist.
 *
 * The drift was strictly one-directional, so nobody was misled toward a method that does not exist.
 * They were misled away from a dozen that do, and either re-implemented them through
 * `client.request()` or judged the gateway feature unusable.
 *
 * SCOPE, stated so the guarantee is not read wider than it is:
 *   - Method-level for the five sites that enumerate methods: `docs/18` §18.1 and its §18.2/§18.3/
 *     §18.4 per-language tables, and `sdk/README.md`'s Coverage table.
 *   - Resource-level only for `sdk/java/README.md` and `sdk/go/README.md`, which list resources and
 *     deliberately delegate their method tables (docs/18 lines 12-13).
 *   - Compares the SET of names in each language's own idiom — Python snake_case, everyone else
 *     camelCase. It does NOT check signatures, descriptions or **OPERATOR** annotations, which carry
 *     information that exists nowhere else and cannot be derived from the source.
 *   - ONE DIRECTION ONLY: shipped → documented. Every failure it can report ends in "which the
 *     client ships". The reverse — a documented method that no client ships — is a false promise and
 *     arguably worse than an omission, but nothing here detects it; do not read a green run as
 *     evidence that the docs promise nothing extra.
 *
 * Lives in ci.yml's lint job rather than sdk-ci.yml for the same reason as the route and event
 * guards: sdk-ci is path-filtered, so a docs-only PR runs none of it.
 *
 * Run locally: `npm run check:sdk-docs`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');

const RESOURCE_DIR = 'sdk/javascript/src/resources';

/** Resources whose per-language tables are headed by a name other than the file's. */
const SECTION_SUFFIX = /\s*_\([^)]*\)_\s*$/;

/** `getQrCode` -> `get_qr_code`, the spelling the Python client ships. */
export const snake = name => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/**
 * Summary tables abbreviate families of methods, in two idioms: a shared suffix
 * (`add/remove/promote/demoteParticipants`) and a shared prefix (`sendImage/Video/Audio`). Expanding
 * both is what lets the tables stay readable without the guard reporting a wall of false gaps.
 */
export function methodsInSummaryCell(cell) {
  const found = new Set();
  for (const token of cell
    .replace(/_\([^)]*\)_/g, '')
    .split(/[,\s]+/)
    .filter(Boolean)) {
    const name = token.replace(/`/g, '');
    if (!/^[A-Za-z][A-Za-z0-9/]*$/.test(name)) continue;
    if (!name.includes('/')) {
      found.add(name);
      continue;
    }
    const parts = name.split('/');
    const first = parts[0];
    const last = parts[parts.length - 1];
    found.add(first);
    found.add(last);
    const tailAt = last.search(/[A-Z]/);
    if (tailAt > 0) for (const part of parts.slice(0, -1)) found.add(part + last.slice(tailAt));
    const headAt = first.search(/[A-Z]/);
    if (headAt > 0) for (const part of parts.slice(1)) found.add(first.slice(0, headAt) + part);
  }
  return found;
}

/** The `| \`resource\` | methods |` row of a summary table, or null when the resource has no row. */
export function summaryRow(text, resource) {
  const row = text.match(new RegExp(`^\\|\\s*\`${resource}\`\\s*\\|([^\\n]*)\\|`, 'm'));
  return row ? methodsInSummaryCell(row[1]) : null;
}

/** The first-column method names of a `#### \`resource\`` table, or null when the section is absent. */
export function sectionMethods(text, heading) {
  const start = text.search(new RegExp(`^#### \`${heading}\``, 'm'));
  if (start === -1) return null;
  // Resume after the heading's own line: slicing one character in would leave `###` at position 0,
  // where the next-heading search matches immediately and every table reads as empty.
  const rest = text.slice(text.indexOf('\n', start) + 1);
  const end = rest.search(/^#{3,4} /m);
  const table = end === -1 ? rest : rest.slice(0, end);
  return new Set([...table.matchAll(/^\|\s*`([A-Za-z_][A-Za-z0-9_]*)`\s*\|/gm)].map(m => m[1]));
}

/** Slice a document between two headings, so §18.2's `#### \`sessions\`` is not read as §18.4's. */
export function slice(text, from, to) {
  const start = text.indexOf(from);
  if (start === -1) return '';
  const end = to ? text.indexOf(to, start + from.length) : -1;
  return end === -1 ? text.slice(start) : text.slice(start, end);
}

/** Harvest the shipped surface: resource name -> public method names, in declaration order. */
export function harvestShipped(dir = RESOURCE_DIR) {
  const shipped = new Map();
  for (const file of readdirSync(join(root, dir)).sort()) {
    if (!file.endsWith('.ts')) continue;
    const source = read(dir, file)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const body = source.slice(source.indexOf('export class'));
    const methods = [
      ...body.matchAll(/^ {2}(?!constructor\b|private\b|readonly\b|static\b)([a-zA-Z][A-Za-z0-9]*)\s*[(<]/gm),
    ];
    shipped.set(file.replace(/\.ts$/, ''), [...new Set(methods.map(m => m[1]))]);
  }
  return shipped;
}

function main() {
  const shipped = harvestShipped();

  const totalMethods = [...shipped.values()].reduce((n, m) => n + m.length, 0);
  const errors = [];

  // A pattern that silently stopped matching would make this gate vacuous, so an implausibly small
  // harvest is a failure rather than a pass. The per-resource check is the one that matters: drift
  // arrives one restyled file at a time, and a single resource falling to zero barely moves the
  // total — the guard would report a clean pass over a resource it had stopped reading entirely.
  const unharvested = [...shipped].filter(([, methods]) => methods.length === 0).map(([name]) => name);
  if (shipped.size < 10 || totalMethods < 100 || unharvested.length) {
    console.error(
      `\n✖ harvested ${shipped.size} resources / ${totalMethods} methods from ${RESOURCE_DIR} — the scan pattern has drifted.`,
    );
    if (unharvested.length) console.error(`  no methods found in: ${unharvested.join(', ')}`);
    console.error('');
    process.exit(1);
  }

  const doc18 = read('docs/18-sdk-design.md');
  const SITES = [
    {
      label: 'docs/18 §18.1 Resource Coverage',
      text: slice(doc18, '## 18.1 Overview', '## 18.2 '),
      lookup: (text, resource) => summaryRow(text, resource),
      missingSection: resource => `\`${resource}\` has no row (${shipped.get(resource).length} methods ship)`,
    },
    {
      label: 'docs/18 §18.2 (JavaScript)',
      text: slice(doc18, '## 18.2 ', '## 18.3 '),
      lookup: (text, resource) => sectionMethods(text, resource),
      missingSection: resource => `no \`#### ${resource}\` section`,
    },
    {
      label: 'docs/18 §18.3 (Python)',
      text: slice(doc18, '## 18.3 ', '## 18.4 '),
      lookup: (text, resource) => sectionMethods(text, `client\\.${resource}`),
      spell: snake,
      missingSection: resource => `no \`#### client.${resource}\` section`,
    },
    {
      label: 'docs/18 §18.4 (PHP)',
      text: slice(doc18, '## 18.4 ', '## 18.5 '),
      lookup: (text, resource) => sectionMethods(text, resource),
      missingSection: resource => `no \`#### ${resource}\` section`,
    },
    {
      label: 'sdk/README.md Coverage',
      text: slice(read('sdk/README.md'), '## Coverage', '\n## '),
      lookup: (text, resource) => summaryRow(text, resource),
      missingSection: resource => `\`${resource}\` has no row (${shipped.get(resource).length} methods ship)`,
    },
  ];

  for (const site of SITES) {
    const spell = site.spell ?? (name => name);
    for (const [resource, methods] of shipped) {
      const documented = site.lookup(site.text, resource.replace(SECTION_SUFFIX, ''));
      if (documented === null) {
        errors.push(`${site.label}: ${site.missingSection(resource)}.`);
        continue;
      }
      for (const method of methods) {
        if (!documented.has(spell(method))) {
          errors.push(`${site.label}: \`${resource}\` omits \`${spell(method)}\`, which the client ships.`);
        }
      }
    }
  }

  // Resource-level only: these two delegate their method tables to the language's own idiom.
  const RESOURCE_LISTS = [
    {
      label: 'sdk/java/README.md',
      text: slice(read('sdk/java/README.md'), '## Resources', '\n## '),
      token: r => `\`${r}\``,
    },
    {
      label: 'sdk/go/README.md',
      text: read('sdk/go/README.md'),
      token: r => `client.${r.charAt(0).toUpperCase()}${r.slice(1)}`,
    },
  ];
  for (const list of RESOURCE_LISTS) {
    for (const resource of shipped.keys()) {
      if (!list.text.includes(list.token(resource))) {
        errors.push(`${list.label}: does not list \`${resource}\`, which the client ships.`);
      }
    }
  }

  if (errors.length) {
    console.error('\n✖ SDK docs do not cover the shipped client surface:');
    for (const e of errors) console.error(`  - ${e}`);
    console.error(`\n${errors.length} finding(s). Document the method, or remove it from the client.\n`);
    process.exit(1);
  }
  console.log(
    `✓ SDK docs cover every shipped client method (${totalMethods} methods across ${shipped.size} resources).`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
