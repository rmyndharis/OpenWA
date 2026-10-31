import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { configureApp } from './../src/configure-app';
import { applyGlobalValidation } from './../src/config/app-validation';
import { AuthService } from './../src/modules/auth/auth.service';
import { ApiKeyRole } from './../src/modules/auth/entities/api-key.entity';
import { Session } from './../src/modules/session/entities/session.entity';
import { EngineRegistry } from './../src/engine/engine-registry.service';
import type { IWhatsAppEngine, MessageResult } from './../src/engine/interfaces/whatsapp-engine.interface';

/**
 * A send that carries an Idempotency-Key is fingerprinted by an interceptor that walks the whole body, and
 * that runs BEFORE the validation pipe, so a guard inside the pipe cannot protect it: the stack overflowed in
 * the interceptor and the request answered 500. The nesting bound therefore sits right after the body parsers
 * in configureApp. This runs the real application behind it, with a fake engine registered for one session.
 */
describe('Request body nesting bound over the real application (e2e)', () => {
  let app: INestApplication<App>;
  let sessionId: string;
  let operatorKey: string;
  const prevSimulateTyping = process.env.SIMULATE_TYPING;

  const result: MessageResult = { id: 'wamid.e2e-nesting', timestamp: 1_706_868_000 };
  const engine = { sendTextMessage: jest.fn().mockResolvedValue(result) };

  const sendText = (body: string, idempotencyKey?: string) => {
    const req = request(app.getHttpServer())
      .post(`/api/sessions/${sessionId}/messages/send-text`)
      .set('X-API-Key', operatorKey)
      .type('json');
    return (idempotencyKey ? req.set('Idempotency-Key', idempotencyKey) : req).send(body);
  };
  const deepMentions = `{"chatId":"628123@c.us","text":"hi","mentions":${'['.repeat(5000)}${']'.repeat(5000)}}`;

  beforeAll(async () => {
    process.env.SIMULATE_TYPING = 'false';
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    // `bodyParser: false` matches main.ts: configureApp installs the only parsers.
    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    applyGlobalValidation(app);
    await app.init();

    const sessionRepo: Repository<Session> = app.get(getRepositoryToken(Session, 'data'));
    sessionId = (await sessionRepo.save(sessionRepo.create({ name: `e2e-nesting-${Date.now()}` }))).id;
    app.get(EngineRegistry).set(sessionId, engine as unknown as IWhatsAppEngine);
    operatorKey = (await app.get(AuthService).createApiKey({ name: 'e2e-nesting', role: ApiKeyRole.OPERATOR })).rawKey;
  });

  afterAll(async () => {
    process.env.SIMULATE_TYPING = prevSimulateTyping;
    try {
      await app?.close();
    } catch {
      /* ignore teardown-only multi-datasource quirk */
    }
  });

  beforeEach(() => jest.clearAllMocks());

  it('sends normally with an Idempotency-Key, so the interceptor path under test is live', async () => {
    await sendText('{"chatId":"628123@c.us","text":"hello"}', 'nesting-control-1').expect(201);
    expect(engine.sendTextMessage).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['with an Idempotency-Key', 'nesting-deep-1'],
    ['without one', undefined],
  ])('refuses a body nested thousands of levels deep with 400, %s', async (_label, key) => {
    const res = await sendText(deepMentions, key);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
    expect(engine.sendTextMessage).not.toHaveBeenCalled();
  });
});
