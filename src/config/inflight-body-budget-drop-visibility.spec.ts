import { createServer, request as httpRequest, Server } from 'http';
import { AddressInfo, Socket } from 'net';
import express, { json } from 'express';
import { createInflightBodyBudget } from './inflight-body-budget';
import { requestMetricsBoundaryMiddleware } from '../common/middleware/request-metrics.middleware';
import { renderHttpRequestMetrics, resetHttpRequestMetrics } from '../common/metrics/request-metrics';
import { LoggerService, LogFormat } from '../common/services/logger.service';

const MB = 1024 * 1024;

/**
 * The budget drops an upload that stalls, falls behind its pace or grows past its share mid-stream. The client only
 * sees the connection close, so the operator needs a log line naming why, and the HTTP RED series must not count a
 * request the gateway ended without answering as a success. Real sockets, the real budget, the real boundary
 * recorder and the real request-metrics store; only the poll clock (setInterval and Date) is faked.
 */
describe('a request body the in-flight budget drops mid-upload', () => {
  const STORED_KEY_HASH = 'stored-key-hash-0123456789abcdef';
  let server: Server | undefined;
  let port = 0;
  let serverSocket: Socket | undefined;
  let warn: jest.SpyInstance;

  const start = async (options: Parameters<typeof createInflightBodyBudget>[1]): Promise<void> => {
    const budget = createInflightBodyBudget(2 * MB, options);
    const app = express();
    app.use('/api', requestMetricsBoundaryMiddleware);
    app.use((req, _res, next) => {
      serverSocket = req.socket;
      next();
    });
    app.use(budget.middleware);
    app.use(json({ limit: '25mb' }));
    app.post('/api/upload', (_req, res) => {
      res.status(201).json({ ok: true });
    });
    server = createServer(app);
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  };

  beforeEach(() => {
    resetHttpRequestMetrics();
    serverSocket = undefined;
    LoggerService.setLogFormat(LogFormat.JSON);
    warn = jest.spyOn(console, 'warn').mockImplementation();
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

  afterEach(async () => {
    jest.useRealTimers();
    warn.mockRestore();
    LoggerService.setLogFormat(null);
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;
  });

  /** Real-time polling: the fake clock does not move, so this counts turns instead of reading Date. */
  const until = async (condition: () => boolean, label: string): Promise<void> => {
    for (let turn = 0; turn < 500; turn++) {
      if (condition()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for ${label}`);
  };

  /** Opens a POST, writes `first` and leaves it open. Resolves with what the client saw when the server ended it. */
  const upload = (headers: Record<string, string>, first: string): Promise<string> =>
    new Promise(resolve => {
      const req = httpRequest({
        host: '127.0.0.1',
        port,
        path: '/api/upload',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
      });
      req.on('response', res => resolve(`status ${res.statusCode}`));
      req.on('error', error => resolve(`error ${(error as NodeJS.ErrnoException).code}`));
      req.write(first);
    });

  const counted = (): string[] => renderHttpRequestMetrics().filter(line => line.startsWith('http_requests_total{'));
  const logged = (): Array<Record<string, unknown>> =>
    (warn.mock.calls as unknown[][]).map(call => JSON.parse(String(call[0])) as Record<string, unknown>);

  it('counts a chunked body that outgrows its client share as a 503 and names the cause in the log', async () => {
    await start({ perClientShare: 0.5 });
    const outcome = upload({ 'Transfer-Encoding': 'chunked' }, `{"data":"${'a'.repeat(1536 * 1024)}`);
    await until(() => (serverSocket?.bytesRead ?? 0) >= 1536 * 1024, 'the body to arrive');

    // The share check runs on the stall poll, every 5 s.
    jest.advanceTimersByTime(5_000);

    expect(await outcome).toMatch(/^error /);
    await until(() => counted().length > 0, 'the request to be recorded');
    expect(counted()).toEqual(['http_requests_total{method="POST",route="(unmatched)",status="503"} 1']);
    expect(logged()).toEqual([
      expect.objectContaining({
        level: 'warn',
        context: 'InflightBodyBudget',
        reason: 'share',
        client: '127.0.0.1',
        keyed: false,
        path: '/api/upload',
        receivedBytes: expect.any(Number) as number,
      }),
    ]);
  }, 20_000);

  it('counts a body that stops arriving as a 408 and never logs the key it was sent with', async () => {
    await start({ classify: () => STORED_KEY_HASH });
    const outcome = upload({ 'Content-Length': '1000' }, 'x'.repeat(500));
    await until(() => (serverSocket?.bytesRead ?? 0) >= 500, 'the first part of the body to arrive');

    // One poll sees the bytes, then 15 s without more.
    jest.advanceTimersByTime(20_000);

    expect(await outcome).toMatch(/^error /);
    await until(() => counted().length > 0, 'the request to be recorded');
    expect(counted()).toEqual(['http_requests_total{method="POST",route="(unmatched)",status="408"} 1']);
    expect(logged()).toEqual([
      expect.objectContaining({ reason: 'stall', keyed: true, declaredBytes: 1000, path: '/api/upload' }),
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(STORED_KEY_HASH);
  }, 20_000);
});
