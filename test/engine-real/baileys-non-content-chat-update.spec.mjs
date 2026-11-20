/**
 * The chat update Baileys raises for a message that is no message of its own (an encrypted edit or reaction, an in-chat
 * pin, a keep-in-chat toggle, an album header, an event answer, an encrypted comment), through the REAL library's
 * processMessage and event buffer into the compiled adapter (lifecycle listener, unread filter, session store). The
 * chat-state table behind the store is an in-memory fake.
 *
 * Baileys counts such a message as received, so the update it emits carries the message's time as well as a count. The
 * adapter does not list the message and keeps its count out of the chat's unread count; its time must not count either.
 * A chat WhatsApp deleted stays out of the list until a message of its own arrives, and a message that is none of its own
 * is no such message.
 *
 * Runs over dist/: `npm run build && node --test test/engine-real/baileys-non-content-chat-update.spec.mjs`.
 * No network, no socket, no WhatsApp account.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAT,
  FakeChatStateStore,
  PEER,
  deliver,
  deliverTogether,
  lib,
  listed,
  quiet,
  startSession,
  until,
  wireMessage,
} from './support/baileys-session.mjs';

const now = () => Math.floor(Date.now() / 1000);
/** The adapter settles a chat that may hold only messages of no content in the microtask that follows its flush. */
const settled = () => new Promise(resolve => setImmediate(resolve));
const target = { id: 'OLD1', remoteJid: PEER, fromMe: false };
const sealed = { encPayload: Buffer.alloc(32, 1), encIv: Buffer.alloc(12, 2) };
const pinOf = () => ({
  pinInChatMessage: { key: { ...target, fromMe: true }, type: 1, senderTimestampMs: 1_700_000_000_000 },
});
const NO_MESSAGE_OF_ITS_OWN = [
  ['an encrypted edit', { secretEncryptedMessage: { targetMessageKey: target, ...sealed, secretEncType: 2 } }],
  ['an encrypted reaction', { encReactionMessage: { targetMessageKey: target, ...sealed } }],
  ['an in-chat pin', pinOf()],
  [
    'a keep-in-chat toggle',
    { keepInChatMessage: { key: { ...target, fromMe: true }, keepType: 1, timestampMs: 1_700_000_000_000 } },
  ],
  ['an album header', { albumMessage: { expectedImageCount: 2, expectedVideoCount: 0 } }],
  ['an event answer', { encEventResponseMessage: { eventCreationMessageKey: target, ...sealed } }],
  ['an encrypted comment', { encCommentMessage: { targetMessageKey: target, ...sealed } }],
];

/** A session that held a chat with PEER and was told by the phone that the chat was deleted. */
async function withDeletedChat(t, { chatStateStore = new FakeChatStateStore(), unarchiveChats = false } = {}) {
  const session = await startSession(t, { chatStateStore, unarchiveChats });
  const { adapter, sock } = session;
  await deliver(sock, wireMessage({ id: 'OLD1', at: now() - 3600, message: { conversation: 'an old message' } }));
  await until(() => adapter.sessionStore.lastInboundMessage(CHAT) !== null, 'the old message to be recorded');
  sock.ev.emit('chats.delete', [PEER]);
  assert.deepEqual(await adapter.getChats(), []);
  return { ...session, chatStateStore };
}

/** What a restart of the session lists: a new adapter over the same chat-state table and the same stored messages. */
async function restarted(t, chatStateStore) {
  const session = await startSession(t, { chatStateStore });
  session.adapter.sessionStore.seedStoredPreviews([
    { chatId: CHAT, id: 'OLD1', fromMe: false, timestamp: now() - 3600, body: 'an old message', type: 'text' },
  ]);
  return session.adapter.getChats();
}

for (const [label, message] of NO_MESSAGE_OF_ITS_OWN) {
  for (const unarchiveChats of [true, false]) {
    test(`a chat deleted on the phone stays out of the chat list when ${label} arrives from a contact, with the unarchive setting ${unarchiveChats ? 'on' : 'off'}`, async t => {
      const { adapter, sock } = await withDeletedChat(t, { unarchiveChats });
      await deliver(sock, wireMessage({ id: 'NEW1', at: now() + 5, message }));
      assert.deepEqual(await adapter.getChats(), []);
      assert.equal(typeof adapter.sessionStore.chatDeletedAt(CHAT), 'number', 'the deletion mark is kept');
    });
  }

  test(`a chat deleted on the phone stays out of the chat list after a restart when ${label} arrived from a contact`, async t => {
    const { sock, chatStateStore } = await withDeletedChat(t);
    await deliver(sock, wireMessage({ id: 'NEW1', at: now() + 5, message }));
    assert.deepEqual(await restarted(t, chatStateStore), []);
  });

  test(`a chat deleted on the phone stays out of the chat list when ${label} arrives from another device of the account`, async t => {
    const { adapter, sock } = await withDeletedChat(t);
    await deliver(sock, wireMessage({ id: 'NEW1', at: now() + 5, fromMe: true, message }));
    assert.deepEqual(await adapter.getChats(), []);
  });

  // With the account's unarchive setting on, Baileys adds `archived: false, readOnly: false` to the update of such a
  // message, which names no chat: the chat the session never saw is not listed either way.
  for (const unarchiveChats of [false, true]) {
    for (const fromMe of [false, true]) {
      test(`a chat the session does not know is not listed when ${label} arrives from ${fromMe ? 'another device of the account' : 'a contact'}, with the unarchive setting ${unarchiveChats ? 'on' : 'off'}`, async t => {
        const { adapter, sock } = await startSession(t, { chatStateStore: new FakeChatStateStore(), unarchiveChats });
        await deliver(sock, wireMessage({ id: 'NEW1', at: now() + 5, fromMe, message }));
        assert.deepEqual(await adapter.getChats(), []);
      });
    }
  }

  test(`a chat the session knows is listed as it was when ${label} arrives from a contact`, async t => {
    const { adapter, sock } = await startSession(t, { chatStateStore: new FakeChatStateStore() });
    await deliver(sock, wireMessage({ id: 'OLD1', at: now() - 3600, message: { conversation: 'an old message' } }));
    await until(async () => (await listed(adapter))?.lastMessage === 'an old message', 'the old message to be listed');
    const before = await listed(adapter);
    await deliver(sock, wireMessage({ id: 'NEW1', at: now() + 5, message }));
    assert.deepEqual(await listed(adapter), before);
  });
}

// Controls: the same flow leaves a deleted chat out for a plain reaction and brings it back for a message of its own.
test('a chat deleted on the phone stays out of the chat list when a plain reaction arrives', async t => {
  const { adapter, sock } = await withDeletedChat(t);
  const reaction = { reactionMessage: { key: { ...target, fromMe: true }, text: String.fromCodePoint(0x1f44d) } };
  await deliver(sock, wireMessage({ id: 'NEW1', at: now() + 5, message: reaction }));
  assert.deepEqual(await adapter.getChats(), []);
});

test('a chat deleted on the phone is listed again when a text message arrives', async t => {
  const { adapter, sock } = await withDeletedChat(t);
  await deliver(sock, wireMessage({ id: 'NEW1', at: now() + 5, message: { conversation: 'hello again' } }));
  assert.equal((await listed(adapter)).unreadCount, 1);
});

test('a chat deleted on the phone is listed again when a text message arrives from another device of the account', async t => {
  const { adapter, sock } = await withDeletedChat(t);
  await deliver(
    sock,
    wireMessage({ id: 'NEW1', at: now() + 5, fromMe: true, message: { conversation: 'from my tablet' } }),
  );
  await until(async () => (await listed(adapter)) !== undefined, 'the chat to be listed again');
});

test('a chat deleted on the phone is listed again when a text message and a pin arrive in one flush', async t => {
  const { adapter, sock } = await withDeletedChat(t);
  const at = now() + 5;
  await deliverTogether(sock, [
    wireMessage({ id: 'TEXT1', at, message: { conversation: 'hello again' } }),
    wireMessage({ id: 'PIN1', at: at + 1, message: pinOf() }),
  ]);
  assert.equal((await listed(adapter)).unreadCount, 2, 'the library counts both and the filter leaves the sum alone');
});

// Several messages of no content for one chat in one flush, as the offline queue delivers them after a reconnect: the
// library adds their counts, and emits the chat update before the messages, so the adapter settles the update with the
// messages of the flush. Only messages of no content in the flush, as many as the count: the update holds none of its own.
const pinAt = (id, at) => wireMessage({ id, at, message: pinOf() });
const reactionAt = (id, at) =>
  wireMessage({ id, at, message: { encReactionMessage: { targetMessageKey: target, ...sealed } } });

test('a chat the session does not know is not listed when two pins arrive in one flush', async t => {
  const { adapter, sock } = await startSession(t, { chatStateStore: new FakeChatStateStore() });
  const at = now() + 5;
  await deliverTogether(sock, [pinAt('P1', at), pinAt('P2', at + 1)]);
  assert.deepEqual(await adapter.getChats(), []);
});

test('a chat deleted on the phone stays out of the chat list when a pin and an encrypted reaction arrive in one flush', async t => {
  const { adapter, sock } = await withDeletedChat(t);
  const at = now() + 5;
  await deliverTogether(sock, [pinAt('P1', at), reactionAt('R1', at + 1), pinAt('P2', at + 2)]);
  assert.deepEqual(await adapter.getChats(), []);
  assert.equal(typeof adapter.sessionStore.chatDeletedAt(CHAT), 'number', 'the deletion mark is kept');
});

test('a chat the session knows is listed as it was when two pins arrive in one flush', async t => {
  const { adapter, sock } = await startSession(t, { chatStateStore: new FakeChatStateStore() });
  await deliver(sock, wireMessage({ id: 'OLD1', at: now() - 3600, message: { conversation: 'an old message' } }));
  await until(async () => (await listed(adapter))?.lastMessage === 'an old message', 'the old message to be listed');
  const before = await listed(adapter);
  const at = now() + 5;
  await deliverTogether(sock, [pinAt('P1', at), pinAt('P2', at + 1)]);
  assert.deepEqual(await listed(adapter), before);
});

// The library lowers the sum of a flush for a message the account read on another device (the count is gone when it
// reaches zero) and replaces it for an unread mark. The chat still holds no message of its own: the pins do not date it.
test('a chat deleted on the phone stays out of the chat list when the account read one of three pins in one flush', async t => {
  const { adapter, sock } = await withDeletedChat(t);
  const at = now() + 5;
  const first = pinAt('P1', at);
  await deliverTogether(sock, [first, pinAt('P2', at + 1), pinAt('P3', at + 2)], { flush: false });
  sock.ev.emit('messages.update', [{ key: first.key, update: { status: 4 } }]);
  sock.ev.flush();
  await settled();
  assert.deepEqual(await adapter.getChats(), []);
});

test('a chat deleted on the phone stays out of the chat list when the account read its only pin in the same flush', async t => {
  const { adapter, sock } = await withDeletedChat(t);
  const at = now() + 5;
  const only = pinAt('P1', at);
  await deliverTogether(sock, [only], { flush: false });
  sock.ev.emit('messages.update', [{ key: only.key, update: { status: 4 } }]);
  sock.ev.flush();
  await settled();
  assert.deepEqual(await adapter.getChats(), []);
});

test('a chat deleted on the phone stays out of the chat list when an unread mark follows two pins in one flush', async t => {
  const { adapter, sock } = await withDeletedChat(t);
  const at = now() + 5;
  await deliverTogether(sock, [pinAt('P1', at), pinAt('P2', at + 1)], { flush: false });
  sock.ev.emit('chats.update', [{ id: PEER, unreadCount: -1 }]);
  sock.ev.flush();
  await settled();
  assert.deepEqual(await adapter.getChats(), []);
});

test('a chat the session knows keeps its time and takes an unread mark that follows two pins in one flush', async t => {
  const { adapter, sock } = await startSession(t, { chatStateStore: new FakeChatStateStore() });
  await deliver(sock, wireMessage({ id: 'OLD1', at: now() - 3600, message: { conversation: 'an old message' } }));
  await until(async () => (await listed(adapter))?.lastMessage === 'an old message', 'the old message to be listed');
  const before = await listed(adapter);
  const at = now() + 5;
  await deliverTogether(sock, [pinAt('P1', at), pinAt('P2', at + 1)], { flush: false });
  sock.ev.emit('chats.update', [{ id: PEER, unreadCount: -1 }]);
  sock.ev.flush();
  await settled();
  const after = await listed(adapter);
  assert.equal(after.timestamp, before.timestamp, 'the pins do not date the chat');
  assert.equal(after.lastMessage, before.lastMessage);
  assert.equal(after.unreadCount, -1, 'the mark set on the phone is listed');
});

// A read synced from the phone in the same flush as pins: the library adds its zero to their count, so the update is
// that of the pins alone and the read is not seen. The chat keeps the count it had until the next read.
test('a read synced from the phone in the same flush as two pins is not seen', async t => {
  const { adapter, sock } = await startSession(t, { chatStateStore: new FakeChatStateStore() });
  for (const [i, id] of ['U1', 'U2', 'U3', 'U4'].entries()) {
    await deliver(sock, wireMessage({ id, at: now() - 3600 + i, message: { conversation: 'unread ' + i } }));
  }
  await until(async () => (await listed(adapter))?.lastMessage === 'unread 3', 'the texts to be listed');
  const before = (await listed(adapter)).unreadCount;
  assert.ok(before > 0, 'the chat is listed unread');
  const at = now() + 5;
  await deliverTogether(sock, [pinAt('P1', at), pinAt('P2', at + 1)], { flush: false });
  sock.ev.emit('chats.update', [{ id: PEER, unreadCount: 0 }]);
  sock.ev.flush();
  await settled();
  assert.equal((await listed(adapter)).unreadCount, before);
});

// Controls: a message of its own in the same flush may be one of the counted, so the update stays whole.
test('a chat deleted on the phone is listed again when two pins and a text message arrive in one flush', async t => {
  const { adapter, sock } = await withDeletedChat(t);
  const at = now() + 5;
  await deliverTogether(sock, [
    pinAt('P1', at),
    wireMessage({ id: 'TEXT1', at: at + 1, message: { conversation: 'hello again' } }),
    pinAt('P2', at + 2),
  ]);
  assert.equal(
    (await listed(adapter)).unreadCount,
    3,
    'the library counts all three and the filter leaves the sum alone',
  );
});

test('a chat deleted on the phone stays out of the chat list when two pins and a plain reaction arrive in one flush', async t => {
  const { adapter, sock } = await withDeletedChat(t);
  const at = now() + 5;
  const reaction = { reactionMessage: { key: { ...target, fromMe: true }, text: String.fromCodePoint(0x1f44d) } };
  await deliverTogether(sock, [
    pinAt('P1', at),
    wireMessage({ id: 'R1', at: at + 1, message: reaction }),
    pinAt('P2', at + 2),
  ]);
  assert.deepEqual(await adapter.getChats(), []);
});

test('a chat deleted on the phone is listed again when the account sends a text message and a pin in one flush', async t => {
  const { adapter, sock } = await withDeletedChat(t);
  const at = now() + 5;
  await deliverTogether(sock, [
    wireMessage({ id: 'TEXT1', at, fromMe: true, message: { conversation: 'from my tablet' } }),
    wireMessage({ id: 'PIN1', at: at + 1, fromMe: true, message: pinOf() }),
  ]);
  await until(async () => (await listed(adapter)) !== undefined, 'the text message to bring the chat back');
});

// The same for the chats that are not a person's: a group, a privacy-id chat, the sender chat of a broadcast list and the
// status chat, and for the plain reaction to the account's own message, which Baileys also answers with the pair.
const SENDER = '6281111111111@s.whatsapp.net';
const OTHER_CHATS = [
  ['a group', { chat: '120363000000000000@g.us', participant: SENDER }, pinOf()],
  ['a privacy-id chat', { chat: '99999999999999@lid' }, pinOf()],
  ['the sender chat of a broadcast list', { chat: '12345@broadcast', participant: SENDER }, pinOf()],
  [
    'the status chat',
    { chat: 'status@broadcast', participant: SENDER },
    { encReactionMessage: { targetMessageKey: { ...target, remoteJid: 'status@broadcast' }, ...sealed } },
  ],
];
for (const [label, where, message] of OTHER_CHATS) {
  test(`${label} the session does not know is not listed when a message that is none of its own arrives, with the unarchive setting on`, async t => {
    const { adapter, sock } = await startSession(t, { chatStateStore: new FakeChatStateStore(), unarchiveChats: true });
    await deliver(sock, wireMessage({ id: 'NEW1', at: now() + 5, message, ...where }));
    assert.deepEqual(await adapter.getChats(), []);
  });
}

for (const unarchiveChats of [false, true]) {
  test(`a chat the session does not know is not listed when a contact reacts to the account's own message, with the unarchive setting ${unarchiveChats ? 'on' : 'off'}`, async t => {
    const { adapter, sock } = await startSession(t, { chatStateStore: new FakeChatStateStore(), unarchiveChats });
    const reaction = { reactionMessage: { key: { ...target, fromMe: true }, text: String.fromCodePoint(0x1f44d) } };
    await deliver(sock, wireMessage({ id: 'NEW1', at: now() + 5, message: reaction }));
    assert.deepEqual(await adapter.getChats(), []);
  });
}

// Controls: the pair still unarchives a chat the session knows, whether by a record or by its persisted state alone,
// and a chat that a text brings is listed as it was.
test('an archived chat the session knows is unarchived by a contact pin, with the unarchive setting on', async t => {
  const { adapter, sock } = await startSession(t, { chatStateStore: new FakeChatStateStore(), unarchiveChats: true });
  await deliver(sock, wireMessage({ id: 'OLD1', at: now() - 3600, message: { conversation: 'an old message' } }));
  await until(async () => (await listed(adapter))?.lastMessage === 'an old message', 'the old message to be listed');
  sock.ev.emit('chats.update', [{ id: PEER, archived: true }]);
  assert.equal((await listed(adapter)).archived, true);
  await deliver(sock, wireMessage({ id: 'NEW1', at: now() + 5, message: pinOf() }));
  assert.equal((await listed(adapter)).archived, false);
});

test('an archived chat only its persisted state is known by is unarchived by a contact pin, with the unarchive setting on', async t => {
  const chatStateStore = new FakeChatStateStore();
  await chatStateStore.remember('real-session', PEER, { archived: true });
  const { adapter, sock } = await startSession(t, { chatStateStore, unarchiveChats: true });
  assert.equal((await listed(adapter)).archived, true);
  await deliver(sock, wireMessage({ id: 'NEW1', at: now() + 5, message: pinOf() }));
  assert.equal((await listed(adapter)).archived, false);
  assert.equal((await listed(adapter)).timestamp, 0, 'the pin dates nothing');
});

test('a chat the session does not know is listed when a text message arrives, with the unarchive setting on', async t => {
  const { adapter, sock } = await startSession(t, { chatStateStore: new FakeChatStateStore(), unarchiveChats: true });
  await deliver(sock, wireMessage({ id: 'NEW1', at: now() + 5, message: { conversation: 'hello' } }));
  assert.equal((await listed(adapter)).unreadCount, 1);
});

// A history chunk (or an upsert) of the chat that the event buffer holds while the message is processed: the library merges
// the message's chat update into the chunk, so the chat reaches the adapter through messaging-history.set, with the
// message as its last, and the message's time unless the chunk reached the buffer after it and has a time of its own.
// Fixed for the run: an assertion that reads the clock again would be a second late.
const SEEN_AT = now() - 7200;
const CHUNK_AT = now() - 3500;
const chunkOf = (at, unreadCount = 0) => ({
  chats: [{ id: PEER, ...(at === undefined ? {} : { conversationTimestamp: at }), unreadCount }],
  contacts: [],
  messages: [],
  syncType: 1,
  isLatest: true,
  progress: 50,
  chunkOrder: 1,
});

async function mergedIntoChunk(sock, wm, { chunkAt, unreadCount = 0, messageFirst = false }) {
  sock.ev.buffer();
  if (messageFirst) await deliverTogether(sock, [wm], { flush: false });
  sock.ev.emit('messaging-history.set', chunkOf(chunkAt, unreadCount));
  if (!messageFirst) await deliverTogether(sock, [wm], { flush: false });
  sock.ev.flush();
  await settled();
}

const MERGES = [
  ['after the chunk', { messageFirst: false, chunkAt: CHUNK_AT }],
  ['before a chunk that has a time', { messageFirst: true, chunkAt: CHUNK_AT }],
  ['before a chunk that has no time', { messageFirst: true, chunkAt: undefined }],
];

for (const [label, message] of NO_MESSAGE_OF_ITS_OWN) {
  for (const [when, merge] of MERGES) {
    test(`a chat deleted on the phone stays out of the chat list when ${label} from a contact is merged into a history chunk of it, arriving ${when}`, async t => {
      const { adapter, sock } = await withDeletedChat(t);
      await mergedIntoChunk(sock, wireMessage({ id: 'NEW1', at: now() + 5, message }), merge);
      assert.deepEqual(await adapter.getChats(), []);
      assert.equal(typeof adapter.sessionStore.chatDeletedAt(CHAT), 'number', 'the deletion mark is kept');
    });
  }

  test(`a chat the session knows keeps its time and its last message when ${label} from a contact is merged into a history chunk of it`, async t => {
    const { adapter, sock } = await startSession(t, { chatStateStore: new FakeChatStateStore() });
    // Known by a chat update alone, so the listing takes its time from the chat record, not from a stored message.
    sock.ev.emit('chats.update', [{ id: PEER, conversationTimestamp: SEEN_AT, unreadCount: 0 }]);
    assert.equal((await listed(adapter)).timestamp, SEEN_AT);
    await mergedIntoChunk(sock, wireMessage({ id: 'NEW1', at: now() + 5, message }), MERGES[0][1]);
    const chat = await listed(adapter);
    assert.equal(chat.timestamp, SEEN_AT, 'the time of the message is not the chat time');
    assert.equal(chat.lastMessage, undefined);
  });

  test(`a chat the session knows takes the time of a history chunk that reached the buffer after ${label} from a contact`, async t => {
    const { adapter, sock } = await startSession(t, { chatStateStore: new FakeChatStateStore() });
    sock.ev.emit('chats.update', [{ id: PEER, conversationTimestamp: SEEN_AT, unreadCount: 0 }]);
    await mergedIntoChunk(sock, wireMessage({ id: 'NEW1', at: now() + 5, message }), MERGES[1][1]);
    assert.equal((await listed(adapter)).timestamp, CHUNK_AT, 'the chunk keeps its own time');
  });
}

// Two such messages merged into the same chunk: the chunk then counts both, and the flush's messages say they are all it counts.
for (const [when, merge] of MERGES) {
  test(`a chat deleted on the phone stays out of the chat list when two pins from a contact are merged into a history chunk of it, arriving ${when}`, async t => {
    const { adapter, sock } = await withDeletedChat(t);
    const at = now() + 5;
    sock.ev.buffer();
    if (merge.messageFirst) await deliverTogether(sock, [pinAt('P1', at), pinAt('P2', at + 1)], { flush: false });
    sock.ev.emit('messaging-history.set', chunkOf(merge.chunkAt));
    if (!merge.messageFirst) await deliverTogether(sock, [pinAt('P1', at), pinAt('P2', at + 1)], { flush: false });
    sock.ev.flush();
    await settled();
    assert.deepEqual(await adapter.getChats(), []);
    assert.equal(typeof adapter.sessionStore.chatDeletedAt(CHAT), 'number', 'the deletion mark is kept');
  });
}

test('a chat the session knows keeps its time and its last message when two pins from a contact are merged into a history chunk of it', async t => {
  const { adapter, sock } = await startSession(t, { chatStateStore: new FakeChatStateStore() });
  sock.ev.emit('chats.update', [{ id: PEER, conversationTimestamp: SEEN_AT, unreadCount: 0 }]);
  const at = now() + 5;
  sock.ev.buffer();
  sock.ev.emit('messaging-history.set', chunkOf(CHUNK_AT));
  await deliverTogether(sock, [pinAt('P1', at), pinAt('P2', at + 1)], { flush: false });
  sock.ev.flush();
  await settled();
  const chat = await listed(adapter);
  assert.equal(chat.timestamp, SEEN_AT, 'the time of the pins is not the chat time');
  assert.equal(chat.lastMessage, undefined);
});

// A first-sync chunk (or a history fetch) of a chat the session holds nothing else of: the chunk's time is that of its last
// message, which is none of its own, and it is the only time the phone gave the chat. It is listed with it, without a preview.
const HISTORY_KINDS = [
  ['an in-chat pin', { pinInChatMessage: { type: 1, senderTimestampMs: 1 } }],
  ['a keep-in-chat toggle', { keepInChatMessage: { key: { ...target, fromMe: true }, keepType: 1, timestampMs: 1 } }],
  ['an album header', { albumMessage: { expectedImageCount: 2, expectedVideoCount: 0 } }],
  ['an encrypted reaction', { encReactionMessage: { targetMessageKey: target, ...sealed } }],
];
const firstSync = (chat, messages) => ({
  chats: [chat],
  contacts: [],
  messages,
  syncType: 1,
  isLatest: true,
  progress: 100,
  chunkOrder: 1,
});

for (const [label, message] of HISTORY_KINDS) {
  for (const [who, fromMe, unreadCount] of [
    ['a contact', false, 1],
    ['the account', true, 0],
  ]) {
    test(`a first-sync chunk whose only message is ${label} from ${who} is listed at the time the phone gave it, with no preview`, async t => {
      const { adapter, sock } = await startSession(t, { chatStateStore: new FakeChatStateStore() });
      const last = wireMessage({ id: 'P1', at: SEEN_AT, message, fromMe });
      sock.ev.emit(
        'messaging-history.set',
        firstSync({ id: PEER, conversationTimestamp: SEEN_AT, unreadCount, messages: [{ message: last }] }, [last]),
      );
      const chat = await listed(adapter);
      assert.equal(chat.timestamp, SEEN_AT);
      assert.equal(chat.lastMessage, undefined, 'the message is not the preview');
      assert.equal(chat.unreadCount, unreadCount, 'the count is as it was');
    });
  }
}

test('a first-sync chunk whose last message is a pin and which holds a text before it is listed with that text and its time', async t => {
  const { adapter, sock } = await startSession(t, { chatStateStore: new FakeChatStateStore() });
  const text = wireMessage({ id: 'TEXT1', at: SEEN_AT - 600, message: { conversation: 'the text' } });
  const pin = wireMessage({ id: 'PIN1', at: SEEN_AT, message: pinOf() });
  sock.ev.emit(
    'messaging-history.set',
    firstSync({ id: PEER, conversationTimestamp: SEEN_AT, unreadCount: 1, messages: [{ message: pin }] }, [text, pin]),
  );
  await until(async () => (await listed(adapter))?.lastMessage === 'the text', 'the text to be listed');
  assert.equal((await listed(adapter)).timestamp, SEEN_AT - 600, 'the pin dates nothing');
});

// Controls: a message of its own, merged into the same chunk, is the chat's last message and brings the chat back.
test('a chat deleted on the phone is listed again when a text from a contact is merged into a history chunk of it', async t => {
  const { adapter, sock } = await withDeletedChat(t);
  await mergedIntoChunk(sock, wireMessage({ id: 'NEW1', at: now() + 5, message: { conversation: 'hello again' } }), {
    ...MERGES[0][1],
  });
  assert.equal((await listed(adapter)).unreadCount, 1);
});

test('a chat deleted on the phone is listed again when a text and then a pin from a contact are merged into a history chunk of it', async t => {
  const { adapter, sock } = await withDeletedChat(t);
  const at = now() + 5;
  await mergedIntoChunk(sock, wireMessage({ id: 'TEXT1', at, message: { conversation: 'hello again' } }), {
    ...MERGES[0][1],
  });
  assert.ok(await listed(adapter), 'the text brings the chat back');
  await deliver(sock, wireMessage({ id: 'PIN1', at: at + 1, message: pinOf() }));
  assert.equal((await listed(adapter)).lastMessage, 'hello again', 'the pin is not the last message');
});

// Only a chat that counts exactly that one message is recognised, as for a live update: a larger count may hold a message of
// its own, whose count must not go with the pin's time (the text of this flush is recorded after the chunk is applied).
test('a chat deleted on the phone is listed again, unread, when a text and then a pin are merged into one history chunk of it', async t => {
  const { adapter, sock } = await withDeletedChat(t);
  const at = now() + 5;
  sock.ev.buffer();
  sock.ev.emit('messaging-history.set', chunkOf(CHUNK_AT));
  await deliverTogether(
    sock,
    [
      wireMessage({ id: 'TEXT1', at, message: { conversation: 'hello again' } }),
      wireMessage({ id: 'PIN1', at: at + 1, message: pinOf() }),
    ],
    { flush: false },
  );
  sock.ev.flush();
  await settled();
  await until(async () => (await listed(adapter)) !== undefined, 'the text to bring the chat back');
  assert.equal((await listed(adapter)).unreadCount, 2, 'the library counts both and the filter leaves the sum alone');
});

test('a chat deleted on the phone is listed again, unread, when a pin and then a text are merged into one history chunk of it', async t => {
  const { adapter, sock } = await withDeletedChat(t);
  const at = now() + 5;
  sock.ev.buffer();
  sock.ev.emit('messaging-history.set', chunkOf(CHUNK_AT));
  await deliverTogether(
    sock,
    [
      wireMessage({ id: 'PIN1', at, message: pinOf() }),
      wireMessage({ id: 'TEXT1', at: at + 1, message: { conversation: 'hello again' } }),
    ],
    { flush: false },
  );
  sock.ev.flush();
  await settled();
  await until(async () => (await listed(adapter)) !== undefined, 'the text to bring the chat back');
  assert.equal((await listed(adapter)).unreadCount, 2);
});

// A contact's text and then a pin of the account, in one chunk: the chunk's one count is the text's, not the pin's, so the
// chunk is left whole, and the text brings the deleted chat back.
test('a chat deleted on the phone is listed again, unread, when a text from a contact and then a pin of the account are merged into one history chunk of it', async t => {
  const { adapter, sock } = await withDeletedChat(t);
  const at = now() + 5;
  sock.ev.buffer();
  sock.ev.emit('messaging-history.set', chunkOf(CHUNK_AT));
  await deliverTogether(
    sock,
    [
      wireMessage({ id: 'TEXT1', at, message: { conversation: 'hello again' } }),
      wireMessage({ id: 'PIN1', at: at + 1, fromMe: true, message: pinOf() }),
    ],
    { flush: false },
  );
  sock.ev.flush();
  await settled();
  await until(async () => (await listed(adapter)) !== undefined, 'the text to bring the chat back');
  assert.equal((await listed(adapter)).unreadCount, 1);
});

// The one thing a merged chat cannot be cleaned of: its count is the chunk's count plus every update the library merged
// into it, and nothing in the chat says how many of those were none of its own. This pins that limit.
test('the count a pin adds to a history chunk of a chat stays in the chunk', async t => {
  const { adapter, sock } = await startSession(t, { chatStateStore: new FakeChatStateStore() });
  sock.ev.emit('chats.update', [{ id: PEER, conversationTimestamp: SEEN_AT, unreadCount: 0 }]);
  await mergedIntoChunk(sock, wireMessage({ id: 'NEW1', at: now() + 5, message: pinOf() }), MERGES[0][1]);
  assert.equal((await listed(adapter)).unreadCount, 1);
});

// A chat deleted while a history sync runs stays out for the chunks of that sync and for a pin, and a text brings it back.
for (const sameFlush of [true, false]) {
  test(`a chat deleted ${sameFlush ? 'in the same buffer as its history chunk' : 'in a later flush than its history chunk'} stays out for a pin and is listed again for a text`, async t => {
    const { adapter, sock } = await startSession(t, { chatStateStore: new FakeChatStateStore() });
    sock.ev.buffer();
    sock.ev.emit('messaging-history.set', chunkOf(SEEN_AT, 2));
    if (sameFlush) {
      sock.ev.emit('chats.delete', [PEER]);
      sock.ev.flush();
      await settled();
    } else {
      sock.ev.flush();
      await settled();
      await until(async () => (await listed(adapter)) !== undefined, 'the history chat to be listed');
      sock.ev.emit('chats.delete', [PEER]);
    }
    assert.equal(await listed(adapter), undefined, 'the deleted chat is not listed');
    // A second chunk that still carries the chat, from before its deletion.
    sock.ev.buffer();
    sock.ev.emit('messaging-history.set', chunkOf(SEEN_AT + 100, 2));
    sock.ev.flush();
    await settled();
    assert.equal(await listed(adapter), undefined, 'a later chunk of the history does not bring it back');
    await deliver(sock, wireMessage({ id: 'PIN1', at: now() + 2, message: pinOf() }));
    assert.equal(await listed(adapter), undefined, 'a contact pin does not bring it back');
    await deliver(sock, wireMessage({ id: 'NEW1', at: now() + 4, message: { conversation: 'hello again' } }));
    await until(async () => (await listed(adapter)) !== undefined, 'a text to bring the chat back');
    assert.equal((await listed(adapter)).unreadCount, 1);
  });
}

test('the library merges what one flush carries into one update, and the filter reads its last message', async () => {
  // The premise the cases above rely on: after a text and a pin the buffer hands over ONE update, of the pin.
  const ev = lib.makeEventBuffer(quiet);
  const flushed = [];
  ev.on('chats.update', updates => flushed.push(...updates));
  ev.buffer();
  ev.emit('chats.update', [
    { id: PEER, unreadCount: 1, conversationTimestamp: 10, messages: [{ message: { key: { id: 'A' } } }] },
  ]);
  ev.emit('chats.update', [
    { id: PEER, unreadCount: 1, conversationTimestamp: 11, messages: [{ message: { key: { id: 'B' } } }] },
  ]);
  ev.flush();
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].unreadCount, 2);
  assert.equal(flushed[0].messages[0].message.key.id, 'B');
});
