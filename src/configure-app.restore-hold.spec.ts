import 'reflect-metadata';
import { Controller, Get, HttpCode, INestApplication, Module, Post, Req } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import { request as httpRequest } from 'http';
import type { AddressInfo } from 'net';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { configureApp } from './configure-app';
import * as budgets from './config/inflight-body-budget';
import { ShutdownService } from './common/services/shutdown.service';
import { holdSharedConnection, type SharedConnectionHold } from './common/utils/shared-connection';

// A SQLite restore holds every statement on the data connection until it ends. A request that carries a body waits
// for it ahead of the in-flight body budget and the parsers, with its body unread, so a parked upload costs its
// stream buffer rather than its whole body, and the budget's stall reaper never sees it.
describe('production HTTP surface while a restore holds the data connection', () => {
  let app: INestApplication<App>;
  let port: number;
  let db: DataSource;
  let hold: SharedConnectionHold | undefined;
  let budget: budgets.InflightBodyBudget;
  let tearingDown = false;
  const handled: Array<{ length: number | undefined }> = [];
  /** Every request as it reached the first middleware. */
  const arrived: Request[] = [];

  @Controller('api/echo')
  class EchoController {
    @Post()
    @HttpCode(200)
    echo(@Req() req: Request) {
      const length = (req.body as { text?: string } | undefined)?.text?.length;
      handled.push({ length });
      return { length };
    }

    @Get()
    read() {
      return { ok: true };
    }
  }

  @Module({
    controllers: [EchoController],
    providers: [{ provide: ShutdownService, useValue: { isTearingDown: () => tearingDown } }],
  })
  class EchoModule {}

  beforeAll(async () => {
    db = await new DataSource({ type: 'better-sqlite3', database: ':memory:' }).initialize();
    const create = budgets.createInflightBodyBudget;
    jest.spyOn(budgets, 'createInflightBodyBudget').mockImplementation((...args) => (budget = create(...args)));
    app = await NestFactory.create<INestApplication<App>>(EchoModule, { bodyParser: false, logger: false });
    app.use((req: Request, _res: Response, next: NextFunction) => {
      arrived.push(req);
      next();
    });
    // Three held requests fill it; the cases below hold at most that many but for the one that tests the bound.
    configureApp(app, { maxHeldBodyRequests: 3 });
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer() as { address: () => AddressInfo }).address().port;
  });

  beforeEach(async () => {
    handled.length = 0;
    arrived.length = 0;
    tearingDown = false;
    hold = await holdSharedConnection(db);
  });

  afterEach(() => {
    hold?.release();
    jest.useRealTimers();
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await app?.close();
    await db?.destroy();
  });

  const until = async (condition: () => boolean): Promise<void> => {
    while (!condition()) await new Promise(resolve => setImmediate(resolve));
  };
  const turns = async (count: number): Promise<void> => {
    for (let i = 0; i < count; i++) await new Promise(resolve => setImmediate(resolve));
  };

  it('lets a request without a body through', async () => {
    const response = await request(app.getHttpServer()).get('/api/echo');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });

  it('keeps a large body unread past the stall bound, then hands it on whole once released', async () => {
    // The budget's stall reaper polls on an interval and reads the clock; both are faked so 20 s pass at once.
    jest.useFakeTimers({
      doNotFake: [
        'nextTick',
        'setImmediate',
        'clearImmediate',
        'setTimeout',
        'clearTimeout',
        'queueMicrotask',
        'hrtime',
        'performance',
      ],
    });
    const text = 'x'.repeat(1_000_000);
    const answer = request(app.getHttpServer())
      .post('/api/echo')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ text }))
      .then(response => response);
    await until(() => arrived.length === 1);
    await turns(20);

    jest.advanceTimersByTime(20_000);
    await turns(20);
    // Nothing read it: no parser, no budget reservation, no handler.
    expect(arrived[0].readableFlowing).toBeNull();
    expect(budget.currentBytes()).toBe(0);
    expect(handled).toEqual([]);

    hold!.release();
    const response = await answer;

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ length: text.length });
    expect(handled).toEqual([{ length: text.length }]);
  });

  it('does not hand on a request whose client left while it waited, and leaves the budget empty', async () => {
    const body = JSON.stringify({ text: 'y'.repeat(2_000) });
    const clients = [0, 1, 2].map(() => {
      const client = httpRequest({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/api/echo',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      });
      client.on('error', () => undefined);
      client.end(body);
      return client;
    });
    await until(() => arrived.length === 3);
    const closed = arrived.map(req => new Promise(resolve => req.once('close', resolve)));
    for (const client of clients) client.destroy();
    await Promise.all(closed);

    hold!.release();
    await turns(20);

    expect(budget.currentBytes()).toBe(0);
    expect(handled).toEqual([]);
  });

  it('refuses a request past the number it holds, body unread, and holds another once one gives its place back', async () => {
    const body = JSON.stringify({ text: 'z'.repeat(2_000) });
    const answered: Array<Promise<number | undefined>> = [];
    const send = () => {
      const client = httpRequest({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/api/echo',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      });
      client.on('error', () => undefined);
      answered.push(
        new Promise(resolve => {
          client.on('response', response => {
            response.resume();
            response.on('end', () => resolve(response.statusCode));
          });
          client.on('close', () => resolve(undefined));
        }),
      );
      client.end(body);
      return client;
    };
    const clients = [send(), send(), send()];
    await until(() => arrived.length === 3);

    const refused = await request(app.getHttpServer())
      .post('/api/echo')
      .set('Content-Type', 'application/json')
      .send(body);

    expect(refused.status).toBe(503);
    expect(refused.headers['retry-after']).toBe('5');
    expect(refused.headers.connection).toBe('close');
    expect(refused.body).toEqual({
      statusCode: 503,
      message: 'Too many requests are waiting for a data restore to end; retry later',
      error: 'Service Unavailable',
    });
    // No parser or budget took it: Node discards the unread bytes with the connection it closes.
    expect(budget.currentBytes()).toBe(0);
    expect(handled).toEqual([]);

    // A client that leaves gives its place back: the next request is held, not refused.
    const left = new Promise(resolve => arrived[0].once('close', resolve));
    clients[0].destroy();
    await left;
    const next = request(app.getHttpServer())
      .post('/api/echo')
      .set('Content-Type', 'application/json')
      .send(body)
      .then(response => response);
    await until(() => arrived.length === 5);
    await turns(20);
    expect(handled).toEqual([]);

    hold!.release();
    expect((await next).status).toBe(200);
    expect(await Promise.all(answered.slice(1))).toEqual([200, 200]);
    expect(handled).toHaveLength(3);
  });

  it('refuses a request let through once teardown has begun', async () => {
    const answer = request(app.getHttpServer())
      .post('/api/echo')
      .set('Content-Type', 'application/json')
      .send('{"text":"late"}')
      .then(response => response);
    await until(() => arrived.length === 1);

    tearingDown = true;
    hold!.release();
    const response = await answer;

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      statusCode: 503,
      message: 'Server is shutting down',
      error: 'Service Unavailable',
    });
    expect(handled).toEqual([]);
  });
});
