import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { BadRequestException, ExecutionContext, HttpException, PayloadTooLargeException } from '@nestjs/common';
import { from, lastValueFrom } from 'rxjs';
import sharp from 'sharp';
import type { WASocket } from '@whiskeysockets/baileys';
import { MessageSendService } from './message-send.service';
import { Message, MessageStatus } from './entities/message.entity';
import { SessionService } from '../session/session.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { EngineStatus, type IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { HookManager } from '../../core/hooks';
import { TemplateService } from '../template/template.service';
import { SendPacingService } from './send-pacing.service';
import { SendIdempotencyKey } from './entities/send-idempotency-key.entity';
import { SendIdempotencyService } from './idempotency/send-idempotency.service';
import { SendIdempotencyInterceptor } from './idempotency/send-idempotency.interceptor';
import { BaileysMessaging, blockSvgDecoding, type BaileysMessagingHost } from '../../engine/adapters/baileys-messaging';
import { WhatsAppWebJsAdapter } from '../../engine/adapters/whatsapp-web-js.adapter';
import { EngineNotSentError } from '../../common/errors/engine-not-sent.error';
import { SSRF_BLOCKED_CLIENT_MESSAGE } from '../../common/security/ssrf-guard';

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * A send the gateway refuses before anything reaches WhatsApp (a media or preview image it cannot fetch or
 * read) frees its Idempotency-Key, keeping its status and body, so the identical retry runs again instead of
 * answering 409 IDEMPOTENCY_OUTCOME_UNKNOWN. Real service, real interceptor on a SQLite store, real Baileys
 * messaging code with real sharp, and the real loader against a local server.
 */
describe('a keyed send refused before anything reaches WhatsApp', () => {
  let server: Server;
  let base: string;
  let handler: (req: IncomingMessage, res: ServerResponse) => void;
  let service: MessageSendService;
  let repository: Record<string, jest.Mock>;
  let release: jest.Mock;
  let ds: DataSource;
  let interceptor: SendIdempotencyInterceptor;
  let sock: { onWhatsApp: jest.Mock; sendMessage: jest.Mock; waUploadToServer: jest.Mock };
  let prepareWAMessageMedia: jest.Mock;
  let proxy: string | undefined;
  let truncatedJpeg: Buffer;
  let engines: EngineRegistry;
  /** A local port nothing listens on, so a fetch to it fails to connect. */
  let closedPort: number;

  const servePng = () => {
    handler = (_req, res) => res.writeHead(200, { 'content-type': 'image/png' }).end(PNG_BYTES);
  };

  beforeAll(async () => {
    await blockSvgDecoding();
    server = createServer((req, res) => handler(req, res));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const full = await sharp({
      create: {
        width: 600,
        height: 300,
        channels: 3,
        background: '#000000',
        noise: { type: 'gaussian', mean: 128, sigma: 30 },
      },
    })
      .jpeg()
      .toBuffer();
    truncatedJpeg = full.subarray(0, Math.floor(full.length / 3));
    const spare = createServer();
    await new Promise<void>(resolve => spare.listen(0, '127.0.0.1', resolve));
    closedPort = (spare.address() as AddressInfo).port;
    await new Promise<void>(resolve => spare.close(() => resolve()));
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  beforeEach(async () => {
    process.env.SIMULATE_TYPING = 'false';
    process.env.SSRF_ALLOWED_HOSTS = '127.0.0.1';
    proxy = undefined;
    servePng();
    repository = {
      create: jest.fn().mockImplementation((d: Partial<Message>) => ({ id: 'row-1', ...d }) as Message),
      save: jest.fn().mockImplementation((m: Message) => Promise.resolve(m)),
      findOne: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    sock = {
      onWhatsApp: jest.fn((jid: string) => Promise.resolve([{ jid, exists: true }])),
      sendMessage: jest.fn().mockResolvedValue({ key: { id: 'M1' }, messageTimestamp: 1 }),
      waUploadToServer: jest.fn(),
    };
    prepareWAMessageMedia = jest
      .fn()
      .mockResolvedValue({ imageMessage: { directPath: '/d', jpegThumbnail: new Uint8Array([1]) } });
    const host = {
      ensureReady: () => undefined,
      sessionProxyUrl: () => proxy,
      getSocket: () => sock as unknown as WASocket,
      getSocketOrNull: () => sock as unknown as WASocket,
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
    const messaging = new BaileysMessaging(host);
    engines = new EngineRegistry();
    engines.set('sess-1', {
      sendTextMessage: (...args: Parameters<BaileysMessaging['sendTextMessage']>) => messaging.sendTextMessage(...args),
      sendImageMessage: (...args: Parameters<BaileysMessaging['sendImageMessage']>) =>
        messaging.sendImageMessage(...args),
      sendStickerMessage: (...args: Parameters<BaileysMessaging['sendStickerMessage']>) =>
        messaging.sendStickerMessage(...args),
    } as unknown as IWhatsAppEngine);
    release = jest.fn();
    const module = await Test.createTestingModule({
      providers: [
        MessageSendService,
        {
          provide: SendPacingService,
          useValue: {
            assertSendAllowed: jest.fn().mockResolvedValue(release),
            recordSendFailure: jest.fn(),
            recordSendSuccess: jest.fn(),
          },
        },
        { provide: getRepositoryToken(Message, 'data'), useValue: repository },
        { provide: SessionService, useValue: { findOne: jest.fn().mockResolvedValue({ id: 'sess-1' }) } },
        { provide: EngineRegistry, useValue: engines },
        {
          provide: HookManager,
          useValue: { execute: jest.fn((_e: string, data: unknown) => Promise.resolve({ continue: true, data })) },
        },
        { provide: TemplateService, useValue: { resolve: jest.fn() } },
      ],
    }).compile();
    service = module.get(MessageSendService);
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [SendIdempotencyKey],
      synchronize: true,
    });
    await ds.initialize();
    interceptor = new SendIdempotencyInterceptor(new SendIdempotencyService(ds.getRepository(SendIdempotencyKey)));
  });

  afterEach(async () => {
    delete process.env.SIMULATE_TYPING;
    delete process.env.SSRF_ALLOWED_HOSTS;
    await ds.destroy();
  });

  type Route = 'sendText' | 'sendImage' | 'sendSticker';
  const withKey = async (route: Route, body: object): Promise<unknown> => {
    const context = {
      getType: () => 'http',
      getHandler: () => ({ name: route }),
      switchToHttp: () => ({
        getRequest: () => ({ headers: { 'idempotency-key': 'k-1' }, params: { sessionId: 'sess-1' }, body }),
        getResponse: () => ({ setHeader: jest.fn() }),
      }),
    } as unknown as ExecutionContext;
    const send = () => service[route]('sess-1', body as never);
    return lastValueFrom(await interceptor.intercept(context, { handle: () => from(send()) }));
  };
  const failure = (route: Route, body: object): Promise<unknown> =>
    withKey(route, body).then(
      () => {
        throw new Error('expected the send to fail');
      },
      (error: unknown) => error,
    );
  const keyState = async () =>
    (await ds.getRepository(SendIdempotencyKey).findOneBy({ idempotencyKey: 'k-1' }))?.state ?? 'absent';
  const failedRowWritten = () =>
    (repository.update.mock.calls as Array<[unknown, { status?: string }]>).some(
      ([, change]) => change.status === MessageStatus.FAILED,
    );
  const previewBody = (image: { thumbnailUrl?: string; thumbnailBase64?: string }) => ({
    chatId: '628123456789@c.us',
    text: 'see https://example.com',
    customLinkPreview: { url: 'https://example.com', title: 'Example', ...image },
  });
  const streamBytes = (n: number) => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' });
      const chunk = Buffer.alloc(64 * 1024);
      let left = n;
      const pump = () => {
        while (left > 0) {
          const part = chunk.subarray(0, Math.min(chunk.length, left));
          left -= part.length;
          if (!res.write(part)) return void res.once('drain', pump);
        }
        res.end();
      };
      pump();
    };
  };

  /** [label, image, status, message, whether serving a valid image lets the identical retry succeed] */
  const refusals: Array<
    [string, () => { thumbnailUrl?: string; thumbnailBase64?: string }, number, string | RegExp, boolean]
  > = [
    [
      'unreadable base64 bytes',
      () => ({ thumbnailBase64: Buffer.from('hello, not an image').toString('base64') }),
      400,
      /could not be read as an image/,
      false,
    ],
    [
      'a truncated base64 JPEG',
      () => ({ thumbnailBase64: truncatedJpeg.toString('base64') }),
      400,
      /could not be read as an image/,
      false,
    ],
    [
      'a thumbnailUrl body over 5 MiB',
      () => (streamBytes(5 * 1024 * 1024 + 1), { thumbnailUrl: `${base}/big.png` }),
      413,
      /exceeds the 5242880-byte limit/,
      true,
    ],
    [
      'a thumbnailUrl answering 404',
      () => ((handler = (_req, res) => res.writeHead(404).end()), { thumbnailUrl: `${base}/gone.png` }),
      400,
      /status 404/,
      true,
    ],
    [
      'a thumbnailUrl the SSRF guard blocks',
      () => ({ thumbnailUrl: 'http://10.0.0.1/a.png' }),
      400,
      SSRF_BLOCKED_CLIENT_MESSAGE,
      false,
    ],
    [
      'a thumbnailUrl whose connection fails without a proxy',
      () => ({ thumbnailUrl: `http://127.0.0.1:${closedPort}/a.png` }),
      400,
      /^Media fetch failed$/,
      false,
    ],
  ];

  it.each(refusals)(
    'send-text with %s keeps its status and frees the key; the identical retry runs again',
    async (_label, image, status, message, fixable) => {
      const body = previewBody(image());

      const error = await failure('sendText', body);
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(status);
      expect((error as HttpException).message).toMatch(message);
      expect(sock.sendMessage).not.toHaveBeenCalled();
      expect(prepareWAMessageMedia).not.toHaveBeenCalled();
      expect(await keyState()).toBe('absent');
      // Unchanged, as for the session proxy's 503: the PENDING row is kept as FAILED and its admission counted.
      expect(failedRowWritten()).toBe(true);
      expect(release).toHaveBeenCalledWith(true);

      if (fixable) {
        servePng();
        await expect(withKey('sendText', body)).resolves.toMatchObject({ messageId: 'M1' });
        expect(sock.sendMessage).toHaveBeenCalledTimes(1);
        expect(await keyState()).toBe('completed');
      } else {
        const again = await failure('sendText', body);
        expect((again as HttpException).getStatus()).toBe(status);
        expect(await keyState()).toBe('absent');
      }
    },
  );

  it('send-text with a base64 image over 5 MiB is refused by the service: no row, admission refunded', async () => {
    const error = await failure(
      'sendText',
      previewBody({ thumbnailBase64: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64') }),
    );

    expect(error).toBeInstanceOf(PayloadTooLargeException);
    expect(release).toHaveBeenCalledWith(false);
    expect(failedRowWritten()).toBe(false);
    expect(await keyState()).toBe('absent');
  });

  it('send-text whose thumbnailUrl fetch fails at the session proxy answers 503 and frees the key', async () => {
    proxy = 'http://127.0.0.1:1';

    const error = await failure('sendText', previewBody({ thumbnailUrl: `${base}/a.png` }));

    expect(error).toBeInstanceOf(EngineNotSentError);
    expect(sock.sendMessage).not.toHaveBeenCalled();
    expect(await keyState()).toBe('absent');
  });

  it('send-text whose socket reconnects during the preview image fetch frees the key; the retry sends', async () => {
    const before = sock;
    const after = { ...sock, sendMessage: jest.fn().mockResolvedValue({ key: { id: 'M2' }, messageTimestamp: 1 }) };
    handler = (_req, res) => {
      sock = after;
      res.writeHead(200, { 'content-type': 'image/png' }).end(PNG_BYTES);
    };
    const body = previewBody({ thumbnailUrl: `${base}/a.png` });

    const error = await failure('sendText', body);

    expect((error as HttpException).getStatus()).toBe(409);
    expect(before.sendMessage).not.toHaveBeenCalled();
    expect(after.sendMessage).not.toHaveBeenCalled();
    expect(await keyState()).toBe('absent');
    servePng();
    await expect(withKey('sendText', body)).resolves.toMatchObject({ messageId: 'M2' });
  });

  it('send-image whose url answers 404 frees the key on Baileys; the retry sends once the url works', async () => {
    handler = (_req, res) => res.writeHead(404).end();
    const body = { chatId: '628123456789@c.us', url: `${base}/photo.png`, mimetype: 'image/png' };

    const error = await failure('sendImage', body);

    expect(error).toBeInstanceOf(BadRequestException);
    expect(sock.sendMessage).not.toHaveBeenCalled();
    expect(await keyState()).toBe('absent');
    servePng();
    await expect(withKey('sendImage', body)).resolves.toMatchObject({ messageId: 'M1' });
  });

  it('send-image whose url answers 404 frees the key on whatsapp-web.js, before the page is asked', async () => {
    const adapter = new WhatsAppWebJsAdapter({
      sessionId: 'sess-1',
      sessionDataPath: './data/sessions',
      puppeteer: {},
    });
    const client = { sendMessage: jest.fn() };
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    (adapter as unknown as { client: unknown }).client = client;
    engines.set('sess-1', adapter);
    handler = (_req, res) => res.writeHead(404).end();

    const error = await failure('sendImage', { chatId: '628123456789@c.us', url: `${base}/photo.png` });

    expect(error).toBeInstanceOf(BadRequestException);
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(await keyState()).toBe('absent');
  });

  it.each([
    ['bytes that do not decode', 'image/png', Buffer.from('nope'), /could not be converted to WebP/],
    ['a type that is no image', 'application/pdf', Buffer.from('%PDF-1.4'), /Received 'application\/pdf'/],
  ])('send-sticker with %s keeps its 400 and frees the key on Baileys', async (_label, mimetype, bytes, message) => {
    const body = { chatId: '628123456789@c.us', base64: bytes.toString('base64'), mimetype };

    const error = await failure('sendSticker', body);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as Error).message).toMatch(message);
    expect(sock.sendMessage).not.toHaveBeenCalled();
    expect(await keyState()).toBe('absent');
    expect(await failure('sendSticker', body)).toBeInstanceOf(BadRequestException);
  });

  // Control: a failure from the socket itself proves nothing, so the key stays taken.
  it('keeps the key when the socket send itself fails', async () => {
    sock.sendMessage.mockRejectedValue(new Error('socket write failed'));
    const body = previewBody({ thumbnailBase64: PNG_BYTES.toString('base64') });

    await failure('sendText', body);

    expect(await keyState()).toBe('failed');
    await expect(withKey('sendText', body)).rejects.toMatchObject({
      response: { code: 'IDEMPOTENCY_OUTCOME_UNKNOWN' },
    });
  });
});
