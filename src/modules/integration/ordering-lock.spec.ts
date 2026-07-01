import { KeyedAsyncLock, orderingKeyFor } from './ordering-lock';
import { IngressJobData } from '../queue/processors/ingress.processor';

describe('KeyedAsyncLock', () => {
  it('serializes runs sharing a key, preserving FIFO order', async () => {
    const lock = new KeyedAsyncLock();
    const order: number[] = [];
    const mk = (n: number, delay: number) =>
      lock.run('k', async () => {
        await new Promise(r => setTimeout(r, delay));
        order.push(n);
      });
    // Same key: even though 1 is slower, 1 must finish before 2 starts (FIFO by enqueue order).
    await Promise.all([mk(1, 20), mk(2, 1)]);
    expect(order).toEqual([1, 2]);
  });

  it('runs different keys concurrently', async () => {
    const lock = new KeyedAsyncLock();
    let concurrent = 0;
    let maxConcurrent = 0;
    const mk = (k: string) =>
      lock.run(k, async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise(r => setTimeout(r, 10));
        concurrent--;
      });
    await Promise.all([mk('a'), mk('b'), mk('c')]);
    expect(maxConcurrent).toBeGreaterThan(1);
  });

  it('releases the key even when the guarded fn throws', async () => {
    const lock = new KeyedAsyncLock();
    await expect(
      // eslint-disable-next-line @typescript-eslint/require-await -- fn must match () => Promise<T>
      lock.run('k', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // The key must be free again for the next run.
    // eslint-disable-next-line @typescript-eslint/require-await -- fn must match () => Promise<T>
    await expect(lock.run('k', async () => 'ok')).resolves.toBe('ok');
  });
});

describe('orderingKeyFor', () => {
  function job(overrides: Partial<IngressJobData> = {}): IngressJobData {
    return {
      pluginId: 'chatwoot',
      instanceId: 'acct1',
      route: 'chatwoot',
      deliveryId: 'd1',
      payload: { headers: {}, query: {}, body: '{}', rawBody: '{}' },
      ...overrides,
    };
  }

  it('keys on instanceId + providerConversationId when present', () => {
    expect(orderingKeyFor(job({ providerConversationId: 'c1' }))).toBe('acct1:c1');
  });

  it('two jobs with the same providerConversationId share a key', () => {
    const a = orderingKeyFor(job({ deliveryId: 'd1', providerConversationId: 'c1' }));
    const b = orderingKeyFor(job({ deliveryId: 'd2', providerConversationId: 'c1' }));
    expect(a).toBe(b);
  });

  it('two jobs with different providerConversationId do not share a key', () => {
    const a = orderingKeyFor(job({ providerConversationId: 'c1' }));
    const b = orderingKeyFor(job({ providerConversationId: 'c2' }));
    expect(a).not.toBe(b);
  });

  it('falls back to a per-instance key when providerConversationId is absent', () => {
    expect(orderingKeyFor(job())).toBe('instance:acct1');
  });

  it('two jobs with no providerConversationId on the same instance share the fallback key', () => {
    const a = orderingKeyFor(job({ deliveryId: 'd1' }));
    const b = orderingKeyFor(job({ deliveryId: 'd2' }));
    expect(a).toBe(b);
  });

  it('never keys on deliveryId', () => {
    const a = orderingKeyFor(job({ deliveryId: 'd1', providerConversationId: 'c1' }));
    const b = orderingKeyFor(job({ deliveryId: 'd2', providerConversationId: 'c1' }));
    expect(a).not.toContain('d1');
    expect(a).not.toContain('d2');
    expect(a).toBe(b);
  });
});
