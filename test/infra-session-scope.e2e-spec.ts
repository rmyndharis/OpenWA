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
 * The infrastructure routes carry no session dimension, so the ApiKeyGuard's route-param fence can
 * never bite on them: a session-restricted ADMIN key would otherwise export or replace the whole
 * deployment database, rewrite global engine configuration, or stop deployment services. They must
 * reject scoped keys outright, while leaving unrestricted ADMIN keys fully functional.
 */
describe('Infrastructure routes reject session-scoped keys (e2e)', () => {
  let app: INestApplication<App>;
  let scopedKey: string; // ADMIN, allowedSessions: [sessA]
  let adminKey: string; // ADMIN, unrestricted

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    applyGlobalValidation(app);
    await app.init();

    const sessionRepo: Repository<Session> = app.get(getRepositoryToken(Session, 'data'));
    const sessA = await sessionRepo.save(sessionRepo.create({ name: `e2e-infra-scope-${Date.now()}` }));

    const authService = app.get(AuthService);
    scopedKey = (
      await authService.createApiKey({ name: 'e2e-infra-scoped', role: ApiKeyRole.ADMIN, allowedSessions: [sessA.id] })
    ).rawKey;
    adminKey = (await authService.createApiKey({ name: 'e2e-infra-admin', role: ApiKeyRole.ADMIN })).rawKey;
  });

  afterAll(async () => {
    try {
      await app?.close();
    } catch {
      /* ignore teardown-only multi-datasource quirk */
    }
  });

  it('rejects a scoped ADMIN on GET /api/infra/export-data', async () => {
    await request(app.getHttpServer()).get('/api/infra/export-data').set('X-API-Key', scopedKey).expect(403);
  });

  it('rejects a scoped ADMIN on POST /api/infra/import-data', async () => {
    await request(app.getHttpServer())
      .post('/api/infra/import-data')
      .set('X-API-Key', scopedKey)
      .send({ tables: {} })
      .expect(403);
  });

  it('rejects a scoped ADMIN on GET /api/infra/config', async () => {
    await request(app.getHttpServer()).get('/api/infra/config').set('X-API-Key', scopedKey).expect(403);
  });

  it('leaves the public health route reachable without a key', async () => {
    await request(app.getHttpServer()).get('/api/infra/health').expect(200);
  });

  it('leaves an unrestricted ADMIN able to read the export', async () => {
    await request(app.getHttpServer()).get('/api/infra/export-data').set('X-API-Key', adminKey).expect(200);
  });
});
