// archiver v8 is ESM-only and is pulled in transitively via the @Global StorageModule when
// AppModule boots; stub it so ts-jest (CommonJS) can load the module graph.
jest.mock('archiver', () => ({ TarArchive: jest.fn() }));

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

/**
 * Smoke e2e: the previous test asserted a non-existent Hello-World route and failed to
 * even compile (ESM archiver). This boots the real app (SQLite, no queue) and checks the
 * public health route, the auth boundary, and unknown-route handling.
 */
describe('App smoke (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    // Mirror the bits of main.ts that affect routing/validation.
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    // app.close() can throw a "could not find DataSource" during TypeORM's shutdown hook because
    // both connections are NAMED ('main'/'data') with no default DataSource — a teardown-only
    // artifact, not an app bug (the smoke assertions above already validated a healthy boot).
    try {
      await app?.close();
    } catch {
      /* ignore teardown-only multi-datasource quirk */
    }
  });

  it('GET /api/health is public and returns ok', () => {
    return request(app.getHttpServer())
      .get('/api/health')
      .expect(200)
      .expect(res => {
        const body = res.body as { status?: string };
        if (body.status !== 'ok') throw new Error(`unexpected health body: ${JSON.stringify(res.body)}`);
      });
  });

  it('GET /api/sessions without an API key is rejected (401)', () => {
    return request(app.getHttpServer()).get('/api/sessions').expect(401);
  });

  it('GET an unknown route returns 404', () => {
    return request(app.getHttpServer()).get('/api/this-route-does-not-exist').expect(404);
  });

  it('GET /api/metrics is disabled (404) when METRICS_TOKEN is unset', () => {
    // Secure default: no scrape token configured → the endpoint must not exist.
    return request(app.getHttpServer()).get('/api/metrics').expect(404);
  });
});
