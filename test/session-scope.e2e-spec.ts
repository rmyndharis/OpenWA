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

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    applyGlobalValidation(app);
    await app.init();

    const sessionRepo: Repository<Session> = app.get(getRepositoryToken(Session, 'data'));
    const auditRepo: Repository<AuditLog> = app.get(getRepositoryToken(AuditLog, 'main'));
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
});
