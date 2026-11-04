import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { joinPythonLiterals, undeclaredVerbPairs } from './check-sdk-coverage.mjs';

const specByPath = new Map([
  ['/api/sessions/*/groups/*', { get: {} }],
  ['/api/sessions/*/webhooks/*', { put: {}, delete: {} }],
]);

test('undeclaredVerbPairs flags a verb the contract does not declare on a single-verb path', () => {
  assert.deepEqual(undeclaredVerbPairs('python', new Set(['POST /api/sessions/*/groups/*']), specByPath), [
    'POST /api/sessions/*/groups/*: built by python, not declared by the contract',
  ]);
  assert.deepEqual(undeclaredVerbPairs('python', new Set(['GET /api/sessions/*/groups/*']), specByPath), []);
});

test('undeclaredVerbPairs flags a wrong verb on a multi-verb path', () => {
  const pairs = new Set(['PUT /api/sessions/*/webhooks/*', 'PATCH /api/sessions/*/webhooks/*']);
  assert.deepEqual(undeclaredVerbPairs('go', pairs, specByPath), [
    'PATCH /api/sessions/*/webhooks/*: built by go, not declared by the contract',
  ]);
});

test('undeclaredVerbPairs ignores a pair that is not a contract path', () => {
  assert.deepEqual(undeclaredVerbPairs('javascript', new Set(['POST /api/sessions/*/messages/*']), specByPath), []);
});

test('joinPythonLiterals joins a path split across adjacent literals', () => {
  const expr = 'f"/api/sessions/{a}/groups/{b}"\n            "/membership-requests/approve"';
  assert.equal(joinPythonLiterals(expr), '/api/sessions/{a}/groups/{b}/membership-requests/approve');
});

test('a run through a symlinked path still reports', () => {
  // Node realpaths the main module's URL but not argv[1], so a guard comparing the unresolved path
  // skipped every check and exited 0 whenever the invocation crossed a symlink (/tmp on macOS).
  const dir = mkdtempSync(join(tmpdir(), 'sdk-coverage-'));
  try {
    symlinkSync(fileURLToPath(new URL('..', import.meta.url)), join(dir, 'repo'));
    const run = spawnSync(process.execPath, [join(dir, 'repo', 'scripts', 'check-sdk-coverage.mjs')], {
      encoding: 'utf8',
    });
    assert.match(run.stdout + run.stderr, /SDK contract coverage/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A copy of the sources the gate reads, so a case can break one of them; `fn` gets an edit helper and a runner. */
function withCopy(fn) {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'sdk-coverage-copy-'));
  try {
    for (const path of [
      'scripts/check-sdk-coverage.mjs',
      'scripts/check-contract-shapes.mjs',
      'openapi.json',
      'sdk/README.md',
      'sdk/javascript/src',
      'sdk/python/openwa',
      'sdk/php/src',
      'sdk/java/src/main',
      'sdk/go',
    ]) {
      cpSync(join(repo, path), join(dir, path), { recursive: true });
    }
    const run = () =>
      spawnSync(process.execPath, [join(dir, 'scripts', 'check-sdk-coverage.mjs')], { encoding: 'utf8' });
    /** Replace `from` in a copied file, returning a function that puts the original back. */
    const edit = (path, from, to) => {
      const file = join(dir, path);
      const source = readFileSync(file, 'utf8');
      assert.ok(source.includes(from), `${path} no longer contains ${JSON.stringify(from)}: move this anchor`);
      writeFileSync(file, source.replace(from, to));
      return () => writeFileSync(file, source);
    };
    const whole = run();
    assert.equal(whole.status, 0, whole.stdout + whole.stderr);
    fn({ edit, run });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the key validation route is required of every SDK, the key management routes are not', () => {
  // sdk/README.md lists `auth/api-keys` as unexposed and says key validation itself is exposed. The scope used to
  // cut every entry to its first segment, which made all of /api/auth unexposed, so an SDK without its auth()
  // method kept the gate green. The gate runs on a copy of the sources it reads, with the PHP auth() emptied.
  withCopy(({ edit, run }) => {
    edit('sdk/php/src/Client.php', "return $this->http->request('POST', '/api/auth/validate') ?? [];", 'return [];');
    const without = run();
    assert.equal(without.status, 1, without.stdout + without.stderr);
    assert.match(without.stderr, /\/api\/auth\/validate .*built by no method in: php/);
    assert.doesNotMatch(without.stderr, /\/api\/auth\/api-keys/);
  });
});

test('a builder whose last segment is a variable covers only the names its callers pass', () => {
  // Every client builds the send-media routes as `.../messages/${segment}`, and Go builds the membership-request
  // actions as `.../membership-requests/" + verb`. Such a wildcard must not stand in for every sibling route.
  withCopy(({ edit, run }) => {
    const missing = (output, route, clients) =>
      assert.match(output, new RegExp(`${route.replace(/\*/g, '\\*')} .*built by no method in: ${clients}$`, 'm'));

    // A message route one client stopped building.
    let restore = edit(
      'sdk/php/src/Resources/MessagesResource.php',
      'return $this->http->request(\'POST\', "/api/sessions/{$this->http->encodeSegment($sessionId)}/messages/react", [], $body);',
      'return [];',
    );
    let result = run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    missing(result.stderr, '/api/sessions/*/messages/react', 'php');
    restore();

    // A send-media verb one client no longer passes to its builder.
    restore = edit(
      'sdk/javascript/src/resources/messages.ts',
      "sendMedia(sessionId, 'send-sticker',",
      "sendMedia(sessionId, 'send-image',",
    );
    result = run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    missing(result.stderr, '/api/sessions/*/messages/send-sticker', 'javascript');
    restore();

    // New routes no client builds at all, in both builder families.
    restore = edit(
      'openapi.json',
      '"paths": {',
      '"paths": {"/api/sessions/{sessionId}/messages/send-brand-new":{"post":{"responses":{"201":{"description":"ok"}}}},' +
        '"/api/sessions/{sessionId}/groups/{groupId}/membership-requests/brand-new":{"post":{"responses":{"201":{"description":"ok"}}}},',
    );
    result = run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    missing(result.stderr, '/api/sessions/*/messages/send-brand-new', 'javascript, python, php, java, go');
    missing(
      result.stderr,
      '/api/sessions/*/groups/*/membership-requests/brand-new',
      'javascript, python, php, java, go',
    );
    restore();
  });
});
