import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import type { WASocket } from '@whiskeysockets/baileys';
import { BaileysMessaging, blockSvgDecoding, type BaileysMessagingHost } from './baileys-messaging';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { markEngineSendFailure } from '../../common/errors/engine-send-failure';
import { sendFailureProvesNothingSent } from '../../modules/message/idempotency/send-idempotency.interceptor';
import { sentNothing } from '../../modules/message/send-pacing.service';

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

type FakeSock = { onWhatsApp: jest.Mock; sendMessage: jest.Mock; waUploadToServer: jest.Mock };
const fakeSock = (id: string): FakeSock => ({
  onWhatsApp: jest.fn((jid: string) => Promise.resolve([{ jid, exists: true }])),
  sendMessage: jest.fn().mockResolvedValue({ key: { id }, messageTimestamp: 1 }),
  waUploadToServer: jest.fn(),
});

/**
 * A Baileys send refuses with 409 when its socket was replaced (a reconnect, or a logout and a relink) while
 * it waited, and never moves to the new socket. Found before sock.sendMessage is called, that 409 proves
 * nothing was sent, so a keyed send frees its Idempotency-Key and a paced send hands its admission back; found
 * after, it proves nothing, and both keep what they hold.
 */
describe('a Baileys send whose socket is replaced while it waits', () => {
  let server: Server;
  let base: string;
  let oldSock: FakeSock;
  let newSock: FakeSock;
  let current: FakeSock | null;
  let messaging: BaileysMessaging;

  /** The interceptor's own decision on an error escaping the engine call, which the send service marks. */
  const freesKey = (error: unknown): boolean => sendFailureProvesNothingSent(markEngineSendFailure(error));
  /** The pacing decision on the same error: a bulk item or product card hands its admission back only on proof. */
  const handsAdmissionBack = (error: unknown): boolean => sentNothing(error);
  /** What a close followed by a reconnect leaves behind: the session holds a different socket. */
  const reconnect = () => {
    current = newSock;
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
    server = createServer((_req, res) => {
      // The connection drops and the reconnect lands while the image is still downloading.
      reconnect();
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
    const prepareWAMessageMedia = jest
      .fn()
      .mockResolvedValue({ imageMessage: { directPath: '/d', jpegThumbnail: new Uint8Array([1]) } });
    const host = {
      ensureReady: () => undefined,
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

  const sendText = (chatId: string, thumbnailUrl?: string) =>
    messaging.sendTextMessage(chatId, 'see https://example.com', undefined, {
      customPreview: { url: 'https://example.com', title: 'Example', ...(thumbnailUrl ? { thumbnailUrl } : {}) },
    });

  it.each([
    ['a phone number', '628123456789@c.us'],
    ['a group', '120363000000000000@g.us'],
  ])('frees the key after a reconnect during the preview image fetch to %s', async (_label, chatId) => {
    const error = await failureOf(sendText(chatId, `${base}/a.png`));

    expect(error).toBeInstanceOf(EngineNotReadyError);
    expect(oldSock.sendMessage).not.toHaveBeenCalled();
    expect(newSock.sendMessage).not.toHaveBeenCalled();
    expect(freesKey(error)).toBe(true);
    expect(handsAdmissionBack(error)).toBe(true);
  });

  it('frees the key after a reconnect while the recipient lookup was answered', async () => {
    oldSock.onWhatsApp.mockImplementation((jid: string) => {
      reconnect();
      return Promise.resolve([{ jid, exists: true }]);
    });

    const error = await failureOf(sendText('628123456789@c.us'));

    expect(error).toBeInstanceOf(EngineNotReadyError);
    expect(newSock.sendMessage).not.toHaveBeenCalled();
    expect(freesKey(error)).toBe(true);
    expect(handsAdmissionBack(error)).toBe(true);
  });

  it('frees the key after a reconnect under a recipient lookup that failed', async () => {
    oldSock.onWhatsApp.mockImplementation(() => {
      reconnect();
      return Promise.reject(new Error('Connection Closed'));
    });

    const error = await failureOf(sendText('628123456789@c.us'));

    expect(error).toBeInstanceOf(EngineNotReadyError);
    expect(freesKey(error)).toBe(true);
    expect(handsAdmissionBack(error)).toBe(true);
  });

  // The message may have been written before the socket went: that 409 still keeps the key, and a paced send
  // keeps its admission held for the window.
  it('keeps the key and the admission for a swap found after sock.sendMessage was called', async () => {
    oldSock.sendMessage.mockImplementation(() => {
      reconnect();
      return Promise.reject(new Error('Connection Closed'));
    });

    const error = await failureOf(sendText('628123456789@c.us'));

    expect(error).toBeInstanceOf(EngineNotReadyError);
    expect(oldSock.sendMessage).toHaveBeenCalledTimes(1);
    expect(freesKey(error)).toBe(false);
    expect(handsAdmissionBack(error)).toBe(false);
  });
});
