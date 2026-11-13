// Exercise the pinned Baileys socket over loopback WebSocket.
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
async function boot(t, { qrTimeout = 10000, ...config } = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  server.on('connection', client =>
    client.on('message', data => {
      const frame = Buffer.from(data);
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
      error(...args) {
        errors.push(args);
      },
    };
  const creds = initAuthCreds();
  let sock;
  t.after(async () => {
    await sock?.end(new Error('fixture complete'));
    for (const client of server.clients) client.terminate();
    await new Promise(resolve => server.close(resolve));
  });
  sock = makeWASocket({
    auth: { creds, keys: { get: async () => ({}), set: async () => {} } },
    logger,
    waWebSocketUrl: `ws://127.0.0.1:${server.address().port}`,
    connectTimeoutMs: 5000,
    qrTimeout,
    ...config,
  });
  if (!sock.ws.isOpen) await once(sock.ws, 'open');
  const qrs = [],
    updates = [];
  sock.ev.on('connection.update', update => {
    if (update.qr) qrs.push(update.qr);
  });
  sock.ev.on('creds.update', update => updates.push(update));
  return { sock, creds, qrs, updates, errors, server };
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
  test('real socket emits fresh credentials and renders same ref for ' + child, { timeout: 10000 }, async t => {
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
  const { sock, creds, server, errors } = await boot(t);
  const receiveAck = () =>
    new Promise(resolve =>
      server.on('fixture-frame', async frame => {
        try {
          const offset = frame.subarray(0, 2).toString() === 'WA' ? 7 : 3;
          const node = await decodeBinaryNode(frame.subarray(offset));
          if (node.tag === 'ack') resolve(node);
        } catch {}
      }),
    );
  const received = receiveAck();
  await sock.sendMessageAck(refresh('companion_reg_refresh'));
  const ack = await received;
  assert.deepEqual(ack.attrs, {
    id: 'fixture-refresh',
    to: 's.whatsapp.net',
    class: 'notification',
    type: 'companion_reg_refresh',
  });
  creds.me = { id: 'fixture@s.whatsapp.net' };
  const registeredAck = receiveAck();
  await sock.sendMessageAck(
    {
      tag: 'message',
      attrs: {
        id: 'registered-message',
        from: 'peer@s.whatsapp.net',
        participant: 'member@s.whatsapp.net',
        type: 'text',
      },
    },
    42,
  );
  assert.deepEqual((await registeredAck).attrs, {
    id: 'registered-message',
    to: 'peer@s.whatsapp.net',
    class: 'message',
    error: '42',
    participant: 'member@s.whatsapp.net',
    type: 'text',
    from: creds.me.id,
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
test(
  'a pairing code request stops the QR timer, so running out of refs does not end the socket',
  { timeout: 10000 },
  async t => {
    // Upstream keeps the timer running: the second ref is rendered and the third wait ends the socket with
    // 'QR refs attempts ended'. This patch adapts #2765 to stop at creds.me, which requestPairingCode writes
    // before the code is entered.
    const { sock, creds, qrs } = await boot(t, { qrTimeout: 150 });
    const closed = [];
    sock.ev.on('connection.update', update => {
      if (update.connection === 'close') closed.push(update.lastDisconnect?.error?.message);
    });
    const qr = nextQr(sock);
    deliver(sock.ws, pairDevice());
    await qr;
    creds.me = { id: 'fixture@s.whatsapp.net', name: '~' };
    // Longer than the two refs last with a 150 ms timer.
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal(qrs.length, 1, 'a QR was rendered after the pairing code was requested');
    assert.deepEqual(closed, [], 'the socket ended when the QR refs ran out');
    assert.ok(sock.ws.isOpen);
  },
);
// WhatsApp delivers some accounts' contact statuses as a top-level <status> node. Unanswered, the server ends
// the stream about 50 minutes later ("Stream Errored (ack)") and redelivers it on every reconnect.
const statusStanza = (attrs = {}) => ({
  tag: 'status',
  attrs: { id: 'fixture-status', from: '5511999999999@s.whatsapp.net', type: 'media', ...attrs },
});
const STATUS_ACK = { id: 'fixture-status', to: '5511999999999@s.whatsapp.net', class: 'status', type: 'media' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Wait for the first ack (or error), so a slow runner needs time rather than failing; then settle() for a second one.
async function until(predicate, what, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await sleep(10);
  }
}
const settle = () => sleep(100);
const ackFailures = errors => errors.filter(args => args[1] === "unexpected error in 'acking status stanza'");
function collectAcks(server) {
  const acks = [];
  server.on('fixture-frame', async frame => {
    try {
      const offset = frame.subarray(0, 2).toString() === 'WA' ? 7 : 3;
      const node = await decodeBinaryNode(frame.subarray(offset));
      if (node.tag === 'ack') acks.push(node);
    } catch {}
  });
  return acks;
}
for (const [name, attrs] of [
  ['a live', {}],
  ['an offline', { offline: '1' }],
])
  test(`${name} <status> stanza is acknowledged once, as class status`, { timeout: 10000 }, async t => {
    const { sock, creds, server, errors } = await boot(t);
    creds.me = { id: 'fixture@s.whatsapp.net', name: 'fixture' };
    const acks = collectAcks(server);
    deliver(sock.ws, statusStanza(attrs));
    await until(() => acks.length > 0, 'the ack');
    await settle();
    assert.deepEqual(
      acks.map(ack => ack.attrs),
      [STATUS_ACK],
    );
    assert.equal(errors.length, 0);
  });
test('a <status> stanza from an ignored JID is acknowledged on the fast path', { timeout: 10000 }, async t => {
  const { sock, creds, server, errors } = await boot(t, { shouldIgnoreJid: () => true });
  creds.me = { id: 'fixture@s.whatsapp.net', name: 'fixture' };
  const acks = collectAcks(server);
  deliver(sock.ws, statusStanza());
  await until(() => acks.length > 0, 'the ack');
  await settle();
  assert.deepEqual(
    acks.map(ack => ack.attrs),
    [STATUS_ACK],
  );
  assert.equal(errors.length, 0);
});
for (const [name, config] of [
  ['an ignored JID', { shouldIgnoreJid: () => true }],
  ['a handled JID', {}],
])
  test(`a failed ack of <status> from ${name} is reported, not thrown`, { timeout: 10000 }, async t => {
    const { sock, creds, errors } = await boot(t, config);
    creds.me = { id: 'fixture@s.whatsapp.net', name: 'fixture' };
    const unhandled = [];
    const onUnhandled = reason => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    t.after(() => process.off('unhandledRejection', onUnhandled));
    await sock.ws.close();
    deliver(sock.ws, statusStanza());
    await until(() => ackFailures(errors).length > 0, 'the reported ack failure');
    await settle();
    assert.equal(ackFailures(errors).length, 1);
    assert.deepEqual(unhandled, []);
  });
