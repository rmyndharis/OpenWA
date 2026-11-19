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
 * merge a real message with a fast-ratchet sender-key distribution in both orders, and follow it through what the
 * adapter and the library do with it afterwards (its media, its stored copy, a click on it, a reply quoting it).
 *
 * Runs over dist/: `npm run build && node --test test/engine-real/baileys-dropped-content-unread.spec.mjs`.
 * No network, no socket, no WhatsApp account.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import {
  CHAT,
  PEER,
  deliver,
  lib,
  listed,
  memoryMessageStore,
  merged,
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

// What happens to such a real message after it was announced by its content: Baileys' own readers of it (the media
// download, a quote of it) type it by the first key that contains `Message`, so they have to be handed the message
// without the distribution, and the adapter's readers of the stored copy (a click on a prompt) have to agree.
const SECRET = Buffer.alloc(32, 9);
const TEXT = { conversation: 'original', messageContextInfo: { messageSecret: SECRET } };
const PROMPT = {
  buttonsMessage: {
    contentText: 'Proceed?',
    buttons: [{ buttonId: 'yes', buttonText: { displayText: 'Yes' }, type: 1 }],
    headerType: 1,
  },
  messageContextInfo: { messageSecret: SECRET },
};
const inOrder = (order, content) =>
  order === 'before' ? [{ [FAST_RATCHET]: {} }, content] : [content, { [FAST_RATCHET]: {} }];

/** An image the library encrypted as WhatsApp's media hosts hold it, with the message that names it. */
async function encryptedPhoto() {
  const plain = Buffer.from('the bytes of a photo');
  const encrypted = await lib.encryptedStream(plain, 'image', {});
  const body = fs.readFileSync(encrypted.encFilePath);
  fs.rmSync(encrypted.encFilePath, { force: true });
  const directPath = '/v/t62.7118-24/photo.enc';
  return {
    plain,
    body,
    url: `https://mmg.whatsapp.net${directPath}`,
    content: {
      imageMessage: {
        url: `https://mmg.whatsapp.net${directPath}`,
        directPath,
        mediaKey: encrypted.mediaKey,
        mimetype: 'image/jpeg',
        fileLength: plain.length,
        fileSha256: encrypted.fileSha256,
        fileEncSha256: encrypted.fileEncSha256,
        caption: 'photo',
      },
      messageContextInfo: { messageSecret: SECRET },
    },
  };
}

/** Runs `body` with media downloads on and the fetch the library downloads through answered by `serve`. */
async function withMediaFrom(serve, body) {
  const fetchBefore = globalThis.fetch;
  process.env.MEDIA_DOWNLOAD_ENABLED = 'true';
  globalThis.fetch = serve;
  try {
    return await body();
  } finally {
    globalThis.fetch = fetchBefore;
    process.env.MEDIA_DOWNLOAD_ENABLED = 'false';
  }
}

for (const order of ['before', 'after']) {
  test(`an image that merged with a fast-ratchet distribution ${order} its content is downloaded and announced with its bytes`, async t => {
    const photo = await encryptedPhoto();
    const announced = [];
    const admissions = [];
    const fetched = [];
    const { sock } = await startSession(t, {
      callbacks: {
        onMessage: message => announced.push(message),
        admitInbound: admission => void admissions.push(admission),
      },
    });
    await withMediaFrom(
      async url => {
        fetched.push(String(url));
        return new Response(photo.body);
      },
      async () => {
        await deliver(sock, merged(`IMG-${order}`, ...inOrder(order, photo.content)));
        await until(() => announced.length === 1, 'the image to be announced', 10_000);
      },
    );
    assert.equal(announced[0].type, 'image');
    assert.equal(announced[0].media.omitted, undefined, 'its media was not left out');
    assert.equal(announced[0].media.data, photo.plain.toString('base64'));
    assert.deepEqual(fetched, [photo.url]);
    assert.equal(admissions[0].needsRoom, true, 'room is reserved for a download that happens');
  });
}

test('a message that merged with a fast-ratchet distribution first is stored without it and with its context', async t => {
  const store = memoryMessageStore();
  const { sock } = await startSession(t, { messageStore: store });
  await deliver(sock, merged('TEXT1', { [FAST_RATCHET]: {} }, TEXT));
  await until(() => store.rows.has('TEXT1'), 'the message to be stored');
  const kept = await store.getMessage('session', 'TEXT1');
  assert.deepEqual(Object.keys(kept.message), ['conversation', 'messageContextInfo']);
  // The store keeps a bytes field as base64, and the secret is what later edits, reactions and votes are read with.
  assert.deepEqual(Buffer.from(kept.message.messageContextInfo.messageSecret, 'base64'), SECRET);
});

/** A socket that builds the message the library builds for a reply or a click, and notes what it quotes. */
function replySocket(sent) {
  return {
    onWhatsApp: jid => Promise.resolve([{ jid, exists: true }]),
    sendMessage: async (jid, content, options) => {
      const built = lib.generateWAMessageFromContent(
        jid,
        lib.proto.Message.fromObject({ extendedTextMessage: { text: content.text ?? 'a click' } }),
        { ...options, userJid: SELF },
      );
      sent.push({ content, quoted: built.message.extendedTextMessage.contextInfo?.quotedMessage });
      return built;
    },
  };
}

for (const shape of ['received now', 'stored by an earlier version']) {
  const receive = async (t, wm) => {
    const store = memoryMessageStore();
    const sent = [];
    const { adapter, sock } = await startSession(t, { messageStore: store, socket: replySocket(sent) });
    if (shape === 'received now') {
      await deliver(sock, wm);
      await until(() => store.rows.has(wm.key.id), 'the message to be stored');
    } else {
      store.seed(wm);
    }
    return { adapter, sent };
  };

  // The store keeps a message as JSON in the order of the proto's fields, which puts the distribution (field 15) before
  // a business prompt (field 42) and after a text (field 1): the prompt is the one a quote reads wrongly.
  for (const [what, content, key] of [
    ['a text', TEXT, 'conversation'],
    ['a business prompt', PROMPT, 'buttonsMessage'],
  ]) {
    test(`a reply to ${what} that merged with a fast-ratchet distribution first, ${shape}, quotes it`, async t => {
      const { adapter, sent } = await receive(t, merged('QUOTED1', { [FAST_RATCHET]: {} }, content));
      await adapter.replyToMessage(CHAT, 'QUOTED1', 'a reply');
      assert.equal(sent.length, 1);
      assert.deepEqual(Object.keys(sent[0].quoted), [key]);
    });
  }

  test(`a business prompt that merged with a fast-ratchet distribution first, ${shape}, can be clicked`, async t => {
    const { adapter, sent } = await receive(t, merged('PROMPT1', { [FAST_RATCHET]: {} }, PROMPT));
    await adapter.clickButton(CHAT, 'PROMPT1', 'yes', 'Yes');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].content.buttonReply.id, 'yes');
    assert.deepEqual(Object.keys(sent[0].quoted), ['buttonsMessage']);
  });
}
