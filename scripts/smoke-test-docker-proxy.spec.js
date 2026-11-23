/**
 * Unit tests for the failure hint in scripts/smoke-test-docker-proxy.sh (node:test, no deps).
 * Run: `npm run test:scripts`.
 *
 * A shim curl answers /api/health with 200 and /api/infra/status with SHIM_CODE, so the admin-API
 * check fails without a running stack and its message can be read.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, 'smoke-test-docker-proxy.sh');

function infraFailure(code) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-proxy-smoke-'));
  fs.writeFileSync(
    path.join(bin, 'curl'),
    '#!/bin/sh\ncase "$*" in\n  */api/health*) printf 200 ;;\n  *) printf \'{}\\n%s\' "$SHIM_CODE" ;;\nesac\n',
    { mode: 0o755 },
  );
  const result = spawnSync('sh', [SCRIPT, 'key'], {
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, SHIM_CODE: code },
    encoding: 'utf8',
  });
  fs.rmSync(bin, { recursive: true, force: true });
  assert.equal(result.status, 1);
  return result.stderr.trim();
}

test('a rejected key is told the whole requirement, not only the role', () => {
  // The controller refuses a session-scoped ADMIN key, or one used from outside its IP allow-list,
  // with the same 403 a non-admin key gets.
  for (const code of ['401', '403']) {
    assert.equal(
      infraFailure(code),
      `FAIL: /api/infra/status returned HTTP ${code} (expected 200; the key must be an unscoped ADMIN key allowed from this IP)`,
    );
  }
});

test('a server error or no answer carries no key hint', () => {
  for (const code of ['000', '500', '503']) {
    assert.equal(infraFailure(code), `FAIL: /api/infra/status returned HTTP ${code} (expected 200)`);
  }
});

test('missing docker-proxy container tells the operator to enable the docker-proxy profile', () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-proxy-smoke-'));
  fs.writeFileSync(
    path.join(bin, 'curl'),
    '#!/bin/sh\ncase "$*" in\n  */api/health*) printf 200 ;;\n  *) printf \'{}\\n200\' ;;\nesac\n',
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const result = spawnSync('sh', [SCRIPT, 'key'], {
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
    encoding: 'utf8',
  });
  fs.rmSync(bin, { recursive: true, force: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--profile docker-proxy/);
});
