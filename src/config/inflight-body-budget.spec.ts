import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { createServer, request as httpRequest, Server } from 'http';
import { AddressInfo } from 'net';
import { gzipSync } from 'zlib';
import express, { Request, Response, json } from 'express';
import {
  createInflightBodyBudget,
  parseBodyLimitBytes,
  resolveInflightBodyBudgetBytes,
  InflightBodyBudget,
} from './inflight-body-budget';

const MB = 1024 * 1024;

/** Minimal req/res doubles: real EventEmitters so the middleware's listener accounting runs as-is. */
const makeReq = (headers: Record<string, string> = {}): Request & EventEmitter => {
  const req = new EventEmitter() as unknown as Request & EventEmitter;
  (req as unknown as { headers: Record<string, string> }).headers = headers;
  (req as unknown as { socket: { bytesRead: number; remoteAddress: string } }).socket = {
    bytesRead: 0,
    remoteAddress: '203.0.113.7',
  };
  (req as unknown as { destroy: jest.Mock }).destroy = jest.fn();
  return req;
};

const makeRes = () => {
  const state = { code: 0, payload: undefined as unknown };
  const headers: Record<string, string> = {};
  const res = Object.assign(new EventEmitter(), {
    headersSent: false,
    writableEnded: false,
    status(code: number) {
      state.code = code;
      return res;
    },
    set(name: string, value: string) {
      headers[name.toLowerCase()] = value;
      return res;
    },
    json(payload: unknown) {
      state.payload = payload;
      return res;
    },
  }) as unknown as Response & EventEmitter;
  return { res, headers, state };
};

const run = (budget: InflightBodyBudget, req: Request & EventEmitter) => {
  const mock = makeRes();
  const next = jest.fn();
  budget.middleware(req, mock.res, next);
  return { ...mock, next };
};

describe('parseBodyLimitBytes', () => {
  it('parses the formats resolveBodyLimit accepts, using binary units like the body parser', () => {
    expect(parseBodyLimitBytes('25mb')).toBe(25 * MB);
    expect(parseBodyLimitBytes('1024')).toBe(1024);
    expect(parseBodyLimitBytes('1.5gb')).toBe(1.5 * 1024 * MB);
    expect(parseBodyLimitBytes('10MB')).toBe(10 * MB);
    expect(parseBodyLimitBytes('512kb')).toBe(512 * 1024);
  });

  it('falls back to the 25 MiB default on an impossible value rather than throwing', () => {
    expect(parseBodyLimitBytes('not-a-limit')).toBe(25 * MB);
  });
});

describe('resolveInflightBodyBudgetBytes', () => {
  it('defaults to 4 × the default per-request cap (25 MiB → 100 MiB)', () => {
    expect(resolveInflightBodyBudgetBytes(undefined, undefined)).toBe(100 * MB);
    expect(resolveInflightBodyBudgetBytes('', '')).toBe(100 * MB);
  });

  it('scales with BODY_SIZE_LIMIT so tuning the per-request cap tunes the aggregate', () => {
    expect(resolveInflightBodyBudgetBytes(undefined, '5mb')).toBe(20 * MB);
  });

  it('uses the default per-request cap when BODY_SIZE_LIMIT is unparseable (matches the parser)', () => {
    expect(resolveInflightBodyBudgetBytes(undefined, 'unlimited')).toBe(100 * MB);
  });

  it('lets an explicit INFLIGHT_BODY_BUDGET_BYTES win over the derived default', () => {
    expect(resolveInflightBodyBudgetBytes('123456', '5mb')).toBe(123456);
    expect(resolveInflightBodyBudgetBytes('  2048  ', undefined)).toBe(2048);
  });

  it('ignores an invalid explicit value (env.validation rejects it at boot anyway)', () => {
    for (const bad of ['0', '-10', 'abc', '10.5']) {
      expect(resolveInflightBodyBudgetBytes(bad, undefined)).toBe(100 * MB);
    }
  });
});

describe('createInflightBodyBudget middleware', () => {
  it('admits a request under budget and reserves its declared Content-Length', () => {
    const budget = createInflightBodyBudget(1000, { perClientShare: 1 });
    const req = makeReq({ 'content-length': '400' });
    const { next, state } = run(budget, req);

    expect(next).toHaveBeenCalledTimes(1);
    expect(budget.currentBytes()).toBe(400);
    expect(state.code).toBe(0); // no response written
  });

  it('does not attach a data listener when a Content-Length was declared (stream left untouched)', () => {
    const budget = createInflightBodyBudget(1000, { perClientShare: 1 });
    const req = makeReq({ 'content-length': '400' });
    run(budget, req);
    expect(req.listenerCount('data')).toBe(0);
  });

  it('admits a request that lands exactly on the budget', () => {
    const budget = createInflightBodyBudget(1000, { perClientShare: 1 });
    run(budget, makeReq({ 'content-length': '600' }));
    const { next } = run(budget, makeReq({ 'content-length': '400' }));
    expect(next).toHaveBeenCalledTimes(1);
    expect(budget.currentBytes()).toBe(1000);
  });

  it('rejects with 503 + Retry-After, without reading the body, when the declared size would exceed the budget', () => {
    const budget = createInflightBodyBudget(1000, { perClientShare: 1 });
    run(budget, makeReq({ 'content-length': '800' }));

    const rejected = makeReq({ 'content-length': '300' });
    const { res, headers, state, next } = run(budget, rejected);

    expect(next).not.toHaveBeenCalled();
    expect(state.code).toBe(503);
    expect(headers['retry-after']).toBe('1');
    expect(headers['connection']).toBe('close');
    expect(state.payload).toEqual({
      statusCode: 503,
      message: 'Too much request body data in flight; retry later',
      error: 'Service Unavailable',
    });
    // Nothing was reserved for the rejected request and its stream was never tapped.
    expect(budget.currentBytes()).toBe(800);
    expect(rejected.listenerCount('data')).toBe(0);
    expect(res.listenerCount('finish')).toBe(0);
  });

  it('sends the configured Retry-After value', () => {
    const budget = createInflightBodyBudget(100, { retryAfterSeconds: 5, perClientShare: 1 });
    run(budget, makeReq({ 'content-length': '100' }));
    const { headers } = run(budget, makeReq({ 'content-length': '1' }));
    expect(headers['retry-after']).toBe('5');
  });

  it('admits a zero-length body even when the budget is fully used', () => {
    const budget = createInflightBodyBudget(1000, { perClientShare: 1 });
    run(budget, makeReq({ 'content-length': '1000' }));
    const { next } = run(budget, makeReq({ 'content-length': '0' }));
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('releases the reservation exactly once on normal completion', () => {
    const budget = createInflightBodyBudget(1000, { perClientShare: 1 });
    const req = makeReq({ 'content-length': '400' });
    const { res } = run(budget, req);

    res.emit('finish');
    expect(budget.currentBytes()).toBe(0);
    // Late terminal events from the same request must not double-decrement.
    res.emit('close');
    req.emit('close');
    expect(budget.currentBytes()).toBe(0);
  });

  it('releases exactly once on a client abort (request close before the response)', () => {
    const budget = createInflightBodyBudget(1000, { perClientShare: 1 });
    const req = makeReq({ 'content-length': '400' });
    const { res } = run(budget, req);

    req.emit('close');
    expect(budget.currentBytes()).toBe(0);
    res.emit('finish');
    res.emit('close');
    req.emit('error', new Error('late'));
    expect(budget.currentBytes()).toBe(0);
  });

  it('releases on stream errors (request or response side)', () => {
    const budget = createInflightBodyBudget(1000, { perClientShare: 1 });
    const reqA = makeReq({ 'content-length': '400' });
    run(budget, reqA);
    reqA.emit('error', new Error('boom'));
    expect(budget.currentBytes()).toBe(0);

    const reqB = makeReq({ 'content-length': '400' });
    const { res: resB } = run(budget, reqB);
    resB.emit('error', new Error('boom'));
    expect(budget.currentBytes()).toBe(0);
  });

  it('takes only an opening placeholder for chunk-encoded bodies and releases it on completion', () => {
    const budget = createInflightBodyBudget(1000, { perClientShare: 1 });
    const req = makeReq({ 'transfer-encoding': 'chunked' });
    const { res, next } = run(budget, req);

    expect(next).toHaveBeenCalledTimes(1);
    // Capped by the budget here (1 MiB placeholder > the 1000-byte test budget); the poller
    // reconciles it against real bytes, so a chunked body is never priced at a full slot.
    expect(budget.currentBytes()).toBe(1000);
    // The middleware must never tap the stream: a 'data' listener would switch it to flowing
    // mode and eat chunks before a late consumer (busboy attaches only after async guards).
    expect(req.listenerCount('data')).toBe(0);

    res.emit('finish');
    expect(budget.currentBytes()).toBe(0);
  });

  it('does not price a small chunked body at a whole per-request slot', () => {
    // Regression: reserving budget/4 up front turned the byte budget into a concurrency limit of 4
    // for chunked senders — four 6-byte uploads refused every further body-carrying request.
    const budget = createInflightBodyBudget(64 * 1024 * 1024, { perClientShare: 1 });
    for (let i = 0; i < 8; i++) {
      const { next } = run(budget, makeReq({ 'transfer-encoding': 'chunked' }));
      expect(next).toHaveBeenCalledTimes(1);
    }
    expect(budget.currentBytes()).toBe(8 * 1024 * 1024); // 8 × the 1 MiB placeholder, not 8 × 16 MiB
  });

  it('still refuses an un-declared body once the aggregate is exhausted', () => {
    const budget = createInflightBodyBudget(2 * 1024 * 1024, { perClientShare: 1 });
    for (let i = 0; i < 2; i++) {
      expect(run(budget, makeReq({ 'transfer-encoding': 'chunked' })).next).toHaveBeenCalledTimes(1);
    }
    const third = run(budget, makeReq({ 'transfer-encoding': 'chunked' }));
    expect(third.next).not.toHaveBeenCalled();
    expect(third.state.code).toBe(503);
  });

  it('reserves nothing for requests with neither Content-Length nor Transfer-Encoding', () => {
    const budget = createInflightBodyBudget(1000, { perClientShare: 1 });
    run(budget, makeReq({ 'content-length': '1000' }));
    // No body expected (health checks, GETs): admitted even with the budget fully reserved.
    const req = makeReq();
    const { next } = run(budget, req);
    expect(next).toHaveBeenCalledTimes(1);
    expect(budget.currentBytes()).toBe(1000);
    expect(req.listenerCount('data')).toBe(0);
  });

  describe('with the client map at capacity', () => {
    const fromIp = (ip: string, headers: Record<string, string> = {}): Request & EventEmitter => {
      const req = makeReq(headers);
      (req as unknown as { socket: { remoteAddress: string } }).socket.remoteAddress = ip;
      return req;
    };
    const saturated = (): InflightBodyBudget => {
      const budget = createInflightBodyBudget(1_000_000, { perClientShare: 1 });
      for (let i = 0; i < 10_000; i++) {
        const ip = `10.${Math.floor(i / 65536)}.${Math.floor(i / 256) % 256}.${i % 256}`;
        expect(run(budget, fromIp(ip, { 'content-length': '10' })).next).toHaveBeenCalledTimes(1);
      }
      expect(budget.currentBytes()).toBe(100_000);
      return budget;
    };

    it('still admits bodyless requests from a new client, without tracking them', () => {
      const budget = saturated();
      for (const headers of [{}, { 'content-length': '0' }] as Record<string, string>[]) {
        const req = fromIp('192.0.2.200', headers);
        const { next, state, res } = run(budget, req);
        expect(next).toHaveBeenCalledTimes(1);
        expect(state.code).toBe(0);
        expect(budget.clientBytes(req)).toBe(0);
        expect(req.listenerCount('close')).toBe(0);
        expect(res.listenerCount('finish')).toBe(0);
      }
      expect(budget.currentBytes()).toBe(100_000);
    });

    it('still refuses a body-carrying request from a new client', () => {
      const budget = saturated();
      const { next, state } = run(budget, fromIp('192.0.2.200', { 'content-length': '10' }));
      expect(next).not.toHaveBeenCalled();
      expect(state.code).toBe(503);
    });
  });

  it('drops the socket instead of writing a 503 when the response is already flushing', () => {
    const budget = createInflightBodyBudget(1000, { perClientShare: 1 });
    run(budget, makeReq({ 'content-length': '800' }));

    const req = makeReq({ 'content-length': '300' });
    const mock = makeRes();
    (mock.res as unknown as { headersSent: boolean }).headersSent = true;
    const next = jest.fn();

    expect(() => budget.middleware(req, mock.res, next)).not.toThrow();
    expect(next).not.toHaveBeenCalled();
    expect((req as unknown as { destroy: jest.Mock }).destroy).toHaveBeenCalledTimes(1);
    expect(mock.state.code).toBe(0); // no second response attempted
    expect(budget.currentBytes()).toBe(800); // nothing reserved for the rejected request
  });

  it('reuses freed budget for the next request (no leak across a full lifecycle)', () => {
    const budget = createInflightBodyBudget(1000, { perClientShare: 1 });
    for (let i = 0; i < 5; i++) {
      const req = makeReq({ 'content-length': '900' });
      const { res, next } = run(budget, req);
      expect(next).toHaveBeenCalledTimes(1);
      res.emit('finish');
      expect(budget.currentBytes()).toBe(0);
    }
  });
});

describe('anonymous tier', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  // Budget 1000 with a 250-byte body cap: the anonymous pool is max(2 x 250, 25% of 1000) = 500,
  // each anonymous IP's share is 250 and each key's share is half the budget, 500.
  const tiered = () => {
    const classify = jest.fn((req: Request) => {
      const key = req.headers['x-api-key'];
      return typeof key === 'string' ? `hash-${key}` : undefined;
    });
    return { budget: createInflightBodyBudget(1000, { classify, bodyLimitBytes: 250 }), classify };
  };
  const from = (ip: string, headers: Record<string, string>): Request & EventEmitter => {
    const req = makeReq(headers);
    (req as unknown as { socket: { remoteAddress: string } }).socket.remoteAddress = ip;
    return req;
  };

  it('keeps unrecognised requests inside their pool while a keyed request still gets in', () => {
    const { budget } = tiered();
    expect(run(budget, from('198.51.100.1', { 'content-length': '250' })).next).toHaveBeenCalledTimes(1);
    expect(run(budget, from('198.51.100.2', { 'content-length': '250' })).next).toHaveBeenCalledTimes(1);
    expect(budget.anonymousBytes()).toBe(500);

    // The aggregate has 500 free, but none of it is open to a third anonymous client.
    const refused = run(budget, from('198.51.100.3', { 'content-length': '10' }));
    expect(refused.next).not.toHaveBeenCalled();
    expect(refused.state.code).toBe(503);

    const keyed = run(budget, from('198.51.100.3', { 'content-length': '400', 'x-api-key': 'k1' }));
    expect(keyed.next).toHaveBeenCalledTimes(1);
    expect(budget.currentBytes()).toBe(900);
    expect(budget.anonymousBytes()).toBe(500);
  });

  it('leaves room for other unkeyed senders while one client holds a full-size body (defaults)', () => {
    const budget = createInflightBodyBudget(100 * MB, { classify: () => undefined, bodyLimitBytes: 25 * MB });
    const big = run(budget, from('198.51.100.1', { 'content-length': String(25 * MB) }));
    expect(big.next).toHaveBeenCalledTimes(1);
    // The same client gets no more than one full-size body.
    expect(run(budget, from('198.51.100.1', { 'content-length': '2048' })).state.code).toBe(503);

    // A small delivery from another address (an ingress webhook, say) still gets in.
    const other = run(budget, from('203.0.113.9', { 'content-length': '2048' }));
    expect(other.next).toHaveBeenCalledTimes(1);
    expect(budget.anonymousBytes()).toBe(25 * MB + 2048);
  });

  it('charges an anonymous body no more than the body cap, so the parser can still answer 413', () => {
    const { budget } = tiered();
    const { next, res } = run(budget, from('198.51.100.1', { 'content-length': '900' }));
    expect(next).toHaveBeenCalledTimes(1);
    expect(budget.currentBytes()).toBe(250);
    res.emit('finish');
    expect(budget.currentBytes()).toBe(0);
    expect(budget.anonymousBytes()).toBe(0);
  });

  it('shares per key across addresses, and per address never across keys', () => {
    const { budget } = tiered();
    expect(run(budget, from('198.51.100.1', { 'content-length': '400', 'x-api-key': 'k1' })).next).toHaveBeenCalled();
    const sameKey = run(budget, from('198.51.100.2', { 'content-length': '200', 'x-api-key': 'k1' }));
    expect(sameKey.state.code).toBe(503);
    const otherKey = run(budget, from('198.51.100.1', { 'content-length': '400', 'x-api-key': 'k2' }));
    expect(otherKey.next).toHaveBeenCalledTimes(1);
  });

  it('aborts an anonymous body whose growth crosses the pool, releasing every counter once', () => {
    // Budget 8 MiB, body cap 2 MiB: pool 4 MiB, 2 MiB per anonymous IP, 1 MiB chunked placeholder.
    const budget = createInflightBodyBudget(8 * MB, { classify: () => undefined, bodyLimitBytes: 2 * MB });
    const slow = from('198.51.100.1', { 'transfer-encoding': 'chunked' });
    const slowRes = run(budget, slow).res;
    const second = run(budget, from('198.51.100.2', { 'content-length': String(2 * MB) }));
    const third = run(budget, from('198.51.100.3', { 'content-length': String(MB) }));
    expect(second.next).toHaveBeenCalledTimes(1);
    expect(third.next).toHaveBeenCalledTimes(1);
    expect(budget.anonymousBytes()).toBe(4 * MB);

    // Within its own share and the aggregate, but past the pool.
    (slow as unknown as { socket: { bytesRead: number } }).socket.bytesRead = 1.5 * MB;
    jest.advanceTimersByTime(5_000);
    expect((slow as unknown as { destroy: jest.Mock }).destroy).toHaveBeenCalledTimes(1);
    slow.emit('close');
    slowRes.emit('finish');
    expect(budget.anonymousBytes()).toBe(3 * MB);
    expect(budget.clientBytes(slow)).toBe(0);

    second.res.emit('finish');
    third.res.emit('finish');
    expect(budget.anonymousBytes()).toBe(0);
    expect(budget.currentBytes()).toBe(0);
  });

  it('does not classify a request without a body', () => {
    const { budget, classify } = tiered();
    run(budget, from('198.51.100.1', { 'x-api-key': 'k1' }));
    expect(classify).not.toHaveBeenCalled();
  });

  it('keeps one pool with per-IP shares when no classifier is given', () => {
    const budget = createInflightBodyBudget(1000, { bodyLimitBytes: 250 });
    expect(run(budget, from('198.51.100.1', { 'content-length': '400' })).next).toHaveBeenCalledTimes(1);
    expect(run(budget, from('198.51.100.2', { 'content-length': '400' })).next).toHaveBeenCalledTimes(1);
    expect(budget.anonymousBytes()).toBe(0);
  });
});

describe('stall reaper', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const destroyMock = (req: Request): jest.Mock => (req as unknown as { destroy: jest.Mock }).destroy;

  it('reaps a stalled declared-length connection and releases its reservation', () => {
    const budget = createInflightBodyBudget(1000, { perClientShare: 1 });
    const req = makeReq({ 'content-length': '400' });
    run(budget, req);
    expect(budget.currentBytes()).toBe(400);

    // Headers sent, then silence: the reservation must not survive the stall timeout.
    jest.advanceTimersByTime(60_000);
    expect(destroyMock(req)).toHaveBeenCalledTimes(1);
    expect(budget.currentBytes()).toBe(0);

    // The freed budget is immediately usable again.
    const { next } = run(budget, makeReq({ 'content-length': '400' }));
    expect(next).toHaveBeenCalledTimes(1);
    expect(budget.currentBytes()).toBe(400);
  });

  it('reaps a stalled chunk-encoded connection the same way', () => {
    const budget = createInflightBodyBudget(1000, { perClientShare: 1 });
    const req = makeReq({ 'transfer-encoding': 'chunked' });
    run(budget, req);
    expect(budget.currentBytes()).toBe(1000);

    jest.advanceTimersByTime(60_000);
    expect(destroyMock(req)).toHaveBeenCalledTimes(1);
    expect(budget.currentBytes()).toBe(0);
  });

  it('does not reap a connection that keeps making progress, and keeps its declared size', () => {
    const budget = createInflightBodyBudget(1000, { perClientShare: 1 });
    const req = makeReq({ 'content-length': '400' });
    run(budget, req);
    const socket = (req as unknown as { socket: { bytesRead: number } }).socket;

    // Well past the stall timeout in total, but never idle for a whole timeout window.
    for (let i = 0; i < 20; i++) {
      jest.advanceTimersByTime(4_000);
      socket.bytesRead += 10; // stays below the declared 400, so only progress keeps it alive
    }
    expect(destroyMock(req)).not.toHaveBeenCalled();
    expect(budget.currentBytes()).toBe(400);
    expect(budget.clientBytes(req)).toBe(400);
  });

  describe('reservation of a slow body', () => {
    const socketOf = (req: Request): { bytesRead: number; remoteAddress: string } =>
      (req as unknown as { socket: { bytesRead: number; remoteAddress: string } }).socket;
    const trickle = (reqs: Request[], bytes: number, ms: number): void => {
      for (let t = 0; t < ms; t += 1_000) {
        jest.advanceTimersByTime(1_000);
        if ((t + 1_000) % 4_000 === 0) for (const r of reqs) socketOf(r).bytesRead += bytes;
      }
    };

    it('drops a declared body that falls behind the pace the request timeout allows, releasing it once', () => {
      const budget = createInflightBodyBudget(1000, { perClientShare: 1 });
      const req = makeReq({ 'content-length': '400' });
      const { res } = run(budget, req);

      // One byte every 4 s: never idle long enough for the stall reaper, far too slow to finish.
      trickle([req], 1, 20_000);
      expect(destroyMock(req)).toHaveBeenCalledTimes(1);
      expect(budget.currentBytes()).toBe(0);
      expect(budget.clientBytes(req)).toBe(0);

      // The terminal events the destroy triggers do not release it a second time.
      const other = makeReq({ 'content-length': '1000' });
      expect(run(budget, other).next).toHaveBeenCalledTimes(1);
      req.emit('close');
      res.emit('close');
      expect(budget.currentBytes()).toBe(1000);
    });

    it('keeps a declared body that arrives fast enough to finish within the request timeout', () => {
      const budget = createInflightBodyBudget(2000, { perClientShare: 1, requestTimeoutMs: 100_000 });
      const req = makeReq({ 'content-length': '1000' });
      run(budget, req);

      // 10 bytes/s finishes 1000 bytes in exactly the 100 s timeout.
      trickle([req], 40, 96_000);
      expect(destroyMock(req)).not.toHaveBeenCalled();
      expect(budget.currentBytes()).toBe(1000);
    });

    it('measures the pace against the configured request timeout', () => {
      const budget = createInflightBodyBudget(2000, { perClientShare: 1, requestTimeoutMs: 100_000 });
      const req = makeReq({ 'content-length': '1000' });
      run(budget, req);

      // Half the pace a 100 s timeout needs; the default 300 s timeout would still allow it.
      trickle([req], 20, 40_000);
      expect(destroyMock(req)).toHaveBeenCalledTimes(1);
      expect(budget.currentBytes()).toBe(0);
    });

    it('drops a chunked body that trickles below the pace its placeholder needs, releasing it once', () => {
      const budget = createInflightBodyBudget(2 * MB, { perClientShare: 1 });
      const req = makeReq({ 'transfer-encoding': 'chunked' });
      const { res } = run(budget, req);

      trickle([req], 1, 20_000);
      expect(destroyMock(req)).toHaveBeenCalledTimes(1);
      expect(budget.currentBytes()).toBe(0);
      expect(budget.clientBytes(req)).toBe(0);

      const other = makeReq({ 'content-length': String(2 * MB) });
      expect(run(budget, other).next).toHaveBeenCalledTimes(1);
      req.emit('close');
      res.emit('close');
      expect(budget.currentBytes()).toBe(2 * MB);
    });

    it('keeps a chunked body that stays on pace, and stops pacing it once it passes the placeholder', () => {
      const budget = createInflightBodyBudget(64 * MB, { perClientShare: 1, requestTimeoutMs: 100_000 });
      const req = makeReq({ 'transfer-encoding': 'chunked' });
      run(budget, req);

      // 10.5 KB/s delivers the 1 MiB placeholder inside the 100 s timeout, then keeps going past it.
      trickle([req], 42_000, 200_000);
      expect(destroyMock(req)).not.toHaveBeenCalled();
      expect(budget.currentBytes()).toBeGreaterThan(MB);
    });

    it('paces an anonymous chunked body against the smaller amount it is charged', () => {
      const budget = createInflightBodyBudget(MB, { classify: () => undefined, bodyLimitBytes: 64 * 1024 });
      const req = makeReq({ 'transfer-encoding': 'chunked' });
      run(budget, req);
      expect(budget.anonymousBytes()).toBe(64 * 1024);

      // 64 KiB in 300 s is about 220 B/s; 1 KiB every 4 s keeps up, 1 MiB in 300 s would not.
      trickle([req], 1024, 60_000);
      expect(destroyMock(req)).not.toHaveBeenCalled();
    });

    it('does not let trickling unkeyed chunked bodies hold the unkeyed pool past the pace window', () => {
      const budget = createInflightBodyBudget(100 * MB, { classify: () => undefined, bodyLimitBytes: 25 * MB });
      const held: Request[] = [];
      for (const ip of ['198.51.100.1', '198.51.100.2']) {
        for (let i = 0; i < 25; i++) {
          const req = makeReq({ 'transfer-encoding': 'chunked' });
          socketOf(req).remoteAddress = ip;
          expect(run(budget, req).next).toHaveBeenCalledTimes(1);
          held.push(req);
        }
      }
      expect(budget.anonymousBytes()).toBe(50 * MB);
      const early = makeReq({ 'content-length': '2000' });
      socketOf(early).remoteAddress = '203.0.113.9';
      expect(run(budget, early).state.code).toBe(503);

      trickle(held, 1, 20_000);
      for (const r of held) expect(destroyMock(r)).toHaveBeenCalledTimes(1);
      expect(budget.anonymousBytes()).toBe(0);
      const late = makeReq({ 'content-length': '2000' });
      socketOf(late).remoteAddress = '203.0.113.9';
      expect(run(budget, late).next).toHaveBeenCalledTimes(1);
    });

    it('keeps a client share held by trickling requests', () => {
      const budget = createInflightBodyBudget(1000); // share 0.5 -> cap 500
      const a = makeReq({ 'content-length': '250' });
      const b = makeReq({ 'content-length': '250' });
      run(budget, a);
      run(budget, b);

      trickle([a, b], 1, 16_000);
      expect(budget.clientBytes(a)).toBe(500);
      expect(run(budget, makeReq({ 'content-length': '200' })).state.code).toBe(503);

      // Once they fall behind the pace the request timeout allows, both are dropped and the share frees.
      trickle([a, b], 1, 10_000);
      expect(destroyMock(a)).toHaveBeenCalledTimes(1);
      expect(destroyMock(b)).toHaveBeenCalledTimes(1);
      expect(budget.clientBytes(a)).toBe(0);
      expect(run(budget, makeReq({ 'content-length': '200' })).next).toHaveBeenCalledTimes(1);
    });

    it('never lets trickling bodies that complete together exceed the budget', () => {
      const budget = createInflightBodyBudget(1000, { perClientShare: 1 });
      const live: Request[] = [];
      // A new 200-byte body every second for two minutes, each trickling one byte every 4 s.
      for (let s = 1; s <= 120; s++) {
        const req = makeReq({ 'content-length': '200' });
        socketOf(req).remoteAddress = `198.51.100.${s}`;
        if (run(budget, req).next.mock.calls.length > 0) live.push(req);
        jest.advanceTimersByTime(1_000);
        if (s % 4 === 0) for (const r of live) socketOf(r).bytesRead += 4;
      }

      // Every live body then lands before the next poll.
      for (const r of live) {
        socketOf(r).bytesRead = 200;
        (r as unknown as { complete: boolean }).complete = true;
      }
      jest.advanceTimersByTime(5_000);
      expect(budget.currentBytes()).toBeLessThanOrEqual(1000);
      expect(live).toHaveLength(5);
      for (const r of live) expect(destroyMock(r)).not.toHaveBeenCalled();
    });

    it('refuses a new body while a trickling one holds its declaration, and settles it at its size', () => {
      const budget = createInflightBodyBudget(1000, { perClientShare: 1 });
      const req = makeReq({ 'content-length': '400' });
      const { res } = run(budget, req);
      trickle([req], 5, 16_000);
      expect(budget.currentBytes()).toBe(400);
      expect(run(budget, makeReq({ 'content-length': '900' })).state.code).toBe(503);

      // The rest of the body lands between polls and Node marks the message complete.
      socketOf(req).bytesRead = 400;
      (req as unknown as { complete: boolean }).complete = true;
      jest.advanceTimersByTime(5_000);
      expect(destroyMock(req)).not.toHaveBeenCalled();
      expect(budget.currentBytes()).toBe(400);

      res.emit('finish');
      expect(budget.currentBytes()).toBe(0);
    });
  });

  it('stops reaping once the declared body has fully arrived', () => {
    const budget = createInflightBodyBudget(1000, { perClientShare: 1 });
    const req = makeReq({ 'content-length': '400' });
    const { res } = run(budget, req);
    (req as unknown as { socket: { bytesRead: number } }).socket.bytesRead = 400;

    jest.advanceTimersByTime(120_000); // body arrived; a slow handler is not a stalled sender
    expect(destroyMock(req)).not.toHaveBeenCalled();
    expect(budget.currentBytes()).toBe(400);

    res.emit('finish');
    expect(budget.currentBytes()).toBe(0);
  });

  it('stops reaping once the downstream consumer finished reading (end)', () => {
    const budget = createInflightBodyBudget(1000, { perClientShare: 1 });
    const req = makeReq({ 'transfer-encoding': 'chunked' });
    const { res } = run(budget, req);

    // A finished chunked body is priced at what arrived, not the opening placeholder.
    (req as unknown as { socket: { bytesRead: number } }).socket.bytesRead = 300;
    req.emit('end');
    jest.advanceTimersByTime(120_000);
    expect(destroyMock(req)).not.toHaveBeenCalled();
    expect(budget.currentBytes()).toBe(300);

    res.emit('finish');
    expect(budget.currentBytes()).toBe(0);
  });

  it('reconciles a chunked reservation with the bytes that actually arrive', () => {
    const budget = createInflightBodyBudget(64 * 1024 * 1024, { perClientShare: 1 });
    const req = makeReq({ 'transfer-encoding': 'chunked' });
    run(budget, req);
    expect(budget.currentBytes()).toBe(1024 * 1024); // opening placeholder

    const socket = (req as unknown as { socket: { bytesRead: number } }).socket;
    socket.bytesRead = 5 * 1024 * 1024;
    jest.advanceTimersByTime(5_000);
    expect(budget.currentBytes()).toBe(5 * 1024 * 1024); // now priced at its real weight
  });

  it('aborts an un-declared body that streams past the aggregate budget', () => {
    const budget = createInflightBodyBudget(2 * 1024 * 1024, { perClientShare: 1 });
    const req = makeReq({ 'transfer-encoding': 'chunked' });
    run(budget, req);

    (req as unknown as { socket: { bytesRead: number } }).socket.bytesRead = 3 * 1024 * 1024;
    jest.advanceTimersByTime(5_000);
    expect(destroyMock(req)).toHaveBeenCalledTimes(1);
    expect(budget.currentBytes()).toBe(0);
  });

  // The per-client share: the DoS bound is per ATTACKER, not per deployment. The spec doubles
  // share one remoteAddress, so every request here comes from the same client.
  describe('per-client share of the budget', () => {
    const runFrom = (budget: InflightBodyBudget, ip: string, headers: Record<string, string>) => {
      const req = makeReq(headers);
      (req as unknown as { socket: { bytesRead: number; remoteAddress: string } }).socket = {
        bytesRead: 0,
        remoteAddress: ip,
      };
      return run(budget, req);
    };

    it('refuses a SECOND client request once that client holds its share, while a different client is still admitted', () => {
      const budget = createInflightBodyBudget(1000); // default share 0.5 -> cap 500
      const { next: firstOk } = runFrom(budget, '198.51.100.1', { 'content-length': '400' });
      expect(firstOk).toHaveBeenCalledTimes(1);

      // Same client, over its 500-byte share now.
      const { next: refused, state } = runFrom(budget, '198.51.100.1', { 'content-length': '200' });
      expect(refused).not.toHaveBeenCalled();
      expect(state.code).toBe(503);

      // A different client sails through - the whole aggregate is still theirs to use.
      const { next: other } = runFrom(budget, '198.51.100.2', { 'content-length': '400' });
      expect(other).toHaveBeenCalledTimes(1);
    });

    it('keys an IPv6 client on its /64, so a rotated address draws on the same share', () => {
      const budget = createInflightBodyBudget(1000);
      const { next: firstOk } = runFrom(budget, '2001:db8:1:2::a', { 'content-length': '400' });
      expect(firstOk).toHaveBeenCalledTimes(1);

      const { next: sameSubnet, state } = runFrom(budget, '2001:db8:1:2::b', { 'content-length': '200' });
      expect(sameSubnet).not.toHaveBeenCalled();
      expect(state.code).toBe(503);

      const probe = makeReq();
      (probe as unknown as { socket: { remoteAddress: string } }).socket.remoteAddress = '2001:db8:1:2::ffff';
      expect(budget.clientBytes(probe as never)).toBe(400);

      const { next: otherSubnet } = runFrom(budget, '2001:db8:1:3::a', { 'content-length': '400' });
      expect(otherSubnet).toHaveBeenCalledTimes(1);
    });

    it('releases the client ledger exactly once: a finished body frees the share', () => {
      const budget = createInflightBodyBudget(1000);
      const { res } = runFrom(budget, '198.51.100.1', { 'content-length': '400' });
      res.emit('finish');
      const { next } = runFrom(budget, '198.51.100.1', { 'content-length': '400' });
      expect(next).toHaveBeenCalledTimes(1);
      expect(budget.clientBytes(makeReq() as never)).toBe(0);
    });

    it('X-Forwarded-For is IGNORED without trusted proxies (share keys on the socket address)', () => {
      const budget = createInflightBodyBudget(1000);
      const reqA = makeReq({ 'content-length': '400', 'x-forwarded-for': '192.0.2.1' });
      const a = run(budget, reqA);
      const reqB = makeReq({ 'content-length': '400', 'x-forwarded-for': '192.0.2.2' });
      const b = run(budget, reqB);
      // Both share one socket address -> one share -> the second is over the cap.
      expect(a.next).toHaveBeenCalledTimes(1);
      expect(b.next).not.toHaveBeenCalled();
    });

    it('X-Forwarded-For keys the share when the proxy is trusted', () => {
      const budget = createInflightBodyBudget(1000, { trustedProxies: ['127.0.0.1'] });
      const base = { 'x-forwarded-for': '', 'content-length': '400' };
      const reqA = makeReq({ ...base, 'x-forwarded-for': '192.0.2.1' });
      (reqA as unknown as { socket: { bytesRead: number; remoteAddress: string } }).socket = {
        bytesRead: 0,
        remoteAddress: '127.0.0.1',
      };
      const reqB = makeReq({ ...base, 'x-forwarded-for': '192.0.2.2' });
      (reqB as unknown as { socket: { bytesRead: number; remoteAddress: string } }).socket = {
        bytesRead: 0,
        remoteAddress: '127.0.0.1',
      };
      expect(run(budget, reqA).next).toHaveBeenCalledTimes(1);
      expect(run(budget, reqB).next).toHaveBeenCalledTimes(1);
    });

    it('perClientShare: 1 restores single-client use of the whole budget', () => {
      const budget = createInflightBodyBudget(1000, { perClientShare: 1 });
      expect(runFrom(budget, '198.51.100.1', { 'content-length': '600' }).next).toHaveBeenCalledTimes(1);
      expect(runFrom(budget, '198.51.100.1', { 'content-length': '400' }).next).toHaveBeenCalledTimes(1);
    });

    it('aborts a chunked body that crosses its client share mid-stream', () => {
      const budget = createInflightBodyBudget(10 * 1024 * 1024); // cap 5 MiB
      const req = makeReq({ 'transfer-encoding': 'chunked' });
      run(budget, req);

      (req as unknown as { socket: { bytesRead: number } }).socket.bytesRead = 6 * 1024 * 1024;
      jest.advanceTimersByTime(5_000);
      expect(destroyMock(req)).toHaveBeenCalledTimes(1);
      expect(budget.currentBytes()).toBe(0);
      expect(budget.clientBytes(req as never)).toBe(0);
    });
  });

  it('does not reap a fully-received request whose body no parser consumed', () => {
    // The body can arrive in the same segment as the headers, so socket.bytesRead never moves again
    // and 'end' never fires when no parser reads the stream. Killing that request at the stall
    // timeout would drop a healthy connection mid-handler.
    const budget = createInflightBodyBudget(1000, { perClientShare: 1 });
    const req = makeReq({ 'content-length': '400' });
    const { res } = run(budget, req);
    (req as unknown as { complete: boolean }).complete = true;

    jest.advanceTimersByTime(120_000);
    expect(destroyMock(req)).not.toHaveBeenCalled();
    expect(budget.currentBytes()).toBe(400);

    res.emit('finish');
    expect(budget.currentBytes()).toBe(0);
  });

  it('never arms the reaper for requests without a body', () => {
    const budget = createInflightBodyBudget(1000, { perClientShare: 1 });
    const getReq = makeReq();
    const emptyReq = makeReq({ 'content-length': '0' });
    run(budget, getReq);
    run(budget, emptyReq);

    jest.advanceTimersByTime(120_000);
    expect(destroyMock(getReq)).not.toHaveBeenCalled();
    expect(destroyMock(emptyReq)).not.toHaveBeenCalled();
  });
});

/**
 * Compressed bodies, exercised over a REAL server with a RAW http client. The doubles above hand the
 * middleware a header bag and never move a byte, so they cannot show what a compressed body costs
 * once the parser inflates it. A raw client (rather than an assertion library) is deliberate: the
 * exact bytes on the wire are the subject here, and a serializer that helpfully re-encodes a Buffer
 * would test itself instead of the middleware.
 */
describe('compressed request bodies', () => {
  const BUDGET = 64 * 1024;
  /** Compresses ~1000:1, so its declared length is a small fraction of what inflating it costs. */
  const INFLATED_PAYLOAD = Buffer.from(JSON.stringify({ data: 'a'.repeat(2 * MB) }));

  let server: Server | undefined;
  let budget: InflightBodyBudget;
  let port = 0;

  const listen = async (): Promise<void> => {
    budget = createInflightBodyBudget(BUDGET);
    const app = express();
    app.use(budget.middleware);
    app.use(json({ limit: '25mb' }));
    app.post('/echo', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    server = createServer(app);
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  };

  interface Reply {
    status: number;
    body: string;
  }

  /**
   * Resolves on the response even when the server drops the socket mid-upload — which is exactly
   * what a refusal does here (it answers, sets Connection: close and never reads the body), so a
   * client that treated the reset as fatal could not observe the status it is meant to assert.
   */
  const send = (headers: Record<string, string>, body: Buffer): Promise<Reply> =>
    new Promise((resolve, reject) => {
      let reply: Reply | undefined;
      const req = httpRequest({ host: '127.0.0.1', port, path: '/echo', method: 'POST', headers }, res => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          reply = { status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() };
          resolve(reply);
        });
      });
      req.on('error', (error: NodeJS.ErrnoException) => {
        if (reply) return;
        // A refusal answers and drops the socket without reading the body, so the reset can beat
        // the parsed response. Settle with a sentinel rather than swallowing it: a bare timeout
        // would report as "test timed out" instead of "expected 415, got a connection reset".
        if (error.code === 'ECONNRESET' || error.code === 'EPIPE') {
          resolve({ status: 0, body: '' });
          return;
        }
        reject(error);
      });
      req.end(body);
    });

  beforeEach(() => jest.useRealTimers());
  afterEach(async () => {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;
  });

  it('refuses a gzip-encoded body with 415 instead of admitting it on its compressed length', async () => {
    await listen();
    const gzipped = gzipSync(INFLATED_PAYLOAD);
    // The premise: compressed, this body is small enough to sail through admission control.
    expect(gzipped.length).toBeLessThan(BUDGET);
    expect(INFLATED_PAYLOAD.length).toBeGreaterThan(BUDGET);

    const reply = await send(
      {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
        'Content-Length': String(gzipped.length),
      },
      gzipped,
    );

    expect(reply.status).toBe(415);
    expect(JSON.parse(reply.body)).toEqual({
      statusCode: 415,
      message: 'Compressed request bodies are not supported',
      error: 'Unsupported Media Type',
    });
    expect(budget.currentBytes()).toBe(0);
  });

  it('refuses an oversized UNCOMPRESSED body through the budget, not the encoding guard', async () => {
    await listen();
    const plain = Buffer.alloc(BUDGET + 1, 0x20);

    const reply = await send({ 'Content-Type': 'application/json', 'Content-Length': String(plain.length) }, plain);

    expect(reply.status).toBe(503);
  });

  it('refuses a compressed body whose Content-Length is zero', async () => {
    await listen();

    // `reserved` is 0 here, so a gate keyed on the reservation would wave this through to the
    // parser and the client would get body-parser's HTML error instead of the documented shape.
    const reply = await send(
      { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': '0' },
      Buffer.alloc(0),
    );

    expect(reply.status).toBe(415);
    expect((JSON.parse(reply.body) as { error?: string }).error).toBe('Unsupported Media Type');
  });

  it('refuses a compressed body whose Content-Length is not a safe integer', async () => {
    await listen();
    const gzipped = gzipSync(INFLATED_PAYLOAD);

    // parseDeclaredLength refuses to reserve for this, but type-is `hasBody` still hands it to the
    // parser — the one shape that escaped both the reservation AND admission control.
    const reply = await send(
      {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
        'Content-Length': String(Number.MAX_SAFE_INTEGER + 2),
      },
      gzipped,
    );

    expect(reply.status).toBe(415);
    expect((JSON.parse(reply.body) as { error?: string }).error).toBe('Unsupported Media Type');
  });

  it('refuses an encoding LIST, matching what the parser would do with it', async () => {
    await listen();
    const plain = Buffer.from(JSON.stringify({ data: 'small' }));

    // "identity, identity" transforms nothing, but body-parser compares the whole header against
    // 'identity' and refuses it — so the middleware refuses it too and both layers answer the same
    // documented shape instead of disagreeing about who rejects it.
    const reply = await send(
      {
        'Content-Type': 'application/json',
        'Content-Encoding': 'identity, identity',
        'Content-Length': String(plain.length),
      },
      plain,
    );

    expect(reply.status).toBe(415);
    expect((JSON.parse(reply.body) as { error?: string }).error).toBe('Unsupported Media Type');
  });

  it('admits an ordinary body declaring Content-Encoding: identity', async () => {
    await listen();
    const plain = Buffer.from(JSON.stringify({ data: 'small' }));

    const reply = await send(
      {
        'Content-Type': 'application/json',
        'Content-Encoding': 'identity',
        'Content-Length': String(plain.length),
      },
      plain,
    );

    expect(reply.status).toBe(200);
  });
});

/**
 * The `inflate: false` backstop is unreachable while the guard above stands, so no behavioural test
 * can lock it — yet it is the only thing standing if the guard is ever bypassed. Assert it in the
 * source instead, the way load-env.spec.ts locks main.ts's import order.
 */
describe('body-parser inflate backstop', () => {
  const read = (relative: string): string => readFileSync(resolve(__dirname, relative), 'utf8');

  it('disables inflate on both global parsers', () => {
    // The parsers live in configure-app.ts, which is where the production stack is assembled; they
    // sat inline in main.ts until that stack was extracted so the e2e lane could run it too.
    const source = read('../configure-app.ts');

    expect(source.match(/^\s+inflate: false,$/gm)).toHaveLength(2);
  });

  it('mirrors the global cap and disabled inflate on the MCP route-level fallback parser', () => {
    expect(read('../modules/mcp/mcp.server.ts')).toContain('express.json({ limit: bodyLimit, inflate: false })');
  });
});
