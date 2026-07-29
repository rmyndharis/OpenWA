// archiver v8 is ESM-only (pulled in transitively via @Global StorageModule); stub for ts-jest CJS.
jest.mock('archiver', () => ({ TarArchive: jest.fn() }));

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { applyGlobalValidation } from './../src/config/app-validation';
import { AuthService } from './../src/modules/auth/auth.service';
import { ApiKeyRole } from './../src/modules/auth/entities/api-key.entity';
import { Session } from './../src/modules/session/entities/session.entity';

/**
 * Cross-session aggregates, environment-derived settings, and session creation all act outside any
 * single session, so the guard's route-param fence cannot scope them. A key restricted to specific
 * sessions must not read deployment-wide activity, read server configuration, or create sessions
 * outside its own allowlist.
 */
describe('Global read and create routes reject session-scoped keys (e2e)', () => {
  let app: INestApplication<App>;
  let scopedAdminKey: string; // ADMIN, allowedSessions: [sessA]
  let scopedOperatorKey: string; // OPERATOR, allowedSessions: [sessA]
  let adminKey: string; // ADMIN, unrestricted
  let scopedSessionId: string; // the session the scoped keys are confined to

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    applyGlobalValidation(app);
    await app.init();

    const sessionRepo: Repository<Session> = app.get(getRepositoryToken(Session, 'data'));
    const a = await sessionRepo.save(sessionRepo.create({ name: `e2e-global-scope-${Date.now()}` }));
    scopedSessionId = a.id;

    const authService = app.get(AuthService);
    scopedAdminKey = (
      await authService.createApiKey({ name: 'e2e-global-scoped', role: ApiKeyRole.ADMIN, allowedSessions: [a.id] })
    ).rawKey;
    scopedOperatorKey = (
      await authService.createApiKey({ name: 'e2e-global-op', role: ApiKeyRole.OPERATOR, allowedSessions: [a.id] })
    ).rawKey;
    adminKey = (await authService.createApiKey({ name: 'e2e-global-admin', role: ApiKeyRole.ADMIN })).rawKey;
  });

  afterAll(async () => {
    try {
      await app?.close();
    } catch {
      /* ignore teardown-only multi-datasource quirk */
    }
  });

  it('rejects a scoped ADMIN on GET /api/stats/overview', async () => {
    await request(app.getHttpServer()).get('/api/stats/overview').set('X-API-Key', scopedAdminKey).expect(403);
  });

  it('rejects a scoped ADMIN on GET /api/stats/messages', async () => {
    await request(app.getHttpServer()).get('/api/stats/messages').set('X-API-Key', scopedAdminKey).expect(403);
  });

  it('rejects a scoped ADMIN on GET /api/settings', async () => {
    await request(app.getHttpServer()).get('/api/settings').set('X-API-Key', scopedAdminKey).expect(403);
  });

  it('rejects a scoped ADMIN on POST /api/sessions', async () => {
    await request(app.getHttpServer())
      .post('/api/sessions')
      .set('X-API-Key', scopedAdminKey)
      .send({ name: `e2e-escape-admin-${Date.now()}` })
      .expect(403);
  });

  it('rejects a scoped OPERATOR on POST /api/sessions (cannot create outside its allowlist)', async () => {
    await request(app.getHttpServer())
      .post('/api/sessions')
      .set('X-API-Key', scopedOperatorKey)
      .send({ name: `e2e-escape-operator-${Date.now()}` })
      .expect(403);
  });

  it('lets an unrestricted key reach the global stats overview', async () => {
    // Control: the fence rejects scoped keys on this route but must not hinder an unrestricted one.
    const res = await request(app.getHttpServer()).get('/api/stats/overview').set('X-API-Key', adminKey);
    expect(res.status).toBe(200);
  });

  it('lets a session-scoped key reach per-session stats for its own session', async () => {
    // The per-session route carries no fence — its :sessionId route param is the scope. Pin that the
    // global-route fencing above does not over-reach onto it.
    const res = await request(app.getHttpServer())
      .get(`/api/stats/sessions/${scopedSessionId}`)
      .set('X-API-Key', scopedAdminKey);
    expect(res.status).toBe(200);
  });

  it('denies a session-scoped key per-session stats for a session outside its scope', async () => {
    // The param-scope check surfaces as 401 (the key is not authorized for that session) — a
    // different code path than the fence's 403 above, pinned here so the two are not conflated.
    const sessionRepo: Repository<Session> = app.get(getRepositoryToken(Session, 'data'));
    const other = await sessionRepo.save(sessionRepo.create({ name: `e2e-global-scope-other-${Date.now()}` }));
    await request(app.getHttpServer())
      .get(`/api/stats/sessions/${other.id}`)
      .set('X-API-Key', scopedAdminKey)
      .expect(401);
  });

  it('leaves an unrestricted ADMIN able to create a session', async () => {
    await request(app.getHttpServer())
      .post('/api/sessions')
      .set('X-API-Key', adminKey)
      .send({ name: `e2e-global-ok-${Date.now()}` })
      .expect(201);
  });
});
