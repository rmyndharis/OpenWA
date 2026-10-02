'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { applyPairingPatch, isApplied, QR_FIND, QR_REPLACE, ACK_FIND, ACK_REPLACE } = require('./patch-baileys-pairing');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-pairing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'lib/Socket'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lib/Socket/socket.js'), '// before\n' + QR_FIND + '// after\n');
  fs.writeFileSync(path.join(dir, 'lib/Socket/messages-recv.js'), ACK_FIND);
  return dir;
}
test('applies both backports once and stands down only on the complete result', t => {
  const dir = fixture(t);
  assert.equal(isApplied(dir), false);
  assert.deepEqual(applyPairingPatch(dir), { skipped: false });
  assert.equal(isApplied(dir), true);
  const files = ['socket', 'messages-recv'].map(name => path.join(dir, 'lib/Socket', name + '.js'));
  const before = files.map(file => fs.readFileSync(file, 'utf8'));
  assert.deepEqual(applyPairingPatch(dir), { skipped: true });
  assert.deepEqual(
    files.map(file => fs.readFileSync(file, 'utf8')),
    before,
  );
});
for (const variant of ['unknown', 'partial', 'duplicate'])
  test('refuses ' + variant + ' trees before either file is written', t => {
    const dir = fixture(t),
      file = path.join(dir, 'lib/Socket/messages-recv.js');
    fs.writeFileSync(
      file,
      variant === 'unknown'
        ? 'changed upstream code'
        : variant === 'partial'
          ? ACK_REPLACE
          : ACK_FIND + '\n' + ACK_FIND,
    );
    const qr = fs.readFileSync(path.join(dir, 'lib/Socket/socket.js'), 'utf8');
    assert.throws(() => applyPairingPatch(dir), /Unknown or partially patched/);
    assert.equal(isApplied(dir), false);
    assert.equal(fs.readFileSync(path.join(dir, 'lib/Socket/socket.js'), 'utf8'), qr);
  });
test('missing dependency fails the prepared build instead of reporting a patch', t => {
  const dir = fixture(t);
  fs.rmSync(path.join(dir, 'lib/Socket/messages-recv.js'));
  assert.throws(() => applyPairingPatch(dir));
  assert.equal(isApplied(dir), false);
});
