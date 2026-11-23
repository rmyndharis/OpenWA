import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Agent as HttpAgent, createServer, request as httpRequest, Server } from 'http';
import { AddressInfo, connect as netConnect } from 'net';
import { gzipSync } from 'zlib';
import express, { Request, Response, json, urlencoded } from 'express';
import multer from 'multer';
import {
  createInflightBodyBudget,
  parseBodyLimitBytes,
  resolveInflightBodyBudgetBytes,
  InflightBodyBudget,
} from './inflight-body-budget';
import { LoggerService, LogFormat } from '../common/services/logger.service';

const MB = 1024 * 1024;

/** Every request a case made: each is closed after the case, so the stall reaper armed for an admitted one ends with it. */
const made: Array<Request & EventEmitter> = [];

/** Minimal req/res doubles: real EventEmitters so the middleware's listener accounting runs as-is. */
const makeReq = (headers: Record<string, string> = {}): Request & EventEmitter => {
  const req = new EventEmitter() as unknown as Request & EventEmitter;
  made.push(req);
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

// A dropped request leaves one warning. JSON output keeps the fields parseable, and the spy keeps the reaper tests quiet.
let warn: jest.SpyInstance;
beforeEach(() => {
  LoggerService.setLogFormat(LogFormat.JSON);
  warn = jest.spyOn(console, 'warn').mockImplementation();
});
afterEach(() => {
  // A request left open keeps its unref'd 5 s reaper alive; when the pace check drops it later the warning is written
  // outside any case, after the console spy is gone. Under fake timers the restored clock retires the reaper instead.
  for (const req of made.splice(0)) req.emit('close');
  warn.mockRestore();
  LoggerService.setLogFormat(null);
});
const dropLines = (): Array<Record<string, unknown>> =>
  (warn.mock.calls as unknown[][]).map(call => JSON.parse(String(call[0])) as Record<string, unknown>);

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

  it('answers 413 without Retry-After, on an idle server, for a declared body that could never be admitted', () => {
    // Default share 0.5 -> a 500-byte per-client cap: 600 bytes would never fit, however long the client waits.
    const budget = createInflightBodyBudget(1000);
    const rejected = makeReq({ 'content-length': '600' });
    const { res, headers, state, next } = run(budget, rejected);

    expect(next).not.toHaveBeenCalled();
    expect(state.code).toBe(413);
    expect(headers['retry-after']).toBeUndefined();
    expect(headers['connection']).toBe('close');
    expect(state.payload).toEqual({
      statusCode: 413,
      message: 'Request body exceeds what this server can accept',
      error: 'Payload Too Large',
    });
    expect(budget.currentBytes()).toBe(0);
    expect(res.listenerCount('finish')).toBe(0);
  });

  it('answers 413 for an unkeyed body declared above the whole budget', () => {
    const budget = createInflightBodyBudget(1000, { classify: () => undefined, bodyLimitBytes: 250 });
    const { state, headers } = run(budget, makeReq({ 'content-length': '1001' }));
    expect(state.code).toBe(413);
    expect(headers['retry-after']).toBeUndefined();
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

  it('reaps a body that stops after part of it arrived, long before the pace check would', () => {
    // 10 MiB of a 20 MiB body lands in the first seconds and then nothing does. The pace the request
    // timeout allows is still far below what has arrived, so only the stall rule can release it.
    const budget = createInflightBodyBudget(100 * MB, { perClientShare: 1 });
    const req = makeReq({ 'content-length': String(20 * MB) });
    run(budget, req);
    const socket = (req as unknown as { socket: { bytesRead: number } }).socket;

    jest.advanceTimersByTime(1_000);
    socket.bytesRead = 10 * MB;
    jest.advanceTimersByTime(5_000);
    expect(destroyMock(req)).not.toHaveBeenCalled();
    expect(budget.currentBytes()).toBe(20 * MB);

    // 15 s of silence since the poll that saw the last byte, plus one poll to notice it.
    jest.advanceTimersByTime(25_000);
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

    // A finished chunked body keeps at least its opening placeholder until the request is released.
    (req as unknown as { socket: { bytesRead: number } }).socket.bytesRead = 300;
    req.emit('end');
    jest.advanceTimersByTime(120_000);
    expect(destroyMock(req)).not.toHaveBeenCalled();
    expect(budget.currentBytes()).toBe(1000);

    res.emit('finish');
    expect(budget.currentBytes()).toBe(0);
  });

  it('keeps pricing a chunked body that arrived with its headers while the handler still holds it', () => {
    const budget = createInflightBodyBudget(1000, { perClientShare: 1 });
    const req = makeReq({ 'transfer-encoding': 'chunked' });
    // The middleware runs inside the parse of the read that carried the headers, so the socket counter
    // already includes a body sent in the same write: nothing more "arrives" after admission.
    (req as unknown as { socket: { bytesRead: number } }).socket.bytesRead = 600;
    const { res } = run(budget, req);

    req.emit('end');
    expect(budget.currentBytes()).toBe(1000);
    (req as unknown as { complete: boolean }).complete = true;
    jest.advanceTimersByTime(10_000);
    expect(budget.currentBytes()).toBe(1000);

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

describe('a request the budget drops', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const socketOf = (req: Request): { bytesRead: number; remoteAddress: string } =>
    (req as unknown as { socket: { bytesRead: number; remoteAddress: string } }).socket;
  const destroyMock = (req: Request): jest.Mock => (req as unknown as { destroy: jest.Mock }).destroy;

  it('logs why, for whom, how much and where, without the query string or the stored key', () => {
    const budget = createInflightBodyBudget(1000, { perClientShare: 1, classify: () => 'stored-key-hash' });
    const req = makeReq({ 'content-length': '400' });
    (req as unknown as { originalUrl: string }).originalUrl = '/api/sessions/s1/messages/send-video?apiKey=leaked&x=1';
    run(budget, req);

    jest.advanceTimersByTime(60_000);

    expect(destroyMock(req)).toHaveBeenCalledTimes(1);
    expect(dropLines()).toEqual([
      expect.objectContaining({
        level: 'warn',
        context: 'InflightBodyBudget',
        reason: 'stall',
        client: '203.0.113.7',
        keyed: true,
        declaredBytes: 400,
        receivedBytes: 0,
        path: '/api/sessions/s1/messages/send-video',
      }),
    ]);
    const text = JSON.stringify(warn.mock.calls);
    expect(text).not.toContain('stored-key-hash');
    expect(text).not.toContain('leaked');
  });

  // The limiter keys an IPv6 client by its /64; the log names the address the operator can act on.
  it('logs the full address of an IPv6 client, not the /64 its limiter key is', () => {
    const budget = createInflightBodyBudget(1000, { perClientShare: 1 });
    const req = makeReq({ 'content-length': '400' });
    (socketOf(req) as unknown as { remoteAddress: string }).remoteAddress = '2001:db8:1:2:3:4:5:6';
    run(budget, req);

    jest.advanceTimersByTime(60_000);

    expect(dropLines()).toEqual([expect.objectContaining({ reason: 'stall', client: '2001:db8:1:2:3:4:5:6' })]);
  });

  it('names the pace when a body keeps trickling but falls too far behind to finish in time', () => {
    const budget = createInflightBodyBudget(1000, { perClientShare: 1 });
    const req = makeReq({ 'content-length': '400' });
    run(budget, req);

    // One byte every 4 s: never idle long enough for the stall rule, far too slow to finish.
    for (let seconds = 0; seconds < 20; seconds += 4) {
      jest.advanceTimersByTime(4_000);
      socketOf(req).bytesRead += 1;
    }

    expect(destroyMock(req)).toHaveBeenCalledTimes(1);
    expect(dropLines().map(line => line.reason)).toEqual(['pace']);
  });

  describe('when a chunked body outgrows what it may hold', () => {
    const grow = (req: Request, bytes: number): void => {
      socketOf(req).bytesRead = bytes;
      jest.advanceTimersByTime(5_000);
    };

    it('names the client share', () => {
      const budget = createInflightBodyBudget(10 * MB); // share 5 MiB
      const req = makeReq({ 'transfer-encoding': 'chunked' });
      run(budget, req);

      grow(req, 6 * MB);

      expect(dropLines().map(line => line.reason)).toEqual(['share']);
    });

    it('names the aggregate budget when other bodies hold the rest of it', () => {
      const budget = createInflightBodyBudget(4 * MB, { perClientShare: 1 });
      const other = makeReq({ 'content-length': String(2 * MB) });
      socketOf(other).remoteAddress = '198.51.100.9';
      run(budget, other);
      const req = makeReq({ 'transfer-encoding': 'chunked' });
      run(budget, req);

      grow(req, 2.5 * MB);

      expect(destroyMock(req)).toHaveBeenCalledTimes(1);
      expect(dropLines().map(line => line.reason)).toEqual(['budget']);
    });

    it('names the unkeyed pool', () => {
      // Budget 8 MiB, body cap 2 MiB: the unkeyed pool is 4 MiB and one unkeyed address may hold 2 MiB.
      const budget = createInflightBodyBudget(8 * MB, { classify: () => undefined, bodyLimitBytes: 2 * MB });
      const req = makeReq({ 'transfer-encoding': 'chunked' });
      run(budget, req);
      for (const [ip, size] of [
        ['198.51.100.2', 2 * MB],
        ['198.51.100.3', MB],
      ] as const) {
        const other = makeReq({ 'content-length': String(size) });
        socketOf(other).remoteAddress = ip;
        run(budget, other);
      }

      grow(req, 1.5 * MB);

      expect(destroyMock(req)).toHaveBeenCalledTimes(1);
      expect(dropLines().map(line => line.reason)).toEqual(['pool']);
    });
  });

  it('logs at most ten drops a minute, however many addresses they come from', () => {
    const budget = createInflightBodyBudget(10_000, { perClientShare: 1 });
    for (let i = 0; i < 12; i++) {
      const req = makeReq({ 'content-length': '10' });
      socketOf(req).remoteAddress = `198.51.100.${i + 1}`;
      run(budget, req);
    }

    jest.advanceTimersByTime(30_000);
    expect(budget.currentBytes()).toBe(0);
    expect(dropLines()).toHaveLength(10);

    // The window slides: a later drop is logged again.
    jest.advanceTimersByTime(60_000);
    run(budget, makeReq({ 'content-length': '10' }));
    jest.advanceTimersByTime(30_000);
    expect(dropLines()).toHaveLength(11);
  });

  it('logs the drop of a socket that could not be answered because a response had already started', () => {
    const budget = createInflightBodyBudget(1000, { perClientShare: 1 });
    run(budget, makeReq({ 'content-length': '800' }));
    const req = makeReq({ 'content-length': '300' });
    (req as unknown as { originalUrl: string }).originalUrl = '/api/upload';
    const mock = makeRes();
    (mock.res as unknown as { headersSent: boolean }).headersSent = true;

    budget.middleware(req, mock.res, jest.fn());

    expect(destroyMock(req)).toHaveBeenCalledTimes(1);
    expect(dropLines()).toEqual([
      expect.objectContaining({ reason: 'refused', client: '203.0.113.7', declaredBytes: 300, path: '/api/upload' }),
    ]);
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

    // Larger than the whole budget, so it could never be admitted: 413, not a retryable 503.
    expect(reply.status).toBe(413);
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

describe('chunked body incremental accounting and keep-alive over real HTTP', () => {
  const servers: Server[] = [];

  beforeEach(() => jest.useRealTimers());
  afterEach(async () => {
    for (const srv of servers.splice(0)) {
      srv.closeAllConnections();
      await new Promise<void>(resolve => srv.close(() => resolve()));
    }
  });

  const startApp = async (
    budget: InflightBodyBudget,
  ): Promise<{ port: number; received: Array<{ path: string; bytes: number }> }> => {
    const received: Array<{ path: string; bytes: number }> = [];
    const app = express();
    app.use((req, _res, next) => {
      // Never attach a 'data' listener to IncomingMessage itself.
      const origOn = req.on.bind(req);
      let sawBudget = false;
      req.on = ((event: string, fn: (...args: unknown[]) => void) => {
        if (sawBudget && event === 'data') {
          throw new Error('unexpected data listener attached to req');
        }
        return origOn(event, fn);
      }) as typeof req.on;
      budget.middleware(req, _res, () => {
        sawBudget = false;
        req.on = origOn;
        next();
      });
      sawBudget = true;
    });
    app.use(json({ limit: '25mb' }));
    app.use(urlencoded({ extended: true, limit: '25mb' }));
    const upload = multer();
    app.post('/json', (req, res) => {
      const len =
        typeof (req.body as { data?: unknown })?.data === 'string' ? (req.body as { data: string }).data.length : 0;
      received.push({ path: '/json', bytes: len });
      res.status(200).json({ bytes: len });
    });
    app.post('/form', (req, res) => {
      const len =
        typeof (req.body as { data?: unknown })?.data === 'string' ? (req.body as { data: string }).data.length : 0;
      received.push({ path: '/form', bytes: len });
      res.status(200).json({ bytes: len });
    });
    app.post('/multipart', upload.single('file'), (req, res) => {
      const len = req.file?.buffer.length ?? 0;
      received.push({ path: '/multipart', bytes: len });
      res.status(200).json({ bytes: len });
    });
    app.use((err: unknown, _req: Request, res: Response, _next: unknown) => {
      void _req;
      void _next;
      if (!res.headersSent) res.status(400).json({ error: String(err) });
    });

    const srv = createServer(app);
    servers.push(srv);
    await new Promise<void>(resolve => srv.listen(0, '127.0.0.1', resolve));
    return { port: (srv.address() as AddressInfo).port, received };
  };

  it('drops excess concurrent 6 x 1.90 MiB chunked POSTs completing in <1 s under a 10 MiB budget', async () => {
    const budget = createInflightBodyBudget(10 * MB, { perClientShare: 1 });
    const { port } = await startApp(budget);

    const payload = JSON.stringify({ data: 'a'.repeat(Math.floor(1.9 * MB) - 11) });
    const firstStageLen = Math.floor(1.85 * MB);
    const chunkSize = 256 * 1024;
    const t0 = Date.now();

    const clients = Array.from({ length: 6 }, () => {
      let settled = false;
      let finish!: (result: { status: number; buffered: boolean }) => void;
      const done = new Promise<{ status: number; buffered: boolean }>(res => (finish = res));
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/json',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
        },
        res => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            if (settled) return;
            settled = true;
            finish({ status: res.statusCode ?? 0, buffered: res.statusCode === 200 });
          });
        },
      );
      req.on('error', () => {
        if (settled) return;
        settled = true;
        finish({ status: 0, buffered: false });
      });
      return { req, done };
    });

    // Stream first 1.85 MiB concurrently on all 6 before any sends its terminating chunk.
    await Promise.all(
      clients.map(
        ({ req }) =>
          new Promise<void>(resolve => {
            let offset = 0;
            const writeNext = (): void => {
              if (req.destroyed || offset >= firstStageLen) {
                resolve();
                return;
              }
              const nextOffset = Math.min(firstStageLen, offset + chunkSize);
              req.write(payload.slice(offset, nextOffset), () => {
                offset = nextOffset;
                setTimeout(writeNext, 2);
              });
            };
            writeNext();
          }),
      ),
    );

    // Send final 0.05 MiB chunk on any surviving connections.
    for (const { req } of clients) {
      if (!req.destroyed) req.end(payload.slice(firstStageLen));
    }

    const results = await Promise.all(clients.map(c => c.done));
    const elapsedMs = Date.now() - t0;

    expect(elapsedMs).toBeLessThan(1000);
    const okCount = results.filter(r => r.status === 200).length;
    const droppedCount = results.filter(r => r.status !== 200).length;
    expect(okCount).toBeLessThan(6);
    expect(droppedCount).toBeGreaterThanOrEqual(1);
    expect(budget.currentBytes()).toBe(0);
  });

  it('drops excess unkeyed chunked POSTs mid-stream when crossing the 4 MiB anonymous pool in <1 s', async () => {
    const budget = createInflightBodyBudget(10 * MB, {
      classify: () => undefined,
      bodyLimitBytes: 2 * MB,
      trustedProxies: ['127.0.0.1'],
    });
    const { port } = await startApp(budget);

    const payload = JSON.stringify({ data: 'b'.repeat(Math.floor(1.9 * MB) - 11) });
    const firstStageLen = Math.floor(1.85 * MB);
    const chunkSize = 256 * 1024;
    const t0 = Date.now();

    const clients = Array.from({ length: 6 }, (_, idx) => {
      let settled = false;
      let finish!: (result: { status: number }) => void;
      const done = new Promise<{ status: number }>(res => (finish = res));
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/json',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Transfer-Encoding': 'chunked',
            'X-Forwarded-For': `198.51.100.${idx + 1}`,
          },
        },
        res => {
          res.resume();
          res.on('end', () => {
            if (settled) return;
            settled = true;
            finish({ status: res.statusCode ?? 0 });
          });
        },
      );
      req.on('error', () => {
        if (settled) return;
        settled = true;
        finish({ status: 0 });
      });
      return { req, done };
    });

    await Promise.all(
      clients.map(
        ({ req }) =>
          new Promise<void>(resolve => {
            let offset = 0;
            const writeNext = (): void => {
              if (req.destroyed || offset >= firstStageLen) {
                resolve();
                return;
              }
              const nextOffset = Math.min(firstStageLen, offset + chunkSize);
              req.write(payload.slice(offset, nextOffset), () => {
                offset = nextOffset;
                setTimeout(writeNext, 2);
              });
            };
            writeNext();
          }),
      ),
    );

    for (const { req } of clients) {
      if (!req.destroyed) req.end(payload.slice(firstStageLen));
    }

    const results = await Promise.all(clients.map(c => c.done));
    expect(Date.now() - t0).toBeLessThan(1000);
    // 4 MiB pool holds at most two 1.90 MiB bodies simultaneously; 6 concurrent senders cannot all get 200.
    expect(results.filter(r => r.status === 200).length).toBeLessThanOrEqual(2);
    expect(budget.anonymousBytes()).toBe(0);
    expect(budget.currentBytes()).toBe(0);
  });

  it('drops a chunked body that crosses the cap right as its final chunk arrives', async () => {
    const budget = createInflightBodyBudget(2 * MB, { perClientShare: 1 });
    const { port, received } = await startApp(budget);

    const payload = JSON.stringify({ data: 'c'.repeat(Math.floor(2.1 * MB) - 11) });
    const split = Math.floor(1.5 * MB);

    const status = await new Promise<number>(resolve => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/json',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
        },
        res => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', () => resolve(0));
      req.write(payload.slice(0, split), () => {
        setTimeout(() => {
          if (!req.destroyed) req.end(payload.slice(split));
        }, 20);
      });
    });

    expect(status).not.toBe(200);
    expect(received).toHaveLength(0);
    expect(budget.currentBytes()).toBe(0);
  });

  it('keeps delivering 100% of bytes for keep-alive JSON, urlencoded, multipart, and pipelined requests', async () => {
    const budget = createInflightBodyBudget(10 * MB, { perClientShare: 1 });
    const { port, received } = await startApp(budget);
    const agent = new HttpAgent({ keepAlive: true, maxSockets: 1 });

    const send = (
      path: string,
      headers: Record<string, string>,
      body: Buffer,
    ): Promise<{ status: number; body: string }> =>
      new Promise((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers, agent }, res => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
        });
        req.on('error', reject);
        const half = Math.floor(body.length / 2);
        req.write(body.slice(0, half), () => {
          setTimeout(() => req.end(body.slice(half)), 5);
        });
      });

    try {
      const jsonText = 'hello-keepalive-json-'.repeat(200);
      const r1 = await send(
        '/json',
        { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
        Buffer.from(JSON.stringify({ data: jsonText })),
      );
      expect(r1).toEqual({ status: 200, body: JSON.stringify({ bytes: jsonText.length }) });

      const formText = 'hello-keepalive-form-'.repeat(200);
      const r2 = await send(
        '/form',
        { 'Content-Type': 'application/x-www-form-urlencoded', 'Transfer-Encoding': 'chunked' },
        Buffer.from(`data=${formText}`),
      );
      expect(r2).toEqual({ status: 200, body: JSON.stringify({ bytes: formText.length }) });

      const mpData = 'hello-keepalive-multipart-'.repeat(200);
      const boundary = '----openwaBoundary77';
      const mpBody = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="payload.bin"\r\n` +
          `Content-Type: application/octet-stream\r\n\r\n${mpData}\r\n--${boundary}--\r\n`,
      );
      const r3 = await send(
        '/multipart',
        { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Transfer-Encoding': 'chunked' },
        mpBody,
      );
      expect(r3).toEqual({ status: 200, body: JSON.stringify({ bytes: mpData.length }) });

      // Pipelined chunked requests over one raw TCP socket.
      const pipedReply = await new Promise<string>((resolve, reject) => {
        const sock = netConnect(port, '127.0.0.1', () => {
          const b1 = JSON.stringify({ data: 'pipe-one' });
          const b2 = JSON.stringify({ data: 'pipe-two' });
          const p1 =
            `POST /json HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n` +
            `${b1.length.toString(16)}\r\n${b1}\r\n0\r\n\r\n`;
          const p2 =
            `POST /json HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n` +
            `${b2.length.toString(16)}\r\n${b2}\r\n0\r\n\r\n`;
          sock.write(p1 + p2);
        });
        const chunks: Buffer[] = [];
        sock.on('data', (d: Buffer) => chunks.push(d));
        sock.on('end', () => resolve(Buffer.concat(chunks).toString()));
        sock.on('error', reject);
      });
      expect(pipedReply).toContain('{"bytes":8}');
      expect(received).toHaveLength(5);
      expect(budget.currentBytes()).toBe(0);
    } finally {
      agent.destroy();
    }
  });
});

describe('chunked socket listener lifecycle and guards', () => {
  it('attaches and detaches socket data listener cleanly on settle and release, and reconciles incrementally', () => {
    const budget = createInflightBodyBudget(4 * MB, { perClientShare: 1 });
    const req = new EventEmitter() as unknown as Request & EventEmitter;
    const socket = Object.assign(new EventEmitter(), { bytesRead: 0, remoteAddress: '203.0.113.7' });
    (req as unknown as { headers: Record<string, string>; socket: unknown; destroy: jest.Mock }).headers = {
      'transfer-encoding': 'chunked',
    };
    (req as unknown as { socket: unknown }).socket = socket;
    (req as unknown as { destroy: jest.Mock }).destroy = jest.fn();

    const mock = (() => {
      const res = Object.assign(new EventEmitter(), {
        headersSent: false,
        writableEnded: false,
        status: () => res,
        set: () => res,
        json: () => res,
      }) as unknown as Response & EventEmitter;
      return res;
    })();
    budget.middleware(req, mock, jest.fn());
    expect(req.listenerCount('data')).toBe(0);
    expect(socket.listenerCount('data')).toBe(1);

    socket.bytesRead = 2 * MB;
    socket.emit('data', Buffer.alloc(1));
    expect(budget.currentBytes()).toBe(2 * MB);

    // Completing req detaches socket listener before res finishes.
    (req as unknown as { complete: boolean }).complete = true;
    req.emit('end');
    expect(socket.listenerCount('data')).toBe(0);

    mock.emit('finish');
    expect(budget.currentBytes()).toBe(0);
  });

  it('detaches socket data listener on release even if end never fired, and handles already-complete or mock sockets', () => {
    const budget = createInflightBodyBudget(4 * MB, { perClientShare: 1 });

    // Early release (res finish before req end) detaches socket data listener.
    const reqA = new EventEmitter() as unknown as Request & EventEmitter;
    const sockA = Object.assign(new EventEmitter(), { bytesRead: 0, remoteAddress: '203.0.113.8' });
    (reqA as unknown as { headers: Record<string, string>; socket: unknown; destroy: jest.Mock }).headers = {
      'transfer-encoding': 'chunked',
    };
    (reqA as unknown as { socket: unknown }).socket = sockA;
    (reqA as unknown as { destroy: jest.Mock }).destroy = jest.fn();
    const resA = Object.assign(new EventEmitter(), {
      headersSent: false,
      writableEnded: false,
    }) as unknown as Response & EventEmitter;
    budget.middleware(reqA, resA, jest.fn());
    expect(sockA.listenerCount('data')).toBe(1);
    resA.emit('finish');
    expect(sockA.listenerCount('data')).toBe(0);

    // Already-complete chunked request at admission does not attach socket listener.
    const reqB = new EventEmitter() as unknown as Request & EventEmitter;
    const sockB = Object.assign(new EventEmitter(), { bytesRead: 0, remoteAddress: '203.0.113.9' });
    (
      reqB as unknown as { headers: Record<string, string>; socket: unknown; complete: boolean; destroy: jest.Mock }
    ).headers = {
      'transfer-encoding': 'chunked',
    };
    (reqB as unknown as { socket: unknown }).socket = sockB;
    (reqB as unknown as { complete: boolean }).complete = true;
    (reqB as unknown as { destroy: jest.Mock }).destroy = jest.fn();
    const resB = Object.assign(new EventEmitter(), {
      headersSent: false,
      writableEnded: false,
    }) as unknown as Response & EventEmitter;
    budget.middleware(reqB, resB, jest.fn());
    expect(sockB.listenerCount('data')).toBe(0);
    resB.emit('finish');

    // Socket with .on but without .off does not throw on release.
    const reqC = new EventEmitter() as unknown as Request & EventEmitter;
    const listeners: Array<() => void> = [];
    const sockC = {
      bytesRead: 0,
      remoteAddress: '203.0.113.10',
      on: (_ev: string, fn: () => void) => listeners.push(fn),
    };
    (reqC as unknown as { headers: Record<string, string>; socket: unknown; destroy: jest.Mock }).headers = {
      'transfer-encoding': 'chunked',
    };
    (reqC as unknown as { socket: unknown }).socket = sockC;
    (reqC as unknown as { destroy: jest.Mock }).destroy = jest.fn();
    const resC = Object.assign(new EventEmitter(), {
      headersSent: false,
      writableEnded: false,
    }) as unknown as Response & EventEmitter;
    budget.middleware(reqC, resC, jest.fn());
    expect(listeners).toHaveLength(1);
    expect(() => resC.emit('finish')).not.toThrow();
  });

  it('ignores pipelined socket bytes when end fires after onSocketData has already settled', () => {
    const budget = createInflightBodyBudget(6 * MB, { perClientShare: 1 });
    const req = new EventEmitter() as unknown as Request & EventEmitter;
    const socket = Object.assign(new EventEmitter(), { bytesRead: 0, remoteAddress: '203.0.113.11' });
    (
      req as unknown as { headers: Record<string, string>; socket: unknown; complete: boolean; destroy: jest.Mock }
    ).headers = {
      'transfer-encoding': 'chunked',
    };
    (req as unknown as { socket: unknown }).socket = socket;
    (req as unknown as { complete: boolean }).complete = false;
    (req as unknown as { destroy: jest.Mock }).destroy = jest.fn();
    const res = Object.assign(new EventEmitter(), {
      headersSent: false,
      writableEnded: false,
    }) as unknown as Response & EventEmitter;

    budget.middleware(req, res, jest.fn());
    expect(budget.currentBytes()).toBe(1 * MB);

    // Final chunk arrives and marks req.complete before onSocketData triggers settle().
    socket.bytesRead = 2 * MB;
    (req as unknown as { complete: boolean }).complete = true;
    socket.emit('data', Buffer.alloc(1));
    expect(budget.currentBytes()).toBe(2 * MB);
    expect(socket.listenerCount('data')).toBe(0);

    // A pipelined request increases socket.bytesRead before req emits 'end'; end must not re-reconcile it.
    socket.bytesRead = 4 * MB;
    req.emit('end');
    expect(budget.currentBytes()).toBe(2 * MB);

    res.emit('finish');
    expect(budget.currentBytes()).toBe(0);
  });
});
