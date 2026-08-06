jest.mock('../metrics/request-metrics', () => ({
  recordHttpRequest: jest.fn(),
  renderHttpRequestMetrics: jest.fn(() => []),
  resetHttpRequestMetrics: jest.fn(),
}));

import {
  HTTP_REQUEST_METRICS_CLAIMED,
  claimHttpRequestMetrics,
  requestMetricsBoundaryMiddleware,
} from './request-metrics.middleware';
import { recordHttpRequest } from '../metrics/request-metrics';

const mockedRecord = recordHttpRequest as jest.MockedFunction<typeof recordHttpRequest>;

interface ReqRes {
  req: Record<string, unknown>;
  listeners: { finish?: () => void; close?: () => void };
  next: jest.Mock;
}

function makeReqRes(opts: { method?: string; routePath?: string; statusCode?: number }): ReqRes {
  const req: Record<string, unknown> = {
    method: opts.method ?? 'GET',
    route: opts.routePath ? { path: opts.routePath } : undefined,
  };
  const listeners: { finish?: () => void; close?: () => void } = {};
  const res = {
    statusCode: opts.statusCode ?? 200,
    on: (event: string, cb: () => void): void => {
      listeners[event as 'finish' | 'close'] = cb;
    },
  };
  const next = jest.fn();
  requestMetricsBoundaryMiddleware(req as never, res as never, next as never);
  return { req, listeners, next };
}

describe('requestMetricsBoundaryMiddleware', () => {
  beforeEach(() => mockedRecord.mockClear());

  it('calls next() immediately (never blocks the chain)', () => {
    const { next } = makeReqRes({ routePath: '/api/sessions' });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 429])(
    'records an unclaimed request rejected by a guard with its final status (%i)',
    statusCode => {
      const { listeners } = makeReqRes({ routePath: '/api/sessions', statusCode });
      listeners.finish?.();
      expect(mockedRecord).toHaveBeenCalledTimes(1);
      const [method, route, status, seconds] = mockedRecord.mock.calls[0];
      expect(method).toBe('GET');
      expect(route).toBe('/api/sessions');
      expect(status).toBe(statusCode);
      expect(seconds).toBeGreaterThanOrEqual(0);
    },
  );

  it('skips a request claimed by the interceptor (no double-count on requests that pass the guards)', () => {
    const { req, listeners } = makeReqRes({ routePath: '/api/sessions', statusCode: 200 });
    claimHttpRequestMetrics(req as never);
    listeners.finish?.();
    expect(mockedRecord).not.toHaveBeenCalled();
  });

  it('skips /api/health and /api/metrics even when unclaimed', () => {
    for (const path of ['/api/health', '/api/health/live', '/api/metrics']) {
      const { listeners } = makeReqRes({ routePath: path });
      listeners.finish?.();
      expect(mockedRecord).not.toHaveBeenCalled();
      mockedRecord.mockClear();
    }
  });

  it('collapses unmatched routes (404) into one constant label', () => {
    const { listeners } = makeReqRes({ routePath: undefined, statusCode: 404 });
    listeners.finish?.();
    expect(mockedRecord).toHaveBeenCalledTimes(1);
    expect(mockedRecord.mock.calls[0][1]).toBe('(unmatched)');
    expect(mockedRecord.mock.calls[0][2]).toBe(404);
  });

  it('records once even if both finish and close fire', () => {
    const { listeners } = makeReqRes({ routePath: '/api/sessions', statusCode: 401 });
    listeners.finish?.();
    listeners.close?.();
    expect(mockedRecord).toHaveBeenCalledTimes(1);
  });

  it('claim marker lives on the request object under the shared symbol', () => {
    const { req } = makeReqRes({ routePath: '/api/sessions' });
    expect((req as Record<symbol, unknown>)[HTTP_REQUEST_METRICS_CLAIMED]).toBeUndefined();
    claimHttpRequestMetrics(req as never);
    expect((req as Record<symbol, unknown>)[HTTP_REQUEST_METRICS_CLAIMED]).toBe(true);
  });
});
