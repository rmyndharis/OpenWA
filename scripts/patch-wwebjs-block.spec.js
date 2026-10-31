'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  applyBlockPatches,
  isApplied,
  GROUPS,
  findFor,
  replaceFor,
  LEGACY_UNBLOCK_REPLACE,
  normalizeLegacy,
} = require('./patch-wwebjs-block');

/**
 * The patcher rewrites a file this repository does not own, so what has to hold is that it fires on
 * exactly the shape it was written for and refuses everything else. A transform that silently did
 * nothing would ship a build where block and unblock still answer an opaque 500 on every id, which
 * is the whole failure this patch exists to remove.
 *
 * The fixture is the INSTALLED Contact.js rather than a hand-written approximation: a synthetic
 * fixture can only prove the patcher matches a shape I wrote, not the shape upstream ships. When the
 * installed tree is already patched (postinstall runs on `npm install`), the patch is reversed to
 * recover the pristine text, so the suite behaves the same before and after a local install.
 */
const INSTALLED_CONTACT = path.join(
  __dirname,
  '..',
  'node_modules',
  'whatsapp-web.js',
  'src',
  'structures',
  'Contact.js',
);

/**
 * The installed file as upstream ships it, un-patching first when postinstall already ran, by this
 * version of the patcher or by the earlier one.
 */
function pristineSource() {
  let source = fs.readFileSync(INSTALLED_CONTACT, 'utf8');
  for (const group of GROUPS) {
    if (source.includes(group.replace)) {
      source = source.replace(group.replace, group.find);
    }
  }
  return normalizeLegacy(source);
}

/** A throwaway whatsapp-web.js tree holding just the file the patcher edits. */
function fakeWwjs(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-block-'));
  const structures = path.join(dir, 'src', 'structures');
  fs.mkdirSync(structures, { recursive: true });
  fs.writeFileSync(path.join(structures, 'Contact.js'), source);
  return { dir, file: path.join(structures, 'Contact.js') };
}

test('the installed tree still has both shapes the patcher targets', () => {
  const source = pristineSource();
  for (const group of GROUPS) {
    assert.ok(source.includes(group.find), `upstream no longer matches the ${group.name}() shape`);
  }
});

test('patches block and unblock, and is idempotent', () => {
  const { dir, file } = fakeWwjs(pristineSource());
  const first = applyBlockPatches({ wwjsDir: dir });
  assert.deepEqual(first.applied, ['block', 'unblock']);
  assert.deepEqual(first.skipped, []);

  const patched = fs.readFileSync(file, 'utf8');
  // The dead helper is gone from both bodies, and the entry point the new action signature needs is
  // supplied on the block side only (unblockContact takes the contact positionally).
  assert.ok(!patched.includes('getContactToBlockOnlyUseIfNoAssociatedChat'));
  assert.ok(patched.includes("blockContact({ contact: target, blockEntryPoint: 'ChatListBlock' })"));
  assert.ok(patched.includes('unblockContact(target)'));
  // Both bodies resolve through the chat-owning identity.
  assert.equal(patched.split('migration.toUserLid(contact.id)').length - 1, 2);
  assert.equal(patched.split('chat && chat.contact ? chat.contact : contact').length - 1, 2);

  const second = applyBlockPatches({ wwjsDir: dir });
  assert.deepEqual(second.applied, []);
  assert.deepEqual(second.skipped, ['block', 'unblock']);
  assert.equal(fs.readFileSync(file, 'utf8'), patched, 'a second run must not change the file');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('isApplied tracks the transform, false before it runs and true after', () => {
  const { dir } = fakeWwjs(pristineSource());
  assert.equal(isApplied(dir), false);
  applyBlockPatches({ wwjsDir: dir });
  assert.equal(isApplied(dir), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('refuses an unknown shape instead of shipping unpatched', () => {
  const { dir } = fakeWwjs(pristineSource().replace('getContactToBlockOnlyUseIfNoAssociatedChat', 'someRenamedHelper'));
  assert.throws(() => applyBlockPatches({ wwjsDir: dir }), /refusing to patch blind/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('refuses a tree with no Contact.js at all', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-block-empty-'));
  assert.throws(() => applyBlockPatches({ wwjsDir: dir }), /Contact\.js not found/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('upgrades a tree left behind by the previous version of this patcher', () => {
  // The earlier unblock body matches neither the pristine find nor the current replace, so without the
  // rewind the patcher would refuse the trees that already carry the block fix.
  const legacy = pristineSource()
    .replace(findFor('blockContact({ contact: resolved })'), GROUPS[0].replace)
    .replace(findFor('unblockContact(resolved)'), LEGACY_UNBLOCK_REPLACE);
  const { dir, file } = fakeWwjs(legacy);
  assert.equal(isApplied(dir), false, 'the earlier unblock body lacks the cleanup');
  const result = applyBlockPatches({ wwjsDir: dir });
  assert.deepEqual(result.applied, ['unblock']);
  assert.deepEqual(result.skipped, ['block']);
  assert.equal(isApplied(dir), true);
  assert.equal(fs.readFileSync(file, 'utf8').split(GROUPS[1].replace).length - 1, 1);
  assert.deepEqual(applyBlockPatches({ wwjsDir: dir }).applied, [], 'a second run must not change the file');
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Run the patched Contact.block() / unblock() against a stand-in WhatsApp Web. `blocked` is the blocklist
 * (PHONE and LID are one person, OTHER someone else); `unblockContact` removes only the entry of the contact
 * it was handed unless `removes` says otherwise, and throws for an id listed in `refuses`.
 */
const PHONE = '628111000000@c.us';
const LID = '100000000000001@lid';
const OTHER = '628222000000@c.us';
function onPage({ blocked, removes, refuses = [], lidMapping = true }) {
  const { dir } = fakeWwjs(pristineSource());
  applyBlockPatches({ wwjsDir: dir });
  const structures = path.join(dir, 'src', 'structures');
  fs.copyFileSync(path.join(path.dirname(INSTALLED_CONTACT), 'Base.js'), path.join(structures, 'Base.js'));
  const Contact = require(path.join(structures, 'Contact.js'));

  const wid = id => ({ _serialized: id });
  const contactFor = id => ({ id: wid(id) });
  let blocklist = [...blocked];
  const unblocked = [];
  const blockedVia = [];
  const modules = {
    WAWebCollections: {
      Contact: { find: async id => contactFor(id) },
      Blocklist: { getModelsArray: () => blocklist.map(id => ({ id: wid(id) })) },
    },
    WAWebLidMigrationUtils: {
      toUserLid: id => {
        if (!lidMapping) throw new Error('no lid');
        return id._serialized === PHONE ? wid(LID) : id;
      },
    },
    WAWebChatCollection: { ChatCollection: { get: id => (id === LID ? { contact: contactFor(LID) } : undefined) } },
    WAWebBlockContactAction: {
      unblockContact: async contact => {
        const id = contact.id._serialized;
        unblocked.push(id);
        if (refuses.includes(id)) throw new Error('refused');
        const gone = removes ? removes(id) : [id];
        blocklist = blocklist.filter(entry => !gone.includes(entry));
      },
      blockContact: async ({ contact }) => {
        blockedVia.push(contact.id._serialized);
      },
    },
  };
  globalThis.window = { require: name => modules[name] };
  const client = { pupPage: { evaluate: (fn, ...args) => fn(...args) } };
  return {
    contact: new Contact(client, { id: wid(PHONE) }),
    unblocked,
    blockedVia,
    blocklist: () => blocklist,
    done: () => {
      delete globalThis.window;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('unblock clears a person blocked under both the LID and the phone id', async () => {
  const page = onPage({ blocked: [LID, PHONE, OTHER] });
  assert.equal(await page.contact.unblock(), true);
  assert.deepEqual(page.unblocked, [LID, PHONE]);
  assert.deepEqual(page.blocklist(), [OTHER], 'someone else on the blocklist is left alone');
  page.done();
});

test('unblock of a person blocked under the LID only makes one call', async () => {
  const page = onPage({ blocked: [LID] });
  await page.contact.unblock();
  assert.deepEqual(page.unblocked, [LID]);
  assert.deepEqual(page.blocklist(), []);
  page.done();
});

test('unblock reaches a person blocked under the phone id only', async () => {
  const page = onPage({ blocked: [PHONE] });
  await page.contact.unblock();
  assert.deepEqual(page.unblocked, [LID, PHONE]);
  assert.deepEqual(page.blocklist(), []);
  page.done();
});

test('unblock makes no second call when WhatsApp clears both entries at once', async () => {
  const page = onPage({ blocked: [LID, PHONE], removes: () => [LID, PHONE] });
  await page.contact.unblock();
  assert.deepEqual(page.unblocked, [LID]);
  page.done();
});

test('unblock tries each other entry once and never retries', async () => {
  const page = onPage({ blocked: [LID, PHONE, PHONE], removes: () => [] });
  await page.contact.unblock();
  assert.deepEqual(page.unblocked, [LID, PHONE]);
  page.done();
});

test('a refused second entry leaves unblock resolved, with that entry still listed', async () => {
  const page = onPage({ blocked: [LID, PHONE], refuses: [PHONE] });
  assert.equal(await page.contact.unblock(), true);
  assert.deepEqual(page.unblocked, [LID, PHONE]);
  assert.deepEqual(page.blocklist(), [PHONE]);
  page.done();
});

test('unblock of an account with no LID mapping unblocks the contact it was given', async () => {
  const page = onPage({ blocked: [PHONE], lidMapping: false });
  await page.contact.unblock();
  assert.deepEqual(page.unblocked, [PHONE]);
  page.done();
});

test('block still makes exactly one call, to the chat-owning identity', async () => {
  const page = onPage({ blocked: [PHONE] });
  assert.equal(await page.contact.block(), true);
  assert.deepEqual(page.blockedVia, [LID]);
  assert.deepEqual(page.unblocked, []);
  page.done();
});

test('a half-patched tree still gets the missing half', () => {
  // Only block patched: unblock must still be applied rather than reported as already present.
  const half = pristineSource().replace(
    findFor('blockContact({ contact: resolved })'),
    replaceFor("blockContact({ contact: target, blockEntryPoint: 'ChatListBlock' })"),
  );
  const { dir } = fakeWwjs(half);
  const result = applyBlockPatches({ wwjsDir: dir });
  assert.deepEqual(result.applied, ['unblock']);
  assert.deepEqual(result.skipped, ['block']);
  fs.rmSync(dir, { recursive: true, force: true });
});
