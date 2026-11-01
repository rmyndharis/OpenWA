import { Controller, Get, INestApplication, Post } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Router } from 'express';
import request from 'supertest';
import type { App } from 'supertest/types';
import { applyGlobalValidation } from '../../config/app-validation';
import { configureApp } from '../../configure-app';
import { RequestMetricsInterceptor } from '../interceptors/request-metrics.interceptor';
import { renderHttpRequestMetrics, resetHttpRequestMetrics } from '../metrics/request-metrics';

@Controller('ping')
class PingController {
  @Get()
  get(): string {
    return 'pong';
  }

  @Post()
  post(): string {
    return 'pong';
  }
}

// The production stack answers some requests itself, ahead of every route and guard: the HTTP RED series
// must count those as well as the routed ones, each once.
describe('HTTP request metrics through the production stack (configureApp)', () => {
  let app: INestApplication<App>;

  const counter = (method: string, route: string, status: number): number => {
    const prefix = `http_requests_total{method="${method}",route="${route}",status="${status}"} `;
    const line = renderHttpRequestMetrics().find(l => l.startsWith(prefix));
    return line ? Number(line.slice(prefix.length)) : 0;
  };
  const total = (): number =>
    renderHttpRequestMetrics()
      .filter(l => l.startsWith('http_requests_total{'))
      .reduce((sum, l) => sum + Number(l.split('} ')[1]), 0);

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [PingController],
      providers: [{ provide: APP_INTERCEPTOR, useClass: RequestMetricsInterceptor }],
    }).compile();
    app = mod.createNestApplication({ bodyParser: false, logger: false });
    configureApp(app);
    // Bull Board is an Express app of its own below /api, and the labels of its routes are relative to the mount.
    const board = Router();
    board.get('/api/queues', (_req, res) => {
      res.json([]);
    });
    app.use('/api/admin/queues', board);
    applyGlobalValidation(app);
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => resetHttpRequestMetrics());

  it('counts a request the stack refuses before routing', async () => {
    await request(app.getHttpServer()).get('/api/ping%00').expect(400);

    expect(counter('GET', '(unmatched)', 400)).toBe(1);
    expect(total()).toBe(1);
  });

  it('counts a body the parser refuses', async () => {
    await request(app.getHttpServer())
      .post('/api/ping')
      .set('Content-Type', 'application/json')
      .send('{"unterminated')
      .expect(400);

    expect(counter('POST', '(unmatched)', 400)).toBe(1);
    expect(total()).toBe(1);
  });

  it('counts a routed request once, under its route', async () => {
    await request(app.getHttpServer()).get('/api/ping').expect(200);

    expect(counter('GET', '/api/ping', 200)).toBe(1);
    expect(total()).toBe(1);
  });

  it('leaves out the Bull Board mount, whose route labels read as routes the API does not have', async () => {
    await request(app.getHttpServer()).get('/api/admin/queues/api/queues').expect(200);

    expect(total()).toBe(0);
  });

  it('leaves out requests outside /api', async () => {
    await request(app.getHttpServer()).get('/other');
    await request(app.getHttpServer()).get('/apiary');

    expect(total()).toBe(0);
  });
});
