import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as lib from '@whiskeysockets/baileys';
import { LIDMappingStore } from '@whiskeysockets/baileys/lib/Signal/lid-mapping.js';

const require = createRequire(import.meta.url);
const { BaileysMessaging } = require('../../dist/engine/adapters/baileys-messaging.js');
const { BaileysSessionStore } = require('../../dist/engine/adapters/baileys-session-store.js');
const { EngineNotSentError, provesNothingSent } = require('../../dist/common/errors/engine-not-sent.error.js');
const { markEngineSendFailure } = require('../../dist/common/errors/engine-send-failure.js');
const { sendFailureProvesNothingSent } = require('../../dist/modules/message/idempotency/run-idempotent-send.js');
const { countsTowardSendBreaker, sentNothing } = require('../../dist/modules/message/send-pacing.service.js');
const { EngineNotReadyError } = require('../../dist/common/errors/engine-not-ready.error.js');
const {
  BaileysLifecycle,
  createKeyCache,
  createProxyAgent,
} = require('../../dist/engine/adapters/baileys-lifecycle.js');
const sharp = require('sharp');
const PN = '6281111111111@s.whatsapp.net';
const LID = '123456789012345@lid';
const noop = () => undefined;

function build(t, { lid = null, budget = 1000, proxyUrl } = {}) {
  const getLIDForPN = t.mock.fn(() => Promise.resolve(lid));
  const sock = {
    signalRepository: { lidMapping: { getLIDForPN, getPNForLID: () => Promise.resolve(PN) } },
    onWhatsApp: t.mock.fn(jid => Promise.resolve([{ jid, exists: true }])),
    sendMessage: t.mock.fn(jid => Promise.resolve({ key: { id: 'M1', remoteJid: jid }, messageTimestamp: 1 })),
    sendPresenceUpdate: t.mock.fn(() => Promise.resolve()),
    presenceSubscribe: t.mock.fn(() => Promise.resolve()),
  };
  let live = sock;
  const recordLidMapping = t.mock.fn();
  const messaging = new BaileysMessaging(
    {
      ensureReady: noop,
      getSocket: () => live,
      getSocketOrNull: () => live,
      logger: { warn: noop },
      toEngineJid: jid => BaileysSessionStore.prototype.toEngineJid(jid),
      toNeutralJid: jid => jid.replace('@s.whatsapp.net', '@c.us'),
      getEphemeralExpiration: noop,
      getStoredMessage: () => Promise.resolve({ key: { id: 'Q1', remoteJid: PN }, message: { conversation: 'Q' } }),
      wasDeletedForEveryone: () => false,
      pendingEditOf: noop,
      toUnixSeconds: ts => ts,
      sessionProxyUrl: () => proxyUrl,
      loadLib: () => Promise.resolve(lib),
      putStoredMessage: noop,
      recordMessage: noop,
      rememberOwnSend: noop,
      recordLidMapping,
      getOnMessageCreate: noop,
    },
    budget,
  );
  return {
    messaging,
    sock,
    recordLidMapping,
    stop: () => {
      live = null;
    },
  };
}

test('an unmapped neutral phone destination uses the Baileys domain', async t => {
  const { messaging, sock } = build(t);
  await messaging.sendTextMessage(PN.replace('@s.whatsapp.net', '@c.us'), 'hello');
  assert.equal(sock.sendMessage.mock.calls[0].arguments[0], PN);
  assert.equal(sock.onWhatsApp.mock.callCount(), 1);
});

test('a first-contact send goes to the id the number check reported, not the one typed', async t => {
  // The ninth digit of a Brazilian number: WhatsApp knows it under another digit string than people type.
  const ASKED = '5511987654321@s.whatsapp.net';
  const CANON = '551187654321@s.whatsapp.net';
  for (const lid of [null, LID]) {
    const { messaging, sock } = build(t);
    sock.onWhatsApp = t.mock.fn(() => Promise.resolve([{ jid: CANON, exists: true }]));
    const getLIDForPN = t.mock.fn(pn => Promise.resolve(pn === CANON ? lid : null));
    sock.signalRepository.lidMapping.getLIDForPN = getLIDForPN;
    await messaging.sendTextMessage(ASKED.replace('@s.whatsapp.net', '@c.us'), 'hello');
    assert.equal(sock.onWhatsApp.mock.calls[0].arguments[0], ASKED);
    assert.equal(getLIDForPN.mock.calls.at(-1).arguments[0], CANON);
    assert.equal(sock.sendMessage.mock.calls[0].arguments[0], lid ?? CANON);
  }
});

test('cold sends resolve through the real Baileys LID store', async t => {
  for (const pairs of [[], [{ pn: PN, lid: LID }]]) {
    const data = {};
    const lookup = t.mock.fn(() => Promise.resolve(pairs));
    const mapping = new LIDMappingStore(
      {
        get: (_type, ids) => Promise.resolve(Object.fromEntries(ids.map(id => [id, data[id]]))),
        set: update => {
          Object.assign(data, update['lid-mapping']);
          return Promise.resolve();
        },
        transaction: work => work(),
      },
      { trace: noop, debug: noop, warn: noop },
      lookup,
    );
    t.after(() => mapping.close());
    const { messaging, sock } = build(t);
    sock.signalRepository.lidMapping = mapping;
    await messaging.sendTextMessage(PN.replace('@s.whatsapp.net', '@c.us'), 'hello');
    assert.deepEqual(lookup.mock.calls[0].arguments[0], [PN]);
    assert.equal(sock.sendMessage.mock.calls[0].arguments[0], pairs.length ? LID : PN);
    assert.equal(sock.onWhatsApp.mock.callCount(), pairs.length ? 0 : 1);
  }
});

test('text, poll and reply sends share canonical recipient preparation', async t => {
  for (const send of [
    m => m.sendTextMessage(PN.replace('@s.whatsapp.net', '@c.us'), 'hello'),
    m => m.sendPollMessage(PN.replace('@s.whatsapp.net', '@c.us'), { name: 'Q', options: ['A', 'B'] }),
    m => m.replyToMessage(PN.replace('@s.whatsapp.net', '@c.us'), 'Q1', 'reply'),
  ]) {
    const { messaging, sock } = build(t);
    await send(messaging);
    assert.equal(sock.sendMessage.mock.calls[0].arguments[0], PN);
    assert.equal(sock.onWhatsApp.mock.callCount(), 1);
  }
});

test('hosted phone and LID destinations normalize to the account', async t => {
  const { messaging, sock } = build(t);
  await messaging.sendTextMessage(PN.replace('@s.whatsapp.net', ':3@hosted'), 'hello');
  await messaging.sendTextMessage(LID.replace('@lid', ':7@hosted.lid'), 'hello');
  assert.deepEqual(
    sock.sendMessage.mock.calls.map(call => call.arguments[0]),
    [PN, LID],
  );
});

test('known and explicit device LIDs address the account and skip phone checks', async t => {
  const { messaging, sock, recordLidMapping } = build(t, { lid: LID.replace('@', ':3@') });
  await messaging.sendTextMessage(PN, 'hello');
  await messaging.sendTextMessage(LID.replace('@', ':7@'), 'hello');
  assert.deepEqual(
    sock.sendMessage.mock.calls.map(call => call.arguments[0]),
    [LID, LID],
  );
  assert.equal(recordLidMapping.mock.calls[0].arguments[0], LID);
  assert.equal(sock.onWhatsApp.mock.callCount(), 0);
});

test('presence normalizes a phone without querying its registration', async t => {
  const { messaging, sock } = build(t);
  await messaging.sendChatState(PN.replace('@s.whatsapp.net', '@c.us'), 'typing');
  await messaging.subscribeToPresence(PN);
  assert.equal(sock.sendPresenceUpdate.mock.calls[0].arguments[1], PN);
  assert.equal(sock.onWhatsApp.mock.callCount(), 0);
});

test('groups, broadcasts and channels bypass phone checks', async t => {
  const { messaging, sock } = build(t);
  for (const jid of ['123@g.us', 'status@broadcast', '123@broadcast', '123@newsletter']) {
    await messaging.sendTextMessage(jid, 'hello');
    assert.equal(sock.sendMessage.mock.calls.at(-1).arguments[0], jid);
  }
  assert.equal(sock.onWhatsApp.mock.callCount(), 0);
});

test('an unregistered phone is refused before sending', async t => {
  const { messaging, sock } = build(t);
  sock.onWhatsApp.mock.mockImplementation(() => Promise.resolve([]));
  await assert.rejects(messaging.sendTextMessage(PN, 'hello'), error => error.getStatus() === 400);
  assert.equal(sock.sendMessage.mock.callCount(), 0);
});

test('an unanswered or rejected phone query is a transport failure before sending', async t => {
  for (const outcome of [() => Promise.resolve(undefined), () => Promise.reject(new Error('disconnected'))]) {
    const { messaging, sock } = build(t);
    sock.onWhatsApp.mock.mockImplementation(outcome);
    await assert.rejects(messaging.sendTextMessage(PN, 'hello'), error => error instanceof EngineNotSentError);
    assert.equal(sock.sendMessage.mock.callCount(), 0);
  }
});

test('a stalled phone query stops at the OpenWA deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { messaging, sock } = build(t, { budget: 20 });
  sock.onWhatsApp.mock.mockImplementation(() => new Promise(noop));
  const sent = messaging.sendTextMessage(PN, 'hello');
  await new Promise(setImmediate);
  t.mock.timers.tick(21);
  await assert.rejects(sent, error => error instanceof EngineNotSentError);
  assert.equal(sock.sendMessage.mock.callCount(), 0);
});

test('a stalled LID lookup cannot hold or send the request indefinitely', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { messaging, sock } = build(t, { budget: 20 });
  sock.signalRepository.lidMapping.getLIDForPN.mock.mockImplementation(() => new Promise(noop));
  const sent = messaging.sendTextMessage(PN, 'hello');
  await new Promise(setImmediate);
  t.mock.timers.tick(21);
  await assert.rejects(sent, error => error instanceof EngineNotSentError);
  assert.equal(sock.sendMessage.mock.callCount(), 0);
});

test('a socket stopped during phone lookup cannot send', async t => {
  const { messaging, sock, stop } = build(t);
  sock.onWhatsApp.mock.mockImplementation(jid => {
    stop();
    return Promise.resolve([{ jid, exists: true }]);
  });
  await assert.rejects(messaging.sendTextMessage(PN, 'hello'), error => error.getStatus() === 409);
  assert.equal(sock.sendMessage.mock.callCount(), 0);
});

test('a socket stopped during LID resolution cannot send or record its mapping', async t => {
  for (const outcome of [() => Promise.resolve(LID), () => Promise.reject(new Error('disconnected'))]) {
    const { messaging, sock, recordLidMapping, stop } = build(t);
    sock.signalRepository.lidMapping.getLIDForPN.mock.mockImplementation(() => {
      stop();
      return outcome();
    });
    await assert.rejects(messaging.sendTextMessage(PN, 'hello'), error => error.getStatus() === 409);
    assert.equal(sock.sendMessage.mock.callCount(), 0);
    assert.equal(recordLidMapping.mock.callCount(), 0);
  }
});

test('a failed LID query still uses a canonical phone destination', async t => {
  const { messaging, sock } = build(t);
  sock.signalRepository.lidMapping.getLIDForPN.mock.mockImplementation(() => Promise.reject(new Error('no mapping')));
  await messaging.sendTextMessage(PN.replace('@s.whatsapp.net', '@c.us'), 'hello');
  assert.equal(sock.sendMessage.mock.calls[0].arguments[0], PN);
});

const silent = {
  level: 'silent',
  child: () => silent,
  trace: noop,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
};

// A real socket, built against a closed local port so nothing reaches WhatsApp, logged out through the compiled
// lifecycle. query() is replaced to record the unlink it would send.
function loggedOutSocket(t) {
  const creds = lib.initAuthCreds();
  const sock = lib.default({
    auth: { creds, keys: { get: () => Promise.resolve({}), set: () => Promise.resolve() } },
    logger: silent,
    waWebSocketUrl: 'ws://127.0.0.1:1',
    connectTimeoutMs: 1000,
  });
  sock.ev.on('connection.update', noop);
  const sent = [];
  sock.query = node => {
    sent.push(node);
    return Promise.resolve({ tag: 'iq', attrs: { type: 'result' } });
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-engine-real-logout-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const authPath = path.join(dir, 's1');
  fs.mkdirSync(authPath);
  fs.writeFileSync(path.join(authPath, 'creds.json'), '{}');
  const lifecycle = new BaileysLifecycle({
    authPath,
    logger: { log: noop, warn: noop, error: noop, debug: noop },
    config: { sessionId: 's1', dbSessionId: 's1' },
    liveCalls: new Map(),
    fenceStoredWrites: noop,
    getOnStateChanged: noop,
    getOnDisconnected: noop,
    getOnError: noop,
    getOnCredentialTeardownStarted: noop,
  });
  lifecycle.lib = lib;
  lifecycle.sock = sock;
  const logout = () =>
    lifecycle.logout().then(
      () => 'unlinked',
      error => error,
    );
  return { sock, creds, sent, logout, authPath };
}

test('a logout of a socket that never linked refuses with the 409 and sends nothing', async t => {
  const { sent, logout } = loggedOutSocket(t);
  assert.ok((await logout()) instanceof EngineNotReadyError);
  assert.equal(sent.length, 0);
});

test('a logout while a pairing code is pending refuses with the 409 and sends nothing', async t => {
  const { sock, creds, sent, logout } = loggedOutSocket(t);
  await sock.requestPairingCode('6281234567890').catch(noop);
  // The request names the number in the credentials; the socket's user is the copy made when it was built.
  assert.equal(creds.me?.id, '6281234567890@s.whatsapp.net');
  assert.equal(sock.user, undefined);
  assert.ok((await logout()) instanceof EngineNotReadyError);
  assert.equal(sent.length, 0);
});

test('a logout right after pairing, before the restart, unlinks the device', async t => {
  const { sock, sent, logout, authPath } = loggedOutSocket(t);
  // What pair-success hands to creds.update; the library merges it into the socket's credentials.
  sock.ev.emit('creds.update', {
    me: { id: '6281234567890:12@s.whatsapp.net', name: 'Biz', lid: '123456789012345:12@lid' },
    account: lib.proto.ADVSignedDeviceIdentity.fromObject({ details: Buffer.from([1]) }),
    platform: 'android',
  });
  assert.equal(sock.user, undefined);
  assert.equal(await logout(), 'unlinked');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content[0].tag, 'remove-companion-device');
  assert.equal(sent[0].content[0].attrs.jid, '6281234567890:12@s.whatsapp.net');
  assert.equal(fs.existsSync(authPath), false);
});

// A real socket, built against a closed local port, from the credentials a first link leaves for its restart: a
// personal account's pair-success carries no name (configureSuccessfulPairing takes it from the business node).
function linkedSocket(t) {
  const creds = lib.initAuthCreds();
  creds.me = { id: '6281234567890:12@s.whatsapp.net', lid: '123456789012345:12@lid' };
  const sock = lib.default({
    auth: { creds, keys: { get: () => Promise.resolve({}), set: () => Promise.resolve() } },
    logger: silent,
    waWebSocketUrl: 'ws://127.0.0.1:1',
    connectTimeoutMs: 1000,
  });
  sock.ev.on('connection.update', noop);
  t.after(() => sock.end(undefined));
  const sent = [];
  sock.sendPresenceUpdate = type => {
    sent.push(type);
    return Promise.resolve();
  };
  const messaging = new BaileysMessaging({
    ensureReady: noop,
    getSocket: () => sock,
    getSocketOrNull: () => sock,
    logger: { warn: noop },
  });
  return { sock, creds, sent, messaging };
}

test('own presence is published once the account name has synced on the running socket', async t => {
  const { sock, creds, sent, messaging } = linkedSocket(t);
  // The app-state pushNameSetting (or an own message's pushName) reaches the socket as this creds.update.
  sock.ev.emit('creds.update', { me: { ...creds.me, name: 'Synced Name' } });
  assert.equal(creds.me.name, 'Synced Name');
  assert.equal(sock.user.name, undefined);

  await messaging.setOnlinePresence(false);

  assert.deepEqual(sent, ['unavailable']);
});

test('own presence is refused while the account has no name, as Baileys would ignore it', async t => {
  const { sent, messaging } = linkedSocket(t);
  await assert.rejects(messaging.setOnlinePresence(true), EngineNotReadyError);
  assert.deepEqual(sent, []);
});

/** Far longer than the 1000 ms budget build() gives the messaging code, so a loaded machine cannot miss it. */
const UPLOAD_BOUND_MS = 15_000;

// A session egress proxy that opens the tunnel and then never answers through it, so the TLS handshake with the
// media host never completes: HTTP CONNECT or SOCKS5, the two kinds createProxyAgent builds.
function stalledProxy(t, scheme) {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', noop);
    const replies =
      scheme === 'http'
        ? [Buffer.from('HTTP/1.1 200 Connection Established\r\n\r\n')]
        : [Buffer.from([5, 0]), Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 9])];
    socket.on('data', () => {
      const reply = replies.shift();
      if (reply) socket.write(reply);
    });
  });
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise(resolve => server.close(resolve));
  });
  return new Promise(resolve =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ url: `${scheme}://127.0.0.1:${server.address().port}`, tunnels: () => sockets.size }),
    ),
  );
}

// The library's uploader, as the lifecycle wires it for a proxied session: fetchAgent is the proxy agent.
function uploaderThrough(t, proxyUrl) {
  const fetchAgent = createProxyAgent(proxyUrl);
  t.after(() => fetchAgent.destroy());
  return lib.getWAUploadToServer({ customUploadHosts: [], fetchAgent, logger: silent, options: {} }, () =>
    Promise.resolve({
      hosts: [{ hostname: '127.0.0.1:9', maxContentLengthBytes: 1e9 }],
      auth: 'a',
      ttl: 60,
      fetchDate: new Date(),
    }),
  );
}

function outcomeWithin(work, ms) {
  let timer;
  return Promise.race([
    work.then(
      () => 'sent',
      () => 'refused',
    ),
    new Promise(resolve => {
      timer = setTimeout(() => resolve('still waiting'), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const previewImage = () =>
  sharp({ create: { width: 64, height: 64, channels: 3, background: '#336699' } })
    .jpeg()
    .toBuffer();

test('a preview image upload through a session proxy that stops answering ends, and the text goes out', async t => {
  const image = await previewImage();
  for (const scheme of ['http', 'socks5']) {
    const proxy = await stalledProxy(t, scheme);
    const { messaging, sock } = build(t, { proxyUrl: proxy.url });
    sock.waUploadToServer = uploaderThrough(t, proxy.url);
    const send = messaging.sendTextMessage(PN.replace('@s.whatsapp.net', '@c.us'), 'see https://example.com', [], {
      customPreview: { url: 'https://example.com', title: 'Example', thumbnailBase64: image.toString('base64') },
    });

    assert.equal(await outcomeWithin(send, UPLOAD_BOUND_MS), 'sent', scheme);
    assert.equal(proxy.tunnels(), 1, scheme);
    const { linkPreview } = sock.sendMessage.mock.calls[0].arguments[1];
    assert.equal(linkPreview.title, 'Example', scheme);
    assert.equal(linkPreview.highQualityThumbnail, undefined, scheme);
  }
});

test('a media send through a session proxy that stops answering fails within the bound', async t => {
  const image = await previewImage();
  const proxy = await stalledProxy(t, 'http');
  const { messaging, sock } = build(t, { proxyUrl: proxy.url });
  sock.waUploadToServer = uploaderThrough(t, proxy.url);
  // What the library's sendMessage does before the relay: build the message, uploading its media.
  sock.sendMessage = t.mock.fn((jid, content, options) =>
    lib.generateWAMessage(jid, content, { logger: silent, userJid: PN, upload: sock.waUploadToServer, ...options }),
  );

  const send = messaging.sendImageMessage(PN.replace('@s.whatsapp.net', '@c.us'), {
    data: image,
    mimetype: 'image/jpeg',
  });

  assert.equal(await outcomeWithin(send, UPLOAD_BOUND_MS), 'refused');
  assert.equal(proxy.tunnels(), 1);
});

test('a direct session leaves a stalled upload to the idle timeout of the agent it uploads through', async t => {
  const image = await previewImage();
  const { messaging, sock } = build(t);
  const timeouts = [];
  sock.waUploadToServer = (_path, { timeoutMs }) => {
    timeouts.push(timeoutMs);
    return Promise.reject(new Error('upload refused'));
  };

  await messaging.sendTextMessage(PN.replace('@s.whatsapp.net', '@c.us'), 'see https://example.com', [], {
    customPreview: { url: 'https://example.com', title: 'Example', thumbnailBase64: image.toString('base64') },
  });
  await messaging.sendImageMessage(PN.replace('@s.whatsapp.net', '@c.us'), { data: image, mimetype: 'image/jpeg' });

  assert.deepEqual(timeouts, [undefined]);
  assert.equal(sock.sendMessage.mock.calls[1].arguments[2].mediaUploadTimeoutMs, undefined);
});

// A TCP port that nothing listens on: the OS picks one and the server lets it go, so a connection is refused at once.
async function closedPort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

// The library's own uploader, aimed at a media host that refuses the connection.
async function refusingUploader() {
  const port = await closedPort();
  return lib.getWAUploadToServer({ customUploadHosts: [], fetchAgent: undefined, logger: silent, options: {} }, () =>
    Promise.resolve({
      hosts: [{ hostname: `127.0.0.1:${port}`, maxContentLengthBytes: 1e9 }],
      auth: 'a',
      ttl: 60,
      fetchDate: new Date(),
    }),
  );
}

// What the library's sendMessage does: build the message, which uploads its media, and relay it only after that.
function relayingAfterUpload(t, sock, relayed = []) {
  sock.sendMessage = t.mock.fn(async (jid, content, options) => {
    const message = await lib.generateWAMessage(jid, content, {
      logger: silent,
      userJid: PN,
      upload: sock.waUploadToServer,
      ...options,
    });
    relayed.push(message);
    return message;
  });
  return relayed;
}

test('a media send whose upload the media host refuses sent nothing', async t => {
  const image = await previewImage();
  const chat = PN.replace('@s.whatsapp.net', '@c.us');
  for (const send of [
    messaging => messaging.sendImageMessage(chat, { data: image, mimetype: 'image/jpeg' }),
    messaging => messaging.sendDocumentMessage(chat, { data: image, mimetype: 'application/pdf', filename: 'a.pdf' }),
  ]) {
    const { messaging, sock } = build(t);
    sock.waUploadToServer = await refusingUploader();
    const relayed = relayingAfterUpload(t, sock);

    const error = await send(messaging).then(
      () => assert.fail('the send must fail'),
      failure => failure,
    );

    assert.equal(error.message, 'Media upload failed on all hosts');
    assert.deepEqual(relayed, [], 'the relay is never reached');
    assert.equal(provesNothingSent(error), true);
    assert.equal(sendFailureProvesNothingSent(markEngineSendFailure(error)), true);
    assert.equal(sentNothing(error), true);
    assert.equal(countsTowardSendBreaker(error), false);
  }
});

test('an upload that succeeds is relayed with the media it uploaded, encrypted and with its thumbnail', async t => {
  const image = await previewImage();
  const { messaging, sock } = build(t);
  const uploads = [];
  sock.waUploadToServer = (filePath, options) => {
    uploads.push(options);
    return Promise.resolve({ mediaUrl: 'https://mmg.example/u', directPath: '/d/u' });
  };
  const relayed = relayingAfterUpload(t, sock);

  await messaging.sendImageMessage(PN.replace('@s.whatsapp.net', '@c.us'), { data: image, mimetype: 'image/jpeg' });

  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].mediaType, 'image');
  assert.equal(uploads[0].timeoutMs, undefined);
  assert.ok(uploads[0].fileEncSha256B64.length > 0);
  const media = relayed[0].message.imageMessage;
  assert.equal(media.url, 'https://mmg.example/u');
  assert.equal(media.directPath, '/d/u');
  assert.ok(media.mediaKey.length > 0 && media.fileEncSha256.length > 0 && media.fileSha256.length > 0);
  assert.ok(media.jpegThumbnail.length > 0);
});

// Every setInterval that `work` makes and nothing clears, as the delay it was given.
async function intervalsLeftBy(work) {
  const live = new Map();
  const { setInterval: set, clearInterval: clear } = globalThis;
  globalThis.setInterval = (...args) => {
    const timer = set(...args);
    live.set(timer, args[1]);
    return timer;
  };
  globalThis.clearInterval = timer => {
    live.delete(timer);
    return clear(timer);
  };
  try {
    await work();
  } finally {
    globalThis.setInterval = set;
    globalThis.clearInterval = clear;
  }
  return [...live.values()];
}

test('the library builds a key cache with an interval timer that only the library could close', async () => {
  const keyStore = { get: () => Promise.resolve({}), set: () => Promise.resolve() };

  const left = await intervalsLeftBy(() => lib.makeCacheableSignalKeyStore(keyStore, silent));

  assert.equal(left.length, 1, 'the instrument sees the timer of the cache the library makes on its own');
});

test('connecting, and reconnecting, leaves no interval timer running for a socket that has ended', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-engine-real-keycache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const authPath = path.join(dir, 's1');
  const sockets = [];
  const lifecycle = new BaileysLifecycle({
    authPath,
    logger: { log: noop, warn: noop, error: noop, debug: noop },
    config: { sessionId: 's1', dbSessionId: 's1' },
    liveCalls: new Map(),
    getOnStateChanged: noop,
    getOnDisconnected: noop,
    getOnError: noop,
  });
  lifecycle.versionResolver = { resolve: () => Promise.resolve([2, 3000, 1]) };
  // The library's own key cache wrapper and event buffer, with only the socket itself replaced.
  lifecycle.lib = {
    ...lib,
    default: () => {
      const sock = {
        ev: lib.makeEventBuffer(silent),
        ws: Object.assign(new EventEmitter(), { isOpen: false, isConnecting: false }),
        end: noop,
      };
      sockets.push(sock);
      return sock;
    },
  };
  t.after(async () => {
    await lifecycle.destroy();
    for (const sock of sockets) sock.ev.destroy();
  });

  const left = await intervalsLeftBy(async () => {
    await lifecycle.connectInner();
    await lifecycle.connectInner();
    await lifecycle.connectInner();
  });

  assert.equal(sockets.length, 3);
  assert.deepEqual(left, []);
});

test('the key cache serves a written key from memory until it is flushed or its time has passed', async () => {
  let clock = 0;
  const reads = [];
  const keyStore = {
    get: (type, ids) => {
      reads.push(ids);
      return Promise.resolve(Object.fromEntries(ids.map(id => [id, { from: 'disk' }])));
    },
    set: () => Promise.resolve(),
    clear: () => Promise.resolve(),
  };
  const keys = lib.makeCacheableSignalKeyStore(
    keyStore,
    silent,
    createKeyCache(1000, () => clock),
  );

  await keys.set({ session: { a: { from: 'memory' } } });
  assert.deepEqual(await keys.get('session', ['a']), { a: { from: 'memory' } });
  assert.equal(reads.length, 0, 'a key just written is not read back from the files');

  clock = 1000;
  assert.deepEqual(await keys.get('session', ['a']), { a: { from: 'disk' } });
  assert.equal(reads.length, 1, 'a key whose time has passed is read from the files');

  await keys.get('session', ['a']);
  assert.equal(reads.length, 1, 'and kept in memory again');
  await keys.clear();
  await keys.get('session', ['a']);
  assert.equal(reads.length, 2, 'a clear flushes it');
});
