/**
 * Packaging and request smoke test: load the BUILT dist/ through Node's real CJS
 * and ESM loaders, then send real requests through each build's client. Unit
 * tests run under vitest's bundler-like resolver and cannot catch a dual-format
 * misconfig (CJS parsed as ESM, or extensionless ESM specifiers), so this guards
 * `npm publish` against shipping an unconsumable package. Run after `npm run build`.
 */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cjs = require('../dist/cjs/index.js');
if (typeof cjs.OpenWAClient !== 'function') throw new Error('CJS: OpenWAClient missing');

const esm = await import(new URL('../dist/esm/index.js', import.meta.url).href);
if (typeof esm.OpenWAClient !== 'function') throw new Error('ESM: OpenWAClient missing');

// The webhook helper is a value export in both builds; on Node 18 this also runs its node:crypto
// fallback through the real CJS require() and ESM import() paths.
const secret = 'test-secret-0123456789';
const body = '{"event":"test"}';
const signature = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
for (const [format, mod] of [
  ['CJS', cjs],
  ['ESM', esm],
]) {
  if ((await mod.verifyWebhookSignature(body, signature, secret)) !== true) {
    throw new Error(`${format}: verifyWebhookSignature rejected a valid signature`);
  }
}

// Request smoke: the Node 18 lane skips the unit tests (vitest 4 needs Node 20+), and the typecheck
// accepts DOM-declared globals Node 18 lacks, so send real requests through each build's client over
// the default global fetch: a parsed 2xx body, a typed error for a non-2xx, and the abort timeout.
const server = createServer((req, res) => {
  if (req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ apiKey: req.headers['x-api-key'] }));
  } else if (req.url === '/api/health/live') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"statusCode":404,"message":"Not here","error":"Not Found"}');
  } else {
    // Never answer, so only the client timeout can settle the request. If that timeout is broken,
    // dropping the socket later rejects with a non-timeout error instead of hanging the job.
    setTimeout(() => res.destroy(), 5000).unref();
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  for (const [format, mod] of [
    ['CJS', cjs],
    ['ESM', esm],
  ]) {
    const client = new mod.OpenWAClient({ baseUrl, apiKey: 'smoke-key' });
    const health = await client.health.check();
    if (health?.apiKey !== 'smoke-key') {
      throw new Error(`${format}: health.check() did not send the key or parse JSON: ${JSON.stringify(health)}`);
    }
    const notFound = await client.health.live().catch(err => err);
    if (!(notFound instanceof mod.OpenWANotFoundError) || notFound.status !== 404) {
      throw new Error(`${format}: a 404 did not raise OpenWANotFoundError (got ${notFound})`);
    }
    const unanswered = await client.request({ method: 'GET', path: '/hang', timeoutMs: 100 }).catch(err => err);
    if (!(unanswered instanceof mod.OpenWATimeoutError)) {
      throw new Error(`${format}: an unanswered request did not raise OpenWATimeoutError (got ${unanswered})`);
    }
  }
} finally {
  server.closeAllConnections?.(); // Node 18.2+
  server.close();
}

// Typings smoke: each runtime condition must carry its OWN types entry pointing at the matching
// build. A single top-level "types" condition ahead of "require" makes a node16-family CommonJS
// TypeScript consumer resolve the ESM declaration while linking the CJS build, which fails with
// TS1479 ("The current file is a CommonJS module whose imports will produce 'require' calls")
// against the ESM declarations' `export ... from` syntax. The runtime loaders above cannot see
// this; only the exports-map shape does.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const dot = pkg.exports?.['.'];
for (const [condition, dist] of [
  ['import', 'esm'],
  ['require', 'cjs'],
]) {
  const types = dot?.[condition]?.types;
  if (types !== `./dist/${dist}/index.d.ts`) {
    throw new Error(`exports["."].${condition}.types must point at ./dist/${dist}/index.d.ts (got ${types})`);
  }
  if (dot?.[condition]?.default !== `./dist/${dist}/index.js`) {
    throw new Error(`exports["."].${condition}.default must point at ./dist/${dist}/index.js`);
  }
}
if (dot?.types !== undefined) {
  throw new Error('exports["."] must not carry a top-level "types" condition (see TS1479 note above)');
}

console.log('smoke OK: require() + import() both resolve OpenWAClient and send requests, each condition types itself');
