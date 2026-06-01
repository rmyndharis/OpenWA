import { ConfigService } from '@nestjs/config';

const store = new Map<string, string>();
const redisMock = {
  set: jest.fn((key: string, val: string) => {
    store.set(key, val);
    return Promise.resolve('OK');
  }),
  get: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
  del: jest.fn((key: string) => {
    const had = store.delete(key);
    return Promise.resolve(had ? 1 : 0);
  }),
  pipeline: jest.fn(() => {
    const ops: Array<[string, string]> = [];
    return {
      set: (key: string, val: string) => {
        ops.push([key, val]);
        return this;
      },
      exec: () => {
        ops.forEach(([k, v]) => store.set(k, v));
        return Promise.resolve([]);
      },
    };
  }),
  quit: jest.fn().mockResolvedValue('OK'),
  on: jest.fn(),
};

jest.mock('ioredis', () => ({
  Redis: jest.fn().mockImplementation(() => redisMock),
}));

// Import after the mock is registered.
import { SessionRegistry } from './session-registry.service';

function makeConfig(overrides: Record<string, unknown> = {}): ConfigService {
  const values: Record<string, unknown> = {
    'cluster.enabled': true,
    'cluster.instanceId': 'node-a',
    'cluster.ownershipTtl': 30,
    'redis.host': 'localhost',
    'redis.port': 6379,
    ...overrides,
  };
  return { get: (k: string, d?: unknown) => values[k] ?? d } as unknown as ConfigService;
}

describe('SessionRegistry', () => {
  beforeEach(() => {
    store.clear();
    jest.clearAllMocks();
  });

  describe('cluster disabled', () => {
    it('no-ops: claim/release touch no Redis and getOwner is null', async () => {
      const registry = new SessionRegistry(makeConfig({ 'cluster.enabled': false }));
      registry.onModuleInit();

      await registry.claim('s1');
      expect(await registry.getOwner('s1')).toBeNull();
      await registry.release('s1');
      expect(redisMock.set).not.toHaveBeenCalled();
    });
  });

  describe('cluster enabled', () => {
    it('claim records this instance as owner with a TTL', async () => {
      const registry = new SessionRegistry(makeConfig());
      registry.onModuleInit();

      await registry.claim('s1');

      expect(redisMock.set).toHaveBeenCalledWith('session:owner:s1', 'node-a', 'EX', 30);
      expect(await registry.getOwner('s1')).toBe('node-a');
    });

    it('release deletes the claim only when this instance owns it', async () => {
      const registry = new SessionRegistry(makeConfig());
      registry.onModuleInit();
      await registry.claim('s1');

      await registry.release('s1');

      expect(redisMock.del).toHaveBeenCalledWith('session:owner:s1');
      expect(await registry.getOwner('s1')).toBeNull();
    });

    it('release does NOT delete a claim owned by another instance', async () => {
      store.set('session:owner:s1', 'node-b');
      const registry = new SessionRegistry(makeConfig());
      registry.onModuleInit();

      await registry.release('s1');

      expect(redisMock.del).not.toHaveBeenCalled();
      expect(await registry.getOwner('s1')).toBe('node-b');
    });

    it('exposes its own instance id and enabled flag', () => {
      const registry = new SessionRegistry(makeConfig());
      expect(registry.instanceId).toBe('node-a');
      expect(registry.isEnabled).toBe(true);
    });
  });
});
