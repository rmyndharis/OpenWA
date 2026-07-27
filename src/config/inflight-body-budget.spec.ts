import { EventEmitter } from 'events';
import { Request, Response } from 'express';
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
  return req;
};

const makeRes = () => {
  const state = { code: 0, payload: undefined as unknown };
  const headers: Record<string, string> = {};
  const res = Object.assign(new EventEmitter(), {
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
    const budget = createInflightBodyBudget(1000);
    const req = makeReq({ 'content-length': '400' });
    const { next, state } = run(budget, req);

    expect(next).toHaveBeenCalledTimes(1);
    expect(budget.currentBytes()).toBe(400);
    expect(state.code).toBe(0); // no response written
  });

  it('does not attach a data listener when a Content-Length was declared (stream left untouched)', () => {
    const budget = createInflightBodyBudget(1000);
    const req = makeReq({ 'content-length': '400' });
    run(budget, req);
    expect(req.listenerCount('data')).toBe(0);
  });

  it('admits a request that lands exactly on the budget', () => {
    const budget = createInflightBodyBudget(1000);
    run(budget, makeReq({ 'content-length': '600' }));
    const { next } = run(budget, makeReq({ 'content-length': '400' }));
    expect(next).toHaveBeenCalledTimes(1);
    expect(budget.currentBytes()).toBe(1000);
  });

  it('rejects with 503 + Retry-After, without reading the body, when the declared size would exceed the budget', () => {
    const budget = createInflightBodyBudget(1000);
    run(budget, makeReq({ 'content-length': '800' }));

    const rejected = makeReq({ 'content-length': '300' });
    const { res, headers, state, next } = run(budget, rejected);

    expect(next).not.toHaveBeenCalled();
    expect(state.code).toBe(503);
    expect(headers['retry-after']).toBe('1');
    expect(headers['connection']).toBe('close');
    expect((state.payload as { statusCode: number }).statusCode).toBe(503);
    // Nothing was reserved for the rejected request and its stream was never tapped.
    expect(budget.currentBytes()).toBe(800);
    expect(rejected.listenerCount('data')).toBe(0);
    expect(res.listenerCount('finish')).toBe(0);
  });

  it('sends the configured Retry-After value', () => {
    const budget = createInflightBodyBudget(100, { retryAfterSeconds: 5 });
    run(budget, makeReq({ 'content-length': '100' }));
    const { headers } = run(budget, makeReq({ 'content-length': '1' }));
    expect(headers['retry-after']).toBe('5');
  });

  it('admits a zero-length body even when the budget is fully used', () => {
    const budget = createInflightBodyBudget(1000);
    run(budget, makeReq({ 'content-length': '1000' }));
    const { next } = run(budget, makeReq({ 'content-length': '0' }));
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('releases the reservation exactly once on normal completion', () => {
    const budget = createInflightBodyBudget(1000);
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
    const budget = createInflightBodyBudget(1000);
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
    const budget = createInflightBodyBudget(1000);
    const reqA = makeReq({ 'content-length': '400' });
    run(budget, reqA);
    reqA.emit('error', new Error('boom'));
    expect(budget.currentBytes()).toBe(0);

    const reqB = makeReq({ 'content-length': '400' });
    const { res: resB } = run(budget, reqB);
    resB.emit('error', new Error('boom'));
    expect(budget.currentBytes()).toBe(0);
  });

  it('counts actual bytes for requests without a Content-Length and releases on completion', () => {
    const budget = createInflightBodyBudget(1000);
    const req = makeReq(); // chunked / close-delimited: nothing declared
    const { res, next } = run(budget, req);

    expect(next).toHaveBeenCalledTimes(1);
    expect(budget.currentBytes()).toBe(0);

    req.emit('data', Buffer.alloc(300));
    expect(budget.currentBytes()).toBe(300);
    req.emit('data', Buffer.alloc(300));
    expect(budget.currentBytes()).toBe(600);

    res.emit('finish');
    expect(budget.currentBytes()).toBe(0);
  });

  it('aborts an un-declared upload mid-stream when it pushes the aggregate over budget', () => {
    const budget = createInflightBodyBudget(1000);

    const reqA = makeReq();
    const { res: resA } = run(budget, reqA);
    reqA.emit('data', Buffer.alloc(600));
    expect(budget.currentBytes()).toBe(600);

    const reqB = makeReq();
    const { res: resB, headers: headersB, state: stateB } = run(budget, reqB);
    reqB.emit('data', Buffer.alloc(500)); // 600 + 500 > 1000 → abort B, keep A's accounting

    expect(stateB.code).toBe(503);
    expect(headersB['retry-after']).toBe('1');
    expect(budget.currentBytes()).toBe(600);

    // After the abort, B is fully released: more incoming bytes are not counted and B's later
    // terminal events cannot decrement a second time.
    reqB.emit('data', Buffer.alloc(100));
    resB.emit('finish');
    reqB.emit('close');
    expect(budget.currentBytes()).toBe(600);

    resA.emit('finish');
    expect(budget.currentBytes()).toBe(0);
  });

  it('reuses freed budget for the next request (no leak across a full lifecycle)', () => {
    const budget = createInflightBodyBudget(1000);
    for (let i = 0; i < 5; i++) {
      const req = makeReq({ 'content-length': '900' });
      const { res, next } = run(budget, req);
      expect(next).toHaveBeenCalledTimes(1);
      res.emit('finish');
      expect(budget.currentBytes()).toBe(0);
    }
  });
});
