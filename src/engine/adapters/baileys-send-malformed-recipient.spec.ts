import { BadRequestException } from '@nestjs/common';
import type { WASocket } from '@whiskeysockets/baileys';
import { BaileysMessaging, type BaileysMessagingHost } from './baileys-messaging';
import { markEngineSendFailure } from '../../common/errors/engine-send-failure';
import { sendFailureProvesNothingSent } from '../../modules/message/idempotency/send-idempotency.interceptor';

describe('Baileys refuses a recipient id with no user part before anything reaches the socket', () => {
  let sock: { onWhatsApp: jest.Mock; sendMessage: jest.Mock };
  let messaging: BaileysMessaging;

  beforeEach(() => {
    // Nobody is registered behind these ids, but the send must stop before the socket is asked anything.
    sock = {
      onWhatsApp: jest.fn().mockResolvedValue([]),
      sendMessage: jest.fn().mockResolvedValue({ key: { id: 'M1' }, messageTimestamp: 1 }),
    };
    const host = {
      ensureReady: () => undefined,
      sessionProxyUrl: () => undefined,
      getSocket: () => sock as unknown as WASocket,
      getSocketOrNull: () => sock as unknown as WASocket,
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      toNeutralJid: (j: string) => j.replace('@s.whatsapp.net', '@c.us'),
      toEngineJid: (j: string) => j.replace('@c.us', '@s.whatsapp.net'),
      normalizedSelfJid: () => '628177@s.whatsapp.net',
      getEphemeralExpiration: () => undefined,
      toUnixSeconds: () => 1,
      loadLib: () =>
        Promise.resolve({ normalizeMessageContent: (m: unknown) => m, getContentType: () => 'conversation' } as never),
      getStoredMessage: () => Promise.resolve(undefined),
      wasDeletedForEveryone: () => false,
      pendingEditOf: () => undefined,
      putStoredMessage: () => undefined,
      recordMessage: () => undefined,
      rememberOwnSend: () => undefined,
      recordLidMapping: () => undefined,
      getOnMessageCreate: () => undefined,
    } as unknown as BaileysMessagingHost;
    messaging = new BaileysMessaging(host);
  });

  it.each([':5@c.us', ':0@s.whatsapp.net', '@c.us', '123@456@c.us', '@g.us'])(
    'answers 400, proves nothing was sent, and writes nothing to %s',
    async chatId => {
      const error = await messaging.sendTextMessage(chatId, 'hi').then(
        () => undefined,
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(BadRequestException);
      expect(sock.sendMessage).not.toHaveBeenCalled();
      expect(sendFailureProvesNothingSent(markEngineSendFailure(error))).toBe(true);
    },
  );

  it('still sends to an id under a domain it does not know, which has a user part', async () => {
    await messaging.sendTextMessage('13135550002@bot', 'hi');

    expect(sock.sendMessage).toHaveBeenCalledTimes(1);
    const [jid] = sock.sendMessage.mock.calls[0] as [string];
    expect(jid).toBe('13135550002@bot');
  });
});
