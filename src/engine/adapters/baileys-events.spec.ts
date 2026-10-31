import { createCipheriv, createHmac } from 'node:crypto';
import { BaileysEvents, type BaileysEventsHost } from './baileys-events';
import { createLogger } from '../../common/services/logger.service';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';
import { inboundMediaConcurrency } from './inbound-media-cap';
import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import type { Contact, EventResponseEvent, MessageReceiptEvent } from '../interfaces/whatsapp-engine.interface';

/**
 * `downloadMediaMessage` is a jest mock, not a silent no-op: the real-download branch
 * (`resolveInboundMedia` in baileys-events.ts, reached whenever `isMediaType` is true and skipMediaDownload
 * isn't set) calls `b.downloadMediaMessage(...)`, and this stub implements nothing else that
 * branch needs — so if a non-media contentType were ever misclassified as media (the exact
 * slip the Plan 2 mapper extraction could introduce), the call throws and that throw is caught
 * by its try/catch around `downloadInboundMediaCapped`, leaving `media` unset. An `incoming.media` assertion alone
 * can't tell "correctly not classified as media" from "misclassified, then crashed and got
 * swallowed" — asserting `downloadMediaMessage` was never called can.
 */
const downloadMediaMessage = jest.fn();

/**
 * A fresh async-iterable stream of the given chunks — the shape `downloadMediaMessage(msg, 'stream', ...)`
 * resolves to (see `downloadInboundMediaCapped` in baileys-events.ts). Mirrors the identically-named
 * helper in `baileys.adapter.spec.ts`. Without this, the bare `jest.fn()` above resolves to `undefined`,
 * `for await` over it throws, and the real-download branch's own try/catch (in `resolveInboundMedia`)
 * swallows that throw before `media` is ever assigned — so that branch can never be exercised at all.
 */
function streamOf(...chunks: Buffer[]): AsyncIterable<Buffer> & { destroy: () => void } {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
    destroy: jest.fn(),
  };
}

/**
 * mapMessage reads NORMALIZED content in four places and says so three times in its own comments:
 * a disappearing (ephemeralMessage), view-once, or captioned-document message nests the real
 * payload under a wrapper. An identity stub makes `normalized === content`, which cannot fail when
 * a caller is handed the raw content by mistake — the likeliest slip when these regions move.
 *
 * Mirrors the real implementation (`node_modules/@whiskeysockets/baileys/lib/Utils/messages.js`,
 * `normalizeMessageContent`): it loops, bounded at 5 iterations same as the real max-iterations
 * guard, unwrapping one FutureProofMessage wrapper per pass — so a combined wrapper (e.g. a
 * view-once photo inside a disappearing chat: ephemeralMessage → viewOnceMessage → imageMessage)
 * fully unwraps instead of stopping one level short. `editedMessage` here is `Message.editedMessage`
 * (the FutureProofMessage wrapper), distinct from `ProtocolMessage.editedMessage` (a plain
 * `IMessage`), which `baileys-events.ts` handles separately in its MESSAGE_EDIT branch.
 */
type FutureProofMessage = { message?: unknown } | null | undefined;

interface WrapperEnvelope {
  ephemeralMessage?: FutureProofMessage;
  viewOnceMessage?: FutureProofMessage;
  documentWithCaptionMessage?: FutureProofMessage;
  viewOnceMessageV2?: FutureProofMessage;
  viewOnceMessageV2Extension?: FutureProofMessage;
  editedMessage?: FutureProofMessage;
}

const getFutureProofMessage = (message: WrapperEnvelope | null | undefined): FutureProofMessage =>
  message?.ephemeralMessage ??
  message?.viewOnceMessage ??
  message?.documentWithCaptionMessage ??
  message?.viewOnceMessageV2 ??
  message?.viewOnceMessageV2Extension ??
  message?.editedMessage;

const normalizeMessageContent = (content: Record<string, unknown> | null | undefined): unknown => {
  if (!content) return undefined;
  let current: unknown = content;
  for (let i = 0; i < 5; i++) {
    const inner = getFutureProofMessage(current as WrapperEnvelope | null | undefined);
    if (!inner) break;
    current = inner.message;
  }
  return current;
};

// Baileys' own picks for the node downloadMediaMessage fetches: unwrap, then the first content key.
const extractMessageContent = (content: Record<string, unknown> | null | undefined): unknown =>
  normalizeMessageContent(content);
const getContentType = (content: Record<string, unknown> | undefined): string | undefined =>
  Object.keys(content ?? {}).find(k => k === 'conversation' || k.endsWith('Message'));

const libStub = {
  normalizeMessageContent,
  extractMessageContent,
  getContentType,
  downloadMediaMessage,
} as unknown as Awaited<ReturnType<BaileysEventsHost['loadLib']>>;

function makeHost(overrides: Partial<BaileysEventsHost> = {}): BaileysEventsHost {
  const noop = (): void => undefined;
  return {
    // getSocket/getSocketOrNull back the live-call path and the media-reupload handle
    // (`downloadInboundMediaCapped` reads `getSocket().updateMediaMessage` as the `reuploadRequest`
    // Baileys' downloadMediaMessage expects — present so the real-download branch has a realistic host).
    getSocket: () => ({ updateMediaMessage: jest.fn() }) as unknown as WASocket,
    getSocketOrNull: () => null,
    logger: createLogger('BaileysEventsSpec'),
    loadLib: () => Promise.resolve(libStub),
    getFetchDispatcher: () => undefined,
    toNeutralJid: (jid: string) => jid,
    normalizedSelfJid: () => '6280000000000@s.whatsapp.net',
    inboundLimiter: new ConcurrencyLimiter(inboundMediaConcurrency()),
    recordKeyLidMappings: noop,
    recordMessage: noop,
    recordMessageEdit: noop,
    consumeOwnSend: () => false,
    getStoredMessage: () => undefined,
    putStoredMessage: () => undefined,
    updateStoredMessage: () => undefined,
    removeStoredMessage: () => undefined,
    getOnMessage: () => undefined,
    getOnMessageCreate: () => undefined,
    getOnMessageRevoked: () => undefined,
    getOnMessageEdited: () => undefined,
    getOnMessageReaction: () => undefined,
    getOnMessageAck: () => undefined,
    getOnMessageReceipt: () => undefined,
    getOnGroupEvent: () => undefined,
    getOnEventResponse: () => undefined,
    findContact: () => null,
    getOnCall: () => undefined,
    getOnPresenceUpdate: () => undefined,
    getOnCallOutcome: () => undefined,
    ...overrides,
  };
}

describe('BaileysEvents.mapMessage', () => {
  // Hoisted: every case uses the same plain fake host; a test that needs a different one can
  // still call makeHost(overrides) directly and shadow this.
  let events: BaileysEvents;

  beforeEach(() => {
    downloadMediaMessage.mockClear();
    events = new BaileysEvents(makeHost());
  });

  it('maps a plain text message', async () => {
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
    // Guards against an isMediaType false positive on a non-media contentType (see the
    // downloadMediaMessage doc comment above) — not just that `media` happens to end up unset.
    expect(downloadMediaMessage).not.toHaveBeenCalled();
  });

  it('maps a static location, carrying name and address', async () => {
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
    expect(downloadMediaMessage).not.toHaveBeenCalled();
  });

  it('maps a LIVE location without name/address (only the static variant carries them)', async () => {
    const incoming = await events.mapMessage(
      {
        key: { id: 'wamid.3', remoteJid: '15550001111@s.whatsapp.net', fromMe: false },
        messageTimestamp: 1_700_000_000,
        message: {
          liveLocationMessage: {
            degreesLatitude: 1.5,
            degreesLongitude: 2.5,
            // ILiveLocationMessage has neither field in the real proto; present here so a slip that
            // reads them off the live variant (instead of the static-only `staticLm`) is caught.
            name: 'SHOULD BE IGNORED',
            address: 'SHOULD BE IGNORED',
          },
        } as WAMessage['message'],
      },
      'liveLocationMessage',
    );

    expect(incoming.location?.latitude).toBe(1.5);
    expect(incoming.location?.longitude).toBe(2.5);
    expect(incoming.location?.description).toBeUndefined();
    expect(incoming.location?.address).toBeUndefined();
    expect(downloadMediaMessage).not.toHaveBeenCalled();
  });

  it('emits an omitted media marker when the download is skipped, keeping mimetype and size', async () => {
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

  it('classifies a sticker as media (pins stickerMessage in the isMediaType disjunction)', async () => {
    const incoming = await events.mapMessage(
      {
        key: { id: 'wamid.8', remoteJid: '15550001111@s.whatsapp.net', fromMe: true },
        messageTimestamp: 1_700_000_000,
        message: { stickerMessage: { mimetype: 'image/webp', fileLength: 555 } },
      },
      'stickerMessage',
      { skipMediaDownload: true },
    );

    expect(incoming.media).toEqual({
      mimetype: 'image/webp',
      filename: undefined,
      omitted: true,
      sizeBytes: 555,
    });
  });

  it('classifies a documentWithCaptionMessage as media (pins it in the isMediaType disjunction)', async () => {
    const incoming = await events.mapMessage(
      {
        key: { id: 'wamid.9', remoteJid: '15550001111@s.whatsapp.net', fromMe: true },
        messageTimestamp: 1_700_000_000,
        message: {
          documentMessage: {
            mimetype: 'application/pdf',
            fileLength: 321,
            fileName: 'contract.pdf',
            caption: 'signed',
          },
        },
      },
      'documentWithCaptionMessage',
      { skipMediaDownload: true },
    );

    expect(incoming.media).toEqual({
      mimetype: 'application/pdf',
      filename: 'contract.pdf',
      omitted: true,
      sizeBytes: 321,
    });
  });

  it('resolves a quoted message from contextInfo', async () => {
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
    expect(downloadMediaMessage).not.toHaveBeenCalled();
  });

  it('leaves quotedMessage undefined when contextInfo has no stanzaId', async () => {
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
    expect(downloadMediaMessage).not.toHaveBeenCalled();
  });

  it('resolves a quoted reply, mention and disappearing timer riding on an imageMessage context (not extendedTextMessage)', async () => {
    const incoming = await events.mapMessage(
      {
        key: { id: 'wamid.10', remoteJid: '15550001111@s.whatsapp.net', fromMe: false },
        messageTimestamp: 1_700_000_000,
        message: {
          imageMessage: {
            mimetype: 'image/jpeg',
            caption: 'look',
            contextInfo: {
              stanzaId: 'wamid.original2',
              expiration: 604800,
              mentionedJid: ['15559998888@s.whatsapp.net'],
              // No `conversation` on the quoted sub-message — only `imageMessage.caption` — so this
              // also pins the qBody fallback chain beyond its first (`conversation`) arm.
              quotedMessage: { imageMessage: { caption: 'quoted image caption' } },
            },
          },
        },
      },
      'imageMessage',
      { skipMediaDownload: true },
    );

    expect(incoming.quotedMessage?.id).toBe('wamid.original2');
    expect(incoming.quotedMessage?.body).toBe('quoted image caption');
    expect(incoming.ephemeralDuration).toBe(604800);
    expect(incoming.mentionedIds).toEqual(['15559998888@s.whatsapp.net']);
  });

  it('reads a location nested under an ephemeral wrapper, not the raw content', async () => {
    const incoming = await events.mapMessage(
      {
        key: { id: 'wamid.wrapped', remoteJid: '15550001111@s.whatsapp.net', fromMe: false },
        messageTimestamp: 1_700_000_000,
        message: {
          ephemeralMessage: {
            message: {
              locationMessage: {
                degreesLatitude: -6.2,
                degreesLongitude: 106.8,
                name: 'Monas',
                address: 'Jakarta Pusat',
              },
            },
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
    expect(downloadMediaMessage).not.toHaveBeenCalled();
  });

  it('reads a quoted reply and disappearing timer nested under an ephemeral wrapper, not the raw content', async () => {
    const incoming = await events.mapMessage(
      {
        key: { id: 'wamid.wrapped2', remoteJid: '15550001111@s.whatsapp.net', fromMe: false },
        messageTimestamp: 1_700_000_000,
        message: {
          ephemeralMessage: {
            message: {
              extendedTextMessage: {
                text: 'replying',
                contextInfo: {
                  stanzaId: 'wamid.original3',
                  expiration: 86400,
                  quotedMessage: { conversation: 'the original, wrapped' },
                },
              },
            },
          },
        },
      },
      'extendedTextMessage',
    );

    expect(incoming.quotedMessage?.id).toBe('wamid.original3');
    expect(incoming.quotedMessage?.body).toBe('the original, wrapped');
    expect(incoming.ephemeralDuration).toBe(86400);
    expect(downloadMediaMessage).not.toHaveBeenCalled();
  });

  it('reads image media nested under an ephemeral wrapper, not the raw content', async () => {
    const incoming = await events.mapMessage(
      {
        key: { id: 'wamid.wrapped3', remoteJid: '15550001111@s.whatsapp.net', fromMe: true },
        messageTimestamp: 1_700_000_000,
        message: {
          ephemeralMessage: {
            message: {
              imageMessage: { mimetype: 'image/jpeg', fileLength: 2048 },
            },
          },
        },
      },
      'imageMessage',
      { skipMediaDownload: true },
    );

    expect(incoming.media).toEqual({
      mimetype: 'image/jpeg',
      filename: undefined,
      omitted: true,
      sizeBytes: 2048,
    });
  });

  it('reads image media nested TWO levels deep (a view-once photo inside a disappearing chat), proving normalization recurses', async () => {
    const incoming = await events.mapMessage(
      {
        key: { id: 'wamid.wrapped4', remoteJid: '15550001111@s.whatsapp.net', fromMe: true },
        messageTimestamp: 1_700_000_000,
        message: {
          ephemeralMessage: {
            message: {
              viewOnceMessage: {
                message: {
                  imageMessage: { mimetype: 'image/png', fileLength: 4096 },
                },
              },
            },
          },
        },
      },
      'imageMessage',
      { skipMediaDownload: true },
    );

    expect(incoming.media).toEqual({
      mimetype: 'image/png',
      filename: undefined,
      omitted: true,
      sizeBytes: 4096,
    });
  });

  it('downloads image media nested under an ephemeral wrapper, not the raw content (the real-download / pre-download-gate branch, not the skip-marker branch)', async () => {
    const buf = Buffer.from('IMGDATA');
    downloadMediaMessage.mockResolvedValueOnce(streamOf(buf));

    const incoming = await events.mapMessage(
      {
        key: { id: 'wamid.wrapped5', remoteJid: '15550001111@s.whatsapp.net', fromMe: false },
        messageTimestamp: 1_700_000_000,
        message: {
          ephemeralMessage: {
            message: {
              imageMessage: { mimetype: 'image/jpeg', fileLength: buf.byteLength },
            },
          },
        },
      },
      'imageMessage',
      // No skipMediaDownload here — this routes through the pre-download-gate + streaming-download
      // branch (`resolveInboundMedia`), not the omitted-marker branch every other media case in
      // this file exercises via `{ skipMediaDownload: true }`.
    );

    // A completed download's media carries `data` (base64), not `omitted`/`sizeBytes` — asserting the
    // full shape (not just mimetype) proves this took the real-download path, not the omitted marker.
    expect(incoming.media).toEqual({
      mimetype: 'image/jpeg',
      filename: undefined,
      data: buf.toString('base64'),
    });
    expect(downloadMediaMessage).toHaveBeenCalledTimes(1);
  });
});

describe('BaileysEvents inbound media source', () => {
  const download = (message: Record<string, unknown>) =>
    new BaileysEvents(makeHost()).mapMessage(
      {
        key: { id: 'wamid.src', remoteJid: '15550001111@s.whatsapp.net', fromMe: false },
        messageTimestamp: 1_700_000_000,
        message,
      },
      'imageMessage',
    );

  beforeEach(() => downloadMediaMessage.mockReset());

  it.each([
    ['a plain-http url', { url: 'http://127.0.0.1/latest/meta-data/' }],
    ['a url outside whatsapp.net', { url: 'https://internal.example/x' }],
    ['a whatsapp.net url on another port', { url: 'https://mmg.whatsapp.net:8080/x' }],
    ['a directPath that rewrites the host', { url: 'https://mmg.whatsapp.net/x', directPath: '@internal.example/x' }],
    ['a directPath under a foreign url host', { url: 'https://internal.example/x', directPath: '/v/t62/x' }],
  ])('does not fetch media whose address is %s', async (_name, source) => {
    const incoming = await download({ imageMessage: { mimetype: 'image/jpeg', fileLength: 7, ...source } });
    expect(downloadMediaMessage).not.toHaveBeenCalled();
    expect(incoming.media).toEqual({ mimetype: 'image/jpeg', filename: undefined, omitted: true, sizeBytes: 7 });
  });

  it('checks the node Baileys downloads, not the first media type this file looks for', async () => {
    await download({
      documentMessage: { mimetype: 'application/pdf', fileLength: 7, url: 'http://127.0.0.1/' },
      imageMessage: { mimetype: 'image/jpeg', fileLength: 7, url: 'https://mmg.whatsapp.net/x' },
    });
    expect(downloadMediaMessage).not.toHaveBeenCalled();
  });

  it('still downloads media served from WhatsApp hosts', async () => {
    const buf = Buffer.from('IMGDATA');
    downloadMediaMessage.mockResolvedValueOnce(streamOf(buf));
    const incoming = await download({
      imageMessage: {
        mimetype: 'image/jpeg',
        fileLength: buf.byteLength,
        url: 'https://mmg.whatsapp.net/v/t62/x.enc',
        directPath: '/v/t62/x.enc',
      },
    });
    expect(downloadMediaMessage).toHaveBeenCalledTimes(1);
    expect(incoming.media).toEqual({ mimetype: 'image/jpeg', filename: undefined, data: buf.toString('base64') });
  });

  it('refuses a re-upload answer that points outside WhatsApp hosts', async () => {
    downloadMediaMessage.mockImplementationOnce(
      async (
        _m: WAMessage,
        _t: string,
        _o: unknown,
        ctx: { reuploadRequest: (m: WAMessage) => Promise<WAMessage> },
      ) => {
        await ctx.reuploadRequest(_m);
        return streamOf(Buffer.from('x'));
      },
    );
    const updateMediaMessage = jest.fn((m: WAMessage) =>
      Promise.resolve({
        ...m,
        message: { imageMessage: { url: 'https://mmg.whatsapp.net', directPath: '@internal.example/x' } },
      }),
    );
    const incoming = await new BaileysEvents(
      makeHost({ getSocket: () => ({ updateMediaMessage }) as unknown as WASocket }),
    ).mapMessage(
      {
        key: { id: 'wamid.re', remoteJid: '15550001111@s.whatsapp.net', fromMe: false },
        messageTimestamp: 1_700_000_000,
        message: { imageMessage: { mimetype: 'image/jpeg', fileLength: 1, url: 'https://mmg.whatsapp.net/x' } },
      },
      'imageMessage',
    );
    expect(updateMediaMessage).toHaveBeenCalledTimes(1);
    expect(incoming.media).toEqual({ mimetype: 'image/jpeg', filename: undefined, omitted: true, sizeBytes: 1 });
  });
});

describe('BaileysEvents store writes across an unlink', () => {
  // Holds every message's processing at its first await until released, the way a media download
  // that outlives the socket would.
  const held = () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const putStoredMessage = jest.fn(() => Promise.resolve());
    const recordKeyLidMappings = jest.fn();
    const events = new BaileysEvents(
      makeHost({
        loadLib: () => gate.then(() => libStub),
        putStoredMessage,
        recordKeyLidMappings,
        getOnMessage: () => jest.fn(),
      }),
    );
    events.handleMessagesUpsert({
      type: 'notify',
      messages: [
        {
          key: {
            id: 'wamid.unlink',
            remoteJid: '123456789@lid',
            remoteJidAlt: '15550001111@s.whatsapp.net',
            fromMe: false,
          },
          messageTimestamp: 1_700_000_000,
          message: { conversation: 'hi' },
        },
      ],
    });
    const settle = async () => {
      release();
      for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
    };
    return { events, putStoredMessage, recordKeyLidMappings, settle };
  };

  it('stores a message whose processing finishes with the account still linked', async () => {
    const { putStoredMessage, recordKeyLidMappings, settle } = held();
    await settle();
    expect(putStoredMessage).toHaveBeenCalledTimes(1);
    expect(recordKeyLidMappings).toHaveBeenCalledTimes(1);
  });

  it('does not store a message still being processed when the account was unlinked', async () => {
    const { events, putStoredMessage, recordKeyLidMappings, settle } = held();
    events.fenceStoredWrites();
    await settle();
    expect(putStoredMessage).not.toHaveBeenCalled();
    expect(recordKeyLidMappings).not.toHaveBeenCalled();
  });
});

describe('BaileysEvents record of messages deleted for everyone', () => {
  it('forgets the oldest id once it holds its limit', () => {
    const events = new BaileysEvents(makeHost());
    const limit = BaileysEvents.DELETED_FOR_EVERYONE_LIMIT;
    for (let i = 0; i <= limit; i++) events.markDeletedForEveryone(`M${i}`);

    expect(events.wasDeletedForEveryone('M0')).toBe(false);
    expect(events.wasDeletedForEveryone('M1')).toBe(true);
    expect(events.wasDeletedForEveryone(`M${limit}`)).toBe(true);
  });
});

describe('BaileysEvents.handleMessageReceiptUpdate', () => {
  const group = '120363000000000001@g.us';
  const member = '6281111111111@s.whatsapp.net';

  function setup(overrides: Partial<BaileysEventsHost> = {}) {
    const onMessageReceipt = jest.fn();
    const events = new BaileysEvents(makeHost({ getOnMessageReceipt: () => onMessageReceipt, ...overrides }));
    return { events, onMessageReceipt };
  }

  it('reports one event per recipient receipt of a message the account sent', () => {
    const { events, onMessageReceipt } = setup();
    events.handleMessageReceiptUpdate([
      {
        key: { id: 'OUT1', remoteJid: group, fromMe: true },
        receipt: { userJid: member, receiptTimestamp: 1700000000 },
      },
      { key: { id: 'OUT1', remoteJid: group, fromMe: true }, receipt: { userJid: member, readTimestamp: 1700000060 } },
    ]);
    expect(onMessageReceipt.mock.calls).toEqual([
      [{ messageId: 'OUT1', chatId: group, participant: member, status: 'delivered', timestamp: 1700000000 }],
      [{ messageId: 'OUT1', chatId: group, participant: member, status: 'read', timestamp: 1700000060 }],
    ]);
  });

  it('splits a buffered entry that carries several timestamps into one event per status', () => {
    const { events, onMessageReceipt } = setup();
    events.handleMessageReceiptUpdate([
      {
        key: { id: 'OUT1', remoteJid: group, fromMe: true },
        receipt: { userJid: member, receiptTimestamp: 1, readTimestamp: 2, playedTimestamp: 3 },
      },
    ]);
    const calls = onMessageReceipt.mock.calls as Array<[MessageReceiptEvent]>;
    expect(calls.map(([e]) => [e.status, e.timestamp])).toEqual([
      ['delivered', 1],
      ['read', 2],
      ['played', 3],
    ]);
  });

  it("drops receipts from the account's own devices, in either dialect", () => {
    const { events, onMessageReceipt } = setup({
      getSocketOrNull: () =>
        ({ user: { id: '6280000000000:3@s.whatsapp.net', lid: '99999@lid' } }) as unknown as WASocket,
    });
    events.handleMessageReceiptUpdate([
      {
        key: { id: 'OUT1', remoteJid: group, fromMe: true },
        receipt: { userJid: '6280000000000@s.whatsapp.net', readTimestamp: 1 },
      },
      { key: { id: 'OUT1', remoteJid: group, fromMe: true }, receipt: { userJid: '99999@lid', readTimestamp: 1 } },
    ]);
    expect(onMessageReceipt).not.toHaveBeenCalled();
  });

  it('ignores receipts for messages the account did not send, and malformed entries', () => {
    const { events, onMessageReceipt } = setup();
    events.handleMessageReceiptUpdate([
      { key: { id: 'IN1', remoteJid: group, fromMe: false }, receipt: { userJid: member, readTimestamp: 1 } },
      { key: { remoteJid: group, fromMe: true }, receipt: { userJid: member, readTimestamp: 1 } },
      { key: { id: 'OUT1', remoteJid: group, fromMe: true }, receipt: { readTimestamp: 1 } },
      { key: { id: 'OUT1', remoteJid: group, fromMe: true }, receipt: { userJid: member } },
    ]);
    expect(onMessageReceipt).not.toHaveBeenCalled();
  });

  it('reports the receipts of a status post as well as a group message', () => {
    const { events, onMessageReceipt } = setup();
    events.handleMessageReceiptUpdate([
      {
        key: { id: 'ST1', remoteJid: 'status@broadcast', fromMe: true },
        receipt: { userJid: member, readTimestamp: 5 },
      },
    ]);
    expect(onMessageReceipt.mock.calls).toEqual([
      [{ messageId: 'ST1', chatId: 'status@broadcast', participant: member, status: 'read', timestamp: 5 }],
    ]);
  });

  // message.receipt is documented for group and status messages only, which is the split Baileys itself makes
  // (1:1 receipts arrive as messages.update). A list the phone filled in reaches this handler through a
  // message's own userReceipt, whatever the chat, so the handler holds the line.
  it.each([
    ['a 1:1 chat', '6282222222222@s.whatsapp.net'],
    ['a 1:1 chat in the lid dialect', '55555@lid'],
    ['a broadcast list', '1700000000@broadcast'],
    ['a channel', '120363000000000002@newsletter'],
    ['a jid in a domain no kind is known for', '120363000000000003@bot'],
    ['another unrecognised domain', '12345@interop'],
  ])('does not report a receipt for %s', (_kind, remoteJid) => {
    const { events, onMessageReceipt } = setup();
    events.handleMessageReceiptUpdate([
      {
        key: { id: 'OUT1', remoteJid, fromMe: true },
        receipt: { userJid: member, receiptTimestamp: 1, readTimestamp: 2 },
      },
    ]);
    expect(onMessageReceipt).not.toHaveBeenCalled();
  });

  it('neutralises the chat and participant ids', () => {
    const { events, onMessageReceipt } = setup({ toNeutralJid: (jid: string) => `n:${jid}` });
    events.handleMessageReceiptUpdate([
      { key: { id: 'OUT1', remoteJid: group, fromMe: true }, receipt: { userJid: '55555@lid', readTimestamp: 1 } },
    ]);
    expect(onMessageReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: `n:${group}`, participant: 'n:55555@lid' }),
    );
  });
});

// Baileys' event buffer merges a receipt that lands while a message's own upsert is still buffered (about
// 100 ms after the send, or inside an offline replay) into that upsert as `userReceipt`, and raises no
// message-receipt.update for it.
describe('BaileysEvents.handleMessagesUpsert receipts merged into the upsert', () => {
  const group = '120363000000000001@g.us';
  const member = '6281111111111@s.whatsapp.net';
  const other = '6282222222222@s.whatsapp.net';
  const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
  const upsert = (userReceipt?: unknown[], fromMe = true): Parameters<BaileysEvents['handleMessagesUpsert']>[0] =>
    ({
      type: 'append',
      messages: [
        {
          key: { id: 'OUT1', remoteJid: group, fromMe },
          messageTimestamp: 1_700_000_000,
          message: { conversation: 'hi' },
          ...(userReceipt ? { userReceipt } : {}),
        },
      ],
    }) as Parameters<BaileysEvents['handleMessagesUpsert']>[0];
  const merged = [
    { userJid: member, receiptTimestamp: 1_700_000_001 },
    { userJid: other, receiptTimestamp: 1_700_000_002, readTimestamp: 1_700_000_005 },
  ];
  const reported = (onMessageReceipt: jest.Mock): unknown[] =>
    (onMessageReceipt.mock.calls as Array<[MessageReceiptEvent]>).map(([e]) => [e.participant, e.status, e.timestamp]);

  it('reports them for the echo of a message this session sent, which is still skipped', async () => {
    const onMessageReceipt = jest.fn();
    const onMessageCreate = jest.fn();
    const events = new BaileysEvents(
      makeHost({
        getOnMessageReceipt: () => onMessageReceipt,
        getOnMessageCreate: () => onMessageCreate,
        consumeOwnSend: id => id === 'OUT1',
      }),
    );

    events.handleMessagesUpsert(upsert(merged));
    await flush();

    expect(reported(onMessageReceipt)).toEqual([
      [member, 'delivered', 1_700_000_001],
      [other, 'delivered', 1_700_000_002],
      [other, 'read', 1_700_000_005],
    ]);
    expect(onMessageCreate).not.toHaveBeenCalled();
  });

  it('reports them for a message the phone sent while the gateway was down, which is still processed', async () => {
    const onMessageReceipt = jest.fn();
    const onMessageCreate = jest.fn();
    const events = new BaileysEvents(
      makeHost({ getOnMessageReceipt: () => onMessageReceipt, getOnMessageCreate: () => onMessageCreate }),
    );

    events.handleMessagesUpsert(upsert(merged));
    for (let i = 0; i < 5; i++) await flush();

    expect(reported(onMessageReceipt)).toHaveLength(3);
    expect(onMessageCreate).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['carries none', upsert(undefined)],
    ['carries an empty list', upsert([])],
    ['is not one the account sent', upsert(merged, false)],
  ])('reports nothing for a message that %s', async (_label, event) => {
    const onMessageReceipt = jest.fn();
    const events = new BaileysEvents(makeHost({ getOnMessageReceipt: () => onMessageReceipt }));

    events.handleMessagesUpsert(event);
    for (let i = 0; i < 5; i++) await flush();

    expect(onMessageReceipt).not.toHaveBeenCalled();
  });
});

// The same buffer merges a 1:1 delivery or read ack that lands within about 100 ms of a message's own upsert
// into that upsert as `status`, and raises no messages.update for it, and so does a rejection by the server
// (status ERROR). An echo carries PENDING and a message the phone typed carries SERVER_ACK before any ack.
describe('BaileysEvents.handleMessagesUpsert acks merged into the upsert', () => {
  const partner = '6281111111111@s.whatsapp.net';
  const group = '120363000000000001@g.us';
  const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 8; i++) await flush();
  };
  const upsert = (
    status: number | null | undefined,
    over: { fromMe?: boolean; remoteJid?: string } = {},
  ): Parameters<BaileysEvents['handleMessagesUpsert']>[0] => ({
    type: 'append',
    messages: [
      {
        key: { id: 'OUT1', remoteJid: over.remoteJid ?? partner, fromMe: over.fromMe ?? true },
        messageTimestamp: 1_700_000_000,
        message: { conversation: 'hi' },
        ...(status === undefined ? {} : { status }),
      },
    ],
  });

  it.each([
    [3, 'delivered'],
    [4, 'read'],
    [5, 'read'],
    [0, 'failed'],
  ])(
    'reports status %i of the echo of a message this session sent as %s, and still skips the echo',
    async (status, expected) => {
      const onMessageAck = jest.fn();
      const onMessageCreate = jest.fn();
      const events = new BaileysEvents(
        makeHost({
          getOnMessageAck: () => onMessageAck,
          getOnMessageCreate: () => onMessageCreate,
          consumeOwnSend: id => id === 'OUT1',
        }),
      );

      events.handleMessagesUpsert(upsert(status));
      await settle();

      expect(onMessageAck).toHaveBeenCalledTimes(1);
      expect(onMessageAck).toHaveBeenCalledWith('OUT1', expected, partner);
      expect(onMessageCreate).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['PENDING, which every echo carries', upsert(1), true],
    ['SERVER_ACK, which a message typed on the phone carries', upsert(2), false],
    ['no status', upsert(undefined), true],
    ['a null status', upsert(null), true],
    ['a delivery status on a message the account did not send', upsert(3, { fromMe: false }), false],
    ['a delivery status on a group message, which is reported as receipts', upsert(3, { remoteJid: group }), true],
  ])('reports no ack for %s', async (_label, event, echo) => {
    const onMessageAck = jest.fn();
    const events = new BaileysEvents(makeHost({ getOnMessageAck: () => onMessageAck, consumeOwnSend: () => echo }));

    events.handleMessagesUpsert(event);
    await settle();

    expect(onMessageAck).not.toHaveBeenCalled();
  });

  it.each([
    ['a group', group],
    ['a status post', 'status@broadcast'],
  ])('reports a rejection by the server merged into the echo of a message sent to %s', async (_label, remoteJid) => {
    const onMessageAck = jest.fn();
    const events = new BaileysEvents(makeHost({ getOnMessageAck: () => onMessageAck, consumeOwnSend: () => true }));

    events.handleMessagesUpsert(upsert(0, { remoteJid }));
    await settle();

    expect(onMessageAck).toHaveBeenCalledWith('OUT1', 'failed', remoteJid);
  });

  it('holds the ack of a message the phone sent while the gateway was down until that message was handed on', async () => {
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<undefined>(resolve => (release = () => resolve(undefined)));
    const events = new BaileysEvents(
      makeHost({
        // The repeat-delivery check is the first thing processing waits for.
        getStoredMessage: () => held as unknown as ReturnType<BaileysEventsHost['getStoredMessage']>,
        getOnMessageCreate: () => () => {
          order.push('created');
        },
        getOnMessageAck: () => (id, status) => {
          order.push(`ack ${id} ${status}`);
        },
      }),
    );

    events.handleMessagesUpsert(upsert(3));
    await settle();
    expect(order).toEqual([]);

    release();
    await settle();

    expect(order).toEqual(['created', 'ack OUT1 delivered']);
  });

  it('still reports the ack of a replayed message that is processed no further', async () => {
    const onMessageAck = jest.fn();
    const onMessageCreate = jest.fn();
    const events = new BaileysEvents(
      makeHost({
        getStoredMessage: () =>
          ({ key: { id: 'OUT1' } }) as unknown as ReturnType<BaileysEventsHost['getStoredMessage']>,
        getOnMessageAck: () => onMessageAck,
        getOnMessageCreate: () => onMessageCreate,
      }),
    );

    events.handleMessagesUpsert(upsert(4));
    await settle();

    expect(onMessageCreate).not.toHaveBeenCalled();
    expect(onMessageAck).toHaveBeenCalledWith('OUT1', 'read', partner);
  });
});

describe('BaileysEvents record of conflicting copies removed', () => {
  it('forgets the id removed longest ago once it holds its limit', async () => {
    const limit = BaileysEvents.DELETED_FOR_EVERYONE_LIMIT;
    const settled = Promise.resolve({ conflict: true });
    const events = new BaileysEvents(makeHost({ getOnMessage: () => () => ({ settled }) }));
    const deliver = async (...ids: string[]): Promise<void> => {
      events.handleMessagesUpsert({
        type: 'notify',
        messages: ids.map(id => ({
          key: { id, remoteJid: '6282222222222@s.whatsapp.net', fromMe: false },
          messageTimestamp: 1_700_000_000,
          message: { conversation: 'hi' },
        })),
      });
      for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
    };
    const removals = (events as unknown as { copyRemovals: Map<string, number> }).copyRemovals;

    await deliver(...Array.from({ length: limit }, (_, i) => `M${i}`));
    expect(removals.size).toBe(limit);
    // M0 is removed again, which makes it the newest, and one more id pushes the oldest out.
    await deliver('M0');
    await deliver('EXTRA');

    expect(removals.size).toBe(limit);
    expect(removals.get('M0')).toBe(2);
    expect(removals.has('M1')).toBe(false);
    expect(removals.get('EXTRA')).toBe(1);
  });
});

describe('BaileysEvents live keys of a 1:1 chat', () => {
  // Baileys runs every live key through cleanMessage, which leaves '' where a 1:1 key has no participant.
  const partner = '6282222222222@s.whatsapp.net';
  const self = '6280000000000@s.whatsapp.net';
  const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

  it.each([
    ['the chat partner', false, partner],
    ['the account', true, self],
  ])('names %s as the reactor of a reaction whose participant is empty', async (_who, fromMe, expected) => {
    const onMessageReaction = jest.fn();
    const events = new BaileysEvents(makeHost({ getOnMessageReaction: () => onMessageReaction }));

    events.handleMessagesUpsert({
      type: 'notify',
      messages: [
        {
          key: { id: 'R1', remoteJid: partner, fromMe, participant: '' },
          messageTimestamp: 1_700_000_000,
          message: { reactionMessage: { key: { id: 'M1', remoteJid: partner }, text: '👍' } },
        },
      ],
    });
    for (let i = 0; i < 5; i++) await flush();

    expect(onMessageReaction).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'M1', senderId: expected }));
  });

  it('flags a sender known only by lid when the participant is empty', async () => {
    const events = new BaileysEvents(makeHost());

    const incoming = await events.mapMessage(
      {
        key: { id: 'L1', remoteJid: '111222333@lid', fromMe: false, participant: '' },
        messageTimestamp: 1_700_000_000,
        message: { conversation: 'hi' },
      },
      'conversation',
    );

    expect(incoming.isLidSender).toBe(true);
  });

  it.each([
    ['the guest', false, partner],
    ['the account', true, self],
  ])('reports an answer from %s whose RSVP key has an empty participant', async (_who, fromMe, expected) => {
    const onEventResponse = jest.fn();
    const events = new BaileysEvents(makeHost({ getOnEventResponse: () => onEventResponse }));

    events.handleMessagesUpdate([
      {
        key: { id: 'EVT9', remoteJid: self },
        update: {
          eventResponses: [
            {
              eventResponseMessageKey: { id: 'RSVP9', remoteJid: partner, fromMe, participant: '' },
              senderTimestampMs: 1786000000123,
              response: { response: 1 },
            },
          ],
        },
      },
    ] as never);
    await flush();

    expect(onEventResponse).toHaveBeenCalledWith(expect.objectContaining({ responderId: expected, fromMe }));
  });
});

describe('BaileysEvents event RSVPs (event.response)', () => {
  const group = '120363000000000001@g.us';
  const eventKey = { id: 'EVT1', remoteJid: group };
  const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

  function rsvp(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      eventResponseMessageKey: {
        id: 'RSVP1',
        remoteJid: group,
        participant: '6281111111111@s.whatsapp.net',
        fromMe: false,
      },
      senderTimestampMs: 1786000000123,
      response: { response: 1, timestampMs: 1786000000123, extraGuestCount: 2 },
      ...overrides,
    };
  }

  it('reports a decrypted RSVP with the event name read from the stored creation message', async () => {
    const onEventResponse = jest.fn();
    const events = new BaileysEvents(
      makeHost({
        getOnEventResponse: () => onEventResponse,
        getStoredMessage: () =>
          Promise.resolve({ key: eventKey, message: { eventMessage: { name: 'Game night' } } } as unknown as WAMessage),
      }),
    );

    events.handleMessagesUpdate([{ key: eventKey, update: { eventResponses: [rsvp()] } }] as never);
    await flush();

    expect(onEventResponse).toHaveBeenCalledTimes(1);
    expect(onEventResponse).toHaveBeenCalledWith({
      eventMessageId: 'EVT1',
      chatId: group,
      responderId: '6281111111111@s.whatsapp.net',
      fromMe: false,
      response: 'going',
      extraGuestCount: 2,
      eventName: 'Game night',
      responseMessageId: 'RSVP1',
      timestamp: 1786000000,
    });
  });

  it.each([
    [2, 'not_going'],
    [3, 'maybe'],
    [0, 'unknown'],
    [undefined, 'unknown'],
  ])('maps response type %p to %p', async (type, expected) => {
    const onEventResponse = jest.fn();
    const events = new BaileysEvents(makeHost({ getOnEventResponse: () => onEventResponse }));

    events.handleMessagesUpdate([
      { key: eventKey, update: { eventResponses: [rsvp({ response: { response: type } })] } },
    ] as never);
    await flush();

    expect(onEventResponse).toHaveBeenCalledWith(expect.objectContaining({ response: expected }));
    expect((onEventResponse.mock.calls as unknown[][])[0][0]).not.toHaveProperty('extraGuestCount');
  });

  it("attributes the account's own 1:1 answer to the account", async () => {
    const onEventResponse = jest.fn();
    const events = new BaileysEvents(makeHost({ getOnEventResponse: () => onEventResponse }));
    const chat = '6282222222222@s.whatsapp.net';

    events.handleMessagesUpdate([
      {
        key: { id: 'EVT2', remoteJid: chat },
        update: { eventResponses: [rsvp({ eventResponseMessageKey: { id: 'RSVP2', remoteJid: chat, fromMe: true } })] },
      },
    ] as never);
    await flush();

    expect(onEventResponse).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: chat, responderId: '6280000000000@s.whatsapp.net', fromMe: true }),
    );
  });

  it("takes a guest's 1:1 answer to the account's own event from the RSVP, not the guest's view of the event", async () => {
    const onEventResponse = jest.fn();
    const events = new BaileysEvents(makeHost({ getOnEventResponse: () => onEventResponse }));
    const guest = '6282222222222@s.whatsapp.net';

    // Baileys passes the creation key on as the guest sent it: its remoteJid is this account.
    events.handleMessagesUpdate([
      {
        key: { id: 'EVT3', remoteJid: '6280000000000@s.whatsapp.net', fromMe: false },
        update: {
          eventResponses: [rsvp({ eventResponseMessageKey: { id: 'RSVP3', remoteJid: guest, fromMe: false } })],
        },
      },
    ] as never);
    await flush();

    expect(onEventResponse).toHaveBeenCalledWith(
      expect.objectContaining({ eventMessageId: 'EVT3', chatId: guest, responderId: guest, fromMe: false }),
    );
  });

  it("names the responder from the session's contact store", async () => {
    const onEventResponse = jest.fn();
    const findContact = jest.fn((id: string) =>
      id === '6281111111111@s.whatsapp.net' ? ({ id, name: 'Ana Pérez', pushName: 'Ana' } as Contact) : null,
    );
    const events = new BaileysEvents(makeHost({ getOnEventResponse: () => onEventResponse, findContact }));

    events.handleMessagesUpdate([
      { key: eventKey, update: { eventResponses: [rsvp()] } },
      {
        key: eventKey,
        update: {
          eventResponses: [
            rsvp({ eventResponseMessageKey: { id: 'RSVP4', remoteJid: group, participant: '628999@s.whatsapp.net' } }),
          ],
        },
      },
    ] as never);
    await flush();

    const byId = (id: string) =>
      (onEventResponse.mock.calls as EventResponseEvent[][]).map(([e]) => e).find(e => e.responseMessageId === id);
    expect(byId('RSVP1')?.contact).toEqual({ name: 'Ana Pérez', pushName: 'Ana' });
    expect(byId('RSVP4')).not.toHaveProperty('contact');
  });

  it('still reports the RSVP, without a name, when the store cannot be read', async () => {
    const onEventResponse = jest.fn();
    const events = new BaileysEvents(
      makeHost({
        getOnEventResponse: () => onEventResponse,
        getStoredMessage: () => Promise.reject(new Error('database is locked')),
      }),
    );

    events.handleMessagesUpdate([{ key: eventKey, update: { eventResponses: [rsvp()] } }] as never);
    await flush();

    expect(onEventResponse).toHaveBeenCalledTimes(1);
    expect((onEventResponse.mock.calls as unknown[][])[0][0]).not.toHaveProperty('eventName');
  });

  it('keeps reporting acks next to RSVPs, and ignores an RSVP without its own key', async () => {
    const onEventResponse = jest.fn();
    const onMessageAck = jest.fn();
    const events = new BaileysEvents(
      makeHost({ getOnEventResponse: () => onEventResponse, getOnMessageAck: () => onMessageAck }),
    );

    events.handleMessagesUpdate([
      { key: eventKey, update: { status: 3, eventResponses: [rsvp({ eventResponseMessageKey: null })] } },
    ] as never);
    await flush();

    expect(onMessageAck).toHaveBeenCalledTimes(1);
    expect(onEventResponse).not.toHaveBeenCalled();
  });

  describe('which chat an RSVP may answer for', () => {
    const otherGroup = '120363000000000002@g.us';
    const storedIn =
      (remoteJid: string, extra: Record<string, unknown> = {}) =>
      () =>
        Promise.resolve({
          key: { id: 'EVT1', remoteJid, fromMe: false, ...extra },
          message: { eventMessage: { name: 'Game night' } },
        } as unknown as WAMessage);

    it("drops an RSVP sent in another chat than its event's, which Baileys decrypts without comparing chats", async () => {
      const onEventResponse = jest.fn();
      const logger = createLogger('BaileysEventsSpec');
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const events = new BaileysEvents(
        makeHost({ getOnEventResponse: () => onEventResponse, getStoredMessage: storedIn(otherGroup), logger }),
      );

      // The event lives in otherGroup; the default RSVP envelope arrived in `group`.
      events.handleMessagesUpdate([
        { key: { id: 'EVT1', remoteJid: otherGroup }, update: { eventResponses: [rsvp()] } },
      ] as never);
      await flush();

      expect(onEventResponse).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('reports an RSVP whose stored event sits in the chat the answer arrived in', async () => {
      const onEventResponse = jest.fn();
      const events = new BaileysEvents(
        makeHost({ getOnEventResponse: () => onEventResponse, getStoredMessage: storedIn(group) }),
      );

      events.handleMessagesUpdate([{ key: eventKey, update: { eventResponses: [rsvp()] } }] as never);
      await flush();

      expect(onEventResponse).toHaveBeenCalledWith(expect.objectContaining({ chatId: group, eventName: 'Game night' }));
    });

    it("reports a guest's 1:1 answer to the account's own event, kept in the guest's chat", async () => {
      const onEventResponse = jest.fn();
      const guest = '6282222222222@s.whatsapp.net';
      const events = new BaileysEvents(
        makeHost({ getOnEventResponse: () => onEventResponse, getStoredMessage: storedIn(guest, { fromMe: true }) }),
      );

      events.handleMessagesUpdate([
        {
          key: { id: 'EVT1', remoteJid: '6280000000000@s.whatsapp.net', fromMe: false },
          update: {
            eventResponses: [rsvp({ eventResponseMessageKey: { id: 'RSVP6', remoteJid: guest, fromMe: false } })],
          },
        },
      ] as never);
      await flush();

      expect(onEventResponse).toHaveBeenCalledWith(expect.objectContaining({ chatId: guest, responderId: guest }));
    });

    it("compares a lid chat with its phone number once the key's pair is known", async () => {
      const onEventResponse = jest.fn();
      const lid = '99887766@lid';
      const phone = '6282222222222@s.whatsapp.net';
      let paired = false;
      const events = new BaileysEvents(
        makeHost({
          getOnEventResponse: () => onEventResponse,
          getStoredMessage: storedIn(phone, { fromMe: true }),
          recordKeyLidMappings: () => {
            paired = true;
          },
          toNeutralJid: jid => (paired && jid === lid ? phone : jid),
        }),
      );

      events.handleMessagesUpdate([
        {
          key: { id: 'EVT1', remoteJid: '6280000000000@s.whatsapp.net', fromMe: false },
          update: {
            eventResponses: [
              rsvp({ eventResponseMessageKey: { id: 'RSVP7', remoteJid: lid, remoteJidAlt: phone, fromMe: false } }),
            ],
          },
        },
      ] as never);
      await flush();

      expect(onEventResponse).toHaveBeenCalledWith(expect.objectContaining({ chatId: phone, responderId: phone }));
    });
  });

  it("learns the RSVP key's lid and phone pair before naming the responder", async () => {
    const onEventResponse = jest.fn();
    const lid = '99887766@lid';
    const phone = '6281111111111@s.whatsapp.net';
    let paired = false;
    const events = new BaileysEvents(
      makeHost({
        getOnEventResponse: () => onEventResponse,
        recordKeyLidMappings: () => {
          paired = true;
        },
        toNeutralJid: jid => (paired && jid === lid ? phone : jid),
      }),
    );

    events.handleMessagesUpdate([
      {
        key: eventKey,
        update: {
          eventResponses: [
            rsvp({
              eventResponseMessageKey: { id: 'RSVP8', remoteJid: group, participant: lid, participantAlt: phone },
            }),
          ],
        },
      },
    ] as never);
    await flush();

    expect(onEventResponse).toHaveBeenCalledWith(expect.objectContaining({ responderId: phone }));
  });
});

/**
 * WhatsApp sends a contact's edit, and a reaction in some chats, encrypted under the secret of the message
 * it changes. These tests seal their payloads with the library's own key construction (see
 * baileys-secret-payload.spec.ts) and let the stub's protobuf decode read JSON, which is the only part
 * the real library supplies.
 */
describe('BaileysEvents encrypted edits and reactions', () => {
  const group = '120363000000000001@g.us';
  const author = '39900313301142@lid';
  const reactor = '195700218425410@lid';
  const secret = Buffer.alloc(32, 0x42);
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
  };

  const protoStub = {
    Message: {
      SecretEncryptedMessage: { SecretEncType: { UNKNOWN: 0, EVENT_EDIT: 1, MESSAGE_EDIT: 2 } },
      ProtocolMessage: { Type: { REVOKE: 0, MESSAGE_EDIT: 14 } },
      decode: (bytes: Uint8Array): unknown => JSON.parse(Buffer.from(bytes).toString()),
      ReactionMessage: { decode: (bytes: Uint8Array): unknown => JSON.parse(Buffer.from(bytes).toString()) },
    },
  };
  const lib = { ...libStub, proto: protoStub } as unknown as Awaited<ReturnType<BaileysEventsHost['loadLib']>>;

  function seal(
    label: 'Message Edit' | 'Enc Reaction',
    ids: { target: string; author: string; modifier: string },
    plain: object,
    withSecret: Buffer = secret,
  ): { encPayload: Buffer; encIv: Buffer } {
    const prk = createHmac('sha256', Buffer.alloc(32)).update(withSecret).digest();
    const info = Buffer.from(`${ids.target}${ids.author}${ids.modifier}${label}`);
    const key = createHmac('sha256', prk)
      .update(Buffer.concat([info, Buffer.from([1])]))
      .digest();
    const iv = Buffer.alloc(12, 5);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(plain))),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    return { encPayload: body, encIv: iv };
  }

  const original = (overrides: Record<string, unknown> = {}): WAMessage =>
    ({
      key: { id: 'ORIG1', remoteJid: group, participant: author, fromMe: false },
      messageTimestamp: 1_786_000_000,
      message: { conversation: 'old text', messageContextInfo: { messageSecret: secret.toString('base64') } },
      ...overrides,
    }) as unknown as WAMessage;

  const editPlain = {
    protocolMessage: {
      type: 14,
      key: { id: 'ORIG1' },
      editedMessage: { conversation: 'new text' },
      timestampMs: 1786000000123,
    },
  };

  function editEnvelope(
    overrides: {
      participant?: string;
      fromMe?: boolean;
      sealed?: object;
      type?: unknown;
      target?: string;
      remoteJid?: string;
    } = {},
  ): WAMessage {
    const participant = overrides.participant ?? author;
    const sealed =
      overrides.sealed ?? seal('Message Edit', { target: 'ORIG1', author, modifier: participant }, editPlain);
    return {
      key: { id: 'ENV1', remoteJid: overrides.remoteJid ?? group, participant, fromMe: overrides.fromMe ?? false },
      messageTimestamp: 1_786_000_100,
      message: {
        secretEncryptedMessage: {
          targetMessageKey: { id: overrides.target ?? 'ORIG1', remoteJid: group, fromMe: true },
          ...sealed,
          secretEncType: overrides.type ?? 2,
        },
      },
    } as unknown as WAMessage;
  }

  function reactionEnvelope(text: string, overrides: { remoteJid?: string; sealed?: object } = {}): WAMessage {
    const sealed =
      overrides.sealed ??
      seal('Enc Reaction', { target: 'ORIG1', author, modifier: reactor }, { text, senderTimestampMs: 1786000000999 });
    return {
      key: { id: 'REACT1', remoteJid: overrides.remoteJid ?? group, participant: reactor, fromMe: false },
      messageTimestamp: 1_786_000_200,
      message: {
        encReactionMessage: { targetMessageKey: { id: 'ORIG1', remoteJid: group, fromMe: false }, ...sealed },
      },
    };
  }

  function setup(extra: Partial<BaileysEventsHost> = {}, stored: WAMessage | null = original()) {
    const onMessageEdited = jest.fn();
    const onMessageReaction = jest.fn();
    const onMessage = jest.fn();
    const recordMessageEdit = jest.fn();
    const events = new BaileysEvents(
      makeHost({
        loadLib: () => Promise.resolve(lib),
        getStoredMessage: (id: string) => Promise.resolve(id === 'ORIG1' ? stored : null),
        getOnMessageEdited: () => onMessageEdited,
        getOnMessageReaction: () => onMessageReaction,
        getOnMessage: () => onMessage,
        recordMessageEdit,
        ...extra,
      }),
    );
    return { events, onMessageEdited, onMessageReaction, onMessage, recordMessageEdit };
  }

  it("applies a contact's encrypted edit of a stored message, as the plain protocol message would be", async () => {
    const { events, onMessageEdited, onMessage, recordMessageEdit } = setup();

    events.handleMessagesUpsert({ type: 'notify', messages: [editEnvelope()] });
    await flush();

    expect(onMessageEdited).toHaveBeenCalledTimes(1);
    expect(onMessageEdited).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'ORIG1', body: 'new text', chatId: group, senderId: author }),
    );
    expect(recordMessageEdit).toHaveBeenCalledWith(group, 'ORIG1', 'new text', undefined, expect.any(Function));
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('reads the edit of a 1:1 message, whose key names the partner by chat and leaves the participant empty', async () => {
    const chat = '262813461250071@lid';
    const stored = original({ key: { id: 'ORIG1', remoteJid: chat, participant: '', fromMe: false } });
    const { events, onMessageEdited } = setup({}, stored);
    const sealed = seal('Message Edit', { target: 'ORIG1', author: chat, modifier: chat }, editPlain);
    const envelope = editEnvelope({ sealed, remoteJid: chat, participant: '' });

    events.handleMessagesUpsert({ type: 'notify', messages: [envelope] });
    await flush();

    expect(onMessageEdited).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'ORIG1', body: 'new text' }));
  });

  it("reads an edit the account made from its phone, under the account's own id", async () => {
    const self = '6280000000000@s.whatsapp.net';
    const stored = original({ key: { id: 'ORIG1', remoteJid: group, fromMe: true } });
    const { events, onMessageEdited } = setup(
      {
        getSocketOrNull: () => ({ user: { id: '6280000000000:12@s.whatsapp.net', lid: '5550001:12@lid' } }) as WASocket,
      },
      stored,
    );
    const sealed = seal('Message Edit', { target: 'ORIG1', author: self, modifier: self }, editPlain);

    events.handleMessagesUpsert({ type: 'notify', messages: [editEnvelope({ sealed, fromMe: true })] });
    await flush();

    expect(onMessageEdited).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'ORIG1', fromMe: true }));
  });

  it('applies an edit the account made from its phone as a plain protocol message, under its own id', async () => {
    const stored = original({ key: { id: 'ORIG1', remoteJid: group, fromMe: true } });
    const { events, onMessageEdited, recordMessageEdit } = setup({}, stored);
    const plain = {
      key: { id: 'ENV2', remoteJid: group, fromMe: true },
      messageTimestamp: 1_786_000_100,
      message: { protocolMessage: editPlain.protocolMessage },
    } as unknown as WAMessage;

    events.handleMessagesUpsert({ type: 'notify', messages: [plain] });
    await flush();

    expect(onMessageEdited).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'ORIG1', body: 'new text', fromMe: true }),
    );
    expect(recordMessageEdit).toHaveBeenCalledWith(group, 'ORIG1', 'new text', undefined, expect.any(Function));
  });

  it('reads an edit of a message that is still being processed, with the secret that copy carries', async () => {
    // The original's repeat-delivery check never settles until released, which keeps it in flight; the
    // edit's own read of the store answers nothing.
    let release: (stored: WAMessage | null) => void = () => undefined;
    let reads = 0;
    const getStoredMessage = (id: string): Promise<WAMessage | null> => {
      if (id !== 'ORIG1') return Promise.resolve(null);
      reads += 1;
      return reads === 1 ? new Promise(resolve => (release = resolve)) : Promise.resolve(null);
    };
    const { events, onMessageEdited } = setup({ getStoredMessage });

    events.handleMessagesUpsert({ type: 'notify', messages: [original()] });
    await flush();
    events.handleMessagesUpsert({ type: 'notify', messages: [editEnvelope()] });
    await flush();
    // The edit was read, but it is announced once the session holds the message it changes.
    expect(onMessageEdited).not.toHaveBeenCalled();

    release(null);
    await flush();

    expect(onMessageEdited).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'ORIG1', body: 'new text' }));
  });

  it('reads the edit of an original that finishes while the edit is still reading the store', async () => {
    // The edit's read of the store is issued while the original is in flight, and answers (null: the row
    // was written after the read began) only once the original has finished and left the in-flight map.
    const reads: Array<(stored: WAMessage | null) => void> = [];
    // Only these two reads are held; any later read of the id (the guard that follows) answers at once.
    const getStoredMessage = (id: string): Promise<WAMessage | null> =>
      id === 'ORIG1' && reads.length < 2 ? new Promise(resolve => reads.push(resolve)) : Promise.resolve(null);
    const { events, onMessageEdited } = setup({ getStoredMessage });

    events.handleMessagesUpsert({ type: 'notify', messages: [original()] });
    await flush();
    events.handleMessagesUpsert({ type: 'notify', messages: [editEnvelope()] });
    await flush();
    expect(reads).toHaveLength(2);

    reads[0](null); // the original's own repeat-delivery check answers: it is stored and done
    await flush();
    reads[1](null); // now the edit's read answers, finding no row and no in-flight entry
    await flush();

    expect(onMessageEdited).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'ORIG1', body: 'new text' }));
  });

  it("drops another member's encrypted edit of an original that finishes while the guard reads the store", async () => {
    // Held reads of the target, in order: the original's own repeat check, the reveal's read, the guard's.
    const reads: Array<(stored: WAMessage | null) => void> = [];
    const getStoredMessage = (id: string): Promise<WAMessage | null> =>
      id === 'ORIG1' && reads.length < 3 ? new Promise(resolve => reads.push(resolve)) : Promise.resolve(null);
    const { events, onMessageEdited, recordMessageEdit } = setup({ getStoredMessage });
    // Another member of the group, who holds the message's secret as a recipient of it, seals an edit.
    const forged = editEnvelope({
      participant: reactor,
      sealed: seal('Message Edit', { target: 'ORIG1', author, modifier: reactor }, editPlain),
    });

    events.handleMessagesUpsert({ type: 'notify', messages: [original()] });
    await flush();
    events.handleMessagesUpsert({ type: 'notify', messages: [forged] });
    await flush();
    expect(reads).toHaveLength(2);

    reads[1](null); // the reveal reads nothing and decrypts from the copy in flight
    await flush();
    expect(reads).toHaveLength(3); // the guard's read is out now
    reads[0](null); // the original finishes and leaves the in-flight map while it is
    await flush();
    reads[2](null);
    await flush();

    expect(onMessageEdited).not.toHaveBeenCalled();
    expect(recordMessageEdit).not.toHaveBeenCalled();
  });

  it('holds a plain edit from another member to the same rule when the original finishes during the read', async () => {
    const reads: Array<(stored: WAMessage | null) => void> = [];
    const getStoredMessage = (id: string): Promise<WAMessage | null> =>
      id === 'ORIG1' && reads.length < 2 ? new Promise(resolve => reads.push(resolve)) : Promise.resolve(null);
    const { events, onMessageEdited } = setup({ getStoredMessage });
    const plain = {
      key: { id: 'ENV2', remoteJid: group, participant: reactor, fromMe: false },
      messageTimestamp: 1_786_000_100,
      message: { protocolMessage: editPlain.protocolMessage },
    } as unknown as WAMessage;

    events.handleMessagesUpsert({ type: 'notify', messages: [original()] });
    await flush();
    events.handleMessagesUpsert({ type: 'notify', messages: [plain] });
    await flush();
    expect(reads).toHaveLength(2); // the original's check and the guard's read
    reads[0](null);
    await flush();
    reads[1](null);
    await flush();

    expect(onMessageEdited).not.toHaveBeenCalled();
  });

  it("still applies the author's own encrypted edit in the same interleaving", async () => {
    const reads: Array<(stored: WAMessage | null) => void> = [];
    const getStoredMessage = (id: string): Promise<WAMessage | null> =>
      id === 'ORIG1' && reads.length < 3 ? new Promise(resolve => reads.push(resolve)) : Promise.resolve(null);
    const { events, onMessageEdited } = setup({ getStoredMessage });

    events.handleMessagesUpsert({ type: 'notify', messages: [original()] });
    await flush();
    events.handleMessagesUpsert({ type: 'notify', messages: [editEnvelope()] });
    await flush();
    reads[1](null);
    await flush();
    reads[0](null);
    await flush();
    reads[2](null);
    await flush();

    expect(onMessageEdited).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'ORIG1', body: 'new text' }));
  });

  describe("another member's encrypted edit of an original still being processed", () => {
    // The original's own repeat check is the first read of the store. The store keeps what is put into it, so
    // a read made after the original was processed finds its copy.
    const withHeldReads = (held: number[], answered: Promise<{ conflict?: boolean } | undefined>) => {
      const opens = new Map<number, () => void>();
      const gates = new Map<number, Promise<void>>();
      for (const index of held) gates.set(index, new Promise<void>(resolve => opens.set(index, resolve)));
      let copy: WAMessage | null = null;
      let reads = 0;
      const setups = setup({
        getStoredMessage: async (id: string) => {
          if (id !== 'ORIG1') return null;
          const seen = copy;
          await gates.get(++reads);
          return seen;
        },
        putStoredMessage: (msg: WAMessage) => {
          copy = msg;
          return Promise.resolve();
        },
        removeStoredMessage: () => {
          copy = null;
          return Promise.resolve();
        },
        getOnMessage: () => jest.fn(() => ({ settled: answered })),
      });
      return { ...setups, open: (index: number) => opens.get(index)!() };
    };
    const forged = (): WAMessage =>
      editEnvelope({
        participant: reactor,
        sealed: seal('Message Edit', { target: 'ORIG1', author, modifier: reactor }, editPlain),
      });

    it('is held until the original is stored, and stays held while the original has no answer', async () => {
      const { events, onMessageEdited, recordMessageEdit, open } = withHeldReads([1], new Promise(() => undefined));

      events.handleMessagesUpsert({ type: 'notify', messages: [original()] });
      await flush();
      events.handleMessagesUpsert({ type: 'notify', messages: [forged()] });
      await flush();
      expect(onMessageEdited).not.toHaveBeenCalled();

      open(1);
      await flush();
      expect(onMessageEdited).not.toHaveBeenCalled();
      expect(recordMessageEdit).not.toHaveBeenCalled();
    });

    it('is applied once the answer says the original was another message and its copy is gone', async () => {
      let answer!: (outcome: { conflict: boolean }) => void;
      const answered = new Promise<{ conflict: boolean }>(resolve => (answer = resolve));
      const { events, onMessageEdited, open } = withHeldReads([1], answered);

      events.handleMessagesUpsert({ type: 'notify', messages: [original()] });
      await flush();
      events.handleMessagesUpsert({ type: 'notify', messages: [forged()] });
      await flush();
      open(1);
      await flush();
      expect(onMessageEdited).not.toHaveBeenCalled();

      answer({ conflict: true });
      await flush();
      expect(onMessageEdited).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'ORIG1', body: 'new text' }));
    });

    it('is dropped once the original is stored and answered as the message', async () => {
      // Reads, in order: the original's repeat check, the reveal's, the guard's, and the guard's second.
      const answered = Promise.resolve({ conflict: false });
      const { events, onMessageEdited, recordMessageEdit, open } = withHeldReads([1, 4], answered);

      events.handleMessagesUpsert({ type: 'notify', messages: [original()] });
      await flush();
      events.handleMessagesUpsert({ type: 'notify', messages: [forged()] });
      await flush();
      open(1);
      await flush();
      open(4);
      await flush();

      expect(onMessageEdited).not.toHaveBeenCalled();
      expect(recordMessageEdit).not.toHaveBeenCalled();
    });
  });

  describe('leaves an encrypted edit unapplied when', () => {
    it.each([
      ['another member sealed it for the message', () => editEnvelope({ participant: reactor })],
      [
        'its payload was sealed under another secret',
        () =>
          editEnvelope({
            sealed: seal('Message Edit', { target: 'ORIG1', author, modifier: author }, editPlain, Buffer.alloc(32, 1)),
          }),
      ],
      ['it is an edit of an event', () => editEnvelope({ type: 1 })],
      [
        'it names a message that is not stored',
        () =>
          editEnvelope({
            target: 'GONE',
            sealed: seal('Message Edit', { target: 'GONE', author, modifier: author }, editPlain),
          }),
      ],
      [
        'what it decrypts to names another message than the one it targets',
        () =>
          editEnvelope({
            sealed: seal(
              'Message Edit',
              { target: 'ORIG1', author, modifier: author },
              {
                protocolMessage: { ...editPlain.protocolMessage, key: { id: 'SOMETHING_ELSE' } },
              },
            ),
          }),
      ],
      [
        'what it decrypts to is not an edit',
        () =>
          editEnvelope({
            sealed: seal(
              'Message Edit',
              { target: 'ORIG1', author, modifier: author },
              {
                protocolMessage: { ...editPlain.protocolMessage, type: 0 },
              },
            ),
          }),
      ],
      ['it targets a message of another chat', () => editEnvelope({ remoteJid: '120363000000000002@g.us' })],
    ])('%s', async (_name, build) => {
      const { events, onMessageEdited, onMessage, recordMessageEdit } = setup();

      events.handleMessagesUpsert({ type: 'notify', messages: [build()] });
      await flush();

      expect(onMessageEdited).not.toHaveBeenCalled();
      expect(recordMessageEdit).not.toHaveBeenCalled();
      expect(onMessage).not.toHaveBeenCalled();
    });

    it('the message store cannot be read', async () => {
      const { events, onMessageEdited } = setup({ getStoredMessage: () => Promise.reject(new Error('store down')) });

      events.handleMessagesUpsert({ type: 'notify', messages: [editEnvelope()] });
      await flush();

      expect(onMessageEdited).not.toHaveBeenCalled();
    });

    it('the target carries no secret', async () => {
      const { events, onMessageEdited } = setup({}, original({ message: { conversation: 'old text' } }));

      events.handleMessagesUpsert({ type: 'notify', messages: [editEnvelope()] });
      await flush();

      expect(onMessageEdited).not.toHaveBeenCalled();
    });
  });

  it('reports a reaction a member sent encrypted, and its removal', async () => {
    const { events, onMessageReaction } = setup();

    events.handleMessagesUpsert({ type: 'notify', messages: [reactionEnvelope('👍')] });
    events.handleMessagesUpsert({ type: 'notify', messages: [reactionEnvelope('')] });
    await flush();

    expect(onMessageReaction).toHaveBeenCalledTimes(2);
    expect(onMessageReaction).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ messageId: 'ORIG1', chatId: group, reaction: '👍', senderId: reactor }),
    );
    expect(onMessageReaction).toHaveBeenNthCalledWith(2, expect.objectContaining({ reaction: '', senderId: reactor }));
  });

  it('drops an encrypted reaction that names a message of another chat, as a plain one is', async () => {
    const { events, onMessageReaction } = setup();

    events.handleMessagesUpsert({
      type: 'notify',
      messages: [reactionEnvelope('👍', { remoteJid: '120363000000000002@g.us' })],
    });
    await flush();

    expect(onMessageReaction).not.toHaveBeenCalled();
  });

  it('drops an encrypted reaction sealed under another secret', async () => {
    const { events, onMessageReaction } = setup();
    const sealed = seal(
      'Enc Reaction',
      { target: 'ORIG1', author, modifier: reactor },
      { text: '👍' },
      Buffer.alloc(32, 9),
    );

    events.handleMessagesUpsert({ type: 'notify', messages: [reactionEnvelope('👍', { sealed })] });
    await flush();

    expect(onMessageReaction).not.toHaveBeenCalled();
  });
});

// Where nothing is admitted before the emit (SQLite) a reaction of a message still being processed waits for its
// emit; the wait ends at the latest after three media deadlines, and its timer is neither kept nor left running.
describe('BaileysEvents changes waiting for the message they change', () => {
  const chat = '6281111111111@s.whatsapp.net';
  const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
  const original: WAMessage = {
    key: { id: 'M', remoteJid: chat, fromMe: false },
    messageTimestamp: 1_700_000_000,
    message: { conversation: 'hi' },
  };
  const reaction: WAMessage = {
    key: { id: 'R', remoteJid: chat, fromMe: false },
    messageTimestamp: 1_700_000_001,
    message: { reactionMessage: { key: { id: 'M', remoteJid: chat, fromMe: false }, text: 'ok' } },
  };
  const saved = process.env.MEDIA_DOWNLOAD_TIMEOUT_MS;

  beforeEach(() => {
    process.env.MEDIA_DOWNLOAD_TIMEOUT_MS = '1000';
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  });
  afterEach(() => {
    jest.useRealTimers();
    if (saved === undefined) delete process.env.MEDIA_DOWNLOAD_TIMEOUT_MS;
    else process.env.MEDIA_DOWNLOAD_TIMEOUT_MS = saved;
  });

  /** The original never finishes: its check for a repeat delivery is not answered. */
  const withMessageStuck = () => {
    let checked = false;
    const onMessageReaction = jest.fn();
    const events = new BaileysEvents(
      makeHost({
        getStoredMessage: (id: string) => {
          if (id !== 'M' || checked) return Promise.resolve(null);
          checked = true;
          return new Promise<WAMessage | null>(() => undefined);
        },
        getOnMessageReaction: () => onMessageReaction,
      }),
    );
    events.handleMessagesUpsert({ type: 'notify', messages: [original] });
    return { events, onMessageReaction };
  };

  it('lets a change go three media deadlines after it began to wait, and leaves no timer behind', async () => {
    const { events, onMessageReaction } = withMessageStuck();
    await flush();
    events.handleMessagesUpsert({ type: 'notify', messages: [reaction] });
    await flush();
    expect(onMessageReaction).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(1);

    jest.advanceTimersByTime(2_999);
    expect(onMessageReaction).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);

    expect(onMessageReaction).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not keep the process alive while a change waits', async () => {
    const waits: Array<{ unref: jest.SpyInstance }> = [];
    const fake = global.setTimeout;
    jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      const handle = fake(fn, ms) as unknown as { unref: () => unknown };
      if (ms === 3_000) waits.push({ unref: jest.spyOn(handle, 'unref') });
      return handle;
    }) as never);
    const { events } = withMessageStuck();
    await flush();

    events.handleMessagesUpsert({ type: 'notify', messages: [reaction] });
    await flush();

    expect(waits).toHaveLength(1);
    expect(waits[0].unref).toHaveBeenCalledTimes(1);
  });

  it('stops the timer once the message has been handed on', async () => {
    let release!: (stored: WAMessage | null) => void;
    let checked = false;
    const onMessageReaction = jest.fn();
    const events = new BaileysEvents(
      makeHost({
        getStoredMessage: (id: string) => {
          if (id !== 'M' || checked) return Promise.resolve(null);
          checked = true;
          return new Promise<WAMessage | null>(resolve => (release = resolve));
        },
        getOnMessageReaction: () => onMessageReaction,
      }),
    );
    events.handleMessagesUpsert({ type: 'notify', messages: [original] });
    await flush();
    events.handleMessagesUpsert({ type: 'notify', messages: [reaction] });
    await flush();
    expect(jest.getTimerCount()).toBe(1);

    release(null);
    await flush();

    expect(onMessageReaction).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
