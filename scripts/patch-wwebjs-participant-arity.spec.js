'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  applyParticipantArityPatches,
  GROUPS,
  ACTIONS,
  findFor,
  replaceFor,
  LEGACY_REPLACE,
} = require('./patch-wwebjs-participant-arity');

/**
 * The patcher rewrites a file this repository does not own, so what has to hold is that it fires on
 * exactly the shapes it was written for and refuses everything else. A transform that silently did
 * nothing would ship a build where removing a non-member still answers 500 and promoting one still
 * answers 200 claiming success — the two failures this patch exists to prevent (#1220).
 *
 * The fixture is the INSTALLED GroupChat.js rather than a hand-written approximation: a synthetic
 * fixture can only prove the patcher matches a shape I wrote, not the shape upstream ships.
 */
const INSTALLED_GROUP_CHAT = path.join(
  __dirname,
  '..',
  'node_modules',
  'whatsapp-web.js',
  'src',
  'structures',
  'GroupChat.js',
);

/** A throwaway whatsapp-web.js tree holding just the file the patcher edits. */
function fakeWwjs(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-arity-'));
  const structures = path.join(dir, 'src', 'structures');
  fs.mkdirSync(structures, { recursive: true });
  const file = path.join(structures, 'GroupChat.js');
  fs.writeFileSync(file, source);
  return { dir, file };
}

/**
 * The installed tree may ALREADY be patched: `npm ci` runs postinstall, which applies this very
 * patcher, so on a CI runner the file is transformed before this spec ever reads it while a local
 * checkout that never re-installed still holds the pristine upstream text. Reversing the transform
 * first makes the fixture identical in both states.
 *
 * This does not weaken the check. If upstream drifts, neither the patched nor the unpatched anchor
 * is present, the reversal is a no-op, and the assertions below fail — which is the point.
 */
const readInstalled = () => {
  let source = fs.readFileSync(INSTALLED_GROUP_CHAT, 'utf8');
  for (const action of ACTIONS) {
    source = source.split(replaceFor(action)).join(findFor(action));
  }
  return source;
};

test('the unpatched-shape reversal is an exact inverse of the transform', () => {
  // This is what makes the fixture safe on a CI runner, where `npm ci` has already run postinstall
  // and patched the installed tree before this spec reads it. If the reversal were not an exact
  // inverse, every assertion below would be testing a shape that never existed.
  const pristine = readInstalled();
  const { dir, file } = fakeWwjs(pristine);
  applyParticipantArityPatches(dir);

  let reversed = fs.readFileSync(file, 'utf8');
  assert.notEqual(reversed, pristine, 'the patch must actually change the file, or this proves nothing');
  for (const action of ACTIONS) {
    reversed = reversed.split(replaceFor(action)).join(findFor(action));
  }
  assert.equal(reversed, pristine);
});

test('the fixture models the shape the patcher acts on', () => {
  // Guard the guard: if the installed tree stopped containing these anchors every assertion below
  // would fail for the wrong reason, or pass vacuously once the patcher started skipping.
  assert.equal(GROUPS.length, 3, `expected three groups, found ${GROUPS.length}`);
  const source = readInstalled();
  for (const action of ACTIONS) {
    assert.equal(
      source.split(findFor(action)).length - 1,
      1,
      `installed GroupChat.js does not contain exactly one unpatched ${action} body`,
    );
  }
});

test('applies every group to the installed upstream shape', () => {
  const { dir, file } = fakeWwjs(readInstalled());

  const { applied, skipped } = applyParticipantArityPatches(dir);

  assert.equal(applied.length, 3);
  assert.deepEqual(skipped, []);

  const out = fs.readFileSync(file, 'utf8');
  assert.equal(out.split('return { status: 200, matched };').length - 1, 3);
  assert.equal(out.split('const matched = participants.map(Boolean);').length - 1, 3);
  assert.equal(out.split('if (present.length) {').length - 1, 3);
  // The surviving participants, not the holed array, are what reaches WhatsApp.
  for (const action of ACTIONS) {
    assert.ok(out.includes(`.${action}(chat, present);`), `${action} still passes the unfiltered array`);
  }
  // The bare `{ status: 200 }` return must be gone from all three, or one of them still lies.
  assert.equal(out.split('return { status: 200 };').length - 1, 0);
});

test('never calls the WA Web action with an empty list', () => {
  const { dir, file } = fakeWwjs(readInstalled());
  applyParticipantArityPatches(dir);
  const out = fs.readFileSync(file, 'utf8');

  // Every action call in the three patched bodies must sit inside the arity guard. Matching the
  // guard and the call as one block is what makes this a check rather than a spot inspection: two
  // separate `includes` would both pass even if the guard sat around unrelated code.
  for (const action of ACTIONS) {
    const guardedCall = `if (present.length) {
                    await window
                        .require('WAWebModifyParticipantsGroupAction')
                        .${action}(chat, present);
                }`;
    assert.equal(out.split(guardedCall).length - 1, 1, `${action} is not guarded by the arity check`);
  }
});

test('acts only on members whose status would actually change', () => {
  // WhatsApp Web rejects a status change that changes nothing, and the minified bundle reports that
  // as an unnamed error — promoting an existing admin answered 500. Reproduced live before this test
  // was written. `remove` keeps acting on every member; only the two status ops narrow.
  const { dir, file } = fakeWwjs(readInstalled());
  applyParticipantArityPatches(dir);
  const out = fs.readFileSync(file, 'utf8');

  assert.equal(out.split('const present = participants.filter((p) => p && !p.isAdmin);').length - 1, 1);
  assert.equal(out.split('const present = participants.filter((p) => p && p.isAdmin);').length - 1, 1);
  assert.equal(out.split('const present = participants.filter(Boolean);').length - 1, 1);
});

test('upgrades a tree left behind by the previous version of this patcher', () => {
  // The legacy shape matches neither the pristine find nor the current replace, so without the
  // rewind the patcher would refuse an already-installed tree as an unknown shape — the upgrade
  // would fail on exactly the machines that already had the fix.
  let legacy = readInstalled();
  for (const action of ACTIONS) {
    legacy = legacy.split(findFor(action)).join(LEGACY_REPLACE(action));
  }
  assert.notEqual(legacy, readInstalled(), 'the legacy fixture must differ, or this proves nothing');

  const { dir, file } = fakeWwjs(legacy);
  const { applied, skipped } = applyParticipantArityPatches(dir);

  // Two applied, not three: removeParticipants' body is unchanged between versions, so the legacy
  // tree already carries its final shape and it is skipped rather than rewritten.
  assert.deepEqual(applied.sort(), ['demoteParticipants batch truth', 'promoteParticipants batch truth']);
  assert.deepEqual(skipped, ['removeParticipants batch truth']);
  const out = fs.readFileSync(file, 'utf8');
  assert.equal(out.split('const present = participants.filter((p) => p && !p.isAdmin);').length - 1, 1);
  assert.equal(out.split('const present = participants.filter((p) => p && p.isAdmin);').length - 1, 1);
  // Only the two status ops changed between versions; removeParticipants' body is identical in both,
  // so asserting its legacy text is gone would assert the wrong thing.
  for (const action of ['promoteParticipants', 'demoteParticipants']) {
    assert.equal(out.split(LEGACY_REPLACE(action)).length - 1, 0, `${action} still carries the legacy body`);
  }
});

test('is idempotent — a second run skips every group', () => {
  const { dir } = fakeWwjs(readInstalled());

  applyParticipantArityPatches(dir);
  const second = applyParticipantArityPatches(dir);

  assert.deepEqual(second.applied, []);
  assert.equal(second.skipped.length, 3);
});

test('refuses an unknown shape instead of writing a half-patched tree', () => {
  // One action drifts upstream; the other two still match. The patcher must refuse rather than
  // apply the two it recognises and leave the third silently broken.
  const drifted = readInstalled().replace(
    findFor('demoteParticipants'),
    '                ).filter((x) => x);\n                await somethingElse();\n                return { status: 200 };',
  );
  const { dir, file } = fakeWwjs(drifted);
  const before = fs.readFileSync(file, 'utf8');

  assert.throws(() => applyParticipantArityPatches(dir), /unsupported GroupChat\.js shape/);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'a refused run must leave the file untouched');
});

test('refuses a tree that is missing the file entirely', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-arity-empty-'));
  assert.throws(() => applyParticipantArityPatches(dir), /GroupChat\.js not found/);
});
