'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * The Dockerfile hand-lists the patchers it copies into the production stage and the ones it runs
 * fatally afterwards. A hand-written list silently loses a patcher added later: the file is absent
 * from the image, postinstall's fs.existsSync guard skips it without a word, and the fix it carries
 * never reaches the published image. That is exactly what happened to the Baileys app-state
 * patcher, which shipped in postinstall and was never added here.
 *
 * Derive the set instead of restating it.
 */
const ROOT = path.join(__dirname, '..');
const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');

const patchers = fs
  .readdirSync(__dirname)
  .filter(f => f.startsWith('patch-') && f.endsWith('.js') && !f.endsWith('.spec.js'))
  .sort();

test('the fixture finds the patchers at all', () => {
  // Guard the guard: an empty list would make every assertion below vacuously pass.
  assert.ok(patchers.length >= 5, `expected several patchers, found ${patchers.length}`);
});

test('every patcher is COPIED into the production stage', () => {
  const missing = patchers.filter(p => !dockerfile.includes(`scripts/${p}`));
  assert.deepEqual(missing, [], `not copied into the image: ${missing.join(', ')}`);
});

test('every patcher is RUN fatally after npm ci', () => {
  // The postinstall hook runs them --best-effort; the explicit run is the real gate, so a shape
  // change fails the image build instead of shipping unpatched.
  const missing = patchers.filter(p => !dockerfile.includes(`node scripts/${p}`));
  assert.deepEqual(missing, [], `never run in the image build: ${missing.join(', ')}`);
});

test('every patcher is also wired into postinstall', () => {
  // Ask postinstall what it would run, rather than searching its text for the name. A substring
  // search is satisfied by the patcher appearing in a comment, so a patcher could be described in
  // the docblock, wired nowhere, and still pass here.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-patchers-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  for (const p of patchers) fs.writeFileSync(path.join(root, 'scripts', p), '// stub\n');

  const planned = require('./postinstall.js')
    .planSteps(root, {})
    .flatMap(step => step.args || [])
    .map(arg => path.basename(arg));
  const missing = patchers.filter(p => !planned.includes(p));
  assert.deepEqual(missing, [], `not wired into postinstall: ${missing.join(', ')}`);
});
