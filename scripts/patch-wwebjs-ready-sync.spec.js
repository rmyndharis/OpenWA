'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequire } = require('node:module');

const {
  applyReadySyncPatch,
  isApplied,
  FLAG_INIT_FIND,
  FLAG_INIT_REPLACE,
  ATTACH_MARK_FIND,
  ATTACH_MARK_REPLACE,
  HAS_SYNCED_FIND,
  HAS_SYNCED_REPLACE,
  PAGE_RESET_FIND,
  PAGE_RESET_REPLACE,
} = require('./patch-wwebjs-ready-sync');

/**
 * Same contract as the sibling patcher specs: the patcher rewrites a file this repository does not
 * own, so it must fire only on the exact shape it was written for, refuse loudly on anything else,
 * and never leave a half-patched tree — the four edits reference one another (the adapter reads
 * the flag the constructor initialises, the attach path sets and a new page resets).
 */

function fakeWwjs(clientSource) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-ready-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'Client.js'), clientSource);
  return { dir, clientFile: path.join(dir, 'src', 'Client.js') };
}

// The branch of the post-auth callback that runs for a page without the helpers, as upstream spells it.
const INJECTED_BRANCH = '                if (!injected) {';

const withSnippets = (flagInit, attachMark, hasSynced, injectedBranch = INJECTED_BRANCH) =>
  `class Client {\n    constructor() {\n${flagInit}\n    }\n    async inject() {\n${injectedBranch}\n${attachMark}\n${hasSynced}\n    }\n}\n`;

const PRISTINE = withSnippets(FLAG_INIT_FIND, ATTACH_MARK_FIND, HAS_SYNCED_FIND);
// What an earlier release of this patcher left behind: the three edits, the branch untouched.
const EARLIER_RELEASE = withSnippets(FLAG_INIT_REPLACE, ATTACH_MARK_REPLACE, HAS_SYNCED_REPLACE);
// The marker reset as the first statement of the branch, comment lines allowed in between.
const RESET_FIRST = /if \(!injected\) \{\s*(?:\/\/[^\n]*\n\s*)*this\.eventsAttached = false;/;

test('applies all four edits to a pristine upstream tree', () => {
  const { dir, clientFile } = fakeWwjs(PRISTINE);

  const result = applyReadySyncPatch(dir);

  assert.equal(result.skipped, false);
  const patched = fs.readFileSync(clientFile, 'utf8');
  for (const replacement of [FLAG_INIT_REPLACE, ATTACH_MARK_REPLACE, HAS_SYNCED_REPLACE, PAGE_RESET_REPLACE]) {
    assert.ok(patched.includes(replacement));
  }
});

test('isApplied is false on a pristine tree and true once the patch has run', () => {
  const { dir } = fakeWwjs(PRISTINE);

  // Each replacement contains its own find, so a raw find count would read a patched tree as pristine.
  assert.equal(isApplied(dir), false);
  applyReadySyncPatch(dir);
  assert.equal(isApplied(dir), true);
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
  fs.copyFileSync(path.join(__dirname, 'atomic-write.js'), path.join(path.dirname(script), 'atomic-write.js'));
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
 * must start false, flip true only after the attach resolves and fall back to false for a new page;
 * the level-check must call the SAME handler the edge calls, guarded on the already-true level.
 */
test('replacements carry the contract the adapter relies on', () => {
  assert.ok(FLAG_INIT_REPLACE.includes('this.eventsAttached = false;'), 'flag starts false');
  assert.ok(
    ATTACH_MARK_REPLACE.indexOf('await this.attachEventListeners();') <
      ATTACH_MARK_REPLACE.indexOf('this.eventsAttached = true;'),
    'flag flips true only after the attach resolves',
  );
  assert.ok(
    PAGE_RESET_REPLACE.startsWith(PAGE_RESET_FIND) && PAGE_RESET_REPLACE.endsWith('this.eventsAttached = false;'),
    'flag resets as the first statement of the branch a page without the helpers runs',
  );
  assert.ok(HAS_SYNCED_REPLACE.includes("if (window.require('WAWebSocketModel').Socket.hasSynced)"), 'level guard');
  assert.equal(
    HAS_SYNCED_REPLACE.split('window.onAppStateHasSyncedEvent()').length - 1,
    2,
    'level-check fires the same handler the edge fires',
  );
});

test('resets the marker as the first statement of the branch a page without the helpers runs', () => {
  const { dir, clientFile } = fakeWwjs(PRISTINE);

  applyReadySyncPatch(dir);

  const patched = fs.readFileSync(clientFile, 'utf8');
  assert.match(patched, RESET_FIRST);
  assert.ok(
    patched.indexOf('this.eventsAttached = false;', patched.indexOf('async inject()')) <
      patched.indexOf('await this.attachEventListeners();'),
  );
});

test('upgrades a tree an earlier release of this patcher left behind', () => {
  const { dir, clientFile } = fakeWwjs(EARLIER_RELEASE);
  assert.equal(isApplied(dir), false, 'a tree without the reset is not fully patched');

  const result = applyReadySyncPatch(dir);

  assert.equal(result.skipped, false);
  assert.equal(isApplied(dir), true);
  const fresh = fakeWwjs(PRISTINE);
  applyReadySyncPatch(fresh.dir);
  assert.equal(fs.readFileSync(clientFile, 'utf8'), fs.readFileSync(fresh.clientFile, 'utf8'));
  assert.equal(applyReadySyncPatch(dir).skipped, true);
});

test('refuses a tree that carries the reset without the edits it belongs to, and leaves the file untouched', () => {
  const { dir, clientFile } = fakeWwjs(
    withSnippets(FLAG_INIT_FIND, ATTACH_MARK_FIND, HAS_SYNCED_FIND, PAGE_RESET_REPLACE),
  );
  const before = fs.readFileSync(clientFile, 'utf8');

  assert.throws(() => applyReadySyncPatch(dir), /unsupported Client\.js shape/);
  assert.equal(fs.readFileSync(clientFile, 'utf8'), before);
});

test('refuses an earlier release tree whose branch no longer has the shape the reset anchors on', () => {
  const { dir, clientFile } = fakeWwjs(
    withSnippets(FLAG_INIT_REPLACE, ATTACH_MARK_REPLACE, HAS_SYNCED_REPLACE, '        if (injected === false) {'),
  );
  const before = fs.readFileSync(clientFile, 'utf8');

  assert.throws(() => applyReadySyncPatch(dir), /unsupported Client\.js shape/);
  assert.equal(fs.readFileSync(clientFile, 'utf8'), before);
});

/**
 * The patched text itself, run against a scripted page. whatsapp-web.js re-runs inject() on every main-frame
 * navigation and the new page walks the post-auth pipeline again, so the marker has to describe the page now loaded.
 * The installed Client.js is patched in a temporary copy and evaluated with its requires resolved from the installed
 * library, so the result does not depend on how far the installed tree itself has been patched.
 */
function loadPatchedLibrary() {
  const installed = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js', 'src', 'Client.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-ready-behaviour-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.copyFileSync(installed, path.join(dir, 'src', 'Client.js'));
  applyReadySyncPatch(dir);
  const source = fs.readFileSync(path.join(dir, 'src', 'Client.js'), 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });

  const libraryRequire = createRequire(installed);
  const loaded = { exports: {} };
  new Function('exports', 'require', 'module', '__filename', '__dirname', source)(
    loaded.exports,
    libraryRequire,
    loaded,
    installed,
    path.dirname(installed),
  );
  return {
    Client: loaded.exports,
    LoadUtils: libraryRequire('./util/Injected/Utils').LoadUtils,
    ExposeAuthStore: libraryRequire('./util/Injected/AuthStore/AuthStore').ExposeAuthStore,
  };
}

function scriptedPage({ LoadUtils, ExposeAuthStore }) {
  const exposed = new Map();
  const state = { helpers: false };
  return {
    exposed,
    state,
    async exposeFunction(name, fn) {
      exposed.set(name, fn);
    },
    async evaluate(fn, ...args) {
      if (typeof fn === 'string') {
        if (fn.includes('window.Debug?.VERSION')) return true;
        if (fn.includes('window.WWebJS != undefined')) return state.helpers;
        return undefined;
      }
      if (fn === ExposeAuthStore) return undefined;
      if (fn === LoadUtils) {
        state.helpers = true;
        return undefined;
      }
      const source = String(fn);
      if (source.includes('!!window[name]')) return exposed.has(args[0]);
      if (source.includes("typeof window.WWebJS !== 'undefined'")) return state.helpers;
      if (source.includes('Socket.state')) return false; // already paired: no QR
      if (source.includes('Conn.serialize')) {
        return { pushname: 'me', wid: { server: 'c.us', user: '15550001111', _serialized: '15550001111@c.us' } };
      }
      return undefined; // listener registrations
    },
  };
}

test('the marker follows the page now loaded: a failed re-attach leaves it false until a later attach succeeds', async () => {
  const library = loadPatchedLibrary();
  const page = scriptedPage(library);
  const client = new library.Client();
  client.pupPage = page;
  client.setDeviceName = async () => undefined;
  client.getWWebVersion = async () => '2.3000.0';
  let attachFails = false;
  client.attachEventListeners = async () => {
    if (attachFails) throw new Error('Execution context was destroyed');
  };
  await client.inject();
  const postAuth = () => page.exposed.get('onAppStateHasSyncedEvent')();

  assert.equal(client.eventsAttached, false, 'before the first attach');
  await postAuth();
  assert.equal(client.eventsAttached, true, 'after the first page attached');

  // A bare run on a page that already has the helpers (a second hasSynced pass, a same-document navigation).
  await postAuth();
  assert.equal(client.eventsAttached, true, 'a page that keeps its helpers is not reset');

  // WhatsApp Web reloads: a new document without the helpers, and this time the attach throws.
  page.state.helpers = false;
  attachFails = true;
  await client.inject();
  await assert.rejects(postAuth(), /Execution context was destroyed/);
  assert.equal(client.eventsAttached, false, 'the bridge of the page now loaded is not attached');

  // The next reload re-attaches.
  page.state.helpers = false;
  attachFails = false;
  await client.inject();
  await postAuth();
  assert.equal(client.eventsAttached, true);
});

test('applies to a copy of the installed whatsapp-web.js, or finds it applied there already', () => {
  // The fixtures above are built from this patcher's own find strings, so they pass just the same once the
  // library stops containing them. A copy of the installed file does not.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-ready-installed-'));
  const file = path.join('src', 'Client.js');
  fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js', file), path.join(dir, file));
  applyReadySyncPatch(dir);
  assert.equal(isApplied(dir), true);
  fs.rmSync(dir, { recursive: true, force: true });
});
