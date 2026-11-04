import type { WAMessage } from '@whiskeysockets/baileys';
import type { IncomingMessage } from '../interfaces/whatsapp-engine.interface';
import { BaileysHistory, BaileysHistoryHost } from './baileys-history';
import { extractBaileysContext } from './baileys-message-mapper';

const contextInfo = {
  stanzaId: 'QUOTED1',
  quotedMessage: { conversation: 'original' },
  mentionedJid: ['628111@s.whatsapp.net'],
};

describe('quote and mentions on a content type without a dedicated carrier', () => {
  it.each([
    ['a contact card', { contactMessage: { vcard: 'BEGIN:VCARD', contextInfo } }],
    ['a live location', { liveLocationMessage: { degreesLatitude: 1, degreesLongitude: 2, contextInfo } }],
    ['a poll', { pollCreationMessageV3: { name: 'Q', contextInfo } }],
    [
      'a poll in a V4 wrapper',
      { pollCreationMessageV4: { message: { pollCreationMessage: { name: 'Q', contextInfo } } } },
    ],
  ])('reads them from %s', (_name, content) => {
    expect(extractBaileysContext(content)).toMatchObject({
      quotedMessage: { id: 'QUOTED1', body: 'original' },
      mentionedJids: ['628111@s.whatsapp.net'],
    });
  });

  it('prefers the carrier a text or media message uses', () => {
    const context = extractBaileysContext({
      extendedTextMessage: { contextInfo: { ...contextInfo, stanzaId: 'FROM-TEXT' } },
      contactMessage: { contextInfo },
    });

    expect(context.quotedMessage?.id).toBe('FROM-TEXT');
  });
});

describe('quote and mentions on a history message', () => {
  it('maps them like a live message', async () => {
    const received: IncomingMessage[][] = [];
    const host = {
      loadLib: () =>
        Promise.resolve({
          normalizeMessageContent: (m: unknown) => m,
          getContentType: (m: object) => Object.keys(m)[0],
          proto: { Message: { ProtocolMessage: { Type: { REVOKE: 0 } } } },
        }),
      normalizedSelfJid: () => 'me@s.whatsapp.net',
      toNeutralJid: (id: string) => id,
      extractEphemeralDuration: () => undefined,
      recordMessage: jest.fn(),
      recordMessageEdit: jest.fn(),
      upsertContacts: jest.fn(),
      getOnHistoryMessages: () => (messages: IncomingMessage[]) => {
        received.push(messages);
      },
      applyHistoryRevoke: (key: WAMessage['key']) => Promise.resolve(key),
    } as unknown as BaileysHistoryHost;

    await new BaileysHistory(host).captureHistoryMessages([
      {
        key: { id: 'H1', remoteJid: '628111@s.whatsapp.net', fromMe: false },
        message: { extendedTextMessage: { text: 'reply', contextInfo } },
        messageTimestamp: 100,
      },
    ] as WAMessage[]);

    expect(received[0][0]).toMatchObject({
      quotedMessage: { id: 'QUOTED1', body: 'original' },
      mentionedIds: ['628111@s.whatsapp.net'],
    });
  });
});
