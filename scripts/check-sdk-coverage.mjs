#!/usr/bin/env node
/**
 * SDK contract-coverage guard — the reverse of check-sdk-routes.
 *
 * `check-sdk-routes` asks: does every route an SDK builds exist in the contract? That catches a
 * renamed route. It cannot catch a route the gateway publishes that no client ever got, because
 * nothing is there to scan. Ten routes reached `main` that way, all of them added in the release
 * that announced them.
 *
 * So this asks the other question: does every route the contract publishes, minus the resources
 * `sdk/README.md` declares unexposed, have a method in EVERY SDK?
 *
 * PER SDK, deliberately. A total across the five would pass while two clients were missing a route
 * three others had — which is the shape of the gap this exists to prevent. Every failure names the
 * client, not just the route.
 *
 * SCOPE, stated so the guarantee is not read wider than it is:
 *   - Asserts a route is REACHABLE from each client, that each verb of a multi-verb route is built,
 *     and that no verb/path pair the verb scan harvests uses a verb the contract does not declare;
 *     not that its body or response match. A call the scan cannot pair with its path (the messages
 *     send-<type> helpers, binary downloads, Go's service helpers and `path :=` variables) is not
 *     verb-checked, so a wrong verb on a single-verb route built that way passes.
 *   - Every query parameter an in-scope operation declares is sent by at least one call to it in each
 *     client (not by every method that calls it), and no call sends a key its operation does not
 *     declare; the known gaps are data (see QUERY_GAPS). A PHP method that passes its own array
 *     parameter through sends whatever its caller gives it, so it counts as sending them all.
 *   - The exclusion list is PARSED from sdk/README.md, so the gate and the promise cannot drift.
 *
 * The harvester is deliberately GENEROUS: it over-approximates what each client builds. That is the
 * safe direction here. A gate that fails on a route the SDK does have is noise, and a noisy gate
 * gets switched off; the defect being hunted leaves no literal anywhere, so generosity cannot hide
 * it. Four rounds of narrowing false positives produced the current rules — see harvestFile.
 * Except through a wildcard: a builder whose last segment is a variable reaches only the names its
 * callers pass, which FAMILY_CALLS reads.
 *
 * Run locally: `npm run check:sdk-coverage`.
 */
import { readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isUnexposedPath, unexposedResources } from './check-contract-shapes.mjs';

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
}

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
 *   (a) quoted literals in any quote style — the JS client writes some paths in single quotes, which
 *       a backtick-only scan silently skips. The forward gate (check-sdk-routes.mjs) was blind to
 *       exactly those nine literals until it was widened to match this one.
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
    // Only a chain whose FINAL term was a variable is a real one-builder family, whose siblings
    // FAMILY_CALLS may then reach. A wildcard synthesised by (c) is an artefact and must not.
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
 * A harvested path whose final segment is a wildcard is a family: one builder with the last segment
 * as a variable (`send-${type}`). When the contract publishes a route OF THAT SHAPE, the wildcard is
 * that route's path parameter (`…/contacts/${contactId}`) and covers nothing but it, which `exact`
 * already holds. Otherwise the wildcard is a route NAME, and it covers only the names the client's
 * callers pass to that builder, harvested by the call patterns below. The wildcard itself never
 * stands in for a sibling: it did, and then a client that dropped `messages/react`, or a new
 * `messages/<name>` route no client built, passed for every client.
 *
 * A name family missing here fails closed: its routes are reported, naming the builder to add.
 */
const isRouteNameFamily = (family) => !contractShapes.has(family);
const FAMILY_CALLS = {
  '/api/sessions/*/messages/*': {
    javascript: /\.sendMedia\(\s*\w+\s*,\s*['"`]([\w-]+)['"`]/g,
    python: /\._send_media\(\s*\w+\s*,\s*["']([\w-]+)["']/g,
    php: /->sendMedia\(\s*\$\w+\s*,\s*["']([\w-]+)["']/g,
    java: /\bsendMedia\(\s*\w+\s*,\s*"([\w-]+)"/g,
    // Go's send(ctx, id, "<name>") helper is read by harvestFile's helper-argument rule (c) instead.
  },
  '/api/sessions/*/groups/*/membership-requests/*': {
    go: /\.membershipRequestAction\(\s*ctx\s*,\s*\w+\s*,\s*\w+\s*,\s*"([\w-]+)"/g,
  },
};
const covers = (built, path) => built.exact.has(path);

// Read the way the shape gate reads it (entries as written, a parenthetical ignored, `auth/api-keys` a path
// prefix): cutting every entry to its first segment made all of /api/auth unexposed, key validation included.
const excluded = unexposedResources(readFileSync(join(root, 'sdk/README.md'), 'utf8'));
const contract = [...new Set(Object.keys(JSON.parse(readFileSync(join(root, 'openapi.json'), 'utf8')).paths).map(normalize))];
/** Every shape the contract publishes, including the excluded resources — a wildcard is explained by
 *  a by-id route whether or not the SDKs are asked to expose it. */
const contractShapes = new Set(contract);
const inScope = contract.filter((p) => !isUnexposedPath(p, excluded));

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

  // A name family reaches the routes its builder's callers name, and only while the client still builds it.
  for (const family of [...built[sdk.name].families].filter(isRouteNameFamily)) {
    const call = FAMILY_CALLS[family]?.[sdk.name];
    if (!call) continue;
    for (const file of walk(dir, sdk.exts).filter((f) => !f.endsWith('_test.go'))) {
      for (const m of strip(readFileSync(file, 'utf8')).matchAll(call)) {
        built[sdk.name].exact.add(family.replace(/\*$/, m[1]));
      }
    }
  }

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
  for (const sdk of SDKS) {
    const unread = [...built[sdk.name].families].filter((f) => isRouteNameFamily(f) && !FAMILY_CALLS[f]?.[sdk.name]);
    for (const family of unread) {
      if (inScope.some((p) => !covers(built[sdk.name], p) && p.replace(/\/[^/]+$/, '/*') === family)) {
        errors.push(
          `${sdk.name} builds ${family} from a variable: if it serves a route above, add its calls to FAMILY_CALLS`,
        );
      }
    }
  }
}


// ─── Verb layer ──────────────────────────────────────────────────────────────────────────────
// The path layer above proves each client REACHES a route; a shared path can still miss a VERB
// entirely; the profile-picture route carried PUT in every client while its DELETE shipped in
// none, and the path gate stayed green because the PUT satisfied it. This layer asks the verb
// question in both directions. For every contract path published with MORE THAN ONE verb, each
// client must build that path with every verb the contract declares on it. And every verb a client
// builds on a contract path must be one the contract declares there, which is what covers the
// single-verb paths: the path layer only proves the path is reached, never with which verb. That
// second check sees only the pairs harvested below; a call the scan cannot pair with its path (see
// the SCOPE note at the top) is not checked.
const VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/** Join a concatenated path expression: literals verbatim, code between them becomes a `*`. */
const literalsToPath = (expr) => {
  let path = '';
  let last = 0;
  for (const m of expr.matchAll(/["'`](\/[^"'`\n]*)["'`]/g)) {
    const between = expr.slice(last, m.index);
    if (path && /\S/.test(between.replace(/["'`+\s]+/g, ''))) path += '*';
    else if (!path && /\S/.test(between.replace(/\s+/g, ''))) path += '*';
    path += m[1];
    last = m.index + m[0].length;
  }
  // Trailing code after the LAST literal (`"/api/sessions/" + encodeSegment(id)`) is an id segment too.
  const trailing = expr.slice(last).replace(/["'`+\s,;)\n]+/g, '');
  if (path && trailing) path += '*';
  return path.startsWith('/api/') ? path : null;
};

/** Go resolves its base() helpers so `s.base(sessionID)+"/picture"` reattaches to a real path. */
const goVerbPairs = (dir) => {
  const pairs = new Set();
  for (const file of walk(dir, ['.go']).filter((f) => !f.endsWith('_test.go'))) {
    const source = strip(readFileSync(file, 'utf8'));
    const bases = new Map();
    for (const helper of source.matchAll(/func \(s \*\w+Service\) (\w+)\([^)]*\) string \{\s*return ([^\n]+)\n/g)) {
      const base = normalize(
        helper[2].split('+').map((t) => t.trim()).map((t) => /^"([^"]*)"$/.exec(t)?.[1] ?? '*').join(''),
      );
      if (base.startsWith('/api/')) bases.set(helper[1], base);
    }
    // Wrapper helpers route the verb through a parameter (`s.participants(ctx, "POST", ..., "/participants")`),
    // so the do() site only sees a variable. Harvest the verb + suffix literal from the wrapper call
    // and pair it with the file's service bases (base+suffix and base/*+suffix), same generosity as
    // the path layer's helper-argument rule.
    for (const m of source.matchAll(/\.\w+\(\s*ctx\s*,\s*"(GET|POST|PUT|PATCH|DELETE)"\s*,[^)]*?"(\/[a-z0-9][\w.\/-]*)"/g)) {
      for (const base of bases.values()) {
        pairs.add(`${m[1]} ${normalize(base + m[2])}`);
        pairs.add(`${m[1]} ${normalize(`${base}/*${m[2]}`)}`);
      }
    }
    for (const m of source.matchAll(/\.do\(\s*ctx\s*,\s*"(GET|POST|PUT|PATCH|DELETE)"\s*,\s*([^\n]+?),\s*(?:nil|[A-Za-z_&])/g)) {
      const expr = m[2]
        .split('+')
        .map((t) => t.trim())
        .map((t) => {
          const lit = /^"([^"]*)"$/.exec(t)?.[1];
          if (lit !== undefined) return lit;
          const helper = /^s\.(\w+)\(/.exec(t)?.[1];
          if (helper && bases.has(helper)) return bases.get(helper);
          return '*';
        })
        .join('');
      if (expr.startsWith('/api/')) pairs.add(`${m[1]} ${normalize(expr)}`);
    }
  }
  return pairs;
};

/**
 * Python splits one path across adjacent literals (`f"/api/sessions/{a}/groups/{b}"` then
 * `"/membership-requests/approve"`), which it concatenates implicitly; join them.
 */
export const joinPythonLiterals = (expr) => [...expr.matchAll(/"([^"]*)"/g)].map((m) => m[1]).join('');

/** The `VERB path` pairs a client builds on a contract path that does not declare that verb. */
export function undeclaredVerbPairs(sdkName, pairs, specByPath) {
  const out = [];
  for (const pair of pairs) {
    const [verb, path] = pair.split(' ');
    const operations = specByPath.get(path);
    if (operations && !operations[verb.toLowerCase()]) out.push(`${verb} ${path}: built by ${sdkName}, not declared by the contract`);
  }
  return out;
}

/**
 * Stale routes built by Go or Java clients that no longer exist in the OpenAPI contract. Every call
 * whose path resolves is also added to `querySites` with its query argument, for the query layer.
 */
export function staleRouteErrors(sdkName, dir, specByPath, contractShapes, querySites = []) {
  const out = [];
  const quoteOpts = { allowBacktick: sdkName === 'go', allowSingleQuote: true };
  const hasContractOrPrefix = (shape) => {
    if (contractShapes.has(shape)) return true;
    const prefix = `${shape}/`;
    for (const c of contractShapes) {
      if (c.startsWith(prefix)) return true;
    }
    return false;
  };
  const isCheckedRouteFamily = (path) => isRouteNameFamily(path) && Boolean(FAMILY_CALLS[path]?.[sdkName]);

  const skipStringLiteral = (src, i, opts = quoteOpts) => {
    const q = src[i];
    if (q !== '"' && !(opts.allowBacktick && q === '`') && !(opts.allowSingleQuote && q === "'")) return i;
    for (let j = i + 1; j < src.length; j++) {
      if (q !== '`' && src[j] === '\\') {
        j++;
        continue;
      }
      if (src[j] === q) return j;
    }
    return src.length - 1;
  };

  const stripInlineComments = (src, opts = quoteOpts) => {
    let cleaned = '';
    let last = 0;
    for (let i = 0; i < src.length; i++) {
      const endStr = skipStringLiteral(src, i, opts);
      if (endStr !== i) {
        i = endStr;
        continue;
      }
      if (src[i] === '/' && src[i + 1] === '/') {
        cleaned += src.slice(last, i);
        const nl = src.indexOf('\n', i + 2);
        if (nl === -1) {
          last = src.length;
          break;
        }
        last = nl;
        i = nl - 1;
      }
    }
    return cleaned + src.slice(last);
  };

  const findMatching = (src, openIdx, openCh, closeCh, limit = src.length, opts = quoteOpts) => {
    let depth = 1;
    for (let i = openIdx + 1; i < limit; i++) {
      const endStr = skipStringLiteral(src, i, opts);
      if (endStr !== i) {
        i = endStr;
        continue;
      }
      if (src[i] === openCh) depth++;
      else if (src[i] === closeCh && --depth === 0) return i;
    }
    return -1;
  };

  const readCommaArg = (src, from) => {
    let pDepth = 0;
    let bDepth = 0;
    let cDepth = 0;
    let i = from;
    for (; i < src.length; i++) {
      const endStr = skipStringLiteral(src, i);
      if (endStr !== i) {
        i = endStr;
        continue;
      }
      const ch = src[i];
      if (ch === '(') pDepth++;
      else if (ch === ')') {
        if (pDepth === 0) break;
        pDepth--;
      } else if (ch === '[') bDepth++;
      else if (ch === ']') bDepth = Math.max(0, bDepth - 1);
      else if (ch === '{') cDepth++;
      else if (ch === '}') {
        if (cDepth === 0 && pDepth === 0) break;
        cDepth = Math.max(0, cDepth - 1);
      } else if (ch === ',' && pDepth === 0 && bDepth === 0 && cDepth === 0) break;
    }
    return src.slice(from, i).trim();
  };

  const splitConcatTerms = (rawExpr) => {
    const terms = [];
    let start = 0;
    let depth = 0;
    for (let i = 0; i < rawExpr.length; i++) {
      const endStr = skipStringLiteral(rawExpr, i);
      if (endStr !== i) {
        i = endStr;
        continue;
      }
      const ch = rawExpr[i];
      if (ch === '(' || ch === '{' || ch === '[') depth++;
      else if (ch === ')' || ch === '}' || ch === ']') depth--;
      else if (ch === '+' && depth === 0) {
        terms.push(rawExpr.slice(start, i).trim());
        start = i + 1;
      }
    }
    terms.push(rawExpr.slice(start).trim());
    return terms.filter(Boolean);
  };

  const stripOuterParens = (term) => {
    let s = term.trim();
    while (s.startsWith('(') && s.endsWith(')')) {
      if (findMatching(s, 0, '(', ')') !== s.length - 1) break;
      s = s.slice(1, -1).trim();
    }
    return s;
  };

  const parseQuotedLiteral = (term) => {
    if (term.length < 2) return null;
    const q = term[0];
    if ((q !== '"' && q !== '`') || skipStringLiteral(term, 0) !== term.length - 1) return null;
    return term.slice(1, -1);
  };

  const MAX_BRANCHES = 64;
  const dedupBranches = (list) => {
    const byKey = new Map();
    for (const b of list) {
      byKey.set(`${b.usesHelperParam}:${b.expr}`, b);
      if (byKey.size >= MAX_BRANCHES) break;
    }
    return [...byKey.values()];
  };

  const resolveExprBranches = (rawExpr, locals, { bases = null, helperParamNames = null } = {}) => {
    let acc = [{ expr: '', usesHelperParam: false }];
    for (const rawTerm of splitConcatTerms(rawExpr)) {
      const term = stripOuterParens(rawTerm);
      let options;
      const lit = parseQuotedLiteral(term);
      const baseCall = bases && /^(?:[A-Za-z_]\w*\.)?(\w+)\(/.exec(term);
      if (lit !== null) {
        options = [{ expr: lit, usesHelperParam: false }];
      } else if (/^[A-Za-z_]\w*$/.test(term) && locals.has(term)) {
        options = locals.get(term);
      } else if (baseCall && bases.has(baseCall[1])) {
        options = [{ expr: bases.get(baseCall[1]), usesHelperParam: false }];
      } else if (/^[A-Za-z_]\w*$/.test(term) && helperParamNames?.has(term)) {
        options = [{ expr: '*', usesHelperParam: true }];
      } else {
        options = [{ expr: '*', usesHelperParam: false }];
      }
      const nextAcc = [];
      for (const left of acc) {
        for (const right of options) {
          nextAcc.push({
            expr: left.expr + right.expr,
            usesHelperParam: left.usesHelperParam || right.usesHelperParam,
          });
          if (nextAcc.length >= MAX_BRANCHES) break;
        }
        if (nextAcc.length >= MAX_BRANCHES) break;
      }
      acc = dedupBranches(nextAcc);
    }
    return acc;
  };

  const cloneState = (state, freshScope = false) => ({
    locals: new Map([...state.locals].map(([k, v]) => [k, [...v]])),
    declaredHere: freshScope ? new Set() : new Set(state.declaredHere),
    terminated: state.terminated,
  });

  const applyAssignment = (state, name, op, rhs, isDecl, opts) => {
    const trimmed = rhs.trim();
    if (op === '+=') {
      if (!trimmed || trimmed === '""' || trimmed === '``' || trimmed === 'null') return;
      const prior = state.locals.get(name) ?? [{ expr: '*', usesHelperParam: false }];
      const rightList = resolveExprBranches(trimmed, state.locals, opts);
      const combined = [];
      for (const left of prior) {
        for (const right of rightList) {
          combined.push({
            expr: left.expr + right.expr,
            usesHelperParam: left.usesHelperParam || right.usesHelperParam,
          });
          if (combined.length >= MAX_BRANCHES) break;
        }
        if (combined.length >= MAX_BRANCHES) break;
      }
      state.locals.set(name, dedupBranches(combined));
      return;
    }
    if (isDecl) state.declaredHere.add(name);
    if (!trimmed || trimmed === 'null') {
      state.locals.delete(name);
      return;
    }
    if (trimmed === '""' || trimmed === '``') {
      state.locals.set(name, [{ expr: '', usesHelperParam: false }]);
      return;
    }
    state.locals.set(name, dedupBranches(resolveExprBranches(trimmed, state.locals, opts)));
  };

  const mergeBranchStates = (branches, fallbackState, declaredToRestore = null) => {
    const live = branches.filter((b) => !b.terminated);
    const terminated = live.length === 0;
    const pool = terminated ? branches : live;
    const mergedLocals = new Map();
    const keys = new Set();
    for (const b of pool) {
      for (const k of b.locals.keys()) keys.add(k);
    }
    for (const k of keys) {
      if (declaredToRestore?.has(k)) {
        if (fallbackState.locals.has(k)) mergedLocals.set(k, [...fallbackState.locals.get(k)]);
        continue;
      }
      const combined = [];
      for (const b of pool) {
        const vals = b.locals.get(k);
        if (vals) combined.push(...vals);
      }
      mergedLocals.set(k, dedupBranches(combined));
    }
    return {
      locals: mergedLocals,
      declaredHere: new Set(fallbackState.declaredHere),
      terminated,
    };
  };

  const splitTopLevelSemi = (text) => {
    const parts = [];
    let start = 0;
    let pDepth = 0;
    let bDepth = 0;
    let cDepth = 0;
    for (let k = 0; k < text.length; k++) {
      const endStr = skipStringLiteral(text, k);
      if (endStr !== k) {
        k = endStr;
        continue;
      }
      const ch = text[k];
      if (ch === '(') pDepth++;
      else if (ch === ')') pDepth = Math.max(0, pDepth - 1);
      else if (ch === '[') bDepth++;
      else if (ch === ']') bDepth = Math.max(0, bDepth - 1);
      else if (ch === '{') cDepth++;
      else if (ch === '}') cDepth = Math.max(0, cDepth - 1);
      else if (ch === ';' && pDepth === 0 && bDepth === 0 && cDepth === 0) {
        parts.push(text.slice(start, k).trim());
        start = k + 1;
      }
    }
    parts.push(text.slice(start).trim());
    return parts;
  };

  const parseStmtList = (src, from, to, singleStmt = false) => {
    const nodes = [];
    let i = from;

    const skipWs = (includeSemi) => {
      while (i < to && (/\s/.test(src[i]) || (includeSemi && src[i] === ';'))) i++;
    };

    const matchKw = (kw) => {
      if (!src.startsWith(kw, i)) return false;
      const prev = src[i - 1] ?? '';
      const next = src[i + kw.length] ?? '';
      return !/[A-Za-z0-9_]/.test(prev) && !/[A-Za-z0-9_]/.test(next);
    };

    const readToOpenBrace = () => {
      let pDepth = 0;
      let bDepth = 0;
      for (let j = i; j < to; j++) {
        const endStr = skipStringLiteral(src, j);
        if (endStr !== j) {
          j = endStr;
          continue;
        }
        const ch = src[j];
        if (ch === '(') pDepth++;
        else if (ch === ')') pDepth = Math.max(0, pDepth - 1);
        else if (ch === '[') bDepth++;
        else if (ch === ']') bDepth = Math.max(0, bDepth - 1);
        else if (ch === '{' && pDepth === 0 && bDepth === 0) return j;
      }
      return -1;
    };

    const parseBraceBlock = (openIdx) => {
      const closeIdx = findMatching(src, openIdx, '{', '}', to);
      const end = closeIdx === -1 ? to : closeIdx;
      const inner = parseStmtList(src, openIdx + 1, end, false);
      i = closeIdx === -1 ? to : closeIdx + 1;
      return { kind: 'block', body: inner.nodes };
    };

    const parseSwitchBody = (openIdx) => {
      const closeIdx = findMatching(src, openIdx, '{', '}', to);
      const end = closeIdx === -1 ? to : closeIdx;
      const bodyStart = openIdx + 1;
      const labels = [];
      let pDepth = 0;
      let bDepth = 0;
      let cDepth = 0;
      for (let k = bodyStart; k < end; k++) {
        const endStr = skipStringLiteral(src, k);
        if (endStr !== k) {
          k = endStr;
          continue;
        }
        const ch = src[k];
        if (ch === '(') pDepth++;
        else if (ch === ')') pDepth = Math.max(0, pDepth - 1);
        else if (ch === '[') bDepth++;
        else if (ch === ']') bDepth = Math.max(0, bDepth - 1);
        else if (ch === '{') cDepth++;
        else if (ch === '}') cDepth = Math.max(0, cDepth - 1);
        else if (pDepth === 0 && bDepth === 0 && cDepth === 0) {
          const prev = src[k - 1] ?? '';
          const isCase = src.startsWith('case', k) && !/[A-Za-z0-9_]/.test(prev) && !/[A-Za-z0-9_]/.test(src[k + 4] ?? '');
          const isDefault =
            src.startsWith('default', k) && !/[A-Za-z0-9_]/.test(prev) && !/[A-Za-z0-9_]/.test(src[k + 7] ?? '');
          if (isCase || isDefault) {
            let m = k + (isCase ? 4 : 7);
            let lp = 0;
            while (m < end) {
              const eStr = skipStringLiteral(src, m);
              if (eStr !== m) {
                m = eStr;
                continue;
              }
              if (src[m] === '(') lp++;
              else if (src[m] === ')') lp = Math.max(0, lp - 1);
              else if (lp === 0 && src[m] === ':') {
                labels.push({ labelStart: k, stmtStart: m + 1, isDefault });
                k = m;
                break;
              } else if (lp === 0 && src.startsWith('->', m)) {
                labels.push({ labelStart: k, stmtStart: m + 2, isDefault });
                k = m + 1;
                break;
              }
              m++;
            }
          }
        }
      }
      const clauses = [];
      let hasDefault = false;
      for (let idx = 0; idx < labels.length; idx++) {
        if (labels[idx].isDefault) hasDefault = true;
        const cEnd = idx + 1 < labels.length ? labels[idx + 1].labelStart : end;
        clauses.push({ kind: 'block', body: parseStmtList(src, labels[idx].stmtStart, cEnd, false).nodes });
      }
      i = closeIdx === -1 ? to : closeIdx + 1;
      return { clauses, hasDefault };
    };

    const parseIf = () => {
      i += 2;
      skipWs(false);
      let initText = null;
      let condText = '';
      let thenNode = null;
      let elseNode = null;
      if (sdkName === 'java' && src[i] === '(') {
        const cEnd = findMatching(src, i, '(', ')', to);
        if (cEnd !== -1) {
          condText = src.slice(i + 1, cEnd).trim();
          i = cEnd + 1;
        }
        skipWs(false);
        if (src[i] === '{') {
          thenNode = parseBraceBlock(i);
        } else {
          const sub = parseStmtList(src, i, to, true);
          thenNode = sub.nodes[0] ?? null;
          i = sub.nextIdx;
        }
      } else {
        const openIdx = readToOpenBrace();
        if (openIdx === -1) return { kind: 'stmt', text: src.slice(i, to).trim() };
        const hdr = src.slice(i, openIdx).trim();
        const parts = splitTopLevelSemi(hdr);
        if (parts.length >= 2) {
          initText = parts[0];
          condText = parts.slice(1).join('; ');
        } else {
          condText = hdr;
        }
        thenNode = parseBraceBlock(openIdx);
      }
      skipWs(false);
      if (matchKw('else')) {
        i += 4;
        skipWs(false);
        if (matchKw('if')) {
          const sub = parseStmtList(src, i, to, true);
          elseNode = sub.nodes[0] ?? null;
          i = sub.nextIdx;
        } else if (src[i] === '{') {
          elseNode = parseBraceBlock(i);
        } else {
          const sub = parseStmtList(src, i, to, true);
          elseNode = sub.nodes[0] ?? null;
          i = sub.nextIdx;
        }
      }
      return { kind: 'if', initText, condText, thenNode, elseNode };
    };

    const parseLoop = (kwLen) => {
      i += kwLen;
      skipWs(false);
      let initText = null;
      let condText = '';
      let postText = null;
      let bodyNode = null;
      if (sdkName === 'java' && src[i] === '(') {
        const cEnd = findMatching(src, i, '(', ')', to);
        const hdr = cEnd === -1 ? '' : src.slice(i + 1, cEnd).trim();
        i = cEnd === -1 ? i + 1 : cEnd + 1;
        const parts = kwLen === 3 ? splitTopLevelSemi(hdr) : [hdr];
        if (kwLen === 3 && parts.length === 3) {
          [initText, condText, postText] = parts;
        } else {
          condText = hdr;
        }
        skipWs(false);
        if (src[i] === '{') {
          bodyNode = parseBraceBlock(i);
        } else {
          const sub = parseStmtList(src, i, to, true);
          bodyNode = sub.nodes[0] ?? null;
          i = sub.nextIdx;
        }
      } else {
        const openIdx = readToOpenBrace();
        if (openIdx === -1) return { kind: 'stmt', text: src.slice(i, to).trim() };
        const hdr = src.slice(i, openIdx).trim();
        const parts = splitTopLevelSemi(hdr);
        if (parts.length === 3) {
          [initText, condText, postText] = parts;
        } else {
          condText = hdr;
        }
        bodyNode = parseBraceBlock(openIdx);
      }
      return { kind: 'for', initText, condText, postText, bodyNode };
    };

    const readSimpleStmt = () => {
      const start = i;
      let pDepth = 0;
      let bDepth = 0;
      let cDepth = 0;
      let lastNonWs = '';
      let prevNonWs = '';
      for (; i < to; i++) {
        const endStr = skipStringLiteral(src, i);
        if (endStr !== i) {
          i = endStr;
          prevNonWs = lastNonWs;
          lastNonWs = src[i];
          continue;
        }
        const ch = src[i];
        if (ch === '(') pDepth++;
        else if (ch === ')') pDepth = Math.max(0, pDepth - 1);
        else if (ch === '[') bDepth++;
        else if (ch === ']') bDepth = Math.max(0, bDepth - 1);
        else if (ch === '{') cDepth++;
        else if (ch === '}') {
          if (pDepth === 0 && bDepth === 0 && cDepth === 0) {
            const text = src.slice(start, i).trim();
            return text ? { kind: 'stmt', text } : null;
          }
          cDepth = Math.max(0, cDepth - 1);
        } else if (ch === ';' && pDepth === 0 && bDepth === 0 && cDepth === 0) {
          const text = src.slice(start, i).trim();
          i++;
          return text ? { kind: 'stmt', text } : null;
        } else if (sdkName === 'go' && ch === '\n' && pDepth === 0 && bDepth === 0 && cDepth === 0) {
          const isIncrement = lastNonWs === '+' && prevNonWs === '+';
          const isCont = !isIncrement && (lastNonWs === '+' || lastNonWs === ',' || lastNonWs === '.' || lastNonWs === '=');
          if (!isCont) {
            const text = src.slice(start, i).trim();
            i++;
            return text ? { kind: 'stmt', text } : null;
          }
        }
        if (!/\s/.test(ch)) {
          prevNonWs = lastNonWs;
          lastNonWs = ch;
        }
      }
      const text = src.slice(start, to).trim();
      return text ? { kind: 'stmt', text } : null;
    };

    while (i < to) {
      skipWs(true);
      if (i >= to) break;
      if (src[i] === '{') {
        nodes.push(parseBraceBlock(i));
      } else if (matchKw('if')) {
        nodes.push(parseIf());
      } else if (matchKw('for')) {
        nodes.push(parseLoop(3));
      } else if (sdkName === 'java' && matchKw('while')) {
        nodes.push(parseLoop(5));
      } else if (sdkName === 'java' && matchKw('do')) {
        i += 2;
        skipWs(false);
        const bodyNode = src[i] === '{' ? parseBraceBlock(i) : parseStmtList(src, i, to, true).nodes[0];
        skipWs(false);
        let condText = '';
        if (matchKw('while')) {
          i += 5;
          skipWs(false);
          if (src[i] === '(') {
            const cEnd = findMatching(src, i, '(', ')', to);
            if (cEnd !== -1) {
              condText = src.slice(i + 1, cEnd).trim();
              i = cEnd + 1;
            }
          }
        }
        nodes.push({ kind: 'for', initText: null, condText, postText: null, bodyNode });
      } else if (matchKw('switch') || (sdkName === 'go' && matchKw('select'))) {
        const kwLen = matchKw('switch') ? 6 : 6;
        i += kwLen;
        skipWs(false);
        let initText = null;
        let condText = '';
        if (sdkName === 'java' && src[i] === '(') {
          const cEnd = findMatching(src, i, '(', ')', to);
          if (cEnd !== -1) {
            condText = src.slice(i + 1, cEnd).trim();
            i = cEnd + 1;
          }
          skipWs(false);
        } else {
          const openIdx = readToOpenBrace();
          if (openIdx !== -1) {
            const hdr = src.slice(i, openIdx).trim();
            const parts = splitTopLevelSemi(hdr);
            if (parts.length >= 2) {
              initText = parts[0];
              condText = parts.slice(1).join('; ');
            } else {
              condText = hdr;
            }
            i = openIdx;
          }
        }
        if (src[i] === '{') {
          const { clauses, hasDefault } = parseSwitchBody(i);
          nodes.push({ kind: 'switch', initText, condText, clauses, hasDefault });
        }
      } else if (sdkName === 'java' && matchKw('try')) {
        i += 3;
        skipWs(false);
        let resourceText = null;
        if (src[i] === '(') {
          const rEnd = findMatching(src, i, '(', ')', to);
          if (rEnd !== -1) {
            resourceText = src.slice(i + 1, rEnd).trim();
            i = rEnd + 1;
          }
          skipWs(false);
        }
        const tryNode = src[i] === '{' ? parseBraceBlock(i) : null;
        const catchNodes = [];
        let finallyNode = null;
        while (i < to) {
          skipWs(false);
          if (matchKw('catch')) {
            i += 5;
            skipWs(false);
            if (src[i] === '(') {
              const cEnd = findMatching(src, i, '(', ')', to);
              i = cEnd === -1 ? i + 1 : cEnd + 1;
            }
            skipWs(false);
            if (src[i] === '{') catchNodes.push(parseBraceBlock(i));
          } else if (matchKw('finally')) {
            i += 7;
            skipWs(false);
            if (src[i] === '{') finallyNode = parseBraceBlock(i);
          } else {
            break;
          }
        }
        nodes.push({ kind: 'try', resourceText, tryNode, catchNodes, finallyNode });
      } else {
        const st = readSimpleStmt();
        if (st) nodes.push(st);
        else if (src[i] === '}') break;
        else i++;
      }
      if (singleStmt) break;
    }
    return { nodes, nextIdx: i };
  };

  const checkCallsInText = (text, state, opts) => {
    if (!text) return;
    const callRe =
      sdkName === 'java'
        ? /\.(?:request|requestList|requestVoid|requestBytes)\(\s*HttpMethod\.(GET|POST|PUT|PATCH|DELETE)\s*,\s*/g
        : /\.do(?:Raw)?\(\s*[A-Za-z_][\w.]*(?:\([^)]*\))?\s*,\s*"(GET|POST|PUT|PATCH|DELETE)"\s*,\s*/g;
    for (const call of text.matchAll(callRe)) {
      const rawExpr = readCommaArg(text, call.index + call[0].length);
      // Both clients take the query right after the path: do(ctx, verb, path, query, ...), request(verb, path, query, ...).
      const queryExpr = splitArgs(text.slice(call.index + call[0].length))[1];
      for (const branch of resolveExprBranches(rawExpr, state.locals, opts)) {
        if (opts.isUnexported && branch.usesHelperParam) continue;
        if (branch.expr.startsWith('/api/')) {
          const normPath = normalize(branch.expr);
          querySites.push({ verb: call[1], path: normPath, expr: queryExpr, scope: opts.scope });
          if (!isCheckedRouteFamily(normPath) && !specByPath.has(normPath)) {
            out.push(`${call[1]} ${normPath}: built by ${sdkName}, not present in the contract`);
          }
        }
      }
    }
  };

  const evalSimpleStmt = (text, state, opts) => {
    if (!text) return;
    checkCallsInText(text, state, opts);
    if (sdkName === 'go') {
      const varDecl = /^var\s+([A-Za-z_]\w*)\s+string$/.exec(text);
      if (varDecl) {
        applyAssignment(state, varDecl[1], ':=', '""', true, opts);
        return;
      }
      const m = /^(?:var\s+)?([A-Za-z_]\w*)(?:\s+string)?\s*(:=|\+=|=(?!=))\s*([\s\S]+)$/.exec(text);
      if (m) {
        const isDecl = m[2] === ':=' || /^var\s+/.test(text);
        applyAssignment(state, m[1], m[2], m[3], isDecl, opts);
      }
    } else {
      const m = /^(?:(?:final\s+)?(?:String|var)\s+)?([A-Za-z_]\w*)\s*(\+=|=(?!=))\s*([\s\S]+)$/.exec(text);
      if (m) {
        const isDecl = /^(?:final\s+)?(?:String|var)\s+/.test(text);
        applyAssignment(state, m[1], m[2], m[3], isDecl, opts);
      }
    }
    if (/^(?:return|throw)\b/.test(text)) state.terminated = true;
  };

  const evalNode = (node, state, opts) => {
    if (!node) return state;
    if (node.kind === 'stmt') {
      evalSimpleStmt(node.text, state, opts);
      return state;
    }
    if (node.kind === 'block') {
      const inner = cloneState(state, true);
      for (const child of node.body) {
        if (inner.terminated) break;
        const next = evalNode(child, inner, opts);
        inner.locals = next.locals;
        inner.terminated = next.terminated;
      }
      return mergeBranchStates([inner], state, inner.declaredHere);
    }
    if (node.kind === 'if') {
      const headerState = cloneState(state, true);
      if (node.initText) evalSimpleStmt(node.initText, headerState, opts);
      checkCallsInText(node.condText, headerState, opts);
      const thenState = evalNode(node.thenNode, cloneState(headerState, true), opts);
      const elseState = node.elseNode ? evalNode(node.elseNode, cloneState(headerState, true), opts) : cloneState(headerState, false);
      return mergeBranchStates([thenState, elseState], state, headerState.declaredHere);
    }
    if (node.kind === 'for') {
      const loopHeader = cloneState(state, true);
      if (node.initText) evalSimpleStmt(node.initText, loopHeader, opts);
      checkCallsInText(node.condText, loopHeader, opts);
      checkCallsInText(node.postText, loopHeader, opts);
      const bodyState = evalNode(node.bodyNode, cloneState(loopHeader, true), opts);
      // A loop may execute 0 times (fallthrough from loopHeader) or 1+ times (bodyState).
      const candidates = [cloneState(loopHeader, false)];
      if (!bodyState.terminated) candidates.push(bodyState);
      return mergeBranchStates(candidates, state, loopHeader.declaredHere);
    }
    if (node.kind === 'switch') {
      const switchHeader = cloneState(state, true);
      if (node.initText) evalSimpleStmt(node.initText, switchHeader, opts);
      checkCallsInText(node.condText, switchHeader, opts);
      const branches = node.clauses.map((c) => evalNode(c, cloneState(switchHeader, true), opts));
      if (!node.hasDefault) branches.push(cloneState(switchHeader, false));
      return mergeBranchStates(branches, state, switchHeader.declaredHere);
    }
    if (node.kind === 'try') {
      const tryHeader = cloneState(state, true);
      if (node.resourceText) {
        for (const res of splitTopLevelSemi(node.resourceText)) evalSimpleStmt(res, tryHeader, opts);
      }
      const tryOut = evalNode(node.tryNode, cloneState(tryHeader, true), opts);
      const branches = [tryOut];
      const catchSeed = mergeBranchStates([cloneState(tryHeader, false), tryOut], tryHeader, tryOut.declaredHere);
      for (const cNode of node.catchNodes) {
        branches.push(evalNode(cNode, cloneState(catchSeed, true), opts));
      }
      const joined = mergeBranchStates(branches, state, tryHeader.declaredHere);
      if (node.finallyNode) {
        const finallyEntry = { ...cloneState(joined, true), terminated: false };
        const finallyOut = evalNode(node.finallyNode, finallyEntry, opts);
        return {
          locals: finallyOut.locals,
          declaredHere: new Set(state.declaredHere),
          terminated: joined.terminated || finallyOut.terminated,
        };
      }
      return joined;
    }
    return state;
  };

  const analyzeBody = (body, opts) => {
    const { nodes } = parseStmtList(body, 0, body.length, false);
    const state = { locals: new Map(), declaredHere: new Set(), terminated: false };
    for (const node of nodes) {
      if (state.terminated) break;
      const next = evalNode(node, state, opts);
      state.locals = next.locals;
      state.terminated = next.terminated;
    }
  };

  const JAVA_NON_METHOD_KEYWORDS = new Set([
    'if',
    'else',
    'for',
    'while',
    'switch',
    'catch',
    'synchronized',
    'try',
    'return',
    'new',
    'throw',
    'assert',
    'do',
    'case',
  ]);

  const extractJavaMethods = (src) => {
    const methods = [];
    const hasTopLevelEquals = (header) => {
      let depth = 0;
      for (let k = 0; k < header.length; k++) {
        const endStr = skipStringLiteral(header, k);
        if (endStr !== k) {
          k = endStr;
          continue;
        }
        const ch = header[k];
        if (ch === '(' || ch === '[' || ch === '<') depth++;
        else if (ch === ')' || ch === ']' || ch === '>') depth = Math.max(0, depth - 1);
        else if (ch === '=' && depth === 0) return true;
      }
      return false;
    };

    const stripAnnotations = (raw) => raw.replace(/@[\w.]+(?:\([^)]*\))?/g, ' ').trim();
    const headerBeforeParen = (header) => {
      const idx = header.indexOf('(');
      return idx === -1 ? header : header.slice(0, idx);
    };
    const isJavaTypeHeader = (rawHeader) => {
      const header = stripAnnotations(rawHeader);
      const prefix = headerBeforeParen(header);
      return /\b(?:class|interface|enum|record)\b/.test(prefix) && !/\bnew\b/.test(prefix) && !hasTopLevelEquals(header);
    };

    const parseJavaMethodHeader = (rawHeader) => {
      const header = stripAnnotations(rawHeader);
      const prefix = headerBeforeParen(header);
      if (!header || /\b(?:class|interface|enum|record|new)\b/.test(prefix) || hasTopLevelEquals(header)) return null;
      const suffixMatch = /\)\s*(?:throws\s+[\w.$,\s<>?[\]]+)?$/.exec(header);
      if (!suffixMatch) return null;
      const closeParen = suffixMatch.index;
      let depth = 1;
      let openParen = -1;
      for (let k = closeParen - 1; k >= 0; k--) {
        const ch = header[k];
        if (ch === '"' || ch === "'") {
          for (k--; k >= 0; k--) {
            if (header[k] === ch && header[k - 1] !== '\\') break;
          }
          continue;
        }
        if (ch === ')') depth++;
        else if (ch === '(' && --depth === 0) {
          openParen = k;
          break;
        }
      }
      if (openParen <= 0) return null;
      const beforeParen = header.slice(0, openParen).trim();
      const nameMatch = /\b([A-Za-z_]\w*)$/.exec(beforeParen);
      if (!nameMatch || JAVA_NON_METHOD_KEYWORDS.has(nameMatch[1])) return null;
      const beforeName = beforeParen.slice(0, nameMatch.index).trim();
      const prevWord = /\b([A-Za-z_]\w*)$/.exec(beforeName)?.[1];
      if (prevWord && JAVA_NON_METHOD_KEYWORDS.has(prevWord)) return null;
      return { name: nameMatch[1], params: header.slice(openParen + 1, closeParen) };
    };

    const scanScope = (from, to) => {
      let memberStart = from;
      for (let i = from; i < to; i++) {
        const endStr = skipStringLiteral(src, i);
        if (endStr !== i) {
          i = endStr;
          continue;
        }
        if (src[i] === ';') {
          memberStart = i + 1;
          continue;
        }
        if (src[i] === '(') {
          const pEnd = findMatching(src, i, '(', ')', to);
          if (pEnd !== -1) i = pEnd;
          continue;
        }
        if (src[i] === '{') {
          const closeIdx = findMatching(src, i, '{', '}', to);
          const end = closeIdx === -1 ? to : closeIdx;
          const header = src.slice(memberStart, i).trim();
          if (isJavaTypeHeader(header)) {
            scanScope(i + 1, end);
          } else {
            const parsed = parseJavaMethodHeader(header);
            if (parsed) {
              methods.push({ ...parsed, body: src.slice(i + 1, end) });
            }
          }
          i = end;
          memberStart = end + 1;
        }
      }
    };

    scanScope(0, src.length);
    return methods;
  };

  const extractGoFunctions = (source) => {
    const fns = [];
    for (let i = 0; i < source.length; i++) {
      const endStr = skipStringLiteral(source, i);
      if (endStr !== i) {
        i = endStr;
        continue;
      }
      if (source[i] === '{') {
        const closeIdx = findMatching(source, i, '{', '}');
        if (closeIdx !== -1) i = closeIdx;
        continue;
      }
      if (!source.startsWith('func', i) || /[A-Za-z0-9_]/.test(source[i - 1] ?? '') || /[A-Za-z0-9_]/.test(source[i + 4] ?? '')) {
        continue;
      }
      let p = i + 4;
      while (p < source.length && /\s/.test(source[p])) p++;
      if (source[p] === '(') {
        const rEnd = findMatching(source, p, '(', ')');
        if (rEnd === -1) continue;
        p = rEnd + 1;
        while (p < source.length && /\s/.test(source[p])) p++;
      }
      const nameMatch = /^([A-Za-z_]\w*)/.exec(source.slice(p));
      if (!nameMatch) continue;
      const name = nameMatch[1];
      p += name.length;
      while (p < source.length && /\s/.test(source[p])) p++;
      if (source[p] === '[') {
        const gEnd = findMatching(source, p, '[', ']');
        if (gEnd === -1) continue;
        p = gEnd + 1;
        while (p < source.length && /\s/.test(source[p])) p++;
      }
      if (source[p] !== '(') continue;
      const pEnd = findMatching(source, p, '(', ')');
      if (pEnd === -1) continue;
      const params = source.slice(p + 1, pEnd);
      let q = pEnd + 1;
      let openBrace = -1;
      for (; q < source.length; q++) {
        const sEnd = skipStringLiteral(source, q);
        if (sEnd !== q) {
          q = sEnd;
          continue;
        }
        if (source[q] === '(') {
          const end = findMatching(source, q, '(', ')');
          if (end === -1) break;
          q = end;
        } else if (source[q] === '[') {
          const end = findMatching(source, q, '[', ']');
          if (end === -1) break;
          q = end;
        } else if (source[q] === '{') {
          openBrace = q;
          break;
        } else if (source[q] === '\n') {
          break;
        }
      }
      if (openBrace === -1) continue;
      const closeBrace = findMatching(source, openBrace, '{', '}');
      if (closeBrace === -1) continue;
      fns.push({ name, params, body: source.slice(openBrace + 1, closeBrace) });
      i = closeBrace;
    }
    return fns;
  };

  if (sdkName === 'java') {
    for (const pair of verbPairsOf({ name: 'java', dir: relative(root, dir), exts: ['.java'] })) {
      const [verb, path] = pair.split(' ');
      if (!isCheckedRouteFamily(path) && !specByPath.has(path)) {
        out.push(`${verb} ${path}: built by java, not present in the contract`);
      }
    }
    const callRe = FAMILY_CALLS['/api/sessions/*/messages/*']?.java;
    for (const file of walk(dir, ['.java'])) {
      const src = stripInlineComments(strip(readFileSync(file, 'utf8')));
      for (const m of src.matchAll(/["'](\/api\/[^"'\n]*)["']/g)) {
        const clean = m[1].endsWith('/') ? m[1].slice(0, -1) : m[1];
        const normPath = normalize(clean);
        if (!hasContractOrPrefix(normPath)) {
          out.push(`${normPath}: built by java, not present in the contract`);
        }
      }
      if (callRe) {
        for (const m of src.matchAll(callRe)) {
          const target = `/api/sessions/*/messages/${m[1]}`;
          if (!contractShapes.has(target)) out.push(`${target}: built by java, not present in the contract`);
        }
      }
      for (const method of extractJavaMethods(src)) {
        analyzeBody(method.body, { isUnexported: false, scope: `${method.params}\n${method.body}` });
      }
    }
  } else if (sdkName === 'go') {
    const parseParamNames = (params) => {
      const names = new Set();
      let start = 0;
      let pDepth = 0;
      let bDepth = 0;
      const parts = [];
      for (let i = 0; i < params.length; i++) {
        if (params[i] === '(') pDepth++;
        else if (params[i] === ')') pDepth = Math.max(0, pDepth - 1);
        else if (params[i] === '[') bDepth++;
        else if (params[i] === ']') bDepth = Math.max(0, bDepth - 1);
        else if (params[i] === ',' && pDepth === 0 && bDepth === 0) {
          parts.push(params.slice(start, i));
          start = i + 1;
        }
      }
      parts.push(params.slice(start));
      for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const m = /^([A-Za-z_]\w*)/.exec(trimmed);
        if (m) names.add(m[1]);
      }
      return names;
    };

    for (const file of walk(dir, ['.go']).filter((f) => !f.endsWith('_test.go'))) {
      const source = stripInlineComments(strip(readFileSync(file, 'utf8')));
      const bases = new Map();
      for (const helper of source.matchAll(/func \(\w+ \*\w+Service\) (\w+)\([^)]*\) string \{\s*return ([^\n]+)\n/g)) {
        const base = normalize(
          helper[2]
            .split('+')
            .map((t) => t.trim())
            .map((t) => /^"([^"]*)"$/.exec(t)?.[1] ?? '*')
            .join(''),
        );
        if (base.startsWith('/api/')) {
          bases.set(helper[1], base);
          if (!hasContractOrPrefix(base)) {
            out.push(`${base}: built by go base(), not present in the contract`);
          }
        }
      }
      for (const m of source.matchAll(/["`](\/api\/[^"`\n]*)["`]/g)) {
        const clean = m[1].endsWith('/') ? m[1].slice(0, -1) : m[1];
        const normPath = normalize(clean);
        if (!hasContractOrPrefix(normPath)) {
          out.push(`${normPath}: built by go, not present in the contract`);
        }
      }
      for (const m of source.matchAll(/\.\w+\(\s*ctx\s*,\s*"(GET|POST|PUT|PATCH|DELETE)"\s*,[^)]*?"(\/[a-z0-9][\w.\/-]*)"/g)) {
        if (m[2].startsWith('/api/')) continue;
        const candidates = [];
        for (const base of bases.values()) {
          candidates.push(normalize(base + m[2]));
          candidates.push(normalize(`${base}/*${m[2]}`));
        }
        if (candidates.length > 0 && !candidates.some((p) => specByPath.has(p))) {
          out.push(`${m[1]} ${candidates[0]}: built by go, not present in the contract`);
        }
      }
      for (const m of source.matchAll(/\bs\.[a-z]\w*\(\s*ctx\s*,\s*\w+\s*,\s*"(\/[a-z0-9][\w.\/-]*)"/g)) {
        if (m[1].startsWith('/api/')) continue;
        const candidates = [];
        for (const base of bases.values()) {
          candidates.push(normalize(base + m[1]));
          candidates.push(normalize(`${base}/*${m[1]}`));
        }
        if (candidates.length > 0 && !candidates.some((p) => specByPath.has(p))) {
          out.push(`${candidates[0]}: built by go, not present in the contract`);
        }
      }
      for (const fn of extractGoFunctions(source)) {
        const isUnexported = /^[a-z]/.test(fn.name);
        const helperParamNames = isUnexported ? parseParamNames(fn.params) : new Set();
        analyzeBody(fn.body, { bases, helperParamNames, isUnexported, scope: `${fn.params}\n${fn.body}` });
      }
      for (const m of source.matchAll(/\.membershipRequestAction\(\s*ctx\s*,\s*\w+\s*,\s*\w+\s*,\s*"([\w-]+)"/g)) {
        const target = `/api/sessions/*/groups/*/membership-requests/${m[1]}`;
        if (!contractShapes.has(target)) out.push(`${target}: built by go, not present in the contract`);
      }
      for (const m of source.matchAll(/\bs\.send\(\s*ctx\s*,\s*\w+\s*,\s*"([\w-]+)"/g)) {
        const target = `/api/sessions/*/messages/${m[1]}`;
        if (!contractShapes.has(target)) out.push(`${target}: built by go, not present in the contract`);
      }
    }
  }
  return out;
}

/** JavaScript, Python and PHP calls with their query argument (group 3) are added to `querySites`. */
const verbPairsOf = (sdk, querySites = []) => {
  if (sdk.name === 'go') return goVerbPairs(join(root, sdk.dir));
  const pairs = new Set();
  for (const file of walk(join(root, sdk.dir), sdk.exts)) {
    const src = readFileSync(file, 'utf8');
    const patterns =
      sdk.name === 'javascript'
        ? [/(GET|POST|PUT|PATCH|DELETE)'\s*,\s*[\s\S]{0,80}?path:\s*[`'"]([^`'"]+)[`'"](?:\s*,\s*(query\b(?:\s*:\s*(?:\{[^}]*\}|\w+))?))?/g]
        : sdk.name === 'python'
          ? [/\.request\(\s*"(GET|POST|PUT|PATCH|DELETE)"\s*,\s*((?:f?"[^"\n]*"\s*)+)(?:,\s*query=(\{[^}]*\}|\w+))?/g]
          : sdk.name === 'php'
            ? [/->request(?:Array|NullableArray)?\(\s*'(GET|POST|PUT|PATCH|DELETE)'\s*,\s*['"]([^'"]+)['"](?:\s*,\s*(\[[^\]]*\]|\$\w+))?/g]
            : [/HttpMethod\.(GET|POST|PUT|PATCH|DELETE)\s*,\s*([\s\S]{2,400}?)\s*,\s*\n?\s*(?:null|new |Map\.|Collections\.|[a-z]\w)/g];
    for (const re of patterns) {
      for (const m of src.matchAll(re)) {
        const path = sdk.name === 'java' ? literalsToPath(m[2]) : sdk.name === 'python' ? joinPythonLiterals(m[2]) : m[2];
        if (path && path.startsWith('/api/')) {
          pairs.add(`${m[1]} ${normalize(path)}`);
          if (sdk.name !== 'java') querySites.push({ verb: m[1], path: normalize(path), expr: m[3], scope: src.slice(0, m.index) });
        }
      }
    }
  }
  return pairs;
};

// ─── Query layer ─────────────────────────────────────────────────────────────────────────────
// The path and verb layers never read an operation's parameters, so a query parameter the server
// renamed or dropped left every client sending the old key with all of them green: a keyset page
// walk that sends `after` to a server reading `cursor` re-reads its first page forever. This layer
// collects the keys each client call sends and compares them with the names the operation
// declares, in both directions. A declared name a client does not send yet is listed in
// QUERY_GAPS, and the list only shrinks: a new gap fails, and so does an entry that is no longer
// one. PHP's list methods pass a caller's array through without naming any key, so all of their
// parameters are listed; a renamed parameter still fails there, through its stale entry.
// `node scripts/check-sdk-coverage.mjs --update-query-gaps` rewrites the list from the current gaps.
/** What a client sends when it passes a caller's query array through unchanged (PHP). */
const FORWARDS_CALLER_QUERY = '*caller*';

const QUERY_GAPS = join(root, 'scripts/sdk-query-parameter-gaps.json');

/** The top-level comma-separated items of `s`, up to the bracket that closes it; quoted text is kept whole. */
const splitArgs = (s) => {
  const items = [];
  let depth = 0;
  let start = 0;
  let quote = null;
  let i = 0;
  for (; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if ('"\'`'.includes(c)) quote = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c) && --depth < 0) break;
    else if (c === ',' && depth === 0) {
      items.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  items.push(s.slice(start, i).trim());
  return items.filter(Boolean);
};

/** Comments and docstrings removed; PHP keeps its docblocks, which carry the array shapes. */
const cleanSource = (sdk, text) =>
  sdk === 'php' ? text : sdk === 'python' ? text.replace(/"""[\s\S]*?"""/g, '').replace(/^\s*#.*$/gm, '') : strip(text);

const keysOf = (re, text) => [...(text ?? '').matchAll(re)].map((k) => k[1]);

/**
 * The keys one client call puts in its query string: read from a literal map, or from the declared
 * type of the variable it passes (a TypeScript interface, a Python TypedDict, a Go values() method,
 * a Java record, a PHP docblock array shape). `scope` is the code that declares the variable and
 * `all` the client's cleaned sources. What cannot be resolved names no key, so its parameters
 * surface as gaps instead of passing unseen.
 */
export function queryKeys(sdk, expr, scope, all) {
  let arg = (expr ?? '').trim();
  if (sdk === 'javascript') arg = arg.replace(/^query\s*:\s*/, '');
  const literal = {
    javascript: /^\{([\s\S]*)\}$/,
    python: /^\{([\s\S]*)\}$/,
    php: /^\[([\s\S]*)\]$/,
    go: /^url\.Values\{([\s\S]*)\}$/,
    java: /^(?:java\.util\.)?Map\.of\(([\s\S]*)\)$/,
  }[sdk].exec(arg);
  if (literal) {
    // Map.of alternates keys and values.
    const entries = splitArgs(literal[1]).filter((_, i) => sdk !== 'java' || i % 2 === 0);
    return entries.map((e) => /^["']?(\w+)/.exec(e)?.[1]).filter(Boolean);
  }
  scope = cleanSource(sdk, scope ?? '');
  const last = (pattern) => [...scope.matchAll(new RegExp(pattern, 'g'))].at(-1);

  if (sdk === 'go') {
    const typed = /^(?:valuesOf\((\w+)\)|(\w+)\.values\(\))$/.exec(arg);
    if (typed) {
      const type = last(`\\b${typed[1] ?? typed[2]}\\s+\\*?(\\w+)`)?.[1];
      const values = type && new RegExp(`func \\(\\w+ \\*?${type}\\) values\\(\\) url\\.Values \\{([\\s\\S]*?)\\n\\}`).exec(all);
      return keysOf(/(?:\bset\w*\(\s*\w+\s*,|\.(?:Set|Add)\()\s*"([^"]+)"/g, values?.[1]);
    }
    if (!/^\w+$/.test(arg)) return [];
    // A local built from another query, plus what it sets and minus what it deletes:
    // `values := query.values(); values.Del("sessionId")`.
    const dropped = keysOf(new RegExp(`\\b${arg}\\.Del\\("([^"]+)"\\)`, 'g'), scope);
    const added = keysOf(new RegExp(`\\b${arg}\\.(?:Set|Add)\\("([^"]+)"`, 'g'), scope);
    const rhs = last(`\\b${arg}\\s*(?::=|=(?!=))\\s*(.+)`)?.[1];
    return [...(rhs ? queryKeys(sdk, rhs, scope, all) : []), ...added].filter((k) => !dropped.includes(k));
  }
  if (sdk === 'php') {
    if (!/^\$\w+$/.test(arg)) return [];
    const shape = last(`@param\\s+(array\\{[^}]*\\}|\\S+)\\s+\\$${arg.slice(1)}\\b`)?.[1];
    if (shape?.startsWith('array{')) return keysOf(/(\w+)\??\s*:/g, shape);
    // The method's own array parameter, passed through, carries whatever keys its caller gives it.
    const signature = last('function\\s+\\w+\\s*\\(([^)]*)\\)')?.[1] ?? '';
    return new RegExp(`\\barray\\s+\\${arg}\\b`).test(signature) ? [FORWARDS_CALLER_QUERY] : [];
  }
  if (!/^\w+$/.test(arg)) return [];
  if (sdk === 'javascript') {
    const interfaceKeys = (type) => {
      const m = new RegExp(`interface ${type}\\b(?:\\s+extends\\s+([\\w\\s,]+?))?\\s*\\{([\\s\\S]*?)\\n\\}`).exec(all);
      return m ? [...(m[1]?.split(',') ?? []).flatMap((base) => interfaceKeys(base.trim())), ...keysOf(/^\s*(\w+)\??:/gm, m[2])] : [];
    };
    const type = last(`\\b${arg}\\??\\s*:\\s*(?:(?:Readonly|Partial|Required)<\\s*)*(\\w+)`)?.[1];
    return type ? interfaceKeys(type) : [];
  }
  if (sdk === 'python') {
    const typedDictKeys = (type) => {
      const functional = new RegExp(`\\b${type}\\s*=\\s*TypedDict\\(\\s*"${type}"\\s*,\\s*\\{([^}]*)\\}`).exec(all);
      if (functional) return keysOf(/"(\w+)"\s*:/g, functional[1]);
      const cls = new RegExp(`^class ${type}\\(([^)]*)\\)[^\\n]*\\n((?:[ \\t]+.*\\n|[ \\t]*\\n)*)`, 'm').exec(all);
      if (!cls) return [];
      const bases = cls[1].split(',').map((b) => b.trim()).filter((b) => /^\w+$/.test(b) && b !== 'TypedDict');
      return [...bases.flatMap(typedDictKeys), ...keysOf(/^[ \t]+(\w+)\s*:/gm, cls[2])];
    };
    const type = last(`\\b${arg}\\s*:\\s*(?:(?:typing\\.)?Optional\\[\\s*)*(\\w+)`)?.[1];
    return type ? typedDictKeys(type) : [];
  }
  // Java: the record components of the variable's declared type. String contents are blanked first:
  // a message such as "Search params must not be null." reads like a declaration of `params`.
  scope = scope.replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
  const decl = last(`\\b([A-Z]\\w*)\\s+${arg}\\b(?:\\s*=\\s*([^;]+))?`);
  const record = decl && new RegExp(`record ${decl[1]}\\(([^)]*)\\)`).exec(all);
  if (!record) return [];
  const components = record[1].split(',').map((p) => /(\w+)\s*$/.exec(p)?.[1]);
  // A component constructed as a literal null is never sent: the query writer skips null members.
  const ctor = new RegExp(`new\\s+${decl[1]}\\(([\\s\\S]*)\\)\\s*$`).exec(decl[2]?.trim() ?? '');
  const args = ctor ? splitArgs(ctor[1]) : [];
  return components.filter((c, i) => c && !(args.length === components.length && args[i] === 'null'));
}

// A spec imports the helpers above; only a direct run reports and exits. argv[1] is realpathed because
// Node realpaths the main module's URL: through a symlinked path the two never matched and nothing ran.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const spec = JSON.parse(readFileSync(join(root, 'openapi.json'), 'utf8')).paths;
  // Same scope as the path layer: resources the README declares unexposed are not the SDKs' to build.
  const specByPath = new Map(Object.entries(spec).map(([k, v]) => [normalize(k), v]));
  const multi = [];
  for (const raw of inScope) {
    const verbs = VERBS.filter((v) => specByPath.get(raw)?.[v.toLowerCase()]);
    if (verbs.length > 1) multi.push({ path: raw, verbs });
  }
  const verbErrors = [];
  const querySites = {};
  for (const sdk of SDKS) {
    const pairs = verbPairsOf(sdk, (querySites[sdk.name] = []));
    // Non-vacuity: a regex that stopped matching yields an empty set and the layer goes blind.
    if (pairs.size < 60) verbErrors.push(`${sdk.name}: harvested only ${pairs.size} verb/path pairs — the verb scan has drifted.`);
    for (const { path, verbs } of multi) {
      for (const verb of verbs) {
        if (!pairs.has(`${verb} ${path}`)) verbErrors.push(`${verb} ${path} — declared by the contract, built by no ${sdk.name} method`);
      }
    }
    // Checked against the whole contract: a client that builds an excluded route still owes it a real verb.
    verbErrors.push(...undeclaredVerbPairs(sdk.name, pairs, specByPath));
    if (sdk.name === 'go' || sdk.name === 'java') {
      verbErrors.push(...staleRouteErrors(sdk.name, join(root, sdk.dir), specByPath, contractShapes, querySites[sdk.name]));
    }
  }
  if (multi.length < 15) {
    console.error('check-sdk-coverage: expected 15+ in-scope multi-verb contract paths, found ' + multi.length);
    process.exit(1);
  }
  if (verbErrors.length) {
    console.error('\n✖ SDK verbs disagree with the contract:');
    for (const e of verbErrors) console.error(`  - ${e}`);
    process.exit(1);
  }

  if (errors.length) {
    console.error('\n✖ The contract publishes routes the SDKs do not expose:');
    for (const e of errors) console.error(`  - ${e}`);
    console.error('\nsdk/README.md promises that everything outside its excluded set is exposed.');
    console.error('Add the client method, or add the resource to that list with a reason.\n');
    process.exit(1);
  }

  // Query layer, after the path layer so a missing route is reported as that first: see QUERY_GAPS.
  const queryErrors = [];
  const gaps = [];
  for (const sdk of SDKS) {
    const all = walk(join(root, sdk.dir), sdk.exts)
      .filter((f) => !f.endsWith('_test.go'))
      .map((f) => cleanSource(sdk.name, readFileSync(f, 'utf8')))
      .join('\n');
    for (const [path, item] of Object.entries(spec)) {
      for (const verb of VERBS.filter((v) => item[v.toLowerCase()])) {
        const declared = (item[verb.toLowerCase()].parameters ?? []).filter((p) => p.in === 'query').map((p) => p.name);
        const sent = new Set(
          querySites[sdk.name]
            .filter((site) => site.verb === verb && site.path === normalize(path))
            .flatMap((site) => queryKeys(sdk.name, site.expr, site.scope, all)),
        );
        const forwarded = sent.delete(FORWARDS_CALLER_QUERY);
        for (const name of sent) {
          if (!declared.includes(name)) queryErrors.push(`${verb} ${path} query "${name}": sent by ${sdk.name}, not declared by the contract`);
        }
        if (isUnexposedPath(normalize(path), excluded)) continue;
        for (const name of declared) if (!forwarded && !sent.has(name)) gaps.push({ sdk: sdk.name, method: verb, path, parameter: name });
      }
    }
  }
  const gapId = (g) => `${g.sdk} ${g.method} ${g.path} ${g.parameter}`;
  const gapsFile = relative(root, QUERY_GAPS);
  if (process.argv.includes('--update-query-gaps')) {
    gaps.sort((a, b) => gapId(a).localeCompare(gapId(b)));
    const body = gaps.map((g) => `  ${JSON.stringify(g)}`).join(',\n');
    writeFileSync(QUERY_GAPS, body ? `[\n${body}\n]\n` : '[]\n');
    console.log(`Wrote ${gaps.length} query parameter gaps to ${gapsFile}: read the diff before committing it.`);
    process.exit(0);
  }
  const listed = JSON.parse(readFileSync(QUERY_GAPS, 'utf8'));
  const listedIds = new Set(listed.map(gapId));
  const gapIds = new Set(gaps.map(gapId));
  for (const g of gaps) {
    if (!listedIds.has(gapId(g))) queryErrors.push(`${g.method} ${g.path} query "${g.parameter}": declared by the contract, sent by no ${g.sdk} call`);
  }
  for (const g of listed) {
    if (!gapIds.has(gapId(g))) queryErrors.push(`${g.method} ${g.path} query "${g.parameter}": listed as missing from ${g.sdk} in ${gapsFile}, but it is not: remove the entry`);
  }
  if (queryErrors.length) {
    console.error('\n✖ SDK query parameters disagree with the contract:');
    for (const e of queryErrors) console.error(`  - ${e}`);
    console.error(`\nSend the declared name from the client method, or, while a parameter stays unexposed, list it in ${gapsFile}.\n`);
    process.exit(1);
  }

  console.log(`✓ SDK contract coverage OK (${inScope.length} in-scope contract paths reachable from all ${SDKS.length} clients).`);
}
