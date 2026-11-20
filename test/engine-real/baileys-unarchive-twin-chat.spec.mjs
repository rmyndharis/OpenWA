// A chat the session holds under one spelling of its id gets updates under the other spelling: WhatsApp indexes a
// lid-migrated contact's pin, mute and archive by its lid, a disappearing-messages timer comes under the spelling of
// the message that changed it, and Baileys writes its unarchive pair for a message that is none of its own. Through the
// real library's event buffer and the compiled adapter: an update that names no time and no message adds no row beside
// the chat's own, and its state shows on that row.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAT, FakeChatStateStore, PEER, deliver, lib, startSession, wireMessage } from './support/baileys-session.mjs';

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

for (const [label, update, shown] of [
  ['a pin', { pinned: now() }, { pinned: true }],
  ['a mute', { muteEndTime: -1 }, { muted: true }],
  ['an archive', { archived: true }, { archived: true }],
  ['a read mark', { unreadCount: -1 }, { unreadCount: -1 }],
  ['a timer change', { ephemeralExpiration: 86400, ephemeralSettingTimestamp: now() }, {}],
]) {
  for (const [held, other] of [
    [PEER, LID],
    [LID, PEER],
  ]) {
    const heldAs = held === LID ? 'lid' : 'phone';
    const otherAs = held === LID ? 'phone' : 'lid';
    test(`${label} synced under the ${otherAs} spelling of a chat known under the ${heldAs} spelling shows on its one row`, async t => {
      const { adapter, sock } = await startSession(t, { chatStateStore: new FakeChatStateStore() });
      const at = now() - 3600;
      sock.ev.emit('chats.update', [{ id: held, conversationTimestamp: at, unreadCount: 0 }]);
      sock.ev.emit('lid-mapping.update', { lid: LID, pn: PEER });
      sock.ev.emit('chats.update', [{ id: other, ...update }]);
      sock.ev.flush();

      const rows = await adapter.getChats();
      assert.deepEqual(
        rows.map(chat => [chat.id, chat.timestamp]),
        [[held === LID ? LID : CHAT, at]],
      );
      for (const [field, value] of Object.entries(shown)) assert.equal(rows[0][field], value, field);
    });
  }
}

test('a timer a contact turns on under the lid spelling of a chat known under the phone spelling lists no second row', async t => {
  const { adapter, sock } = await startSession(t, { chatStateStore: new FakeChatStateStore() });
  sock.ev.emit('chats.update', [{ id: PEER, conversationTimestamp: now() - 3600, unreadCount: 0 }]);
  sock.ev.emit('lid-mapping.update', { lid: LID, pn: PEER });
  const before = (await adapter.getChats()).map(chat => chat.id);
  const setting = { type: lib.proto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING, ephemeralExpiration: 86400 };

  await deliver(sock, wireMessage({ id: 'EPH1', chat: LID, at: now() + 5, message: { protocolMessage: setting } }));

  assert.deepEqual(
    (await adapter.getChats()).map(chat => chat.id),
    before,
  );
});
