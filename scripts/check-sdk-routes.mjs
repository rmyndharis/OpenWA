#!/usr/bin/env node
/**
 * SDK route guard.
 *
 * No gate anywhere compared an SDK to the committed contract. Every SDK suite asserts the URL the
 * SDK itself constructed against a mock transport, so the oracle is circular: rename a route on the
 * server and `openapi:check` fails while all five SDK suites stay green and ship a 404. This closes
 * the cheap half of that gap — every route literal an SDK builds must exist as a path in
 * openapi.json.
 *
 * SCOPE, stated so the guarantee is not read wider than it is:
 *   - Covers JavaScript, PHP and Python, which write their paths as literals a scan can find.
 *   - Does NOT cover Go or Java: both assemble paths by concatenating a base with a suffix, so there
 *     is no literal to harvest. A drift there is invisible to this gate.
 *   - Checks that a route EXISTS, not that its method, request shape or response shape match.
 *
 * Lives in ci.yml's lint job rather than sdk-ci.yml on purpose: sdk-ci is path-filtered and does not
 * list openapi.json, so changing the contract alone runs none of it — and it never runs on a release
 * tag at all.
 *
 * Run locally: `npm run check:sdk-routes`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL.pathname: the latter stays percent-encoded, so a checkout under a path
// containing a space resolves to a directory that does not exist and every read here fails with
// ENOENT. check-sdk-docs.mjs and check-chart-behaviour.mjs already resolve it this way.
const root = fileURLToPath(new URL('../', import.meta.url));

/** Every interpolation form the three SDKs use collapses to the same wildcard as an OpenAPI param. */
const normalize = (path) =>
  path
    .replace(/\$\{[^}]*\}/g, '*') // JavaScript `${...}` and PHP "{$...}" once the $ is consumed below
    .replace(/\{[^}]*\}/g, '*') // Python f-string `{...}` and OpenAPI `{param}`
    .replace(/\/+$/, '');

const walk = (dir, exts, out = []) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'vendor' || entry === 'dist' || entry === '__pycache__') continue;
      walk(full, exts, out);
    } else if (exts.some((e) => entry.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
};

// Source directories only — test files assert against fixtures and may legitimately name paths the
// package never builds.
const SDKS = [
  { name: 'javascript', dir: 'sdk/javascript/src', exts: ['.ts'], re: /`(\/api\/[^`]*)`/g },
  { name: 'php', dir: 'sdk/php/src', exts: ['.php'], re: /["'](\/api\/[^"']*)["']/g },
  { name: 'python', dir: 'sdk/python/openwa', exts: ['.py'], re: /["'](\/api\/[^"']*)["']/g },
];

/**
 * Literals whose interpolated segment is a whole path PIECE rather than a single id, so the
 * normalised form cannot match a concrete contract path. Each needs a reason, not just an entry.
 */
const ALLOWED = new Map([
  ['/api/sessions/*/messages/*', 'the send-* family shares one builder; the verb itself is the variable'],
]);

const contract = JSON.parse(readFileSync(join(root, 'openapi.json'), 'utf8'));
const known = new Set(Object.keys(contract.paths).map(normalize));

const errors = [];
let scanned = 0;

for (const sdk of SDKS) {
  const found = new Set();
  for (const file of walk(join(root, sdk.dir), sdk.exts)) {
    // Comments are stripped first: docblocks describe routes in prose (and in Express `:id` notation,
    // which is not the contract's `{id}`), so scanning them reports drift that does not exist.
    const src = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*(\/\/|#).*$/gm, '');
    for (const m of src.matchAll(sdk.re)) found.add(normalize(m[1]));
  }
  // A pattern that silently stops matching would make this gate vacuous, so an empty harvest is a
  // failure rather than a pass.
  if (found.size < 20) {
    errors.push(`${sdk.name}: harvested only ${found.size} route literals from ${sdk.dir} — the scan pattern has drifted.`);
    continue;
  }
  scanned += found.size;
  for (const route of [...found].sort()) {
    if (known.has(route) || ALLOWED.has(route)) continue;
    errors.push(`${sdk.name}: builds ${route}, which is not a path in openapi.json.`);
  }
}

if (errors.length) {
  console.error('\n✖ SDK routes drifted from the committed contract:');
  for (const e of errors) console.error(`  - ${e}`);
  console.error('\nRegenerate the contract (`npm run openapi:export`) or fix the SDK path.\n');
  process.exit(1);
}
console.log(`✓ SDK routes OK (${scanned} literals across ${SDKS.length} SDKs against ${known.size} contract paths).`);
