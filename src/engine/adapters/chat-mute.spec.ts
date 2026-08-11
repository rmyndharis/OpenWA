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
