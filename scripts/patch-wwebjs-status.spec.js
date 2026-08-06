'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  applyStatusPatches,
  GATING_FIND,
  GATING_REPLACE,
  MEDIA_DATA_FIND,
  MEDIA_DATA_REPLACE,
  MEDIA_SEND_FIND,
  MEDIA_SEND_REPLACE,
} = require('./patch-wwebjs-status');

/**
 * The patcher rewrites a file this repository does not own, so what has to hold is that it only
 * ever fires on the exact shapes it was written for. A transform that silently does nothing (or
 * half-applies to a changed upstream) would ship a build whose status posting is still broken,
 * which is the failure this patch exists to prevent.
 */

/** A throwaway whatsapp-web.js tree containing just the file the patcher edits. */
function fakeWwjs(utilsSource) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-status-'));
  const utilsDir = path.join(dir, 'src', 'util', 'Injected');
  fs.mkdirSync(utilsDir, { recursive: true });
  fs.writeFileSync(path.join(utilsDir, 'Utils.js'), utilsSource);
  return { dir, utilsFile: path.join(utilsDir, 'Utils.js') };
}

/** Fake Utils.js source holding the given snippets in their real relative order. */
const withSnippets = (mediaData, gating, mediaSend) =>
  `exports.x = async () => {\n${mediaData}\n    const msg = new Model({\n${gating}\n    });\n${mediaSend}\n};\n`;

const PRISTINE = withSnippets(MEDIA_DATA_FIND, GATING_FIND, MEDIA_SEND_FIND);

test('applies both repairs to a pristine upstream tree', () => {
  const { dir, utilsFile } = fakeWwjs(PRISTINE);

  const result = applyStatusPatches(dir);

  assert.deepEqual(result.applied, ['status ranking-gating guard', 'media status send repair']);
  assert.deepEqual(result.skipped, []);
  const patched = fs.readFileSync(utilsFile, 'utf8');
  for (const replacement of [GATING_REPLACE, MEDIA_DATA_REPLACE, MEDIA_SEND_REPLACE]) {
    assert.ok(patched.includes(replacement));
  }
  for (const needle of [GATING_FIND, MEDIA_DATA_FIND, MEDIA_SEND_FIND]) {
    assert.ok(!patched.includes(needle));
  }
});

test('is idempotent — a second run is a no-op, not a double patch', () => {
  const { dir, utilsFile } = fakeWwjs(PRISTINE);
  applyStatusPatches(dir);
  const once = fs.readFileSync(utilsFile, 'utf8');

  const result = applyStatusPatches(dir);

  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.skipped, ['status ranking-gating guard', 'media status send repair']);
  assert.equal(fs.readFileSync(utilsFile, 'utf8'), once);
});

/**
 * The state an already-guarded install is actually in: the gating guard landed in an earlier run
 * (or an earlier version of this patcher), the media repair did not exist yet. The groups must
 * resolve independently — skipping one is not a reason to refuse the other.
 */
test('applies only the media repair when the gating guard is already present', () => {
  const { dir, utilsFile } = fakeWwjs(withSnippets(MEDIA_DATA_FIND, GATING_REPLACE, MEDIA_SEND_FIND));

  const result = applyStatusPatches(dir);

  assert.deepEqual(result.applied, ['media status send repair']);
  assert.deepEqual(result.skipped, ['status ranking-gating guard']);
  const patched = fs.readFileSync(utilsFile, 'utf8');
  assert.ok(patched.includes(MEDIA_SEND_REPLACE));
  assert.equal(patched.split(GATING_REPLACE).length - 1, 1, 'the existing guard must survive unchanged');
});

/**
 * The important one. If upstream changes a call, the patcher must refuse loudly rather than leave
 * the file untouched and report success — a silent skip ships a build that still throws on every
 * status post, and nothing downstream would notice until a user tried to post one.
 */
test('refuses an upstream shape it does not recognise', () => {
  const { dir, utilsFile } = fakeWwjs(
    withSnippets(MEDIA_DATA_FIND, '                    cannotBeRanked: somethingElse(),', MEDIA_SEND_FIND),
  );
  const before = fs.readFileSync(utilsFile, 'utf8');

  assert.throws(() => applyStatusPatches(dir), /unsupported Utils\.js shape for the status ranking-gating guard/);
  assert.equal(fs.readFileSync(utilsFile, 'utf8'), before, 'must not modify a file it did not understand');
});

/**
 * The media repair's two edits reference each other (`mediaMsgData` is declared by one and used by
 * the other), so a tree where only one matches must be refused as a whole — and the refusal must
 * also discard the OTHER group's otherwise-applyable edit, because the file is only ever written
 * once, whole.
 */
test('refuses a half-matching media group and leaves the whole file untouched', () => {
  const { dir, utilsFile } = fakeWwjs(withSnippets(MEDIA_DATA_REPLACE, GATING_FIND, MEDIA_SEND_FIND));
  const before = fs.readFileSync(utilsFile, 'utf8');

  assert.throws(() => applyStatusPatches(dir), /unsupported Utils\.js shape for the media status send repair/);
  assert.equal(
    fs.readFileSync(utilsFile, 'utf8'),
    before,
    'the applyable gating edit must not be written when a later group refuses',
  );
});

test('refuses when a call appears more than once', () => {
  const { dir } = fakeWwjs(PRISTINE + withSnippets(MEDIA_DATA_FIND, GATING_FIND, MEDIA_SEND_FIND));

  assert.throws(() => applyStatusPatches(dir), /unpatched: 2/);
});

/**
 * A tree holding a needle AND its replacement at once (a botched merge, a manually re-added call)
 * satisfies neither the apply nor the skip precondition — treating it as applyable would write a
 * second copy of the replacement into the file.
 */
test('refuses a tree containing both the unpatched and the patched form', () => {
  const { dir, utilsFile } = fakeWwjs(withSnippets(MEDIA_DATA_FIND, `${GATING_FIND}\n${GATING_REPLACE}`, MEDIA_SEND_FIND));
  const before = fs.readFileSync(utilsFile, 'utf8');

  assert.throws(() => applyStatusPatches(dir), /unsupported Utils\.js shape for the status ranking-gating guard/);
  assert.equal(fs.readFileSync(utilsFile, 'utf8'), before);
});

test('reports a missing whatsapp-web.js rather than pretending to patch it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-status-empty-'));

  assert.throws(() => applyStatusPatches(dir), /Utils\.js not found/);
});

/**
 * The exit-code contract both consumers stand on: postinstall passes `--best-effort` and must get
 * exit 0 for an unrecognised tree (a Baileys-only install must not fail `npm install`), while the
 * production image build runs the patcher bare and MUST get exit 1 for the same tree — that
 * failing build is the only thing standing between an upstream reshape and a shipped image whose
 * status posting is still broken. Exercised end-to-end via a copy of the script next to a fake
 * node_modules, because the default target path is resolved relative to the script file.
 */
test('CLI: unrecognised tree exits 1 bare and 0 under --best-effort', () => {
  const { spawnSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-status-cli-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  const script = path.join(root, 'scripts', 'patch-wwebjs-status.js');
  fs.copyFileSync(path.join(__dirname, 'patch-wwebjs-status.js'), script);
  const utilsDir = path.join(root, 'node_modules', 'whatsapp-web.js', 'src', 'util', 'Injected');
  fs.mkdirSync(utilsDir, { recursive: true });
  fs.writeFileSync(path.join(utilsDir, 'Utils.js'), 'exports.x = () => {};\n');

  const bare = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(bare.status, 1, 'the production image build must fail on a tree the patcher cannot repair');
  assert.match(bare.stderr, /unsupported Utils\.js shape/);

  const bestEffort = spawnSync(process.execPath, [script, '--best-effort'], { encoding: 'utf8' });
  assert.equal(bestEffort.status, 0, 'postinstall must not fail an install the patcher cannot help');
  assert.match(bestEffort.stderr, /skipped/);
});

/**
 * The guard has to preserve behaviour where the helper still exists — otherwise the patch would
 * silently change what WhatsApp records for every status on builds that were working fine. Asserted
 * on the snippet's shape rather than by evaluating it: this is generated code destined for a
 * browser page, and building a function out of a string to test it is not worth the hazard.
 */
test('gating guard calls the helper when present and falls back to false, rather than replacing it outright', () => {
  assert.ok(
    GATING_REPLACE.includes("typeof gating?.canCheckStatusRankingPosterGating === 'function'"),
    'must still call the real helper when the build provides it',
  );
  assert.ok(GATING_REPLACE.includes('gating.canCheckStatusRankingPosterGating()'), 'helper result is used as-is');
  assert.ok(GATING_REPLACE.includes(': false'), 'absent helper falls back to the pre-gating meaning');
  assert.ok(GATING_REPLACE.includes('catch'), 'a throwing require must not take the status post down');
});

/**
 * The media repair must stay shaped like the upstream fix it adopts (wwebjs/whatsapp-web.js#201816):
 * a single options object carrying the message data, and a returned model built from that same data
 * — the model constructed for the old positional flow is no longer the message that gets sent.
 */
test('media repair passes the upstream options object and returns a model built from it', () => {
  assert.ok(MEDIA_DATA_REPLACE.includes('...message,'), 'mediaMsgData starts from the built message');
  assert.ok(MEDIA_DATA_REPLACE.includes('to: chat.id,'), 'destination is the status chat');
  assert.ok(MEDIA_DATA_REPLACE.includes('author: from,'), 'author is the sender');

  assert.ok(MEDIA_SEND_REPLACE.includes('mediaMsgData,'), 'options carry the message data');
  assert.ok(MEDIA_SEND_REPLACE.includes('beforeSend: async () => {},'), 'beforeSend hook is provided');
  assert.ok(MEDIA_SEND_REPLACE.includes('funnelContext: undefined,'), 'funnelContext is explicit');
  assert.ok(!MEDIA_SEND_REPLACE.includes('[msg, mediaUpdate]'), 'the broken positional call is gone');
  assert.ok(
    MEDIA_SEND_REPLACE.includes('return isMedia'),
    'media returns the model built from mediaMsgData, text keeps the original msg',
  );
  assert.ok(MEDIA_SEND_REPLACE.includes(': msg;'), 'text status return value is unchanged');
});
