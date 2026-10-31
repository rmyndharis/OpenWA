import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { BadRequestException } from '@nestjs/common';
import type { WASocket } from '@whiskeysockets/baileys';
import { BaileysMessaging, blockSvgDecoding, type BaileysMessagingHost } from './baileys-messaging';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { BAILEYS_QUERY_BUDGET_MS } from './baileys-query-deadline';

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * A custom preview image costs a fetch, a conversion slot and a WhatsApp upload, so send-text builds it only
 * once the recipient has passed the check every send to a phone number makes: a number that is not on
 * WhatsApp costs none of it, and its refusal is what the caller is told.
 */
describe('a custom link preview image on a Baileys text send', () => {
  let server: Server;
  let base: string;
  let fetches: number;
  let sock: { onWhatsApp: jest.Mock; sendMessage: jest.Mock; waUploadToServer: jest.Mock };
  let current: WASocket | null;
  let prepareWAMessageMedia: jest.Mock;
  let messaging: BaileysMessaging;
  let proxyUrl: string | undefined;

  beforeAll(async () => {
    await blockSvgDecoding();
    server = createServer((_req, res) => {
      fetches += 1;
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
    fetches = 0;
    proxyUrl = undefined;
    sock = {
      onWhatsApp: jest.fn((jid: string) => Promise.resolve([{ jid, exists: true }])),
      sendMessage: jest.fn().mockResolvedValue({ key: { id: 'M1' }, messageTimestamp: 1 }),
      waUploadToServer: jest.fn(),
    };
    current = sock as unknown as WASocket;
    prepareWAMessageMedia = jest
      .fn()
      .mockResolvedValue({ imageMessage: { directPath: '/d', jpegThumbnail: new Uint8Array([1]) } });
    const host = {
      ensureReady: () => undefined,
      sessionProxyUrl: () => proxyUrl,
      getSocket: () => sock as unknown as WASocket,
      getSocketOrNull: () => current,
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      toNeutralJid: (j: string) => j.replace('@s.whatsapp.net', '@c.us'),
      toEngineJid: (j: string) => j.replace('@c.us', '@s.whatsapp.net'),
      normalizedSelfJid: () => '628177@s.whatsapp.net',
      getEphemeralExpiration: () => undefined,
      toUnixSeconds: () => 1,
      loadLib: () => Promise.resolve({ prepareWAMessageMedia } as never),
      putStoredMessage: () => undefined,
      recordMessage: () => undefined,
      rememberOwnSend: () => undefined,
      recordLidMapping: () => undefined,
      getOnMessageCreate: () => undefined,
    } as unknown as BaileysMessagingHost;
    messaging = new BaileysMessaging(host);
  });

  afterEach(() => {
    delete process.env.SSRF_ALLOWED_HOSTS;
  });

  const send = (chatId: string, image: { thumbnailUrl?: string; thumbnailBase64?: string }) =>
    messaging.sendTextMessage(chatId, 'see https://example.com', undefined, {
      customPreview: { url: 'https://example.com', title: 'Example', ...image },
    });
  const failureOf = (promise: Promise<unknown>): Promise<unknown> =>
    promise.then(
      () => {
        throw new Error('expected the send to fail');
      },
      (error: unknown) => error,
    );

  it.each([
    ['base64', () => ({ thumbnailBase64: PNG_BYTES.toString('base64') })],
    ['a URL', () => ({ thumbnailUrl: `${base}/a.png` })],
  ])('is not fetched, converted or uploaded for an unregistered number (%s)', async (_label, image) => {
    sock.onWhatsApp.mockResolvedValue([]);

    const error = await failureOf(send('628123456789@c.us', image()));

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as Error).message).toMatch(/is not registered/);
    expect(sock.onWhatsApp).toHaveBeenCalledTimes(1);
    expect(fetches).toBe(0);
    expect(prepareWAMessageMedia).not.toHaveBeenCalled();
    expect(sock.sendMessage).not.toHaveBeenCalled();
  });

  it('answers the not-registered 400 for an unregistered number, not the error of an unreadable image', async () => {
    sock.onWhatsApp.mockResolvedValue([]);

    const error = await failureOf(
      send('628123456789@c.us', { thumbnailBase64: Buffer.from('nope').toString('base64') }),
    );

    expect((error as Error).message).toMatch(/is not registered/);
  });

  it('checks a registered number first, then uploads the image and sends it with the preview', async () => {
    await send('628123456789@c.us', { thumbnailUrl: `${base}/a.png` });

    expect(fetches).toBe(1);
    expect(sock.onWhatsApp.mock.invocationCallOrder[0]).toBeLessThan(prepareWAMessageMedia.mock.invocationCallOrder[0]);
    const [, content] = sock.sendMessage.mock.calls[0] as [string, { linkPreview: Record<string, unknown> }];
    expect(content.linkPreview).toMatchObject({ title: 'Example', highQualityThumbnail: { directPath: '/d' } });
  });

  it('still attaches the image for a group, which has no number to check', async () => {
    await send('120363000000000000@g.us', { thumbnailBase64: PNG_BYTES.toString('base64') });

    expect(sock.onWhatsApp).not.toHaveBeenCalled();
    expect(prepareWAMessageMedia).toHaveBeenCalledTimes(1);
    const [jid, content] = sock.sendMessage.mock.calls[0] as [string, { linkPreview: Record<string, unknown> }];
    expect(jid).toBe('120363000000000000@g.us');
    expect(content.linkPreview).toHaveProperty('highQualityThumbnail');
  });

  it('sends nothing when the socket is torn down while the image uploads', async () => {
    prepareWAMessageMedia.mockImplementation(() => {
      current = null;
      return Promise.resolve({ imageMessage: { directPath: '/d' } });
    });

    await expect(send('628123456789@c.us', { thumbnailBase64: PNG_BYTES.toString('base64') })).rejects.toBeInstanceOf(
      EngineNotReadyError,
    );
    expect(sock.sendMessage).not.toHaveBeenCalled();
  });

  // Baileys sets no upload deadline, and a session proxy's agent has no idle timeout to end a stalled upload.
  it('bounds the preview image upload and a media send through a session proxy', async () => {
    proxyUrl = 'http://proxy.example:8080';
    const bounded = expect.objectContaining({ mediaUploadTimeoutMs: BAILEYS_QUERY_BUDGET_MS }) as unknown;

    await send('628123456789@c.us', { thumbnailBase64: PNG_BYTES.toString('base64') });
    await messaging.sendImageMessage('628123456789@c.us', { data: PNG_BYTES, mimetype: 'image/png' });

    expect(prepareWAMessageMedia).toHaveBeenCalledWith(expect.anything(), bounded);
    expect(sock.sendMessage).toHaveBeenNthCalledWith(1, '628123456789@s.whatsapp.net', expect.anything(), bounded);
    expect(sock.sendMessage).toHaveBeenNthCalledWith(2, '628123456789@s.whatsapp.net', expect.anything(), bounded);
  });

  // Node's global agent ends a stalled upload after 5 s idle, and a request timeout would replace it.
  it('leaves the uploads of a direct session to the idle timeout of its agent', async () => {
    await send('628123456789@c.us', { thumbnailBase64: PNG_BYTES.toString('base64') });
    await messaging.sendImageMessage('628123456789@c.us', { data: PNG_BYTES, mimetype: 'image/png' });

    expect(prepareWAMessageMedia).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ mediaUploadTimeoutMs: expect.anything() as unknown }),
    );
    expect(sock.sendMessage).toHaveBeenNthCalledWith(
      1,
      '628123456789@s.whatsapp.net',
      expect.anything(),
      expect.not.objectContaining({ mediaUploadTimeoutMs: expect.anything() as unknown }),
    );
    expect(sock.sendMessage.mock.calls[1]).toHaveLength(2);
  });
});
