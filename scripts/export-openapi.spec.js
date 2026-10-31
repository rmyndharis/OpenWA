'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * The export keeps its SQLite file in a temp directory and promises to remove it. It used to create
 * the directory before it looked at its arguments and to load the application outside the block that
 * cleans up, so a usage error or an environment the application refuses left a directory behind.
 */

const ROOT = path.join(__dirname, '..');
const TS_NODE = require.resolve('ts-node/dist/bin.js');
const SCRIPT = path.join(ROOT, 'scripts', 'export-openapi.ts');

function run(args, env) {
  // A private cwd and TMPDIR: the application writes data/ beside the cwd, and the leftovers are
  // counted in the TMPDIR.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'export-openapi-'));
  try {
    const result = spawnSync(process.execPath, [TS_NODE, '--transpile-only', SCRIPT, ...args], {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: cwd,
        TMPDIR: cwd,
        TS_NODE_PROJECT: path.join(ROOT, 'tsconfig.json'),
        ...env,
      },
      encoding: 'utf8',
      timeout: 120000,
    });
    assert.equal(result.error, undefined);
    return { result, leftovers: fs.readdirSync(cwd).filter(name => name.startsWith('openapi-export-')) };
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

test('a missing output path leaves no temporary directory', () => {
  const { result, leftovers } = run([], {});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage:/);
  assert.deepEqual(leftovers, []);
});

test('an environment the application refuses leaves no temporary directory', () => {
  const { result, leftovers } = run(['out.json'], { WEBHOOK_SSRF_PROTECT: 'off' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /WEBHOOK_SSRF_PROTECT/);
  assert.deepEqual(leftovers, []);
});
