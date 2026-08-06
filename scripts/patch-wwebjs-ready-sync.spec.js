'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  applyReadySyncPatch,
  FLAG_INIT_FIND,
  FLAG_INIT_REPLACE,
  ATTACH_MARK_FIND,
  ATTACH_MARK_REPLACE,
  HAS_SYNCED_FIND,
  HAS_SYNCED_REPLACE,
} = require('./patch-wwebjs-ready-sync');

/**
 * Same contract as the sibling patcher specs: the patcher rewrites a file this repository does not
 * own, so it must fire only on the exact shape it was written for, refuse loudly on anything else,
 * and never leave a half-patched tree — the three edits reference one another (the adapter reads
 * the flag the constructor initialises and the attach path sets).
 */

function fakeWwjs(clientSource) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-ready-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'Client.js'), clientSource);
  return { dir, clientFile: path.join(dir, 'src', 'Client.js') };
}

const withSnippets = (flagInit, attachMark, hasSynced) =>
  `class Client {\n    constructor() {\n${flagInit}\n    }\n    async inject() {\n${attachMark}\n${hasSynced}\n    }\n}\n`;

const PRISTINE = withSnippets(FLAG_INIT_FIND, ATTACH_MARK_FIND, HAS_SYNCED_FIND);

test('applies all three edits to a pristine upstream tree', () => {
  const { dir, clientFile } = fakeWwjs(PRISTINE);

  const result = applyReadySyncPatch(dir);

  assert.equal(result.skipped, false);
  const patched = fs.readFileSync(clientFile, 'utf8');
  for (const replacement of [FLAG_INIT_REPLACE, ATTACH_MARK_REPLACE, HAS_SYNCED_REPLACE]) {
    assert.ok(patched.includes(replacement));
  }
});

test('is idempotent — a second run is a no-op, not a double patch', () => {
  const { dir, clientFile } = fakeWwjs(PRISTINE);
  applyReadySyncPatch(dir);
  const once = fs.readFileSync(clientFile, 'utf8');

  const result = applyReadySyncPatch(dir);

  assert.equal(result.skipped, true);
  assert.equal(fs.readFileSync(clientFile, 'utf8'), once);
});

test('refuses an upstream shape it does not recognise and leaves the file untouched', () => {
  const { dir, clientFile } = fakeWwjs(withSnippets(FLAG_INIT_FIND, '        somethingElse();', HAS_SYNCED_FIND));
  const before = fs.readFileSync(clientFile, 'utf8');

  assert.throws(() => applyReadySyncPatch(dir), /unsupported Client\.js shape/);
  assert.equal(fs.readFileSync(clientFile, 'utf8'), before);
});

test('refuses a tree containing both the unpatched and the patched form', () => {
  const { dir, clientFile } = fakeWwjs(withSnippets(`${FLAG_INIT_FIND}\n${FLAG_INIT_REPLACE}`, ATTACH_MARK_FIND, HAS_SYNCED_FIND));
  const before = fs.readFileSync(clientFile, 'utf8');

  assert.throws(() => applyReadySyncPatch(dir), /unsupported Client\.js shape/);
  assert.equal(fs.readFileSync(clientFile, 'utf8'), before);
});

test('reports a missing whatsapp-web.js rather than pretending to patch it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-ready-empty-'));

  assert.throws(() => applyReadySyncPatch(dir), /Client\.js not found/);
});

test('CLI: unrecognised tree exits 1 bare and 0 under --best-effort', () => {
  const { spawnSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-ready-cli-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  const script = path.join(root, 'scripts', 'patch-wwebjs-ready-sync.js');
  fs.copyFileSync(path.join(__dirname, 'patch-wwebjs-ready-sync.js'), script);
  const clientDir = path.join(root, 'node_modules', 'whatsapp-web.js', 'src');
  fs.mkdirSync(clientDir, { recursive: true });
  fs.writeFileSync(path.join(clientDir, 'Client.js'), 'class Client {}\n');

  const bare = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(bare.status, 1, 'the production image build must fail on a tree the patcher cannot repair');
  assert.match(bare.stderr, /unsupported Client\.js shape/);

  const bestEffort = spawnSync(process.execPath, [script, '--best-effort'], { encoding: 'utf8' });
  assert.equal(bestEffort.status, 0, 'postinstall must not fail an install the patcher cannot help');
  assert.match(bestEffort.stderr, /skipped/);
});

/**
 * Shape assertions on the replacements themselves: the properties other code depends on. The
 * adapter's reconcile probe reads `eventsAttached === false` as "bridge not ready", so the flag
 * must start false and flip true only after the attach resolves; the level-check must call the
 * SAME handler the edge calls, guarded on the already-true level.
 */
test('replacements carry the contract the adapter relies on', () => {
  assert.ok(FLAG_INIT_REPLACE.includes('this.eventsAttached = false;'), 'flag starts false');
  assert.ok(
    ATTACH_MARK_REPLACE.indexOf('await this.attachEventListeners();') <
      ATTACH_MARK_REPLACE.indexOf('this.eventsAttached = true;'),
    'flag flips true only after the attach resolves',
  );
  assert.ok(HAS_SYNCED_REPLACE.includes("if (window.require('WAWebSocketModel').Socket.hasSynced)"), 'level guard');
  assert.equal(
    HAS_SYNCED_REPLACE.split('window.onAppStateHasSyncedEvent()').length - 1,
    2,
    'level-check fires the same handler the edge fires',
  );
});
