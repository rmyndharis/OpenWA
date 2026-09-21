import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import { BadRequestException } from '@nestjs/common';
import { BaileysMessaging, type BaileysMessagingHost } from './baileys-messaging';
import { MessageNotFoundError } from '../../common/errors/message-not-found.error';
import { createLogger } from '../../common/services/logger.service';

const logger = createLogger('baileys-click-button.spec');

const PROMPT = {
  key: { id: 'PROMPT-1', remoteJid: '628111@s.whatsapp.net', fromMe: false },
  message: {
    buttonsMessage: {
      contentText: 'Já é nosso cliente?',
      buttons: [
        { buttonId: 'yes', buttonText: { displayText: 'Sim' } },
        { buttonId: 'no', buttonText: { displayText: 'Não' } },
      ],
    },
  },
};

const LIST_PROMPT = {
  key: { id: 'PROMPT-LIST', remoteJid: '628111@s.whatsapp.net', fromMe: false },
  message: {
    listMessage: {
      sections: [
        {
          rows: [
            { rowId: 'ship_express', title: 'Express' },
            { rowId: 'ship_std', title: 'Standard' },
          ],
        },
      ],
    },
  },
};

const TEMPLATE_PROMPT = {
  key: { id: 'PROMPT-TPL', remoteJid: '628111@s.whatsapp.net', fromMe: false },
  message: {
    templateMessage: {
      hydratedTemplate: {
        hydratedButtons: [
          { index: 1, urlButton: { url: 'https://pay.example', displayText: 'Pay now' } },
          { index: 2, quickReplyButton: { id: 'yes', displayText: 'Sim' } },
        ],
      },
    },
  },
};

function contentTypeOf(message: unknown): string | undefined {
  const content = message as Record<string, unknown> | undefined;
  if (content?.buttonsMessage) return 'buttonsMessage';
  if (content?.templateMessage) return 'templateMessage';
  if (content?.listMessage) return 'listMessage';
  if (content?.interactiveMessage) return 'interactiveMessage';
  return undefined;
}

function makeMessaging(stored: unknown = PROMPT, opts: { ephemeralExpiration?: number } = {}) {
  const sendMessage = jest.fn().mockResolvedValue({
    key: { id: 'CLICK-1', remoteJid: '628111@s.whatsapp.net', fromMe: true },
    messageTimestamp: 1700000000,
  });
  const sock = { sendMessage };
  const getStoredMessage = jest.fn().mockResolvedValue(stored);
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
        getContentType: (c: unknown) => contentTypeOf(c),
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

const contentOf = (sendMessage: jest.Mock): Record<string, unknown> => {
  const [, content] = sendMessage.mock.calls[0] as [string, Record<string, unknown>];
  return content;
};

const optionsOf = (sendMessage: jest.Mock): Record<string, unknown> => {
  const [, , options] = sendMessage.mock.calls[0] as [string, unknown, Record<string, unknown>?];
  return options ?? {};
};

describe('BaileysMessaging.clickButton', () => {
  it('sends a plain buttonReply quoted to the stored prompt', async () => {
    const { messaging, sendMessage, putStoredMessage } = makeMessaging();
    const result = await messaging.clickButton('628111@s.whatsapp.net', 'PROMPT-1', 'yes', 'Sim');
    expect(contentOf(sendMessage)).toEqual({
      buttonReply: { displayText: 'Sim', id: 'yes', index: 0 },
      type: 'plain',
    });
    expect(optionsOf(sendMessage)).toEqual(expect.objectContaining({ quoted: PROMPT }));
    expect(putStoredMessage).toHaveBeenCalled();
    expect(result).toEqual({ id: 'CLICK-1', timestamp: 1700000000, body: 'Sim' });
  });

  it('sends a listReply for a listMessage prompt', async () => {
    const { messaging, sendMessage } = makeMessaging(LIST_PROMPT);
    await messaging.clickButton('628111@s.whatsapp.net', 'PROMPT-LIST', 'ship_std');
    expect(contentOf(sendMessage)).toEqual({
      listReply: {
        title: 'Standard',
        listType: 1,
        singleSelectReply: { selectedRowId: 'ship_std' },
      },
    });
  });

  it('sends a template buttonReply using the hydrated button index', async () => {
    const { messaging, sendMessage } = makeMessaging(TEMPLATE_PROMPT);
    await messaging.clickButton('628111@s.whatsapp.net', 'PROMPT-TPL', 'yes');
    expect(contentOf(sendMessage)).toEqual({
      buttonReply: { displayText: 'Sim', id: 'yes', index: 2 },
      type: 'template',
    });
  });

  it('passes the chat disappearing-messages timer on the click send', async () => {
    const { messaging, sendMessage } = makeMessaging(PROMPT, { ephemeralExpiration: 604800 });
    await messaging.clickButton('628111@s.whatsapp.net', 'PROMPT-1', 'yes', 'Sim');
    expect(optionsOf(sendMessage)).toEqual(expect.objectContaining({ quoted: PROMPT, ephemeralExpiration: 604800 }));
  });

  it('404s when the prompt is not in the store', async () => {
    const { messaging } = makeMessaging(null);
    await expect(messaging.clickButton('628111@s.whatsapp.net', 'MISSING', 'yes')).rejects.toBeInstanceOf(
      MessageNotFoundError,
    );
  });

  it('404s when the prompt belongs to a different chat', async () => {
    const otherChat: WAMessage = {
      ...PROMPT,
      key: { ...PROMPT.key, remoteJid: '628999@s.whatsapp.net' },
    };
    const { messaging, sendMessage } = makeMessaging(otherChat);
    await expect(messaging.clickButton('628111@s.whatsapp.net', 'PROMPT-1', 'yes')).rejects.toBeInstanceOf(
      MessageNotFoundError,
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('400s when buttonId is not among the prompt choices', async () => {
    const { messaging } = makeMessaging();
    await expect(messaging.clickButton('628111@s.whatsapp.net', 'PROMPT-1', 'maybe')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
