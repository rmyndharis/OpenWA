import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import Redis from 'ioredis';
import { RedisThrottlerStorage } from '../src/common/throttler/redis-throttler.storage';
import { buildThrottlerRedisOptions } from '../src/common/throttler/throttler-redis.client';

// Runs the throttler's Lua script against a real Redis: the unit spec mocks eval, so a wrong ARGV
// index or a repair branch that is never taken would pass there, and increment() fails open on a
// script error, which only logs. Gated on Redis the same way as queue-on.e2e-spec.ts: a developer
// box without one skips, GitHub Actions (which provides one) fails instead of skipping.
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);

const probeRedis = (host: string, port: number, timeoutMs: number): boolean => {
  const script =
    `const s = require('net').connect(${port}, ${JSON.stringify(host)});` +
    `const t = setTimeout(() => process.exit(2), ${timeoutMs});` +
    `s.on('connect', () => { clearTimeout(t); s.end(); process.exit(0); });` +
    `s.on('error', () => { clearTimeout(t); process.exit(1); });`;
  return spawnSync(process.execPath, ['-e', script], { timeout: timeoutMs + 1000 }).status === 0;
};

const REDIS_AVAILABLE = probeRedis(REDIS_HOST, REDIS_PORT, 1000);
if (!REDIS_AVAILABLE && process.env.GITHUB_ACTIONS === 'true') {
  throw new Error(`throttler e2e: no Redis at ${REDIS_HOST}:${REDIS_PORT} under GitHub Actions; refusing to skip`);
}
const describeWithRedis = REDIS_AVAILABLE ? describe : describe.skip;

describeWithRedis('RedisThrottlerStorage against a real Redis', () => {
  const TTL_MS = 5000;
  const LIMIT = 2;
  const throttler = `e2e-${randomUUID()}`;
  const keyOf = (key: string): string => `openwa:throttle:${throttler}:${key}`;
  let redis: Redis;
  let storage: RedisThrottlerStorage;
  let warn: jest.SpyInstance;

  beforeAll(() => {
    redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT, maxRetriesPerRequest: 1 });
    storage = new RedisThrottlerStorage(redis);
    warn = jest.spyOn((storage as unknown as { logger: { warn: () => void } }).logger, 'warn');
  });

  afterEach(async () => {
    // A script error is swallowed by the fail-open path; this is where it would show.
    expect(warn).not.toHaveBeenCalled();
    const keys = await redis.keys(keyOf('*'));
    if (keys.length) await redis.del(...keys);
  });

  afterAll(async () => {
    await storage.onModuleDestroy();
  });

  it('arms the window TTL on the first hit', async () => {
    const record = await storage.increment('first', TTL_MS, LIMIT, 60_000, throttler);

    expect(record).toEqual({ totalHits: 1, timeToExpire: 5, isBlocked: false, timeToBlockExpire: 0 });
    const pttl = await redis.pttl(keyOf('first'));
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(TTL_MS);
  });

  it('resets a counter left without a TTL to a fresh first hit and arms its TTL', async () => {
    await redis.set(keyOf('legacy'), 999);

    const record = await storage.increment('legacy', TTL_MS, LIMIT, 60_000, throttler);

    expect(record).toEqual({ totalHits: 1, timeToExpire: 5, isBlocked: false, timeToBlockExpire: 0 });
    expect(await redis.get(keyOf('legacy'))).toBe('1');
    expect(await redis.pttl(keyOf('legacy'))).toBeGreaterThan(0);
  });

  it('blocks past the limit until the window expires, without extending it', async () => {
    for (let i = 0; i < LIMIT; i++) await storage.increment('busy', TTL_MS, LIMIT, 60_000, throttler);

    const record = await storage.increment('busy', TTL_MS, LIMIT, 60_000, throttler);
    const pttl = await redis.pttl(keyOf('busy'));

    expect(record.totalHits).toBe(LIMIT + 1);
    expect(record.isBlocked).toBe(true);
    expect(record.timeToBlockExpire).toBeGreaterThanOrEqual(Math.ceil(pttl / 1000));
    expect(record.timeToBlockExpire).toBeLessThanOrEqual(TTL_MS / 1000);
    expect(pttl).toBeGreaterThan(0);
  });
});

// A Redis that stays connected and stops answering never errors its socket. The client the app builds has to
// turn that into one command timeout for the first guarded request and an immediate allow for everything after
// it, instead of one timeout per throttler tier on every request.
describeWithRedis('the throttler client against a Redis that stops answering', () => {
  const throttler = `e2e-stall-${randomUUID()}`;
  const sockets = new Set<net.Socket>();
  let blackhole = false;
  let proxy: net.Server;
  let storage: RedisThrottlerStorage;
  let client: Redis;
  let cleaner: Redis;

  beforeAll(async () => {
    proxy = net.createServer(peer => {
      const upstream = net.connect(REDIS_PORT, REDIS_HOST);
      sockets.add(peer).add(upstream);
      peer.on('data', data => {
        if (!blackhole) upstream.write(data);
      });
      upstream.on('data', data => {
        if (!blackhole) peer.write(data);
      });
      const end = (): void => {
        peer.destroy();
        upstream.destroy();
      };
      peer.on('close', end);
      upstream.on('close', end);
      peer.on('error', () => undefined);
      upstream.on('error', () => undefined);
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    client = new Redis({
      ...buildThrottlerRedisOptions(),
      host: '127.0.0.1',
      port: (proxy.address() as AddressInfo).port,
    });
    client.on('error', () => undefined);
    await new Promise<void>(resolve => client.once('ready', () => resolve()));
    storage = new RedisThrottlerStorage(client);
    jest.spyOn((storage as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => {});
    cleaner = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
  });

  afterAll(async () => {
    blackhole = false;
    // The client can still report the stall it was put through after this file is done, when the mocked logger is
    // gone and a log line fails the whole run: its errors have nobody left to tell.
    client.removeAllListeners('error');
    client.on('error', () => undefined);
    const keys = await cleaner.keys(`openwa:throttle:*:${throttler}*`);
    if (keys.length) await cleaner.del(...keys);
    cleaner.disconnect();
    await storage.onModuleDestroy();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
  });

  const timed = async (tier: string): Promise<number> => {
    const started = Date.now();
    await storage.increment(throttler, 10_000, 5, 0, tier);
    return Date.now() - started;
  };

  it('costs the first request one command timeout and every request after it nothing', async () => {
    expect((await storage.increment(throttler, 10_000, 5, 0, 'warmup')).totalHits).toBe(1);

    blackhole = true;
    const firstRequest = [await timed('short'), await timed('medium'), await timed('long')];

    // The tiers behind the first command do not each wait out a timeout of their own.
    expect(firstRequest[1] + firstRequest[2]).toBeLessThan(1000);
    expect(firstRequest[0] + firstRequest[1] + firstRequest[2]).toBeLessThan(3000);
    expect(await timed('short')).toBeLessThan(500);
  }, 20_000);
});
