'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { applyMediaSignalPatch, isApplied, FETCH_FIND, MARKER } = require('./patch-baileys-media-signal');

const INSTALLED_MEDIA = path.join(
  __dirname,
  '..',
  'node_modules',
  '@whiskeysockets',
  'baileys',
  'lib',
  'Utils',
  'messages-media.js',
);

/**
 * Copy the installed Baileys messages-media.js into an isolated temp directory so tests never
 * touch the workspace's node_modules tree.
 */
function copyInstalledFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baileys-media-signal-'));
  const targetDir = path.join(dir, 'lib', 'Utils');
  fs.mkdirSync(targetDir, { recursive: true });
  const file = path.join(targetDir, 'messages-media.js');
  if (fs.existsSync(INSTALLED_MEDIA)) {
    fs.copyFileSync(INSTALLED_MEDIA, file);
  } else {
    fs.writeFileSync(
      file,
      `export const getHttpStream = async (url, options = {}) => {\n${FETCH_FIND}\n    if (!response.ok) {\n        throw new Boom('err', { statusCode: response.status });\n    }\n    return response.body instanceof Readable ? response.body : Readable.fromWeb(response.body);\n};\n`,
    );
  }
  return { dir, file };
}

/**
 * Compile the exact `getHttpStream` function out of a copied `messages-media.js` file so control
 * and patched tests run the real upstream function shape against a live local HTTP server.
 */
function loadGetHttpStream(file) {
  const src = fs.readFileSync(file, 'utf8');
  const match = src.match(/export const getHttpStream = async \(url, options = \{\}\) => \{[\s\S]*?\n\};/);
  assert.ok(match, 'could not locate getHttpStream in copied messages-media.js');
  const body = match[0].replace(/^export const getHttpStream = /, 'return ');
  const { Readable } = require('stream');
  class FakeBoom extends Error {
    constructor(msg, opts) {
      super(msg);
      this.output = { statusCode: opts?.statusCode };
    }
  }
  return new Function('fetch', 'Readable', 'Boom', body)(globalThis.fetch, Readable, FakeBoom);
}

/** Start a local HTTP server that accepts a request and never writes response headers. */
async function startHangingServer() {
  let onReceived;
  let onClosed;
  const received = new Promise(resolve => (onReceived = resolve));
  const closed = new Promise(resolve => (onClosed = resolve));
  let isClosed = false;
  const server = http.createServer(req => {
    onReceived();
    req.on('close', () => {
      isClosed = true;
      onClosed();
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/media`,
    received,
    closed,
    isClosed: () => isClosed,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(() => resolve()));
    },
  };
}

test('CONTROL: unpatched getHttpStream ignores AbortSignal on a stalled local HTTP server', async () => {
  const { dir, file } = copyInstalledFixture();
  const srv = await startHangingServer();
  try {
    // If installed Baileys already carries the patch, restore the unpatched shape in our temp copy.
    const current = fs.readFileSync(file, 'utf8');
    if (current.includes(MARKER)) {
      fs.writeFileSync(
        file,
        current.replace(
          /\/\/ OpenWA:[^\n]*\n\s*const response = await fetch\(url\.toString\(\), \{[\s\S]*?\}\);/,
          FETCH_FIND,
        ),
      );
    }
    const getHttpStream = loadGetHttpStream(file);
    const abort = new AbortController();
    const pending = getHttpStream(srv.url, { signal: abort.signal });
    pending.catch(() => undefined);

    await srv.received;
    abort.abort();

    const outcome = await Promise.race([
      pending.then(
        () => 'resolved',
        err => `rejected:${err.name}`,
      ),
      new Promise(resolve => setTimeout(() => resolve('still-hanging'), 150)),
    ]);
    assert.equal(outcome, 'still-hanging');
    assert.equal(srv.isClosed(), false);
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('patched getHttpStream rejects with AbortError and closes the server socket when aborted', async () => {
  const { dir, file } = copyInstalledFixture();
  const srv = await startHangingServer();
  try {
    assert.equal(isApplied(dir), fs.readFileSync(file, 'utf8').includes(MARKER));
    const res = applyMediaSignalPatch(dir);
    assert.ok(res.note || res.skipped);
    assert.equal(isApplied(dir), true);

    const getHttpStream = loadGetHttpStream(file);
    const abort = new AbortController();
    const pending = getHttpStream(srv.url, { signal: abort.signal });

    await srv.received;
    abort.abort();

    await assert.rejects(
      () => pending,
      err => err && err.name === 'AbortError',
    );
    await srv.closed;
    assert.equal(srv.isClosed(), true);
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('patched getHttpStream still streams a normal HTTP response body intact', async () => {
  const { dir, file } = copyInstalledFixture();
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(Buffer.from('hello-media'));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    applyMediaSignalPatch(dir);
    const getHttpStream = loadGetHttpStream(file);
    const stream = await getHttpStream(`http://127.0.0.1:${port}/ok`, { signal: new AbortController().signal });
    const chunks = [];
    for await (const c of stream) chunks.push(Buffer.from(c));
    assert.equal(Buffer.concat(chunks).toString(), 'hello-media');
  } finally {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('idempotent: a second run stands down and keeps isApplied true', () => {
  const { dir, file } = copyInstalledFixture();
  try {
    // Ensure starting unpatched in temp copy to test false -> true transition cleanly.
    const raw = fs.readFileSync(file, 'utf8');
    if (raw.includes(MARKER)) {
      fs.writeFileSync(
        file,
        raw.replace(
          /\/\/ OpenWA:[^\n]*\n\s*const response = await fetch\(url\.toString\(\), \{[\s\S]*?\}\);/,
          FETCH_FIND,
        ),
      );
    }
    assert.equal(isApplied(dir), false);
    const first = applyMediaSignalPatch(dir);
    assert.equal(first.skipped, undefined);
    assert.equal(isApplied(dir), true);

    const once = fs.readFileSync(file, 'utf8');
    assert.deepEqual(applyMediaSignalPatch(dir), { skipped: true, reason: 'already patched' });
    assert.equal(fs.readFileSync(file, 'utf8'), once);
    assert.equal(once.split(MARKER).length - 1, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('refuses an unknown shape instead of shipping unpatched', () => {
  const { dir, file } = copyInstalledFixture();
  try {
    fs.writeFileSync(file, '// completely different upstream shape\n');
    assert.equal(isApplied(dir), false);
    assert.throws(() => applyMediaSignalPatch(dir), /expected exactly 1 getHttpStream fetch site/);
    assert.equal(isApplied(dir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the find string matches the installed Baileys messages-media.js exactly once', () => {
  if (!fs.existsSync(INSTALLED_MEDIA)) return;
  const source = fs.readFileSync(INSTALLED_MEDIA, 'utf8');
  if (source.includes(MARKER)) return;
  assert.equal(source.split(FETCH_FIND).length - 1, 1);
});
