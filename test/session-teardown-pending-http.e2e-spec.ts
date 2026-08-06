// archiver v8 is ESM-only (pulled in transitively via @Global StorageModule); stub for ts-jest CJS.
jest.mock('archiver', () => ({ TarArchive: jest.fn() }));

import { ConflictException, HttpStatus, INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { applyGlobalValidation } from './../src/config/app-validation';
import { AuthService } from './../src/modules/auth/auth.service';
import { ApiKeyRole } from './../src/modules/auth/entities/api-key.entity';
import { SessionService } from './../src/modules/session/session.service';

/**
 * Task 5 follow-up (Minor M2): the existing logout-teardown-race.spec.ts asserts the thrown object's
 * `.getResponse()` at the SERVICE layer, but NOTHING asserted the `code: 'SESSION_NAME_TEARDOWN_PENDING'`
 * field survives Nest's default exception-filter serialization and reaches the JSON body a real REST
 * caller sees. That serialization relies on Nest's standard handling of an object-response HttpException,
 * which is correct-but-unverified for THIS code path.
 *
 * Driven through the real HTTP stack (AppModule + applyGlobalValidation, the exact production bootstrap)
 * with NO custom exception filter registered, so the object-response ConflictException that
 * `SessionEngineLifecycle.awaitPendingTeardown()` throws is serialized by Nest's default filter — proving the
 * stable `code` field reaches the response body unchanged. The service is overridden to throw the exact
 * ConflictException shape the source constructs, so this exercises the real Nest serialization path
 * (controller + DI + filter) rather than re-running the 10s bounded-wait (which needs fake timers and
 * would fight supertest's socket handling in an e2e boot).
 */
describe('Session name-scoped teardown fence: 409 code survives HTTP serialization (e2e)', () => {
  let app: INestApplication<App>;
  let adminKey: string;
  let sessionId: string;

  beforeAll(async () => {
    // The exact object-response ConflictException the service throws on a name-scoped teardown still
    // pending past its 10s fail-closed bound — constructed once and returned by both overridden handlers
    // so this asserts the same shape that production code emits, not a hand-rolled approximation.
    const teardownPending = new ConflictException({
      statusCode: HttpStatus.CONFLICT,
      message:
        `A credential teardown for session 'teardown-pending' is still in flight. Wait for it to ` +
        'settle and retry.',
      error: 'Conflict',
      code: 'SESSION_NAME_TEARDOWN_PENDING',
    });

    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SessionService)
      .useValue({
        // Both start() and delete() call awaitPendingTeardown(session.name) before any lifecycle mutation;
        // a still-pending teardown makes the first fence throw this ConflictException.
        start: jest.fn().mockRejectedValue(teardownPending),
        delete: jest.fn().mockRejectedValue(teardownPending),
        // findOne() is called by the controller before start()/delete(); return a minimal session so the
        // route reaches the service method under test (delete() also calls findOne() itself).
        findOne: jest.fn().mockResolvedValue({
          id: 'sess-teardown-pending',
          name: 'teardown-pending',
        }),
      })
      .compile();
    app = moduleRef.createNestApplication();
    applyGlobalValidation(app);
    await app.init();

    const authService = app.get(AuthService);
    adminKey = (await authService.createApiKey({ name: 'e2e-teardown-admin', role: ApiKeyRole.ADMIN })).rawKey;
    // A ParseUUIDPipe-valid session id for the route param; the overridden findOne() ignores it but the
    // pipe still validates the shape before the handler runs.
    sessionId = '00000000-0000-4000-8000-000000000000';
  });

  afterAll(async () => {
    try {
      await app?.close();
    } catch {
      /* ignore teardown-only multi-datasource quirk */
    }
  });

  it('DELETE /api/sessions/:id serializes the teardown-pending 409 with the code field in the body', async () => {
    const res = await request(app.getHttpServer()).delete(`/api/sessions/${sessionId}`).set('X-API-Key', adminKey);

    expect(res.status).toBe(409);
    // The load-bearing assertion: the stable machine-readable code Nest's default filter copies from the
    // object-response ConflictException survives into the REST caller's JSON body.
    expect(res.body).toMatchObject({
      statusCode: 409,
      error: 'Conflict',
      code: 'SESSION_NAME_TEARDOWN_PENDING',
    });
    // Message is a nested object on Nest's serialized body; assert it without an unsafe `any` access.
    expect((res.body as { message: unknown }).message).toEqual(expect.stringContaining('still in flight'));
  });

  it('POST /api/sessions/:id/start serializes the teardown-pending 409 with the code field in the body', async () => {
    const res = await request(app.getHttpServer()).post(`/api/sessions/${sessionId}/start`).set('X-API-Key', adminKey);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      statusCode: 409,
      error: 'Conflict',
      code: 'SESSION_NAME_TEARDOWN_PENDING',
    });
  });
});
