jest.mock('../metrics/request-metrics', () => ({
  recordHttpRequest: jest.fn(),
  renderHttpRequestMetrics: jest.fn(() => []),
  resetHttpRequestMetrics: jest.fn(),
}));

import { EventEmitter } from 'events';
import type { Request, Response } from 'express';
import { markDroppedResponse, requestMetricsBoundaryMiddleware } from './request-metrics.middleware';
import { RequestMetricsInterceptor } from '../interceptors/request-metrics.interceptor';
import { recordHttpRequest } from '../metrics/request-metrics';
import { createInflightBodyBudget } from '../../config/inflight-body-budget';
import { LoggerService, LogFormat } from '../services/logger.service';

const mockedRecord = recordHttpRequest as jest.MockedFunction<typeof recordHttpRequest>;
const MB = 1024 * 1024;

type Res = EventEmitter & { statusCode: number; headersSent?: boolean };
const makeRes = (statusCode = 200, headersSent?: boolean): Res =>
  Object.assign(new EventEmitter(), { statusCode, headersSent });

const makeReq = (headers: Record<string, string> = {}): Request & EventEmitter => {
  const req = new EventEmitter() as unknown as Request & EventEmitter;
  Object.assign(req, {
    method: 'POST',
    headers,
    originalUrl: '/api/upload',
    socket: { bytesRead: 0, remoteAddress: '203.0.113.7' },
    destroy: jest.fn(),
  });
  return req;
};

/** The boundary recorder in front of a request, as configureApp mounts it. */
const withBoundary = (req: Request, res: Res): void => {
  requestMetricsBoundaryMiddleware(req, res as unknown as Response, jest.fn());
};

describe('a response the gateway ended by dropping its request body', () => {
  beforeEach(() => mockedRecord.mockClear());

  it('is counted by the boundary recorder under the status the drop marked', () => {
    const req = makeReq();
    const res = makeRes();
    withBoundary(req, res);

    markDroppedResponse(res as unknown as Response, 408);
    res.emit('close');

    expect(mockedRecord).toHaveBeenCalledTimes(1);
    expect(mockedRecord.mock.calls[0][2]).toBe(408);
  });

  it('is counted by the interceptor under the status the drop marked', () => {
    const res = makeRes();
    const req = { method: 'POST', route: { path: '/api/media' } };
    const context = {
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
      getClass: () => ({ name: 'MediaController' }),
      getHandler: () => ({ name: 'upload' }),
    };
    new RequestMetricsInterceptor().intercept(context as never, { handle: jest.fn() } as never);

    markDroppedResponse(res as unknown as Response, 503);
    res.emit('close');

    expect(mockedRecord.mock.calls[0][2]).toBe(503);
  });

  it('keeps the status it had already sent when the drop came after the response started', () => {
    const res = makeRes(202, true);
    withBoundary(makeReq(), res);

    markDroppedResponse(res as unknown as Response, 408);
    res.emit('close');

    expect(mockedRecord.mock.calls[0][2]).toBe(202);
  });

  it('keeps the status the drop marked when the cut made the application write an error afterwards', () => {
    const res = makeRes();
    withBoundary(makeReq(), res);

    // Destroying the request fails a multipart parser at once, and Nest answers the failure on the dead socket
    // before the response reports that it closed.
    markDroppedResponse(res as unknown as Response, 408);
    res.statusCode = 500;
    res.headersSent = true;
    res.emit('close');

    expect(mockedRecord.mock.calls[0][2]).toBe(408);
  });

  it('is counted under its own status when it finished, whatever was marked', () => {
    const res = makeRes(201);
    withBoundary(makeReq(), res);

    markDroppedResponse(res as unknown as Response, 408);
    res.emit('finish');

    expect(mockedRecord.mock.calls[0][2]).toBe(201);
  });
});

describe('the in-flight body budget marks the response before it destroys the socket', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    mockedRecord.mockClear();
    LoggerService.setLogFormat(LogFormat.JSON);
    warn = jest.spyOn(console, 'warn').mockImplementation();
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
    warn.mockRestore();
    LoggerService.setLogFormat(null);
  });

  /** Runs a request through the recorder and the budget; destroying the socket closes the response at once. */
  const admit = (
    budget: ReturnType<typeof createInflightBodyBudget>,
    headers: Record<string, string>,
    ip = '203.0.113.7',
  ): { req: Request & EventEmitter; res: Res } => {
    const req = makeReq(headers);
    (req.socket as unknown as { remoteAddress: string }).remoteAddress = ip;
    const res = makeRes();
    (req as unknown as { destroy: jest.Mock }).destroy.mockImplementation(() => {
      res.emit('close');
    });
    withBoundary(req, res);
    budget.middleware(req, res as unknown as Response, jest.fn());
    return { req, res };
  };

  it('counts a stalled body as 408', () => {
    const budget = createInflightBodyBudget(1000, { perClientShare: 1 });
    admit(budget, { 'content-length': '400' });

    jest.advanceTimersByTime(60_000);

    expect(mockedRecord).toHaveBeenCalledTimes(1);
    expect(mockedRecord.mock.calls[0][2]).toBe(408);
  });

  it('counts a body that falls behind the pace as 408', () => {
    const budget = createInflightBodyBudget(1000, { perClientShare: 1 });
    const { req } = admit(budget, { 'content-length': '400' });

    for (let seconds = 0; seconds < 20; seconds += 4) {
      jest.advanceTimersByTime(4_000);
      (req.socket as unknown as { bytesRead: number }).bytesRead += 1;
    }

    expect(mockedRecord.mock.calls.map(call => call[2])).toEqual([408]);
  });

  it('counts a chunked body that outgrows its share as 503', () => {
    const budget = createInflightBodyBudget(10 * MB);
    const { req } = admit(budget, { 'transfer-encoding': 'chunked' });

    (req.socket as unknown as { bytesRead: number }).bytesRead = 6 * MB;
    jest.advanceTimersByTime(5_000);

    expect(mockedRecord.mock.calls.map(call => call[2])).toEqual([503]);
  });

  it('counts a chunked body that outgrows the aggregate budget as 503', () => {
    const budget = createInflightBodyBudget(4 * MB, { perClientShare: 1 });
    admit(budget, { 'content-length': String(2 * MB) }, '198.51.100.9');
    const { req } = admit(budget, { 'transfer-encoding': 'chunked' });

    (req.socket as unknown as { bytesRead: number }).bytesRead = 2.5 * MB;
    jest.advanceTimersByTime(5_000);

    expect(mockedRecord.mock.calls.map(call => call[2])).toEqual([503]);
  });

  it('counts a chunked body that outgrows the unkeyed pool as 503', () => {
    const budget = createInflightBodyBudget(8 * MB, { classify: () => undefined, bodyLimitBytes: 2 * MB });
    const { req } = admit(budget, { 'transfer-encoding': 'chunked' });
    admit(budget, { 'content-length': String(2 * MB) }, '198.51.100.2');
    admit(budget, { 'content-length': String(MB) }, '198.51.100.3');

    (req.socket as unknown as { bytesRead: number }).bytesRead = 1.5 * MB;
    jest.advanceTimersByTime(5_000);

    expect(mockedRecord.mock.calls.map(call => call[2])).toEqual([503]);
  });

  it('leaves a socket it could not answer to the status already on the response', () => {
    const budget = createInflightBodyBudget(1000, { perClientShare: 1 });
    admit(budget, { 'content-length': '800' });
    const req = makeReq({ 'content-length': '300' });
    const res = makeRes(413, true);
    (req as unknown as { destroy: jest.Mock }).destroy.mockImplementation(() => {
      res.emit('close');
    });
    withBoundary(req, res);

    budget.middleware(req, res as unknown as Response, jest.fn());

    expect(mockedRecord.mock.calls.map(call => call[2])).toEqual([413]);
  });
});
