// The pair Baileys writes for a message that is none of its own, when the account unarchives on a new message, comes
// under the other spelling of the id of a chat the session holds under one spelling only. Through the real library's
// event buffer and the compiled adapter: the pair names no time and no message, so it adds no row beside the chat's own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeChatStateStore, PEER, deliver, startSession, wireMessage } from './support/baileys-session.mjs';

const LID = '99999999999999@lid';
const now = () => Math.floor(Date.now() / 1000);
const target = { id: 'OLD1', remoteJid: PEER, fromMe: false };
const pin = { pinInChatMessage: { key: { ...target, fromMe: true }, type: 1, senderTimestampMs: 1_700_000_000_000 } };
const reactionToOwn = { reactionMessage: { key: { ...target, remoteJid: LID, fromMe: true }, text: 'x' } };

for (const [label, message] of [
  ['an in-chat pin', pin],
  ['a plain reaction to the own message', reactionToOwn],
]) {
  test(`${label} under the lid spelling of a chat known under the phone spelling lists no second row`, async t => {
    const { adapter, sock } = await startSession(t, { chatStateStore: new FakeChatStateStore(), unarchiveChats: true });
    sock.ev.emit('chats.update', [{ id: PEER, conversationTimestamp: now() - 3600, unreadCount: 0 }]);
    sock.ev.emit('lid-mapping.update', { lid: LID, pn: PEER });
    const before = (await adapter.getChats()).map(chat => chat.id);

    await deliver(sock, wireMessage({ id: 'NEW1', chat: LID, at: now() + 5, message }));

    assert.equal(before.length, 1);
    assert.deepEqual(
      (await adapter.getChats()).map(chat => chat.id),
      before,
    );
  });
}
