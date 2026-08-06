/**
 * The adapter is the whole opt-in surface for cross-replica fan-out, so what has to hold is narrow
 * and load-bearing: it attaches the Redis adapter ONLY when Redis is enabled, never opens a
 * connection otherwise (a single-node deployment must pay nothing), survives a client-construction
 * failure by falling back rather than crashing the boot, and closes both connections on shutdown.
 */

const redisInstances: FakeRedis[] = [];

class FakeRedis {
  readonly handlers: Record<string, (err: Error) => void> = {};
  quit = jest.fn().mockResolvedValue('OK');
  disconnect = jest.fn();
  constructor(public readonly opts?: unknown) {
    redisInstances.push(this);
  }
  duplicate(): FakeRedis {
    return new FakeRedis(this.opts);
  }
  on(event: string, handler: (err: Error) => void): this {
    this.handlers[event] = handler;
    return this;
  }
}

jest.mock('ioredis', () => ({ __esModule: true, default: FakeRedis }));

// The mock's return references its args, so createAdapter(pub, sub) yields an identifiable value
// carrying both clients — proving both that it was called with the pair and that its result is
// what gets handed to server.adapter().
const createAdapterMock = jest.fn((pub: unknown, sub: unknown) => ({ tag: 'redis-adapter-fn', pub, sub }));
jest.mock('@socket.io/redis-adapter', () => ({
  createAdapter: (pub: unknown, sub: unknown) => createAdapterMock(pub, sub),
}));

import { RedisIoAdapter, isWsRedisEnabled, wsRedisOptions, WS_REDIS_QUIT_TIMEOUT_MS } from './redis-io.adapter';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { Server } from 'socket.io';

describe('RedisIoAdapter', () => {
  const prevEnv = { ...process.env };

  beforeEach(() => {
    redisInstances.length = 0;
    createAdapterMock.mockClear();
  });

  afterEach(() => {
    process.env = { ...prevEnv };
  });

  const fakeServer = (): { server: Server; adapterFn: jest.Mock } => {
    const adapterFn = jest.fn();
    return { server: { adapter: adapterFn } as unknown as Server, adapterFn };
  };

  /** Stub the base createIOServer so no real socket.io server is spun up. */
  const withBaseServer = (server: Server): jest.SpyInstance => {
    return jest.spyOn(IoAdapter.prototype, 'createIOServer').mockReturnValue(server);
  };

  describe('isWsRedisEnabled', () => {
    it('is true only for the exact string "true"', () => {
      process.env.REDIS_ENABLED = 'true';
      expect(isWsRedisEnabled()).toBe(true);
      for (const v of ['false', 'True', '1', '']) {
        process.env.REDIS_ENABLED = v;
        expect(isWsRedisEnabled()).toBe(false);
      }
      delete process.env.REDIS_ENABLED;
      expect(isWsRedisEnabled()).toBe(false);
    });
  });

  describe('wsRedisOptions', () => {
    it('maps the same REDIS_* env the cache/throttler read', () => {
      process.env.REDIS_HOST = 'redis.internal';
      process.env.REDIS_PORT = '6380';
      process.env.REDIS_PASSWORD = 'secret';
      const opts = wsRedisOptions();
      expect(opts.host).toBe('redis.internal');
      expect(opts.port).toBe(6380);
      expect(opts.password).toBe('secret');
      // Reconnect-forever so a blip never strands the SUBSCRIBE connection.
      expect(typeof opts.retryStrategy).toBe('function');
      expect((opts.retryStrategy as (n: number) => number)(100)).toBe(5000);
    });
  });

  describe('createIOServer', () => {
    it('opens no Redis connection and does not touch the adapter when Redis is disabled', () => {
      delete process.env.REDIS_ENABLED;
      const { server, adapterFn } = fakeServer();
      const spy = withBaseServer(server);
      try {
        const adapter = new RedisIoAdapter({} as never);
        expect(adapter.createIOServer(2785)).toBe(server);
        expect(redisInstances).toHaveLength(0);
        expect(adapterFn).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it('attaches the Redis adapter with a pub/sub pair when Redis is enabled', () => {
      process.env.REDIS_ENABLED = 'true';
      const { server, adapterFn } = fakeServer();
      const spy = withBaseServer(server);
      try {
        const adapter = new RedisIoAdapter({} as never);
        adapter.createIOServer(2785);
        // pub + its duplicate = two clients, both given an error handler.
        expect(redisInstances).toHaveLength(2);
        expect(redisInstances[0].handlers.error).toBeDefined();
        expect(redisInstances[1].handlers.error).toBeDefined();
        expect(createAdapterMock).toHaveBeenCalledWith(redisInstances[0], redisInstances[1]);
        expect(adapterFn).toHaveBeenCalledWith(
          expect.objectContaining({ tag: 'redis-adapter-fn', pub: redisInstances[0], sub: redisInstances[1] }),
        );
      } finally {
        spy.mockRestore();
      }
    });

    it('falls back to the base server (no crash) if wiring the adapter throws', () => {
      process.env.REDIS_ENABLED = 'true';
      const { server, adapterFn } = fakeServer();
      adapterFn.mockImplementation(() => {
        throw new Error('adapter boom');
      });
      const spy = withBaseServer(server);
      try {
        const adapter = new RedisIoAdapter({} as never);
        expect(() => adapter.createIOServer(2785)).not.toThrow();
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('close', () => {
    it('quits both pub and sub clients', async () => {
      process.env.REDIS_ENABLED = 'true';
      const { server } = fakeServer();
      const createSpy = withBaseServer(server);
      const closeSpy = jest.spyOn(IoAdapter.prototype, 'close').mockResolvedValue(undefined);
      try {
        const adapter = new RedisIoAdapter({} as never);
        adapter.createIOServer(2785);
        const [pub, sub] = redisInstances;

        await adapter.close(server);

        expect(pub.quit).toHaveBeenCalledTimes(1);
        expect(sub.quit).toHaveBeenCalledTimes(1);
        // Always release the socket, so a clean quit still can't leave the reconnect timer alive.
        expect(pub.disconnect).toHaveBeenCalledTimes(1);
        expect(sub.disconnect).toHaveBeenCalledTimes(1);
        expect(closeSpy).toHaveBeenCalledWith(server);
      } finally {
        createSpy.mockRestore();
        closeSpy.mockRestore();
      }
    });

    // The server must close BEFORE the clients are released: the namespace adapters unsubscribe as
    // the server closes, and issuing those on already-quit clients surfaced as a handful of
    // unhandled-rejection ERRORs on every graceful shutdown.
    it('closes the server before releasing the pub/sub clients', async () => {
      process.env.REDIS_ENABLED = 'true';
      const { server } = fakeServer();
      const createSpy = withBaseServer(server);
      const order: string[] = [];
      const closeSpy = jest.spyOn(IoAdapter.prototype, 'close').mockImplementation(() => {
        order.push('super.close');
        return Promise.resolve();
      });
      try {
        const adapter = new RedisIoAdapter({} as never);
        adapter.createIOServer(2785);
        const [pub, sub] = redisInstances;
        pub.quit.mockImplementation(() => {
          order.push('pub.quit');
          return Promise.resolve();
        });
        sub.quit.mockImplementation(() => {
          order.push('sub.quit');
          return Promise.resolve();
        });

        await adapter.close(server);

        expect(order[0]).toBe('super.close');
        expect(order).toContain('pub.quit');
        expect(order).toContain('sub.quit');
      } finally {
        createSpy.mockRestore();
        closeSpy.mockRestore();
      }
    });

    it('does not hang when quit() never resolves (Redis down at shutdown), then force-disconnects', async () => {
      jest.useFakeTimers();
      process.env.REDIS_ENABLED = 'true';
      const { server } = fakeServer();
      const createSpy = withBaseServer(server);
      const closeSpy = jest.spyOn(IoAdapter.prototype, 'close').mockResolvedValue(undefined);
      try {
        const adapter = new RedisIoAdapter({} as never);
        adapter.createIOServer(2785);
        const [pub, sub] = redisInstances;
        // The exact outage shape: quit() queued to the offline queue, never settles.
        pub.quit.mockReturnValue(new Promise(() => undefined));
        sub.quit.mockReturnValue(new Promise(() => undefined));

        const closed = adapter.close(server);
        // Drive the per-client deadline; without it the await would block forever.
        await jest.advanceTimersByTimeAsync(WS_REDIS_QUIT_TIMEOUT_MS + 10);
        await expect(closed).resolves.toBeUndefined();

        expect(pub.disconnect).toHaveBeenCalledTimes(1);
        expect(sub.disconnect).toHaveBeenCalledTimes(1);
        expect(closeSpy).toHaveBeenCalledWith(server);
      } finally {
        jest.useRealTimers();
        createSpy.mockRestore();
        closeSpy.mockRestore();
      }
    });

    it('is safe to close when Redis was never enabled (no clients to quit)', async () => {
      delete process.env.REDIS_ENABLED;
      const { server } = fakeServer();
      const createSpy = withBaseServer(server);
      const closeSpy = jest.spyOn(IoAdapter.prototype, 'close').mockResolvedValue(undefined);
      try {
        const adapter = new RedisIoAdapter({} as never);
        adapter.createIOServer(2785);
        await expect(adapter.close(server)).resolves.toBeUndefined();
      } finally {
        createSpy.mockRestore();
        closeSpy.mockRestore();
      }
    });
  });
});
