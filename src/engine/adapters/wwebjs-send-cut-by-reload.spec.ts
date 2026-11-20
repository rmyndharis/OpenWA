import { EventEmitter } from 'events';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ExecutionContext, HttpException } from '@nestjs/common';
import { from, lastValueFrom } from 'rxjs';
import { WAState } from 'whatsapp-web.js';
import { MessageSendService } from '../../modules/message/message-send.service';
import { Message } from '../../modules/message/entities/message.entity';
import { SessionService } from '../../modules/session/session.service';
import { EngineRegistry } from '../engine-registry.service';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { HookManager } from '../../core/hooks';
import { TemplateService } from '../../modules/template/template.service';
import { SendPacingService, countsTowardSendBreaker, sentNothing } from '../../modules/message/send-pacing.service';
import { SendIdempotencyKey } from '../../modules/message/entities/send-idempotency-key.entity';
import { SendIdempotencyService } from '../../modules/message/idempotency/send-idempotency.service';
import { SendIdempotencyInterceptor } from '../../modules/message/idempotency/send-idempotency.interceptor';
import { StatusService } from '../../modules/status/status.service';
import { StatusStoreService } from '../../modules/status-store/status-store.service';
import { StorageService } from '../../common/storage/storage.service';
import { EnginePageError } from '../../common/errors/engine-page.error';
import { hasUnknownOutcome } from '../../common/errors/engine-not-sent.error';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import { PAGE_RELOADED_DURING_SEND_MESSAGE } from './wwebjs-messaging';
import { CAPTURED_PAGE_ERROR_PREFIX, WwebjsLifecycle } from './wwebjs-lifecycle';

/**
 * A page reload that cuts a whatsapp-web.js send or status post while its attempt runs says nothing about the account,
 * and the message may already be out. It answers the plain 409 that says so, the one the readiness check gives for the
 * same reload one await later: the Idempotency-Key stays taken, a paced send keeps its admission, and the send breaker
 * is not fed. Real services and interceptor on a SQLite store, real adapter and lifecycle with a stand-in page.
 */
describe('a whatsapp-web.js send or status post that a page reload cuts mid-attempt', () => {
  const GROUP = '120363000000000000@g.us';
  const PHONE = '628123456789@c.us';
  const LID = '159442138038327@lid';
  const IN_FLIGHT = 'Execution context was destroyed, most likely because of a navigation.';
  const STATUS_TEXT = /^WhatsApp Web reloaded its page while the status was being posted, and it may or may not/;

  let service: MessageSendService;
  let statuses: StatusService;
  let pacing: { recordSendFailure: jest.Mock; recordSendSuccess: jest.Mock };
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

  beforeEach(async () => {
    process.env.SIMULATE_TYPING = 'false';
    // The lifecycle warns of every navigation it stamps, and the services of every failed send.
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
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
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    const lifecycle = (adapter as unknown as { lifecycle: WwebjsLifecycle }).lifecycle;
    lifecycle.setupEventHandlers();
    lifecycle.attachPuppeteerLifecycleListeners();

    const engines = new EngineRegistry();
    engines.set('sess-1', adapter);
    pacing = { recordSendFailure: jest.fn(), recordSendSuccess: jest.fn() };
    const passThrough = (_event: string, data: unknown) => Promise.resolve({ continue: true, data });
    const hookManager = { execute: jest.fn(passThrough) };
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
          useValue: { assertSendAllowed: jest.fn().mockResolvedValue(jest.fn()), ...pacing },
        },
        { provide: getRepositoryToken(Message, 'data'), useValue: repository },
        { provide: SessionService, useValue: { findOne: jest.fn().mockResolvedValue({ id: 'sess-1' }) } },
        { provide: EngineRegistry, useValue: engines },
        { provide: HookManager, useValue: hookManager },
        { provide: TemplateService, useValue: { resolve: jest.fn() } },
      ],
    }).compile();
    service = module.get(MessageSendService);
    statuses = new StatusService(
      engines,
      hookManager as unknown as HookManager,
      {} as unknown as StatusStoreService,
      {} as unknown as StorageService,
      {
        assertSendAllowed: jest.fn().mockResolvedValue(undefined),
        ...pacing,
      } as unknown as SendPacingService,
    );
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
  const sendText = (extra: Record<string, unknown> = {}): Route => {
    const body = { chatId: GROUP, text: 'hello', ...extra };
    return { name: 'sendText', body, run: () => service.sendText('sess-1', body) };
  };
  const sendImage = (): Route => {
    const body = { chatId: GROUP, base64: 'aGVsbG8=', mimetype: 'image/png' };
    return { name: 'sendImage', body, run: () => service.sendImage('sess-1', body) };
  };
  const reply = (): Route => {
    const body = { chatId: GROUP, quotedMessageId: 'Q1', text: 'hello' };
    return { name: 'reply', body, run: () => service.reply('sess-1', body) };
  };
  const forward = (): Route => {
    const body = { fromChatId: GROUP, toChatId: PHONE, messageId: 'SRC1' };
    return { name: 'forward', body, run: () => service.forward('sess-1', body) };
  };

  const withKey = async (route: Route): Promise<unknown> => {
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
  const failure = (route: Route): Promise<unknown> =>
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
  /** The library call the reload cuts: the page tells of its navigation, then the call dies with `error`. */
  const cutByReload =
    (error: Error = new Error(IN_FLIGHT)) =>
    () => {
      reload();
      return Promise.reject(error);
    };

  /** What a client reads, and what the key, the admission and the breaker keep, for a send the reload cut. */
  const expectOutcomeUnknown = async (error: unknown, route: Route): Promise<void> => {
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(409);
    // No code and no interval: a client is not told to ask again.
    expect((error as HttpException).getResponse()).toEqual({
      statusCode: 409,
      error: 'Conflict',
      message: PAGE_RELOADED_DURING_SEND_MESSAGE,
    });
    expect(hasUnknownOutcome(error)).toBe(true);
    expect(sentNothing(error)).toBe(false);
    expect(countsTowardSendBreaker(error)).toBe(false);
    expect(pacing.recordSendFailure).not.toHaveBeenCalled();
    expect(await keyState()).toBe('failed');
    // The retry with the same key is told the first one may have been sent, where a freed key would send it again.
    await expect(withKey(route)).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_OUTCOME_UNKNOWN' } });
  };

  /** A source chat that holds message `id`, whose `action` is the library call under test. */
  const holding = (id: string, action: Record<string, jest.Mock>) => ({
    fetchMessages: jest.fn().mockResolvedValue([{ id: { _serialized: id }, ...action }]),
  });

  describe('answers the 409 that says it may have gone out', () => {
    it.each([
      ['a text message', () => sendText(), (): jest.Mock => client.sendMessage.mockImplementation(cutByReload())],
      ['an image', () => sendImage(), (): jest.Mock => client.sendMessage.mockImplementation(cutByReload())],
      [
        'a text message held until the new document ran it',
        () => sendText(),
        (): jest.Mock =>
          client.sendMessage.mockImplementation(
            cutByReload(new TypeError("Cannot read properties of undefined (reading 'getChat')")),
          ),
      ],
      [
        'a reply',
        () => reply(),
        (): jest.Mock => {
          const quoted = jest.fn(cutByReload());
          client.getChatById.mockResolvedValue(holding('Q1', { reply: quoted }));
          return quoted;
        },
      ],
      [
        'a forward',
        () => forward(),
        (): jest.Mock => {
          const copy = jest.fn(cutByReload());
          const destination = { fetchMessages: jest.fn().mockResolvedValue([]) };
          client.getChatById.mockImplementation((id: string) =>
            Promise.resolve(id === GROUP ? holding('SRC1', { forward: copy }) : destination),
          );
          return copy;
        },
      ],
    ])('%s', async (_name, route, arrange) => {
      const cut = arrange();
      const keyed = route();

      const error = await failure(keyed);

      await expectOutcomeUnknown(error, keyed);
      expect(cut).toHaveBeenCalledTimes(1);
    });

    it('also when the reload cuts the retry made after No LID for user', async () => {
      client.sendMessage.mockRejectedValueOnce(new Error('No LID for user')).mockImplementationOnce(cutByReload());
      client.getNumberId
        .mockImplementationOnce((number: string) => Promise.resolve({ _serialized: number }))
        .mockImplementationOnce(() => Promise.resolve({ _serialized: LID }));
      const keyed: Route = {
        name: 'sendText',
        body: { chatId: PHONE, text: 'hello' },
        run: () => service.sendText('sess-1', { chatId: PHONE, text: 'hello' }),
      };

      const error = await failure(keyed);

      await expectOutcomeUnknown(error, keyed);
      expect(client.sendMessage).toHaveBeenCalledTimes(2);
    });

    it('before the quote it names is read as missing, since the new document holds no messages', async () => {
      const quoteMissing = new Error('Evaluation failed: Error: Could not get the quoted message.');
      client.sendMessage.mockImplementation(cutByReload(quoteMissing));
      const keyed = sendText({ quotedMessageId: 'Q1' });

      const error = await failure(keyed);

      await expectOutcomeUnknown(error, keyed);
    });

    it.each([
      ['a text status', () => statuses.postTextStatus('sess-1', 'hello', {})],
      ['an image status', () => statuses.postImageStatus('sess-1', { base64: 'aGk=', mimetype: 'image/png' }, {})],
    ])('%s answers a 409 that says it may or may not have been posted, and feeds no breaker', async (_name, post) => {
      client.sendMessage.mockImplementation(cutByReload());

      const error: unknown = await post().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(409);
      expect((error as HttpException).getResponse()).toEqual({
        statusCode: 409,
        error: 'Conflict',
        message: expect.stringMatching(STATUS_TEXT) as unknown,
      });
      expect(hasUnknownOutcome(error)).toBe(true);
      expect(client.sendMessage).toHaveBeenCalledTimes(1);
      expect(pacing.recordSendFailure).not.toHaveBeenCalled();
    });
  });

  describe('keeps the answer of a failure the reload did not cut', () => {
    it('a plain page failure with no reload is an engine error the breaker counts', async () => {
      client.sendMessage.mockRejectedValue(new Error('Evaluation failed: t'));

      const error = await failure(sendText());

      expect(error).not.toBeInstanceOf(HttpException);
      expect(await keyState()).toBe('failed');
      expect(pacing.recordSendFailure).toHaveBeenCalledTimes(1);
    });

    it('a plain status failure with no reload is counted', async () => {
      client.sendMessage.mockRejectedValue(new Error('Evaluation failed: t'));

      const error: unknown = await statuses.postTextStatus('sess-1', 'hello', {}).catch((e: unknown) => e);

      expect(error).not.toBeInstanceOf(HttpException);
      expect(pacing.recordSendFailure).toHaveBeenCalledTimes(1);
    });

    it('a reload that landed before the attempt began is not the cause of its failure', async () => {
      reload();
      client.pupPage.evaluate.mockResolvedValue(true);
      // The re-injected page's ready closes the reload window, so the send is not refused before it runs.
      client.emit('ready');
      client.sendMessage.mockRejectedValue(new Error('Evaluation failed: t'));

      const error = await failure(sendText());

      expect(error).not.toBeInstanceOf(HttpException);
      expect(pacing.recordSendFailure).toHaveBeenCalledTimes(1);
    });

    it('a dead page stays a death, reported and answered as it was', async () => {
      const dead = new Error('Protocol error (Runtime.callFunctionOn): Target closed.');
      const report = jest.spyOn(
        adapter as unknown as { reportIfPageTransportError: () => void },
        'reportIfPageTransportError',
      );
      client.sendMessage.mockImplementation(cutByReload(dead));

      const error = await failure(sendText());

      expect(error).toBe(dead);
      expect(report).toHaveBeenCalledWith(dead, 'sendMessage');
      expect(pacing.recordSendFailure).toHaveBeenCalledTimes(1);
    });

    it('a failure the page captured keeps its reason', async () => {
      const captured = new Error(`${CAPTURED_PAGE_ERROR_PREFIX}{"name":"Error","message":"refused"}`);
      client.sendMessage.mockImplementation(cutByReload(captured));

      const error = await failure(sendText());

      expect(error).toBeInstanceOf(EnginePageError);
      expect(hasUnknownOutcome(error)).toBe(false);
      expect(pacing.recordSendFailure).toHaveBeenCalledTimes(1);
    });

    it('a quote the page cannot resolve is the 404 of a send that left nothing, when no reload cut it', async () => {
      client.sendMessage.mockRejectedValue(new Error('Evaluation failed: Error: Could not get the quoted message.'));

      const error = await failure(sendText({ quotedMessageId: 'Q1' }));

      expect((error as HttpException).getStatus()).toBe(404);
      expect(sentNothing(error)).toBe(true);
      expect(await keyState()).toBe('absent');
      expect(pacing.recordSendFailure).not.toHaveBeenCalled();
    });
  });
});
