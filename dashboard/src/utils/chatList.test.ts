import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyIncomingToChatList, promoteChatWithSnippet, type ChatListEntry } from './chatList.ts';

const chat = (id: string, over: Partial<ChatListEntry> = {}): ChatListEntry => ({
  id,
  lastMessage: 'old',
  timestamp: 100,
  ...over,
});

const LOCATION = '📍 Location';

test('an arriving message moves its chat to the top and refreshes the snippet', () => {
  const before = [chat('a@c.us'), chat('b@c.us')];

  const { chats, needsSidebarRefetch } = applyIncomingToChatList(
    before,
    { chatId: 'b@c.us', body: 'hi', type: 'text', timestamp: 200 },
    { locationLabel: LOCATION },
  );

  assert.equal(needsSidebarRefetch, false);
  assert.deepEqual(
    chats.map(c => c.id),
    ['b@c.us', 'a@c.us'],
  );
  assert.equal(chats[0].lastMessage, 'hi');
  assert.equal(chats[0].timestamp, 200);
  assert.deepEqual(
    before.map(c => c.id),
    ['a@c.us', 'b@c.us'],
    'input is not mutated',
  );
});

test('a location message shows the label, never its base64 body', () => {
  const { chats } = applyIncomingToChatList(
    [chat('a@c.us')],
    { chatId: 'a@c.us', body: 'data:image/jpeg;base64,AAAA…', type: 'location', timestamp: 200 },
    { locationLabel: LOCATION },
  );

  assert.equal(chats[0].lastMessage, LOCATION);
});

test('unread increments only for an incoming message in a chat that is not open', () => {
  const incomingElsewhere = applyIncomingToChatList(
    [chat('a@c.us', { unreadCount: 2 })],
    { chatId: 'a@c.us', body: 'hi', timestamp: 200 },
    { activeChatId: 'b@c.us', locationLabel: LOCATION },
  );
  assert.equal(incomingElsewhere.chats[0].unreadCount, 3);

  const incomingOnScreen = applyIncomingToChatList(
    [chat('a@c.us', { unreadCount: 2 })],
    { chatId: 'a@c.us', body: 'hi', timestamp: 200 },
    { activeChatId: 'a@c.us', locationLabel: LOCATION },
  );
  assert.equal(incomingOnScreen.chats[0].unreadCount, 2);

  const ownSend = applyIncomingToChatList(
    [chat('a@c.us', { unreadCount: 2 })],
    { chatId: 'a@c.us', body: 'hi', timestamp: 200, fromMe: true },
    { activeChatId: 'b@c.us', locationLabel: LOCATION },
  );
  assert.equal(ownSend.chats[0].unreadCount, 2);
});

test('an unknown chat asks for a refetch, and leaves the list alone', () => {
  const before = [chat('a@c.us')];

  const { chats, needsSidebarRefetch } = applyIncomingToChatList(
    before,
    { chatId: 'new@c.us', body: 'hi', timestamp: 200 },
    { locationLabel: LOCATION },
  );

  assert.equal(needsSidebarRefetch, true);
  assert.equal(chats, before);
});

test('a LID-migrated own-send echo does NOT ask for a refetch (#583 R2)', () => {
  // The user sent to @c.us; the contact echoes back @lid. The bubble is already reconciled in the
  // open chat, so refetching on every such send only churns the sidebar.
  const { needsSidebarRefetch } = applyIncomingToChatList(
    [chat('a@c.us')],
    { chatId: '628111@lid', body: 'hi', timestamp: 200, fromMe: true },
    { locationLabel: LOCATION },
  );

  assert.equal(needsSidebarRefetch, false);
});

test('an INCOMING message from an unknown @lid chat still asks for a refetch', () => {
  // The suppression is scoped to own-send echoes; a genuinely new inbound chat must appear.
  const { needsSidebarRefetch } = applyIncomingToChatList(
    [chat('a@c.us')],
    { chatId: '628111@lid', body: 'hi', timestamp: 200, fromMe: false },
    { locationLabel: LOCATION },
  );

  assert.equal(needsSidebarRefetch, true);
});

test('promoteChatWithSnippet moves the sent-into chat to the top', () => {
  const before = [chat('a@c.us'), chat('b@c.us')];

  const after = promoteChatWithSnippet(before, 'b@c.us', '[image]', 999);

  assert.deepEqual(
    after.map(c => c.id),
    ['b@c.us', 'a@c.us'],
  );
  assert.equal(after[0].lastMessage, '[image]');
  assert.equal(after[0].timestamp, 999);
  assert.deepEqual(
    before.map(c => c.id),
    ['a@c.us', 'b@c.us'],
    'input is not mutated',
  );
});

test('promoteChatWithSnippet leaves an unknown chat alone rather than inventing a row', () => {
  const before = [chat('a@c.us')];

  assert.equal(promoteChatWithSnippet(before, 'gone@c.us', 'x', 1), before);
});
