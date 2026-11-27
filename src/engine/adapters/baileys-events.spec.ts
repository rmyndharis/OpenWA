import { Boom } from '@hapi/boom';
import { createCipheriv, createHash, createHmac } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { compileFunction } from 'node:vm';
import * as ts from 'typescript';
import { BufferJSON } from '@whiskeysockets/baileys';
import {
  BaileysEvents,
  keptInboundRaw,
  revivedInbound,
  type BaileysEventsHost,
  type StoredChange,
} from './baileys-events';
import { createLogger } from '../../common/services/logger.service';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';
import { inboundMediaConcurrency } from './inbound-media-cap';
import { toNeutralJid } from '../identity/wa-id';
import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import type {
  Contact,
  EventResponseEvent,
  InboundTicket,
  MessageReceiptEvent,
  PollVoteEvent,
} from '../interfaces/whatsapp-engine.interface';

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
    getOnPollVote: () => undefined,
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

  describe('whose address has expired', () => {
    const OLD = 'https://mmg.whatsapp.net/v/t62/old.enc';
    const NEW = 'https://mmg.whatsapp.net/v/t62/new.enc';
    const image = (url: string) => ({
      imageMessage: { mimetype: 'image/jpeg', fileLength: 3, url, directPath: new URL(url).pathname },
    });
    // Baileys' own fetch failure: the host's status lives in `output.statusCode`, not in `status`.
    const hostAnswered = (statusCode: number) => new Boom(`Failed to fetch stream from ${OLD}`, { statusCode });
    const reuploadTo = (url: string) =>
      jest.fn((m: WAMessage) => Promise.resolve({ ...m, message: image(url) } as WAMessage));
    const receive = (updateMediaMessage: jest.Mock) =>
      new BaileysEvents(makeHost({ getSocket: () => ({ updateMediaMessage }) as unknown as WASocket })).mapMessage(
        {
          key: { id: 'wamid.expired', remoteJid: '15550001111@s.whatsapp.net', fromMe: false },
          messageTimestamp: 1_700_000_000,
          message: image(OLD),
        },
        'imageMessage',
      );
    const fetchedFrom = (call: number): unknown =>
      (downloadMediaMessage.mock.calls[call] as [WAMessage])[0].message?.imageMessage?.url;
    const omitted = { mimetype: 'image/jpeg', filename: undefined, omitted: true, sizeBytes: 3 };

    it.each([
      ['410 Gone', hostAnswered(410)],
      ['404 Not Found', hostAnswered(404)],
      ['410 as a numeric status', Object.assign(new Error('gone'), { status: 410 })],
    ])('asks WhatsApp to upload it again after %s and downloads the new copy', async (_name, error) => {
      downloadMediaMessage.mockRejectedValueOnce(error).mockResolvedValueOnce(streamOf(Buffer.from('IMG')));
      const updateMediaMessage = reuploadTo(NEW);

      const incoming = await receive(updateMediaMessage);

      expect(updateMediaMessage).toHaveBeenCalledTimes(1);
      expect(downloadMediaMessage).toHaveBeenCalledTimes(2);
      expect(fetchedFrom(1)).toBe(NEW);
      expect(incoming.media).toEqual({
        mimetype: 'image/jpeg',
        filename: undefined,
        data: Buffer.from('IMG').toString('base64'),
      });
    });

    it.each([
      ['403 Forbidden', hostAnswered(403)],
      ['503 Service Unavailable', hostAnswered(503)],
      ['a network failure', new TypeError('fetch failed')],
    ])('does not ask for an upload after %s', async (_name, error) => {
      downloadMediaMessage.mockRejectedValueOnce(error);
      const updateMediaMessage = reuploadTo(NEW);

      const incoming = await receive(updateMediaMessage);

      expect(updateMediaMessage).not.toHaveBeenCalled();
      expect(downloadMediaMessage).toHaveBeenCalledTimes(1);
      expect(incoming.media).toEqual(omitted);
    });

    // rc14 waits for the phone's answer with no timeout, keeping two listeners on the socket until it comes.
    it('stops asking while five requests are unanswered, and asks again once one is answered', async () => {
      const saved = process.env.MEDIA_DOWNLOAD_TIMEOUT_MS;
      process.env.MEDIA_DOWNLOAD_TIMEOUT_MS = '50';
      try {
        const answers: Array<(m: WAMessage) => void> = [];
        const updateMediaMessage = jest.fn(() => new Promise<WAMessage>(resolve => answers.push(resolve)));
        const sock = { updateMediaMessage } as unknown as WASocket;
        const events = new BaileysEvents(makeHost({ getSocket: () => sock }));
        const receiveOne = (n: number) =>
          events.mapMessage(
            {
              key: { id: `wamid.expired-${n}`, remoteJid: '15550001111@s.whatsapp.net', fromMe: false },
              messageTimestamp: 1_700_000_000 + n,
              message: image(OLD),
            },
            'imageMessage',
          );
        downloadMediaMessage.mockRejectedValue(hostAnswered(410));

        for (let n = 1; n <= 6; n++) await expect(receiveOne(n)).resolves.toMatchObject({ media: omitted });
        expect(updateMediaMessage).toHaveBeenCalledTimes(5);

        answers[0]({ key: { id: 'wamid.expired-1' }, message: image(NEW) });
        await new Promise(resolve => setImmediate(resolve));
        await receiveOne(7);
        expect(updateMediaMessage).toHaveBeenCalledTimes(6);
      } finally {
        downloadMediaMessage.mockReset();
        if (saved === undefined) delete process.env.MEDIA_DOWNLOAD_TIMEOUT_MS;
        else process.env.MEDIA_DOWNLOAD_TIMEOUT_MS = saved;
      }
    });

    it('gives up when the new copy cannot be fetched either', async () => {
      downloadMediaMessage.mockRejectedValueOnce(hostAnswered(410)).mockRejectedValueOnce(hostAnswered(410));
      const updateMediaMessage = reuploadTo(NEW);

      const incoming = await receive(updateMediaMessage);

      expect(updateMediaMessage).toHaveBeenCalledTimes(1);
      expect(downloadMediaMessage).toHaveBeenCalledTimes(2);
      expect(incoming.media).toEqual(omitted);
    });

    it('does not fetch a new copy whose address is outside WhatsApp hosts', async () => {
      downloadMediaMessage.mockRejectedValueOnce(hostAnswered(410));
      const updateMediaMessage = reuploadTo('https://internal.example/v/t62/x.enc');

      const incoming = await receive(updateMediaMessage);

      expect(updateMediaMessage).toHaveBeenCalledTimes(1);
      expect(downloadMediaMessage).toHaveBeenCalledTimes(1);
      expect(incoming.media).toEqual(omitted);
    });

    // A Baileys release that reads the Boom status itself asks once, retries once, and rethrows the
    // retry's failure: that must not start a second upload request.
    it('asks only once when Baileys already asked for the upload', async () => {
      downloadMediaMessage.mockImplementationOnce(
        async (
          m: WAMessage,
          _t: string,
          _o: unknown,
          ctx: { reuploadRequest: (m: WAMessage) => Promise<WAMessage> },
        ) => {
          await ctx.reuploadRequest(m);
          throw hostAnswered(410);
        },
      );
      const updateMediaMessage = reuploadTo(NEW);

      const incoming = await receive(updateMediaMessage);

      expect(updateMediaMessage).toHaveBeenCalledTimes(1);
      expect(downloadMediaMessage).toHaveBeenCalledTimes(1);
      expect(incoming.media).toEqual(omitted);
    });
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

// Baileys raises a group message's receipts member by member and never its 1:1 status update, so the message
// would stay at "sent". Each member reports in the dialect the group addresses them by (a lid), once per device.
describe('BaileysEvents group message acks', () => {
  const group = '120363000000000001@g.us';
  const alice = '111111111111111@lid';
  const bob = '222222222222222@lid';
  // The roster as Baileys lists a lid-addressed group: the lid with the phone number beside it, and this
  // account among the members.
  const roster = [
    [alice, '6281111111111@s.whatsapp.net'],
    [bob, '6282222222222@s.whatsapp.net'],
    ['999999999999999@lid', '6280000000000@s.whatsapp.net'],
  ];
  const own = { user: { id: '6280000000000:3@s.whatsapp.net', lid: '999999999999999@lid' } } as unknown as WASocket;
  const delivered = (userJid: string, remoteJid = group) => ({
    key: { id: 'OUT1', remoteJid, fromMe: true },
    receipt: { userJid, receiptTimestamp: 1 },
  });
  const read = (userJid: string) => ({
    key: { id: 'OUT1', remoteJid: group, fromMe: true },
    receipt: { userJid, readTimestamp: 2 },
  });
  const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

  function setup(overrides: Partial<BaileysEventsHost> = {}) {
    const onMessageAck = jest.fn();
    const readGroupRoster = jest.fn(() => Promise.resolve(roster));
    const events = new BaileysEvents(
      makeHost({ getOnMessageAck: () => onMessageAck, readGroupRoster, getSocketOrNull: () => own, ...overrides }),
    );
    return { events, onMessageAck, readGroupRoster };
  }

  it('reports delivered and then read once every other member has received and read the message', async () => {
    const { events, onMessageAck, readGroupRoster } = setup();
    events.handleMessageReceiptUpdate([delivered(alice), delivered(alice), delivered('999999999999999@lid')]);
    await settle();
    expect(onMessageAck).not.toHaveBeenCalled();

    events.handleMessageReceiptUpdate([delivered(bob)]);
    await settle();
    expect(onMessageAck.mock.calls).toEqual([['OUT1', 'delivered', group]]);

    events.handleMessageReceiptUpdate([read(alice)]);
    await settle();
    expect(onMessageAck).toHaveBeenCalledTimes(1);

    events.handleMessageReceiptUpdate([read(bob)]);
    await settle();
    expect(onMessageAck.mock.calls).toEqual([
      ['OUT1', 'delivered', group],
      ['OUT1', 'read', group],
    ]);
    expect(readGroupRoster).toHaveBeenCalledTimes(1);
  });

  it('does not wait for this account, whose own devices are left out of the roster', async () => {
    const { events, onMessageAck } = setup();
    events.handleMessageReceiptUpdate([delivered(alice), delivered(bob)]);
    await settle();
    expect(onMessageAck.mock.calls).toEqual([['OUT1', 'delivered', group]]);
  });

  it('still reports the per-recipient events beside the aggregate ack', async () => {
    const onMessageReceipt = jest.fn();
    const { events, onMessageAck } = setup({ getOnMessageReceipt: () => onMessageReceipt });
    events.handleMessageReceiptUpdate([delivered(alice), delivered(bob)]);
    await settle();
    expect(onMessageReceipt).toHaveBeenCalledTimes(2);
    expect(onMessageAck).toHaveBeenCalledTimes(1);
  });

  it('leaves a status post at sent', async () => {
    const { events, onMessageAck, readGroupRoster } = setup();
    events.handleMessageReceiptUpdate([delivered(alice, 'status@broadcast'), delivered(bob, 'status@broadcast')]);
    await settle();
    expect(readGroupRoster).not.toHaveBeenCalled();
    expect(onMessageAck).not.toHaveBeenCalled();
  });

  it('reports no ack when the engine cannot read a roster, and still reports the receipts', async () => {
    const onMessageReceipt = jest.fn();
    const { events, onMessageAck } = setup({ readGroupRoster: undefined, getOnMessageReceipt: () => onMessageReceipt });
    events.handleMessageReceiptUpdate([delivered(alice), delivered(bob)]);
    await settle();
    expect(onMessageReceipt).toHaveBeenCalledTimes(2);
    expect(onMessageAck).not.toHaveBeenCalled();
  });

  it('does nothing without an ack callback or a receipt callback', async () => {
    const { events, readGroupRoster } = setup({ getOnMessageAck: () => undefined });
    events.handleMessageReceiptUpdate([delivered(alice), delivered(bob)]);
    await settle();
    expect(readGroupRoster).not.toHaveBeenCalled();
  });

  it('stops waiting for a member who leaves the group', async () => {
    const { events, onMessageAck } = setup();
    events.handleMessageReceiptUpdate([delivered(alice)]);
    await settle();
    expect(onMessageAck).not.toHaveBeenCalled();

    // Baileys 7 lists a departure as objects that carry the lid and the phone number
    events.handleGroupParticipantsUpdate({
      id: group,
      action: 'remove',
      participants: [{ id: bob, phoneNumber: '6282222222222@s.whatsapp.net' }],
    });
    expect(onMessageAck.mock.calls).toEqual([['OUT1', 'delivered', group]]);
  });

  it('keeps waiting through an add, a promotion and a departure from another group', async () => {
    const { events, onMessageAck } = setup();
    events.handleMessageReceiptUpdate([delivered(alice)]);
    await settle();
    events.handleGroupParticipantsUpdate({ id: group, action: 'add', participants: [{ id: bob }] });
    events.handleGroupParticipantsUpdate({ id: group, action: 'promote', participants: [{ id: bob }] });
    events.handleGroupParticipantsUpdate({ id: '120363000000000009@g.us', action: 'remove', participants: [bob] });
    expect(onMessageAck).not.toHaveBeenCalled();
  });

  it('waits for a member who joins while the roster of the group is being read', async () => {
    const answers: Array<(rows: string[][]) => void> = [];
    const readGroupRoster = jest.fn(() => new Promise<string[][]>(resolve => answers.push(resolve)));
    const { events, onMessageAck } = setup({ readGroupRoster });
    const ownRow = ['999999999999999@lid', '6280000000000@s.whatsapp.net'];

    events.handleMessageReceiptUpdate([delivered(alice)]);
    events.handleGroupParticipantsUpdate({ id: group, action: 'add', participants: [{ id: bob }] });
    events.handleMessageReceiptUpdate([
      { key: { id: 'OUT2', remoteJid: group, fromMe: true }, receipt: { userJid: alice, receiptTimestamp: 1 } },
    ]);
    expect(readGroupRoster).toHaveBeenCalledTimes(2);

    answers[0]([roster[0], ownRow]); // the read that began before Bob joined
    await settle();
    answers[1](roster);
    await settle();
    expect(onMessageAck).not.toHaveBeenCalled();

    events.handleMessageReceiptUpdate([delivered(bob)]);
    await settle();
    expect(onMessageAck.mock.calls).toEqual([['OUT1', 'delivered', group]]);
  });

  it("recognises this account's row by the phone number the session knows for its lid", async () => {
    // Credentials without `user.lid`, and a roster row for this account that lists only its lid
    const { events, onMessageAck } = setup({
      getSocketOrNull: () => ({ user: { id: '6280000000000:3@s.whatsapp.net' } }) as unknown as WASocket,
      resolvePhone: jid => (jid === '999999999999999@lid' ? '6280000000000' : null),
      readGroupRoster: () => Promise.resolve([[alice], [bob], ['999999999999999@lid']]),
    });
    events.handleMessageReceiptUpdate([delivered(alice), delivered(bob)]);
    await settle();
    expect(onMessageAck.mock.calls).toEqual([['OUT1', 'delivered', group]]);
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

describe('BaileysEvents partial decryption and ciphertext stubs', () => {
  const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 12; i++) await flush();
  };

  function setup() {
    const logger = createLogger('BaileysEventsCiphertextSpec');
    const debugSpy = jest.spyOn(logger, 'debug');
    const stored = new Map<string, WAMessage>();
    const onMessage = jest.fn();
    const onMessageCreate = jest.fn();
    const events = new BaileysEvents(
      makeHost({
        logger,
        getStoredMessage: id => Promise.resolve(stored.get(id) ?? null),
        putStoredMessage: msg => {
          if (msg.key?.id) stored.set(msg.key.id, msg);
          return Promise.resolve();
        },
        getOnMessage: () => onMessage,
        getOnMessageCreate: () => onMessageCreate,
      }),
    );
    return { events, stored, onMessage, onMessageCreate, debugSpy };
  }

  beforeEach(() => downloadMediaMessage.mockReset());

  it('drops a partial decryption leaving only messageContextInfo with CIPHERTEXT stub before storing, and delivers a redelivery of the same id', async () => {
    const { events, stored, onMessage, debugSpy } = setup();
    const key = {
      id: 'PARTIAL-1',
      remoteJid: 'status@broadcast',
      participant: '6281111111111@s.whatsapp.net',
      fromMe: false,
    };

    events.handleMessagesUpsert({
      type: 'notify',
      messages: [
        {
          key,
          messageTimestamp: 1_700_000_000,
          messageStubType: 2,
          message: { messageContextInfo: { deviceListMetadataVersion: 2 } },
        },
      ],
    });
    await settle();

    expect(onMessage).not.toHaveBeenCalled();
    expect(stored.size).toBe(0);
    expect(debugSpy).toHaveBeenCalledWith(
      'Dropping contentless protocol message',
      expect.objectContaining({
        action: 'baileys_drop_protocol_noise',
        msgId: 'PARTIAL-1',
        keys: ['messageContextInfo'],
        ciphertextStub: true,
      }),
    );

    events.handleMessagesUpsert({
      type: 'notify',
      messages: [
        {
          key,
          messageTimestamp: 1_700_000_001,
          message: {
            extendedTextMessage: { text: 'real story' },
            messageContextInfo: { deviceListMetadataVersion: 2 },
          },
        },
      ],
    });
    await settle();

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'PARTIAL-1',
        chatId: 'status@broadcast',
        type: 'text',
        body: 'real story',
      }),
    );
    expect(stored.has('PARTIAL-1')).toBe(true);
  });

  it('keeps emitting and storing a lone messageContextInfo as unknown when messageStubType is not CIPHERTEXT', async () => {
    const { events, stored, onMessage } = setup();

    events.handleMessagesUpsert({
      type: 'notify',
      messages: [
        {
          key: { id: 'UNK-CTX-1', remoteJid: '6281111111111@s.whatsapp.net', fromMe: false },
          messageTimestamp: 1_700_000_000,
          message: { messageContextInfo: { messageSecret: Buffer.from('cw==', 'base64') } },
        },
      ],
    });
    await settle();

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'UNK-CTX-1',
        type: 'unknown',
      }),
    );
    expect(stored.has('UNK-CTX-1')).toBe(true);
  });

  it('still delivers a status with readable content when messageStubType is CIPHERTEXT', async () => {
    const { events, stored, onMessage } = setup();

    events.handleMessagesUpsert({
      type: 'notify',
      messages: [
        {
          key: {
            id: 'ST-CIPHER-OK',
            remoteJid: 'status@broadcast',
            participant: '6281111111111@s.whatsapp.net',
            fromMe: false,
          },
          messageTimestamp: 1_700_000_000,
          messageStubType: 2,
          message: {
            extendedTextMessage: { text: 'readable status' },
            messageContextInfo: { deviceListMetadataVersion: 2 },
          },
        },
      ],
    });
    await settle();

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'ST-CIPHER-OK',
        chatId: 'status@broadcast',
        type: 'text',
        body: 'readable status',
        fromMe: false,
      }),
    );
    expect(stored.has('ST-CIPHER-OK')).toBe(true);
  });
});

/** Waits for `condition` between event-loop turns and fails at the deadline instead of hanging. */
async function until(condition: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(resolve => setImmediate(resolve));
  }
}

describe('BaileysEvents a message that merged a fast-ratchet distribution before its content', () => {
  const DISTRIBUTION = 'fastRatchetKeySenderKeyDistributionMessage';
  const PEER = '6281111111111@s.whatsapp.net';
  const secret = { messageSecret: Buffer.alloc(32, 7) };

  /** What the merge of a stanza's decrypted parts leaves: the distribution first, then the content and its context. */
  const merged = (id: string, content: Record<string, unknown>): WAMessage => ({
    key: { id, remoteJid: PEER, fromMe: false },
    messageTimestamp: 1_700_000_000,
    message: { [DISTRIBUTION]: { groupId: 'g' }, ...content, messageContextInfo: secret },
  });

  const image = (over: Record<string, unknown> = {}) => ({
    imageMessage: {
      mimetype: 'image/jpeg',
      fileLength: 3,
      url: 'https://mmg.whatsapp.net/v/t62/x.enc',
      directPath: '/v/t62/x.enc',
      ...over,
    },
  });

  function setup() {
    const stored = new Map<string, WAMessage>();
    const onMessage = jest.fn();
    const events = new BaileysEvents(
      makeHost({
        getStoredMessage: id => Promise.resolve(stored.get(id) ?? null),
        putStoredMessage: msg => {
          if (msg.key?.id) stored.set(msg.key.id, msg);
          return Promise.resolve();
        },
        getOnMessage: () => onMessage,
      }),
    );
    return { events, stored, onMessage };
  }

  beforeEach(() => {
    downloadMediaMessage.mockReset();
    downloadMediaMessage.mockImplementation(() => Promise.resolve(streamOf(Buffer.from('IMG'))));
  });

  it('hands the download and the store the message without the distribution, and announces it by its content', async () => {
    const { events, stored, onMessage } = setup();
    const received = merged('IMG1', image());

    events.handleMessagesUpsert({ type: 'notify', messages: [received] });
    await until(() => onMessage.mock.calls.length === 1, 'the image to be announced');

    expect(downloadMediaMessage).toHaveBeenCalledTimes(1);
    const [downloaded] = downloadMediaMessage.mock.calls[0] as [WAMessage];
    expect(Object.keys(downloaded.message ?? {})).toEqual(['imageMessage', 'messageContextInfo']);
    // What the library keeps reading the message by, and what a later edit, reaction or vote is read with.
    expect(Object.keys(stored.get('IMG1')?.message ?? {})).toEqual(['imageMessage', 'messageContextInfo']);
    expect(stored.get('IMG1')?.message?.messageContextInfo?.messageSecret).toBe(secret.messageSecret);
    const [announced] = onMessage.mock.calls[0] as [{ media?: { data?: string } }];
    expect(announced).toMatchObject({ id: 'IMG1', type: 'image' });
    expect(announced.media?.data).toBe('SU1H');
    // Baileys' own copy is the one it keeps, and may still read.
    expect(Object.keys(received.message ?? {})[0]).toBe(DISTRIBUTION);
  });

  it('refuses the media of such a message whose address is outside WhatsApp hosts, as for any other', async () => {
    const { events, onMessage } = setup();

    events.handleMessagesUpsert({
      type: 'notify',
      messages: [merged('IMG2', image({ url: 'http://127.0.0.1/latest/meta-data/', directPath: undefined }))],
    });
    await until(() => onMessage.mock.calls.length === 1, 'the image to be announced');

    expect(downloadMediaMessage).not.toHaveBeenCalled();
    expect(onMessage.mock.calls[0]).toMatchObject([{ id: 'IMG2', type: 'image', media: { omitted: true } }]);
  });

  it('still drops a distribution that stands alone as protocol noise', async () => {
    const { events, stored, onMessage } = setup();

    // A text behind it, as the control that the handler ran: once that is announced, the distribution has been judged.
    events.handleMessagesUpsert({
      type: 'notify',
      messages: [
        {
          key: { id: 'LONE1', remoteJid: PEER, fromMe: false },
          messageTimestamp: 1_700_000_000,
          message: { [DISTRIBUTION]: {} },
        },
        {
          key: { id: 'TEXT1', remoteJid: PEER, fromMe: false },
          messageTimestamp: 1_700_000_001,
          message: { conversation: 'after' },
        },
      ],
    });
    await until(() => onMessage.mock.calls.length >= 1, 'the text to be announced');

    expect(onMessage.mock.calls.map(([incoming]: [{ id: string }]) => incoming.id)).toEqual(['TEXT1']);
    expect([...stored.keys()]).toEqual(['TEXT1']);
  });

  it('reserves room for the download of such an image, as for one that merged after it', () => {
    const { events } = setup();
    const after = { ...merged('IMG3', {}), message: { ...image(), [DISTRIBUTION]: {} } } as unknown as WAMessage;

    expect(events.plannedMediaDownload(libStub, merged('IMG4', image()))).toBe(true);
    expect(events.plannedMediaDownload(libStub, after)).toBe(true);
  });
});

describe('BaileysEvents own status addressed by LID', () => {
  const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 12; i++) await flush();
  };

  function setup(overrides: Partial<BaileysEventsHost> = {}) {
    const stored = new Map<string, WAMessage>();
    const onMessage = jest.fn();
    const onMessageCreate = jest.fn();
    const events = new BaileysEvents(
      makeHost({
        toNeutralJid: jid => toNeutralJid(jid),
        getSocketOrNull: () =>
          ({ user: { id: '6280000000000:1@s.whatsapp.net', lid: '99999:1@lid' } }) as unknown as WASocket,
        getStoredMessage: id => Promise.resolve(stored.get(id) ?? null),
        putStoredMessage: msg => {
          if (msg.key?.id) stored.set(msg.key.id, msg);
          return Promise.resolve();
        },
        getOnMessage: () => onMessage,
        getOnMessageCreate: () => onMessageCreate,
        ...overrides,
      }),
    );
    return { events, stored, onMessage, onMessageCreate };
  }

  beforeEach(() => {
    downloadMediaMessage.mockReset();
    downloadMediaMessage.mockImplementation(() => Promise.resolve(streamOf(Buffer.from('IMG'))));
  });

  it('treats an own status addressed by the account LID with fromMe false as own without mutating the input or downloading media, and consumes an API-sent echo', async () => {
    const sentIds = new Set(['ST-API-1']);
    const consumeOwnSend = jest.fn((id: string | null | undefined) => !!id && sentIds.delete(id));
    const { events, stored, onMessage, onMessageCreate } = setup({ consumeOwnSend });
    const rawKey = { id: 'ST-OWN-1', remoteJid: 'status@broadcast', participant: '99999@lid', fromMe: false };
    const rawMsg: WAMessage = {
      key: rawKey,
      messageTimestamp: 1_700_000_000,
      message: {
        imageMessage: {
          mimetype: 'image/jpeg',
          fileLength: 64,
          url: 'https://mmg.whatsapp.net/v/t62/x.enc',
          directPath: '/v/t62/x.enc',
        },
      },
    };

    events.handleMessagesUpsert({ type: 'notify', messages: [rawMsg] });
    await settle();

    expect(downloadMediaMessage).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
    expect(onMessageCreate).toHaveBeenCalledTimes(1);
    expect(onMessageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'ST-OWN-1',
        chatId: 'status@broadcast',
        fromMe: true,
        media: { mimetype: 'image/jpeg', filename: undefined, omitted: true, sizeBytes: 64 },
      }),
    );
    expect(stored.get('ST-OWN-1')?.key.fromMe).toBe(true);
    expect(rawMsg.key).toBe(rawKey);
    expect(rawMsg.key.fromMe).toBe(false);

    const echoKey = { id: 'ST-API-1', remoteJid: 'status@broadcast', participant: '99999@lid', fromMe: false };
    const echoMsg: WAMessage = {
      key: echoKey,
      messageTimestamp: 1_700_000_001,
      message: { extendedTextMessage: { text: 'api status' } },
    };

    events.handleMessagesUpsert({ type: 'append', messages: [echoMsg] });
    await settle();

    expect(consumeOwnSend).toHaveBeenCalledWith('ST-API-1');
    expect(sentIds.has('ST-API-1')).toBe(false);
    expect(onMessage).not.toHaveBeenCalled();
    expect(onMessageCreate).toHaveBeenCalledTimes(1);
    expect(stored.has('ST-API-1')).toBe(false);
    expect(echoMsg.key.fromMe).toBe(false);
  });

  it('leaves a contact status unaffected', async () => {
    const { events, stored, onMessage, onMessageCreate } = setup({
      resolvePhone: jid => (jid === '11111@lid' ? '6281111111111' : null),
    });

    events.handleMessagesUpsert({
      type: 'notify',
      messages: [
        {
          key: { id: 'ST-CONTACT-1', remoteJid: 'status@broadcast', participant: '11111@lid', fromMe: false },
          messageTimestamp: 1_700_000_000,
          message: {
            imageMessage: {
              mimetype: 'image/jpeg',
              fileLength: 3,
              url: 'https://mmg.whatsapp.net/v/t62/contact.enc',
              directPath: '/v/t62/contact.enc',
            },
          },
        },
      ],
    });
    await settle();

    expect(downloadMediaMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'ST-CONTACT-1',
        chatId: 'status@broadcast',
        fromMe: false,
      }),
    );
    expect(onMessageCreate).not.toHaveBeenCalled();
    expect(stored.get('ST-CONTACT-1')?.key.fromMe).toBe(false);
  });

  it('reads the direction of a message outside the status feed as the library reports it', async () => {
    const { events, onMessage, onMessageCreate } = setup();

    events.handleMessagesUpsert({
      type: 'notify',
      messages: [
        {
          key: { id: 'GRP-1', remoteJid: '120363000000000001@g.us', participant: '99999@lid', fromMe: false },
          messageTimestamp: 1_700_000_000,
          message: { conversation: 'hello' },
        },
      ],
    });
    await settle();

    expect(onMessageCreate).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 'GRP-1', fromMe: false }));
  });

  it('recognises the account LID via resolvePhone when credentials carry no user.lid', async () => {
    const { events, stored, onMessage, onMessageCreate } = setup({
      getSocketOrNull: () => ({ user: { id: '6280000000000:1@s.whatsapp.net' } }) as unknown as WASocket,
      resolvePhone: jid => (jid === '99999@lid' ? '6280000000000' : null),
    });
    const rawKey = { id: 'ST-RESOLVED-LID', remoteJid: 'status@broadcast', participant: '99999@lid', fromMe: false };

    events.handleMessagesUpsert({
      type: 'notify',
      messages: [
        {
          key: rawKey,
          messageTimestamp: 1_700_000_000,
          message: {
            imageMessage: {
              mimetype: 'image/jpeg',
              fileLength: 64,
              url: 'https://mmg.whatsapp.net/v/t62/own.enc',
              directPath: '/v/t62/own.enc',
            },
          },
        },
      ],
    });
    await settle();

    expect(downloadMediaMessage).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
    expect(onMessageCreate).toHaveBeenCalledTimes(1);
    expect(onMessageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'ST-RESOLVED-LID',
        chatId: 'status@broadcast',
        fromMe: true,
        media: { mimetype: 'image/jpeg', filename: undefined, omitted: true, sizeBytes: 64 },
      }),
    );
    expect(stored.get('ST-RESOLVED-LID')?.key.fromMe).toBe(true);
    expect(rawKey.fromMe).toBe(false);
  });

  it.each([
    ['participantAlt', { participant: '99999@lid', participantAlt: '6280000000000@s.whatsapp.net' }],
    ['remoteJidAlt', { participant: '99999@lid', remoteJidAlt: '6280000000000@s.whatsapp.net' }],
  ])('recognises an own status via %s when credentials carry no user.lid', async (_field, altKeys) => {
    const { events, stored, onMessage, onMessageCreate } = setup({
      getSocketOrNull: () => ({ user: { id: '6280000000000:1@s.whatsapp.net' } }) as unknown as WASocket,
    });

    events.handleMessagesUpsert({
      type: 'notify',
      messages: [
        {
          key: { id: 'ST-ALT-SELF', remoteJid: 'status@broadcast', fromMe: false, ...altKeys },
          messageTimestamp: 1_700_000_000,
          message: {
            imageMessage: {
              mimetype: 'image/jpeg',
              fileLength: 64,
              url: 'https://mmg.whatsapp.net/v/t62/alt.enc',
              directPath: '/v/t62/alt.enc',
            },
          },
        },
      ],
    });
    await settle();

    expect(downloadMediaMessage).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
    expect(onMessageCreate).toHaveBeenCalledWith(expect.objectContaining({ id: 'ST-ALT-SELF', fromMe: true }));
    expect(stored.get('ST-ALT-SELF')?.key.fromMe).toBe(true);
  });
});

describe('BaileysEvents removal of a conflicting copy the store refused', () => {
  it("is kept, and removes the copy once the store answers if it still carries that delivery's key", async () => {
    const peer = '6282222222222@s.whatsapp.net';
    const kept: Array<{ messageId: string; change: StoredChange }> = [];
    const removed: string[] = [];
    let failing = true;
    const copy = { key: { id: 'C1', remoteJid: peer, fromMe: false }, message: { conversation: 'hi' } } as WAMessage;
    const events = new BaileysEvents(
      makeHost({
        getOnMessage: () => () => ({ settled: Promise.resolve({ conflict: true }) }),
        removeStoredMessage: (id: string, shouldRemove: (stored: WAMessage) => boolean) => {
          if (failing) {
            return Promise.reject(Object.assign(new Error('Connection terminated'), { code: 'ECONNREFUSED' }));
          }
          if (shouldRemove(copy)) removed.push(id);
          return Promise.resolve();
        },
        keepStoredChange: (messageId: string, _changeId: string, change: StoredChange) =>
          kept.push({ messageId, change }),
      }),
    );

    events.handleMessagesUpsert({
      type: 'notify',
      messages: [{ key: copy.key, messageTimestamp: 1_700_000_000, message: { conversation: 'hi' } }],
    });
    const deadline = Date.now() + 5_000;
    while (kept.length === 0 && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
    expect(kept).toEqual([{ messageId: 'C1', change: expect.objectContaining({ kind: 'remove' }) as unknown }]);

    failing = false;
    await events.restoreStoredChange('C1', JSON.parse(JSON.stringify(kept[0].change)) as StoredChange);

    expect(removed).toEqual(['C1']);
  });
});

describe('BaileysEvents record of conflicting copies removed', () => {
  it('forgets the id removed longest ago once it holds its limit', async () => {
    const limit = BaileysEvents.DELETED_FOR_EVERYONE_LIMIT;
    const settled = Promise.resolve({ conflict: true });
    const events = new BaileysEvents(makeHost({ getOnMessage: () => () => ({ settled }) }));
    const removals = (events as unknown as { copyRemovals: Map<string, number> }).copyRemovals;
    // Waits for the removals to be recorded, with a deadline: how many turns of the event loop thousands of messages take
    // depends on the machine, so no fixed number of them is enough.
    const deliver = async (ids: string[], recorded: () => boolean): Promise<void> => {
      events.handleMessagesUpsert({
        type: 'notify',
        messages: ids.map(id => ({
          key: { id, remoteJid: '6282222222222@s.whatsapp.net', fromMe: false },
          messageTimestamp: 1_700_000_000,
          message: { conversation: 'hi' },
        })),
      });
      const deadline = Date.now() + 30_000;
      while (!recorded() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    };

    await deliver(
      Array.from({ length: limit }, (_, i) => `M${i}`),
      () => removals.size === limit,
    );
    expect(removals.size).toBe(limit);
    // M0 is removed again, which makes it the newest, and one more id pushes the oldest out.
    await deliver(['M0'], () => removals.get('M0') === 2);
    await deliver(['EXTRA'], () => removals.has('EXTRA'));

    expect(removals.size).toBe(limit);
    expect(removals.get('M0')).toBe(2);
    expect(removals.has('M1')).toBe(false);
    expect(removals.get('EXTRA')).toBe(1);
  }, 120_000);
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

    it("reports a guest's answer by phone number to the account's own event kept under the guest's lid", async () => {
      const onEventResponse = jest.fn();
      const events = new BaileysEvents(
        makeHost({
          getOnEventResponse: () => onEventResponse,
          // Posted from the phone in a chat addressed by lid there: the account's own number sits beside the lid.
          getStoredMessage: storedIn('99887766@lid', { fromMe: true, remoteJidAlt: '6280000000000@s.whatsapp.net' }),
          toNeutralJid: jid => toNeutralJid(jid),
        }),
      );

      events.handleMessagesUpdate([
        {
          key: { id: 'EVT1', remoteJid: '6280000000000@s.whatsapp.net', fromMe: false },
          update: {
            eventResponses: [
              rsvp({
                eventResponseMessageKey: { id: 'RSVP10', remoteJid: '6282222222222@s.whatsapp.net', fromMe: false },
              }),
            ],
          },
        },
      ] as never);
      await flush();

      expect(onEventResponse).toHaveBeenCalledWith(expect.objectContaining({ chatId: '6282222222222@c.us' }));
    });

    it("reports the account's own answer from a lid chat to a contact's event kept under the number", async () => {
      const onEventResponse = jest.fn();
      const events = new BaileysEvents(
        makeHost({
          getOnEventResponse: () => onEventResponse,
          getStoredMessage: storedIn('6282222222222@s.whatsapp.net'),
          toNeutralJid: jid => toNeutralJid(jid),
        }),
      );

      events.handleMessagesUpdate([
        {
          key: { id: 'EVT1', remoteJid: '99887766@lid', fromMe: false },
          update: {
            eventResponses: [
              rsvp({
                // Typed on the phone: Baileys files the account's own number beside the chat's lid.
                eventResponseMessageKey: {
                  id: 'RSVP12',
                  remoteJid: '99887766@lid',
                  remoteJidAlt: '6280000000000@s.whatsapp.net',
                  fromMe: true,
                },
              }),
            ],
          },
        },
      ] as never);
      await flush();

      expect(onEventResponse).toHaveBeenCalledTimes(1);
    });

    it('drops an answer from a lid whose own phone number is not the chat of the event', async () => {
      const onEventResponse = jest.fn();
      const logger = createLogger('BaileysEventsSpec');
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const events = new BaileysEvents(
        makeHost({
          getOnEventResponse: () => onEventResponse,
          getStoredMessage: storedIn('6282222222222@s.whatsapp.net', { fromMe: true }),
          toNeutralJid: jid => toNeutralJid(jid),
          logger,
        }),
      );

      events.handleMessagesUpdate([
        {
          key: { id: 'EVT1', remoteJid: '6280000000000@s.whatsapp.net', fromMe: false },
          update: {
            eventResponses: [
              rsvp({
                eventResponseMessageKey: {
                  id: 'RSVP11',
                  remoteJid: '55443322@lid',
                  remoteJidAlt: '6283333333333@s.whatsapp.net',
                  fromMe: false,
                },
              }),
            ],
          },
        },
      ] as never);
      await flush();

      expect(onEventResponse).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        'Dropping an event response sent in a chat other than its event',
        expect.objectContaining({ responseMessageId: 'RSVP11' }),
      );
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

  it('drops an in-flight RSVP when fenceStoredWrites advances the generation', async () => {
    const onEventResponse = jest.fn();
    let releaseStore!: (v: null) => void;
    const storeGate = new Promise<null>(resolve => {
      releaseStore = resolve;
    });
    const events1 = new BaileysEvents(
      makeHost({ getOnEventResponse: () => onEventResponse, getStoredMessage: () => storeGate }),
    );

    events1.handleMessagesUpdate([
      {
        key: eventKey,
        update: {
          eventResponses: [
            rsvp({
              eventResponseMessageKey: {
                id: 'RSVP9',
                remoteJid: group,
                participant: '6282222222222@s.whatsapp.net',
                fromMe: false,
              },
            }),
          ],
        },
      },
    ] as never);
    await flush();
    events1.fenceStoredWrites();
    releaseStore(null);
    await flush();

    expect(onEventResponse).not.toHaveBeenCalled();

    let releaseLib!: (lib: Awaited<ReturnType<BaileysEventsHost['loadLib']>>) => void;
    const libGate = new Promise<Awaited<ReturnType<BaileysEventsHost['loadLib']>>>(resolve => {
      releaseLib = resolve;
    });
    const events2 = new BaileysEvents(
      makeHost({
        getOnEventResponse: () => onEventResponse,
        getStoredMessage: () =>
          Promise.resolve({ key: eventKey, message: { eventMessage: { name: 'Launch' } } } as never),
        loadLib: () => libGate,
      }),
    );

    events2.handleMessagesUpdate([
      {
        key: eventKey,
        update: {
          eventResponses: [
            rsvp({
              eventResponseMessageKey: {
                id: 'RSVP12',
                remoteJid: group,
                participant: '6282222222222@s.whatsapp.net',
                fromMe: false,
              },
            }),
          ],
        },
      },
    ] as never);
    await flush();
    events2.fenceStoredWrites();
    releaseLib(libStub);
    await flush();

    expect(onEventResponse).not.toHaveBeenCalled();
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

  it('reads an encrypted edit of a message stored from an upsert that merged a fast-ratchet distribution before its content', async () => {
    const held = new Map<string, WAMessage>();
    const { events, onMessageEdited } = setup({
      putStoredMessage: msg => {
        if (msg.key?.id) held.set(msg.key.id, msg);
        return Promise.resolve();
      },
      getStoredMessage: id => Promise.resolve(held.get(id) ?? null),
    });
    const merged = original({
      message: {
        fastRatchetKeySenderKeyDistributionMessage: { groupId: group },
        conversation: 'old text',
        messageContextInfo: { messageSecret: secret.toString('base64') },
      },
    });

    events.handleMessagesUpsert({ type: 'notify', messages: [merged] });
    await until(() => held.has('ORIG1'), 'the original to be stored');
    // The stored copy lost the distribution and kept the secret the edit is read with.
    expect(Object.keys(held.get('ORIG1')?.message ?? {})).toEqual(['conversation', 'messageContextInfo']);

    events.handleMessagesUpsert({ type: 'notify', messages: [editEnvelope()] });
    await until(() => onMessageEdited.mock.calls.length === 1, 'the edit to be announced');

    expect(onMessageEdited).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'ORIG1', body: 'new text' }));
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

describe('BaileysEvents poll votes', () => {
  const findPackageDir = (start: string, pkgName: string): string => {
    let dir = start;
    for (;;) {
      const candidate = join(dir, 'node_modules', ...pkgName.split('/'));
      if (existsSync(join(candidate, 'package.json'))) return candidate;
      const parent = dirname(dir);
      if (parent === dir) throw new Error(`Unable to locate ${pkgName} package`);
      dir = parent;
    }
  };

  const loadBaileysModules = (): {
    decryptPollVote: typeof import('@whiskeysockets/baileys').decryptPollVote;
    proto: typeof import('@whiskeysockets/baileys').proto;
  } => {
    const baileysDir = findPackageDir(__dirname, '@whiskeysockets/baileys');
    const cache = new Map<string, { exports: Record<string, unknown> }>();

    const resolvePackageEntry = (fromDir: string, spec: string): string => {
      const parts = spec.split('/');
      const pkgName = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
      const pkgDir = findPackageDir(fromDir, pkgName);
      const pkgJson = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
        main?: string;
        exports?: Record<string, unknown>;
      };
      const subKey =
        parts.length > (spec.startsWith('@') ? 2 : 1)
          ? `./${parts.slice(spec.startsWith('@') ? 2 : 1).join('/')}`
          : '.';
      const pick = (node: unknown): string | undefined => {
        if (typeof node === 'string') return node;
        if (!node || typeof node !== 'object') return undefined;
        const rec = node as Record<string, unknown>;
        return pick(rec.import) ?? pick(rec.default) ?? pick(rec.node);
      };
      const targetExp = subKey === '.' ? (pkgJson.exports?.['.'] ?? pkgJson.exports) : pkgJson.exports?.[subKey];
      const entry = pick(targetExp) ?? (subKey === '.' ? pkgJson.main : `./${subKey.slice(2)}`);
      return resolve(pkgDir, entry ?? 'index.js');
    };

    const loadFile = (filePath: string): Record<string, unknown> => {
      const cached = cache.get(filePath);
      if (cached) return cached.exports;
      const mod: { exports: Record<string, unknown> } = { exports: {} };
      cache.set(filePath, mod);
      const source = readFileSync(filePath, 'utf8');
      const code = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true, target: ts.ScriptTarget.ES2022 },
      }).outputText;
      const baseRequire = createRequire(filePath);
      const localRequire = (spec: string): unknown => {
        if (spec.startsWith('./') || spec.startsWith('../')) {
          let target = resolve(dirname(filePath), spec);
          if (existsSync(target) && statSync(target).isDirectory()) target = join(target, 'index.js');
          if (target.endsWith('.js') || target.endsWith('.mjs')) return loadFile(target);
          return baseRequire(target);
        }
        try {
          return baseRequire(spec);
        } catch {
          return loadFile(resolvePackageEntry(dirname(filePath), spec));
        }
      };
      const fn = compileFunction(code, ['exports', 'require', 'module', '__filename', '__dirname']) as (
        exports: Record<string, unknown>,
        require: (spec: string) => unknown,
        module: { exports: Record<string, unknown> },
        filename: string,
        dirname: string,
      ) => void;
      fn(mod.exports, localRequire, mod, filePath, dirname(filePath));
      return mod.exports;
    };

    const procMod = loadFile(join(baileysDir, 'lib', 'Utils', 'process-message.js'));
    const protoMod = loadFile(join(baileysDir, 'WAProto', 'index.js'));
    return {
      decryptPollVote: procMod.decryptPollVote as typeof import('@whiskeysockets/baileys').decryptPollVote,
      proto: protoMod.proto as typeof import('@whiskeysockets/baileys').proto,
    };
  };

  let proto!: typeof import('@whiskeysockets/baileys').proto;
  let lib!: Awaited<ReturnType<BaileysEventsHost['loadLib']>>;

  beforeAll(() => {
    const real = loadBaileysModules();
    proto = real.proto;
    lib = {
      ...libStub,
      decryptPollVote: real.decryptPollVote,
      proto: real.proto,
    };
  }, 30_000);
  const group = '120363000000000001@g.us';
  const otherGroup = '120363000000000002@g.us';
  const selfPhone = '6280000000000@s.whatsapp.net';
  const selfLid = '10000000000001@lid';
  const peerPhone = '6281111111111@s.whatsapp.net';
  const peerLid = '39900313301142@lid';
  const voterPhone = '6282222222222@s.whatsapp.net';
  const voterLid = '195700218425410@lid';
  const secret = Buffer.alloc(32, 0x33);

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
  };

  function sealPollVote(
    ids: { pollMsgId: string; pollCreatorJid: string; voterJid: string },
    optionNames: string[],
    withSecret: Buffer = secret,
  ): { encPayload: Buffer; encIv: Buffer } {
    const plaintext = proto.Message.PollVoteMessage.encode({
      selectedOptions: optionNames.map(name => createHash('sha256').update(name).digest()),
    }).finish();
    const key0 = createHmac('sha256', Buffer.alloc(32)).update(withSecret).digest();
    const sign = Buffer.concat([
      Buffer.from(ids.pollMsgId),
      Buffer.from(ids.pollCreatorJid),
      Buffer.from(ids.voterJid),
      Buffer.from('Poll Vote'),
      Buffer.from([1]),
    ]);
    const encKey = createHmac('sha256', key0).update(sign).digest();
    const iv = Buffer.alloc(12, 7);
    const cipher = createCipheriv('aes-256-gcm', encKey, iv);
    cipher.setAAD(Buffer.from(`${ids.pollMsgId}\u0000${ids.voterJid}`));
    const encPayload = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    return { encPayload, encIv: iv };
  }

  function makePoll(
    options: string[],
    opts: {
      id?: string;
      key?: Record<string, unknown>;
      message?: Record<string, unknown>;
      withSecret?: Buffer | null;
      name?: string;
    } = {},
  ): WAMessage {
    const id = opts.id ?? 'POLL1';
    const poll = {
      name: opts.name ?? 'Lunch?',
      options: options.map(optionName => ({ optionName })),
      selectableOptionsCount: 0,
    };
    const msgSecret =
      opts.withSecret === null ? undefined : { messageSecret: (opts.withSecret ?? secret).toString('base64') };
    return {
      key: { id, remoteJid: group, participant: peerPhone, fromMe: false, ...opts.key },
      messageTimestamp: 1_786_000_000,
      message: opts.message ?? {
        pollCreationMessageV3: poll,
        ...(msgSecret ? { messageContextInfo: msgSecret } : {}),
      },
    };
  }

  function makeVoteEnvelope(
    ids: { pollMsgId?: string; pollCreatorJid: string; voterJid: string },
    optionNames: string[],
    opts: {
      key?: Record<string, unknown>;
      senderTimestampMs?: unknown;
      messageTimestamp?: number;
      withSecret?: Buffer;
      wrapped?: boolean;
    } = {},
  ): WAMessage {
    const pollMsgId = ids.pollMsgId ?? 'POLL1';
    const sealed = sealPollVote({ ...ids, pollMsgId }, optionNames, opts.withSecret ?? secret);
    const pollUpdateMessage = {
      pollCreationMessageKey: { id: pollMsgId, remoteJid: group, fromMe: false },
      vote: sealed,
      ...(opts.senderTimestampMs !== undefined ? { senderTimestampMs: opts.senderTimestampMs } : {}),
    };
    return {
      key: { id: 'VOTE1', remoteJid: group, participant: voterPhone, fromMe: false, ...opts.key },
      messageTimestamp: opts.messageTimestamp ?? 1_786_000_005,
      message: opts.wrapped ? { ephemeralMessage: { message: { pollUpdateMessage } } } : { pollUpdateMessage },
    } as unknown as WAMessage;
  }

  function setup(
    extra: Partial<BaileysEventsHost> = {},
    stored: WAMessage | null = makePoll(['Pizza', 'Sushi', 'Tacos']),
  ) {
    const logger = createLogger('BaileysEventsPollVoteSpec');
    const debugSpy = jest.spyOn(logger, 'debug');
    const warnSpy = jest.spyOn(logger, 'warn');
    const onPollVote = jest.fn<void, [PollVoteEvent]>();
    const onMessage = jest.fn();
    const onMessageCreate = jest.fn();
    const events = new BaileysEvents(
      makeHost({
        logger,
        loadLib: () => Promise.resolve(lib),
        toNeutralJid: jid => toNeutralJid(jid),
        getSocketOrNull: () =>
          ({ user: { id: '6280000000000:1@s.whatsapp.net', lid: selfLid } }) as unknown as WASocket,
        getStoredMessage: (id: string) => Promise.resolve(stored && id === stored.key.id ? stored : null),
        getOnMessage: () => onMessage,
        getOnMessageCreate: () => onMessageCreate,
        getOnPollVote: () => onPollVote,
        ...extra,
      }),
    );
    return { events, onPollVote, onMessage, onMessageCreate, debugSpy, warnSpy };
  }

  it('emits poll.vote for a single choice and never forwards to onMessage or onMessageCreate', async () => {
    const { events, onPollVote, onMessage, onMessageCreate } = setup();
    const vote = makeVoteEnvelope({ pollCreatorJid: peerPhone, voterJid: voterPhone }, ['Sushi'], {
      key: { participant: voterPhone },
      senderTimestampMs: 1_786_000_000_123,
    });

    events.handleMessagesUpsert({ type: 'notify', messages: [vote] });
    await flush();

    expect(onPollVote).toHaveBeenCalledTimes(1);
    expect(onPollVote).toHaveBeenCalledWith({
      pollMessageId: 'POLL1',
      chatId: group,
      voterId: '6282222222222@c.us',
      selectedOptions: ['Sushi'],
      pollName: 'Lunch?',
      timestamp: 1_786_000_000,
      timestampMs: 1_786_000_000_123,
    });
    expect(onMessage).not.toHaveBeenCalled();
    expect(onMessageCreate).not.toHaveBeenCalled();
  });

  it('keeps a vote whose poll the store fails to read, and reads it once handed back', async () => {
    const poll = makePoll(['Pizza', 'Sushi', 'Tacos']);
    let failing = true;
    const kept: WAMessage[] = [];
    const { events, onPollVote } = setup({
      getStoredMessage: (id: string) =>
        failing
          ? Promise.reject(Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNREFUSED' }))
          : Promise.resolve(id === poll.key.id ? poll : null),
      keepUnreadInbound: (msg: WAMessage) => kept.push(msg),
    });
    const vote = makeVoteEnvelope({ pollCreatorJid: peerPhone, voterJid: voterPhone }, ['Sushi'], {
      key: { participant: voterPhone },
      senderTimestampMs: 1_786_000_000_123,
    });
    // As the library delivers it: its content in the protocol's own classes.
    vote.message = proto.Message.fromObject(vote.message!);

    events.handleMessagesUpsert({ type: 'notify', messages: [vote] });
    await flush();
    expect(kept).toEqual([vote]);
    expect(onPollVote).not.toHaveBeenCalled();

    failing = false;
    // Handed back as the session keeps it: through JSON, which holds its 64-bit time as a string, and revived.
    const form = { BufferJSON, proto } as unknown as typeof lib;
    await events.redeliverInbound(revivedInbound(form, keptInboundRaw(form, kept[0])));

    expect(onPollVote).toHaveBeenCalledWith(
      expect.objectContaining({ pollMessageId: 'POLL1', selectedOptions: ['Sushi'], timestampMs: 1_786_000_000_123 }),
    );
  });

  it('keeps a vote whose poll the store does not hold yet, its copy kept to be written', async () => {
    const kept: WAMessage[] = [];
    const { events, onPollVote } = setup(
      { keepUnreadInbound: (msg: WAMessage) => kept.push(msg), isStoredCopyKept: (id: string) => id === 'POLL1' },
      null,
    );
    const vote = makeVoteEnvelope({ pollCreatorJid: peerPhone, voterJid: voterPhone }, ['Sushi'], {
      key: { participant: voterPhone },
    });

    events.handleMessagesUpsert({ type: 'notify', messages: [vote] });
    await flush();

    expect(kept).toEqual([vote]);
    expect(onPollVote).not.toHaveBeenCalled();
  });

  it('emits poll.vote with multiple selected options', async () => {
    const { events, onPollVote, onMessage, onMessageCreate } = setup();
    const vote = makeVoteEnvelope({ pollCreatorJid: peerPhone, voterJid: voterPhone }, ['Pizza', 'Tacos'], {
      key: { participant: voterPhone },
      senderTimestampMs: { toNumber: () => 1_786_000_002_456 },
    });

    events.handleMessagesUpsert({ type: 'notify', messages: [vote] });
    await flush();

    expect(onPollVote).toHaveBeenCalledWith({
      pollMessageId: 'POLL1',
      chatId: group,
      voterId: '6282222222222@c.us',
      selectedOptions: ['Pizza', 'Tacos'],
      pollName: 'Lunch?',
      timestamp: 1_786_000_002,
      timestampMs: 1_786_000_002_456,
    });
    expect(onMessage).not.toHaveBeenCalled();
    expect(onMessageCreate).not.toHaveBeenCalled();
  });

  it('emits selectedOptions: [] when a voter clears their selection', async () => {
    const { events, onPollVote } = setup();
    const vote = makeVoteEnvelope({ pollCreatorJid: peerPhone, voterJid: voterPhone }, [], {
      key: { participant: voterPhone },
      messageTimestamp: 1_786_000_010,
    });

    events.handleMessagesUpsert({ type: 'notify', messages: [vote] });
    await flush();

    expect(onPollVote).toHaveBeenCalledWith({
      pollMessageId: 'POLL1',
      chatId: group,
      voterId: '6282222222222@c.us',
      selectedOptions: [],
      pollName: 'Lunch?',
      timestamp: 1_786_000_010,
      timestampMs: 1_786_000_010_000,
    });
  });

  it('hashes raw option names before bounding selectedOptions across poll proto versions', async () => {
    const veryLong = 'L'.repeat(1100);
    const manyOptions = Array.from({ length: 35 }, (_, i) => `Opt-${i}`);
    manyOptions[34] = veryLong;
    const pollContent = {
      name: 'Big poll',
      options: manyOptions.map(optionName => ({ optionName })),
      selectableOptionsCount: 0,
    };
    const variants: Array<Record<string, unknown>> = [
      { pollCreationMessage: pollContent },
      { pollCreationMessageV2: pollContent },
      { pollCreationMessageV3: pollContent },
      { pollCreationMessageV4: { message: { pollCreationMessageV3: pollContent } } },
      { pollCreationMessageV5: pollContent },
      { ephemeralMessage: { message: { pollCreationMessageV3: pollContent } } },
    ];

    for (const inner of variants) {
      const stored = makePoll(manyOptions, {
        message: { ...inner, messageContextInfo: { messageSecret: secret.toString('base64') } },
      });
      const { events, onPollVote } = setup({}, stored);
      const vote = makeVoteEnvelope({ pollCreatorJid: peerPhone, voterJid: voterPhone }, [veryLong], {
        key: { participant: voterPhone },
        senderTimestampMs: 1_786_000_003_000,
        wrapped: true,
      });

      events.handleMessagesUpsert({ type: 'notify', messages: [vote] });
      await flush();

      expect(onPollVote).toHaveBeenCalledWith(
        expect.objectContaining({
          selectedOptions: [veryLong.slice(0, 1024)],
        }),
      );
    }
  });

  it('decrypts when a LID voter answers a phone-stored poll (and own LID / phone forms)', async () => {
    // Peer phone poll, LID voter carrying participantAlt phone form (sealed with LID or phone)
    for (const sealedVoter of [voterLid, voterPhone]) {
      const stored = makePoll(['A', 'B'], { key: { participant: peerPhone, fromMe: false } });
      const { events, onPollVote } = setup({}, stored);
      const vote = makeVoteEnvelope({ pollCreatorJid: peerPhone, voterJid: sealedVoter }, ['A'], {
        key: { participant: voterLid, participantAlt: voterPhone, fromMe: false },
        senderTimestampMs: 1_786_000_004_000,
      });
      events.handleMessagesUpsert({ type: 'notify', messages: [vote] });
      await flush();
      expect(onPollVote).toHaveBeenCalledWith(expect.objectContaining({ voterId: voterLid, selectedOptions: ['A'] }));
    }

    // Own poll stored under fromMe + peer phone 1:1, voter arrives under LID sealed against ownLid
    const ownStored = makePoll(['A', 'B'], {
      key: { remoteJid: voterPhone, fromMe: true, participant: undefined },
    });
    const { events, onPollVote } = setup({}, ownStored);
    const vote = makeVoteEnvelope({ pollCreatorJid: selfLid, voterJid: voterLid }, ['B'], {
      key: { remoteJid: voterLid, remoteJidAlt: voterPhone, participant: undefined, fromMe: false },
      senderTimestampMs: 1_786_000_004_500,
    });
    events.handleMessagesUpsert({ type: 'notify', messages: [vote] });
    await flush();
    expect(onPollVote).toHaveBeenCalledWith(
      expect.objectContaining({ pollMessageId: 'POLL1', selectedOptions: ['B'] }),
    );
  });

  it('decrypts when a phone voter answers a LID-stored poll (with Alt or resolved LID)', async () => {
    const storedViaAlt = makePoll(['A', 'B'], {
      key: { participant: peerLid, participantAlt: peerPhone, fromMe: false },
    });
    const { events: events1, onPollVote: onPollVote1 } = setup({}, storedViaAlt);
    const vote1 = makeVoteEnvelope({ pollCreatorJid: peerPhone, voterJid: voterPhone }, ['B'], {
      key: { participant: voterPhone },
      senderTimestampMs: 1_786_000_005_000,
    });
    events1.handleMessagesUpsert({ type: 'notify', messages: [vote1] });
    await flush();
    expect(onPollVote1).toHaveBeenCalledWith(
      expect.objectContaining({ voterId: '6282222222222@c.us', selectedOptions: ['B'] }),
    );

    const storedWithoutAlt = makePoll(['A', 'B'], {
      key: { remoteJid: peerLid, participant: undefined, fromMe: false },
    });
    const { events: events2, onPollVote: onPollVote2 } = setup(
      {
        resolvePhone: (jid: string) => (jid === peerLid ? '6281111111111' : null),
      },
      storedWithoutAlt,
    );
    const vote2 = makeVoteEnvelope({ pollCreatorJid: peerPhone, voterJid: peerPhone }, ['A'], {
      key: { remoteJid: peerPhone, participant: undefined },
      senderTimestampMs: 1_786_000_005_500,
    });
    events2.handleMessagesUpsert({ type: 'notify', messages: [vote2] });
    await flush();
    expect(onPollVote2).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: '6281111111111@c.us', voterId: '6281111111111@c.us', selectedOptions: ['A'] }),
    );
  });

  it('skips with debug log when poll is missing, not a poll, or lacks messageSecret', async () => {
    const cases: Array<WAMessage | null> = [
      null,
      makePoll(['A'], {
        message: { conversation: 'not a poll', messageContextInfo: { messageSecret: secret.toString('base64') } },
      }),
      makePoll(['A'], { withSecret: null }),
    ];

    for (const stored of cases) {
      const { events, onPollVote, onMessage, onMessageCreate, debugSpy } = setup({}, stored);
      const vote = makeVoteEnvelope({ pollCreatorJid: peerPhone, voterJid: voterPhone }, ['A']);
      events.handleMessagesUpsert({ type: 'notify', messages: [vote] });
      await flush();

      expect(onPollVote).not.toHaveBeenCalled();
      expect(onMessage).not.toHaveBeenCalled();
      expect(onMessageCreate).not.toHaveBeenCalled();
      expect(debugSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ action: 'baileys_poll_vote_unreadable' }),
      );
    }
  });

  it('skips with debug log when the secret does not authenticate the vote', async () => {
    const wrongSecret = Buffer.alloc(32, 0x99);
    const { events, onPollVote, onMessage, onMessageCreate, debugSpy } = setup();
    const vote = makeVoteEnvelope({ pollCreatorJid: peerPhone, voterJid: voterPhone }, ['Pizza'], {
      withSecret: wrongSecret,
    });

    events.handleMessagesUpsert({ type: 'notify', messages: [vote] });
    await flush();

    expect(onPollVote).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
    expect(onMessageCreate).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ action: 'baileys_poll_vote_unauthentic' }),
    );
  });

  it('skips the entire vote when any decrypted option hash is unknown', async () => {
    for (const chosen of [['Unknown'], ['Pizza', 'Unknown']]) {
      const { events, onPollVote, onMessage, onMessageCreate, debugSpy } = setup();
      const vote = makeVoteEnvelope({ pollCreatorJid: peerPhone, voterJid: voterPhone }, chosen);

      events.handleMessagesUpsert({ type: 'notify', messages: [vote] });
      await flush();

      expect(onPollVote).not.toHaveBeenCalled();
      expect(onMessage).not.toHaveBeenCalled();
      expect(onMessageCreate).not.toHaveBeenCalled();
      expect(debugSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ action: 'baileys_poll_vote_unknown_option' }),
      );
    }
  });

  it('ignores a cross-chat vote even when the secret authenticates it', async () => {
    const { events, onPollVote, onMessage, onMessageCreate, warnSpy } = setup();
    const vote = makeVoteEnvelope({ pollCreatorJid: peerPhone, voterJid: voterPhone }, ['Sushi'], {
      key: { remoteJid: otherGroup, participant: voterPhone },
    });

    events.handleMessagesUpsert({ type: 'notify', messages: [vote] });
    await flush();

    expect(onPollVote).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
    expect(onMessageCreate).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ action: 'baileys_poll_vote_cross_chat' }),
    );
  });

  it('reports fromMe votes under normalizedSelfJid in 1:1 and participant without device in groups', async () => {
    const directStored = makePoll(['Yes', 'No'], {
      key: { remoteJid: peerPhone, fromMe: false, participant: undefined },
    });
    const { events: directEvents, onPollVote: directCb } = setup({}, directStored);
    const directVote = makeVoteEnvelope({ pollCreatorJid: peerPhone, voterJid: selfPhone }, ['Yes'], {
      key: { remoteJid: peerPhone, participant: undefined, fromMe: true },
      senderTimestampMs: 1_786_000_006_000,
    });
    directEvents.handleMessagesUpsert({ type: 'notify', messages: [directVote] });
    await flush();

    expect(directCb).toHaveBeenCalledWith({
      pollMessageId: 'POLL1',
      chatId: '6281111111111@c.us',
      voterId: '6280000000000@c.us',
      selectedOptions: ['Yes'],
      pollName: 'Lunch?',
      timestamp: 1_786_000_006,
      timestampMs: 1_786_000_006_000,
    });

    const { events: groupEvents, onPollVote: groupCb } = setup();
    const groupVote = makeVoteEnvelope({ pollCreatorJid: peerPhone, voterJid: selfPhone }, ['Tacos'], {
      key: { remoteJid: group, participant: '6280000000000:2@s.whatsapp.net', fromMe: true },
      senderTimestampMs: 1_786_000_007_000,
    });
    groupEvents.handleMessagesUpsert({ type: 'notify', messages: [groupVote] });
    await flush();

    expect(groupCb).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: group,
        voterId: '6280000000000@c.us',
        selectedOptions: ['Tacos'],
      }),
    );
  });

  it('does not throw when onPollVote is not registered and drops vote traffic from content delivery', async () => {
    const { events, onMessage, onMessageCreate } = setup({ getOnPollVote: () => undefined });
    const vote = makeVoteEnvelope({ pollCreatorJid: peerPhone, voterJid: voterPhone }, ['Pizza']);

    await expect(
      (async () => {
        events.handleMessagesUpsert({ type: 'notify', messages: [vote] });
        await flush();
      })(),
    ).resolves.toBeUndefined();

    expect(onMessage).not.toHaveBeenCalled();
    expect(onMessageCreate).not.toHaveBeenCalled();
  });

  it('announces a vote only after its in-flight poll is handed on', async () => {
    let releasePollRead!: (value: null) => void;
    const pollRead = new Promise<null>(resolve => {
      releasePollRead = resolve;
    });
    let reads = 0;
    const getStoredMessage = jest.fn(() => (++reads === 1 ? pollRead : Promise.resolve(null)));
    const { events, onMessage, onPollVote } = setup({ getStoredMessage });
    const poll = makePoll(['Pizza', 'Sushi'], { key: { remoteJid: group, participant: peerPhone, fromMe: false } });
    const vote = makeVoteEnvelope({ pollCreatorJid: peerPhone, voterJid: voterPhone }, ['Sushi'], {
      key: { participant: voterPhone },
      senderTimestampMs: 1_786_000_000_500,
    });

    events.handleMessagesUpsert({ type: 'notify', messages: [poll, vote] });
    await flush();

    expect(onMessage).not.toHaveBeenCalled();
    expect(onPollVote).not.toHaveBeenCalled();

    releasePollRead(null);
    await flush();

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onPollVote).toHaveBeenCalledTimes(1);
    expect(onPollVote).toHaveBeenCalledWith(expect.objectContaining({ selectedOptions: ['Sushi'] }));
    expect(onMessage.mock.invocationCallOrder[0]).toBeLessThan(onPollVote.mock.invocationCallOrder[0]);
  });

  it('emits two votes for the same poll in arrival order even when the first store read is slower', async () => {
    let releaseFirstRead!: (value: WAMessage) => void;
    const firstRead = new Promise<WAMessage>(resolve => {
      releaseFirstRead = resolve;
    });
    const stored = makePoll(['Pizza', 'Sushi', 'Tacos']);
    let reads = 0;
    const getStoredMessage = jest.fn(() => (++reads === 1 ? firstRead : Promise.resolve(stored)));
    const { events, onPollVote } = setup({ getStoredMessage });
    const vote1 = makeVoteEnvelope({ pollCreatorJid: peerPhone, voterJid: voterPhone }, ['Pizza'], {
      key: { id: 'VOTE_A', participant: voterPhone },
      senderTimestampMs: 1_786_000_001_000,
    });
    const vote2 = makeVoteEnvelope({ pollCreatorJid: peerPhone, voterJid: voterPhone }, ['Tacos'], {
      key: { id: 'VOTE_B', participant: voterPhone },
      senderTimestampMs: 1_786_000_002_000,
    });

    events.handleMessagesUpsert({ type: 'notify', messages: [vote1, vote2] });
    await flush();

    expect(onPollVote).not.toHaveBeenCalled();

    releaseFirstRead(stored);
    await flush();

    expect(onPollVote).toHaveBeenCalledTimes(2);
    expect(onPollVote.mock.calls[0][0]).toEqual(expect.objectContaining({ selectedOptions: ['Pizza'] }));
    expect(onPollVote.mock.calls[1][0]).toEqual(expect.objectContaining({ selectedOptions: ['Tacos'] }));
  });

  it('drops a vote whose poll read spans a store wipe', async () => {
    let releaseRead!: (value: WAMessage) => void;
    const read = new Promise<WAMessage>(resolve => {
      releaseRead = resolve;
    });
    const { events, onPollVote } = setup({ getStoredMessage: jest.fn(() => read) });
    const vote = makeVoteEnvelope({ pollCreatorJid: peerPhone, voterJid: voterPhone }, ['Pizza'], {
      key: { id: 'VOTE_WIPE', participant: voterPhone },
      senderTimestampMs: 1_786_000_003_000,
    });

    events.handleMessagesUpsert({ type: 'notify', messages: [vote] });
    await flush();
    events.fenceStoredWrites();
    releaseRead(makePoll(['Pizza', 'Sushi', 'Tacos']));
    await flush();

    expect(onPollVote).not.toHaveBeenCalled();
  });

  it('drops the admission ticket before awaiting the poll store read', async () => {
    let releaseRead!: (value: WAMessage) => void;
    const pendingRead = new Promise<WAMessage>(resolve => {
      releaseRead = resolve;
    });
    const stored = makePoll(['Pizza', 'Sushi']);
    const ticket: InboundTicket = {
      reserve: jest.fn(() => true),
      holdUntil: jest.fn(),
      drop: jest.fn(),
      revoked: false,
    };
    const getStoredMessage = jest.fn(() => pendingRead);
    const { events, onPollVote } = setup({ getStoredMessage, getAdmitInbound: () => () => ticket });
    const vote = makeVoteEnvelope({ pollCreatorJid: peerPhone, voterJid: voterPhone }, ['Pizza'], {
      key: { participant: voterPhone },
      senderTimestampMs: 1_786_000_003_000,
    });

    events.handleMessagesUpsert({ type: 'notify', messages: [vote] });
    await flush();

    expect(getStoredMessage).toHaveBeenCalledTimes(1);
    expect(ticket.drop).toHaveBeenCalledTimes(1);
    expect(onPollVote).not.toHaveBeenCalled();

    releaseRead(stored);
    await flush();

    expect(onPollVote).toHaveBeenCalledWith(expect.objectContaining({ selectedOptions: ['Pizza'] }));
  });

  it('logs unauthenticated cross-chat votes at debug without warning and warns only when authenticated', async () => {
    const stored = makePoll(['Pizza', 'Sushi']);
    const { events, onPollVote, debugSpy, warnSpy } = setup({}, stored);
    const forgedCrossChat = makeVoteEnvelope({ pollCreatorJid: peerPhone, voterJid: voterPhone }, ['Pizza'], {
      key: { id: 'VOTE_FORGED', remoteJid: otherGroup, participant: voterPhone, fromMe: false },
      withSecret: Buffer.alloc(32, 0x99),
      senderTimestampMs: 1_786_000_004_000,
    });

    events.handleMessagesUpsert({ type: 'notify', messages: [forgedCrossChat] });
    await flush();

    expect(onPollVote).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledWith(
      'A poll vote did not authenticate against its poll',
      expect.objectContaining({ action: 'baileys_poll_vote_unauthentic', targetId: 'POLL1' }),
    );

    const authenticCrossChat = makeVoteEnvelope({ pollCreatorJid: peerPhone, voterJid: voterPhone }, ['Pizza'], {
      key: { id: 'VOTE_AUTH_XCHAT', remoteJid: otherGroup, participant: voterPhone, fromMe: false },
      senderTimestampMs: 1_786_000_004_500,
    });

    events.handleMessagesUpsert({ type: 'notify', messages: [authenticCrossChat] });
    await flush();

    expect(onPollVote).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      'Dropping a poll vote sent in a chat other than its poll',
      expect.objectContaining({ action: 'baileys_poll_vote_cross_chat', targetId: 'POLL1' }),
    );
  });

  it('skips votes with malformed iv, payload, or secret sizes and accepts a 16-byte cleared vote', async () => {
    const badVotes = [
      { encPayload: Buffer.alloc(0), encIv: Buffer.alloc(12, 7) },
      { encPayload: Buffer.alloc(15, 1), encIv: Buffer.alloc(12, 7) },
      { encPayload: Buffer.alloc(256 * 1024 + 1), encIv: Buffer.alloc(12, 7) },
      { encPayload: Buffer.alloc(32, 1), encIv: Buffer.alloc(8) },
    ];

    for (const bad of badVotes) {
      const getStoredMessage = jest.fn();
      const { events, onPollVote, debugSpy } = setup({ getStoredMessage });
      const envelope = {
        key: { id: 'VOTE_BAD_SIZE', remoteJid: group, participant: voterPhone, fromMe: false },
        messageTimestamp: 1_786_000_005,
        message: {
          pollUpdateMessage: {
            pollCreationMessageKey: { id: 'POLL1', remoteJid: group, fromMe: false },
            vote: bad,
          },
        },
      } as unknown as WAMessage;

      events.handleMessagesUpsert({ type: 'notify', messages: [envelope] });
      await flush();

      expect(getStoredMessage).not.toHaveBeenCalled();
      expect(onPollVote).not.toHaveBeenCalled();
      expect(debugSpy).toHaveBeenCalledWith(
        'Cannot read poll vote: missing creation key or ciphertext',
        expect.objectContaining({ targetId: 'POLL1' }),
      );
    }

    const { events: clearEvents, onPollVote: clearCb } = setup();
    const clearVote = makeVoteEnvelope({ pollCreatorJid: peerPhone, voterJid: voterPhone }, [], {
      key: { id: 'VOTE_CLEAR_16B', participant: voterPhone },
      senderTimestampMs: 1_786_000_005_500,
    });
    const clearEnc = (clearVote.message as { pollUpdateMessage: { vote: { encPayload: Buffer } } }).pollUpdateMessage
      .vote.encPayload;
    expect(clearEnc).toHaveLength(16);

    clearEvents.handleMessagesUpsert({ type: 'notify', messages: [clearVote] });
    await flush();

    expect(clearCb).toHaveBeenCalledWith(expect.objectContaining({ pollMessageId: 'POLL1', selectedOptions: [] }));

    const badSecretPoll = makePoll(['Pizza', 'Sushi'], { withSecret: Buffer.alloc(16, 0x33) });
    const { events: badSecretEvents, onPollVote: badSecretCb, debugSpy: badSecretDebug } = setup({}, badSecretPoll);
    const voteForBadSecret = makeVoteEnvelope({ pollCreatorJid: peerPhone, voterJid: voterPhone }, ['Pizza'], {
      key: { id: 'VOTE_BAD_SECRET', participant: voterPhone },
      senderTimestampMs: 1_786_000_005_800,
    });

    badSecretEvents.handleMessagesUpsert({ type: 'notify', messages: [voteForBadSecret] });
    await flush();

    expect(badSecretCb).not.toHaveBeenCalled();
    expect(badSecretDebug).toHaveBeenCalledWith(
      'Cannot read poll vote: target poll is missing, not a poll, or has no secret',
      expect.objectContaining({ targetId: 'POLL1' }),
    );
  });

  it('deduplicates repeated option hashes and bounds pollName and selectedOptions', async () => {
    const longName = 'P'.repeat(1100);
    const longOpt = 'O'.repeat(1100);
    const manyOptions = [longOpt, ...Array.from({ length: 34 }, (_, i) => `Opt-${i}`)];
    const stored = makePoll(manyOptions, { name: longName });
    const { events, onPollVote } = setup({}, stored);

    const dupVote = makeVoteEnvelope({ pollCreatorJid: peerPhone, voterJid: voterPhone }, [longOpt, longOpt, 'Opt-1'], {
      key: { id: 'VOTE_DUP', participant: voterPhone },
      senderTimestampMs: 1_786_000_008_000,
    });
    events.handleMessagesUpsert({ type: 'notify', messages: [dupVote] });
    await flush();

    expect(onPollVote).toHaveBeenLastCalledWith(
      expect.objectContaining({
        pollName: 'P'.repeat(1024),
        selectedOptions: ['O'.repeat(1024), 'Opt-1'],
      }),
    );

    const manyVote = makeVoteEnvelope({ pollCreatorJid: peerPhone, voterJid: voterPhone }, manyOptions, {
      key: { id: 'VOTE_MANY', participant: voterPhone },
      senderTimestampMs: 1_786_000_008_500,
    });
    events.handleMessagesUpsert({ type: 'notify', messages: [manyVote] });
    await flush();

    const secondEvent = onPollVote.mock.calls[1][0];
    expect(secondEvent.selectedOptions).toHaveLength(32);
    expect(secondEvent.selectedOptions[0]).toBe('O'.repeat(1024));
    expect(secondEvent.selectedOptions[31]).toBe('Opt-30');
    expect(secondEvent.pollName).toBe('P'.repeat(1024));
  });

  it('accepts a 1:1 vote on the account own broadcast-list poll', async () => {
    const stored = makePoll(['Yes', 'No'], {
      key: { remoteJid: '1786000000@broadcast', fromMe: true, participant: undefined },
    });
    const { events, onPollVote } = setup({}, stored);
    const vote = makeVoteEnvelope({ pollCreatorJid: selfPhone, voterJid: voterPhone }, ['Yes'], {
      key: { remoteJid: voterPhone, participant: undefined, fromMe: false },
      senderTimestampMs: 1_786_000_009_000,
    });

    events.handleMessagesUpsert({ type: 'notify', messages: [vote] });
    await flush();

    expect(onPollVote).toHaveBeenCalledWith(
      expect.objectContaining({
        pollMessageId: 'POLL1',
        chatId: '6282222222222@c.us',
        voterId: '6282222222222@c.us',
        selectedOptions: ['Yes'],
      }),
    );
  });

  describe('a vote on the account own broadcast-list poll', () => {
    const listPoll = () =>
      makePoll(['Yes', 'No'], { key: { remoteJid: '1786000000@broadcast', fromMe: true, participant: undefined } });
    const voteFrom = (key: Record<string, unknown>, voterJid = voterPhone) =>
      makeVoteEnvelope({ pollCreatorJid: selfPhone, voterJid }, ['Yes'], {
        key: { participant: undefined, fromMe: false, ...key },
        senderTimestampMs: 1_786_000_009_000,
      });

    it('accepts a vote the recipient casts from its 1:1 chat addressed by lid', async () => {
      const { events, onPollVote } = setup({}, listPoll());

      events.handleMessagesUpsert({ type: 'notify', messages: [voteFrom({ remoteJid: voterLid }, voterLid)] });
      await flush();

      expect(onPollVote).toHaveBeenCalledWith(
        expect.objectContaining({
          pollMessageId: 'POLL1',
          chatId: voterLid,
          voterId: voterLid,
          selectedOptions: ['Yes'],
        }),
      );
    });

    it.each([
      ['a group chat', group],
      ['the broadcast list itself', '1786000000@broadcast'],
      ['the status chat', 'status@broadcast'],
    ])('drops a vote that arrives in %s', async (_where, remoteJid) => {
      const { events, onPollVote, warnSpy } = setup({}, listPoll());

      events.handleMessagesUpsert({
        type: 'notify',
        messages: [voteFrom({ remoteJid, participant: voterPhone })],
      });
      await flush();

      expect(onPollVote).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        'Dropping a poll vote sent in a chat other than its poll',
        expect.objectContaining({ action: 'baileys_poll_vote_cross_chat', targetId: 'POLL1' }),
      );
    });

    it('judges a vote on a list poll the account received as before, by the chat the poll is filed under', async () => {
      const received = makePoll(['Yes', 'No'], {
        key: { remoteJid: '1786000000@broadcast', fromMe: false, participant: peerPhone },
      });
      const { events, onPollVote } = setup({}, received);
      const vote = makeVoteEnvelope({ pollCreatorJid: peerPhone, voterJid: voterPhone }, ['Yes'], {
        key: { remoteJid: '1786000000@broadcast', participant: voterPhone },
        senderTimestampMs: 1_786_000_009_000,
      });

      events.handleMessagesUpsert({ type: 'notify', messages: [vote] });
      await flush();

      expect(onPollVote).toHaveBeenCalledWith(
        expect.objectContaining({ pollMessageId: 'POLL1', selectedOptions: ['Yes'] }),
      );
    });

    it('still reports a vote on a poll the account sent to a group, from that group', async () => {
      const { events, onPollVote } = setup(
        {},
        makePoll(['Yes', 'No'], { key: { fromMe: true, participant: undefined } }),
      );

      events.handleMessagesUpsert({
        type: 'notify',
        messages: [voteFrom({ remoteJid: group, participant: voterPhone })],
      });
      await flush();

      expect(onPollVote).toHaveBeenCalledWith(expect.objectContaining({ chatId: group, selectedOptions: ['Yes'] }));
    });
  });

  it('reads messageSecret nested inside pollCreationMessageV4', async () => {
    const stored = makePoll(['One', 'Two'], {
      message: {
        pollCreationMessageV4: {
          message: {
            pollCreationMessageV3: {
              name: 'V4?',
              options: [{ optionName: 'One' }, { optionName: 'Two' }],
              selectableOptionsCount: 0,
            },
            messageContextInfo: { messageSecret: secret.toString('base64') },
          },
        },
      },
    });
    const { events, onPollVote } = setup({}, stored);
    const vote = makeVoteEnvelope({ pollCreatorJid: peerPhone, voterJid: voterPhone }, ['Two'], {
      key: { participant: voterPhone },
      senderTimestampMs: 1_786_000_010_000,
    });

    events.handleMessagesUpsert({ type: 'notify', messages: [vote] });
    await flush();

    expect(onPollVote).toHaveBeenCalledWith(
      expect.objectContaining({
        pollName: 'V4?',
        selectedOptions: ['Two'],
      }),
    );
  });

  it('falls back to messageTimestamp when senderTimestampMs is a plain { low, high } object', async () => {
    const { events, onPollVote } = setup();
    const vote = makeVoteEnvelope({ pollCreatorJid: peerPhone, voterJid: voterPhone }, ['Pizza'], {
      key: { participant: voterPhone },
      senderTimestampMs: { low: 1_786_000_000, high: 0 },
      messageTimestamp: 1_786_000_050,
    });

    events.handleMessagesUpsert({ type: 'notify', messages: [vote] });
    await flush();

    expect(onPollVote).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedOptions: ['Pizza'],
        timestamp: 1_786_000_050,
        timestampMs: 1_786_000_050_000,
      }),
    );
  });

  it('skips a poll vote when the derived voter id is empty', async () => {
    const stored = makePoll(['A', 'B'], {
      key: { remoteJid: voterPhone, fromMe: false, participant: undefined },
    });
    const { events, onPollVote, debugSpy } = setup({ normalizedSelfJid: () => '' }, stored);
    const vote = makeVoteEnvelope({ pollCreatorJid: voterPhone, voterJid: selfPhone }, ['A'], {
      key: { remoteJid: voterPhone, fromMe: true, participant: undefined },
      senderTimestampMs: 1_786_000_011_000,
    });

    events.handleMessagesUpsert({ type: 'notify', messages: [vote] });
    await flush();

    expect(onPollVote).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledWith(
      'Skipping poll vote with empty voter id',
      expect.objectContaining({ action: 'baileys_poll_vote_empty_voter', targetId: 'POLL1' }),
    );
  });

  it('bridges lid and phone identities via resolvePhone and lidOf using the real toNeutralJid, and skips unmapped pairs', async () => {
    const storedLidPoll = makePoll(['A', 'B'], { key: { participant: peerLid, fromMe: false } });
    const lidVote = makeVoteEnvelope({ pollCreatorJid: peerPhone, voterJid: voterPhone }, ['A'], {
      key: { participant: voterLid, fromMe: false },
      senderTimestampMs: 1_786_000_012_000,
    });

    const { events: phoneResolvedEvents, onPollVote: phoneResolvedCb } = setup(
      {
        resolvePhone: jid => (jid === peerLid ? '6281111111111' : jid === voterLid ? '6282222222222' : null),
      },
      storedLidPoll,
    );
    phoneResolvedEvents.handleMessagesUpsert({ type: 'notify', messages: [lidVote] });
    await flush();

    expect(phoneResolvedCb).toHaveBeenCalledWith(
      expect.objectContaining({ voterId: voterLid, selectedOptions: ['A'] }),
    );

    const storedPhonePoll = makePoll(['A', 'B'], { key: { participant: peerPhone, fromMe: false } });
    const phoneVote = makeVoteEnvelope({ pollCreatorJid: peerLid, voterJid: voterLid }, ['B'], {
      key: { participant: voterPhone, fromMe: false },
      senderTimestampMs: 1_786_000_012_500,
    });

    const { events: lidResolvedEvents, onPollVote: lidResolvedCb } = setup(
      {
        lidOf: jid => (jid === peerPhone ? peerLid : jid === voterPhone ? voterLid : null),
      },
      storedPhonePoll,
    );
    lidResolvedEvents.handleMessagesUpsert({ type: 'notify', messages: [phoneVote] });
    await flush();

    expect(lidResolvedCb).toHaveBeenCalledWith(
      expect.objectContaining({ voterId: '6282222222222@c.us', selectedOptions: ['B'] }),
    );

    const { events: unmappedEvents, onPollVote: unmappedCb } = setup({}, storedLidPoll);
    unmappedEvents.handleMessagesUpsert({ type: 'notify', messages: [lidVote] });
    await flush();

    expect(unmappedCb).not.toHaveBeenCalled();
  });
});

describe('BaileysEvents preparation room and unlink fencing', () => {
  const chat = '6281111111111@s.whatsapp.net';
  const flush = async (turns = 10): Promise<void> => {
    for (let i = 0; i < turns; i++) await new Promise(resolve => setImmediate(resolve));
  };

  it('releases the inbound limiter slot while waiting for preparation room', async () => {
    const releases: Array<() => void> = [];
    const onMessage = jest.fn();
    const limiter = new ConcurrencyLimiter(1);
    const events = new BaileysEvents(
      makeHost({
        inboundLimiter: limiter,
        getStoredMessage: (id: string) => {
          if (id === 'PLAIN') return Promise.resolve(null);
          return new Promise<WAMessage | null>(resolve => {
            releases.push(() => resolve(null));
          });
        },
        getOnMessage: () => onMessage,
        getOnMessageReaction: () => jest.fn(),
      }),
    );

    const reactions: WAMessage[] = Array.from({ length: 65 }, (_, i) => ({
      key: { id: `R-${i}`, remoteJid: chat, fromMe: false },
      messageTimestamp: 1_700_000_000 + i,
      message: { reactionMessage: { key: { id: `T-${i}`, remoteJid: chat, fromMe: false }, text: 'ok' } },
    }));
    const plain: WAMessage = {
      key: { id: 'PLAIN', remoteJid: chat, fromMe: false },
      messageTimestamp: 1_700_000_999,
      message: { conversation: 'unblocked' },
    };

    events.handleMessagesUpsert({ type: 'notify', messages: [...reactions, plain] });
    await flush(30);

    // The 65th reaction waits for preparation room without holding the lone limiter slot,
    // so the plain message queued behind it runs and is emitted immediately.
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 'PLAIN', body: 'unblocked' }));

    for (const release of releases) release();
    await flush(30);
  });

  it('aborts a change waiting for preparation room when fenceStoredWrites advances the generation', async () => {
    const releases: Array<() => void> = [];
    const onMessageReaction = jest.fn();
    const events = new BaileysEvents(
      makeHost({
        inboundLimiter: new ConcurrencyLimiter(2),
        getStoredMessage: () =>
          new Promise<WAMessage | null>(resolve => {
            releases.push(() => resolve(null));
          }),
        getOnMessageReaction: () => onMessageReaction,
      }),
    );

    const reactions: WAMessage[] = Array.from({ length: 65 }, (_, i) => ({
      key: { id: `RF-${i}`, remoteJid: chat, fromMe: false },
      messageTimestamp: 1_700_000_000 + i,
      message: { reactionMessage: { key: { id: `TF-${i}`, remoteJid: chat, fromMe: false }, text: 'ok' } },
    }));

    events.handleMessagesUpsert({ type: 'notify', messages: reactions });
    await flush(30);

    events.fenceStoredWrites();
    for (const release of releases) release();
    await flush(30);

    expect(onMessageReaction).not.toHaveBeenCalled();
  });

  it('does not underflow inboundLimiter or leak changesParked when fenceStoredWrites retires a change awaiting readTarget', async () => {
    const otherChat = '6282222222222@s.whatsapp.net';
    let releaseOriginal!: (v: WAMessage | null) => void;
    let releaseForeignRead!: (v: WAMessage | null) => void;
    let originalReadOnce = false;
    const limiter = new ConcurrencyLimiter(2);
    const onMessageReaction = jest.fn();

    const events = new BaileysEvents(
      makeHost({
        inboundLimiter: limiter,
        getStoredMessage: (id: string) => {
          if (id === 'ORIG-1' && !originalReadOnce) {
            originalReadOnce = true;
            return new Promise<WAMessage | null>(r => (releaseOriginal = r));
          }
          if (id === 'ORIG-1') {
            return new Promise<WAMessage | null>(r => (releaseForeignRead = r));
          }
          return Promise.resolve(null);
        },
        getOnMessage: () => jest.fn(),
        getOnMessageReaction: () => onMessageReaction,
      }),
    );

    // Start an in-flight original in `chat` (stays pending in `inboundInFlight`).
    events.handleMessagesUpsert({
      type: 'notify',
      messages: [
        {
          key: { id: 'ORIG-1', remoteJid: chat, fromMe: false },
          messageTimestamp: 1_700_000_000,
          message: { conversation: 'hello' },
        },
      ],
    });
    await flush();

    // Send a foreign reaction from `otherChat` targeting ORIG-1; its targetsForeignMessage awaits readTarget.
    events.handleMessagesUpsert({
      type: 'notify',
      messages: [
        {
          key: { id: 'REACT-FOREIGN', remoteJid: otherChat, fromMe: false },
          messageTimestamp: 1_700_000_001,
          message: {
            reactionMessage: { key: { id: 'ORIG-1', remoteJid: otherChat, fromMe: false }, text: 'x' },
          },
        },
      ],
    });
    await flush();

    // Fence while the reaction's readTarget is still pending: retires prepareMessageChange so
    // inboundLimiter.run() finishes while the detached targetsForeignMessage still holds releaseForeignRead.
    events.fenceStoredWrites();
    await flush();

    // Now resolve the detached readTarget: it sees the foreign in-flight original, and MUST NOT
    // call parkUntil (which would leak changesParked) or double-release inboundLimiter.
    releaseForeignRead(null);
    await flush(20);

    const internals = events as unknown as { changesParked: number };
    expect(internals.changesParked).toBe(0);
    expect(limiter.activeCount).toBe(1); // only ORIG-1 still active

    releaseOriginal(null);
    await flush(20);

    expect(limiter.activeCount).toBe(0);
    expect(internals.changesParked).toBe(0);
    expect(onMessageReaction).not.toHaveBeenCalled();
  });

  describe('timers and callbacks across fenceStoredWrites', () => {
    const savedTimeout = process.env.MEDIA_DOWNLOAD_TIMEOUT_MS;

    beforeEach(() => {
      process.env.MEDIA_DOWNLOAD_TIMEOUT_MS = '1000';
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    });

    afterEach(() => {
      jest.useRealTimers();
      if (savedTimeout === undefined) delete process.env.MEDIA_DOWNLOAD_TIMEOUT_MS;
      else process.env.MEDIA_DOWNLOAD_TIMEOUT_MS = savedTimeout;
    });

    it('clears changesAwaitingEmit timers and drops stale waiting changes on fenceStoredWrites', async () => {
      let releaseOriginal!: (stored: WAMessage | null) => void;
      let checked = false;
      const onMessageReaction = jest.fn();
      const events = new BaileysEvents(
        makeHost({
          getStoredMessage: (id: string) => {
            if (id !== 'M-FENCE' || checked) return Promise.resolve(null);
            checked = true;
            return new Promise<WAMessage | null>(resolve => {
              releaseOriginal = resolve;
            });
          },
          getOnMessageReaction: () => onMessageReaction,
        }),
      );

      events.handleMessagesUpsert({
        type: 'notify',
        messages: [
          {
            key: { id: 'M-FENCE', remoteJid: chat, fromMe: false },
            messageTimestamp: 1_700_000_000,
            message: { conversation: 'hi' },
          },
        ],
      });
      await flush();

      events.handleMessagesUpsert({
        type: 'notify',
        messages: [
          {
            key: { id: 'R-FENCE', remoteJid: chat, fromMe: false },
            messageTimestamp: 1_700_000_001,
            message: { reactionMessage: { key: { id: 'M-FENCE', remoteJid: chat, fromMe: false }, text: 'ok' } },
          },
        ],
      });
      await flush();
      expect(jest.getTimerCount()).toBe(1);

      events.fenceStoredWrites();
      expect(jest.getTimerCount()).toBe(0);

      jest.advanceTimersByTime(10_000);
      releaseOriginal(null);
      await flush();

      expect(onMessageReaction).not.toHaveBeenCalled();
      expect((events as unknown as { changesAwaiting: number }).changesAwaiting).toBe(0);
    });

    it('clears outcomesPending timers, gates dropConflictingCopy, and preserves a newer hold on fenceStoredWrites', async () => {
      let resolveFirst!: (val: { conflict?: boolean }) => void;
      let resolveSecond!: (val: { conflict?: boolean }) => void;
      const firstReceipt = { settled: new Promise<{ conflict?: boolean }>(r => (resolveFirst = r)) };
      const secondReceipt = { settled: new Promise<{ conflict?: boolean }>(r => (resolveSecond = r)) };
      const removeStoredMessage = jest.fn(() => Promise.resolve());
      const onMessage = jest.fn().mockReturnValueOnce(firstReceipt).mockReturnValueOnce(secondReceipt);

      const events = new BaileysEvents(
        makeHost({
          getOnMessage: () => onMessage,
          removeStoredMessage,
        }),
      );

      const msg: WAMessage = {
        key: { id: 'M-OUTCOME', remoteJid: chat, fromMe: false },
        messageTimestamp: 1_700_000_000,
        message: { conversation: 'first' },
      };

      events.handleMessagesUpsert({ type: 'notify', messages: [msg] });
      await flush();
      expect(jest.getTimerCount()).toBe(1);

      const internals = events as unknown as {
        outcomesPending: Map<string, { ended: Promise<void> }>;
      };
      const firstHold = internals.outcomesPending.get('M-OUTCOME');
      expect(firstHold).toBeDefined();
      let waiterUnblocked = false;
      void firstHold!.ended.then(() => {
        waiterUnblocked = true;
      });

      events.fenceStoredWrites();
      await flush();
      expect(jest.getTimerCount()).toBe(0);
      expect(waiterUnblocked).toBe(true);
      expect(internals.outcomesPending.size).toBe(0);

      // New generation receives a message with the same id and installs a new hold.
      events.handleMessagesUpsert({ type: 'notify', messages: [msg] });
      await flush();
      expect(jest.getTimerCount()).toBe(1);
      const secondHold = internals.outcomesPending.get('M-OUTCOME');
      expect(secondHold).toBeDefined();

      // The fenced delivery settles late as a conflict: must neither drop the new copy nor remove the new hold.
      resolveFirst({ conflict: true });
      await flush();
      expect(removeStoredMessage).not.toHaveBeenCalled();
      expect(internals.outcomesPending.get('M-OUTCOME')).toBe(secondHold);
      expect(jest.getTimerCount()).toBe(1);

      // Settling the new hold cleans up its timer completely.
      resolveSecond({ conflict: false });
      await flush();
      expect(internals.outcomesPending.size).toBe(0);
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  describe('inbound media download AbortSignal propagation', () => {
    const savedEnv = {
      MEDIA_DOWNLOAD_ENABLED: process.env.MEDIA_DOWNLOAD_ENABLED,
      MEDIA_DOWNLOAD_MAX_BYTES: process.env.MEDIA_DOWNLOAD_MAX_BYTES,
      MEDIA_DOWNLOAD_TIMEOUT_MS: process.env.MEDIA_DOWNLOAD_TIMEOUT_MS,
    };

    const imageMsg = (id: string, fileLength = 100): WAMessage => ({
      key: { id, remoteJid: '15550001111@s.whatsapp.net', fromMe: false },
      messageTimestamp: 1_700_000_000,
      message: { imageMessage: { mimetype: 'image/png', fileLength } },
    });

    beforeEach(() => {
      downloadMediaMessage.mockReset();
      process.env.MEDIA_DOWNLOAD_ENABLED = 'true';
    });

    afterEach(() => {
      jest.useRealTimers();
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    it('passes options.signal to downloadMediaMessage both with and without a proxy dispatcher', async () => {
      downloadMediaMessage.mockImplementation(() => Promise.resolve(streamOf(Buffer.from('PNG'))));

      const directEvents = new BaileysEvents(makeHost({ getFetchDispatcher: () => undefined }));
      await directEvents.mapMessage(imageMsg('SIG-DIRECT', 3), 'imageMessage');
      const calls = downloadMediaMessage.mock.calls as unknown[][];
      const directOpts = calls[0]?.[2] as { options?: Record<string, unknown> } | undefined;
      expect(directOpts?.options?.signal).toBeInstanceOf(AbortSignal);
      expect(directOpts?.options).not.toHaveProperty('dispatcher');

      const dispatcher = { dispatch: jest.fn() };
      const proxiedEvents = new BaileysEvents(makeHost({ getFetchDispatcher: () => dispatcher as never }));
      await proxiedEvents.mapMessage(imageMsg('SIG-PROXY', 3), 'imageMessage');
      const proxyOpts = calls[1]?.[2] as { options?: Record<string, unknown> } | undefined;
      expect(proxyOpts?.options?.signal).toBeInstanceOf(AbortSignal);
      expect(proxyOpts?.options?.dispatcher).toBe(dispatcher);
    });

    it('aborts options.signal on timeout even when downloadMediaMessage is still stalled pre-stream', async () => {
      jest.useFakeTimers();
      process.env.MEDIA_DOWNLOAD_TIMEOUT_MS = '50';

      let capturedSignal: AbortSignal | undefined;
      downloadMediaMessage.mockImplementation((_m, _t, opts: { options?: { signal?: AbortSignal } }) => {
        capturedSignal = opts?.options?.signal;
        return new Promise(() => undefined); // never resolves stream
      });

      const events = new BaileysEvents(makeHost());
      const pending = events.mapMessage(imageMsg('SIG-TIMEOUT', 1024), 'imageMessage');
      await Promise.resolve();
      await Promise.resolve();
      expect(capturedSignal).toBeInstanceOf(AbortSignal);
      expect(capturedSignal?.aborted).toBe(false);

      await jest.advanceTimersByTimeAsync(50);
      const result = await pending;
      expect(result.media).toMatchObject({ omitted: true, sizeBytes: 1024 });
      expect(capturedSignal?.aborted).toBe(true);
    });

    it('aborts options.signal and destroys the stream when size cap is breached mid-stream', async () => {
      process.env.MEDIA_DOWNLOAD_MAX_BYTES = '10';
      let capturedSignal: AbortSignal | undefined;
      const destroy = jest.fn();
      downloadMediaMessage.mockImplementation((_m, _t, opts: { options?: { signal?: AbortSignal } }) => {
        capturedSignal = opts?.options?.signal;
        return Promise.resolve({
          // eslint-disable-next-line @typescript-eslint/require-await
          async *[Symbol.asyncIterator]() {
            yield Buffer.alloc(6);
            yield Buffer.alloc(6);
          },
          destroy,
        });
      });

      const events = new BaileysEvents(makeHost());
      const result = await events.mapMessage(imageMsg('SIG-CAP', 5), 'imageMessage');
      expect(result.media).toMatchObject({ omitted: true, sizeBytes: 12 });
      expect(capturedSignal?.aborted).toBe(true);
      expect(destroy).toHaveBeenCalled();
    });

    it('rejects reuploadRequest immediately if aborted and races pending sock.updateMediaMessage against abort', async () => {
      jest.useFakeTimers();
      process.env.MEDIA_DOWNLOAD_TIMEOUT_MS = '50';

      const updateMediaMessage = jest.fn(() => new Promise(() => undefined));
      let capturedReupload: ((m: WAMessage) => Promise<WAMessage>) | undefined;
      downloadMediaMessage.mockImplementation(
        (_m, _t, _opts, ctx: { reuploadRequest?: (m: WAMessage) => Promise<WAMessage> }) => {
          capturedReupload = ctx?.reuploadRequest;
          return new Promise(() => undefined);
        },
      );

      const events = new BaileysEvents(
        makeHost({
          getSocket: () => ({ updateMediaMessage }) as unknown as WASocket,
        }),
      );

      // Start download and kick off a pending reuploadRequest before timeout.
      const pending = events.mapMessage(imageMsg('SIG-REUPLOAD', 1024), 'imageMessage');
      await Promise.resolve();
      await Promise.resolve();
      expect(capturedReupload).toBeDefined();

      const inFlightReupload = capturedReupload!(imageMsg('SIG-REUPLOAD', 1024));
      expect(updateMediaMessage).toHaveBeenCalledTimes(1);

      // Advance past timeout -> abort signal fires -> pending reuploadRequest rejects promptly.
      const reuploadRejection = inFlightReupload.then(
        () => 'resolved',
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      );
      await jest.advanceTimersByTimeAsync(50);
      await pending;
      expect(await reuploadRejection).toMatch(/timed out|aborted/i);

      // Calling reuploadRequest again after abort must reject immediately without invoking updateMediaMessage.
      await expect(capturedReupload!(imageMsg('SIG-REUPLOAD', 1024))).rejects.toThrow(/timed out|aborted/i);
      expect(updateMediaMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('storeGeneration fencing and editedWhileInFlight cleanup', () => {
    it('stops processing after readStoredMessage when fenceStoredWrites ran during the store lookup', async () => {
      let resolveGet: ((val: WAMessage | null) => void) | undefined;
      const getStoredMessage = jest.fn(
        () =>
          new Promise<WAMessage | null>(res => {
            resolveGet = res;
          }),
      );
      const putStoredMessage = jest.fn().mockResolvedValue(undefined);
      const onMessage = jest.fn();
      const recordMessage = jest.fn();
      const events = new BaileysEvents(
        makeHost({
          getStoredMessage,
          putStoredMessage,
          getOnMessage: () => onMessage,
          recordMessage,
        }),
      );
      const mapSpy = jest.spyOn(events, 'mapMessage');

      const pending = (
        events as unknown as {
          processInboundMessage: (msg: WAMessage, opts: { generation: number }) => Promise<void>;
        }
      ).processInboundMessage(
        {
          key: { id: 'FENCE-READ', remoteJid: '628111@s.whatsapp.net', fromMe: false },
          messageTimestamp: 1_700_000_000,
          message: { conversation: 'late' },
        },
        { generation: 0 },
      );
      for (let i = 0; i < 20 && !resolveGet; i++) {
        await new Promise(resolve => setImmediate(resolve));
      }
      expect(resolveGet).toBeDefined();
      events.fenceStoredWrites();
      resolveGet!(null);
      await pending;

      expect(mapSpy).not.toHaveBeenCalled();
      expect(putStoredMessage).not.toHaveBeenCalled();
      expect(onMessage).not.toHaveBeenCalled();
      expect(recordMessage).not.toHaveBeenCalled();
    });

    it('stops before putStoredMessage, onMessage, and recordMessage when fenced during mapMessage', async () => {
      let resolveMedia!: (val: unknown) => void;
      downloadMediaMessage.mockImplementationOnce(
        () =>
          new Promise(res => {
            resolveMedia = res;
          }),
      );
      const putStoredMessage = jest.fn().mockResolvedValue(undefined);
      const onMessage = jest.fn();
      const recordMessage = jest.fn();
      const events = new BaileysEvents(
        makeHost({
          putStoredMessage,
          getOnMessage: () => onMessage,
          recordMessage,
        }),
      );

      const pending = (
        events as unknown as {
          processInboundMessage: (msg: WAMessage, opts: { generation: number }) => Promise<void>;
        }
      ).processInboundMessage(
        {
          key: { id: 'FENCE-MAP', remoteJid: '628111@s.whatsapp.net', fromMe: false },
          messageTimestamp: 1_700_000_000,
          message: { imageMessage: { mimetype: 'image/jpeg' } },
        },
        { generation: 0 },
      );
      await new Promise(resolve => setImmediate(resolve));
      events.fenceStoredWrites();
      resolveMedia(streamOf(Buffer.from([1, 2, 3])));
      await pending;

      expect(putStoredMessage).not.toHaveBeenCalled();
      expect(onMessage).not.toHaveBeenCalled();
      expect(recordMessage).not.toHaveBeenCalled();
    });

    it('skips fallback emit in handleMessagesUpsert when fenced before inboundLimiter rejects on close', async () => {
      const limiter = new ConcurrencyLimiter(1);
      let releaseFirst!: () => void;
      const firstHold = limiter.run(
        () =>
          new Promise<void>(res => {
            releaseFirst = res;
          }),
      );
      const onMessage = jest.fn();
      const putStoredMessage = jest.fn().mockResolvedValue(undefined);
      const recordMessage = jest.fn();
      const events = new BaileysEvents(
        makeHost({
          inboundLimiter: limiter,
          putStoredMessage,
          getOnMessage: () => onMessage,
          recordMessage,
        }),
      );

      events.handleMessagesUpsert({
        type: 'notify',
        messages: [
          {
            key: { id: 'QUEUED-1', remoteJid: '628111@s.whatsapp.net', fromMe: false },
            messageTimestamp: 1_700_000_000,
            message: { conversation: 'queued during teardown' },
          },
        ],
      });

      events.fenceStoredWrites();
      limiter.close();
      await new Promise(resolve => setTimeout(resolve, 25));
      releaseFirst();
      await firstHold;
      await new Promise(resolve => setTimeout(resolve, 25));

      expect(putStoredMessage).not.toHaveBeenCalled();
      expect(onMessage).not.toHaveBeenCalled();
      expect(recordMessage).not.toHaveBeenCalled();
    });

    it('does not re-insert editedWhileInFlight via stale target fallback after inbound completes mid-await', async () => {
      let releaseInbound!: () => void;
      let releaseRead: ((msg: WAMessage | null) => void) | undefined;
      let readStarted = false;
      let editReads = 0;
      const onMessage = jest.fn();
      const events = new BaileysEvents(
        makeHost({
          loadLib: () =>
            Promise.resolve({
              ...libStub,
              BufferJSON: {
                replacer: (_k: string, v: unknown) => v,
                reviver: (_k: string, v: unknown) => v,
              },
              proto: { Message: { ProtocolMessage: { Type: { REVOKE: 0, MESSAGE_EDIT: 14 } } } },
            } as unknown as Awaited<ReturnType<BaileysEventsHost['loadLib']>>),
          getStoredMessage: jest.fn((msgId: string) => {
            if (msgId === 'EDITED-TARGET-1' && !readStarted) {
              // First read for EDITED-TARGET-1 is repeat-delivery check during inbound; allow once.
              return Promise.resolve(null);
            }
            if (msgId === 'EDITED-TARGET-1') {
              editReads++;
              if (editReads === 1) return Promise.resolve(null); // targetsForeignMessage read
              return new Promise<WAMessage | null>(res => {
                releaseRead = res;
              });
            }
            return Promise.resolve(null);
          }),
          getOnMessage: () => onMessage,
        }),
      );

      jest.spyOn(events, 'mapMessage').mockImplementationOnce(
        () =>
          new Promise(res => {
            releaseInbound = () =>
              res({
                id: 'EDITED-TARGET-1',
                from: '628111@s.whatsapp.net',
                to: '6280000000000@s.whatsapp.net',
                chatId: '628111@s.whatsapp.net',
                body: 'orig',
                type: 'text',
                timestamp: 1_700_000_000,
                fromMe: false,
                isGroup: false,
                kind: 'individual',
              });
          }),
      );

      events.handleMessagesUpsert({
        type: 'notify',
        messages: [
          {
            key: { id: 'EDITED-TARGET-1', remoteJid: '628111@s.whatsapp.net', fromMe: false },
            messageTimestamp: 1_700_000_000,
            message: { conversation: 'orig' },
          },
        ],
      });
      await new Promise(resolve => setTimeout(resolve, 10));
      readStarted = true;

      // Start an edit while inbound is in flight, pausing inside readTarget -> getStoredMessage.
      const editPromise = (
        events as unknown as {
          processInboundMessage: (msg: WAMessage, opts: { generation: number }) => Promise<void>;
        }
      ).processInboundMessage(
        {
          key: { id: 'EDIT-ENV-1', remoteJid: '628111@s.whatsapp.net', fromMe: false },
          messageTimestamp: 1_700_000_001,
          message: {
            protocolMessage: {
              type: 14,
              key: { id: 'EDITED-TARGET-1', remoteJid: '628111@s.whatsapp.net', fromMe: false },
              editedMessage: { conversation: 'edited' },
            },
          },
        },
        { generation: 0 },
      );
      for (let i = 0; i < 20 && !releaseRead; i++) {
        await new Promise(resolve => setImmediate(resolve));
      }
      expect(releaseRead).toBeDefined();

      // Inbound completes before readTarget resolves, clearing inboundInFlight and editedWhileInFlight.
      releaseInbound();
      await new Promise(resolve => setTimeout(resolve, 10));

      // Now readTarget settles. editedWhileInFlight must stay empty rather than re-inserting stale target.
      releaseRead!(null);
      await editPromise;

      const map = (events as unknown as { editedWhileInFlight: Map<string, unknown> }).editedWhileInFlight;
      expect(map.size).toBe(0);
    });
  });
});
