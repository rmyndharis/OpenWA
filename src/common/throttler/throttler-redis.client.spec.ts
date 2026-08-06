import { ConfigService } from '@nestjs/config';
import {
  buildThrottlerRedisOptions,
  createThrottlerRedisClient,
  THROTTLER_REDIS_COMMAND_TIMEOUT_MS,
} from './throttler-redis.client';

const makeConfig = (values: Record<string, unknown>): ConfigService =>
  ({
    get: jest.fn((key: string, fallback?: unknown) => values[key] ?? fallback),
  }) as unknown as ConfigService;

describe('buildThrottlerRedisOptions', () => {
  it('maps the redis.* config keys onto the client', () => {
    const options = buildThrottlerRedisOptions(
      makeConfig({
        'redis.host': 'redis.internal',
        'redis.port': 6380,
        'redis.username': 'throttler',
        'redis.password': 'secret',
        'redis.connectTimeoutMs': 3000,
      }),
    );
    expect(options).toMatchObject({
      host: 'redis.internal',
      port: 6380,
      username: 'throttler',
      password: 'secret',
      connectTimeout: 3000,
    });
  });

  it('falls back to localhost defaults', () => {
    const options = buildThrottlerRedisOptions(makeConfig({}));
    expect(options).toMatchObject({ host: 'localhost', port: 6379, connectTimeout: 5000 });
  });

  it('fails fast instead of queueing or replaying commands across an outage', () => {
    const options = buildThrottlerRedisOptions(makeConfig({}));
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
    const client = createThrottlerRedisClient(makeConfig({ 'redis.host': '127.0.0.1' }));
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
