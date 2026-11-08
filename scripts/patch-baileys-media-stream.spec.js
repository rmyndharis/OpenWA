'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { applyMediaStreamPatch, isApplied, PIPE_FIND, MARKER } = require('./patch-baileys-media-stream');

/**
 * Same contract as the sibling patcher specs: fire only on the exact shape, refuse loudly on anything
 * else, be safe to run twice. The defect is a process crash, so the behavioural cases run the stream
 * wiring in a child process and assert on how that process exits.
 */

/** The real tail of downloadEncryptedContent, in CommonJS, with a pass-through "decipher". */
function fakeBaileys() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baileys-media-stream-'));
  fs.mkdirSync(path.join(dir, 'lib', 'Utils'), { recursive: true });
  const file = path.join(dir, 'lib', 'Utils', 'messages-media.js');
  fs.writeFileSync(
    file,
    `'use strict';
const { Transform } = require('stream');
module.exports = function downloadEncryptedContent(fetched) {
    const output = new Transform({
        transform(chunk, _, callback) {
            callback(null, chunk);
        }
    });
${PIPE_FIND}
};
`,
  );
  return { dir, file };
}

/**
 * The production sequence: the reader gives up (OpenWA's timeout destroys the stream it was handed),
 * then the HTTP body is reset. Prints whether the body was released.
 */
const ABANDON = `
const { Readable } = require('stream');
const download = require(process.argv[1]);
const fetched = new Readable({ read() {} });
const output = download(fetched);
fetched.push(Buffer.from('partial'));
output.destroy();
setTimeout(() => {
  const releasedEarly = fetched.destroyed;
  if (!fetched.destroyed) fetched.destroy(new TypeError('terminated'));
  setTimeout(() => { console.log(JSON.stringify({ releasedEarly })); process.exit(0); }, 50);
}, 20);
`;

/** The body fails while the reader is still consuming: the reader must see the error, not the process. */
const MID_READ = `
const { Readable } = require('stream');
const download = require(process.argv[1]);
const fetched = new Readable({ read() {} });
const output = download(fetched);
(async () => {
  try {
    setTimeout(() => fetched.destroy(new TypeError('terminated')), 20);
    fetched.push(Buffer.from('partial'));
    for await (const _ of output) { /* keep reading */ }
    console.log(JSON.stringify({ readerSaw: 'end' }));
  } catch (err) {
    console.log(JSON.stringify({ readerSaw: err.message }));
  }
  setTimeout(() => process.exit(0), 50);
})();
`;

function runScenario(script, file) {
  const r = spawnSync(process.execPath, ['-e', script, file], { encoding: 'utf8', timeout: 10_000 });
  const line = r.stdout.trim().split('\n').pop();
  return { status: r.status, stderr: r.stderr, result: line ? JSON.parse(line) : undefined };
}

test('CONTROL — unpatched, an abandoned body that is later reset crashes the process', () => {
  const { dir, file } = fakeBaileys();
  const r = runScenario(ABANDON, file);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /terminated/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CONTROL — unpatched, a body error mid-read crashes instead of reaching the reader', () => {
  const { dir, file } = fakeBaileys();
  const r = runScenario(MID_READ, file);
  assert.notEqual(r.status, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('patched, abandoning the output releases the body at once and nothing crashes', () => {
  const { dir, file } = fakeBaileys();
  assert.equal(applyMediaStreamPatch(dir).skipped, undefined);
  const r = runScenario(ABANDON, file);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.result, { releasedEarly: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('patched, a body error mid-read reaches the reader as a stream error', () => {
  const { dir, file } = fakeBaileys();
  applyMediaStreamPatch(dir);
  const r = runScenario(MID_READ, file);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.result, { readerSaw: 'terminated' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('patched, a complete download still yields every byte', async () => {
  const { dir, file } = fakeBaileys();
  applyMediaStreamPatch(dir);
  delete require.cache[require.resolve(file)];
  const { Readable } = require('stream');
  const output = require(file)(Readable.from([Buffer.from('ab'), Buffer.from('cd')]));
  const chunks = [];
  for await (const c of output) chunks.push(c);
  assert.equal(Buffer.concat(chunks).toString(), 'abcd');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('idempotent: a second run stands down', () => {
  const { dir, file } = fakeBaileys();
  applyMediaStreamPatch(dir);
  const once = fs.readFileSync(file, 'utf8');
  assert.deepEqual(applyMediaStreamPatch(dir), { skipped: true, reason: 'already patched' });
  assert.equal(fs.readFileSync(file, 'utf8'), once);
  assert.equal(isApplied(dir), true);
  assert.equal(once.split(MARKER).length - 1, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('refuses an unknown shape instead of shipping unpatched', () => {
  const { dir, file } = fakeBaileys();
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(PIPE_FIND, '    return pipeline(fetched, output);'));
  assert.throws(() => applyMediaStreamPatch(dir), /expected exactly 1 media download pipe site/);
  assert.equal(isApplied(dir), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the find string matches the installed Baileys exactly once', () => {
  const real = path.join(
    __dirname,
    '..',
    'node_modules',
    '@whiskeysockets',
    'baileys',
    'lib',
    'Utils',
    'messages-media.js',
  );
  if (!fs.existsSync(real)) return; // no install in this checkout
  const source = fs.readFileSync(real, 'utf8');
  if (source.includes(MARKER)) return; // postinstall already applied it
  assert.equal(source.split(PIPE_FIND).length - 1, 1);
});
