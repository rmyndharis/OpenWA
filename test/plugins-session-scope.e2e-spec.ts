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
 * Plugin install/lifecycle routes are deployment-global and their sink is code execution as the
 * OpenWA process user, so a session-restricted key must not reach them. The full session
 * activation replacement (PUT /:id/sessions) is fenced too: it overwrites the ENTIRE active set,
 * so a scoped key could otherwise delete another tenant's activation by sending [] or its own
 * session. The per-session config route (PUT /:id/config/:sessionId) stays reachable for a scoped
 * key — the guard scopes against its :sessionId route param, so it is the only session-dimensioned
 * plugin route and the reason this fence is per-route, not class-level.
 */
describe('Plugin routes reject session-scoped keys (e2e)', () => {
  let app: INestApplication<App>;
  let scopedKey: string; // ADMIN, allowedSessions: [sessA]
  let adminKey: string; // ADMIN, unrestricted
  let sessA: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    applyGlobalValidation(app);
    await app.init();

    const sessionRepo: Repository<Session> = app.get(getRepositoryToken(Session, 'data'));
    const a = await sessionRepo.save(sessionRepo.create({ name: `e2e-plugin-scope-${Date.now()}` }));
    sessA = a.id;

    const authService = app.get(AuthService);
    scopedKey = (
      await authService.createApiKey({ name: 'e2e-plugin-scoped', role: ApiKeyRole.ADMIN, allowedSessions: [sessA] })
    ).rawKey;
    adminKey = (await authService.createApiKey({ name: 'e2e-plugin-admin', role: ApiKeyRole.ADMIN })).rawKey;
  });

  afterAll(async () => {
    try {
      await app?.close();
    } catch {
      /* ignore teardown-only multi-datasource quirk */
    }
  });

  describe('fenced routes', () => {
    it('rejects a scoped ADMIN on GET /api/plugins (cannot enumerate deployment plugins)', async () => {
      await request(app.getHttpServer()).get('/api/plugins').set('X-API-Key', scopedKey).expect(403);
    });

    it('rejects a scoped ADMIN on POST /api/plugins/install-url (cannot install remote code)', async () => {
      await request(app.getHttpServer())
        .post('/api/plugins/install-url')
        .set('X-API-Key', scopedKey)
        .send({ url: 'https://example.invalid/plugin.zip' })
        .expect(403);
    });

    it('rejects a scoped ADMIN on GET /api/plugins/catalog', async () => {
      await request(app.getHttpServer()).get('/api/plugins/catalog').set('X-API-Key', scopedKey).expect(403);
    });

    it('rejects a scoped ADMIN on POST /api/plugins/:id/enable', async () => {
      await request(app.getHttpServer()).post('/api/plugins/any-plugin/enable').set('X-API-Key', scopedKey).expect(403);
    });

    it('rejects a scoped ADMIN on POST /api/plugins/:id/disable', async () => {
      await request(app.getHttpServer())
        .post('/api/plugins/any-plugin/disable')
        .set('X-API-Key', scopedKey)
        .expect(403);
    });

    it('rejects a scoped ADMIN on PUT /api/plugins/:id/config', async () => {
      await request(app.getHttpServer())
        .put('/api/plugins/any-plugin/config')
        .set('X-API-Key', scopedKey)
        .send({ config: {} })
        .expect(403);
    });

    it('rejects a scoped ADMIN on POST /api/plugins/:id/update', async () => {
      await request(app.getHttpServer())
        .post('/api/plugins/any-plugin/update')
        .set('X-API-Key', scopedKey)
        .send({ url: 'https://example.invalid/plugin.zip' })
        .expect(403);
    });

    it('rejects a scoped ADMIN on PUT /api/plugins/:id/sessions (full replacement can delete other tenants)', async () => {
      await request(app.getHttpServer())
        .put('/api/plugins/any-plugin/sessions')
        .set('X-API-Key', scopedKey)
        .send({ sessions: [sessA] })
        .expect(403);
    });

    it('rejects a scoped ADMIN on DELETE /api/plugins/:id', async () => {
      await request(app.getHttpServer()).delete('/api/plugins/any-plugin').set('X-API-Key', scopedKey).expect(403);
    });
  });

  /**
   * Regression guard for the deliberate carve-out. The per-session config route is the only
   * session-dimensioned plugin route: the guard scopes against its :sessionId param, so a scoped
   * key must still reach the handler (a 404 for the absent fixture plugin proves it passed the guard).
   * The full session-replacement route is NOT here — it overwrites the whole active set and now
   * carries @RequireUnscopedKey (see fenced routes above).
   */
  describe('deliberate carve-outs stay reachable for a scoped key', () => {
    it('does not 403 a scoped ADMIN on PUT /api/plugins/:id/config/:sessionId for an in-scope session', async () => {
      const res = await request(app.getHttpServer())
        .put(`/api/plugins/any-plugin/config/${sessA}`)
        .set('X-API-Key', scopedKey)
        .send({ config: {} });
      expect(res.status).not.toBe(403);
    });
  });

  it('lets an unrestricted ADMIN reach the PUT /api/plugins/:id/sessions handler (404 for an absent plugin)', async () => {
    await request(app.getHttpServer())
      .put('/api/plugins/any-plugin/sessions')
      .set('X-API-Key', adminKey)
      .send({ sessions: [sessA] })
      .expect(404);
  });

  it('leaves an unrestricted ADMIN able to list plugins', async () => {
    await request(app.getHttpServer()).get('/api/plugins').set('X-API-Key', adminKey).expect(200);
  });
});
