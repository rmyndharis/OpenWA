import {
  ingressWorkerConcurrency,
  producerConnectWaitMs,
  producerReady,
  queueConnectionOptions,
  workerConnectionOptions,
  webhookWorkerConcurrency,
} from './redis-connection';

describe('workerConnectionOptions (webhook Worker connection)', () => {
  const ORIGINAL_ENV = process.env;

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('does NOT disable the offline queue — the Worker must tolerate a brief Redis reconnect', () => {
    // The producer sets enableOfflineQueue:false for fast-fail; the Worker must keep ioredis's default
    // (true). Asserting it is absent guards against the regression where the Worker inherited the
    // producer-only fast-fail from the shared connection and threw "Stream isn't writeable" on a blip.
    const opts = workerConnectionOptions() as unknown as Record<string, unknown>;
    expect(opts.enableOfflineQueue).toBeUndefined();
  });

  it('reads host/port/username/password/connectTimeout from env with safe defaults', () => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.REDIS_HOST;
    delete process.env.REDIS_PORT;
    delete process.env.REDIS_USERNAME;
    delete process.env.REDIS_PASSWORD;
    delete process.env.REDIS_CONNECT_TIMEOUT_MS;
    expect(workerConnectionOptions()).toEqual({
      host: 'localhost',
      port: 6379,
      username: undefined,
      password: undefined,
      connectTimeout: 5000,
    });

    process.env.REDIS_HOST = 'redis.internal';
    process.env.REDIS_PORT = '6380';
    process.env.REDIS_USERNAME = 'myuser';
    process.env.REDIS_PASSWORD = 'secret';
    process.env.REDIS_CONNECT_TIMEOUT_MS = '1234';
    expect(workerConnectionOptions()).toEqual({
      host: 'redis.internal',
      port: 6380,
      username: 'myuser',
      password: 'secret',
      connectTimeout: 1234,
    });
  });

  it('connects the Worker and the producer over TLS when REDIS_TLS=true', () => {
    process.env = { ...ORIGINAL_ENV, REDIS_TLS: 'true' };
    expect(workerConnectionOptions().tls).toEqual({});
    expect(queueConnectionOptions()).toMatchObject({ tls: {}, enableOfflineQueue: false });
  });
});

describe('webhookWorkerConcurrency', () => {
  const ORIGINAL_ENV = process.env;
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('defaults to 10 so deliveries do not serialize behind one slow receiver', () => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.WEBHOOK_WORKER_CONCURRENCY;
    expect(webhookWorkerConcurrency()).toBe(10);
  });

  it('honors a positive override', () => {
    process.env = { ...ORIGINAL_ENV, WEBHOOK_WORKER_CONCURRENCY: '25' };
    expect(webhookWorkerConcurrency()).toBe(25);
  });

  it('falls back to the default for a non-positive/garbage override', () => {
    process.env = { ...ORIGINAL_ENV, WEBHOOK_WORKER_CONCURRENCY: '0' };
    expect(webhookWorkerConcurrency()).toBe(10);
    process.env = { ...ORIGINAL_ENV, WEBHOOK_WORKER_CONCURRENCY: 'abc' };
    expect(webhookWorkerConcurrency()).toBe(10);
  });

  it('does not read the leading digits of a unit-suffixed value', () => {
    process.env = { ...ORIGINAL_ENV, WEBHOOK_WORKER_CONCURRENCY: '5abc' };
    expect(webhookWorkerConcurrency()).toBe(10);
    process.env = { ...ORIGINAL_ENV, INGRESS_WORKER_CONCURRENCY: '5abc' };
    expect(ingressWorkerConcurrency()).toBe(10);
  });
});

describe('producerReady', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    process.env = ORIGINAL_ENV;
  });

  /** A queue whose first connect completes after `connectMs`, or never when undefined. */
  const queueReadyAfter = (connectMs?: number) => ({
    waitUntilReady: () =>
      new Promise<never>(resolve => {
        if (connectMs !== undefined) setTimeout(resolve, connectMs);
      }),
  });

  /** Settle state of `promise` once the fake clock has advanced `ms`. */
  async function settledAfter(promise: Promise<void>, ms: number): Promise<string> {
    const state = promise.then(
      () => 'resolved',
      (error: Error) => `rejected: ${error.message}`,
    );
    let result = 'pending';
    void state.then(s => (result = s));
    await jest.advanceTimersByTimeAsync(ms);
    return result;
  }

  it('waits for a first connect that lands within REDIS_CONNECT_TIMEOUT_MS', async () => {
    process.env = { ...ORIGINAL_ENV, REDIS_CONNECT_TIMEOUT_MS: '1000' };
    await expect(settledAfter(producerReady(queueReadyAfter(900)), 900)).resolves.toBe('resolved');
  });

  it('rejects once REDIS_CONNECT_TIMEOUT_MS passes without a connect', async () => {
    process.env = { ...ORIGINAL_ENV, REDIS_CONNECT_TIMEOUT_MS: '1000' };
    const ready = producerReady(queueReadyAfter());
    await expect(settledAfter(ready, 999)).resolves.toBe('pending');
    await expect(settledAfter(ready, 1)).resolves.toBe('rejected: Redis has not connected within 1000ms');
  });

  it('still waits the default for a first connect when REDIS_CONNECT_TIMEOUT_MS is 0', async () => {
    // 0 turns off the socket connect timeout; it must not skip a healthy queue that is still connecting.
    process.env = { ...ORIGINAL_ENV, REDIS_CONNECT_TIMEOUT_MS: '0' };
    await expect(settledAfter(producerReady(queueReadyAfter(20)), 20)).resolves.toBe('resolved');

    const never = producerReady(queueReadyAfter());
    await expect(settledAfter(never, 4999)).resolves.toBe('pending');
    await expect(settledAfter(never, 1)).resolves.toBe('rejected: Redis has not connected within 5000ms');
  });

  it('caps the wait at the Node timer ceiling instead of overflowing to 1 ms', async () => {
    // Above the ceiling a Node timer fires after 1 ms and would skip a healthy queue that is connecting.
    process.env = { ...ORIGINAL_ENV, REDIS_CONNECT_TIMEOUT_MS: '3000000000' };
    expect(producerConnectWaitMs()).toBe(2147483647);
    await expect(settledAfter(producerReady(queueReadyAfter()), 1000)).resolves.toBe('pending');
  });

  // Each wait on BullMQ's pending connect holds memory until Redis connects, which may be never.
  it('shares one wait per queue: calls after an expired window reject at once until Redis connects', async () => {
    process.env = { ...ORIGINAL_ENV, REDIS_CONNECT_TIMEOUT_MS: '1000' };
    let connect!: () => void;
    const queue = { waitUntilReady: jest.fn(() => new Promise<void>(resolve => (connect = resolve))) };

    const first = producerReady(queue);
    await expect(settledAfter(first, 600)).resolves.toBe('pending');
    const inWindow = producerReady(queue);
    await expect(settledAfter(inWindow, 400)).resolves.toBe('rejected: Redis has not connected within 1000ms');
    await expect(settledAfter(first, 0)).resolves.toBe('rejected: Redis has not connected within 1000ms');

    await expect(settledAfter(producerReady(queue), 0)).resolves.toBe(
      'rejected: Redis has not connected within 1000ms',
    );
    expect(queue.waitUntilReady).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);

    connect();
    await jest.advanceTimersByTimeAsync(0);
    await expect(settledAfter(producerReady(queue), 0)).resolves.toBe('resolved');
    expect(queue.waitUntilReady).toHaveBeenCalledTimes(1);
  });
});
