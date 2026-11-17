import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import { BaileysContacts, BaileysContactsHost } from './baileys-contacts';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { toNeutralJid } from '../identity/wa-id';

/**
 * `readMessages` reaches `fetchPrivacySettings`, whose body is
 * `const { content } = await query({...})`. On an unanswered query that destructure throws a raw
 * TypeError — no Boom, so nothing can classify it — and the caller gets a bare 500.
 *
 * Marking a chat read is idempotent in effect, so bounding it is safe: a repeat costs nothing.
 * The media send path is deliberately NOT bounded the same way — see the PR.
 */
const never = (): Promise<never> => new Promise<never>(() => undefined);

/**
 * The real fold, not an identity stub. A stub that returned its argument unchanged let the whole
 * suite pass with the `toEngineJid` call deleted outright, and left the fallback case asserting
 * `@s.whatsapp.net` while the supplied-id cases asserted `@c.us` for the same chat.
 */
const toEngineJid = (jid: string): string => {
  const [userPart, host] = jid.split('@');
  return host === 'c.us' || host === 's.whatsapp.net' ? `${userPart}@s.whatsapp.net` : jid;
};

const LAST = {
  key: { id: 'M1', remoteJid: '628123@s.whatsapp.net' },
  timestamp: 1,
  jid: '628123@s.whatsapp.net',
};

function makeHost(overrides: Partial<Record<keyof BaileysContactsHost, unknown>>): BaileysContactsHost {
  const host = {
    ensureReady: () => undefined,
    logger: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
    normalizedSelfJid: () => '628177@s.whatsapp.net',
    listContacts: () => [],
    findContact: () => null,
    resolvePhone: () => null,
    findPersistedLidPhone: () => Promise.resolve(null),
    listChats: () => [],
    lastMessage: () => LAST,
    lastInboundMessage: () => ({ key: LAST.key, timestamp: LAST.timestamp }),
    isMarkedUnread: () => false,
    clearUnread: () => undefined,
    chatDeletedAt: () => null,
    getStoredMessages: () => Promise.resolve([]),
    toEngineJid,
    chatJid: (jid: string) => toEngineJid(jid),
    ...overrides,
  } as unknown as BaileysContactsHost;
  const socket = host.getSocket();
  host.getSocket = () => socket;
  // Wired the way the adapter wires it: the real fold, reading the session's lid mapping through
  // this host's own resolvePhone, so a test can hand it a mapping and exercise the lid dialect.
  host.toNeutralJid = (jid: string): string => toNeutralJid(jid, id => host.resolvePhone(id));
  return host;
}

function contacts(sock: Record<string, jest.Mock>, budgetMs: number): BaileysContacts {
  return new BaileysContacts(makeHost({ getSocket: () => sock as unknown as WASocket }), budgetMs);
}

/** A stored message as the message store hands it back: the whole key, not a synthesised one. */
const stored = (key: WAMessage['key']): WAMessage => ({ key, message: {}, messageTimestamp: 1 });

describe('sendSeen', () => {
  it('reports an unanswered read receipt instead of a bare 500', async () => {
    await expect(contacts({ readMessages: jest.fn(never) }, 15).sendSeen('628123@c.us')).rejects.toBeInstanceOf(
      EngineTransportError,
    );
  });

  it('still resolves when WhatsApp answers inside the budget', async () => {
    const readMessages = jest.fn().mockResolvedValue(undefined);
    await expect(contacts({ readMessages }, 500).sendSeen('628123@c.us')).resolves.toBe(true);
  });

  // Baileys raises a chat's unread count with every message received and lowers it for no receipt this
  // session sends, so POST chats/read answered success and the chat was listed as unread on the next
  // reload. The count is the session's own bookkeeping: it is reset here, with no second write.
  it('resets the unread count of the chat once the receipt is out, with no write to app state', async () => {
    const readMessages = jest.fn().mockResolvedValue(undefined);
    const chatModify = jest.fn().mockResolvedValue(undefined);
    const clearUnread = jest.fn();
    const host = makeHost({ getSocket: () => ({ readMessages, chatModify }) as unknown as WASocket, clearUnread });
    await expect(new BaileysContacts(host, 500).sendSeen('628123@c.us')).resolves.toBe(true);
    expect(clearUnread).toHaveBeenCalledWith('628123@c.us', false);
    expect(chatModify).not.toHaveBeenCalled();
  });

  describe('a read that does not reach the newest message received', () => {
    /** A host that counts the resets and the marks undone on a socket whose receipt is confirmed. */
    const reading = (overrides: Partial<Record<keyof BaileysContactsHost, unknown>> = {}) => {
      const readMessages = jest.fn().mockResolvedValue(undefined);
      const chatModify = jest.fn().mockResolvedValue(undefined);
      const clearUnread = jest.fn();
      const host = makeHost({
        getSocket: () => ({ readMessages, chatModify }) as unknown as WASocket,
        isMarkedUnread: () => true,
        clearUnread,
        ...overrides,
      });
      return { host, readMessages, chatModify, clearUnread };
    };

    it('keeps the count for a message that arrived while the receipt was on its way', async () => {
      let newest = LAST.key;
      const { host, readMessages, chatModify, clearUnread } = reading({
        lastInboundMessage: () => ({ key: newest, timestamp: LAST.timestamp }),
      });
      readMessages.mockImplementation(() => {
        newest = { id: 'M2', remoteJid: LAST.jid };
        return Promise.resolve();
      });
      await expect(new BaileysContacts(host, 500).sendSeen('628123@c.us')).resolves.toBe(true);
      expect(readMessages).toHaveBeenCalledWith([LAST.key]);
      expect(clearUnread).not.toHaveBeenCalled();
      expect(chatModify).not.toHaveBeenCalled();
    });

    it('keeps the count when the caller names an older message of a burst', async () => {
      const { host, readMessages, chatModify, clearUnread } = reading();
      await expect(new BaileysContacts(host, 500).sendSeen('628123@c.us', ['M0'])).resolves.toBe(true);
      expect(readMessages).toHaveBeenCalledWith([{ remoteJid: LAST.jid, id: 'M0', fromMe: false }]);
      expect(clearUnread).not.toHaveBeenCalled();
      expect(chatModify).not.toHaveBeenCalled();
    });

    it('resets the count when the ids named include the newest', async () => {
      const { host, clearUnread } = reading({ isMarkedUnread: () => false });
      await expect(new BaileysContacts(host, 500).sendSeen('628123@c.us', ['M0', 'M1'])).resolves.toBe(true);
      expect(clearUnread).toHaveBeenCalledWith('628123@c.us', false);
    });

    // Baileys leaves the account's own keys out of a receipt, so nothing was read. After a restart the
    // newest received message is not known, and such a call must not pass for a read either.
    it.each([
      ['knows the newest message', () => ({ key: LAST.key, timestamp: LAST.timestamp })],
      ['holds no received message', () => null],
    ])("keeps the count for a read of the account's own messages when memory %s", async (_case, lastInbound) => {
      const { host, clearUnread, chatModify } = reading({
        lastInboundMessage: lastInbound,
        getStoredMessages: () => Promise.resolve([stored({ id: 'O1', remoteJid: LAST.jid, fromMe: true })]),
      });
      await expect(new BaileysContacts(host, 500).sendSeen('628123@c.us', ['O1'])).resolves.toBe(true);
      expect(clearUnread).not.toHaveBeenCalled();
      expect(chatModify).not.toHaveBeenCalled();
    });

    it('takes a received id for the read while memory holds no received message', async () => {
      const { host, clearUnread } = reading({ lastInboundMessage: () => null, isMarkedUnread: () => false });
      await expect(new BaileysContacts(host, 500).sendSeen('628123@c.us', ['M9'])).resolves.toBe(true);
      expect(clearUnread).toHaveBeenCalledWith('628123@c.us', false);
    });
  });

  it('leaves the unread count alone when the receipt was not confirmed', async () => {
    const clearUnread = jest.fn();
    const host = makeHost({ getSocket: () => ({ readMessages: jest.fn(never) }) as unknown as WASocket, clearUnread });
    await expect(new BaileysContacts(host, 15).sendSeen('628123@c.us')).rejects.toBeInstanceOf(EngineTransportError);
    expect(clearUnread).not.toHaveBeenCalled();
  });

  describe('for a chat marked unread by hand', () => {
    /** A host whose chat carries the mark, on a socket with the two writes a read of it makes. */
    const marked = (chatModify: jest.Mock, overrides: Partial<Record<keyof BaileysContactsHost, unknown>> = {}) => {
      const readMessages = jest.fn().mockResolvedValue(undefined);
      const warn = jest.fn();
      const host = makeHost({
        getSocket: () => ({ readMessages, chatModify }) as unknown as WASocket,
        isMarkedUnread: () => true,
        logger: { warn },
        ...overrides,
      });
      return { host, readMessages, warn };
    };

    it('undoes the mark in the app state after the receipt, the half markUnread writes the other way', async () => {
      const chatModify = jest.fn().mockResolvedValue(undefined);
      const clearUnread = jest.fn();
      const { host, readMessages } = marked(chatModify, { clearUnread });
      await expect(new BaileysContacts(host, 500).sendSeen('628123@c.us')).resolves.toBe(true);
      // Confirmed, so the mark goes from every record of the chat, not only the one the write was keyed to.
      expect(clearUnread).toHaveBeenCalledWith('628123@c.us', true);
      expect(readMessages).toHaveBeenCalled();
      expect(chatModify).toHaveBeenCalledWith(
        {
          markRead: true,
          lastMessages: [{ key: { ...LAST.key, fromMe: false }, messageTimestamp: LAST.timestamp }],
        },
        LAST.jid,
      );
    });

    // The receipt is out by then and is what the answer reports. Failing the read on the mark would tell
    // the caller that a receipt the sender already has was not sent.
    it.each([
      ['WhatsApp never confirms', () => jest.fn(never)],
      ['WhatsApp refuses', () => jest.fn().mockRejectedValue(new Error('App state key not present!'))],
    ])('answers true and logs the mark that %s', async (_case, failing) => {
      const clearUnread = jest.fn();
      const { host, readMessages, warn } = marked(failing(), { clearUnread });
      await expect(new BaileysContacts(host, 15).sendSeen('628123@c.us')).resolves.toBe(true);
      expect(readMessages).toHaveBeenCalled();
      // The count is reset, the mark is kept: the account's other devices still show it.
      expect(clearUnread).toHaveBeenCalledWith('628123@c.us', false);
      expect(warn).toHaveBeenCalledWith(
        'Sent the read receipt of a chat but could not undo its unread mark',
        expect.objectContaining({ chatId: '628123@c.us' }),
      );
    });

    it('does not undo the mark on a socket that replaced the one the receipt went out on', async () => {
      const replacement = { readMessages: jest.fn(), chatModify: jest.fn().mockResolvedValue(undefined) };
      let current: Record<string, jest.Mock> = replacement;
      const first = {
        readMessages: jest.fn(() => {
          current = replacement;
          return Promise.resolve();
        }),
        chatModify: jest.fn().mockResolvedValue(undefined),
      };
      current = first;
      const { host, warn } = marked(first.chatModify, { getSocket: () => first as unknown as WASocket });
      // makeHost pins the socket it is given; this session replaces its socket while the receipt is out.
      host.getSocket = () => current as unknown as WASocket;
      await expect(new BaileysContacts(host, 500).sendSeen('628123@c.us')).resolves.toBe(true);
      expect(first.readMessages).toHaveBeenCalled();
      expect(first.chatModify).not.toHaveBeenCalled();
      expect(replacement.chatModify).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
    });

    it('sends no mark that names no message, also for a chat the session lists', async () => {
      // What the phone does with a read mark that carries no range is not established (for an unread
      // mark it is). The receipt went out, so the answer stays true.
      const chatModify = jest.fn().mockResolvedValue(undefined);
      const { host, readMessages } = marked(chatModify, {
        lastMessage: () => null,
        lastInboundMessage: () => null,
        listChats: () => [{ id: '628123@c.us' }],
      });
      await expect(new BaileysContacts(host, 500).sendSeen('628123@c.us', ['M9'])).resolves.toBe(true);
      expect(readMessages).toHaveBeenCalled();
      expect(chatModify).not.toHaveBeenCalled();
    });
  });

  it('acknowledges every supplied message, not just the newest one', async () => {
    // The whole point of the caller-supplied list: a burst of three inbound messages used to leave
    // the first two unread forever, because only lastMessage() was ever acknowledged.
    const readMessages = jest.fn().mockResolvedValue(undefined);
    await expect(contacts({ readMessages }, 500).sendSeen('628123@c.us', ['M1', 'M2', 'M3'])).resolves.toBe(true);
    expect(readMessages).toHaveBeenCalledWith([
      { remoteJid: '628123@s.whatsapp.net', id: 'M1', fromMe: false },
      { remoteJid: '628123@s.whatsapp.net', id: 'M2', fromMe: false },
      { remoteJid: '628123@s.whatsapp.net', id: 'M3', fromMe: false },
    ]);
  });

  it('never sends the receipt to another chat, even when the store resolves the id', async () => {
    // The stored key carries its own remoteJid. Used unchecked, an id belonging to a different chat
    // in the same session acknowledged THAT chat while the route answered success for the one the
    // caller named, and the caller's own chat stayed unread.
    const readMessages = jest.fn().mockResolvedValue(undefined);
    const host = makeHost({
      getSocket: () => ({ readMessages }) as unknown as WASocket,
      getStoredMessages: () =>
        Promise.resolve([stored({ id: 'X1', remoteJid: '628999@s.whatsapp.net', fromMe: false })]),
    });

    await expect(new BaileysContacts(host, 500).sendSeen('628123@c.us', ['X1'])).resolves.toBe(true);

    // Falls back to the synthesised key for the ADDRESSED chat rather than the stored one.
    expect(readMessages).toHaveBeenCalledWith([{ remoteJid: '628123@s.whatsapp.net', id: 'X1', fromMe: false }]);
  });

  it('still uses a stored key stored under the peer lid for the addressed chat', async () => {
    // Baileys addresses a DM by the peer's lid, so the stored key's remoteJid is `<lid>@lid` while
    // the caller names the chat by phone number. Folding through the ENGINE dialect cannot reduce a
    // lid, so every stored key was discarded and the receipt fell back to a synthesised key that
    // lost the real fromMe and participant.
    const readMessages = jest.fn().mockResolvedValue(undefined);
    const host = makeHost({
      getSocket: () => ({ readMessages }) as unknown as WASocket,
      resolvePhone: (jid: string) => (jid === '9988@lid' ? '628123' : null),
      findPersistedLidPhone: (jid: string) => Promise.resolve(jid === '9988@lid' ? '628123' : null),
      getStoredMessages: () =>
        Promise.resolve([stored({ id: 'L1', remoteJid: '9988@lid', fromMe: true, participant: '9988@lid' })]),
    });

    await expect(new BaileysContacts(host, 500).sendSeen('628123@c.us', ['L1'])).resolves.toBe(true);
    expect(readMessages).toHaveBeenCalledWith([
      { id: 'L1', remoteJid: '9988@lid', fromMe: true, participant: '9988@lid' },
    ]);
  });

  it('still rejects a lid-addressed key from another chat', async () => {
    // Negative twin of the case above: reducing through the neutral dialect must not turn the scope
    // check into "accept anything spelled @lid". An unmapped lid stays itself and cannot match.
    const readMessages = jest.fn().mockResolvedValue(undefined);
    const host = makeHost({
      getSocket: () => ({ readMessages }) as unknown as WASocket,
      getStoredMessages: () => Promise.resolve([stored({ id: 'L2', remoteJid: '7777@lid', fromMe: true })]),
    });

    await expect(new BaileysContacts(host, 500).sendSeen('628123@c.us', ['L2'])).resolves.toBe(true);
    expect(readMessages).toHaveBeenCalledWith([{ remoteJid: '628123@s.whatsapp.net', id: 'L2', fromMe: false }]);
  });

  it('still uses a stored key whose chat is spelled in the other dialect', async () => {
    // Control for the check above: the same chat written @c.us must still resolve, or the fix would
    // have cost every receipt its participant and fromMe.
    const readMessages = jest.fn().mockResolvedValue(undefined);
    const host = makeHost({
      getSocket: () => ({ readMessages }) as unknown as WASocket,
      getStoredMessages: () => Promise.resolve([stored({ id: 'D1', remoteJid: '628123@c.us', fromMe: true })]),
    });

    await expect(new BaileysContacts(host, 500).sendSeen('628123@s.whatsapp.net', ['D1'])).resolves.toBe(true);
    expect(readMessages).toHaveBeenCalledWith([{ id: 'D1', remoteJid: '628123@c.us', fromMe: true }]);
  });

  it('keeps the stored key of a received broadcast-list message addressed by its sender chat', async () => {
    // The message is reported under the sender's chat, but its key names the list and the sender.
    // Synthesising a key for the sender's chat dropped the participant the receipt needs.
    const readMessages = jest.fn().mockResolvedValue(undefined);
    const key = { id: 'B1', remoteJid: '1700000000@broadcast', participant: '628123@s.whatsapp.net', fromMe: false };
    const host = makeHost({
      getSocket: () => ({ readMessages }) as unknown as WASocket,
      getStoredMessages: () => Promise.resolve([stored(key)]),
    });

    await expect(new BaileysContacts(host, 500).sendSeen('628123@c.us', ['B1'])).resolves.toBe(true);
    expect(readMessages).toHaveBeenCalledWith([key]);
  });

  it('treats a null id list as absent rather than dereferencing it', async () => {
    // The REST body rejects an explicit null, but this is the engine boundary; it used to throw a
    // TypeError here and surface as a 500.
    const readMessages = jest.fn().mockResolvedValue(undefined);
    const host = makeHost({ getSocket: () => ({ readMessages }) as unknown as WASocket });

    await expect(new BaileysContacts(host, 500).sendSeen('628123@c.us', null as unknown as string[])).resolves.toBe(
      true,
    );
    expect(readMessages).toHaveBeenCalledWith([{ id: 'M1', remoteJid: '628123@s.whatsapp.net' }]);
  });

  it('carries the participant on a group receipt, which a synthesised key cannot', async () => {
    // A group receipt with no `participant` names no sender, so WhatsApp cannot attribute it and
    // the message stays unread on the sender's side while the API answers success: true.
    const readMessages = jest.fn().mockResolvedValue(undefined);
    const host = makeHost({
      getSocket: () => ({ readMessages }) as unknown as WASocket,
      getStoredMessages: () =>
        Promise.resolve([
          stored({ id: 'G1', remoteJid: '628999-1@g.us', fromMe: false, participant: '628123@s.whatsapp.net' }),
        ]),
    });
    await expect(new BaileysContacts(host, 500).sendSeen('628999-1@g.us', ['G1'])).resolves.toBe(true);
    expect(readMessages).toHaveBeenCalledWith([
      { id: 'G1', remoteJid: '628999-1@g.us', fromMe: false, participant: '628123@s.whatsapp.net' },
    ]);
  });

  it('takes fromMe from the stored key rather than assuming inbound', async () => {
    const readMessages = jest.fn().mockResolvedValue(undefined);
    const host = makeHost({
      getSocket: () => ({ readMessages }) as unknown as WASocket,
      getStoredMessages: () =>
        Promise.resolve([stored({ id: 'O1', remoteJid: '628123@s.whatsapp.net', fromMe: true })]),
    });
    await expect(new BaileysContacts(host, 500).sendSeen('628123@c.us', ['O1'])).resolves.toBe(true);
    expect(readMessages).toHaveBeenCalledWith([{ id: 'O1', remoteJid: '628123@s.whatsapp.net', fromMe: true }]);
  });

  it('synthesises a key only for ids the store has never seen', async () => {
    // History-sync backfill is emitted but never persisted, so a legitimate id can miss. Falling
    // back keeps the 1:1 case working instead of silently dropping the message from the receipt.
    const readMessages = jest.fn().mockResolvedValue(undefined);
    const host = makeHost({
      getSocket: () => ({ readMessages }) as unknown as WASocket,
      getStoredMessages: () =>
        Promise.resolve([stored({ id: 'K1', remoteJid: '628123@s.whatsapp.net', fromMe: true })]),
    });
    await expect(new BaileysContacts(host, 500).sendSeen('628123@c.us', ['K1', 'MISSING'])).resolves.toBe(true);
    expect(readMessages).toHaveBeenCalledWith([
      { id: 'K1', remoteJid: '628123@s.whatsapp.net', fromMe: true },
      { remoteJid: '628123@s.whatsapp.net', id: 'MISSING', fromMe: false },
    ]);
  });

  describe('ids of a group the message store never held', () => {
    // History backfill is emitted and persisted for the chat view only, so a group message of that kind has no
    // stored key. A group receipt names its sender through `participant`; without it WhatsApp cannot attribute
    // the receipt, so the id takes the gateway's stored author or is left out.
    const GROUP = '628999-1@g.us';
    const authors = (entries: Array<[string, string]>): ReadonlyMap<string, string> => new Map(entries);

    it('builds the key with the stored author as its participant', async () => {
      const readMessages = jest.fn().mockResolvedValue(undefined);
      const host = makeHost({ getSocket: () => ({ readMessages }) as unknown as WASocket });

      await expect(
        new BaileysContacts(host, 500).sendSeen(GROUP, ['H1'], authors([['H1', '628123@c.us']])),
      ).resolves.toBe(true);

      expect(readMessages).toHaveBeenCalledWith([
        { remoteJid: GROUP, id: 'H1', fromMe: false, participant: '628123@s.whatsapp.net' },
      ]);
    });

    it('leaves a lid author in its own dialect', async () => {
      const readMessages = jest.fn().mockResolvedValue(undefined);
      const host = makeHost({ getSocket: () => ({ readMessages }) as unknown as WASocket });

      await new BaileysContacts(host, 500).sendSeen(GROUP, ['H1'], authors([['H1', '9988@lid']]));

      expect(readMessages).toHaveBeenCalledWith([
        { remoteJid: GROUP, id: 'H1', fromMe: false, participant: '9988@lid' },
      ]);
    });

    it('sends no key at all for an id whose author is unknown, and says nothing was acknowledged', async () => {
      const readMessages = jest.fn().mockResolvedValue(undefined);
      const host = makeHost({ getSocket: () => ({ readMessages }) as unknown as WASocket });

      await expect(new BaileysContacts(host, 500).sendSeen(GROUP, ['H1', 'H2'])).resolves.toBe(false);
      await expect(
        new BaileysContacts(host, 500).sendSeen(GROUP, ['H1'], authors([['OTHER', '628123@c.us']])),
      ).resolves.toBe(false);

      expect(readMessages).not.toHaveBeenCalled();
    });

    it('acknowledges the ids it can name and skips the rest without failing the read', async () => {
      const readMessages = jest.fn().mockResolvedValue(undefined);
      const stored1 = { id: 'S1', remoteJid: GROUP, fromMe: false, participant: '628111@s.whatsapp.net' };
      const host = makeHost({
        getSocket: () => ({ readMessages }) as unknown as WASocket,
        getStoredMessages: () => Promise.resolve([stored(stored1)]),
      });

      await expect(
        new BaileysContacts(host, 500).sendSeen(
          GROUP,
          ['S1', 'H1', 'LOST', 'H2'],
          // S1 has an author too: the stored key wins, as it carries the dialect WhatsApp used.
          authors([
            ['S1', '628000@c.us'],
            ['H1', '628123@c.us'],
            ['H2', '628456@c.us'],
          ]),
        ),
      ).resolves.toBe(true);

      expect(readMessages).toHaveBeenCalledWith([
        stored1,
        { remoteJid: GROUP, id: 'H1', fromMe: false, participant: '628123@s.whatsapp.net' },
        { remoteJid: GROUP, id: 'H2', fromMe: false, participant: '628456@s.whatsapp.net' },
      ]);
    });

    it('keeps a stored key and leaves a one to one chat on its synthesised key whatever authors say', async () => {
      const readMessages = jest.fn().mockResolvedValue(undefined);
      const host = makeHost({ getSocket: () => ({ readMessages }) as unknown as WASocket });

      await expect(
        new BaileysContacts(host, 500).sendSeen('628123@c.us', ['M1'], authors([['M1', '628555@c.us']])),
      ).resolves.toBe(true);

      expect(readMessages).toHaveBeenCalledWith([{ remoteJid: '628123@s.whatsapp.net', id: 'M1', fromMe: false }]);
    });
  });

  it('marks supplied messages even when the store has nothing cached', async () => {
    // The restart case: the in-memory store is empty, so the old code returned false under a 200
    // and no receipt was ever sent. A caller that persisted the IDs is not subject to that.
    const readMessages = jest.fn().mockResolvedValue(undefined);
    const host = makeHost({
      getSocket: () => ({ readMessages }) as unknown as WASocket,
      lastInboundMessage: () => null,
    });
    await expect(new BaileysContacts(host, 500).sendSeen('628123@c.us', ['M9'])).resolves.toBe(true);
    expect(readMessages).toHaveBeenCalledWith([{ remoteJid: '628123@s.whatsapp.net', id: 'M9', fromMe: false }]);
  });

  it('works without a message store at all', async () => {
    const readMessages = jest.fn().mockResolvedValue(undefined);
    const host = makeHost({
      getSocket: () => ({ readMessages }) as unknown as WASocket,
      getStoredMessages: () => undefined,
    });
    await expect(new BaileysContacts(host, 500).sendSeen('628123@c.us', ['M9'])).resolves.toBe(true);
    expect(readMessages).toHaveBeenCalledWith([{ remoteJid: '628123@s.whatsapp.net', id: 'M9', fromMe: false }]);
  });

  it('acknowledges nothing when the caller supplies an empty list', async () => {
    // An empty list is a caller that computed its unread set and found none. Folding it into the
    // no-list branch would acknowledge the newest message, which is the opposite of the request.
    const readMessages = jest.fn().mockResolvedValue(undefined);
    await expect(contacts({ readMessages }, 500).sendSeen('628123@c.us', [])).resolves.toBe(false);
    expect(readMessages).not.toHaveBeenCalled();
  });

  it('falls back to the newest received message when no list is supplied', async () => {
    const readMessages = jest.fn().mockResolvedValue(undefined);
    await expect(contacts({ readMessages }, 500).sendSeen('628123@c.us')).resolves.toBe(true);
    expect(readMessages).toHaveBeenCalledWith([{ id: 'M1', remoteJid: '628123@s.whatsapp.net' }]);
  });

  it('still short-circuits when no received message is known', async () => {
    const host = makeHost({ getSocket: () => ({}) as unknown as WASocket, lastInboundMessage: () => null });
    await expect(new BaileysContacts(host, 15).sendSeen('628123@c.us')).resolves.toBe(false);
  });
});
