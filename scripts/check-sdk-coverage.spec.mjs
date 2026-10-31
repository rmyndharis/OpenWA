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

test('the key validation route is required of every SDK, the key management routes are not', () => {
  // sdk/README.md lists `auth/api-keys` as unexposed and says key validation itself is exposed. The scope used to
  // cut every entry to its first segment, which made all of /api/auth unexposed, so an SDK without its auth()
  // method kept the gate green. The gate runs on a copy of the sources it reads, with the PHP auth() emptied.
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
    const whole = run();
    assert.equal(whole.status, 0, whole.stdout + whole.stderr);

    const client = join(dir, 'sdk', 'php', 'src', 'Client.php');
    const source = readFileSync(client, 'utf8');
    const call = "return $this->http->request('POST', '/api/auth/validate') ?? [];";
    assert.ok(source.includes(call), 'the PHP auth() call has moved: move this anchor');
    writeFileSync(client, source.replace(call, 'return [];'));
    const without = run();
    assert.equal(without.status, 1, without.stdout + without.stderr);
    assert.match(without.stderr, /\/api\/auth\/validate .*built by no method in: php/);
    assert.doesNotMatch(without.stderr, /\/api\/auth\/api-keys/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
