// Exercise the pinned installed library, not a copy of the replacement function.
// Loopback WebSocket transport; no WhatsApp traffic, account or persisted auth.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { once } from 'node:events';
const require = createRequire(process.env.BAILEYS_TEST_PROVIDER_PACKAGE || import.meta.url);
const root = path.dirname(require.resolve('@whiskeysockets/baileys/package.json'));
const load = relative => import(pathToFileURL(path.join(root, relative)));
const { default: makeWASocket } = await load('lib/Socket/index.js');
const { initAuthCreds } = await load('lib/Utils/auth-utils.js');
const { DEF_CALLBACK_PREFIX } = await load('lib/Defaults/index.js');
const { decodeBinaryNode } = await load('lib/WABinary/index.js');
const { WebSocketServer } = require('ws');
function deliver(ws, node) {
  const child = Array.isArray(node.content) ? node.content[0]?.tag : '';
  for (const [attr, value] of Object.entries(node.attrs)) {
    ws.emit(`${DEF_CALLBACK_PREFIX}${node.tag},${attr}:${value},${child}`, node);
    ws.emit(`${DEF_CALLBACK_PREFIX}${node.tag},${attr}:${value}`, node);
    ws.emit(`${DEF_CALLBACK_PREFIX}${node.tag},${attr}`, node);
  }
  ws.emit(`${DEF_CALLBACK_PREFIX}${node.tag},,${child}`, node);
  ws.emit(`${DEF_CALLBACK_PREFIX}${node.tag}`, node);
}
function nextQr(sock) {
  return new Promise(resolve => {
    const listener = update => {
      if (update.qr) {
        sock.ev.off('connection.update', listener);
        resolve(update.qr);
      }
    };
    sock.ev.on('connection.update', listener);
  });
}
const refresh = child => ({
  tag: 'notification',
  attrs: { id: 'fixture-refresh', from: 's.whatsapp.net', type: 'companion_reg_refresh' },
  content: child ? [{ tag: child, attrs: {} }] : [],
});
async function boot(t) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const frames = [];
  server.on('connection', client =>
    client.on('message', data => {
      const frame = Buffer.from(data);
      frames.push(frame);
      server.emit('fixture-frame', frame);
    }),
  );
  const errors = [],
    logger = {
      level: 'silent',
      child: () => logger,
      trace() {},
      debug() {},
      info() {},
      warn() {},
      error() {
        errors.push(true);
      },
    };
  const creds = initAuthCreds();
  const sock = makeWASocket({
    auth: { creds, keys: { get: async () => ({}), set: async () => {} } },
    logger,
    waWebSocketUrl: `ws://127.0.0.1:${server.address().port}`,
    connectTimeoutMs: 5000,
    qrTimeout: 10000,
  });
  t.after(async () => {
    await sock.end(new Error('fixture complete'));
    for (const client of server.clients) client.terminate();
    await new Promise(resolve => server.close(resolve));
  });
  if (!sock.ws.isOpen) await once(sock.ws, 'open');
  const qrs = [],
    updates = [];
  sock.ev.on('connection.update', update => {
    if (update.qr) qrs.push(update.qr);
  });
  sock.ev.on('creds.update', update => updates.push(update));
  return { sock, creds, qrs, updates, errors, frames, server };
}
const pairDevice = () => ({
  tag: 'iq',
  attrs: { from: 's.whatsapp.net', type: 'set', id: 'fixture-pair' },
  content: [
    {
      tag: 'pair-device',
      attrs: {},
      content: ['fixture-ref-1', 'fixture-ref-2'].map(ref => ({ tag: 'ref', attrs: {}, content: Buffer.from(ref) })),
    },
  ],
});
for (const child of ['companion_reg_refresh', 'pair-device-rotate-qr'])
  test('real socket persists fresh secret and renders same ref for ' + child, { timeout: 10000 }, async t => {
    const { sock, creds, qrs, updates, errors } = await boot(t);
    let qr = nextQr(sock);
    deliver(sock.ws, pairDevice());
    await qr;
    const initial = qrs[0].split('#')[1].split(','),
      secret = creds.advSecretKey;
    qr = nextQr(sock);
    deliver(sock.ws, refresh(child));
    await qr;
    const current = qrs[1].split('#')[1].split(',');
    assert.equal(current[0], initial[0]);
    assert.deepEqual(current.slice(1, 3), initial.slice(1, 3));
    assert.notEqual(current[3], secret);
    assert.equal(current[3], creds.advSecretKey);
    assert.equal(Buffer.from(current[3], 'base64').length, 32);
    assert.ok(updates.some(update => update.advSecretKey === current[3]));
    for (let n = 0; n < 50; n++) deliver(sock.ws, refresh(child));
    assert.equal(qrs.length, 52);
    assert.ok(qrs.every(value => value.split('#')[1].split(',')[0] === initial[0]));
    // Generic notification handler still runs concurrently and must not throw.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(errors.length, 0);
  });
test('real ACK succeeds before login and writes the expected notification stanza', { timeout: 10000 }, async t => {
  const { sock, server, errors } = await boot(t);
  const received = new Promise(resolve =>
    server.on('fixture-frame', async frame => {
      try {
        const offset = frame.subarray(0, 2).toString() === 'WA' ? 7 : 3;
        const node = await decodeBinaryNode(frame.subarray(offset));
        if (node.tag === 'ack') resolve(node);
      } catch {}
    }),
  );
  await sock.sendMessageAck(refresh('companion_reg_refresh'));
  const ack = await received;
  assert.deepEqual(ack.attrs, {
    id: 'fixture-refresh',
    to: 's.whatsapp.net',
    class: 'notification',
    type: 'companion_reg_refresh',
  });
  assert.equal(errors.length, 0);
});
test('malformed refresh and established identity leave credentials and QR intact', { timeout: 10000 }, async t => {
  const { sock, creds, qrs, updates } = await boot(t);
  let qr = nextQr(sock);
  deliver(sock.ws, pairDevice());
  await qr;
  const secret = creds.advSecretKey;
  deliver(sock.ws, refresh());
  deliver(sock.ws, refresh('wrong-child'));
  assert.equal(qrs.length, 1);
  assert.equal(creds.advSecretKey, secret);
  assert.equal(updates.length, 0);
  creds.me = { id: 'fixture@s.whatsapp.net', name: 'fixture' };
  deliver(sock.ws, refresh('companion_reg_refresh'));
  assert.equal(qrs.length, 1);
  assert.equal(creds.advSecretKey, secret);
  assert.equal(updates.length, 0);
});
