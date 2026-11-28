import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
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
import { Message } from './../src/modules/message/entities/message.entity';
import { PluginInstance } from './../src/modules/integration/entities/plugin-instance.entity';
import { WebhookOutboxEvent } from './../src/modules/webhook/entities/webhook-outbox-event.entity';
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

  // A client that repeats a keyed send on the 503 (the Go SDK does, with retries on) cannot send it twice: the key is
  // held as possibly sent, as for any failure the gateway cannot prove sent nothing.
  it('answers a keyed send the database refused with 503, and its repeat under the same key with 409', async () => {
    const insert = messages.save.bind(messages);
    jest
      .spyOn(messages, 'save')
      .mockImplementation((...args: Parameters<typeof insert>) =>
        names(sessionId, args[0]) ? Promise.reject(refusedConnection()) : insert(...args),
      );
    const keyed = () => sendText().set('Idempotency-Key', `e2e-db-down-${sessionId}`);

    expect((await keyed().expect(503)).body).toEqual(UNAVAILABLE);
    const repeat = await keyed().expect(409);

    expect((repeat.body as { code?: string }).code).toBe('IDEMPOTENCY_OUTCOME_UNKNOWN');
    expect(engine.sendTextMessage).not.toHaveBeenCalled();
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
});
