jest.mock('../metrics/request-metrics', () => ({
  recordHttpRequest: jest.fn(),
  renderHttpRequestMetrics: jest.fn(() => []),
  resetHttpRequestMetrics: jest.fn(),
}));

import { Observable } from 'rxjs';
import { RequestMetricsInterceptor } from './request-metrics.interceptor';
import { recordHttpRequest } from '../metrics/request-metrics';

const mockedRecord = recordHttpRequest as jest.MockedFunction<typeof recordHttpRequest>;

interface Ctx {
  ctx: Record<string, unknown>;
  listeners: { finish?: () => void; close?: () => void };
}

function makeContext(opts: {
  method?: string;
  routePath?: string;
  statusCode?: number;
  className?: string;
  handlerName?: string;
}): Ctx {
  const req = { method: opts.method ?? 'GET', route: opts.routePath ? { path: opts.routePath } : undefined };
  const listeners: { finish?: () => void; close?: () => void } = {};
  const res = {
    statusCode: opts.statusCode ?? 200,
    on: (event: string, cb: () => void): void => {
      listeners[event as 'finish' | 'close'] = cb;
    },
  };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    getClass: () => ({ name: opts.className ?? 'SessionController' }),
    getHandler: () => ({ name: opts.handlerName ?? 'list' }),
  };
  return { ctx, listeners };
}

const noopHandler = { handle: (): Observable<unknown> => new Observable<unknown>() };

describe('RequestMetricsInterceptor', () => {
  beforeEach(() => mockedRecord.mockClear());

  it('records on response finish with method/route/status and a duration', () => {
    const { ctx, listeners } = makeContext({ method: 'GET', routePath: '/api/sessions', statusCode: 200 });
    new RequestMetricsInterceptor().intercept(ctx as never, noopHandler as never);
    listeners.finish?.();
    expect(mockedRecord).toHaveBeenCalledTimes(1);
    const [method, route, status, seconds] = mockedRecord.mock.calls[0];
    expect(method).toBe('GET');
    expect(route).toBe('/api/sessions');
    expect(status).toBe(200);
    expect(seconds).toBeGreaterThanOrEqual(0);
  });

  it('skips /api/health and /api/metrics entirely (no observation, no listener)', () => {
    for (const path of ['/api/health', '/api/health/live', '/api/metrics']) {
      const { ctx, listeners } = makeContext({ routePath: path });
      new RequestMetricsInterceptor().intercept(ctx as never, noopHandler as never);
      listeners.finish?.();
      expect(mockedRecord).not.toHaveBeenCalled();
      mockedRecord.mockClear();
    }
  });

  it('records the final status set by exception filters (e.g. 500)', () => {
    const { ctx, listeners } = makeContext({ routePath: '/api/sessions', statusCode: 500 });
    new RequestMetricsInterceptor().intercept(ctx as never, noopHandler as never);
    listeners.finish?.();
    expect(mockedRecord.mock.calls[0][2]).toBe(500);
  });

  it('falls back to Controller#handler when the Express route is unavailable', () => {
    const { ctx, listeners } = makeContext({
      routePath: undefined,
      className: 'MessageController',
      handlerName: 'sendText',
    });
    new RequestMetricsInterceptor().intercept(ctx as never, noopHandler as never);
    listeners.finish?.();
    expect(mockedRecord.mock.calls[0][1]).toBe('MessageController#sendText');
  });

  it('records once even if both finish and close fire', () => {
    const { ctx, listeners } = makeContext({ routePath: '/api/sessions' });
    new RequestMetricsInterceptor().intercept(ctx as never, noopHandler as never);
    listeners.finish?.();
    listeners.close?.();
    expect(mockedRecord).toHaveBeenCalledTimes(1);
  });
});
