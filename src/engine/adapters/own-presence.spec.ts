import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
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
 * swallowed. Chat state is a separate wire operation and does not republish this.
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

  it('clears a chat indicator without publishing global presence', async () => {
    const clearState = jest.fn().mockResolvedValue(undefined);
    const client = {
      sendPresenceAvailable: jest.fn().mockResolvedValue(undefined),
      sendPresenceUnavailable: jest.fn().mockResolvedValue(undefined),
      getChatById: jest.fn().mockResolvedValue({ clearState }),
    };
    const messaging = {
      resolveSendId: jest.fn().mockResolvedValue('123@c.us'),
    } as unknown as WwebjsMessaging;
    const host = {
      ensureReady: jest.fn(),
      getClient: () => client as unknown as Client,
      logger,
    } as unknown as WwebjsEngineHost;
    const chats = new WwebjsChats(host, messaging);

    await chats.sendChatState('123@c.us', 'paused');

    expect(clearState).toHaveBeenCalled();
    expect(client.sendPresenceAvailable).not.toHaveBeenCalled();
  });
});

describe('BaileysMessaging.setOnlinePresence', () => {
  function makeMessaging(name: string | null = 'Me'): {
    messaging: BaileysMessaging;
    sock: { sendPresenceUpdate: jest.Mock; user?: { name?: string } };
  } {
    const sock = {
      sendPresenceUpdate: jest.fn().mockResolvedValue(undefined),
      // null means creds.me itself is missing; '' is the empty name Baileys also ignores.
      ...(name === null ? {} : { user: { name } }),
    };
    const host = {
      ensureReady: jest.fn(),
      getSocket: () => sock as unknown as WASocket,
      toEngineJid: (jid: string) => jid,
      recordLidMapping: jest.fn(),
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

  it('refuses when the push name is not set — Baileys would resolve without sending', async () => {
    const { messaging, sock } = makeMessaging(null);
    await expect(messaging.setOnlinePresence(true)).rejects.toBeInstanceOf(EngineNotReadyError);
    expect(sock.sendPresenceUpdate).not.toHaveBeenCalled();
  });

  it('refuses an empty push name the same way Baileys treats a missing one', async () => {
    const { messaging, sock } = makeMessaging('');
    await expect(messaging.setOnlinePresence(false)).rejects.toBeInstanceOf(EngineNotReadyError);
    expect(sock.sendPresenceUpdate).not.toHaveBeenCalled();
  });

  it('sends composing as a per-chat update and nothing global', async () => {
    const { messaging, sock } = makeMessaging();
    await messaging.sendChatState('628111@s.whatsapp.net', 'typing');
    expect(sock.sendPresenceUpdate).toHaveBeenCalledTimes(1);
    expect(sock.sendPresenceUpdate).toHaveBeenCalledWith('composing', '628111@s.whatsapp.net');
  });
});
