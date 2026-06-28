import { workerConnectionOptions } from './redis-connection';

describe('workerConnectionOptions (webhook Worker connection)', () => {
  const ORIGINAL_ENV = process.env;

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('does NOT disable the offline queue — the Worker must tolerate a brief Redis reconnect', () => {
    // The producer sets enableOfflineQueue:false for fast-fail; the Worker must keep ioredis's default
    // (true). Asserting it is absent guards against the regression where the Worker inherited the
    // producer-only fast-fail from the shared connection and threw "Stream isn't writeable" on a blip.
    const opts = workerConnectionOptions() as Record<string, unknown>;
    expect(opts.enableOfflineQueue).toBeUndefined();
  });

  it('reads host/port/password/connectTimeout from env with safe defaults', () => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.REDIS_HOST;
    delete process.env.REDIS_PORT;
    delete process.env.REDIS_PASSWORD;
    delete process.env.REDIS_CONNECT_TIMEOUT_MS;
    expect(workerConnectionOptions()).toEqual({
      host: 'localhost',
      port: 6379,
      password: undefined,
      connectTimeout: 5000,
    });

    process.env.REDIS_HOST = 'redis.internal';
    process.env.REDIS_PORT = '6380';
    process.env.REDIS_PASSWORD = 'secret';
    process.env.REDIS_CONNECT_TIMEOUT_MS = '1234';
    expect(workerConnectionOptions()).toEqual({
      host: 'redis.internal',
      port: 6380,
      password: 'secret',
      connectTimeout: 1234,
    });
  });
});
