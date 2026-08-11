import { WwebjsChats } from './wwebjs-chats';
import { BaileysMessaging, type BaileysMessagingHost } from './baileys-messaging';
import { createLogger } from '../../common/services/logger.service';
import { type WwebjsEngineHost } from './wwebjs-host';
import { type WwebjsMessaging } from './wwebjs-messaging';
import type { Client } from 'whatsapp-web.js';
import type { WASocket } from '@whiskeysockets/baileys';

/**
 * Own GLOBAL presence (appear online/offline) across both engines. Unlike the per-chat
 * typing/recording indicator (sendChatState), this is NOT best-effort: the caller explicitly asked
 * to appear offline — a bot that silently stays visible online causes exactly the missed-phone-
 * notification problem the feature exists to solve (#871) — so a failure surfaces instead of being
 * swallowed. The setting belongs to the connection and resets on reconnect.
 */

const logger = createLogger('own-presence.spec');

describe('WwebjsChats.setOnlinePresence', () => {
  function makeChats(): { chats: WwebjsChats; client: { [k: string]: jest.Mock } } {
    const client = {
      sendPresenceAvailable: jest.fn().mockResolvedValue(undefined),
      sendPresenceUnavailable: jest.fn().mockResolvedValue(undefined),
    };
    const host = {
      ensureReady: jest.fn(),
      getClient: () => client as unknown as Client,
      logger,
    } as unknown as WwebjsEngineHost;
    return { chats: new WwebjsChats(host, {} as unknown as WwebjsMessaging), client };
  }

  it('true publishes available', async () => {
    const { chats, client } = makeChats();
    await chats.setOnlinePresence(true);
    expect(client.sendPresenceAvailable).toHaveBeenCalledTimes(1);
    expect(client.sendPresenceUnavailable).not.toHaveBeenCalled();
  });

  it('false publishes unavailable', async () => {
    const { chats, client } = makeChats();
    await chats.setOnlinePresence(false);
    expect(client.sendPresenceUnavailable).toHaveBeenCalledTimes(1);
    expect(client.sendPresenceAvailable).not.toHaveBeenCalled();
  });

  it('propagates a failure — the caller asked for this state, so a swallow would lie', async () => {
    const { chats, client } = makeChats();
    client.sendPresenceUnavailable.mockRejectedValue(new Error('page died'));
    await expect(chats.setOnlinePresence(false)).rejects.toThrow('page died');
  });
});

describe('BaileysMessaging.setOnlinePresence', () => {
  function makeMessaging(): { messaging: BaileysMessaging; sock: { sendPresenceUpdate: jest.Mock } } {
    const sock = { sendPresenceUpdate: jest.fn().mockResolvedValue(undefined) };
    const host = {
      ensureReady: jest.fn(),
      getSocket: () => sock as unknown as WASocket,
      logger,
    } as unknown as BaileysMessagingHost;
    return { messaging: new BaileysMessaging(host), sock };
  }

  it('true publishes a GLOBAL available update (no chat jid)', async () => {
    const { messaging, sock } = makeMessaging();
    await messaging.setOnlinePresence(true);
    expect(sock.sendPresenceUpdate).toHaveBeenCalledWith('available');
  });

  it('false publishes a GLOBAL unavailable update', async () => {
    const { messaging, sock } = makeMessaging();
    await messaging.setOnlinePresence(false);
    expect(sock.sendPresenceUpdate).toHaveBeenCalledWith('unavailable');
  });

  it('propagates a failure rather than swallowing it', async () => {
    const { messaging, sock } = makeMessaging();
    sock.sendPresenceUpdate.mockRejectedValue(new Error('socket closed'));
    await expect(messaging.setOnlinePresence(true)).rejects.toThrow('socket closed');
  });
});
