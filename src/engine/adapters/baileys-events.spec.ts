import { BaileysEvents, type BaileysEventsHost } from './baileys-events';
import { createLogger } from '../../common/services/logger.service';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';
import { inboundMediaConcurrency } from './inbound-media-cap';
import type { WAMessage, WASocket } from '@whiskeysockets/baileys';

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
    getOnMessage: () => undefined,
    getOnMessageCreate: () => undefined,
    getOnMessageRevoked: () => undefined,
    getOnMessageEdited: () => undefined,
    getOnMessageReaction: () => undefined,
    getOnMessageAck: () => undefined,
    getOnGroupEvent: () => undefined,
    getOnEventResponse: () => undefined,
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
    const events = new BaileysEvents(
      makeHost({ loadLib: () => gate.then(() => libStub), putStoredMessage, getOnMessage: () => jest.fn() }),
    );
    events.handleMessagesUpsert({
      type: 'notify',
      messages: [
        {
          key: { id: 'wamid.unlink', remoteJid: '15550001111@s.whatsapp.net', fromMe: false },
          messageTimestamp: 1_700_000_000,
          message: { conversation: 'hi' },
        },
      ],
    });
    const settle = async () => {
      release();
      for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
    };
    return { events, putStoredMessage, settle };
  };

  it('stores a message whose processing finishes with the account still linked', async () => {
    const { putStoredMessage, settle } = held();
    await settle();
    expect(putStoredMessage).toHaveBeenCalledTimes(1);
  });

  it('does not store a message still being processed when the account was unlinked', async () => {
    const { events, putStoredMessage, settle } = held();
    events.fenceStoredWrites();
    await settle();
    expect(putStoredMessage).not.toHaveBeenCalled();
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
});
