import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import { BaileysMessaging, blockSvgDecoding, type BaileysMessagingHost } from './baileys-messaging';
import { BaileysStatus, type BaileysStatusHost } from './baileys-status';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { markEngineSendFailure } from '../../common/errors/engine-send-failure';
import { sendFailureProvesNothingSent } from '../../modules/message/idempotency/send-idempotency.interceptor';

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

type FakeSock = { onWhatsApp: jest.Mock; sendMessage: jest.Mock; waUploadToServer: jest.Mock };
const fakeSock = (id: string): FakeSock => ({
  onWhatsApp: jest.fn((jid: string) => Promise.resolve([{ jid, exists: true }])),
  sendMessage: jest.fn().mockResolvedValue({ key: { id }, messageTimestamp: 1 }),
  waUploadToServer: jest.fn().mockResolvedValue({ mediaUrl: 'https://mmg.whatsapp.net/d', directPath: '/d' }),
});

describe('Baileys sends whose socket or readiness changes during pre-send preparation', () => {
  let server: Server;
  let base: string;
  let oldSock: FakeSock;
  let newSock: FakeSock;
  let current: FakeSock | null;
  let ready: boolean;
  let onQuoteLookup: (() => void) | undefined;
  let prepareWAMessageMedia: jest.Mock;
  let messaging: BaileysMessaging;
  let statusOps: BaileysStatus;

  const freesKey = (error: unknown): boolean => sendFailureProvesNothingSent(markEngineSendFailure(error));
  const reconnect = () => {
    current = newSock;
  };
  const dropIntoBackoff = () => {
    // During transient close backoff, status drops to INITIALIZING while this.sock stays oldSock.
    ready = false;
  };
  const failureOf = (promise: Promise<unknown>): Promise<unknown> =>
    promise.then(
      () => {
        throw new Error('expected the send to fail');
      },
      (error: unknown) => error,
    );

  beforeAll(async () => {
    await blockSvgDecoding();
    server = createServer((req, res) => {
      if (req.url === '/backoff.png') {
        dropIntoBackoff();
      } else if (req.url !== '/stable.png') {
        reconnect();
      }
      res.writeHead(200, { 'content-type': 'image/png' }).end(PNG_BYTES);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  beforeEach(() => {
    process.env.SSRF_ALLOWED_HOSTS = '127.0.0.1';
    oldSock = fakeSock('OLD');
    newSock = fakeSock('NEW');
    current = oldSock;
    ready = true;
    onQuoteLookup = undefined;
    prepareWAMessageMedia = jest.fn(async (_media: unknown, opts: { upload: () => Promise<unknown> }) => {
      await opts.upload();
      return { imageMessage: { directPath: '/d', jpegThumbnail: new Uint8Array([1]) } };
    });

    const ensureReady = () => {
      if (!ready || !current) throw new EngineNotReadyError();
    };
    const storedMsg: WAMessage = {
      key: { remoteJid: '628123456789@s.whatsapp.net', fromMe: false, id: 'Q1' },
      message: { conversation: 'hello' },
    };

    const host = {
      ensureReady,
      sessionProxyUrl: () => undefined,
      getSocket: () => {
        if (!current) throw new EngineNotReadyError();
        return current as unknown as WASocket;
      },
      getSocketOrNull: () => current as unknown as WASocket | null,
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      toNeutralJid: (j: string) => j.replace('@s.whatsapp.net', '@c.us'),
      toEngineJid: (j: string) => j.replace('@c.us', '@s.whatsapp.net'),
      normalizedSelfJid: () => '628177@s.whatsapp.net',
      getEphemeralExpiration: () => undefined,
      toUnixSeconds: () => 1,
      loadLib: () =>
        Promise.resolve({
          prepareWAMessageMedia,
          normalizeMessageContent: (m: unknown) => m,
          getContentType: () => 'conversation',
        } as never),
      getStoredMessage: jest.fn(() => {
        onQuoteLookup?.();
        return Promise.resolve(storedMsg);
      }),
      wasDeletedForEveryone: () => false,
      pendingEditOf: () => undefined,
      putStoredMessage: () => undefined,
      recordMessage: () => undefined,
      rememberOwnSend: () => undefined,
      recordLidMapping: () => undefined,
      getOnMessageCreate: () => undefined,
    } as unknown as BaileysMessagingHost & BaileysStatusHost;

    messaging = new BaileysMessaging(host);
    statusOps = new BaileysStatus(host);
  });

  afterEach(() => {
    delete process.env.SSRF_ALLOWED_HOSTS;
  });

  it('refuses with 409 and frees the key when the socket is replaced during an image media fetch', async () => {
    const error = await failureOf(
      messaging.sendImageMessage('628123456789@c.us', {
        data: `${base}/a.png`,
        mimetype: 'image/png',
      }),
    );

    expect(error).toBeInstanceOf(EngineNotReadyError);
    expect(oldSock.sendMessage).not.toHaveBeenCalled();
    expect(newSock.sendMessage).not.toHaveBeenCalled();
    expect(freesKey(error)).toBe(true);
  });

  it('refuses with 409 and frees the key when the socket is replaced during a quoted message lookup on a text send', async () => {
    onQuoteLookup = reconnect;

    const error = await failureOf(
      messaging.sendTextMessage('628123456789@c.us', 'reply body', undefined, {
        quotedMessageId: 'Q1',
      }),
    );

    expect(error).toBeInstanceOf(EngineNotReadyError);
    expect(oldSock.sendMessage).not.toHaveBeenCalled();
    expect(newSock.sendMessage).not.toHaveBeenCalled();
    expect(freesKey(error)).toBe(true);
  });

  it('does not upload a custom preview thumbnail onto the replacement socket when swapped during thumbnail fetch', async () => {
    const error = await failureOf(
      messaging.sendTextMessage('628123456789@c.us', 'see https://example.com', undefined, {
        customPreview: {
          url: 'https://example.com',
          title: 'Example',
          thumbnailUrl: `${base}/a.png`,
        },
      }),
    );

    expect(error).toBeInstanceOf(EngineNotReadyError);
    expect(newSock.waUploadToServer).not.toHaveBeenCalled();
    expect(newSock.sendMessage).not.toHaveBeenCalled();
    expect(freesKey(error)).toBe(true);
  });

  it('refuses with 409 instead of sending without thumbnail when the session drops into reconnect backoff during preview fetch', async () => {
    const error = await failureOf(
      messaging.sendTextMessage('628123456789@c.us', 'see https://example.com', undefined, {
        customPreview: {
          url: 'https://example.com',
          title: 'Example',
          thumbnailUrl: `${base}/backoff.png`,
        },
      }),
    );

    expect(error).toBeInstanceOf(EngineNotReadyError);
    expect(oldSock.sendMessage).not.toHaveBeenCalled();
    expect(freesKey(error)).toBe(true);
  });

  it('refuses with 409 when the socket is replaced during a status image fetch', async () => {
    const error = await failureOf(
      statusOps.postImageStatus(
        { data: `${base}/a.png`, mimetype: 'image/png' },
        { recipients: ['628123456789@c.us'] },
      ),
    );

    expect(error).toBeInstanceOf(EngineNotReadyError);
    expect(oldSock.sendMessage).not.toHaveBeenCalled();
    expect(newSock.sendMessage).not.toHaveBeenCalled();
  });

  it('delivers image and status sends normally when the socket and readiness stay unchanged during preparation', async () => {
    const imgRes = await messaging.sendImageMessage('628123456789@c.us', {
      data: `${base}/stable.png`,
      mimetype: 'image/png',
    });
    const statusRes = await statusOps.postImageStatus(
      { data: `${base}/stable.png`, mimetype: 'image/png' },
      { recipients: ['628123456789@c.us'] },
    );

    expect(imgRes.id).toBe('OLD');
    expect(statusRes.statusId).toBe('OLD');
    expect(oldSock.sendMessage).toHaveBeenCalledTimes(2);
    expect(newSock.sendMessage).not.toHaveBeenCalled();
  });
});
