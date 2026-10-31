'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  applyPairingPatch,
  isApplied,
  run,
  QR_FIND,
  QR_REPLACE,
  ACK_FIND,
  ACK_REPLACE,
} = require('./patch-baileys-pairing');
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
  assert.equal(isApplied(dir), true);
});
test('best-effort skips unknown shapes but refuses partial patches', t => {
  const dir = fixture(t);
  const file = path.join(dir, 'lib/Socket/messages-recv.js');
  fs.writeFileSync(file, 'unknown upstream shape');
  assert.equal(run(dir, true), 0);
  assert.equal(run(dir, false), 1);
  fs.writeFileSync(file, ACK_REPLACE);
  assert.equal(run(dir, true), 1);
});
test('best-effort skips and changes nothing when a validated patch cannot be written', t => {
  const dir = fixture(t);
  const write = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (file, data) => {
    if (file.includes('messages-recv.js')) throw new Error('write failed');
    return write(file, data);
  });
  assert.equal(run(dir, true), 0);
  assert.equal(run(dir, false), 1);
  assert.equal(isApplied(dir), false);
  assert.ok(fs.readFileSync(path.join(dir, 'lib/Socket/socket.js'), 'utf8').includes(QR_FIND));
});
test('best-effort still fails if only part of a validated patch was written', t => {
  const dir = fixture(t);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to.endsWith('messages-recv.js')) throw new Error('rename failed');
    return rename(from, to);
  });
  assert.equal(run(dir, true), 1);
  assert.equal(isApplied(dir), false);
});
test('best-effort refuses a repaired socket with the ACK file missing', t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'lib/Socket/socket.js'), QR_REPLACE);
  fs.rmSync(path.join(dir, 'lib/Socket/messages-recv.js'));
  assert.equal(run(dir, true), 1);
});
test('refuses a pre-existing refresh handler before changing either file', t => {
  const dir = fixture(t);
  fs.appendFileSync(
    path.join(dir, 'lib/Socket/socket.js'),
    "ws.on('CB:notification,type:companion_reg_refresh', handler);",
  );
  assert.throws(() => applyPairingPatch(dir), /Unknown/);
  assert.equal(fs.readFileSync(path.join(dir, 'lib/Socket/messages-recv.js'), 'utf8'), ACK_FIND);
});
