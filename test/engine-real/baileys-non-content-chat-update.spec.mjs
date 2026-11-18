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

  test(`a chat the session does not know is not listed when ${label} arrives from a contact`, async t => {
    const { adapter, sock } = await startSession(t, { chatStateStore: new FakeChatStateStore() });
    await deliver(sock, wireMessage({ id: 'NEW1', at: now() + 5, message }));
    assert.deepEqual(await adapter.getChats(), []);
  });

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

test('a chat deleted on the phone is listed again when the account sends a text message and a pin in one flush', async t => {
  const { adapter, sock } = await withDeletedChat(t);
  const at = now() + 5;
  await deliverTogether(sock, [
    wireMessage({ id: 'TEXT1', at, fromMe: true, message: { conversation: 'from my tablet' } }),
    wireMessage({ id: 'PIN1', at: at + 1, fromMe: true, message: pinOf() }),
  ]);
  await until(async () => (await listed(adapter)) !== undefined, 'the text message to bring the chat back');
});

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
