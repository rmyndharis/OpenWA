'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { applyAppStatePatch, LOOP_FIND } = require('./patch-baileys-appstate');

/**
 * Same contract as the sibling patcher specs: the patcher rewrites a file this repository does not
 * own, so it must fire only on the exact shape it was written for, refuse loudly on anything else,
 * and be safe to run twice (postinstall runs on every install).
 */

function fakeBaileys(chatsSource) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baileys-appstate-'));
  fs.mkdirSync(path.join(dir, 'lib', 'Socket'), { recursive: true });
  const file = path.join(dir, 'lib', 'Socket', 'chats.js');
  fs.writeFileSync(file, chatsSource);
  return { dir, file };
}

const REAL_SHAPE = `            while (collectionsToHandle.size) {
${LOOP_FIND}
                    const name = key;
                }
            }
`;

test('bounds the loop on an empty decode', () => {
  const { dir, file } = fakeBaileys(REAL_SHAPE);
  const result = applyAppStatePatch(dir);
  assert.equal(result.skipped, undefined);
  const patched = fs.readFileSync(file, 'utf8');
  assert.match(patched, /if \(!Object\.keys\(decoded\)\.length\) \{\n\s+break;/);
  // The original walk is preserved, not replaced.
  assert.ok(patched.includes('for (const key in decoded) {'));
});

test('is idempotent — a second run does not double-patch', () => {
  const { dir, file } = fakeBaileys(REAL_SHAPE);
  applyAppStatePatch(dir);
  const once = fs.readFileSync(file, 'utf8');
  const second = applyAppStatePatch(dir);
  assert.equal(second.skipped, true);
  assert.equal(fs.readFileSync(file, 'utf8'), once);
});

test('refuses loudly when the upstream shape changed', () => {
  const { dir, file } = fakeBaileys('const decoded = somethingElse();\nfor (const key in decoded) {\n}\n');
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => applyAppStatePatch(dir), /found 0/);
  // Refusing must not leave a partial write behind.
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('refuses when the decode site appears more than once', () => {
  const { dir } = fakeBaileys(`${LOOP_FIND}\n}\n${LOOP_FIND}\n}\n`);
  assert.throws(() => applyAppStatePatch(dir), /found 2/);
});

test('skips a tree that has no chats.js rather than throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baileys-absent-'));
  const result = applyAppStatePatch(dir);
  assert.equal(result.skipped, true);
  assert.match(result.reason, /not found/);
});
