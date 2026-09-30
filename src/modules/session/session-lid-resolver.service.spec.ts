import { SessionLidResolver } from './session-lid-resolver.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import type { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import type { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { LidNotMappedError } from '../../common/errors/lid-not-mapped.error';

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

  describe('a rejected lookup', () => {
    let now: jest.SpyInstance<number, []>;
    beforeEach(() => {
      now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    });
    afterEach(() => now.mockRestore());

    it('does not cache a transient failure, so the sender resolves once the engine answers', async () => {
      resolveContactPhone.mockRejectedValueOnce(new Error('Evaluation failed')).mockResolvedValueOnce('628111');

      await expect(resolver.resolveSenderPhone('s1', '111@lid')).resolves.toBeNull();
      await expect(resolver.resolveSenderPhone('s1', '111@lid')).resolves.toBe('628111');
      expect(resolveContactPhone).toHaveBeenCalledTimes(2);
    });

    it('retries an unmapped lid once the hold expires', async () => {
      resolveContactPhone.mockRejectedValueOnce(new LidNotMappedError('111@lid')).mockResolvedValueOnce('628111');

      await expect(resolver.resolveSenderPhone('s1', '111@lid')).resolves.toBeNull();
      now.mockReturnValue(1_000_000 + 60_001);
      await expect(resolver.resolveSenderPhone('s1', '111@lid')).resolves.toBe('628111');
      expect(resolveContactPhone).toHaveBeenCalledTimes(2);
    });

    it('does not retry an unmapped lid on every message from the same sender, and writes nothing', async () => {
      resolveContactPhone.mockRejectedValue(new LidNotMappedError('404@lid'));

      await expect(resolver.resolveSenderPhone('s1', '404@lid')).resolves.toBeNull();
      now.mockReturnValue(1_000_000 + 59_000);
      await expect(resolver.resolveSenderPhone('s1', '404@lid')).resolves.toBeNull();

      expect(resolveContactPhone).toHaveBeenCalledTimes(1);
      expect(remember).not.toHaveBeenCalled();
    });
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

  // The wwjs adapter used to swallow every lookup failure into null, so this guard was dead on
  // that engine: a dead page or rate-limit read as "no mapping" and clobbered a valid stored
  // row. The adapter now rejects on failure (the HTTP boundary nulls instead), which is what
  // makes the guard above real; this case pins that the persisted-negative path still fires for
  // a DEFINITIVE null (the engine answered: no mapping).
  it('persists a definitive null (the engine answered no-mapping) even on wwjs', async () => {
    resolveContactPhone.mockResolvedValue(null);

    await resolver.resolveSenderPhone('s1', '222@lid');

    expect(remember).toHaveBeenCalledWith('222', null, 's1');
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
