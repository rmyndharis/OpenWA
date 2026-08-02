'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { applyBackport } = require('./patch-wwebjs-newsletter-preview.js');

const LEGACY_CALL =
  "let preview = await window\n                    .require('WAWebLinkPreviewChatAction')\n                    .getLinkPreview(link);";
const CONTEXT_CALL =
  "let preview = await window\n                    .require('WAWebLinkPreviewChatAction')\n                    .getLinkPreview(link, chat);";

function makeDependency(source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-newsletter-preview-'));
  const utils = path.join(root, 'src', 'util', 'Injected', 'Utils.js');
  fs.mkdirSync(path.dirname(utils), { recursive: true });
  fs.writeFileSync(utils, source);
  return { root, utils };
}

test('patches link-preview generation to include the destination chat', () => {
  const { root, utils } = makeDependency(`before\n${LEGACY_CALL}\nafter\n`);

  const result = applyBackport(root);

  assert.deepEqual(result, { skipped: false, note: 'destination chat context added to link previews' });
  assert.equal(fs.readFileSync(utils, 'utf8'), `before\n${CONTEXT_CALL}\nafter\n`);
});

test('is idempotent when destination chat context is already present', () => {
  const { root, utils } = makeDependency(`before\n${CONTEXT_CALL}\nafter\n`);
  const original = fs.readFileSync(utils, 'utf8');

  assert.deepEqual(applyBackport(root), {
    skipped: true,
    reason: 'installed whatsapp-web.js already passes destination chat context',
  });
  assert.equal(fs.readFileSync(utils, 'utf8'), original);
});

test('rejects an unknown dependency shape without changing it', () => {
  const { root, utils } = makeDependency('window.WWebJS.sendMessage = async () => {};\n');
  const original = fs.readFileSync(utils, 'utf8');

  assert.throws(() => applyBackport(root), /unsupported Utils\.js shape/);
  assert.equal(fs.readFileSync(utils, 'utf8'), original);
});

test('rejects an ambiguous dependency shape without changing it', () => {
  const { root, utils } = makeDependency(`${LEGACY_CALL}\n${CONTEXT_CALL}\n`);
  const original = fs.readFileSync(utils, 'utf8');

  assert.throws(() => applyBackport(root), /unsupported Utils\.js shape/);
  assert.equal(fs.readFileSync(utils, 'utf8'), original);
});
