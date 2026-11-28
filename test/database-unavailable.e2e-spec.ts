import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { INTERCEPTORS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { DatabaseError } from 'pg';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { applyGlobalValidation } from './../src/config/app-validation';
import { AuthService } from './../src/modules/auth/auth.service';
import { ApiKeyRole } from './../src/modules/auth/entities/api-key.entity';
import { Session } from './../src/modules/session/entities/session.entity';
import { Message, MessageStatus } from './../src/modules/message/entities/message.entity';
import { PluginInstance } from './../src/modules/integration/entities/plugin-instance.entity';
import { WebhookOutboxEvent } from './../src/modules/webhook/entities/webhook-outbox-event.entity';
import { SendIdempotencyKey } from './../src/modules/message/entities/send-idempotency-key.entity';
import { MessageController } from './../src/modules/message/message.controller';
import { SendIdempotencyInterceptor } from './../src/modules/message/idempotency/send-idempotency.interceptor';
import {
  SEND_IDEMPOTENCY_STALE_PENDING_MS,
  SEND_IDEMPOTENCY_TTL_MS,
  SendIdempotencyService,
} from './../src/modules/message/idempotency/send-idempotency.service';
import { SessionOwnershipService } from './../src/modules/session/session-ownership.service';
import { EngineRegistry } from './../src/engine/engine-registry.service';
import type { IWhatsAppEngine } from './../src/engine/interfaces/whatsapp-engine.interface';

/** What pg raises, unwrapped, when the server refuses a new connection (ALTER DATABASE ... ALLOW_CONNECTIONS false). */
const refusedConnection = (): DatabaseError =>
  Object.assign(new DatabaseError('database "openwa" is not currently accepting connections', 118, 'error'), {
    severity: 'FATAL',
    code: '55000',
  });

/** What TypeORM raises when SQLite stays locked past its busy timeout. */
const sqliteLocked = (): QueryFailedError =>
  new QueryFailedError(
    'INSERT INTO "messages" DEFAULT VALUES',
    [],
    Object.assign(new Error('database is locked'), { name: 'SqliteError', code: 'SQLITE_BUSY' }),
  );

/** Whether a call's arguments name the id: the failures below hit this test's session only, not a timer's work. */
const names = (id: string, ...args: unknown[]): boolean => JSON.stringify(args).includes(id);

const UNAVAILABLE = {
  statusCode: 503,
  message:
    'The database could not serve the request; retry later. A write may already have taken effect: check before repeating it.',
  error: 'Service Unavailable',
};
const INTERNAL = { statusCode: 500, message: 'Internal server error' };

/**
 * A request a database cannot serve answers the documented retryable 503, on the real stack: guard, pipes, the send
 * path and Nest's exception handling. Every other failure keeps its answer, and so do the routes that define their own
 * error body.
 */
describe('A database that cannot serve the request (e2e)', () => {
  let app: INestApplication<App>;
  let sessionId: string;
  let operatorKey: string;
  let sessions: Repository<Session>;
  let messages: Repository<Message>;
  const prevSimulateTyping = process.env.SIMULATE_TYPING;

  const engine = { sendTextMessage: jest.fn(), subscribeToPresence: jest.fn() };
  const sent = { id: 'wamid.e2e-db-down', timestamp: 1_706_868_000 };

  const sendText = () =>
    request(app.getHttpServer())
      .post(`/api/sessions/${sessionId}/messages/send-text`)
      .set('X-API-Key', operatorKey)
      .send({ chatId: '628123@c.us', text: 'hello' });

  /** A session this node holds, running `running` as its engine. */
  const runningSession = async (running: Partial<IWhatsAppEngine>): Promise<string> => {
    const id = (await sessions.save(sessions.create({ name: `e2e-db-down-${Date.now()}-${Math.random()}` }))).id;
    app.get(EngineRegistry).set(id, running as IWhatsAppEngine);
    expect(await app.get(SessionOwnershipService).claim(id)).toBe(true);
    return id;
  };

  /** The status write of the session fails as a refused connection; its other writes (the stop record) go through. */
  const refuseStatusWrite = (id: string) => {
    const update = sessions.update.bind(sessions);
    return jest
      .spyOn(sessions, 'update')
      .mockImplementation((criteria, partial) =>
        'status' in partial && names(id, criteria) ? Promise.reject(refusedConnection()) : update(criteria, partial),
      );
  };

  const lifecycle = (id: string, verb: string) =>
    request(app.getHttpServer()).post(`/api/sessions/${id}/${verb}`).set('X-API-Key', operatorKey);

  beforeAll(async () => {
    process.env.SIMULATE_TYPING = 'false';
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    applyGlobalValidation(app);
    await app.init();

    sessions = app.get(getRepositoryToken(Session, 'data'));
    messages = app.get(getRepositoryToken(Message, 'data'));
    sessionId = (await sessions.save(sessions.create({ name: `e2e-db-down-${Date.now()}` }))).id;
    app.get(EngineRegistry).set(sessionId, engine as unknown as IWhatsAppEngine);
    expect(await app.get(SessionOwnershipService).claim(sessionId)).toBe(true);
    operatorKey = (await app.get(AuthService).createApiKey({ name: 'e2e-db-down', role: ApiKeyRole.OPERATOR })).rawKey;
  });

  afterAll(async () => {
    process.env.SIMULATE_TYPING = prevSimulateTyping;
    await app?.close();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    engine.sendTextMessage.mockReset();
    engine.subscribeToPresence.mockReset();
  });

  it('answers 503 to a send whose pending row PostgreSQL refused to connect for, and sends nothing', async () => {
    const insert = messages.save.bind(messages);
    const save = jest
      .spyOn(messages, 'save')
      .mockImplementation((...args: Parameters<typeof insert>) =>
        names(sessionId, args[0]) ? Promise.reject(refusedConnection()) : insert(...args),
      );

    const res = await sendText().expect(503);

    expect(res.body).toEqual(UNAVAILABLE);
    expect(save).toHaveBeenCalled();
    expect(engine.sendTextMessage).not.toHaveBeenCalled();
  });

  it('answers 503 to a send whose pending row a locked SQLite refused', async () => {
    const insert = messages.save.bind(messages);
    const save = jest
      .spyOn(messages, 'save')
      .mockImplementation((...args: Parameters<typeof insert>) =>
        names(sessionId, args[0]) ? Promise.reject(sqliteLocked()) : insert(...args),
      );

    const res = await sendText().expect(503);

    expect(res.body).toEqual(UNAVAILABLE);
    expect(save).toHaveBeenCalled();
  });

  // The retry a 503 invites (the Go SDK makes it by itself, with retries on): a send that never reached the engine frees
  // its key, so the repeat sends the message, once.
  it('frees the key of a keyed send the database refused before the engine, so its repeat sends once', async () => {
    const insert = messages.save.bind(messages);
    let refuse = true;
    jest.spyOn(messages, 'save').mockImplementation((...args: Parameters<typeof insert>) => {
      if (!refuse || !names(sessionId, args[0])) return insert(...args);
      refuse = false;
      return Promise.reject(refusedConnection());
    });
    engine.sendTextMessage.mockResolvedValue(sent);
    const keyed = () => sendText().set('Idempotency-Key', `e2e-db-down-once-${sessionId}`);

    expect((await keyed().expect(503)).body).toEqual(UNAVAILABLE);
    expect((await keyed().expect(201)).body).toEqual({ messageId: sent.id, timestamp: sent.timestamp });
    expect(engine.sendTextMessage).toHaveBeenCalledTimes(1);
  });

  // When the database also refuses to free the key, the claim says the send never reached the engine: past the stale
  // window it is taken over, where a claim handed to the engine reads as possibly sent.
  it('does not hold the key for good when the database refused to free it too', async () => {
    const key = `e2e-db-down-release-${sessionId}`;
    const keys = app.get<Repository<SendIdempotencyKey>>(getRepositoryToken(SendIdempotencyKey, 'data'));
    const insert = messages.save.bind(messages);
    let refuse = true;
    jest.spyOn(messages, 'save').mockImplementation((...args: Parameters<typeof insert>) => {
      if (!refuse || !names(sessionId, args[0])) return insert(...args);
      refuse = false;
      return Promise.reject(refusedConnection());
    });
    const remove = keys.delete.bind(keys);
    jest
      .spyOn(keys, 'delete')
      .mockImplementationOnce(() => Promise.reject(refusedConnection()))
      .mockImplementation(criteria => remove(criteria));
    engine.sendTextMessage.mockResolvedValue(sent);
    const keyed = () => sendText().set('Idempotency-Key', key);

    expect((await keyed().expect(503)).body).toEqual(UNAVAILABLE);
    expect(((await keyed().expect(409)).body as { code?: string }).code).toBe('IDEMPOTENCY_KEY_IN_PROGRESS');
    // The claim time is read back from expiresAt.
    const claimedLongAgo = Date.now() - SEND_IDEMPOTENCY_STALE_PENDING_MS - 1000;
    await keys.update(
      { sessionId, idempotencyKey: key },
      { expiresAt: new Date(claimedLongAgo + SEND_IDEMPOTENCY_TTL_MS) },
    );
    expect((await keyed().expect(201)).body).toEqual({ messageId: sent.id, timestamp: sent.timestamp });
    expect(engine.sendTextMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps the 500 of a send whose engine call failed before the database did', async () => {
    engine.sendTextMessage.mockRejectedValueOnce(new Error('the engine failed'));
    const write = messages.update.bind(messages);
    const update = jest
      .spyOn(messages, 'update')
      .mockImplementation((criteria, partial) =>
        names(sessionId, criteria) ? Promise.reject(refusedConnection()) : write(criteria, partial),
      );

    const res = await sendText().expect(500);

    expect(res.body).toEqual(INTERNAL);
    expect(engine.sendTextMessage).toHaveBeenCalled();
    expect(update).toHaveBeenCalled();
  });

  it('keeps the 500 of an engine error whose text names a closed connection', async () => {
    engine.subscribeToPresence.mockRejectedValueOnce(new Error('Connection Closed'));

    const res = await request(app.getHttpServer())
      .post(`/api/sessions/${sessionId}/presence/subscribe`)
      .set('X-API-Key', operatorKey)
      .send({ chatId: '628123@c.us' })
      .expect(500);

    expect(res.body).toEqual(INTERNAL);
    expect(engine.subscribeToPresence).toHaveBeenCalled();
  });

  // Each of these routes answers its own 503 for a database that failed before anything was taken down, saying so.
  // One that fails after the teardown has acted, and keeps the 500 it answered before.
  it('keeps the 500 of a stop whose status write failed after the engine was torn down', async () => {
    const running = { disconnect: jest.fn().mockResolvedValue(undefined) };
    const id = await runningSession(running);
    refuseStatusWrite(id);

    const res = await lifecycle(id, 'stop').expect(500);

    expect(res.body).toEqual(INTERNAL);
    expect(running.disconnect).toHaveBeenCalled();
  });

  it('keeps the 500 of a logout whose status write failed after the device was unlinked', async () => {
    const running = { logout: jest.fn().mockResolvedValue(undefined) };
    const id = await runningSession(running);
    refuseStatusWrite(id);

    const res = await lifecycle(id, 'logout').expect(500);

    expect(res.body).toEqual(INTERNAL);
    expect(running.logout).toHaveBeenCalled();
  });

  it('keeps the 500 of a force-kill whose status write failed after the engine was killed', async () => {
    const running = { forceDestroy: jest.fn().mockResolvedValue(undefined) };
    const id = await runningSession(running);
    refuseStatusWrite(id);

    const res = await lifecycle(id, 'force-kill').expect(500);

    expect(res.body).toEqual(INTERNAL);
    expect(running.forceDestroy).toHaveBeenCalled();
  });

  it('keeps the 500 of a delete whose row removal failed after the engine was torn down', async () => {
    const running = { forceDestroy: jest.fn().mockResolvedValue(undefined) };
    const id = await runningSession(running);
    const outbox = app.get<Repository<WebhookOutboxEvent>>(getRepositoryToken(WebhookOutboxEvent, 'data'));
    const read = outbox.find.bind(outbox);
    const find = jest
      .spyOn(outbox, 'find')
      .mockImplementation(options => (names(id, options) ? Promise.reject(refusedConnection()) : read(options)));

    const res = await request(app.getHttpServer())
      .delete(`/api/sessions/${id}`)
      .set('X-API-Key', operatorKey)
      .expect(500);

    expect(res.body).toEqual(INTERNAL);
    expect(running.forceDestroy).toHaveBeenCalled();
    expect(find).toHaveBeenCalled();
  });

  it('keeps the readiness probe its own 503 body when the data database refuses the connection', async () => {
    const dataSource = app.get<DataSource>(getDataSourceToken('data'));
    const run = dataSource.query.bind(dataSource);
    const query = jest
      .spyOn(dataSource, 'query')
      .mockImplementation((sql: string, ...rest: unknown[]) =>
        sql === 'SELECT 1' ? Promise.reject(refusedConnection()) : run(sql, ...(rest as [])),
      );

    const res = await request(app.getHttpServer()).get('/api/health/ready').expect(503);

    expect(res.body).toEqual({
      status: 'error',
      details: { mainDatabase: { status: 'up' }, dataDatabase: { status: 'down' } },
    });
    expect(query).toHaveBeenCalledWith('SELECT 1');
  });

  it('keeps the ingress answering a database failure with the 500 it answered before', async () => {
    const instances = app.get<Repository<PluginInstance>>(getRepositoryToken(PluginInstance, 'data'));
    const read = instances.findOne.bind(instances);
    const findOne = jest
      .spyOn(instances, 'findOne')
      .mockImplementation(options =>
        names('some-plugin:some-instance', options) ? Promise.reject(refusedConnection()) : read(options),
      );

    const res = await request(app.getHttpServer())
      .post('/api/ingress/some-plugin/some-instance/hook')
      .send({ event: 'ping' })
      .expect(500);

    expect(res.body).toEqual(INTERNAL);
    expect(findOne).toHaveBeenCalled();
  });

  // The hand-over write is the last before the engine: refused, the send stops there, sent nothing, and frees the key.
  it('stops a keyed send whose hand-over the database refused, and lets its repeat send once', async () => {
    const key = `e2e-db-down-hand-over-${sessionId}`;
    const keys = app.get<Repository<SendIdempotencyKey>>(getRepositoryToken(SendIdempotencyKey, 'data'));
    const write = keys.update.bind(keys);
    let refuse = true;
    const update = jest.spyOn(keys, 'update').mockImplementation((criteria, partial) => {
      if (!refuse || (partial as { state?: string }).state !== 'pending') return write(criteria, partial);
      refuse = false;
      return Promise.reject(refusedConnection());
    });
    // The release is refused too, until the claim is made stale below.
    const remove = keys.delete.bind(keys);
    let away = true;
    jest
      .spyOn(keys, 'delete')
      .mockImplementation(criteria => (away ? Promise.reject(refusedConnection()) : remove(criteria)));
    engine.sendTextMessage.mockResolvedValue(sent);
    const keyed = () => sendText().set('Idempotency-Key', key);

    expect((await keyed().expect(503)).body).toEqual(UNAVAILABLE);
    expect(engine.sendTextMessage).not.toHaveBeenCalled();
    expect(((await keyed().expect(409)).body as { code?: string }).code).toBe('IDEMPOTENCY_KEY_IN_PROGRESS');
    away = false;
    const claimedLongAgo = Date.now() - SEND_IDEMPOTENCY_STALE_PENDING_MS - 1000;
    update.mockRestore();
    await keys.update(
      { sessionId, idempotencyKey: key },
      { expiresAt: new Date(claimedLongAgo + SEND_IDEMPOTENCY_TTL_MS) },
    );
    expect((await keyed().expect(201)).body).toEqual({ messageId: sent.id, timestamp: sent.timestamp });
    expect(engine.sendTextMessage).toHaveBeenCalledTimes(1);
  });

  // A send held past the stale window before its hand-over loses its claim to the repeat, which sends the message.
  it('fails at once the row of a keyed send whose claim another request took over', async () => {
    const running = { sendTextMessage: jest.fn().mockResolvedValue(sent), subscribeToPresence: jest.fn() };
    const id = await runningSession(running);
    const key = `e2e-db-down-taken-over-${id}`;
    const store = app.get(SendIdempotencyService);
    const keys = app.get<Repository<SendIdempotencyKey>>(getRepositoryToken(SendIdempotencyKey, 'data'));
    const handOver = store.handOver.bind(store);
    let held!: () => void;
    const holding = new Promise<void>(resolve => (held = resolve));
    let resume!: () => void;
    const resumed = new Promise<void>(resolve => (resume = resolve));
    jest.spyOn(store, 'handOver').mockImplementationOnce(async claim => {
      held();
      await resumed;
      return handOver(claim);
    });
    const keyed = () =>
      request(app.getHttpServer())
        .post(`/api/sessions/${id}/messages/send-text`)
        .set('X-API-Key', operatorKey)
        .set('Idempotency-Key', key)
        .send({ chatId: '628123@c.us', text: 'hello' });

    const first = keyed().then(res => res);
    await holding;
    const claimedLongAgo = Date.now() - SEND_IDEMPOTENCY_STALE_PENDING_MS - 1000;
    await keys.update(
      { sessionId: id, idempotencyKey: key },
      { expiresAt: new Date(claimedLongAgo + SEND_IDEMPOTENCY_TTL_MS) },
    );
    expect((await keyed().expect(201)).body).toEqual({ messageId: sent.id, timestamp: sent.timestamp });
    resume();
    const refused = await first;

    expect(refused.status).toBe(409);
    expect((refused.body as { message?: string }).message).toContain('took over');
    expect(running.sendTextMessage).toHaveBeenCalledTimes(1);
    const rows = await messages.find({ where: { sessionId: id } });
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.waMessageId === sent.id)?.status).toBe(MessageStatus.SENT);
    expect(rows.find(row => row.waMessageId !== sent.id)?.status).toBe(MessageStatus.FAILED);
  });

  describe('every keyed send route', () => {
    const routes: Array<[string, Record<string, unknown>, keyof typeof keyedEngine]> = [
      ['send-text', { chatId: '628123@c.us', text: 'hello' }, 'sendTextMessage'],
      ['send-template', { chatId: '628123@c.us', templateName: 'e2e-db-down-greet' }, 'sendTextMessage'],
      ['send-image', { chatId: '628123@c.us', base64: 'R0lGODlh', mimetype: 'image/gif' }, 'sendImageMessage'],
      ['send-video', { chatId: '628123@c.us', base64: 'ZmFrZQ==', mimetype: 'video/mp4' }, 'sendVideoMessage'],
      ['send-audio', { chatId: '628123@c.us', base64: 'ZmFrZQ==', mimetype: 'audio/ogg' }, 'sendAudioMessage'],
      [
        'send-document',
        { chatId: '628123@c.us', base64: 'ZmFrZQ==', mimetype: 'application/pdf', filename: 'a.pdf' },
        'sendDocumentMessage',
      ],
      ['send-location', { chatId: '628123@c.us', latitude: -6.2, longitude: 106.8 }, 'sendLocationMessage'],
      ['send-contact', { chatId: '628123@c.us', contactName: 'Ada', contactNumber: '628456' }, 'sendContactMessage'],
      ['send-sticker', { chatId: '628123@c.us', base64: 'ZmFrZQ==', mimetype: 'image/webp' }, 'sendStickerMessage'],
      ['send-poll', { chatId: '628123@c.us', name: 'Lunch?', options: ['A', 'B'] }, 'sendPollMessage'],
      ['reply', { chatId: '628123@c.us', quotedMessageId: 'wamid.quoted.1', text: 'hi' }, 'replyToMessage'],
      ['forward', { fromChatId: '628123@c.us', toChatId: '628999@c.us', messageId: 'wamid.src.1' }, 'forwardMessage'],
      ['click-button', { chatId: '628123@c.us', messageId: 'wamid.buttons.1', buttonId: 'b1' }, 'clickButton'],
    ];
    const keyedEngine = {
      sendTextMessage: jest.fn(),
      sendImageMessage: jest.fn(),
      sendVideoMessage: jest.fn(),
      sendAudioMessage: jest.fn(),
      sendDocumentMessage: jest.fn(),
      sendLocationMessage: jest.fn(),
      sendContactMessage: jest.fn(),
      sendStickerMessage: jest.fn(),
      sendPollMessage: jest.fn(),
      replyToMessage: jest.fn(),
      forwardMessage: jest.fn(),
      clickButton: jest.fn(),
    };
    let keyedSession: string;

    beforeAll(async () => {
      keyedSession = (await sessions.save(sessions.create({ name: `e2e-db-down-keyed-${Date.now()}` }))).id;
      app.get(EngineRegistry).set(keyedSession, keyedEngine as unknown as IWhatsAppEngine);
      expect(await app.get(SessionOwnershipService).claim(keyedSession)).toBe(true);
      await request(app.getHttpServer())
        .post(`/api/sessions/${keyedSession}/templates`)
        .set('X-API-Key', operatorKey)
        .send({ name: 'e2e-db-down-greet', body: 'Hello' })
        .expect(201);
    });

    // A claim not handed over is freed once stale, so a route that reached the engine without saying so could send twice.
    it.each(routes)('%s records the hand-over on its claim before the engine sends', async (route, body, method) => {
      const order: string[] = [];
      const store = app.get(SendIdempotencyService);
      const handOver = store.handOver.bind(store);
      jest.spyOn(store, 'handOver').mockImplementation(id => (order.push('hand-over'), handOver(id)));
      keyedEngine[method].mockImplementationOnce(() => (order.push('engine'), Promise.resolve(sent)));

      await request(app.getHttpServer())
        .post(`/api/sessions/${keyedSession}/messages/${route}`)
        .set('X-API-Key', operatorKey)
        .set('Idempotency-Key', `e2e-db-down-${route}`)
        .send(body)
        .expect(201);

      expect(order).toEqual(['hand-over', 'engine']);
    });

    it('names every route that takes an Idempotency-Key', () => {
      const prototype = MessageController.prototype as unknown as Record<string, unknown>;
      const keyed = Object.getOwnPropertyNames(prototype)
        .map(name => prototype[name])
        .filter(
          (handler): handler is object =>
            typeof handler === 'function' &&
            ((Reflect.getMetadata(INTERCEPTORS_METADATA, handler) as unknown[] | undefined) ?? []).includes(
              SendIdempotencyInterceptor,
            ),
        )
        .map(handler => Reflect.getMetadata(PATH_METADATA, handler) as string);

      expect(keyed.sort()).toEqual(routes.map(([route]) => route).sort());
    });
  });
});
