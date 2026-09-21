'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { applyBackport, isApplied, ANCHOR, FIX } = require('./patch-wwebjs-media-id.js');

// The real shape around the anchor: the outgoing message object closes, then the bot comment.
const BEFORE = `            ...extraOptions,\n        };\n\n${ANCHOR}        if (botOptions) {\n`;
const AFTER = `            ...extraOptions,\n        };\n\n${FIX}${ANCHOR}        if (botOptions) {\n`;

function makeDependency(source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-media-id-'));
  const utils = path.join(root, 'src', 'util', 'Injected', 'Utils.js');
  fs.mkdirSync(path.dirname(utils), { recursive: true });
  fs.writeFileSync(utils, source);
  return { root, utils };
}

test('strips the media model id from the outgoing message before it is built', () => {
  const { root, utils } = makeDependency(`head\n${BEFORE}tail\n`);

  const result = applyBackport(root);

  assert.deepEqual(result, { skipped: false, note: 'media model id stripped from outgoing messages' });
  assert.equal(fs.readFileSync(utils, 'utf8'), `head\n${AFTER}tail\n`);
});

test('is idempotent once the fix is present', () => {
  const { root, utils } = makeDependency(`head\n${AFTER}tail\n`);
  const original = fs.readFileSync(utils, 'utf8');

  assert.deepEqual(applyBackport(root), {
    skipped: true,
    reason: 'installed whatsapp-web.js already strips the media model id',
  });
  assert.equal(fs.readFileSync(utils, 'utf8'), original);
});

test('reports the patch as applied only once the transform has run', () => {
  const { root } = makeDependency(`head\n${BEFORE}tail\n`);

  assert.equal(isApplied(root), false);
  applyBackport(root);
  assert.equal(isApplied(root), true);
});

test('rejects an unknown dependency shape without changing it', () => {
  const { root, utils } = makeDependency('window.WWebJS.sendMessage = async () => {};\n');
  const original = fs.readFileSync(utils, 'utf8');

  assert.throws(() => applyBackport(root), /unsupported Utils\.js shape/);
  assert.equal(fs.readFileSync(utils, 'utf8'), original);
});

test('rejects an ambiguous dependency shape without changing it', () => {
  const { root, utils } = makeDependency(`${BEFORE}${BEFORE}`);
  const original = fs.readFileSync(utils, 'utf8');

  assert.throws(() => applyBackport(root), /unsupported Utils\.js shape/);
  assert.equal(fs.readFileSync(utils, 'utf8'), original);
});

// The patch stands down when the fix is already there, so a shape carrying both the fix and a
// second anchor is not one it understands either.
test('rejects a fix present alongside a second anchor', () => {
  const { root, utils } = makeDependency(`${AFTER}${BEFORE}`);
  const original = fs.readFileSync(utils, 'utf8');

  assert.throws(() => applyBackport(root), /unsupported Utils\.js shape/);
  assert.equal(fs.readFileSync(utils, 'utf8'), original);
});
