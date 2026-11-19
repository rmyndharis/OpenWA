/**
 * Which messages Baileys counts as received but the adapter does not announce, against the unread count the chat is
 * listed with.
 *
 * Baileys raises a chat's unread count for every message it takes for a real one. The adapter announces most of them
 * and drops a few as carrying no content of their own (BAILEYS_NON_CONTENT_TYPES, and a message made only of protocol
 * noise). A chat must not be listed unread for a message nobody can read, so every shape the adapter drops while Baileys
 * counts it has to leave the chat's count alone, and none the adapter announces may lose it.
 *
 * Every top-level field of the shipped proto is built, wire-encoded and decoded, run through the REAL library's
 * processMessage and event buffer into the compiled adapter (lifecycle listener, unread filter, session store), and through
 * the compiled handler for what the adapter makes of it. Baileys also merges the decrypted parts of one stanza into one
 * message in the order the stanza lists them, and types it by the first key that contains `Message`: the cases below
 * merge a real message with a fast-ratchet sender-key distribution in both orders.
 *
 * Runs over dist/: `npm run build && node --test test/engine-real/baileys-dropped-content-unread.spec.mjs`.
 * No network, no socket, no WhatsApp account.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  PEER,
  deliver,
  lib,
  listed,
  processMessage,
  startSession,
  until,
  wireMessage,
} from './support/baileys-session.mjs';

const require = createRequire(import.meta.url);
const { BaileysEvents } = require('../../dist/engine/adapters/baileys-events.js');
const { BaileysHistory } = require('../../dist/engine/adapters/baileys-history.js');
const { ConcurrencyLimiter } = require('../../dist/common/utils/concurrency-limiter.js');

const SELF = '6280000000000@s.whatsapp.net';
const FAST_RATCHET = 'fastRatchetKeySenderKeyDistributionMessage';
const AT = 1_700_000_000;
const silent = { log() {}, debug() {}, verbose() {}, warn() {}, error() {} };

const messageOf = (id, message, chat = PEER) => wireMessage({ id, chat, at: AT, message });

/**
 * The decrypted parts of one stanza merged as Baileys' decryptMessageNode merges them: `Object.assign` in the order the
 * stanza lists them, so the key order of the message is the order of its parts.
 */
function merged(id, ...parts) {
  const message = parts
    .map(part => lib.proto.Message.decode(lib.proto.Message.encode(lib.proto.Message.fromObject(part)).finish()))
    .reduce((all, part) => Object.assign(all, part));
  return lib.proto.WebMessageInfo.fromObject({
    key: { id, remoteJid: PEER, fromMe: false },
    messageTimestamp: AT,
    message,
  });
}

/** Whether the library counts this message as a received one, which is what raises the chat's unread count. */
async function countedByLibrary(wm) {
  const emitted = [];
  await processMessage(wm, {
    shouldProcessHistoryMsg: false,
    ev: { emit: (name, data) => emitted.push({ name, data }) },
    creds: { me: { id: SELF }, accountSettings: { unarchiveChats: false } },
    signalRepository: { lidMapping: {} },
    keyStore: {},
    options: {},
    getMessage: async () => undefined,
  });
  return emitted.filter(e => e.name === 'chats.update').flatMap(e => e.data)[0]?.unreadCount === 1;
}

/**
 * What the compiled handler does with a message: it announces it, or it drops it and logs which drop. Waits for either,
 * up to a deadline, so a message that reaches neither fails the test instead of passing as a silent drop.
 */
function handled(wm) {
  return new Promise((resolve, reject) => {
    const noop = () => undefined;
    const timer = setTimeout(() => reject(new Error(`${wm.key.id} was neither announced nor dropped`)), 5000);
    const settle = outcome => {
      clearTimeout(timer);
      resolve(outcome);
    };
    const announce = payload => settle({ kind: 'announced', payload });
    const events = new BaileysEvents({
      getSocket: () => ({ updateMediaMessage: noop }),
      getSocketOrNull: () => null,
      logger: {
        ...silent,
        debug: (_message, meta) => {
          if (String(meta?.action).startsWith('baileys_drop_')) settle({ kind: 'dropped', action: meta.action });
        },
        warn: (message, meta) => reject(new Error(`${wm.key.id}: ${message} ${meta?.error ?? ''}`)),
      },
      toNeutralJid: jid => jid.replace('@s.whatsapp.net', '@c.us'),
      normalizedSelfJid: () => SELF,
      loadLib: () => Promise.resolve(lib),
      getFetchDispatcher: () => undefined,
      inboundLimiter: new ConcurrencyLimiter(2),
      recordKeyLidMappings: noop,
      recordMessage: noop,
      recordMessageEdit: noop,
      putStoredMessage: () => undefined,
      updateStoredMessage: () => undefined,
      consumeOwnSend: () => false,
      getStoredMessage: () => undefined,
      getOnMessage: () => announce,
      getOnMessageCreate: () => announce,
      getOnMessageRevoked: () => noop,
      getOnMessageEdited: () => noop,
      getOnMessageReaction: () => noop,
      getOnPollVote: () => noop,
      getOnMessageAck: () => undefined,
      getOnGroupEvent: () => undefined,
      getOnCall: () => undefined,
      getOnPresenceUpdate: () => undefined,
      getOnCallOutcome: () => undefined,
    });
    events.handleMessagesUpsert({ messages: [wm], type: 'notify' });
  });
}

/** What the history capture hands over for these messages. */
async function historyOf(...messages) {
  const handed = [];
  const noop = () => undefined;
  const history = new BaileysHistory({
    getSocket: () => ({}),
    logger: silent,
    toNeutralJid: jid => jid.replace('@s.whatsapp.net', '@c.us'),
    normalizedSelfJid: () => SELF,
    loadLib: () => Promise.resolve(lib),
    recordMessage: noop,
    recordMessageEdit: noop,
    applyHistoryRevoke: () => Promise.resolve(undefined),
    upsertContacts: noop,
    upsertChats: noop,
    contactCount: () => 0,
    extractEphemeralDuration: () => undefined,
    getOnHistoryMessages: () => batch => void handed.push(...batch),
  });
  await history.captureHistoryMessages(messages);
  return handed.map(m => [m.id, m.type, m.body]);
}

/** The unread count the adapter lists the chat with after this message was delivered; 0 when it lists no such chat. */
async function unreadAfter(t, wm) {
  const { adapter, sock } = await startSession(t);
  await deliver(sock, wm);
  return (await listed(adapter, wm.key.remoteJid.replace('@s.whatsapp.net', '@c.us')))?.unreadCount ?? 0;
}

const PIN = { pinInChatMessage: { key: { id: 'OLD1', remoteJid: PEER, fromMe: true }, type: 1, senderTimestampMs: 1 } };

// Control: the shapes the filter was written for are not listed unread, and a plain text message is.
test('an in-chat pin does not list the chat unread and a text message does', async t => {
  assert.equal(await unreadAfter(t, messageOf('PIN1', PIN)), 0);
  assert.equal(await unreadAfter(t, messageOf('TEXT1', { conversation: 'hello' })), 1);
});

test('a lone fast-ratchet sender-key distribution does not list the chat unread', async t => {
  const wm = messageOf('FR1', { [FAST_RATCHET]: {} });
  assert.equal(await countedByLibrary(wm), true, 'the library counts it as a received message');
  assert.deepEqual(await handled(wm), { kind: 'dropped', action: 'baileys_drop_protocol_noise' });
  assert.equal(await unreadAfter(t, wm), 0);
});

test('every message the adapter drops while the library counts it is not listed unread, and none it announces is lost', async t => {
  const { adapter, sock } = await startSession(t);
  const dropped = [];
  const announced = [];
  const wrong = { droppedAndListedUnread: [], announcedAndNotListedUnread: [] };
  let index = 0;
  for (const field of Object.keys(lib.proto.Message.prototype)) {
    // A chat of its own for each shape, so one never answers for another.
    const chat = `62811000${String(index++).padStart(4, '0')}@s.whatsapp.net`;
    let wm;
    try {
      wm = messageOf(`ID-${field}`, { [field]: field === 'conversation' ? 'x' : {} }, chat);
    } catch {
      continue;
    }
    if (!(await countedByLibrary(wm))) continue;
    const outcome = (await handled(wm)).kind;
    await deliver(sock, wm);
    const unread = (await listed(adapter, chat.replace('@s.whatsapp.net', '@c.us')))?.unreadCount ?? 0;
    if (outcome === 'dropped') {
      dropped.push(field);
      if (unread !== 0) wrong.droppedAndListedUnread.push(field);
    } else {
      announced.push(field);
      if (unread !== 1) wrong.announcedAndNotListedUnread.push(field);
    }
  }
  assert.deepEqual(wrong, { droppedAndListedUnread: [], announcedAndNotListedUnread: [] });
  // The scan reached the shapes it is about: the seven kinds, the distribution, and the ordinary messages.
  for (const field of [
    'secretEncryptedMessage',
    'encReactionMessage',
    'pinInChatMessage',
    'keepInChatMessage',
    'albumMessage',
    'encEventResponseMessage',
    'encCommentMessage',
    FAST_RATCHET,
  ]) {
    assert.ok(dropped.includes(field), `${field} is dropped by the adapter and counted by the library`);
  }
  for (const field of ['conversation', 'extendedTextMessage', 'imageMessage', 'contactMessage']) {
    assert.ok(announced.includes(field), `${field} is announced by the adapter and counted by the library`);
  }
});

for (const order of ['before', 'after']) {
  const text = { conversation: 'hello' };
  const textParts = order === 'before' ? [{ [FAST_RATCHET]: {} }, text] : [text, { [FAST_RATCHET]: {} }];
  const pinParts = order === 'before' ? [{ [FAST_RATCHET]: {} }, PIN] : [PIN, { [FAST_RATCHET]: {} }];

  test(`a text that merged with a fast-ratchet distribution ${order} it is announced as a text and lists the chat unread`, async t => {
    const announced = [];
    const { adapter, sock } = await startSession(t, { callbacks: { onMessage: m => announced.push(m) } });
    const wm = merged('TEXT1', ...textParts);
    await deliver(sock, wm);
    await until(() => announced.length === 1, 'the text to be announced');
    assert.deepEqual([announced[0].type, announced[0].body], ['text', 'hello']);
    assert.equal((await listed(adapter)).unreadCount, 1);
  });

  test(`a pin that merged with a fast-ratchet distribution ${order} it is dropped and does not list the chat unread`, async t => {
    const wm = merged('PIN1', ...pinParts);
    assert.equal(await countedByLibrary(wm), true);
    assert.deepEqual(await handled(merged('PIN1', ...pinParts)), {
      kind: 'dropped',
      action: 'baileys_drop_non_content',
    });
    assert.equal(await unreadAfter(t, wm), 0);
  });

  // The history capture reads the same shapes.
  test(`the history capture hands over a text that merged with a fast-ratchet distribution ${order} it as a text`, async () => {
    assert.deepEqual(await historyOf(merged('TEXT1', ...textParts)), [['TEXT1', 'text', 'hello']]);
  });
}

test('the history capture hands over nothing for a lone fast-ratchet sender-key distribution', async () => {
  assert.deepEqual(
    await historyOf(messageOf('FR1', { [FAST_RATCHET]: {} }), messageOf('TEXT1', { conversation: 'hi' })),
    [['TEXT1', 'text', 'hi']],
  );
});
