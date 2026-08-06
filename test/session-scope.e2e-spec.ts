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
import { ApiKey, ApiKeyRole } from './../src/modules/auth/entities/api-key.entity';
import { Session } from './../src/modules/session/entities/session.entity';
import { AuditLog, AuditAction, AuditSeverity } from './../src/modules/audit/entities/audit-log.entity';
import { WebhookDeliveryFailure } from './../src/modules/webhook/entities/webhook-delivery-failure.entity';

/**
 * End-to-end proof that GET /api/audit and GET /api/webhooks/delivery-failures — which take sessionId
 * as a QUERY param, outside the ApiKeyGuard's route-param session fence — are scoped to the calling
 * key's allowedSessions. Exercised through the real HTTP stack (guard + @CurrentApiKey + DI + routing),
 * which the unit specs mock away: a session-restricted ADMIN key must never read another session's rows.
 */
describe('Session-scoped query endpoints (e2e)', () => {
  let app: INestApplication<App>;
  let sessA: string;
  let sessB: string;
  let scopedKey: string; // ADMIN, allowedSessions: [sessA]
  let adminKey: string; // ADMIN, unrestricted
  let throwawayId: string; // a VIEWER key used as the :id target for key-management routes
  let auditRepo: Repository<AuditLog>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    applyGlobalValidation(app);
    await app.init();

    const sessionRepo: Repository<Session> = app.get(getRepositoryToken(Session, 'data'));
    auditRepo = app.get(getRepositoryToken(AuditLog, 'main'));
    const failureRepo: Repository<WebhookDeliveryFailure> = app.get(getRepositoryToken(WebhookDeliveryFailure, 'data'));

    const a = await sessionRepo.save(sessionRepo.create({ name: `e2e-scope-a-${Date.now()}` }));
    const b = await sessionRepo.save(sessionRepo.create({ name: `e2e-scope-b-${Date.now()}` }));
    sessA = a.id;
    sessB = b.id;

    // One audit row and one delivery-failure row per session, so a cross-tenant read has something to leak.
    for (const sessionId of [sessA, sessB]) {
      await auditRepo.save(
        auditRepo.create({ action: AuditAction.SESSION_CREATED, severity: AuditSeverity.INFO, sessionId }),
      );
      await failureRepo.save(
        failureRepo.create({
          webhookId: `wh-${sessionId}`,
          sessionId,
          event: 'message.received',
          url: `https://${sessionId}.example/hook`,
          attempts: 3,
          lastError: 'ECONNREFUSED',
        }),
      );
    }

    const authService = app.get(AuthService);
    scopedKey = (
      await authService.createApiKey({ name: 'e2e-scoped', role: ApiKeyRole.ADMIN, allowedSessions: [sessA] })
    ).rawKey;
    adminKey = (await authService.createApiKey({ name: 'e2e-admin', role: ApiKeyRole.ADMIN })).rawKey;
    throwawayId = (await authService.createApiKey({ name: 'e2e-throwaway', role: ApiKeyRole.VIEWER })).apiKey.id;
  });

  afterAll(async () => {
    try {
      await app?.close();
    } catch {
      /* ignore teardown-only multi-datasource quirk */
    }
  });

  describe('GET /api/audit', () => {
    it('a key scoped to sessA sees sessA rows but never sessB (no sessionId param => no cross-tenant leak)', async () => {
      const res = await request(app.getHttpServer()).get('/api/audit').set('X-API-Key', scopedKey).expect(200);
      const body = res.body as { data: AuditLog[]; total: number };
      const sessions = body.data.map(r => r.sessionId);
      expect(sessions).toContain(sessA);
      expect(sessions).not.toContain(sessB);
    });

    it('a scoped key requesting sessB via query param gets nothing (cannot broaden its scope)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/audit')
        .query({ sessionId: sessB })
        .set('X-API-Key', scopedKey)
        .expect(200);
      const body = res.body as { data: AuditLog[]; total: number };
      expect(body.data).toEqual([]);
      expect(body.total).toBe(0);
    });

    it('an unrestricted ADMIN key still sees both sessions', async () => {
      const res = await request(app.getHttpServer()).get('/api/audit').set('X-API-Key', adminKey).expect(200);
      const body = res.body as { data: AuditLog[]; total: number };
      const sessions = body.data.map(r => r.sessionId);
      expect(sessions).toContain(sessA);
      expect(sessions).toContain(sessB);
    });
  });

  describe('GET /api/webhooks/delivery-failures', () => {
    it('a key scoped to sessA sees sessA failures but never sessB', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/webhooks/delivery-failures')
        .set('X-API-Key', scopedKey)
        .expect(200);
      const sessions = (res.body as WebhookDeliveryFailure[]).map(r => r.sessionId);
      expect(sessions).toContain(sessA);
      expect(sessions).not.toContain(sessB);
    });

    it('a scoped key requesting sessB via query param gets nothing', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/webhooks/delivery-failures')
        .query({ sessionId: sessB })
        .set('X-API-Key', scopedKey)
        .expect(200);
      expect(res.body).toEqual([]);
    });

    it('an unrestricted ADMIN key still sees both sessions', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/webhooks/delivery-failures')
        .set('X-API-Key', adminKey)
        .expect(200);
      const sessions = (res.body as WebhookDeliveryFailure[]).map(r => r.sessionId);
      expect(sessions).toContain(sessA);
      expect(sessions).toContain(sessB);
    });
  });

  /**
   * The key-lifecycle routes carry no session id at all (neither route param nor query), so the
   * guard's route-param fence can never bite: a session-scoped ADMIN key would otherwise mint an
   * unrestricted key (POST), clear another key's allowedSessions (PUT), or enumerate every
   * credential (GET). These routes must reject scoped keys outright — while leaving unrestricted
   * ADMIN keys fully functional.
   */
  describe('API-key management routes (/api/auth/api-keys)', () => {
    it('rejects a scoped ADMIN on POST (cannot mint a key beyond its fence)', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/api-keys')
        .set('X-API-Key', scopedKey)
        .send({ name: 'escape-attempt', role: 'admin', allowedSessions: [] })
        .expect(403);
    });

    it('rejects a scoped ADMIN on GET list (cannot enumerate credentials)', async () => {
      await request(app.getHttpServer()).get('/api/auth/api-keys').set('X-API-Key', scopedKey).expect(403);
    });

    it('rejects a scoped ADMIN on GET :id', async () => {
      await request(app.getHttpServer())
        .get(`/api/auth/api-keys/${throwawayId}`)
        .set('X-API-Key', scopedKey)
        .expect(403);
    });

    it('rejects a scoped ADMIN on PUT :id (cannot clear another key\u2019s scope)', async () => {
      await request(app.getHttpServer())
        .put(`/api/auth/api-keys/${throwawayId}`)
        .set('X-API-Key', scopedKey)
        .send({ allowedSessions: [] })
        .expect(403);
    });

    it('rejects a scoped ADMIN on DELETE :id', async () => {
      await request(app.getHttpServer())
        .delete(`/api/auth/api-keys/${throwawayId}`)
        .set('X-API-Key', scopedKey)
        .expect(403);
    });

    it('rejects a scoped ADMIN on POST :id/revoke', async () => {
      await request(app.getHttpServer())
        .post(`/api/auth/api-keys/${throwawayId}/revoke`)
        .set('X-API-Key', scopedKey)
        .expect(403);
    });

    it('leaves an unrestricted ADMIN fully functional across the key lifecycle', async () => {
      await request(app.getHttpServer()).get('/api/auth/api-keys').set('X-API-Key', adminKey).expect(200);
      const created = await request(app.getHttpServer())
        .post('/api/auth/api-keys')
        .set('X-API-Key', adminKey)
        .send({ name: 'e2e-lifecycle', role: 'viewer' })
        .expect(201);
      const id = (created.body as { id: string }).id;
      await request(app.getHttpServer())
        .put(`/api/auth/api-keys/${id}`)
        .set('X-API-Key', adminKey)
        .send({ name: 'e2e-lifecycle-renamed' })
        .expect(200);
      await request(app.getHttpServer()).post(`/api/auth/api-keys/${id}/revoke`).set('X-API-Key', adminKey).expect(200);
      await request(app.getHttpServer()).delete(`/api/auth/api-keys/${id}`).set('X-API-Key', adminKey).expect(204);
    });

    it('audits the scoped denial as a failed-auth event', async () => {
      await request(app.getHttpServer()).get('/api/auth/api-keys').set('X-API-Key', scopedKey).expect(403);
      // The audit write is fire-and-forget; poll briefly for it to land.
      const deadline = Date.now() + 5000;
      let row: AuditLog | null = null;
      while (Date.now() < deadline && !row) {
        row = await auditRepo.findOne({
          where: { action: AuditAction.API_KEY_AUTH_FAILED, path: '/api/auth/api-keys' },
        });
        if (!row) await new Promise(r => setTimeout(r, 100));
      }
      expect(row).not.toBeNull();
    });
  });

  /**
   * The last-admin invariant must match the @RequireUnscopedKey fence: a session-scoped admin can
   * never manage keys, so it must not count as a surviving admin. Stripping the last UNSCOPED
   * admin — delete, revoke, demote, or scoping it — must 409; before the fix these returned
   * 204/200 while a scoped admin existed, permanently locking the deployment out of key
   * management (the boot seed only fires on an EMPTY api_keys table, not on zero unscoped admins).
   */
  describe('last-admin invariant vs session-scoped admins', () => {
    let soleAdminKey: string; // raw key of the only remaining UNSCOPED admin
    let soleAdminId: string;

    beforeEach(async () => {
      const authService = app.get(AuthService);
      const created = await authService.createApiKey({ name: 'e2e-sole-admin', role: ApiKeyRole.ADMIN });
      soleAdminKey = created.rawKey;
      soleAdminId = created.apiKey.id;

      // Revoke every OTHER unscoped admin directly in the DB (bypassing the service leaves the
      // bootstrap key file alone), so soleAdmin is the last key that can manage keys — the
      // session-scoped admin from the outer fixture must not count.
      const apiKeyRepo: Repository<ApiKey> = app.get(getRepositoryToken(ApiKey, 'main'));
      const others = (await apiKeyRepo.find()).filter(
        k => k.id !== soleAdminId && k.role === ApiKeyRole.ADMIN && k.isActive && !k.allowedSessions?.length,
      );
      for (const k of others) {
        k.isActive = false;
        await apiKeyRepo.save(k);
      }
    });

    it('rejects DELETE of the last unscoped admin (a scoped admin does not count)', async () => {
      await request(app.getHttpServer())
        .delete(`/api/auth/api-keys/${soleAdminId}`)
        .set('X-API-Key', soleAdminKey)
        .expect(409);
    });

    it('rejects revoking the last unscoped admin', async () => {
      await request(app.getHttpServer())
        .post(`/api/auth/api-keys/${soleAdminId}/revoke`)
        .set('X-API-Key', soleAdminKey)
        .expect(409);
    });

    it('rejects demoting the last unscoped admin', async () => {
      await request(app.getHttpServer())
        .put(`/api/auth/api-keys/${soleAdminId}`)
        .set('X-API-Key', soleAdminKey)
        .send({ role: 'operator' })
        .expect(409);
    });

    it('rejects scoping the last unscoped admin (would strip key-management capability)', async () => {
      await request(app.getHttpServer())
        .put(`/api/auth/api-keys/${soleAdminId}`)
        .set('X-API-Key', soleAdminKey)
        .send({ allowedSessions: [sessA] })
        .expect(409);
    });

    it('still allows the mutation once another unscoped admin exists', async () => {
      const authService = app.get(AuthService);
      const second = await authService.createApiKey({ name: 'e2e-second-admin', role: ApiKeyRole.ADMIN });

      await request(app.getHttpServer())
        .put(`/api/auth/api-keys/${soleAdminId}`)
        .set('X-API-Key', soleAdminKey)
        .send({ allowedSessions: [sessA] })
        .expect(200);
      // soleAdminKey is now session-scoped itself (the fence would 403 it) — the surviving
      // unscoped admin carries the delete.
      await request(app.getHttpServer())
        .delete(`/api/auth/api-keys/${soleAdminId}`)
        .set('X-API-Key', second.rawKey)
        .expect(204);
    });
  });
});
