import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import { BaileysContacts, type BaileysContactsHost } from './baileys-contacts';
import { BaileysSessionStore } from './baileys-session-store';

/**
 * A read of a chat on Baileys sends the receipt, resets the session's unread count when the receipt names the
 * newest message received, and undoes an unread mark set by hand with a second write to the account's app state.
 * Both halves run against the real session store, fed the way Baileys feeds it: a message received arrives as a
 * `chats.update` whose `unreadCount` is an increment of 1, and an own app-state write is replayed as a `chats.update`
 * with an absolute zero for the record it was keyed to.
 */
const PHONE = '628111@s.whatsapp.net';
const LID = '484848@lid';
const CHAT = '628111@c.us';

const inbound = (id: string, timestamp: number, remoteJid = PHONE): WAMessage => ({
  key: { remoteJid, fromMe: false, id },
  message: { conversation: id },
  messageTimestamp: timestamp,
});

/**
 * Contacts wired to the real store, as the adapter wires it, with a socket whose two writes the test controls.
 * `pending` is what the events layer would list as received and still being processed.
 */
function wire(socket: Record<string, jest.Mock>) {
  const store = new BaileysSessionStore();
  const pending: Array<{ chatJid: string; id: string; timestamp: number; order: number }> = [];
  const logger = { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() };
  const host = {
    ensureReady: () => undefined,
    logger,
    getSocket: () => socket as unknown as WASocket,
    findPersistedLidPhone: () => Promise.resolve(null),
    getStoredMessages: () => Promise.resolve([]),
    toEngineJid: (jid: string) => store.toEngineJid(jid),
    toNeutralJid: (jid: string) => store.toNeutralJid(jid),
    chatJid: (jid: string) => store.chatJid(jid),
    resolvePhone: (jid: string) => store.resolvePhone(jid),
    chatTwins: (jid: string) => store.chatTwins(jid),
    lidOf: (jid: string) => store.lidOf(jid),
    listChats: () => store.listChats(),
    lastMessage: (chatId: string) => store.lastMessage(chatId),
    lastInboundMessage: (chatId: string) => store.lastInboundMessage(chatId),
    hasUnrecordedInbound: (chatId: string) => store.followsLastInbound(chatId, pending),
    isMarkedUnread: (chatId: string) => store.isMarkedUnread(chatId),
    clearUnread: (chatId: string, marks?: boolean) => store.clearUnread(chatId, marks),
    keepUnread: (chatId: string) => store.keepUnread(chatId),
    chatDeletedAt: (chatId: string) => store.chatDeletedAt(chatId),
  } as unknown as BaileysContactsHost;
  return { store, pending, logger, contacts: new BaileysContacts(host, 500) };
}

/** The count each row of the chat list carries, by the id it is listed under. */
const counts = (store: BaileysSessionStore): Record<string, number | undefined> =>
  Object.fromEntries(store.listChats().map(chat => [chat.id, chat.unreadCount]));

/** What Baileys does when the write of a chatModify completes (appPatch with emitOwnEvents, on by default). */
const replay = (store: BaileysSessionStore, jid = PHONE): void =>
  store.upsertChats([{ id: jid, unreadCount: 0, conditional: () => undefined } as never]);

/** A message reaches the session: the message itself, and the `chats.update` increment Baileys emits for it. */
const arrives = (store: BaileysSessionStore, id: string, timestamp: number, jid = PHONE): void => {
  store.recordMessage(inbound(id, timestamp, jid));
  store.upsertChats([{ id: jid, unreadCount: 1, conversationTimestamp: timestamp }]);
};

describe('a read of a chat marked unread by hand, with a message arriving while the mark is being undone', () => {
  /** The chat is marked unread, as WhatsApp syncs it: a negative count; M1 is the newest message received. */
  const marked = (chatModify: jest.Mock) => {
    const readMessages = jest.fn().mockResolvedValue(undefined);
    const wired = wire({ readMessages, chatModify });
    wired.store.upsertChats([{ id: PHONE, unreadCount: -1, conversationTimestamp: 10 }]);
    wired.store.recordMessage(inbound('M1', 10));
    return { ...wired, readMessages };
  };

  it.each([
    ['during the round trip, before Baileys replays the write', true],
    ['after Baileys replayed the write, before the write resolves', false],
  ])('keeps the unread count of a message that arrives %s', async (_when, beforeReplay) => {
    const chatModify = jest.fn();
    const { store, contacts, readMessages } = marked(chatModify);
    chatModify.mockImplementation(() => {
      if (beforeReplay) {
        arrives(store, 'M2', 11);
        replay(store);
      } else {
        replay(store);
        arrives(store, 'M2', 11);
      }
      return Promise.resolve();
    });

    await expect(contacts.sendSeen(CHAT, ['M1'])).resolves.toBe(true);

    expect(readMessages).toHaveBeenCalledWith([expect.objectContaining({ id: 'M1' })]);
    expect(chatModify).toHaveBeenCalledTimes(1);
    // M2 was never named by a receipt: the chat is still unread.
    expect(counts(store)).toEqual({ [CHAT]: 1 });
  });

  it("keeps the unread count of a message counted on the contact's other record", async () => {
    const chatModify = jest.fn();
    const { store, contacts } = marked(chatModify);
    store.addLidMappings([{ lid: LID, pn: PHONE }]);
    chatModify.mockImplementation(() => {
      arrives(store, 'M2', 11, LID);
      replay(store); // the record the write was keyed to, which holds the mark
      return Promise.resolve();
    });

    await expect(contacts.sendSeen(CHAT, ['M1'])).resolves.toBe(true);

    expect(counts(store)).toEqual({ [CHAT]: 0, [LID]: 1 });
  });

  it('resets the counts of the chat before the write, which only waits for the marks', async () => {
    const chatModify = jest.fn();
    const { store, contacts } = marked(chatModify);
    // The mark was set under the phone; a count that is not a message of the newest second sits on the lid record.
    store.addLidMappings([{ lid: LID, pn: PHONE }]);
    store.upsertChats([{ id: LID, unreadCount: 2, conversationTimestamp: 5 }]);
    let duringWrite: Record<string, number | undefined> = {};
    chatModify.mockImplementation(() => {
      duringWrite = counts(store);
      return Promise.resolve();
    });

    await expect(contacts.sendSeen(CHAT, ['M1'])).resolves.toBe(true);

    expect(duringWrite).toEqual({ [CHAT]: -1, [LID]: 0 });
    expect(counts(store)).toEqual({ [CHAT]: 0, [LID]: 0 });
  });

  it('clears the mark from every record of the chat once the write is confirmed', async () => {
    const chatModify = jest.fn().mockResolvedValue(undefined);
    const { store, contacts } = marked(chatModify);
    store.addLidMappings([{ lid: LID, pn: PHONE }]);
    store.upsertChats([{ id: LID, unreadCount: -1, conversationTimestamp: 5 }]);

    await expect(contacts.sendSeen(CHAT, ['M1'])).resolves.toBe(true);

    expect(store.isMarkedUnread(CHAT)).toBe(false);
    expect(counts(store)).toEqual({ [CHAT]: 0, [LID]: 0 });
  });

  it('restores nothing for a message the caller named', async () => {
    const chatModify = jest.fn();
    const { store, contacts } = marked(chatModify);
    chatModify.mockImplementation(() => {
      arrives(store, 'M2', 11);
      replay(store);
      return Promise.resolve();
    });

    await expect(contacts.sendSeen(CHAT, ['M1', 'M2'])).resolves.toBe(true);

    expect(counts(store)).toEqual({ [CHAT]: 0 });
  });

  it('lists the chat unread for a message that is still being processed when the write returns', async () => {
    const chatModify = jest.fn();
    const { store, contacts, pending } = marked(chatModify);
    chatModify.mockImplementation(() => {
      pending.push({ chatJid: PHONE, id: 'M2', timestamp: 11, order: 5 });
      replay(store);
      return Promise.resolve();
    });

    await expect(contacts.sendSeen(CHAT, ['M1'])).resolves.toBe(true);

    expect(counts(store)).toEqual({ [CHAT]: 1 });
  });

  it('lists the chat unread for a message that is still being processed when the read begins, and writes nothing', async () => {
    const chatModify = jest.fn().mockResolvedValue(undefined);
    const { store, contacts, pending, readMessages } = marked(chatModify);
    pending.push({ chatJid: PHONE, id: 'M2', timestamp: 11, order: 5 });

    await expect(contacts.sendSeen(CHAT, ['M1'])).resolves.toBe(true);

    expect(readMessages).toHaveBeenCalledTimes(1);
    expect(chatModify).not.toHaveBeenCalled();
    expect(counts(store)).toEqual({ [CHAT]: -1 });
  });

  it('keeps the mark and the count of a message that arrives while a write that WhatsApp refuses is out', async () => {
    const chatModify = jest.fn();
    const { store, contacts, logger } = marked(chatModify);
    chatModify.mockImplementation(() => {
      arrives(store, 'M2', 11); // counted over the mark on the same record; no write was applied, so no replay
      return Promise.reject(new Error('App state key not present!'));
    });

    await expect(contacts.sendSeen(CHAT, ['M1'])).resolves.toBe(true);

    expect(counts(store)).toEqual({ [CHAT]: 1 });
    expect(logger.warn).toHaveBeenCalledWith(
      'Sent the read receipt of a chat but could not undo its unread mark',
      expect.objectContaining({ chatId: CHAT }),
    );
  });
});
