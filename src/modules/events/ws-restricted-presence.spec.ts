const redisInstances: MockIoredis[] = [];

class MockIoredis {
  readonly handlers: Record<string, (...args: unknown[]) => void> = {};
  status = 'ready';
  connect = jest.fn().mockResolvedValue(undefined);
  set = jest.fn().mockResolvedValue('OK');
  del = jest.fn().mockResolvedValue(1);
  sadd = jest.fn().mockResolvedValue(1);
  srem = jest.fn().mockResolvedValue(1);
  smembers = jest.fn().mockResolvedValue([]);
  mget = jest.fn().mockResolvedValue([]);
  eval = jest.fn().mockResolvedValue(0);
  quit = jest.fn().mockResolvedValue('OK');
  disconnect = jest.fn();

  constructor(public readonly opts?: Record<string, unknown>) {
    redisInstances.push(this);
  }

  on(event: string, handler: (...args: unknown[]) => void): this {
    this.handlers[event] = handler;
    return this;
  }
}

jest.mock('ioredis', () => ({ __esModule: true, default: MockIoredis }));

import { WS_REDIS_COMMAND_TIMEOUT_MS, WS_REDIS_QUIT_TIMEOUT_MS, WS_REDIS_SOCKET_TIMEOUT_MS } from './redis-io.adapter';
import {
  type RestrictedPresenceRedisClient,
  WS_RESTRICTED_NODES_KEY,
  WS_RESTRICTED_NODE_KEY_PREFIX,
  WsRestrictedPresenceTracker,
} from './ws-restricted-presence';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

interface FakeRedisStore {
  client: RestrictedPresenceRedisClient;
  mocks: {
    set: jest.Mock;
    del: jest.Mock;
    sadd: jest.Mock;
    srem: jest.Mock;
    smembers: jest.Mock;
    mget: jest.Mock;
    eval: jest.Mock;
  };
  strings: Map<string, string>;
  sets: Map<string, Set<string>>;
}

function createFakeRedis(): FakeRedisStore {
  const strings = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const set = jest.fn((key: string, value: string) => {
    strings.set(key, value);
    return Promise.resolve('OK');
  });
  const del = jest.fn((...keys: string[]) => {
    for (const k of keys) strings.delete(k);
    return Promise.resolve(keys.length);
  });
  const sadd = jest.fn((key: string, ...members: string[]) => {
    const bucket = sets.get(key) ?? new Set<string>();
    for (const m of members) bucket.add(m);
    sets.set(key, bucket);
    return Promise.resolve(members.length);
  });
  const srem = jest.fn((key: string, ...members: string[]) => {
    const bucket = sets.get(key);
    if (bucket) for (const m of members) bucket.delete(m);
    return Promise.resolve(members.length);
  });
  const smembers = jest.fn((key: string) => Promise.resolve([...(sets.get(key) ?? [])]));
  const mget = jest.fn((...keys: string[]) => Promise.resolve(keys.map(k => strings.get(k) ?? null)));
  const evalFn = jest.fn((_script: string, numkeys: number, ...args: string[]) => {
    const setKey = args[0];
    const leaseKeys = args.slice(1, numkeys);
    const members = args.slice(numkeys);
    const bucket = sets.get(setKey);
    let alive = 0;
    for (let i = 0; i < members.length; i++) {
      if (strings.has(leaseKeys[i])) {
        alive++;
      } else {
        bucket?.delete(members[i]);
      }
    }
    return Promise.resolve(alive);
  });

  const client: RestrictedPresenceRedisClient = {
    status: 'ready',
    set,
    del,
    sadd,
    srem,
    smembers,
    mget,
    eval: evalFn,
  };

  return {
    client,
    mocks: { set, del, sadd, srem, smembers, mget, eval: evalFn },
    strings,
    sets,
  };
}

describe('WsRestrictedPresenceTracker', () => {
  beforeEach(() => {
    redisInstances.length = 0;
  });

  it('prunes stale members atomically via Lua so a concurrent Node B renewal between MGET and prune is never removed', async () => {
    const { client, mocks, strings, sets } = createFakeRedis();
    const nodeB = 'node-b:2222';
    const nodeBLease = `${WS_RESTRICTED_NODE_KEY_PREFIX}${nodeB}`;
    // Node B's previous lease has expired while its member id is still in the set.
    sets.set(WS_RESTRICTED_NODES_KEY, new Set([nodeB]));

    mocks.mget.mockImplementationOnce((...keys: string[]) => {
      const snapshot = keys.map(k => strings.get(k) ?? null);
      // Simulate Node B registering/renewing its live lease AFTER Node A's MGET read [null]
      // and BEFORE Node A runs its prune step.
      strings.set(nodeBLease, '1');
      const set = sets.get(WS_RESTRICTED_NODES_KEY) ?? new Set<string>();
      set.add(nodeB);
      sets.set(WS_RESTRICTED_NODES_KEY, set);
      return Promise.resolve(snapshot);
    });

    const tracker = new WsRestrictedPresenceTracker(client, { nodeId: 'node-a', cacheTtlMs: 0 });
    const hasRestricted = await tracker.hasRestrictedNodes();
    await new Promise<void>(resolve => setImmediate(resolve));

    // Atomic Lua check sees EXISTS == 1 and leaves Node B in the set; presence remains true.
    expect(mocks.eval).toHaveBeenCalledTimes(1);
    expect(sets.get(WS_RESTRICTED_NODES_KEY)?.has(nodeB)).toBe(true);
    expect(hasRestricted).toBe(true);
    expect(await tracker.hasRestrictedNodes()).toBe(true);
  });

  it('clears presence when disconnect arrives while initial SET/SADD is still in flight (no zombie lease)', async () => {
    const { client, mocks, strings, sets } = createFakeRedis();
    const tracker = new WsRestrictedPresenceTracker(client, { nodeId: 'node-a', cacheTtlMs: 0 });
    const leaseKey = `${WS_RESTRICTED_NODE_KEY_PREFIX}${tracker.nodeKey}`;

    const setGate = deferred();
    mocks.set.mockImplementationOnce(async (k: string, v: string) => {
      await setGate.promise;
      strings.set(k, v);
      return 'OK';
    });

    // Restricted socket connects, then disconnects before SET resolves.
    const connectSync = tracker.syncLocal(true);
    const disconnectSync = tracker.syncLocal(false);

    setGate.resolve();
    await Promise.all([connectSync, disconnectSync]);

    expect(strings.has(leaseKey)).toBe(false);
    expect(sets.get(WS_RESTRICTED_NODES_KEY)?.has(tracker.nodeKey)).toBeFalsy();
    expect(await tracker.hasRestrictedNodes()).toBe(false);
  });

  it('clears presence when destroy() runs while initial SET/SADD is still in flight', async () => {
    const { client, mocks, strings, sets } = createFakeRedis();
    const tracker = new WsRestrictedPresenceTracker(client, { nodeId: 'node-a', cacheTtlMs: 0 });
    const leaseKey = `${WS_RESTRICTED_NODE_KEY_PREFIX}${tracker.nodeKey}`;

    const setGate = deferred();
    mocks.set.mockImplementationOnce(async (k: string, v: string) => {
      await setGate.promise;
      strings.set(k, v);
      return 'OK';
    });

    const connectSync = tracker.syncLocal(true);
    const destroyPromise = tracker.destroy();

    setGate.resolve();
    await Promise.all([connectSync, destroyPromise]);

    expect(strings.has(leaseKey)).toBe(false);
    expect(sets.get(WS_RESTRICTED_NODES_KEY)?.has(tracker.nodeKey)).toBeFalsy();
  });

  it('retains live presence when a second restricted socket subscribes while the first disconnect is still in flight', async () => {
    const { client, mocks, strings, sets } = createFakeRedis();
    const tracker = new WsRestrictedPresenceTracker(client, { nodeId: 'node-a', cacheTtlMs: 0 });
    const leaseKey = `${WS_RESTRICTED_NODE_KEY_PREFIX}${tracker.nodeKey}`;

    // S1 connects and registers cleanly.
    await tracker.syncLocal(true);
    expect(strings.has(leaseKey)).toBe(true);
    expect(sets.get(WS_RESTRICTED_NODES_KEY)?.has(tracker.nodeKey)).toBe(true);

    // Pause S1's unregister at DEL, then subscribe S2 concurrently.
    const delGate = deferred();
    mocks.del.mockImplementationOnce(async (...keys: string[]) => {
      await delGate.promise;
      for (const k of keys) strings.delete(k);
      return keys.length;
    });

    const disconnectS1 = tracker.syncLocal(false);
    await Promise.resolve();
    const subscribeS2 = tracker.syncLocal(true);

    delGate.resolve();
    await Promise.all([disconnectS1, subscribeS2]);

    expect(strings.has(leaseKey)).toBe(true);
    expect(sets.get(WS_RESTRICTED_NODES_KEY)?.has(tracker.nodeKey)).toBe(true);
    expect(await tracker.hasRestrictedNodes()).toBe(true);
  });

  it('createDefault configures socketTimeout to WS_REDIS_SOCKET_TIMEOUT_MS (10s) and commandTimeout to WS_REDIS_COMMAND_TIMEOUT_MS', async () => {
    const tracker = WsRestrictedPresenceTracker.createDefault('node-a', () => false);
    expect(redisInstances).toHaveLength(1);
    expect(redisInstances[0].opts?.commandTimeout).toBe(WS_REDIS_COMMAND_TIMEOUT_MS);
    expect(redisInstances[0].opts?.socketTimeout).toBe(WS_REDIS_SOCKET_TIMEOUT_MS);
    await tracker.destroy();
  });

  it('prunes genuinely dead members in a mixed batch while keeping concurrently renewed members alive', async () => {
    const { client, mocks, strings, sets } = createFakeRedis();
    const deadNode = 'node-dead:1111';
    const renewedNode = 'node-renewed:2222';
    sets.set(WS_RESTRICTED_NODES_KEY, new Set([deadNode, renewedNode]));

    mocks.mget.mockImplementationOnce((...keys: string[]) => {
      const snapshot = keys.map(k => strings.get(k) ?? null);
      // renewedNode restores its lease between MGET and EVAL; deadNode stays expired.
      strings.set(`${WS_RESTRICTED_NODE_KEY_PREFIX}${renewedNode}`, '1');
      return Promise.resolve(snapshot);
    });

    const tracker = new WsRestrictedPresenceTracker(client, { nodeId: 'node-a', cacheTtlMs: 0 });
    expect(await tracker.hasRestrictedNodes()).toBe(true);
    expect(sets.get(WS_RESTRICTED_NODES_KEY)?.has(deadNode)).toBe(false);
    expect(sets.get(WS_RESTRICTED_NODES_KEY)?.has(renewedNode)).toBe(true);
  });

  it('re-synchronizes local presence on Redis ready reconnect (re-registering when active and cleaning dirty presence when idle)', async () => {
    let hasRestricted = true;
    const tracker = WsRestrictedPresenceTracker.createDefault('node-a', () => hasRestricted);
    const redis = redisInstances[0];
    const leaseKey = `${WS_RESTRICTED_NODE_KEY_PREFIX}${tracker.nodeKey}`;

    // Reconnect while restricted socket is active -> registers lease + set member.
    redis.handlers.ready();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(redis.set).toHaveBeenCalledWith(leaseKey, '1', 'PX', 30_000);
    expect(redis.sadd).toHaveBeenCalledWith(WS_RESTRICTED_NODES_KEY, tracker.nodeKey);

    // Drop Redis, disconnect socket while disconnected (cannot unregister yet), then reconnect -> cleans up.
    redis.status = 'reconnecting';
    hasRestricted = false;
    await tracker.syncLocal(false);
    expect(redis.srem).not.toHaveBeenCalled();

    redis.status = 'ready';
    redis.handlers.ready();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(redis.srem).toHaveBeenCalledWith(WS_RESTRICTED_NODES_KEY, tracker.nodeKey);
    expect(redis.del).toHaveBeenCalledWith(leaseKey);

    await tracker.destroy();
  });

  it('resets registered state when a renewal fails so the next syncLocal(true) immediately re-registers', async () => {
    const { client, mocks, strings, sets } = createFakeRedis();
    const tracker = new WsRestrictedPresenceTracker(client, { nodeId: 'node-a', cacheTtlMs: 0 });
    const leaseKey = `${WS_RESTRICTED_NODE_KEY_PREFIX}${tracker.nodeKey}`;

    await tracker.syncLocal(true);
    expect(mocks.set).toHaveBeenCalledTimes(1);

    // Renewal fails (e.g. Redis LOADING / timeout) after lease expired.
    strings.delete(leaseKey);
    sets.get(WS_RESTRICTED_NODES_KEY)?.delete(tracker.nodeKey);
    mocks.set.mockRejectedValueOnce(new Error('LOADING Redis is loading the dataset in memory'));
    tracker.handleRedisReady();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(mocks.set).toHaveBeenCalledTimes(2);

    // Next subscribe / syncLocal(true) must re-register immediately instead of skipping.
    await tracker.syncLocal(true);
    expect(mocks.set).toHaveBeenCalledTimes(3);
    expect(strings.has(leaseKey)).toBe(true);
    expect(sets.get(WS_RESTRICTED_NODES_KEY)?.has(tracker.nodeKey)).toBe(true);
  });

  it('skips sadd if destroy() arrives while set is pending, and bounds destroy() on a hung Redis command', async () => {
    // Subcase A: destroy() arrives while SET is in flight -> SADD is never issued.
    const fakeA = createFakeRedis();
    const trackerA = new WsRestrictedPresenceTracker(fakeA.client, { nodeId: 'node-a' });
    const leaseKeyA = `${WS_RESTRICTED_NODE_KEY_PREFIX}${trackerA.nodeKey}`;
    const setGate = deferred();
    fakeA.mocks.set.mockImplementationOnce(async (k: string, v: string) => {
      await setGate.promise;
      fakeA.strings.set(k, v);
      return 'OK';
    });

    const connectA = trackerA.syncLocal(true);
    const destroyA = trackerA.destroy();
    setGate.resolve();
    await Promise.all([connectA, destroyA]);

    expect(fakeA.mocks.sadd).not.toHaveBeenCalled();
    expect(fakeA.strings.has(leaseKeyA)).toBe(false);
    expect(fakeA.sets.get(WS_RESTRICTED_NODES_KEY)?.has(trackerA.nodeKey)).toBeFalsy();

    // Subcase B: hung Redis client never settles SET -> destroy() finishes within WS_REDIS_QUIT_TIMEOUT_MS and disconnects.
    jest.useFakeTimers();
    try {
      const fakeB = createFakeRedis();
      const disconnectSpy = jest.fn();
      const quitSpy = jest.fn(() => new Promise<void>(() => undefined));
      fakeB.client.disconnect = disconnectSpy;
      fakeB.client.quit = quitSpy;
      fakeB.mocks.set.mockImplementationOnce(() => new Promise(() => undefined));

      const trackerB = new WsRestrictedPresenceTracker(fakeB.client, { nodeId: 'node-b', ownsClient: true });
      void trackerB.syncLocal(true);
      let destroyed = false;
      const destroyB = trackerB.destroy().then(() => {
        destroyed = true;
      });

      await jest.advanceTimersByTimeAsync(WS_REDIS_QUIT_TIMEOUT_MS * 2);
      await destroyB;

      expect(destroyed).toBe(true);
      expect(disconnectSpy).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it.each<unknown>([undefined, null, 'OK', '', Number.NaN, -1, {}, '99999999999999999999'])(
    'fails open to true when atomic prune eval returns non-numeric or unsafe reply %p',
    async badReply => {
      const { client, mocks, sets } = createFakeRedis();
      sets.set(WS_RESTRICTED_NODES_KEY, new Set(['node-stale:1111']));
      mocks.eval.mockResolvedValueOnce(badReply);

      const tracker = new WsRestrictedPresenceTracker(client, { nodeId: 'node-a', cacheTtlMs: 0 });
      expect(await tracker.hasRestrictedNodes()).toBe(true);
    },
  );

  it('accepts safe decimal-digit string replies from atomic prune eval', async () => {
    const { client, mocks, sets } = createFakeRedis();
    sets.set(WS_RESTRICTED_NODES_KEY, new Set(['node-stale:1111']));
    const tracker = new WsRestrictedPresenceTracker(client, { nodeId: 'node-a', cacheTtlMs: 0 });

    mocks.eval.mockResolvedValueOnce('0');
    expect(await tracker.hasRestrictedNodes()).toBe(false);

    mocks.eval.mockResolvedValueOnce('2');
    expect(await tracker.hasRestrictedNodes()).toBe(true);
  });

  it('runs periodic heartbeat renewals and cleanups via bindLocalCheck and ignores post-destroy triggers', async () => {
    jest.useFakeTimers();
    try {
      const { client, mocks } = createFakeRedis();
      let localRestricted = true;
      const tracker = new WsRestrictedPresenceTracker(client, { heartbeatMs: 1_000 });
      tracker.bindLocalCheck(() => localRestricted);

      // Starting twice is idempotent.
      tracker.start();
      tracker.start();

      await jest.advanceTimersByTimeAsync(1_000);
      expect(mocks.set).toHaveBeenCalledTimes(1);
      expect(mocks.sadd).toHaveBeenCalledTimes(1);

      // Heartbeat clears presence once local restricted sockets disconnect, then idles cleanly.
      localRestricted = false;
      await jest.advanceTimersByTimeAsync(1_000);
      expect(mocks.srem).toHaveBeenCalledTimes(1);
      expect(mocks.del).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(1_000);
      expect(mocks.srem).toHaveBeenCalledTimes(1);

      await tracker.destroy();
      tracker.start();
      tracker.handleRedisReady();
      await tracker.syncLocal(true);
      expect(mocks.set).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('coalesces concurrent hasRestrictedNodes checks and fails open on absent, not-ready, or erroring clients', async () => {
    const nullTracker = new WsRestrictedPresenceTracker(null);
    nullTracker.start();
    expect(await nullTracker.hasRestrictedNodes()).toBe(true);
    await nullTracker.destroy();

    const { client, mocks } = createFakeRedis();
    const smembersGate = deferred<string[]>();
    mocks.smembers.mockImplementationOnce(() => smembersGate.promise);

    const tracker = new WsRestrictedPresenceTracker(client, { nodeId: 'node-a', ownsClient: true });
    const p1 = tracker.hasRestrictedNodes();
    const p2 = tracker.hasRestrictedNodes();
    smembersGate.resolve([]);
    expect(await Promise.all([p1, p2])).toEqual([false, false]);
    expect(mocks.smembers).toHaveBeenCalledTimes(1);

    // Non-Error rejections fail open and preserve resilience across register, unregister, and query.
    mocks.set.mockRejectedValueOnce('set-failed');
    await tracker.syncLocal(true);
    mocks.srem.mockRejectedValueOnce('srem-failed');
    await tracker.syncLocal(false);
    mocks.srem.mockRejectedValueOnce(new Error('srem-err'));
    await tracker.syncLocal(false);
    mocks.smembers.mockRejectedValueOnce('query-failed');
    expect(await tracker.hasRestrictedNodes()).toBe(true);

    // Disconnected client skips registerLocal without throwing and fails open on checks.
    (client as { status?: string }).status = 'connecting';
    await tracker.syncLocal(true);
    expect(await tracker.hasRestrictedNodes()).toBe(true);

    // Destroy with ownsClient=true and no quit() method completes cleanly.
    await tracker.destroy();
  });

  it('logs createDefault Redis error events without throwing', async () => {
    const tracker = WsRestrictedPresenceTracker.createDefault('node-err', () => false);
    const redis = redisInstances[0];
    expect(() => redis.handlers.error(new Error('socket reset'))).not.toThrow();
    await tracker.destroy();
  });

  it('shares a single WS_REDIS_QUIT_TIMEOUT_MS deadline across unregister and quit in destroy()', async () => {
    jest.useFakeTimers();
    try {
      const { client, mocks } = createFakeRedis();
      await new WsRestrictedPresenceTracker(client, { nodeId: 'node-a' }).syncLocal(true);

      const tracker = new WsRestrictedPresenceTracker(client, { nodeId: 'node-shared', ownsClient: true });
      await tracker.syncLocal(true);
      mocks.srem.mockImplementation(() => new Promise(() => undefined));
      client.quit = jest.fn(() => new Promise<string>(() => undefined));
      const disconnectSpy = jest.fn();
      client.disconnect = disconnectSpy;

      let destroyed = false;
      const done = tracker.destroy().then(() => {
        destroyed = true;
      });

      await jest.advanceTimersByTimeAsync(WS_REDIS_QUIT_TIMEOUT_MS);
      await done;

      expect(destroyed).toBe(true);
      expect(disconnectSpy).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('caches hasRestrictedNodes for a short TTL and invalidates immediately on local restricted changes', async () => {
    jest.useFakeTimers();
    try {
      const { client, mocks } = createFakeRedis();
      const tracker = new WsRestrictedPresenceTracker(client, { nodeId: 'node-cache', cacheTtlMs: 2_000 });

      expect(await tracker.hasRestrictedNodes()).toBe(false);
      expect(mocks.smembers).toHaveBeenCalledTimes(1);

      // Repeated lookups inside TTL use cached result without hitting Redis again.
      expect(await tracker.hasRestrictedNodes()).toBe(false);
      expect(mocks.smembers).toHaveBeenCalledTimes(1);

      // Local restricted state update invalidates the cached answer immediately.
      await tracker.syncLocal(true);
      expect(await tracker.hasRestrictedNodes()).toBe(true);
      expect(mocks.smembers).toHaveBeenCalledTimes(2);

      // TTL expiry refreshes from Redis.
      await jest.advanceTimersByTimeAsync(2_001);
      expect(await tracker.hasRestrictedNodes()).toBe(true);
      expect(mocks.smembers).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });
});
