import { SessionLidResolver } from './session-lid-resolver.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import type { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import type { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';

describe('SessionLidResolver', () => {
  let engines: EngineRegistry;
  let resolveContactPhone: jest.Mock;
  let remember: jest.Mock;
  let resolver: SessionLidResolver;

  beforeEach(() => {
    engines = new EngineRegistry();
    resolveContactPhone = jest.fn().mockResolvedValue('628111222333');
    engines.set('s1', { resolveContactPhone } as unknown as IWhatsAppEngine);
    remember = jest.fn().mockResolvedValue(undefined);
    resolver = new SessionLidResolver(engines, { remember } as unknown as LidMappingStoreService);
  });

  it('resolves a phone through the engine', async () => {
    await expect(resolver.resolveSenderPhone('s1', '111@lid')).resolves.toBe('628111222333');
    expect(resolveContactPhone).toHaveBeenCalledWith('111@lid');
  });

  it('caches a hit so a chatty sender is queried once', async () => {
    await resolver.resolveSenderPhone('s1', '111@lid');
    await resolver.resolveSenderPhone('s1', '111@lid');

    expect(resolveContactPhone).toHaveBeenCalledTimes(1);
  });

  it('caches a miss too, so an unmapped sender does not re-query every message', async () => {
    resolveContactPhone.mockResolvedValue(null);

    await expect(resolver.resolveSenderPhone('s1', '404@lid')).resolves.toBeNull();
    await expect(resolver.resolveSenderPhone('s1', '404@lid')).resolves.toBeNull();

    expect(resolveContactPhone).toHaveBeenCalledTimes(1);
  });

  it('keys the cache per session, so two sessions resolve independently', async () => {
    engines.set('s2', { resolveContactPhone } as unknown as IWhatsAppEngine);

    await resolver.resolveSenderPhone('s1', '111@lid');
    await resolver.resolveSenderPhone('s2', '111@lid');

    expect(resolveContactPhone).toHaveBeenCalledTimes(2);
  });

  it('returns null (never throws) when the engine rejects', async () => {
    resolveContactPhone.mockRejectedValue(new Error('socket closed'));

    await expect(resolver.resolveSenderPhone('s1', '111@lid')).resolves.toBeNull();
  });

  it('returns null when the session has no live engine', async () => {
    await expect(resolver.resolveSenderPhone('not-started', '111@lid')).resolves.toBeNull();
  });

  it('persists a real resolution to the shared lid mapping store', async () => {
    await resolver.resolveSenderPhone('s1', '111@lid');

    expect(remember).toHaveBeenCalledWith('111', '628111222333', 's1');
  });

  it('persists a definitive null resolution so a stale mapping converges (#1058)', async () => {
    resolveContactPhone.mockResolvedValue(null);

    await resolver.resolveSenderPhone('s1', '404@lid');

    expect(remember).toHaveBeenCalledWith('404', null, 's1');
  });

  it('does not persist a transient failure (engine rejects) as a null mapping', async () => {
    resolveContactPhone.mockRejectedValue(new Error('socket closed'));

    await resolver.resolveSenderPhone('s1', '111@lid');

    expect(remember).not.toHaveBeenCalled();
  });

  it('does not persist when there is no live engine (transient, not definitive)', async () => {
    await resolver.resolveSenderPhone('not-started', '111@lid');

    expect(remember).not.toHaveBeenCalled();
  });

  it('never rejects when the mapping store write fails (fire-and-forget)', async () => {
    remember.mockRejectedValue(new Error('db down'));

    await expect(resolver.resolveSenderPhone('s1', '111@lid')).resolves.toBe('628111222333');
  });

  it('works without a mapping store at all (optional dependency)', async () => {
    const bare = new SessionLidResolver(engines);

    await expect(bare.resolveSenderPhone('s1', '111@lid')).resolves.toBe('628111222333');
  });

  it('evicts the oldest entry once the cache is full, bounding memory', async () => {
    const max = 5000;
    // Fill past the cap; the first key inserted must be the one evicted (FIFO).
    for (let i = 0; i < max; i++) {
      resolveContactPhone.mockResolvedValue(`phone-${i}`);
      await resolver.resolveSenderPhone('s1', `${i}@lid`);
    }
    expect(resolveContactPhone).toHaveBeenCalledTimes(max);

    // One more insert evicts the oldest ('0@lid').
    resolveContactPhone.mockResolvedValue('phone-new');
    await resolver.resolveSenderPhone('s1', 'new@lid');

    // The evicted key must be re-queried; a still-cached one must not be.
    resolveContactPhone.mockClear();
    await resolver.resolveSenderPhone('s1', '0@lid');
    expect(resolveContactPhone).toHaveBeenCalledTimes(1);

    resolveContactPhone.mockClear();
    await resolver.resolveSenderPhone('s1', `${max - 1}@lid`);
    expect(resolveContactPhone).not.toHaveBeenCalled();
  });
});
