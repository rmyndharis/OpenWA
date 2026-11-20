'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const {
  applyEventBufferPatch,
  isApplied,
  SITES,
  GROUPS_FIND,
  RSVP_FIND,
  MARKER,
} = require('./patch-baileys-event-buffer');

/**
 * Same contract as the sibling patcher specs: fire only on the exact shape, refuse loudly on anything else, be safe to
 * run twice, stand down on a library that keeps the events itself. The last cases load the installed library's own
 * buffer, before and after the patch, and feed it the events it drops; what the adapter makes of them is exercised in
 * test/engine-real/baileys-event-buffer.spec.mjs.
 */

const BUFFER = path.join('lib', 'Utils', 'event-buffer.js');
const INSTALLED = path.join(__dirname, '..', 'node_modules', '@whiskeysockets', 'baileys', BUFFER);

const shape = () => `'use strict';\n${SITES.map(([, find]) => find).join('\n')}\n`;

function fakeBaileys(t, source = shape()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baileys-event-buffer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'lib', 'Utils'), { recursive: true });
  fs.writeFileSync(path.join(dir, BUFFER), source);
  return { dir, file: path.join(dir, BUFFER) };
}

const count = (source, text) => source.split(text).length - 1;

test('patched: every site rewritten once and marked once', t => {
  const { dir, file } = fakeBaileys(t);
  assert.equal(isApplied(dir), false);
  assert.equal(applyEventBufferPatch(dir).skipped, undefined);
  const patched = fs.readFileSync(file, 'utf8');
  assert.equal(count(patched, MARKER), 1);
  for (const [label, find, replace] of SITES) {
    assert.equal(count(patched, replace), 1, label);
  }
  assert.equal(count(patched, 'if (!data.groupUpdates[id])'), 0);
  assert.equal(isApplied(dir), true);
});

test('idempotent: a second run stands down', t => {
  const { dir, file } = fakeBaileys(t);
  applyEventBufferPatch(dir);
  const once = fs.readFileSync(file, 'utf8');
  assert.deepEqual(applyEventBufferPatch(dir), { skipped: true, reason: 'already patched' });
  assert.equal(fs.readFileSync(file, 'utf8'), once);
});

for (const [label, find] of SITES) {
  test(`refuses an unknown shape instead of shipping unpatched: no ${label}`, t => {
    const source = shape().replace(find, '// reshaped');
    const { dir, file } = fakeBaileys(t, source);
    assert.throws(() => applyEventBufferPatch(dir), new RegExp(`expected exactly 1 ${label} site .* found 0`));
    assert.equal(fs.readFileSync(file, 'utf8'), source);
    assert.equal(isApplied(dir), false);
  });
}

test('refuses a site that appears twice, writing nothing', t => {
  const source = shape() + RSVP_FIND;
  const { dir, file } = fakeBaileys(t, source);
  assert.throws(() => applyEventBufferPatch(dir), /expected exactly 1 messages\.update merge site .* found 2/);
  assert.equal(fs.readFileSync(file, 'utf8'), source);
});

/** A buffer that keeps all three itself, written differently from this patch. */
const UPSTREAM = `        case 'groups.update':
            for (const update of eventData) {
                data.groupUpdates.push(update);
            }
            break;
    map['messaging-history.set'] = { lidPnMappings: data.historySets.lidPnMappings };
    msgUpdate.update.eventResponses = mergeEventResponses(msgUpdate.update, update);
`;

test('stands down on a library that keeps every event itself, writing nothing and saying so', t => {
  const { dir, file } = fakeBaileys(t, UPSTREAM);
  assert.deepEqual(applyEventBufferPatch(dir), {
    skipped: true,
    reason: 'the library already keeps every buffered group update, history pair and RSVP',
  });
  assert.equal(fs.readFileSync(file, 'utf8'), UPSTREAM);
  assert.equal(isApplied(dir), true);
});

test('a library that fixes only some of the three is refused as an unknown shape', t => {
  // Still first-wins for groups, though the two lists are handled.
  const source = UPSTREAM.replace('data.groupUpdates.push(update);', 'if (!data.groupUpdates[update.id]) {}');
  const { dir, file } = fakeBaileys(t, source);
  assert.throws(() => applyEventBufferPatch(dir), /expected exactly 1 groups\.update append site .* found 0/);
  assert.equal(fs.readFileSync(file, 'utf8'), source);
  assert.equal(isApplied(dir), false);
  // And the other way: groups fixed upstream, the pairs still dropped.
  const partial = fakeBaileys(t, shape().replace(GROUPS_FIND, "        case 'groups.update': break;"));
  assert.throws(() => applyEventBufferPatch(partial.dir), /expected exactly 1 groups\.update append site .* found 0/);
  assert.equal(isApplied(partial.dir), false);
});

test('a missing file is an error, and an unreadable tree reads as applied', t => {
  const { dir } = fakeBaileys(t);
  fs.rmSync(path.join(dir, BUFFER));
  assert.throws(() => applyEventBufferPatch(dir), /event-buffer\.js not found/);
  assert.equal(isApplied(dir), true);
});

/** The installed buffer as the library ships it: postinstall may already have patched it. */
function pristineInstalled() {
  let source = fs.readFileSync(INSTALLED, 'utf8');
  if (source.includes(MARKER)) {
    for (const [, find, replace] of SITES) source = source.replace(replace, () => find);
  }
  return source;
}

test('the find strings match the installed Baileys exactly once', { skip: !fs.existsSync(INSTALLED) }, () => {
  const source = pristineInstalled();
  for (const [label, find] of SITES) assert.equal(count(source, find), 1, label);
});

/**
 * Loads a copy of the installed buffer module from a temporary file, its relative imports pointed back at the library,
 * so the copy runs exactly as the library's own file does.
 */
async function loadBuffer(t, source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baileys-event-buffer-load-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'event-buffer.mjs');
  const utils = path.dirname(INSTALLED);
  fs.writeFileSync(
    file,
    source.replace(/from '(\.{1,2}\/[^']+)'/g, (_, rel) => `from '${pathToFileURL(path.resolve(utils, rel)).href}'`),
  );
  const { makeEventBuffer } = await import(pathToFileURL(file).href);
  const quiet = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child: () => quiet };
  return () => makeEventBuffer(quiet);
}

/** Runs one buffered window and returns what each listened event delivered. */
function window(makeBuffer, emits, { buffered = true } = {}) {
  const ev = makeBuffer();
  const seen = {};
  for (const name of ['groups.update', 'messaging-history.set', 'messages.update']) {
    ev.on(name, value => (seen[name] = [...(seen[name] || []), value]));
  }
  if (buffered) ev.buffer();
  for (const [name, value] of emits) ev.emit(name, value);
  if (buffered) ev.flush();
  ev.destroy();
  return seen;
}

const GROUP = '120363000000000001@g.us';
const OTHER = '120363000000000002@g.us';
const snapshot = { id: GROUP, subject: 'Old name', participants: [], creation: 1, subjectTime: 1, owner: 'o@lid' };
const history = lidPnMappings => ({ chats: [], contacts: [], messages: [], lidPnMappings, syncType: 0, progress: 50 });
const pair = n => ({ lid: `${n}@lid`, pn: `62${n}@s.whatsapp.net` });
const eventKey = { remoteJid: GROUP, id: 'EVENT1', fromMe: true };
const rsvp = id => [
  { key: eventKey, update: { eventResponses: [{ eventResponseMessageKey: { id }, response: { response: 1 } }] } },
];

const SCENARIOS = [
  {
    label: 'two changes of one group, and a change after a snapshot of it',
    emits: [
      ['groups.update', [{ id: GROUP, subject: 'New name' }]],
      ['groups.update', [{ id: OTHER, announce: true }]],
      ['groups.update', [{ id: GROUP, desc: 'New description' }]],
      ['groups.update', [snapshot]],
      ['groups.update', [{ id: GROUP, restrict: true }]],
    ],
    read: seen => seen['groups.update'].flat(),
    pristine: [
      { id: GROUP, subject: 'New name' },
      { id: OTHER, announce: true },
    ],
    patched: [
      { id: GROUP, subject: 'New name' },
      { id: GROUP, desc: 'New description' },
      snapshot,
      { id: GROUP, restrict: true },
      { id: OTHER, announce: true },
    ],
  },
  {
    label: 'the lid to phone pairs of two history syncs',
    emits: [
      ['messaging-history.set', history([pair(1), pair(2)])],
      ['messaging-history.set', history([pair(3)])],
    ],
    read: seen => seen['messaging-history.set'].map(set => set.lidPnMappings),
    pristine: [undefined],
    patched: [[pair(1), pair(2), pair(3)]],
  },
  {
    label: 'three answers to one event',
    emits: [
      ['messages.update', rsvp('RSVP1')],
      ['messages.update', rsvp('RSVP2')],
      ['messages.update', [{ key: eventKey, update: { status: 3 } }]],
      ['messages.update', rsvp('RSVP3')],
    ],
    read: seen =>
      seen['messages.update']
        .flat()
        .map(({ update }) => [update.status, update.eventResponses.map(r => r.eventResponseMessageKey.id)]),
    pristine: [[3, ['RSVP3']]],
    patched: [[3, ['RSVP1', 'RSVP2', 'RSVP3']]],
  },
];

for (const scenario of SCENARIOS) {
  test(`the installed buffer keeps ${scenario.label} once patched`, { skip: !fs.existsSync(INSTALLED) }, async t => {
    const source = pristineInstalled();
    const { dir, file } = fakeBaileys(t, source);
    applyEventBufferPatch(dir);
    const before = await loadBuffer(t, source);
    const after = await loadBuffer(t, fs.readFileSync(file, 'utf8'));
    // The library as shipped loses them, so the case can see the loss it guards against.
    assert.deepEqual(scenario.read(window(before, scenario.emits)), scenario.pristine);
    assert.deepEqual(scenario.read(window(after, scenario.emits)), scenario.patched);
    // Unbuffered, every event goes through as it was emitted, patched or not.
    assert.deepEqual(
      window(after, scenario.emits, { buffered: false }),
      window(before, scenario.emits, { buffered: false }),
    );
  });
}
