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
  (req as unknown as { socket: { bytesRead: number } }).socket = { bytesRead: 0 };
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

  it('takes only an opening placeholder for chunk-encoded bodies and releases it on completion', () => {
    const budget = createInflightBodyBudget(1000);
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
    const budget = createInflightBodyBudget(64 * 1024 * 1024);
    for (let i = 0; i < 8; i++) {
      const { next } = run(budget, makeReq({ 'transfer-encoding': 'chunked' }));
      expect(next).toHaveBeenCalledTimes(1);
    }
    expect(budget.currentBytes()).toBe(8 * 1024 * 1024); // 8 × the 1 MiB placeholder, not 8 × 16 MiB
  });

  it('still refuses an un-declared body once the aggregate is exhausted', () => {
    const budget = createInflightBodyBudget(2 * 1024 * 1024);
    for (let i = 0; i < 2; i++) {
      expect(run(budget, makeReq({ 'transfer-encoding': 'chunked' })).next).toHaveBeenCalledTimes(1);
    }
    const third = run(budget, makeReq({ 'transfer-encoding': 'chunked' }));
    expect(third.next).not.toHaveBeenCalled();
    expect(third.state.code).toBe(503);
  });

  it('reserves nothing for requests with neither Content-Length nor Transfer-Encoding', () => {
    const budget = createInflightBodyBudget(1000);
    run(budget, makeReq({ 'content-length': '1000' }));
    // No body expected (health checks, GETs): admitted even with the budget fully reserved.
    const req = makeReq();
    const { next } = run(budget, req);
    expect(next).toHaveBeenCalledTimes(1);
    expect(budget.currentBytes()).toBe(1000);
    expect(req.listenerCount('data')).toBe(0);
  });

  it('drops the socket instead of writing a 503 when the response is already flushing', () => {
    const budget = createInflightBodyBudget(1000);
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

describe('stall reaper', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const destroyMock = (req: Request): jest.Mock => (req as unknown as { destroy: jest.Mock }).destroy;

  it('reaps a stalled declared-length connection and releases its reservation', () => {
    const budget = createInflightBodyBudget(1000);
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
    const budget = createInflightBodyBudget(1000);
    const req = makeReq({ 'transfer-encoding': 'chunked' });
    run(budget, req);
    expect(budget.currentBytes()).toBe(1000);

    jest.advanceTimersByTime(60_000);
    expect(destroyMock(req)).toHaveBeenCalledTimes(1);
    expect(budget.currentBytes()).toBe(0);
  });

  it('does not reap a connection that keeps making progress, however slow', () => {
    const budget = createInflightBodyBudget(1000);
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
  });

  it('stops reaping once the declared body has fully arrived', () => {
    const budget = createInflightBodyBudget(1000);
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
    const budget = createInflightBodyBudget(1000);
    const req = makeReq({ 'transfer-encoding': 'chunked' });
    const { res } = run(budget, req);

    req.emit('end');
    jest.advanceTimersByTime(120_000);
    expect(destroyMock(req)).not.toHaveBeenCalled();
    expect(budget.currentBytes()).toBe(1000);

    res.emit('finish');
    expect(budget.currentBytes()).toBe(0);
  });

  it('reconciles a chunked reservation with the bytes that actually arrive', () => {
    const budget = createInflightBodyBudget(64 * 1024 * 1024);
    const req = makeReq({ 'transfer-encoding': 'chunked' });
    run(budget, req);
    expect(budget.currentBytes()).toBe(1024 * 1024); // opening placeholder

    const socket = (req as unknown as { socket: { bytesRead: number } }).socket;
    socket.bytesRead = 5 * 1024 * 1024;
    jest.advanceTimersByTime(5_000);
    expect(budget.currentBytes()).toBe(5 * 1024 * 1024); // now priced at its real weight
  });

  it('aborts an un-declared body that streams past the aggregate budget', () => {
    const budget = createInflightBodyBudget(2 * 1024 * 1024);
    const req = makeReq({ 'transfer-encoding': 'chunked' });
    run(budget, req);

    (req as unknown as { socket: { bytesRead: number } }).socket.bytesRead = 3 * 1024 * 1024;
    jest.advanceTimersByTime(5_000);
    expect(destroyMock(req)).toHaveBeenCalledTimes(1);
    expect(budget.currentBytes()).toBe(0);
  });

  it('does not reap a fully-received request whose body no parser consumed', () => {
    // The body can arrive in the same segment as the headers, so socket.bytesRead never moves again
    // and 'end' never fires when no parser reads the stream. Killing that request at the stall
    // timeout would drop a healthy connection mid-handler.
    const budget = createInflightBodyBudget(1000);
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
    const budget = createInflightBodyBudget(1000);
    const getReq = makeReq();
    const emptyReq = makeReq({ 'content-length': '0' });
    run(budget, getReq);
    run(budget, emptyReq);

    jest.advanceTimersByTime(120_000);
    expect(destroyMock(getReq)).not.toHaveBeenCalled();
    expect(destroyMock(emptyReq)).not.toHaveBeenCalled();
  });
});
