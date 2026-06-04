import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    // TypeOrm's shutdown hook resolves the *default* DataSource, but this app
    // only registers named ones ('main'/'data'), so close() throws a harmless
    // "could not find DataSource element". Swallow it — boot already succeeded.
    await app.close().catch(() => undefined);
  });

  // Boot smoke test: the whole AppModule must wire up (DI, event-bus listeners,
  // TypeORM datasources) and serve the public health endpoint.
  it('/health (GET) returns ok', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect(res => {
        if (res.body.status !== 'ok') {
          throw new Error(`expected status "ok", got ${JSON.stringify(res.body)}`);
        }
      });
  });
});
