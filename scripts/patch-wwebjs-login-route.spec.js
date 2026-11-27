/**
 * Unit tests for scripts/patch-wwebjs-login-route.js (node:test — no jest, no deps).
 * Run: `npm run test:scripts`.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { applyPatch, isApplied, REPLACEMENTS } = require('./patch-wwebjs-login-route.js');

function makeFixture(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-login-route-'));
  const target = path.join(dir, 'src', 'Client.js');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
  return { dir, target };
}

const PRISTINE_BODY = REPLACEMENTS.map(([before]) => before).join('\n// ---\n');

test('applyPatch transforms pristine Client.js and is idempotent', () => {
  const { dir, target } = makeFixture(PRISTINE_BODY);
  try {
    const first = applyPatch(dir);
    assert.equal(first.skipped, false);
    assert.equal(isApplied(dir), true);

    const written = fs.readFileSync(target, 'utf8');
    for (const [before, after] of REPLACEMENTS) {
      assert.equal(written.includes(before), false);
      assert.equal(written.includes(after), true);
    }

    const second = applyPatch(dir);
    assert.equal(second.skipped, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('applyPatch throws on unknown Client.js shape and isApplied returns false', () => {
  const { dir } = makeFixture('// unrelated content\n');
  try {
    assert.equal(isApplied(dir), false);
    assert.throws(() => applyPatch(dir), /unsupported Client\.js shape/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('applyPatch throws when Client.js is missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-login-route-missing-'));
  try {
    assert.throws(() => applyPatch(dir), /Client\.js not found/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
