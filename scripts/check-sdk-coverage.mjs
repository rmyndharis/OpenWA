#!/usr/bin/env node
/**
 * SDK contract-coverage guard — the reverse of check-sdk-routes.
 *
 * `check-sdk-routes` asks: does every route an SDK builds exist in the contract? That catches a
 * renamed route. It cannot catch a route the gateway publishes that no client ever got, because
 * nothing is there to scan. Ten routes reached `main` that way — five found by an audit, five more
 * found by writing this file, all of them added in the release that announced them.
 *
 * So this asks the other question: does every route the contract publishes, minus the resources
 * `sdk/README.md` declares unexposed, have a method in EVERY SDK?
 *
 * PER SDK, deliberately. A total across the five would pass while two clients were missing a route
 * three others had — which is the shape of the gap this exists to prevent. Every failure names the
 * client, not just the route.
 *
 * SCOPE, stated so the guarantee is not read wider than it is:
 *   - Asserts a route is REACHABLE from each client, not that its method, body or response match.
 *   - The exclusion list is PARSED from sdk/README.md, so the gate and the promise cannot drift.
 *
 * The harvester is deliberately GENEROUS: it over-approximates what each client builds. That is the
 * safe direction here. A gate that fails on a route the SDK does have is noise, and a noisy gate
 * gets switched off; the defect being hunted leaves no literal anywhere, so generosity cannot hide
 * it. Four rounds of narrowing false positives produced the current rules — see harvestFile.
 *
 * Run locally: `npm run check:sdk-coverage`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL.pathname: the latter stays percent-encoded, so a checkout under a path
// containing a space resolves to a directory that does not exist and every read here fails with
// ENOENT. check-sdk-docs.mjs and check-chart-behaviour.mjs already resolve it this way.
const root = fileURLToPath(new URL('../', import.meta.url));

/** Every interpolation form collapses to the same wildcard as an OpenAPI `{param}`. */
const normalize = (path) =>
  path
    .replace(/\$\{[^}]*\}/g, '*')
    .replace(/\{[^}]*\}/g, '*')
    .replace(/\*+/g, '*')
    .replace(/\/+$/, '');

const SKIP_DIRS = new Set(['node_modules', 'vendor', 'dist', '__pycache__', 'target', '.pytest_cache', 'build']);

const walk = (dir, exts, out = []) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) walk(full, exts, out);
    } else if (exts.some((e) => entry.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
};

/** Comments describe routes in prose and in `:id` notation, which is not the contract's `{id}`. */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|#).*$/gm, '');

// A chain term is a string literal, a call, or a bare identifier. Identifiers matter: Go builds
// `…/membership-requests/" + verb`, and stopping the chain at the variable would truncate the path
// to its parent and report the concrete siblings as missing.
const TERM = String.raw`(?:"[^"\n]*"|\x60[^\x60\n]*\x60|[A-Za-z_][\w.]*\([^()]*\)|[A-Za-z_]\w*)`;
const CHAIN = new RegExp(`${TERM}(?:\\s*\\+\\s*${TERM})*`, 'g');

/**
 * Every path shape the five clients build, over-approximated.
 *
 * `baseValue` is a resolved `…Service.base()` body (Go). Each rule exists because its absence
 * produced a false positive:
 *   (a) quoted literals in any quote style — the JS client writes some paths in single quotes, and
 *       a backtick-only scan silently skips them (the shipped forward gate still does).
 *   (b) `+`-chains — Java and Go assemble paths rather than writing them whole.
 *   (c) base plus a bare suffix, with and without an interposed id segment — Go's per-service
 *       helpers take `"/read"` or `"reply"` and the caller never names the whole path.
 *   (d) adjacent literals — Python's implicit concatenation splits one path across two lines.
 */
function harvestFile(source, baseValue, families = new Set()) {
  const found = new Set();
  const flat = strip(source).replace(/\s*\n\s*/g, ' ');

  for (const m of flat.matchAll(/["'`](\/api\/[^"'`\n]*)["'`]/g)) {
    const shape = normalize(m[1]); // (a)
    found.add(shape);
    // A literal whose final segment is an interpolation is one builder serving a family — the
    // send-<verb> shape. Same standing as a chain ending in a variable, and unlike (c)'s synthesis.
    if (shape.endsWith('/*') && /[$}]/.test(m[1].slice(-6))) families.add(shape);
  }

  for (const m of flat.matchAll(CHAIN)) {
    const parts = m[0]
      .split('+')
      .map((t) => t.trim())
      .map((t) => {
        const literal = /^(?:"([^"]*)"|`([^`]*)`)$/.exec(t);
        if (literal) return literal[1] ?? literal[2];
        if (/\.\w*[Bb]ase\(/.test(t)) return baseValue;
        return '*';
      });
    if (parts.some((p) => p == null)) continue;
    const path = parts.join('');
    if (!path.startsWith('/api/')) continue;
    const shape = normalize(path);
    found.add(shape); // (b)
    // Only a chain whose FINAL term was a variable stands in for its concrete siblings — that is a
    // real one-builder family. A wildcard synthesised by (c) is an artefact and must not.
    if (shape.endsWith('/*') && !/^(?:"|`)/.test(m[0].split('+').pop().trim())) families.add(shape);
  }

  if (baseValue) {
    // Only genuine path suffixes. An earlier version synthesised from ANY lowercase literal, which
    // manufactured `<base>/audio`, `<base>/POST` and — from the bare `"/"` separator — `<base>/*`,
    // and that last one made every single-segment route under a Go service base undetectable.
    for (const m of flat.matchAll(/["'`](\/[a-z0-9][\w.-]*(?:\/[a-z0-9][\w.-]*)*)["'`]/gi)) {
      if (m[1].startsWith('/api/')) continue;
      found.add(normalize(baseValue + m[1])); // (c) helper appends directly
      found.add(normalize(`${baseValue}/*${m[1]}`)); // (c) helper interposes an id
    }
    // Go's per-service helpers take a bare verb: `s.send(ctx, sessionID, "reply", body)`. Matched as
    // a helper ARGUMENT rather than as any literal, so an unrelated string cannot become a route.
    for (const m of flat.matchAll(/\.\w+\(\s*ctx\s*,[^)]*?["`]([a-z][\w.-]*)["`]/gi)) {
      found.add(normalize(`${baseValue}/${m[1]}`));
      found.add(normalize(`${baseValue}/*/${m[1]}`));
    }
  }

  for (const m of flat.matchAll(/["'`](\/api\/[^"'`\n]*)["'`]\s*["'`]([^"'`\n]*)["'`]/g)) {
    found.add(normalize(m[1] + m[2])); // (d)
  }
  return found;
}

/** Go resolves `base()`-style helpers first so the suffixes its callers pass can be reattached. */
function harvestGo(dir) {
  const exact = new Set();
  const families = new Set();
  for (const file of walk(dir, ['.go']).filter((f) => !f.endsWith('_test.go'))) {
    const source = strip(readFileSync(file, 'utf8'));
    const bases = [null];
    for (const helper of source.matchAll(/func \(s \*\w+Service\) \w+\([^)]*\) string \{\s*return ([^\n]+)\n/g)) {
      const base = normalize(
        helper[1]
          .split('+')
          .map((t) => t.trim())
          .map((t) => /^"([^"]*)"$/.exec(t)?.[1] ?? '*')
          .join(''),
      );
      if (base.startsWith('/api/')) bases.push(base);
    }
    for (const base of bases) for (const p of harvestFile(source, base, families)) exact.add(p);
  }
  return { exact, families };
}

const SDKS = [
  { name: 'javascript', dir: 'sdk/javascript/src', exts: ['.ts'] },
  { name: 'python', dir: 'sdk/python/openwa', exts: ['.py'] },
  { name: 'php', dir: 'sdk/php/src', exts: ['.php'] },
  { name: 'java', dir: 'sdk/java/src/main', exts: ['.java'] },
  { name: 'go', dir: 'sdk/go', exts: ['.go'], harvest: harvestGo },
];

/**
 * The resources sdk/README.md declares deliberately unexposed, read from the README rather than
 * restated here: a hand-copied second list is the thing this whole line of work keeps finding.
 */
function excludedResources() {
  const readme = readFileSync(join(root, 'sdk/README.md'), 'utf8');
  const start = readme.indexOf('Deliberately **not** exposed');
  const end = readme.indexOf('Everything else the gateway publishes', start);
  if (start < 0 || end < 0) {
    throw new Error('sdk/README.md: could not find the "Deliberately not exposed" paragraph — the gate cannot derive its exclusion list.');
  }
  const names = [...readme.slice(start, end).matchAll(/`([^`]+)`/g)].map((m) => m[1].split('/')[0].trim());
  if (names.length < 8) throw new Error(`sdk/README.md: parsed only ${names.length} excluded resources, expected the full list.`);
  return new Set(names);
}

// The resource a path belongs to: the segment after `/api/`, or after a session id.
const resourceOf = (path) =>
  /^\/api\/sessions\/\*\/([^/]+)/.exec(path)?.[1] ?? /^\/api\/([^/*]+)/.exec(path)?.[1] ?? '';

/**
 * A harvested path whose final segment is a wildcard MAY cover its concrete siblings: the client
 * reaches that family through one builder with the last segment as a variable (`send-${type}`).
 * The forward gate makes the same concession explicitly.
 *
 * But only when the wildcard is a route NAME. A client that builds `…/contacts/${contactId}` also
 * produces `…/contacts/*`, and reading that as a family let it stand in for every concrete sibling
 * — `contacts/blocked` among them — so removing a route from a client entirely still passed. The
 * two cases are told apart by the contract itself: if it publishes a route OF THAT SHAPE, the
 * wildcard is that route's path parameter and covers nothing but it (which `exact` already does).
 * `…/messages/*` is published by no route, so a wildcard there can only be a verb.
 */
const isRouteNameFamily = (family) => !contractShapes.has(family);
const covers = (built, path) => {
  if (built.exact.has(path)) return true;
  const family = path.replace(/\/[^/]+$/, '/*');
  return isRouteNameFamily(family) && built.families.has(family);
};

const excluded = excludedResources();
const contract = [...new Set(Object.keys(JSON.parse(readFileSync(join(root, 'openapi.json'), 'utf8')).paths).map(normalize))];
/** Every shape the contract publishes, including the excluded resources — a wildcard is explained by
 *  a by-id route whether or not the SDKs are asked to expose it. */
const contractShapes = new Set(contract);
const inScope = contract.filter((p) => {
  const resource = resourceOf(p);
  return !excluded.has(resource) && !excluded.has(resource.replace(/-rules$/, ''));
});

const errors = [];
const built = {};

for (const sdk of SDKS) {
  const dir = join(root, sdk.dir);
  built[sdk.name] = sdk.harvest
    ? sdk.harvest(dir)
    : (() => {
        const exact = new Set();
        const families = new Set();
        for (const file of walk(dir, sdk.exts)) for (const p of harvestFile(readFileSync(file, 'utf8'), null, families)) exact.add(p);
        return { exact, families };
      })();

  // Non-vacuity, PER SDK. A scan that stopped matching yields an empty set, and an empty set makes
  // every "is this route covered" question answer no — loudly — but a harvest that collapsed to a
  // handful would instead report most of the contract as missing and read as a catastrophe rather
  // than a broken scan. Fail here, naming the client, before any coverage claim is made from it.
  if (built[sdk.name].exact.size < 40) {
    errors.push(`${sdk.name}: harvested only ${built[sdk.name].exact.size} route shapes from ${sdk.dir} — the scan has drifted, so its coverage cannot be trusted.`);
  }
}

if (!errors.length) {
  for (const path of inScope.sort()) {
    const missing = SDKS.map((s) => s.name).filter((name) => !covers(built[name], path));
    if (missing.length) errors.push(`${path} — published by the gateway, built by no method in: ${missing.join(', ')}`);
  }
}

if (errors.length) {
  console.error('\n✖ The contract publishes routes the SDKs do not expose:');
  for (const e of errors) console.error(`  - ${e}`);
  console.error('\nsdk/README.md promises that everything outside its excluded set is exposed.');
  console.error('Add the client method, or add the resource to that list with a reason.\n');
  process.exit(1);
}
console.log(`✓ SDK contract coverage OK (${inScope.length} in-scope contract paths reachable from all ${SDKS.length} clients).`);
