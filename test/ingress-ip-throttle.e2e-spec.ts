// archiver v8 is ESM-only and is pulled in transitively via the @Global StorageModule when
// AppModule boots; stub it so ts-jest (CommonJS) can load the module graph.
jest.mock('archiver', () => ({ TarArchive: jest.fn() }));

// Set BEFORE AppModule is imported: InstanceThrottlerGuard reads these in onModuleInit (once, at
// boot), not per request. A low ip limit with the per-instance limit left at its default isolates
// the tier under test: the instance bucket can never bind here, because every request below uses a
// different (pluginId, instanceId) pair and therefore its own instance bucket.
process.env.INGRESS_IP_LIMIT = '4';
process.env.INGRESS_INSTANCE_LIMIT = '120';
process.env.INGRESS_INSTANCE_TTL = '60000';

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { applyGlobalValidation } from './../src/config/app-validation';

/**
 * The ingress route is `@Public` and carries `@SkipThrottle()` so the global per-IP tiers leave it
 * alone (their 100/min sits below the per-instance 120/min and would 429 a shared-egress provider
 * before the instance bound ever fired). That left the per-instance bucket as the only limiter, and
 * its key is built from the caller-supplied `:pluginId/:instanceId` path segments, so walking those
 * segments minted a fresh bucket per request: an unauthenticated client had no effective bound at
 * all. This proves the client-keyed tier now binds regardless of the path.
 *
 * The pairs below name no registered instance, so each request 404s at the handler. That is the
 * point: the guard runs BEFORE the handler, so a 404 still consumes budget, and an unknown-instance
 * flood is exactly the shape that had no limit.
 */
describe('Ingress per-IP rate bound (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    applyGlobalValidation(app);
    await app.init();
  });

  afterAll(async () => {
    try {
      await app?.close();
    } catch {
      /* ignore teardown-only multi-datasource quirk */
    }
  });

  const sendTo = (n: number) =>
    request(app.getHttpServer()).post(`/api/ingress/plugin-${n}/instance-${n}/hook`).send({});

  it('sheds a flood that varies the instance path segments, from one client', async () => {
    // INGRESS_IP_LIMIT=4: four distinct paths pass the guard (and 404 at the handler), the fifth is
    // shed. Without the client-keyed tier every one of these answers 404 and the flood is unbounded.
    for (let n = 0; n < 4; n++) {
      const res = await sendTo(n);
      expect(res.status).toBe(404);
    }

    const shed = await sendTo(99);
    expect(shed.status).toBe(429);
    // Names the tier that shed it, so an operator can tell this from the per-instance bound.
    expect(shed.headers['retry-after-ingress-ip']).toBeDefined();
    // The suffixed name says WHICH bucket shed it; the plain one is the only spelling a client reads.
    expect(shed.headers['retry-after']).toBe(shed.headers['retry-after-ingress-ip']);
    expect(shed.body).toMatchObject({ statusCode: 429 });
  });
});
