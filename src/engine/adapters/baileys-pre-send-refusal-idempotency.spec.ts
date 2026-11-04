import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { BadRequestException, ExecutionContext } from '@nestjs/common';
import { from, lastValueFrom } from 'rxjs';
import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import { MessageSendService } from '../../modules/message/message-send.service';
import { Message } from '../../modules/message/entities/message.entity';
import { SessionService } from '../../modules/session/session.service';
import { EngineRegistry } from '../engine-registry.service';
import type { IWhatsAppEngine } from '../interfaces/whatsapp-engine.interface';
import { HookManager } from '../../core/hooks';
import { TemplateService } from '../../modules/template/template.service';
import { SendPacingService } from '../../modules/message/send-pacing.service';
import { SendIdempotencyKey } from '../../modules/message/entities/send-idempotency-key.entity';
import { SendIdempotencyService } from '../../modules/message/idempotency/send-idempotency.service';
import { SendIdempotencyInterceptor } from '../../modules/message/idempotency/send-idempotency.interceptor';
import { BaileysMessaging, type BaileysMessagingHost } from './baileys-messaging';
import type { SendTextMessageDto } from '../../modules/message/dto/send-message.dto';

/**
 * Baileys refuses a phone number WhatsApp reports as unregistered after its number check, and a quoted message
 * the store does not hold before the send starts; both come before the message content is built and before
 * sock.sendMessage, so nothing reached WhatsApp. The keyed send then frees its Idempotency-Key, as it does for
 * the other refusals raised in that window, and the identical retry runs again. Real service, real interceptor
 * on a SQLite store and real Baileys messaging code.
 */
describe('a keyed Baileys send refused before its message is built', () => {
  let service: MessageSendService;
  let ds: DataSource;
  let interceptor: SendIdempotencyInterceptor;
  let sock: { onWhatsApp: jest.Mock; sendMessage: jest.Mock };

  let body: SendTextMessageDto;
  let stored: WAMessage | null;

  beforeEach(async () => {
    process.env.SIMULATE_TYPING = 'false';
    body = { chatId: '628123456789@c.us', text: 'hello' };
    stored = null;
    sock = {
      onWhatsApp: jest.fn().mockResolvedValue([]),
      sendMessage: jest.fn().mockResolvedValue({ key: { id: 'M1' }, messageTimestamp: 1 }),
    };
    const host = {
      ensureReady: () => undefined,
      sessionProxyUrl: () => undefined,
      getSocket: () => sock as unknown as WASocket,
      getSocketOrNull: () => sock as unknown as WASocket,
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      toNeutralJid: (j: string) => j.replace('@s.whatsapp.net', '@c.us'),
      toEngineJid: (j: string) => j.replace('@c.us', '@s.whatsapp.net'),
      normalizedSelfJid: () => '628177@s.whatsapp.net',
      getEphemeralExpiration: () => undefined,
      toUnixSeconds: () => 1,
      loadLib: () => Promise.resolve({} as never),
      putStoredMessage: () => undefined,
      recordMessage: () => undefined,
      rememberOwnSend: () => undefined,
      recordLidMapping: () => undefined,
      getOnMessageCreate: () => undefined,
      getStoredMessage: () => Promise.resolve(stored),
      pendingEditOf: () => undefined,
      wasDeletedForEveryone: () => false,
    } as unknown as BaileysMessagingHost;
    const messaging = new BaileysMessaging(host);
    const engines = new EngineRegistry();
    engines.set('sess-1', {
      sendTextMessage: (...args: Parameters<BaileysMessaging['sendTextMessage']>) => messaging.sendTextMessage(...args),
      replyToMessage: (...args: Parameters<BaileysMessaging['replyToMessage']>) => messaging.replyToMessage(...args),
      forwardMessage: (...args: Parameters<BaileysMessaging['forwardMessage']>) => messaging.forwardMessage(...args),
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

  const keyed = async (handler: string, request: object, run: () => Promise<unknown>): Promise<unknown> => {
    const context = {
      getType: () => 'http',
      getHandler: () => ({ name: handler }),
      switchToHttp: () => ({
        getRequest: () => ({ headers: { 'idempotency-key': 'k-1' }, params: { sessionId: 'sess-1' }, body: request }),
        getResponse: () => ({ setHeader: jest.fn() }),
      }),
    } as unknown as ExecutionContext;
    return lastValueFrom(await interceptor.intercept(context, { handle: () => from(run()) }));
  };
  const withKey = (): Promise<unknown> => keyed('sendText', body, () => service.sendText('sess-1', body));
  const keyState = async () =>
    (await ds.getRepository(SendIdempotencyKey).findOneBy({ idempotencyKey: 'k-1' }))?.state ?? 'absent';

  it('to a number WhatsApp reports as unregistered keeps its 400, frees the key, and the identical retry runs the send again', async () => {
    await expect(withKey()).rejects.toBeInstanceOf(BadRequestException);
    expect(sock.sendMessage).not.toHaveBeenCalled();
    expect(await keyState()).toBe('absent');

    // The number is registered by the time the client retries with the same key.
    sock.onWhatsApp.mockImplementation((jid: string) => Promise.resolve([{ jid, exists: true }]));
    await expect(withKey()).resolves.toMatchObject({ messageId: 'M1' });
    expect(sock.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('with a quotedMessageId the store does not hold keeps its 404 and frees the key', async () => {
    sock.onWhatsApp.mockImplementation((jid: string) => Promise.resolve([{ jid, exists: true }]));
    body = { chatId: '628123456789@c.us', text: 'hello', quotedMessageId: '3EB0UNKNOWN' };

    await expect(withKey()).rejects.toMatchObject({ status: 404 });
    expect(sock.sendMessage).not.toHaveBeenCalled();
    expect(await keyState()).toBe('absent');
  });

  it('with a reply or forward naming a message stored under another chat keeps its 404 and frees the key', async () => {
    sock.onWhatsApp.mockImplementation((jid: string) => Promise.resolve([{ jid, exists: true }]));
    stored = {
      key: { id: 'Q1', remoteJid: '628999000111@s.whatsapp.net', fromMe: false },
      message: { conversation: 'q' },
    };
    const reply = { chatId: '628123456789@c.us', quotedMessageId: 'Q1', text: 'hello' };
    const forward = { fromChatId: '628123456789@c.us', toChatId: '628123456789@c.us', messageId: 'Q1' };

    await expect(keyed('reply', reply, () => service.reply('sess-1', reply))).rejects.toMatchObject({ status: 404 });
    expect(await keyState()).toBe('absent');
    await expect(keyed('forward', forward, () => service.forward('sess-1', forward))).rejects.toMatchObject({
      status: 404,
    });
    expect(await keyState()).toBe('absent');
    expect(sock.sendMessage).not.toHaveBeenCalled();
  });

  it('keeps the key of a send that failed once the message was handed to the socket', async () => {
    sock.onWhatsApp.mockImplementation((jid: string) => Promise.resolve([{ jid, exists: true }]));
    sock.sendMessage.mockRejectedValue(new Error('relay failed'));

    await expect(withKey()).rejects.toThrow();
    expect(sock.sendMessage).toHaveBeenCalledTimes(1);
    expect(await keyState()).toBe('failed');
  });
});
