import { WwebjsChats } from './wwebjs-chats';
import { BaileysContacts, type BaileysContactsHost } from './baileys-contacts';
import { createLogger } from '../../common/services/logger.service';
import { type WwebjsEngineHost } from './wwebjs-host';
import { type WwebjsMessaging } from './wwebjs-messaging';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import type { Client } from 'whatsapp-web.js';
import type { WASocket } from '@whiskeysockets/baileys';

/**
 * Chat mute/unmute across both engines — the first of the §29.5.3 "supported by BOTH libraries,
 * missing only in OpenWA" backlog.
 *
 * `muteUntil` is an absolute epoch-MILLISECONDS timestamp, `null` unmutes. Milliseconds is a
 * measured fact, not a reading of the proto: `MuteAction.muteEndTimestamp` is unsuffixed while the
 * same file spells other millisecond fields `…Ms`, which suggests seconds and is wrong. Sent live
 * against a real Baileys session, an epoch-SECONDS value left the chat unmuted — that instant had
 * already passed in 1970 — and the same instant in milliseconds muted it to the expected minute.
 *
 * The behaviour worth pinning is the one that separates mute from its neighbours: `archive`,
 * `clear` and `delete` are app-state modifications keyed to the chat's LAST MESSAGE, so Baileys
 * cannot apply them to a chat with no known history and those methods resolve false. The `mute`
 * modification carries no `lastMessages` at all (Types/Chat.d.ts ChatModification union), so it has
 * no such limit — and a test is the only thing that stops someone copying the archive body and
 * reintroducing the guard.
 */

const logger = createLogger('chat-mute.spec');
const MUTE_UNTIL = 1_800_000_000_000; // epoch MILLISECONDS (2027-01-15)

describe('WwebjsChats.muteChat', () => {
  function makeChats(): { chats: WwebjsChats; client: { [k: string]: jest.Mock } } {
    const client = {
      muteChat: jest.fn().mockResolvedValue({ isMuted: true, muteExpiration: MUTE_UNTIL }),
      unmuteChat: jest.fn().mockResolvedValue({ isMuted: false, muteExpiration: 0 }),
      getChatById: jest.fn().mockResolvedValue({ id: { _serialized: '628123@c.us' } }),
    };
    const host = {
      ensureReady: jest.fn(),
      getClient: () => client as unknown as Client,
      logger,
      // Both are declared on WwebjsEngineHost and called unguarded by every operation in this
      // adapter; a stub that omits them is a host shape production never has, and it hid which
      // failures this file classifies as transport.
      isPageTransportError: () => false,
      reportIfPageTransportError: jest.fn(),
    } as unknown as WwebjsEngineHost;
    return { chats: new WwebjsChats(host, {} as unknown as WwebjsMessaging), client };
  }

  it('a timestamp mutes until exactly that instant', async () => {
    const { chats, client } = makeChats();
    await chats.muteChat('628123@c.us', MUTE_UNTIL);
    expect(client.unmuteChat).not.toHaveBeenCalled();
    expect(client.muteChat).toHaveBeenCalledTimes(1);
    const [chatId, unmuteDate] = client.muteChat.mock.calls[0] as [string, Date];
    expect(chatId).toBe('628123@c.us');
    // The Date must carry the exact instant asked for; wwjs floors it to seconds on the page side.
    expect(unmuteDate.getTime()).toBe(MUTE_UNTIL);
  });

  it('null unmutes', async () => {
    const { chats, client } = makeChats();
    await chats.muteChat('628123@c.us', null);
    expect(client.unmuteChat).toHaveBeenCalledWith('628123@c.us');
    expect(client.muteChat).not.toHaveBeenCalled();
  });

  it('propagates a failure — the caller asked for this state, so a swallow would lie', async () => {
    const { chats, client } = makeChats();
    client.muteChat.mockRejectedValue(new Error('page died'));
    await expect(chats.muteChat('628123@c.us', MUTE_UNTIL)).rejects.toThrow('page died');
  });

  /**
   * Live against a real session, muting a chat the page could not resolve rejected from inside
   * `Client._muteUnmuteChat`'s evaluate with `TypeError: this.findImpl is not a function`, which
   * NestJS turns into a bare 500 — a status this route never declares, while its own 400 already
   * reads "an invalid chatId". The same call against a real chat succeeded, so the capability was
   * never the problem; only the unresolvable-chat path was.
   */
  describe.each([
    ['the page resolves no such chat', (c: { [k: string]: jest.Mock }) => c.getChatById.mockResolvedValue(undefined)],
    [
      'the page rejects the lookup',
      (c: { [k: string]: jest.Mock }) => c.getChatById.mockRejectedValue(new Error('No LID for user')),
    ],
  ])('an unknown chat is bad input, not a server fault — %s', (_label, arrange) => {
    it('rejects with a 400 and never reaches the mute call', async () => {
      const { chats, client } = makeChats();
      arrange(client);
      await expect(chats.muteChat('628123@c.us', MUTE_UNTIL)).rejects.toMatchObject({ status: 400 });
      expect(client.muteChat).not.toHaveBeenCalled();
    });

    it('guards the unmute direction too', async () => {
      const { chats, client } = makeChats();
      arrange(client);
      await expect(chats.muteChat('628123@c.us', null)).rejects.toMatchObject({ status: 400 });
      expect(client.unmuteChat).not.toHaveBeenCalled();
    });
  });

  /**
   * The other half of the same fix, and the reason the guard resolves the chat instead of wrapping
   * the mute call: a page-side rejection for a chat that DOES exist is exactly what a renamed page
   * internal produces, and that is how `createGroup` was caught. Demoting it to 400 would relabel a
   * dead capability as the caller's bad input.
   */
  it('a page failure on a chat that DOES resolve stays a server error, not a 400', async () => {
    const { chats, client } = makeChats();
    client.muteChat.mockRejectedValue(new TypeError('this.findImpl is not a function'));
    await expect(chats.muteChat('628123@c.us', MUTE_UNTIL)).rejects.toThrow('findImpl');
    await expect(chats.muteChat('628123@c.us', MUTE_UNTIL)).rejects.not.toMatchObject({ status: 400 });
  });

  /**
   * The chat resolution swallowed EVERY rejection into "no such chat", so a dead page — the state
   * where nothing can be resolved — was reported to the caller as a 400 naming their chatId. Five
   * other operations in this adapter split that case out and answer 503; leaving these two behind
   * made the same file answer a dead page two different ways, and told a caller to fix a request
   * that was never the problem.
   */
  describe.each([
    ['muteChat', (c: WwebjsChats) => c.muteChat('628123@c.us', MUTE_UNTIL)],
    ['pinChat', (c: WwebjsChats) => c.pinChat('628123@c.us', true)],
  ])('%s reports a dead page as transport, not as a bad chatId', (_name, call) => {
    it('rethrows EngineTransportError', async () => {
      const dead = new Error('Execution context was destroyed');
      const client = {
        getChatById: jest.fn().mockRejectedValue(dead),
        muteChat: jest.fn(),
        unmuteChat: jest.fn(),
        pinChat: jest.fn(),
        unpinChat: jest.fn(),
      };
      const reportIfPageTransportError = jest.fn();
      const host = {
        ensureReady: jest.fn(),
        getClient: () => client as unknown as Client,
        logger,
        isPageTransportError: (error: unknown) => error === dead,
        reportIfPageTransportError,
      } as unknown as WwebjsEngineHost;
      const chats = new WwebjsChats(host, {} as unknown as WwebjsMessaging);

      await expect(call(chats)).rejects.toBeInstanceOf(EngineTransportError);
      expect(reportIfPageTransportError).toHaveBeenCalled();
    });
  });

  // Negative twin: an ordinary unresolvable chat must still be the 400 the routes document.
  it('still answers 400 when the page simply does not know the chat', async () => {
    const { chats, client } = makeChats();
    client.getChatById.mockResolvedValue(undefined);
    await expect(chats.muteChat('628999@c.us', MUTE_UNTIL)).rejects.toMatchObject({ status: 400 });
  });
});

describe('BaileysContacts.muteChat', () => {
  const never = (): Promise<never> => new Promise<never>(() => undefined);

  function makeContacts(
    sock: Record<string, jest.Mock>,
    opts: { lastMessage?: unknown; budgetMs?: number } = {},
  ): BaileysContacts {
    const host = {
      ensureReady: () => undefined,
      getSocket: () => sock as unknown as WASocket,
      logger,
      normalizedSelfJid: () => '628177@s.whatsapp.net',
      listContacts: () => [],
      findContact: () => null,
      resolvePhone: () => null,
      listChats: () => [],
      lastMessage: () => opts.lastMessage ?? null,
      toEngineJid: (j: string) => j.replace('@c.us', '@s.whatsapp.net'),
    } as unknown as BaileysContactsHost;
    return new BaileysContacts(host, opts.budgetMs ?? 500);
  }

  it('a timestamp writes the mute app-state patch for that chat', async () => {
    const chatModify = jest.fn().mockResolvedValue(undefined);
    await makeContacts({ chatModify }).muteChat('628123@c.us', MUTE_UNTIL);
    expect(chatModify).toHaveBeenCalledWith({ mute: MUTE_UNTIL }, '628123@s.whatsapp.net');
  });

  it('null writes the unmute patch', async () => {
    const chatModify = jest.fn().mockResolvedValue(undefined);
    await makeContacts({ chatModify }).muteChat('628123@c.us', null);
    expect(chatModify).toHaveBeenCalledWith({ mute: null }, '628123@s.whatsapp.net');
  });

  it('works on a chat with NO known history, unlike archive/clear/delete', async () => {
    const chatModify = jest.fn().mockResolvedValue(undefined);
    const contacts = makeContacts({ chatModify }, { lastMessage: null });
    await expect(contacts.muteChat('628123@c.us', MUTE_UNTIL)).resolves.toBeUndefined();
    expect(chatModify).toHaveBeenCalledTimes(1);
  });

  it('reports an unconfirmed write rather than resolving on a silent socket', async () => {
    const contacts = makeContacts({ chatModify: jest.fn(never) }, { budgetMs: 15 });
    await expect(contacts.muteChat('628123@c.us', MUTE_UNTIL)).rejects.toBeInstanceOf(EngineTransportError);
  });
});

// Read-back of mute state through getChats (#1473). whatsapp-web.js exposes an authoritative
// isMuted plus muteExpiration in epoch SECONDS (-1 = indefinitely); the neutral shape reports the
// same seconds with 0 = indefinitely, and only when the chat is muted.
describe('WwebjsChats.getChats mute mapping (#1473)', () => {
  function makeChatsWith(rawChats: unknown[]): WwebjsChats {
    const client = { getChats: jest.fn().mockResolvedValue(rawChats) };
    const host = {
      ensureReady: jest.fn(),
      getClient: () => client as unknown as Client,
      logger,
      isPageTransportError: () => false,
      reportIfPageTransportError: jest.fn(),
    } as unknown as WwebjsEngineHost;
    return new WwebjsChats(host, {} as unknown as WwebjsMessaging);
  }

  const raw = (over: Record<string, unknown>): Record<string, unknown> => ({
    id: { _serialized: '628123@c.us' },
    name: 'Alice',
    isGroup: false,
    unreadCount: 0,
    timestamp: 1700000000,
    ...over,
  });

  it('maps a timed mute to isMuted:true and the same epoch-seconds expiration', async () => {
    const [chat] = await makeChatsWith([raw({ isMuted: true, muteExpiration: 1700003600 })]).getChats();
    expect(chat).toEqual(expect.objectContaining({ isMuted: true, muteExpiration: 1700003600 }));
  });

  it('normalises the -1 "indefinitely" sentinel to 0', async () => {
    const [chat] = await makeChatsWith([raw({ isMuted: true, muteExpiration: -1 })]).getChats();
    expect(chat).toEqual(expect.objectContaining({ isMuted: true, muteExpiration: 0 }));
  });

  it('reports isMuted:false and omits the expiration for an unmuted chat', async () => {
    const [chat] = await makeChatsWith([raw({ isMuted: false, muteExpiration: 0 })]).getChats();
    expect(chat).toEqual(expect.objectContaining({ isMuted: false }));
    expect(chat).not.toHaveProperty('muteExpiration');
  });
});
