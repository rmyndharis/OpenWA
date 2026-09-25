import type { WASocket } from '@whiskeysockets/baileys';
import { BaileysMessaging, type BaileysMessagingHost } from './baileys-messaging';
import { createLogger } from '../../common/services/logger.service';

const logger = createLogger('baileys-interactive-cta.spec');

function makeMessaging(opts: { ephemeralExpiration?: number } = {}) {
  const sendMessage = jest.fn().mockResolvedValue({
    key: { id: 'CTA-MSG-1', remoteJid: '628111@s.whatsapp.net', fromMe: true },
    messageTimestamp: 1700000000,
  });
  const sock = { sendMessage };
  const getStoredMessage = jest.fn().mockResolvedValue(null);
  const putStoredMessage = jest.fn();
  const getEphemeralExpiration = jest.fn().mockReturnValue(opts.ephemeralExpiration);
  const host = {
    ensureReady: jest.fn(),
    sessionProxyUrl: () => undefined,
    getSocket: () => sock as unknown as WASocket,
    logger,
    toNeutralJid: (j: string) => j.replace('@c.us', '@s.whatsapp.net'),
    toEngineJid: (j: string) => j,
    normalizedSelfJid: () => '628177@s.whatsapp.net',
    getEphemeralExpiration,
    toUnixSeconds: (ts: number | { toNumber(): number } | null | undefined) =>
      typeof ts === 'number' ? ts : ts && 'toNumber' in ts ? ts.toNumber() : 0,
    loadLib: () =>
      Promise.resolve({
        normalizeMessageContent: (c: unknown) => c,
        getContentType: () => undefined,
      } as never),
    getStoredMessage,
    putStoredMessage,
    rememberOwnSend: () => undefined,
    recordLidMapping: () => undefined,
    getOnMessageCreate: () => undefined,
    mapMessage: () => Promise.resolve({} as never),
  } as unknown as BaileysMessagingHost;
  return {
    messaging: new BaileysMessaging(host),
    sendMessage,
    getStoredMessage,
    putStoredMessage,
    getEphemeralExpiration,
  };
}

describe('BaileysMessaging.sendInteractiveCtaMessage', () => {
  it('assembles nativeFlowMessage with cta_url button and sends to destination', async () => {
    const { messaging, sendMessage } = makeMessaging();
    const result = await messaging.sendInteractiveCtaMessage('628111@s.whatsapp.net', {
      body: 'Check out our deals',
      displayText: 'Visit Shop',
      url: 'https://example.com/shop',
      header: 'Special Discount',
      footer: 'Valid today only',
    });

    expect(result).toEqual({ id: 'CTA-MSG-1', timestamp: 1700000000 });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const calls = sendMessage.mock.calls as unknown as Array<
      [
        string,
        {
          interactiveMessage?: {
            nativeFlowMessage?: {
              buttons?: Array<{ name: string; buttonParamsJson: string }>;
            };
          };
        },
        Record<string, unknown>?,
      ]
    >;
    const [jid, content] = calls[0];
    expect(jid).toBe('628111@s.whatsapp.net');
    expect(content).toMatchObject({
      interactiveMessage: {
        body: { text: 'Check out our deals' },
        header: { title: 'Special Discount', hasMediaAttachment: false },
        footer: { text: 'Valid today only' },
        nativeFlowMessage: {
          buttons: [
            {
              name: 'cta_url',
              buttonParamsJson: JSON.stringify({
                display_text: 'Visit Shop',
                url: 'https://example.com/shop',
              }),
            },
          ],
        },
      },
    });
  });

  it('includes merchant_url when provided in input', async () => {
    const { messaging, sendMessage } = makeMessaging();
    await messaging.sendInteractiveCtaMessage('628111@s.whatsapp.net', {
      body: 'Order online',
      displayText: 'Order Now',
      url: 'https://example.com/order',
      merchantUrl: 'https://merchant.example.com',
    });

    const calls = sendMessage.mock.calls as unknown as Array<
      [
        string,
        {
          interactiveMessage: {
            nativeFlowMessage: {
              buttons: Array<{ name: string; buttonParamsJson: string }>;
            };
          };
        },
      ]
    >;
    const [, content] = calls[0];
    const button = content.interactiveMessage.nativeFlowMessage.buttons[0];
    expect(JSON.parse(button.buttonParamsJson) as Record<string, unknown>).toEqual({
      display_text: 'Order Now',
      url: 'https://example.com/order',
      merchant_url: 'https://merchant.example.com',
    });
  });

  it('passes ephemeral expiration when chat has disappearing timer set', async () => {
    const { messaging, sendMessage } = makeMessaging({ ephemeralExpiration: 86400 });
    await messaging.sendInteractiveCtaMessage('628111@s.whatsapp.net', {
      body: 'Disappearing promo',
      displayText: 'Claim',
      url: 'https://example.com/claim',
    });

    const calls = sendMessage.mock.calls as unknown as Array<[string, unknown, Record<string, unknown>?]>;
    const [, , options] = calls[0];
    expect(options).toMatchObject({ ephemeralExpiration: 86400 });
  });
});
