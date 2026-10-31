import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ExecutionContext, HttpException } from '@nestjs/common';
import { from, lastValueFrom } from 'rxjs';
import type { WASocket } from '@whiskeysockets/baileys';
import { MessageSendService } from './message-send.service';
import { Message } from './entities/message.entity';
import { SessionService } from '../session/session.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { type IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { HookManager } from '../../core/hooks';
import { TemplateService } from '../template/template.service';
import { SendPacingService } from './send-pacing.service';
import { SendIdempotencyKey } from './entities/send-idempotency-key.entity';
import { SendIdempotencyService } from './idempotency/send-idempotency.service';
import { SendIdempotencyInterceptor } from './idempotency/send-idempotency.interceptor';
import { BaileysMessaging, type BaileysMessagingHost } from '../../engine/adapters/baileys-messaging';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';

/**
 * A Baileys send writes once, with sock.sendMessage. Every not-ready 409 raised before that write sent nothing, so a
 * keyed send frees its Idempotency-Key for it: the session not ready yet, or its socket replaced or torn down during
 * an await before the write (a recipient lookup, the library load, the quoted message's checks). The same 409 after
 * the write proves nothing and keeps the key. Real service, real interceptor on a SQLite store, real Baileys
 * messaging code with a stand-in socket shaped like the adapter's host.
 */
describe('a keyed Baileys send refused with the not-ready 409', () => {
  const PHONE = '628123456789@c.us';
  const LID = '159442138038327@lid';

  type FakeSock = {
    onWhatsApp: jest.Mock;
    sendMessage: jest.Mock;
    executeUSyncQuery: jest.Mock;
    signalRepository: { lidMapping: { getLIDForPN: jest.Mock } };
  };
  const fakeSock = (): FakeSock => ({
    onWhatsApp: jest.fn((jid: string) => Promise.resolve([{ jid, exists: true }])),
    sendMessage: jest.fn().mockResolvedValue({ key: { id: 'M1' }, messageTimestamp: 1 }),
    executeUSyncQuery: jest.fn().mockResolvedValue(undefined),
    signalRepository: { lidMapping: { getLIDForPN: jest.fn().mockResolvedValue(null) } },
  });

  let ready: boolean;
  let current: FakeSock | null;
  let sock: FakeSock;
  let replacement: FakeSock;
  let loadLib: jest.Mock;
  let getStoredMessage: jest.Mock;
  let service: MessageSendService;
  let ds: DataSource;
  let interceptor: SendIdempotencyInterceptor;

  beforeEach(async () => {
    process.env.SIMULATE_TYPING = 'false';
    ready = true;
    sock = fakeSock();
    replacement = fakeSock();
    current = sock;
    loadLib = jest.fn().mockResolvedValue({});
    getStoredMessage = jest.fn((id: string) =>
      Promise.resolve({ key: { remoteJid: LID, id, fromMe: false }, message: { conversation: 'quoted' } }),
    );
    const host = {
      ensureReady: () => {
        if (!ready || !current) throw new EngineNotReadyError();
      },
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
      loadLib,
      getStoredMessage,
      wasDeletedForEveryone: () => false,
      pendingEditOf: () => undefined,
      putStoredMessage: () => undefined,
      recordMessage: () => undefined,
      rememberOwnSend: () => undefined,
      recordLidMapping: () => undefined,
      getOnMessageCreate: () => undefined,
    } as unknown as BaileysMessagingHost;
    const messaging = new BaileysMessaging(host);
    const engines = new EngineRegistry();
    engines.set('sess-1', {
      sendTextMessage: (...args: Parameters<BaileysMessaging['sendTextMessage']>) => messaging.sendTextMessage(...args),
      sendLocationMessage: (...args: Parameters<BaileysMessaging['sendLocationMessage']>) =>
        messaging.sendLocationMessage(...args),
      replyToMessage: (...args: Parameters<BaileysMessaging['replyToMessage']>) => messaging.replyToMessage(...args),
    } as unknown as IWhatsAppEngine);
    const module = await Test.createTestingModule({
      providers: [
        MessageSendService,
        {
          provide: SendPacingService,
          useValue: {
            assertSendAllowed: jest.fn().mockResolvedValue(jest.fn()),
            recordSendFailure: jest.fn(),
            recordSendSuccess: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Message, 'data'),
          useValue: {
            create: jest.fn().mockImplementation((d: Partial<Message>) => ({ id: 'row-1', ...d }) as Message),
            save: jest.fn().mockImplementation((m: Message) => Promise.resolve(m)),
            findOne: jest.fn().mockResolvedValue(null),
            update: jest.fn().mockResolvedValue({ affected: 1 }),
          },
        },
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
    await ds.destroy();
  });

  type Route = { name: string; body: Record<string, unknown>; run: () => Promise<unknown> };
  const sendText = (): Route => {
    const body = { chatId: PHONE, text: 'hello' };
    return { name: 'sendText', body, run: () => service.sendText('sess-1', body) };
  };
  const sendLocation = (): Route => {
    const body = { chatId: PHONE, latitude: 1, longitude: 2 };
    return { name: 'sendLocation', body, run: () => service.sendLocation('sess-1', body) };
  };
  const reply = (): Route => {
    const body = { chatId: PHONE, quotedMessageId: 'Q1', text: 'hello' };
    return { name: 'reply', body, run: () => service.reply('sess-1', body) };
  };

  const withKey = async (route: Route = sendText()): Promise<unknown> => {
    const context = {
      getType: () => 'http',
      getHandler: () => ({ name: route.name }),
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { 'idempotency-key': 'k-1' },
          params: { sessionId: 'sess-1' },
          body: route.body,
        }),
        getResponse: () => ({ setHeader: jest.fn() }),
      }),
    } as unknown as ExecutionContext;
    return lastValueFrom(await interceptor.intercept(context, { handle: () => from(route.run()) }));
  };
  const failure = (route?: Route): Promise<unknown> =>
    withKey(route).then(
      () => {
        throw new Error('expected the send to fail');
      },
      (error: unknown) => error,
    );
  const keyState = async () =>
    (await ds.getRepository(SendIdempotencyKey).findOneBy({ idempotencyKey: 'k-1' }))?.state ?? 'absent';
  const nothingWritten = (): void => {
    expect(sock.sendMessage).not.toHaveBeenCalled();
    expect(replacement.sendMessage).not.toHaveBeenCalled();
  };

  it('frees the key of a send refused while the session is not ready, and the retry sends once it is', async () => {
    ready = false;

    const error = await failure();

    expect((error as HttpException).getStatus()).toBe(409);
    nothingWritten();
    expect(await keyState()).toBe('absent');

    ready = true;
    await expect(withKey()).resolves.toMatchObject({ messageId: 'M1' });
  });

  it('frees the key of a send whose socket is replaced during the recipient number check', async () => {
    sock.onWhatsApp.mockImplementation((jid: string) => {
      current = replacement;
      return Promise.resolve([{ jid, exists: true }]);
    });

    const error = await failure();

    expect((error as HttpException).getStatus()).toBe(409);
    nothingWritten();
    expect(await keyState()).toBe('absent');
  });

  it.each([
    ['replaced', () => replacement],
    ['torn down', () => null],
  ])('frees the key of a send whose socket is %s during the recipient lid lookup', async (_label, next) => {
    sock.signalRepository.lidMapping.getLIDForPN.mockImplementation(() => {
      current = next();
      return Promise.resolve(null);
    });

    const error = await failure();

    expect((error as HttpException).getStatus()).toBe(409);
    nothingWritten();
    expect(await keyState()).toBe('absent');
  });

  it('frees the key of a send whose session stops before the recipient is resolved', async () => {
    loadLib.mockImplementation(() => {
      current = null;
      return Promise.resolve({});
    });

    const error = await failure(sendLocation());

    expect((error as HttpException).getStatus()).toBe(409);
    nothingWritten();
    expect(await keyState()).toBe('absent');
  });

  it.each([
    ['read from the store', () => getStoredMessage],
    ['matched to the chat', () => loadLib],
  ])('frees the key of a reply whose socket is replaced while the quoted message is %s', async (_label, step) => {
    const original = step().getMockImplementation() as (...args: unknown[]) => Promise<unknown>;
    step().mockImplementationOnce((...args: unknown[]) => {
      current = replacement;
      return original(...args);
    });

    const error = await failure(reply());

    expect((error as HttpException).getStatus()).toBe(409);
    nothingWritten();
    expect(await keyState()).toBe('absent');
  });

  // The message may have been written before the socket went, so the outcome is unknown.
  it('keeps the key of a send that fails after the write on a socket torn down meanwhile', async () => {
    sock.sendMessage.mockImplementation(() => {
      current = null;
      return Promise.reject(new Error('Connection Closed'));
    });

    const error = await failure();

    expect((error as HttpException).getStatus()).toBe(409);
    expect(sock.sendMessage).toHaveBeenCalledTimes(1);
    expect(await keyState()).toBe('failed');
    current = sock;
    await expect(withKey()).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_OUTCOME_UNKNOWN' } });
  });
});
