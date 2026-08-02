import { BaileysEvents, type BaileysEventsHost } from './baileys-events';
import { createLogger } from '../../common/services/logger.service';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';
import type { WASocket } from '@whiskeysockets/baileys';

/**
 * Minimal Baileys lib stub. `mapMessage` calls `normalizeMessageContent` to unwrap
 * ephemeral / viewOnce / documentWithCaption wrappers; identity is the correct
 * behaviour for already-unwrapped content.
 */
const libStub = {
  normalizeMessageContent: (content: unknown) => content,
} as Awaited<ReturnType<BaileysEventsHost['loadLib']>>;

function makeHost(overrides: Partial<BaileysEventsHost> = {}): BaileysEventsHost {
  const noop = (): void => undefined;
  return {
    // getSocket/getSocketOrNull back the live-call and media-reupload paths only; mapMessage's
    // own media path is never reached here (every media case passes skipMediaDownload: true).
    getSocket: () => ({}) as WASocket,
    getSocketOrNull: () => null,
    logger: createLogger('BaileysEventsSpec'),
    loadLib: () => Promise.resolve(libStub),
    toNeutralJid: (jid: string) => jid,
    normalizedSelfJid: () => '6280000000000@s.whatsapp.net',
    // connectedAt only gates handleMessagesUpsert's history-replay skip; mapMessage itself never
    // reads it.
    connectedAt: 0,
    inboundLimiter: new ConcurrencyLimiter(1),
    recordKeyLidMappings: noop,
    recordMessage: noop,
    recordMessageEdit: noop,
    putStoredMessage: () => undefined,
    getOnMessage: () => undefined,
    getOnMessageCreate: () => undefined,
    getOnMessageRevoked: () => undefined,
    getOnMessageEdited: () => undefined,
    getOnMessageReaction: () => undefined,
    getOnMessageAck: () => undefined,
    getOnGroupEvent: () => undefined,
    getOnCall: () => undefined,
    ...overrides,
  };
}

describe('BaileysEvents.mapMessage', () => {
  it('maps a plain text message', async () => {
    const events = new BaileysEvents(makeHost());

    const incoming = await events.mapMessage(
      {
        key: { id: 'wamid.1', remoteJid: '15550001111@s.whatsapp.net', fromMe: false },
        messageTimestamp: 1_700_000_000,
        message: { conversation: 'hello there' },
      },
      'conversation',
    );

    expect(incoming.body).toBe('hello there');
    expect(incoming.media).toBeUndefined();
    expect(incoming.location).toBeUndefined();
  });

  it('maps a static location, carrying name and address', async () => {
    const events = new BaileysEvents(makeHost());

    const incoming = await events.mapMessage(
      {
        key: { id: 'wamid.2', remoteJid: '15550001111@s.whatsapp.net', fromMe: false },
        messageTimestamp: 1_700_000_000,
        message: {
          locationMessage: {
            degreesLatitude: -6.2,
            degreesLongitude: 106.8,
            name: 'Monas',
            address: 'Jakarta Pusat',
          },
        },
      },
      'locationMessage',
    );

    expect(incoming.location).toEqual({
      latitude: -6.2,
      longitude: 106.8,
      description: 'Monas',
      address: 'Jakarta Pusat',
    });
  });

  it('maps a LIVE location without name/address (only the static variant carries them)', async () => {
    const events = new BaileysEvents(makeHost());

    const incoming = await events.mapMessage(
      {
        key: { id: 'wamid.3', remoteJid: '15550001111@s.whatsapp.net', fromMe: false },
        messageTimestamp: 1_700_000_000,
        message: { liveLocationMessage: { degreesLatitude: 1.5, degreesLongitude: 2.5 } },
      },
      'liveLocationMessage',
    );

    expect(incoming.location?.latitude).toBe(1.5);
    expect(incoming.location?.longitude).toBe(2.5);
    expect(incoming.location?.description).toBeUndefined();
    expect(incoming.location?.address).toBeUndefined();
  });

  it('emits an omitted media marker when the download is skipped, keeping mimetype and size', async () => {
    const events = new BaileysEvents(makeHost());

    const incoming = await events.mapMessage(
      {
        key: { id: 'wamid.4', remoteJid: '15550001111@s.whatsapp.net', fromMe: true },
        messageTimestamp: 1_700_000_000,
        message: { imageMessage: { mimetype: 'image/jpeg', fileLength: 1234, caption: 'look' } },
      },
      'imageMessage',
      { skipMediaDownload: true },
    );

    expect(incoming.media).toEqual({
      mimetype: 'image/jpeg',
      filename: undefined,
      omitted: true,
      sizeBytes: 1234,
    });
    expect(incoming.body).toBe('look');
  });

  it('carries the document filename onto the omitted marker', async () => {
    const events = new BaileysEvents(makeHost());

    const incoming = await events.mapMessage(
      {
        key: { id: 'wamid.5', remoteJid: '15550001111@s.whatsapp.net', fromMe: true },
        messageTimestamp: 1_700_000_000,
        message: { documentMessage: { mimetype: 'application/pdf', fileLength: 99, fileName: 'invoice.pdf' } },
      },
      'documentMessage',
      { skipMediaDownload: true },
    );

    expect(incoming.media?.filename).toBe('invoice.pdf');
    expect(incoming.media?.omitted).toBe(true);
  });

  it('resolves a quoted message from contextInfo', async () => {
    const events = new BaileysEvents(makeHost());

    const incoming = await events.mapMessage(
      {
        key: { id: 'wamid.6', remoteJid: '15550001111@s.whatsapp.net', fromMe: false },
        messageTimestamp: 1_700_000_000,
        message: {
          extendedTextMessage: {
            text: 'replying',
            contextInfo: { stanzaId: 'wamid.original', quotedMessage: { conversation: 'the original' } },
          },
        },
      },
      'extendedTextMessage',
    );

    expect(incoming.quotedMessage?.id).toBe('wamid.original');
    expect(incoming.quotedMessage?.body).toBe('the original');
  });

  it('leaves quotedMessage undefined when contextInfo has no stanzaId', async () => {
    const events = new BaileysEvents(makeHost());

    const incoming = await events.mapMessage(
      {
        key: { id: 'wamid.7', remoteJid: '15550001111@s.whatsapp.net', fromMe: false },
        messageTimestamp: 1_700_000_000,
        message: {
          extendedTextMessage: { text: 'no quote', contextInfo: { quotedMessage: { conversation: 'orphan' } } },
        },
      },
      'extendedTextMessage',
    );

    expect(incoming.quotedMessage).toBeUndefined();
  });
});
