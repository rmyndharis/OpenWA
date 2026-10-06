import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as lib from '@whiskeysockets/baileys';
import { LIDMappingStore } from '@whiskeysockets/baileys/lib/Signal/lid-mapping.js';
import {
  buildTcTokenFromJid,
  isTcTokenExpired,
  resolveTcTokenJid,
} from '@whiskeysockets/baileys/lib/Utils/tc-token-utils.js';

const require = createRequire(import.meta.url);
const { BaileysMessaging } = require('../../dist/engine/adapters/baileys-messaging.js');
const { BaileysSessionStore } = require('../../dist/engine/adapters/baileys-session-store.js');
const { EngineNotSentError } = require('../../dist/common/errors/engine-not-sent.error.js');
const PN = '6281111111111@s.whatsapp.net';
const LID = '123456789012345@lid';
const noop = () => undefined;

function build(t, { lid = null, budget = 1000 } = {}) {
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
      sessionProxyUrl: noop,
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

/**
 * The `<tctoken>` node `relayMessage` pushes onto a 1:1 stanza (messages-send.js): the stored
 * bytes, when they are still inside Baileys' expiry window and the session asked for them.
 * `buildTcTokenFromJid` is the library's other reader of that same store entry.
 */
async function stanzaToken(sock, jid) {
  const getLIDForPN = pn => sock.signalRepository.lidMapping.getLIDForPN(pn);
  const storageJid = await resolveTcTokenJid(jid, getLIDForPN);
  const stored = await sock.authState.keys.get('tctoken', [storageJid]);
  const entry = stored[storageJid];
  let token = entry?.token;
  if (token?.length && isTcTokenExpired(entry.timestamp)) token = undefined;
  if (!token?.length || !sock.serverProps?.privacyTokenOn1to1) return null;
  const fromStore = await buildTcTokenFromJid({ authState: sock.authState, jid, getLIDForPN });
  const libNode = fromStore?.find(node => node.tag === 'tctoken');
  assert.ok(libNode, 'buildTcTokenFromJid did not emit the stored token');
  assert.deepEqual(Buffer.from(libNode.content), Buffer.from(token));
  return { tag: 'tctoken', attrs: {}, content: Buffer.from(token) };
}

function memoryKeys(initial = {}) {
  const tctoken = { ...initial };
  return {
    tctoken,
    get(_type, ids) {
      return Promise.resolve(Object.fromEntries(ids.map(id => [id, tctoken[id]])));
    },
    set(update) {
      Object.assign(tctoken, update.tctoken);
      return Promise.resolve();
    },
  };
}

function privacyIq(bytes, timestamp, jid = PN) {
  return {
    tag: 'iq',
    attrs: { type: 'result', xmlns: 'privacy' },
    content: [
      {
        tag: 'tokens',
        attrs: {},
        content: [
          {
            tag: 'token',
            attrs: { jid, t: String(timestamp), type: 'trusted_contact' },
            content: Buffer.from(bytes),
          },
        ],
      },
    ],
  };
}

function armPrivacy(t, sock, keys, issue) {
  sock.serverProps = { privacyTokenOn1to1: true, lidTrustedTokenIssueToLid: false };
  sock.authState = { keys };
  sock.issuePrivacyTokens = t.mock.fn(issue);
  const stanzas = [];
  sock.sendMessage.mock.mockImplementation(async jid => {
    stanzas.push(await stanzaToken(sock, jid));
    return { key: { id: 'M1', remoteJid: jid }, messageTimestamp: 1 };
  });
  return stanzas;
}

test('a privacy-token IQ is stored with its bookkeeping and the stanza carries those bytes', async t => {
  const now = Math.floor(Date.now() / 1000);
  const issued = Buffer.from('issued-privacy-token');
  const keys = memoryKeys({ [PN]: { token: Buffer.alloc(0), senderTimestamp: 4242 } });
  const { messaging, sock } = build(t);
  const order = [];
  const stanzas = armPrivacy(t, sock, keys, () => {
    order.push('issue');
    return Promise.resolve(privacyIq(issued, now));
  });
  sock.sendMessage.mock.mockImplementation(async jid => {
    order.push('send');
    stanzas.push(await stanzaToken(sock, jid));
    return { key: { id: 'M1', remoteJid: jid }, messageTimestamp: 1 };
  });
  await messaging.sendTextMessage(PN, 'hello');
  assert.deepEqual(order, ['issue', 'send']);
  assert.deepEqual(sock.issuePrivacyTokens.mock.calls[0].arguments[0], [PN]);
  assert.deepEqual(keys.tctoken[PN].token, issued);
  assert.equal(keys.tctoken[PN].timestamp, String(now));
  assert.equal(keys.tctoken[PN].senderTimestamp, 4242);
  assert.equal(stanzas[0].tag, 'tctoken');
  assert.deepEqual(stanzas[0].content, issued);
});

test('a stale privacy-token IQ does not replace a newer token or its senderTimestamp', async t => {
  const now = Math.floor(Date.now() / 1000);
  const newer = Buffer.from('newer-privacy-token');
  const keys = memoryKeys();
  const { messaging, sock } = build(t);
  const stanzas = armPrivacy(t, sock, keys, () => {
    keys.tctoken[PN] = { token: newer, timestamp: String(now), senderTimestamp: 99 };
    return Promise.resolve(privacyIq('older-privacy-token', now - 30));
  });
  await messaging.sendTextMessage(PN, 'hello');
  assert.deepEqual(keys.tctoken[PN].token, newer);
  assert.equal(keys.tctoken[PN].timestamp, String(now));
  assert.equal(keys.tctoken[PN].senderTimestamp, 99);
  assert.deepEqual(stanzas[0].content, newer);
});

test('a stored privacy token is reused and still carried on the stanza', async t => {
  const now = Math.floor(Date.now() / 1000);
  const stored = Buffer.from('stored-privacy-token');
  const keys = memoryKeys({ [PN]: { token: stored, timestamp: String(now), senderTimestamp: 7 } });
  const { messaging, sock } = build(t);
  const stanzas = armPrivacy(t, sock, keys, () => Promise.reject(new Error('should not issue')));
  await messaging.sendTextMessage(PN, 'hello');
  assert.equal(sock.issuePrivacyTokens.mock.callCount(), 0);
  assert.deepEqual(stanzas[0].content, stored);
  assert.equal(keys.tctoken[PN].senderTimestamp, 7);
});

test('a stalled privacy-token query stops at the OpenWA deadline and sends nothing', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { messaging, sock } = build(t, { budget: 20 });
  armPrivacy(t, sock, memoryKeys(), () => new Promise(noop));
  const sent = messaging.sendTextMessage(PN, 'hello');
  await new Promise(setImmediate);
  t.mock.timers.tick(21);
  await assert.rejects(sent, error => error instanceof EngineNotSentError);
  assert.equal(sock.sendMessage.mock.callCount(), 0);
});

test('a socket replaced during privacy-token preparation cannot send', async t => {
  const keys = memoryKeys();
  const { messaging, sock, stop } = build(t);
  armPrivacy(t, sock, keys, () => {
    stop();
    return Promise.resolve(privacyIq('late', Math.floor(Date.now() / 1000)));
  });
  await assert.rejects(messaging.sendTextMessage(PN, 'hello'), error => error.getStatus() === 409);
  assert.equal(sock.sendMessage.mock.callCount(), 0);
  assert.equal(keys.tctoken[PN], undefined);
});

test('a phone lookup failure stays not-sent and does not issue a privacy token', async t => {
  const { messaging, sock } = build(t);
  armPrivacy(t, sock, memoryKeys(), () => Promise.resolve(privacyIq('x', Math.floor(Date.now() / 1000))));
  sock.onWhatsApp.mock.mockImplementation(() => Promise.reject(new Error('disconnected')));
  await assert.rejects(messaging.sendTextMessage(PN, 'hello'), error => error instanceof EngineNotSentError);
  assert.equal(sock.issuePrivacyTokens.mock.callCount(), 0);
  assert.equal(sock.sendMessage.mock.callCount(), 0);
});

test('groups do not issue a privacy token', async t => {
  const { messaging, sock } = build(t);
  armPrivacy(t, sock, memoryKeys(), () => Promise.reject(new Error('should not issue')));
  await messaging.sendTextMessage('123@g.us', 'hello');
  assert.equal(sock.issuePrivacyTokens.mock.callCount(), 0);
  assert.equal(sock.sendMessage.mock.calls[0].arguments[0], '123@g.us');
});
