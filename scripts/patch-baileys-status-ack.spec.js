'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const {
  applyStatusAckPatch,
  isApplied,
  MAP_FIND,
  HANDLER_FIND,
  HANDLER_REPLACE,
  ACK_ONLY_MAP,
  MARKER,
} = require('./patch-baileys-status-ack');
const pairing = require('./patch-baileys-pairing');

/**
 * Same contract as the sibling patcher specs: fire only on the exact shape, refuse loudly on anything
 * else, be safe to run twice. messages-recv.js is also the pairing patcher's target, so the cases below
 * run both in either order. What the patched socket does with a real `<status>` stanza is exercised
 * against the installed library in baileys-pairing.integration.spec.mjs.
 */

const RECV = path.join('lib', 'Socket', 'messages-recv.js');
const SOCKET = path.join('lib', 'Socket', 'socket.js');

/** The two sites the patch edits, around the line the pairing patcher edits (`ack`). */
const recvSource = ack => `'use strict';
const sendMessageAck = async (node, errorCode) => {
    const stanza = ${ack};
    await sendNode(stanza);
};
${MAP_FIND}
    isWsOpen: () => ws.isOpen,
    onUnexpectedError,
    yieldToEventLoop: () => new Promise(resolve => setImmediate(resolve))
});
${HANDLER_FIND}
`;

function fakeBaileys(t, source = recvSource(pairing.ACK_FIND)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baileys-status-ack-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'lib', 'Socket'), { recursive: true });
  fs.writeFileSync(path.join(dir, RECV), source);
  fs.writeFileSync(path.join(dir, SOCKET), pairing.QR_FIND);
  return { dir, file: path.join(dir, RECV) };
}

const count = (source, text) => source.split(text).length - 1;

test('patched: handled, mapped for offline nodes, registered for live ones, and valid JavaScript', t => {
  const { dir, file } = fakeBaileys(t);
  assert.equal(applyStatusAckPatch(dir).skipped, undefined);
  const patched = fs.readFileSync(file, 'utf8');
  assert.equal(count(patched, MARKER), 1);
  assert.equal(count(patched, "['status', handleStatus]"), 1);
  assert.equal(count(patched, "ws.on('CB:status'"), 1);
  // A const read before its declaration is a TDZ error at the first reconnect, not at install.
  assert.ok(patched.indexOf('const handleStatus') < patched.indexOf('const offlineNodeProcessor'));
  assert.doesNotThrow(() => new vm.Script(patched));
  assert.equal(isApplied(dir), true);
});

test('idempotent: a second run stands down', t => {
  const { dir, file } = fakeBaileys(t);
  applyStatusAckPatch(dir);
  const once = fs.readFileSync(file, 'utf8');
  assert.deepEqual(applyStatusAckPatch(dir), { skipped: true, reason: 'already patched' });
  assert.equal(fs.readFileSync(file, 'utf8'), once);
  assert.equal(count(once, MARKER), 1);
});

for (const [label, find] of [
  ['offline node map', MAP_FIND],
  ['notification handler', HANDLER_FIND],
]) {
  test(`refuses an unknown shape instead of shipping unpatched: no ${label}`, t => {
    const source = recvSource(pairing.ACK_FIND).replace(find, '// reshaped');
    const { dir, file } = fakeBaileys(t, source);
    assert.throws(() => applyStatusAckPatch(dir), new RegExp(`expected exactly 1 ${label} site .* found 0`));
    assert.equal(fs.readFileSync(file, 'utf8'), source);
    assert.equal(isApplied(dir), false);
  });
}

test('refuses a site that appears twice, writing nothing', t => {
  const source = recvSource(pairing.ACK_FIND) + HANDLER_FIND;
  const { dir, file } = fakeBaileys(t, source);
  assert.throws(() => applyStatusAckPatch(dir), /expected exactly 1 notification handler site .* found 2/);
  assert.equal(fs.readFileSync(file, 'utf8'), source);
});

test('fails when the library answers the stanza itself, so a second ack is never added', t => {
  const source = `${recvSource(pairing.ACK_FIND)}ws.on('CB:status', node => sendMessageAck(node));\n`;
  const { dir, file } = fakeBaileys(t, source);
  assert.throws(() => applyStatusAckPatch(dir), /already registers a CB:status handler.*retire this patcher/);
  assert.equal(fs.readFileSync(file, 'utf8'), source);
  // Nothing is left to patch, so the startup guard must not report it missing.
  assert.equal(isApplied(dir), true);
});

test('a tree the acknowledge-only revision patched is upgraded to the file a fresh patch writes', t => {
  const fresh = fakeBaileys(t);
  applyStatusAckPatch(fresh.dir);
  const ackOnly = recvSource(pairing.ACK_FIND)
    .replace(MAP_FIND, () => ACK_ONLY_MAP)
    .replace(HANDLER_FIND, () => HANDLER_REPLACE);
  const { dir, file } = fakeBaileys(t, ackOnly);
  // Half of what the patch does now, so the startup guard reports it.
  assert.equal(isApplied(dir), false);
  assert.equal(applyStatusAckPatch(dir).skipped, undefined);
  assert.equal(fs.readFileSync(file, 'utf8'), fs.readFileSync(fresh.file, 'utf8'));
  assert.equal(isApplied(dir), true);
});

test('composes with the pairing patcher in either order', t => {
  const results = [];
  for (const order of [
    [applyStatusAckPatch, pairing.applyPairingPatch],
    [pairing.applyPairingPatch, applyStatusAckPatch],
  ]) {
    const { dir, file } = fakeBaileys(t);
    for (const apply of order) apply(dir);
    assert.equal(isApplied(dir), true);
    assert.equal(pairing.isApplied(dir), true);
    results.push(fs.readFileSync(file, 'utf8'));
  }
  assert.equal(results[0], results[1]);
  assert.equal(count(results[0], pairing.ACK_REPLACE), 1);
  assert.equal(count(results[0], MARKER), 1);
});

test('applies over a tree the pairing patcher already patched', t => {
  const { dir, file } = fakeBaileys(t, recvSource(pairing.ACK_REPLACE));
  fs.writeFileSync(path.join(dir, SOCKET), pairing.QR_REPLACE);
  applyStatusAckPatch(dir);
  assert.equal(pairing.isApplied(dir), true);
  assert.equal(isApplied(dir), true);
  assert.equal(count(fs.readFileSync(file, 'utf8'), pairing.ACK_REPLACE), 1);
});

test('a missing file is an error, and an unreadable tree reads as applied', t => {
  const { dir } = fakeBaileys(t);
  fs.rmSync(path.join(dir, RECV));
  assert.throws(() => applyStatusAckPatch(dir), /messages-recv\.js not found/);
  assert.equal(isApplied(dir), true);
});

test('the find strings match the installed Baileys exactly once', () => {
  const real = path.join(__dirname, '..', 'node_modules', '@whiskeysockets', 'baileys', RECV);
  if (!fs.existsSync(real)) return; // no install in this checkout
  const source = fs.readFileSync(real, 'utf8');
  if (source.includes(MARKER) || source.includes(ACK_ONLY_MAP)) return; // postinstall already applied a revision of it
  assert.equal(count(source, MAP_FIND), 1);
  assert.equal(count(source, HANDLER_FIND), 1);
});
