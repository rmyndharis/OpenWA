import { Controller, Get, INestApplication, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { FileInterceptor } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Router } from 'express';
import { request as httpRequest, type ClientRequest, type Server } from 'http';
import type { AddressInfo, Socket } from 'net';
import request from 'supertest';
import type { App } from 'supertest/types';
import { applyGlobalValidation } from '../../config/app-validation';
import { configureApp } from '../../configure-app';
import { RequestMetricsInterceptor } from '../interceptors/request-metrics.interceptor';
import { renderHttpRequestMetrics, resetHttpRequestMetrics } from '../metrics/request-metrics';
import { LoggerService, LogFormat } from '../services/logger.service';

let holdEntered: () => void = () => undefined;
let holdRelease: () => void = () => undefined;

@Controller('hold')
class HoldController {
  /** A handler still working when its client gives up. */
  @Get()
  hold(): Promise<string> {
    holdEntered();
    return new Promise(resolve => {
      holdRelease = () => resolve('done');
    });
  }
}

@Controller('upload')
class UploadController {
  /** A routed multipart body, read by multer after the guards: the body budget can cut it once the route is known. */
  @Post()
  @UseInterceptors(FileInterceptor('file'))
  upload(@UploadedFile() file: unknown): { stored: boolean } {
    return { stored: file !== undefined };
  }
}

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
      controllers: [PingController, HoldController, UploadController],
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

  // Nest sets the route's status before the handler runs; a client that leaves first was not answered.
  it('counts a routed request whose client left before the answer as 499, once', async () => {
    const entered = new Promise<void>(resolve => (holdEntered = resolve));
    const { port } = (app.getHttpServer() as Server).address() as AddressInfo;
    const client = httpRequest({ host: '127.0.0.1', port, path: '/api/hold', method: 'GET' });
    client.on('error', () => undefined);
    client.end();
    await entered;

    client.destroy();
    for (let turn = 0; turn < 200 && total() === 0; turn++) await new Promise(resolve => setTimeout(resolve, 10));
    holdRelease();
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(counter('GET', '/api/hold', 499)).toBe(1);
    expect(total()).toBe(1);
  }, 20_000);

  it('leaves out the Bull Board mount, whose route labels read as routes the API does not have', async () => {
    await request(app.getHttpServer()).get('/api/admin/queues/api/queues').expect(200);

    expect(total()).toBe(0);
  });

  it('leaves out requests outside /api', async () => {
    await request(app.getHttpServer()).get('/other');
    await request(app.getHttpServer()).get('/apiary');

    expect(total()).toBe(0);
  });

  // The body budget cuts a body that stops arriving by destroying its request. A multipart parser fails at once and the
  // stack writes its 500 to the dead connection, but the series count who ended the request, not that error.
  describe('for a body that is still arriving when its request ends', () => {
    const BOUNDARY = 'cut-boundary';
    const MULTIPART = `multipart/form-data; boundary=${BOUNDARY}`;
    const FILE_PART =
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n${'z'.repeat(2000)}`;

    let serverSocket: Socket | undefined;
    let warn: jest.SpyInstance;

    beforeAll(() => {
      (app.getHttpServer() as Server).on('request', req => {
        serverSocket = req.socket;
      });
    });

    beforeEach(() => {
      serverSocket = undefined;
      LoggerService.setLogFormat(LogFormat.JSON);
      warn = jest.spyOn(console, 'warn').mockImplementation();
      // Only the budget's poll clock (setInterval and Date) is faked: the sockets and the waits below run in real time.
      jest.useFakeTimers({
        doNotFake: [
          'nextTick',
          'setImmediate',
          'clearImmediate',
          'setTimeout',
          'clearTimeout',
          'queueMicrotask',
          'performance',
          'hrtime',
        ],
      });
    });

    afterEach(() => {
      jest.useRealTimers();
      warn.mockRestore();
      LoggerService.setLogFormat(null);
    });

    const until = async (condition: () => boolean, label: string): Promise<void> => {
      for (let turn = 0; turn < 500 && !condition(); turn++) await new Promise(resolve => setTimeout(resolve, 10));
      if (!condition()) throw new Error(`timed out waiting for ${label}`);
    };
    const counted = (): string[] => renderHttpRequestMetrics().filter(line => line.startsWith('http_requests_total{'));

    /** Opens a POST that declares 4000 bytes, writes `first` and returns once the server has read all of it. */
    const openUpload = async (
      path: string,
      contentType: string,
      first: string,
    ): Promise<{ client: ClientRequest; outcome: Promise<string> }> => {
      const { port } = (app.getHttpServer() as Server).address() as AddressInfo;
      const client = httpRequest({
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        agent: false,
        headers: { 'Content-Type': contentType, 'Content-Length': '4000' },
      });
      const outcome = new Promise<string>(resolve => {
        client.on('response', res => resolve(`status ${res.statusCode}`));
        client.on('error', error => resolve(`error ${(error as NodeJS.ErrnoException).code}`));
      });
      await new Promise<void>(resolve => client.write(first, () => resolve()));
      await until(
        () => (serverSocket?.bytesRead ?? 0) >= (client.socket?.bytesWritten ?? Infinity),
        'the server to read the opening of the body',
      );
      return { client, outcome };
    };

    it('counts a multipart upload the budget drops as 408, not as the error its parser raised', async () => {
      const { outcome } = await openUpload('/api/upload', MULTIPART, FILE_PART);

      // One poll sees the bytes, then 15 s pass without more.
      jest.advanceTimersByTime(20_000);

      expect(await outcome).toMatch(/^error /);
      await until(() => counted().length > 0, 'the request to be recorded');
      expect(counted()).toEqual(['http_requests_total{method="POST",route="/api/upload",status="408"} 1']);
      expect(warn).toHaveBeenCalledTimes(1);
    }, 20_000);

    it('counts a multipart upload its client abandons as 499', async () => {
      const { client } = await openUpload('/api/upload', MULTIPART, FILE_PART);

      client.destroy();

      await until(() => counted().length > 0, 'the request to be recorded');
      expect(counted()).toEqual(['http_requests_total{method="POST",route="/api/upload",status="499"} 1']);
    }, 20_000);

    // The parser answers an aborted JSON body with 400 before the response reports that it closed.
    it('counts a JSON body its client abandons as 400', async () => {
      const { client } = await openUpload('/api/ping', 'application/json', `{"note":"${'x'.repeat(2000)}`);

      client.destroy();

      await until(() => counted().length > 0, 'the request to be recorded');
      expect(counted()).toEqual(['http_requests_total{method="POST",route="(unmatched)",status="400"} 1']);
    }, 20_000);
  });
});
