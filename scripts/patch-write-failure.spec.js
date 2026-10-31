'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * `--best-effort` lets a source install carry on without a patch it cannot place. The patchers replace a
 * file by writing a temporary file beside it and renaming that over the target, so whatever fails on the
 * way (a full disk, an I/O error, a refused or busy open, a refused rename) leaves the target as it was,
 * and the patcher skips under --best-effort and fails without it. Only a patch over several files can be
 * left half done, when a rename fails after an earlier one went through; that one fails the install.
 */

// realpath: os.tmpdir() is a symlink on macOS and the patcher resolves its own location through it,
// so the fault below would never match the target path.
const WORK = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patch-write-failure-')));
test.after(() => fs.rmSync(WORK, { recursive: true, force: true }));

// The mode every fixture file is given by an explicit chmod, so the cases do not depend on the umask the
// suite runs under (a default creation mode is masked by it).
const FIXTURE_MODE = 0o640;
const PREFIX_BYTES = 64;
const MARKER = 'FIXTURE_WRITE_FAULT';
const PRELOAD = path.join(WORK, 'write-fault.cjs');
// Fails one write ('write': the temporary file beside FIXTURE_FAULT_FILE, or the file itself), one
// rename ('rename': onto FIXTURE_FAULT_FILE) or the chmod of the temporary file ('chmod'). A full disk or
// an I/O error lands a prefix first; a refused or busy open writes nothing.
fs.writeFileSync(
  PRELOAD,
  `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const write = fs.writeFileSync;
const rename = fs.renameSync;
const chmod = fs.chmodSync;
const op = process.env.FIXTURE_FAULT_OP;
const file = path.resolve(process.env.FIXTURE_FAULT_FILE);
const code = process.env.FIXTURE_FAULT_CODE;
const fail = () => {
  process.stderr.write('${MARKER}\\n');
  throw Object.assign(new Error('fixture failure'), { code });
};
fs.writeFileSync = function (target, data, ...args) {
  const resolved = typeof target === 'number' ? '' : path.resolve(String(target));
  if (op === 'write' && (resolved === file || resolved.startsWith(file + '.'))) {
    if (['ENOSPC', 'EIO'].includes(code)) write.call(fs, target, Buffer.from(String(data)).subarray(0, ${PREFIX_BYTES}));
    fail();
  }
  return write.call(fs, target, data, ...args);
};
fs.renameSync = function (from, to) {
  if (op === 'rename' && path.resolve(String(to)) === file) fail();
  return rename.call(fs, from, to);
};
fs.chmodSync = function (target, mode) {
  if (op === 'chmod' && path.resolve(String(target)).startsWith(file + '.')) fail();
  return chmod.call(fs, target, mode);
};
`,
);

const finds = edits => edits.map(edit => edit.find).join('\n');
const PATCHERS = [
  ['patch-baileys-appstate.js', '@whiskeysockets/baileys/lib/Socket/chats.js', m => m.LOOP_FIND],
  ['patch-baileys-newsletter-create.js', '@whiskeysockets/baileys/lib/Socket/newsletter.js', m => m.PARSE_FIND],
  [
    'patch-wwebjs-block.js',
    'whatsapp-web.js/src/structures/Contact.js',
    m => m.GROUPS.map(group => group.find).join('\n'),
  ],
  ['patch-wwebjs-group-description.js', 'whatsapp-web.js/src/structures/GroupChat.js', m => m.POSITIONAL_CALL],
  ['patch-wwebjs-media-id.js', 'whatsapp-web.js/src/util/Injected/Utils.js', m => m.ANCHOR],
  ['patch-wwebjs-newsletter-preview.js', 'whatsapp-web.js/src/util/Injected/Utils.js', m => m.LEGACY_CALL],
  [
    'patch-wwebjs-participant-arity.js',
    'whatsapp-web.js/src/structures/GroupChat.js',
    m => finds(m.GROUPS.flatMap(group => group.edits)),
  ],
  ['patch-wwebjs-ready-sync.js', 'whatsapp-web.js/src/Client.js', m => finds(m.EDITS)],
  ['patch-wwebjs-send-error.js', 'whatsapp-web.js/src/Client.js', m => m.ANCHOR],
  [
    'patch-wwebjs-status.js',
    'whatsapp-web.js/src/util/Injected/Utils.js',
    m => finds(m.GROUPS.flatMap(group => group.edits)),
  ],
];

function fixture(name, files) {
  const root = fs.mkdtempSync(path.join(WORK, 'tree-'));
  const script = path.join(root, 'scripts', name);
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.copyFileSync(path.join(__dirname, name), script);
  // The shared write helper sits beside the patchers (the image copies it with them).
  fs.copyFileSync(path.join(__dirname, 'atomic-write.js'), path.join(root, 'scripts', 'atomic-write.js'));
  const targets = {};
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, 'node_modules', relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    fs.chmodSync(target, FIXTURE_MODE);
    targets[relative] = target;
  }
  return { root, script, targets };
}

// fault: { op: 'write' | 'rename', file: absolute path, code }.
function patch({ root, script }, { fault, bestEffort = true } = {}) {
  const result = spawnSync(
    process.execPath,
    [...(fault ? ['--require', PRELOAD] : []), script, ...(bestEffort ? ['--best-effort'] : [])],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        ...(fault && {
          FIXTURE_FAULT_OP: fault.op,
          FIXTURE_FAULT_FILE: fault.file,
          FIXTURE_FAULT_CODE: fault.code,
        }),
      },
      encoding: 'utf8',
      timeout: 10000,
    },
  );
  assert.equal(result.error, undefined);
  return result;
}

const leftovers = tree =>
  Object.values(tree.targets).flatMap(target =>
    fs.readdirSync(path.dirname(target)).filter(entry => entry.endsWith('.tmp')),
  );

// A failure at any step of the replacement; every one leaves the target as it was.
const FAULTS = [
  ['a full disk while writing', 'write', 'ENOSPC'],
  ['an open that is busy', 'write', 'EBUSY'],
  ['a refused rename', 'rename', 'EACCES'],
];

for (const [name, relative, shapeOf] of PATCHERS) {
  const shape = `// fixture\n${shapeOf(require(`./${name}`))}\n`;

  test(`${name} patches a recognised tree, keeps its mode and leaves no temporary file`, () => {
    const tree = fixture(name, { [relative]: shape });
    const target = tree.targets[relative];
    assert.equal(patch(tree).status, 0);
    assert.notEqual(fs.readFileSync(target, 'utf8'), shape);
    assert.equal(fs.statSync(target).mode & 0o777, FIXTURE_MODE);
    assert.deepEqual(leftovers(tree), []);
  });

  test(`${name} skips an unrecognised tree under --best-effort`, () => {
    const tree = fixture(name, { [relative]: 'unknown source shape\n' });
    assert.equal(patch(tree).status, 0);
    assert.equal(fs.readFileSync(tree.targets[relative], 'utf8'), 'unknown source shape\n');
  });

  for (const [label, op, code] of FAULTS) {
    test(`${name} skips under --best-effort and fails without it on ${label}, leaving the file as it was`, () => {
      for (const bestEffort of [true, false]) {
        const tree = fixture(name, { [relative]: shape });
        const fault = { op, code, file: tree.targets[relative] };
        const result = patch(tree, { fault, bestEffort });
        assert.match(result.stderr, new RegExp(MARKER), 'the injected fault did not fire');
        assert.equal(fs.readFileSync(tree.targets[relative], 'utf8'), shape);
        assert.deepEqual(leftovers(tree), []);
        assert.equal(result.status, bestEffort ? 0 : 1, result.stderr);
        if (bestEffort) assert.match(result.stderr, /skipped/);
      }
    });
  }
}

// The Baileys pairing patch spans two files: staged together, replaced one after the other.
const pairing = require('./patch-baileys-pairing.js');
const SOCKET = '@whiskeysockets/baileys/lib/Socket/socket.js';
const RECV = '@whiskeysockets/baileys/lib/Socket/messages-recv.js';
const pairingTree = () =>
  fixture('patch-baileys-pairing.js', {
    [SOCKET]: `// fixture\n${pairing.QR_FIND}\n`,
    [RECV]: `// fixture\n${pairing.ACK_FIND}\n`,
  });

test('patch-baileys-pairing.js patches both files and leaves no temporary file', () => {
  const tree = pairingTree();
  assert.equal(patch(tree).status, 0);
  assert.ok(fs.readFileSync(tree.targets[SOCKET], 'utf8').includes(pairing.QR_REPLACE));
  assert.ok(fs.readFileSync(tree.targets[RECV], 'utf8').includes(pairing.ACK_REPLACE));
  assert.deepEqual(leftovers(tree), []);
});

for (const [label, op, code] of FAULTS) {
  for (const faulty of [SOCKET, RECV]) {
    // Whichever file the failure hits before anything is replaced, both stay as they were.
    if (op === 'rename' && faulty === RECV) continue;
    test(`patch-baileys-pairing.js skips under --best-effort on ${label} for ${path.basename(faulty)}`, () => {
      for (const bestEffort of [true, false]) {
        const tree = pairingTree();
        const before = Object.values(tree.targets).map(file => fs.readFileSync(file, 'utf8'));
        const result = patch(tree, { fault: { op, code, file: tree.targets[faulty] }, bestEffort });
        assert.match(result.stderr, new RegExp(MARKER), 'the injected fault did not fire');
        assert.deepEqual(
          Object.values(tree.targets).map(file => fs.readFileSync(file, 'utf8')),
          before,
        );
        assert.deepEqual(leftovers(tree), []);
        assert.equal(result.status, bestEffort ? 0 : 1, result.stderr);
      }
    });
  }
}

test('patch-baileys-pairing.js fails even under --best-effort when only the first file was replaced', () => {
  const tree = pairingTree();
  const result = patch(tree, { fault: { op: 'rename', code: 'EBUSY', file: tree.targets[RECV] } });
  assert.match(result.stderr, new RegExp(MARKER), 'the injected fault did not fire');
  assert.ok(fs.readFileSync(tree.targets[SOCKET], 'utf8').includes(pairing.QR_REPLACE), 'the first file is patched');
  assert.ok(fs.readFileSync(tree.targets[RECV], 'utf8').includes(pairing.ACK_FIND), 'the second file is not');
  assert.deepEqual(leftovers(tree), []);
  assert.equal(result.status, 1);
});

// A file system that refuses chmod (a bind mount, FAT) must not turn into a failed or skipped patch: the
// in-place write this replaced needed none. The file is patched, no temporary file is left, and with the
// restoring chmod refused it keeps the mode the create gave it, which the umask masked; under
// --best-effort and, for the Puppeteer patch, without it.
const refusedChmod = tree => ({ op: 'chmod', code: 'EPERM', file: Object.values(tree.targets)[0] });
const patchedWithoutChmod = (tree, result, before, refused = Object.keys(before)) => {
  assert.match(result.stderr, new RegExp(MARKER), 'the injected fault did not fire');
  assert.equal(result.status, 0, result.stderr);
  Object.entries(before).forEach(([relative, text]) => {
    assert.notEqual(fs.readFileSync(tree.targets[relative], 'utf8'), text);
    const expected = refused.includes(relative) ? FIXTURE_MODE & ~process.umask() : FIXTURE_MODE;
    assert.equal(fs.statSync(tree.targets[relative]).mode & 0o777, expected);
  });
  assert.deepEqual(leftovers(tree), []);
};

for (const [name, relative, shapeOf] of PATCHERS) {
  test(`${name} patches the file when the file system refuses chmod`, () => {
    const shape = `// fixture\n${shapeOf(require(`./${name}`))}\n`;
    const tree = fixture(name, { [relative]: shape });
    patchedWithoutChmod(tree, patch(tree, { fault: refusedChmod(tree) }), { [relative]: shape });
  });
}

test('patch-baileys-pairing.js patches both files when the file system refuses chmod', () => {
  const tree = pairingTree();
  const before = Object.fromEntries(
    Object.entries(tree.targets).map(([key, file]) => [key, fs.readFileSync(file, 'utf8')]),
  );
  // Only socket.js has its chmod refused: messages-recv.js gets its mode back.
  const result = patch(tree, { fault: { op: 'chmod', code: 'EPERM', file: tree.targets[SOCKET] } });
  patchedWithoutChmod(tree, result, before, [SOCKET]);
});

// The Puppeteer patch has no --best-effort mode: any failure is fatal, and leaves the file untouched.
const puppeteer = require('./patch-wwebjs-puppeteer.js');
test('patch-wwebjs-puppeteer.js fails on a write error and leaves Client.js as it was', () => {
  const relative = 'whatsapp-web.js/src/Client.js';
  const shape = `// fixture\n${puppeteer.REPLACEMENTS.map(([before]) => before).join('\n')}\n`;
  const tree = fixture('patch-wwebjs-puppeteer.js', { [relative]: shape });
  const result = patch(tree, { fault: { op: 'write', code: 'ENOSPC', file: tree.targets[relative] } });
  assert.match(result.stderr, new RegExp(MARKER), 'the injected fault did not fire');
  assert.equal(fs.readFileSync(tree.targets[relative], 'utf8'), shape);
  assert.deepEqual(leftovers(tree), []);
  assert.equal(result.status, 1);
});

test('patch-wwebjs-puppeteer.js patches Client.js when the file system refuses chmod, without --best-effort', () => {
  const relative = 'whatsapp-web.js/src/Client.js';
  const shape = `// fixture\n${puppeteer.REPLACEMENTS.map(([before]) => before).join('\n')}\n`;
  const tree = fixture('patch-wwebjs-puppeteer.js', { [relative]: shape });
  patchedWithoutChmod(tree, patch(tree, { fault: refusedChmod(tree), bestEffort: false }), { [relative]: shape });
});

test('a link is written through, not replaced', () => {
  const { writeFileAtomic } = require('./atomic-write.js');
  const real = path.join(WORK, 'real.txt');
  const link = path.join(WORK, 'link.txt');
  fs.writeFileSync(real, 'old');
  fs.symlinkSync(real, link);
  writeFileAtomic(link, 'new');
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.readFileSync(real, 'utf8'), 'new');
});
