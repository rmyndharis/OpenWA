import {
  buildThrottlerRedisOptions,
  createThrottlerRedisClient,
  THROTTLER_REDIS_COMMAND_TIMEOUT_MS,
} from './throttler-redis.client';

const KEYS = ['REDIS_HOST', 'REDIS_PORT', 'REDIS_USERNAME', 'REDIS_PASSWORD', 'REDIS_CONNECT_TIMEOUT_MS', 'REDIS_TLS'];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('buildThrottlerRedisOptions', () => {
  it('maps the REDIS_* connection env onto the client', () => {
    Object.assign(process.env, {
      REDIS_HOST: 'redis.internal',
      REDIS_PORT: '6380',
      REDIS_USERNAME: 'throttler',
      REDIS_PASSWORD: 'secret',
      REDIS_CONNECT_TIMEOUT_MS: '3000',
      REDIS_TLS: 'true',
    });
    expect(buildThrottlerRedisOptions()).toMatchObject({
      host: 'redis.internal',
      port: 6380,
      username: 'throttler',
      password: 'secret',
      connectTimeout: 3000,
      tls: {},
    });
  });

  it('falls back to localhost defaults', () => {
    expect(buildThrottlerRedisOptions()).toMatchObject({ host: 'localhost', port: 6379, connectTimeout: 5000 });
  });

  it('fails fast instead of queueing or replaying commands across an outage', () => {
    const options = buildThrottlerRedisOptions();
    // Commands issued while disconnected reject immediately so the storage's fail-open path
    // engages per request — no offline-queue stall, no post-recovery replay of queued evals.
    expect(options.enableOfflineQueue).toBe(false);
    // An eval in flight when the socket dies is never resent: the INCR is not idempotent, so a
    // resend could double-count or land in a fresh window.
    expect(options.autoResendUnfulfilledCommands).toBe(false);
    // Every command is deadline-bounded, so a dropped in-flight call cannot hang the request.
    expect(options.commandTimeout).toBe(THROTTLER_REDIS_COMMAND_TIMEOUT_MS);
    // No queue-based retry flushing — per-command latency is bounded by commandTimeout alone.
    expect(options.maxRetriesPerRequest).toBeNull();
  });
});

describe('createThrottlerRedisClient', () => {
  it('passes the fail-fast options through to the ioredis constructor', () => {
    process.env.REDIS_HOST = '127.0.0.1';
    const client = createThrottlerRedisClient();
    try {
      expect(client.options.enableOfflineQueue).toBe(false);
      expect(client.options.autoResendUnfulfilledCommands).toBe(false);
      expect(client.options.commandTimeout).toBe(THROTTLER_REDIS_COMMAND_TIMEOUT_MS);
      expect(client.options.maxRetriesPerRequest).toBeNull();
      expect(client.options.host).toBe('127.0.0.1');
    } finally {
      // Stop the eager connect/reconnect loop so the test leaves no live handle behind.
      client.on('error', () => undefined);
      client.disconnect();
    }
  });
});
