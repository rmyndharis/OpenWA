import { EventEmitter } from 'events';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ExecutionContext, HttpException } from '@nestjs/common';
import { from, lastValueFrom } from 'rxjs';
import { WAState } from 'whatsapp-web.js';
import { MessageSendService } from './message-send.service';
import { Message } from './entities/message.entity';
import { SessionService } from '../session/session.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { EngineStatus } from '../../engine/interfaces/whatsapp-engine.interface';
import { HookManager } from '../../core/hooks';
import { TemplateService } from '../template/template.service';
import { SendPacingService } from './send-pacing.service';
import { SendIdempotencyKey } from './entities/send-idempotency-key.entity';
import { SendIdempotencyService } from './idempotency/send-idempotency.service';
import { SendIdempotencyInterceptor } from './idempotency/send-idempotency.interceptor';
import { WhatsAppWebJsAdapter } from '../../engine/adapters/whatsapp-web-js.adapter';
import {
  NAVIGATION_REINJECT_GRACE_MS,
  PAGE_RELOADING_MESSAGE,
  WwebjsLifecycle,
} from '../../engine/adapters/wwebjs-lifecycle';

/**
 * A whatsapp-web.js send that the adapter refuses with the retryable 409 before the page is asked (the session is not
 * ready, WhatsApp Web is reloading its page, or a probe found the reloaded page without its helpers) sent nothing.
 * Its Idempotency-Key must then be free, so the retry the 409 asks for runs, instead of answering
 * 409 IDEMPOTENCY_OUTCOME_UNKNOWN for a message that never left. The same 409 raised after a send attempt proves
 * nothing and keeps the key. Real service, real interceptor on a SQLite store, real adapter and lifecycle with a
 * stand-in page.
 */
describe('a keyed whatsapp-web.js send refused with the not-ready 409', () => {
  const GROUP = '120363000000000000@g.us';
  const PHONE = '628123456789@c.us';
  const LID = '159442138038327@lid';

  let service: MessageSendService;
  let ds: DataSource;
  let interceptor: SendIdempotencyInterceptor;
  let adapter: WhatsAppWebJsAdapter;
  let client: EventEmitter & {
    getState: jest.Mock;
    sendMessage: jest.Mock;
    getNumberId: jest.Mock;
    getChatById: jest.Mock;
    pupPage: EventEmitter & { evaluate: jest.Mock };
    pupBrowser: EventEmitter;
  };
  let now: number;

  const setStatus = (status: EngineStatus): void => {
    (adapter as unknown as { status: EngineStatus }).status = status;
  };

  beforeEach(async () => {
    process.env.SIMULATE_TYPING = 'false';
    now = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => now);

    adapter = new WhatsAppWebJsAdapter({ sessionId: 'sess-1', sessionDataPath: './data/sessions' });
    const pupPage = Object.assign(new EventEmitter(), { evaluate: jest.fn().mockResolvedValue(false) });
    client = Object.assign(new EventEmitter(), {
      getState: jest.fn().mockResolvedValue(WAState.CONNECTED),
      sendMessage: jest.fn().mockResolvedValue({ id: { _serialized: 'true_x@g.us_M1' }, timestamp: 1 }),
      getNumberId: jest.fn((number: string) => Promise.resolve({ _serialized: number })),
      getChatById: jest.fn(),
      pupBrowser: new EventEmitter(),
      pupPage,
    });
    (adapter as unknown as { client: unknown }).client = client;
    (adapter as unknown as { callbacks: unknown }).callbacks = {};
    setStatus(EngineStatus.READY);
    const lifecycle = (adapter as unknown as { lifecycle: WwebjsLifecycle }).lifecycle;
    lifecycle.setupEventHandlers();
    lifecycle.attachPuppeteerLifecycleListeners();

    const engines = new EngineRegistry();
    engines.set('sess-1', adapter);
    const repository = {
      create: jest.fn().mockImplementation((d: Partial<Message>) => ({ id: 'row-1', ...d }) as Message),
      save: jest.fn().mockImplementation((m: Message) => Promise.resolve(m)),
      findOne: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
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
    jest.restoreAllMocks();
    await ds.destroy();
  });

  type Route = { name: string; body: Record<string, unknown>; run: () => Promise<unknown> };
  const sendText = (chatId = GROUP): Route => {
    const body = { chatId, text: 'hello' };
    return { name: 'sendText', body, run: () => service.sendText('sess-1', body) };
  };
  const reply = (): Route => {
    const body = { chatId: GROUP, quotedMessageId: 'Q1', text: 'hello' };
    return { name: 'reply', body, run: () => service.reply('sess-1', body) };
  };
  const forward = (): Route => {
    const body = { fromChatId: GROUP, toChatId: PHONE, messageId: 'SRC1' };
    return { name: 'forward', body, run: () => service.forward('sess-1', body) };
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
  const reload = (): void => {
    client.pupPage.emit('framenavigated', { url: () => 'https://web.whatsapp.com/' });
  };

  it('frees the key of a send refused while WhatsApp Web reloads its page; the retry sends once it is back', async () => {
    reload();
    now += 5_000;

    const error = await failure();

    expect(error).toBeInstanceOf(HttpException);
    expect({ status: (error as HttpException).getStatus(), message: (error as Error).message }).toEqual({
      status: 409,
      message: PAGE_RELOADING_MESSAGE,
    });
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(await keyState()).toBe('absent');

    client.pupPage.evaluate.mockResolvedValue(true);
    // The re-injected page's ready closes the reload window synchronously.
    client.emit('ready');
    await expect(withKey()).resolves.toMatchObject({ messageId: 'true_x@g.us_M1' });
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('frees the key of a send refused on a reloaded page a probe found without its helpers', async () => {
    reload();
    now += NAVIGATION_REINJECT_GRACE_MS + 5_000;
    await expect(adapter.probeLiveness()).resolves.toBe(true);

    const error = await failure();

    expect((error as HttpException).getStatus()).toBe(409);
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(await keyState()).toBe('absent');
  });

  it('frees the key of a send refused while the session is not ready', async () => {
    setStatus(EngineStatus.AUTHENTICATING);

    const error = await failure();

    expect((error as HttpException).getStatus()).toBe(409);
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(await keyState()).toBe('absent');
  });

  it('frees the key of a send whose session goes away during the recipient lookup', async () => {
    client.getNumberId.mockImplementation((number: string) => {
      setStatus(EngineStatus.DISCONNECTED);
      return Promise.resolve({ _serialized: number });
    });

    const error = await failure(sendText(PHONE));

    expect((error as HttpException).getStatus()).toBe(409);
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(await keyState()).toBe('absent');
  });

  it('frees the key of a reply whose session goes away while the quoted message is read', async () => {
    client.getChatById.mockImplementation(() => {
      setStatus(EngineStatus.DISCONNECTED);
      return Promise.reject(new Error('Evaluation failed: t'));
    });

    const error = await failure(reply());

    expect((error as HttpException).getStatus()).toBe(409);
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(await keyState()).toBe('absent');
  });

  it('frees the key of a forward whose session goes away while its destination is read before the first attempt', async () => {
    const forwardCopy = jest.fn().mockResolvedValue(undefined);
    const source = {
      fetchMessages: jest.fn().mockResolvedValue([{ id: { _serialized: 'SRC1' }, forward: forwardCopy }]),
    };
    const destination = {
      fetchMessages: jest.fn(() => {
        setStatus(EngineStatus.DISCONNECTED);
        return Promise.resolve([]);
      }),
    };
    client.getChatById.mockImplementation((id: string) => Promise.resolve(id === GROUP ? source : destination));

    const error = await failure(forward());

    expect((error as HttpException).getStatus()).toBe(409);
    expect(forwardCopy).not.toHaveBeenCalled();
    expect(await keyState()).toBe('absent');
  });

  it('keeps the key when the page send itself fails', async () => {
    client.sendMessage.mockRejectedValue(new Error('Evaluation failed: t'));

    await failure();

    expect(await keyState()).toBe('failed');
    await expect(withKey()).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_OUTCOME_UNKNOWN' } });
  });

  // whatsapp-web.js can throw after the message is on the wire, so a 409 after that send proves nothing.
  it('keeps the key when the session goes away while a send that failed with No LID for user re-resolves', async () => {
    client.sendMessage.mockRejectedValue(new Error('No LID for user'));
    client.getNumberId
      .mockImplementationOnce((number: string) => Promise.resolve({ _serialized: number }))
      .mockImplementationOnce(() => {
        setStatus(EngineStatus.DISCONNECTED);
        return Promise.resolve({ _serialized: LID });
      });

    const error = await failure(sendText(PHONE));

    expect((error as HttpException).getStatus()).toBe(409);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(await keyState()).toBe('failed');
  });

  it('keeps the key when a forward retried after No LID for user is refused before its second attempt', async () => {
    const forwardCopy = jest.fn().mockRejectedValue(new Error('No LID for user'));
    const source = {
      fetchMessages: jest.fn().mockResolvedValue([{ id: { _serialized: 'SRC1' }, forward: forwardCopy }]),
    };
    let destinationReads = 0;
    const destination = {
      fetchMessages: jest.fn(() => {
        // The second read runs inside the retry, after the first forward attempt.
        if (++destinationReads === 2) setStatus(EngineStatus.DISCONNECTED);
        return Promise.resolve([]);
      }),
    };
    client.getChatById.mockImplementation((id: string) => Promise.resolve(id === GROUP ? source : destination));
    client.getNumberId
      .mockImplementationOnce((number: string) => Promise.resolve({ _serialized: number }))
      .mockImplementationOnce(() => Promise.resolve({ _serialized: LID }));

    const error = await failure(forward());

    expect((error as HttpException).getStatus()).toBe(409);
    expect(forwardCopy).toHaveBeenCalledTimes(1);
    expect(await keyState()).toBe('failed');
  });
});
