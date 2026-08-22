import { DistributedKeyedLock, OrderingRedis } from './ordering-lock';

/**
 * Fake Redis for the lock: SET NX PX + the compare-and-del eval, with manual time control via
 * expiry timestamps. Enough surface to prove acquisition, contention, fenced release and the
 * degraded path — the semantics the real ioredis client provides.
 */
class FakeRedis implements OrderingRedis {
  readonly store = new Map<string, { value: string; expiresAt: number }>();
  failNextSet = false;

  set(key: string, value: string, _px: 'PX', ttlMs: number, _nx: 'NX'): Promise<'OK' | null> {
    if (this.failNextSet) {
      this.failNextSet = false;
      return Promise.reject(new Error('ECONNREFUSED'));
    }
    const existing = this.store.get(key);
    if (existing && existing.expiresAt > Date.now()) return Promise.resolve(null);
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
    return Promise.resolve('OK');
  }

  eval(_script: string, _numKeys: number, key: string, token: string): Promise<unknown> {
    const existing = this.store.get(key);
    if (existing && existing.value === token) {
      this.store.delete(key);
      return Promise.resolve(1);
    }
    return Promise.resolve(0);
  }
}

describe('DistributedKeyedLock', () => {
  it('serializes two pods contending on one key — the second enters only after the first releases', async () => {
    const redis = new FakeRedis();
    const podA = new DistributedKeyedLock('t', redis, { retryDelayMs: 5 });
    const podB = new DistributedKeyedLock('t', redis, { retryDelayMs: 5 });

    const events: string[] = [];
    let releaseA: () => void = () => undefined;
    const aInside = new Promise<void>(resolve => {
      void podA.run('conv-1', async () => {
        events.push('A-in');
        resolve();
        await new Promise<void>(r => (releaseA = r));
        events.push('A-out');
      });
    });

    await aInside;
    const b = podB.run('conv-1', () => {
      events.push('B-in');
      return Promise.resolve('done');
    });
    // Give B time to spin on the held lock; it must not have entered.
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(events).toEqual(['A-in']);

    releaseA();
    await expect(b).resolves.toBe('done');
    expect(events).toEqual(['A-in', 'A-out', 'B-in']);
  });

  it('different keys never contend', async () => {
    const redis = new FakeRedis();
    const lock = new DistributedKeyedLock('t', redis, { retryDelayMs: 5 });
    const order: string[] = [];

    await Promise.all([
      lock.run('conv-1', async () => void order.push('one')),
      lock.run('conv-2', async () => void order.push('two')),
    ]);

    expect(order.sort()).toEqual(['one', 'two']);
  });

  it('releases with a fence: a lock that expired and was re-acquired elsewhere is not deleted', async () => {
    const redis = new FakeRedis();
    const lock = new DistributedKeyedLock('t', redis, { ttlMs: 1, retryDelayMs: 5 });

    await lock.run('conv-1', async () => {
      // Simulate the TTL lapsing mid-critical-section and another pod re-acquiring.
      await new Promise(resolve => setTimeout(resolve, 5));
      redis.store.set('openwa:lock:t:conv-1', { value: 'other-pod-token', expiresAt: Date.now() + 60_000 });
    });

    // The fenced release must have left the other pod's lock in place.
    expect(redis.store.get('openwa:lock:t:conv-1')?.value).toBe('other-pod-token');
  });

  it('degrades to local ordering when Redis errors, instead of failing the dispatch', async () => {
    const redis = new FakeRedis();
    const lock = new DistributedKeyedLock('t', redis, { retryDelayMs: 5 });
    redis.failNextSet = true;

    await expect(lock.run('conv-1', () => Promise.resolve('delivered'))).resolves.toBe('delivered');
  });

  it('times out a hopeless wait with an error so the queue retry re-enters later', async () => {
    const redis = new FakeRedis();
    redis.store.set('openwa:lock:t:conv-1', { value: 'stuck', expiresAt: Date.now() + 60_000 });
    const lock = new DistributedKeyedLock('t', redis, { retryDelayMs: 5, maxWaitMs: 30 });

    await expect(lock.run('conv-1', () => Promise.resolve('never'))).rejects.toThrow(/ordering lock wait exceeded/);
  });
});
