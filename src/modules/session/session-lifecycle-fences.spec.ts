import { ConflictException } from '@nestjs/common';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { SessionLifecycleFences } from './session-lifecycle-fences';

/**
 * Direct invariant coverage for the credential-teardown / initial-status fences. Until now these
 * semantics were pinned only through the session-service suite's white-box pokes on the lifecycle's
 * fields; these specs name the invariants (INV-8's fence, the fail-closed 409, the settlement
 * chaining, the identity-checked removals) against the unit itself.
 */
describe('SessionLifecycleFences', () => {
  const engine = (over: Partial<IWhatsAppEngine> = {}): IWhatsAppEngine => over as IWhatsAppEngine;

  const makeFences = () => {
    const engines = new EngineRegistry();
    const pendingTeardowns = new Map<string, Promise<void>>();
    const pendingInitialStatuses = new Map<string, { engine: IWhatsAppEngine; promise: Promise<void> }>();
    const fences = new SessionLifecycleFences({
      engines,
      pendingTeardowns,
      pendingInitialStatuses,
      logger: console as never,
    });
    return { fences, engines, pendingTeardowns, pendingInitialStatuses };
  };

  describe('teardownEngineSafely', () => {
    it('resolves true when the teardown completes', async () => {
      const { fences } = makeFences();
      const destroy = jest.fn().mockResolvedValue(undefined);
      await expect(fences.teardownEngineSafely('s1', engine({ destroy }), e => e.destroy(), 'destroy')).resolves.toBe(
        true,
      );
      expect(destroy).toHaveBeenCalledTimes(1);
    });

    it('resolves false (never rejects) when the teardown throws, so the caller can reconcile the map anyway', async () => {
      const { fences } = makeFences();
      const destroy = jest.fn().mockRejectedValue(new Error('Target closed'));
      await expect(fences.teardownEngineSafely('s1', engine({ destroy }), e => e.destroy(), 'destroy')).resolves.toBe(
        false,
      );
    });

    it('tracks the RAW logout promise under the session NAME before racing the deadline', async () => {
      const { fences, pendingTeardowns } = makeFences();
      let settle!: () => void;
      const logout = jest.fn().mockImplementation(() => new Promise<void>(resolve => (settle = resolve)));
      const pending = fences.teardownEngineSafely('s1', engine({ logout }), e => e.logout(), 'logout', 'main');
      expect(pendingTeardowns.has('main')).toBe(true);
      settle();
      await expect(pending).resolves.toBe(true);
    });
  });

  describe('trackPendingCredentialTeardown', () => {
    it('chains a concurrent teardown onto the previous entry instead of overwriting it', async () => {
      const { fences, pendingTeardowns } = makeFences();
      let settleFirst!: () => void;
      const first = new Promise<void>(resolve => (settleFirst = resolve));
      fences.trackPendingCredentialTeardown('main', first);

      let settleSecond!: () => void;
      const second = new Promise<void>(resolve => (settleSecond = resolve));
      fences.trackPendingCredentialTeardown('main', second);

      // The FIRST settling alone must not drop the entry: the second teardown is still in flight.
      settleFirst();
      await Promise.resolve();
      await Promise.resolve();
      expect(pendingTeardowns.has('main')).toBe(true);

      settleSecond();
      await pendingTeardowns.get('main');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(pendingTeardowns.has('main')).toBe(false);
    });

    it('never rejects the tracked entry even when the raw teardown rejects', async () => {
      const { fences, pendingTeardowns } = makeFences();
      fences.trackPendingCredentialTeardown('main', Promise.reject(new Error('rm failed')));
      await expect(pendingTeardowns.get('main')).resolves.toBeUndefined();
    });
  });

  describe('awaitPendingTeardown (fail-closed fence, INV-8)', () => {
    it('is a no-op when nothing is pending under the name', async () => {
      const { fences } = makeFences();
      await expect(fences.awaitPendingTeardown('main')).resolves.toBeUndefined();
    });

    it('resolves once the tracked teardown settles', async () => {
      const { fences } = makeFences();
      let settle!: () => void;
      fences.trackPendingCredentialTeardown('main', new Promise<void>(resolve => (settle = resolve)));
      settle();
      await expect(fences.awaitPendingTeardown('main')).resolves.toBeUndefined();
    });

    it('refuses with the retryable 409 SESSION_NAME_TEARDOWN_PENDING when the bound is exhausted', async () => {
      const { fences, pendingTeardowns } = makeFences();
      jest.useFakeTimers();
      try {
        fences.trackPendingCredentialTeardown('main', new Promise<void>(() => undefined));
        const waiting = fences.awaitPendingTeardown('main');
        jest.advanceTimersByTime(10_001);
        await expect(waiting).rejects.toMatchObject({
          status: 409,
          response: { code: 'SESSION_NAME_TEARDOWN_PENDING' },
        });
        expect(ConflictException).toBeDefined();
        // Fail closed: the entry survives so a retry after settlement can proceed.
        expect(pendingTeardowns.has('main')).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('awaitInitialStatus (control action stays the final persisted owner)', () => {
    it('awaits ONLY the captured engine entry, never a replacement', async () => {
      const { fences, pendingInitialStatuses } = makeFences();
      const engineA = engine();
      const engineB = engine();
      let settleA!: () => void;
      const promiseA = new Promise<void>(resolve => (settleA = resolve));
      pendingInitialStatuses.set('s1', { engine: engineA, promise: promiseA });

      const waiting = fences.awaitInitialStatus('s1', engineB);
      // engineB's await must NOT wait on engineA's promise: it settles immediately.
      await expect(waiting).resolves.toBeUndefined();

      // And the entry for A is untouched by B's call.
      expect(pendingInitialStatuses.get('s1')?.engine).toBe(engineA);
      settleA();
    });

    it('awaits the captured engine entry when identities match', async () => {
      const { fences, pendingInitialStatuses } = makeFences();
      const engineA = engine();
      let settle!: () => void;
      pendingInitialStatuses.set('s1', { engine: engineA, promise: new Promise<void>(resolve => (settle = resolve)) });

      let settled = false;
      const waiting = fences.awaitInitialStatus('s1', engineA).then(() => (settled = true));
      await Promise.resolve();
      expect(settled).toBe(false);
      settle();
      await waiting;
      expect(settled).toBe(true);
    });
  });

  describe('evictAndForceDestroy', () => {
    it('removes the engine from the registry and force-destroys (never graceful destroy)', async () => {
      const { fences, engines } = makeFences();
      const forceDestroy = jest.fn().mockResolvedValue(undefined);
      const destroy = jest.fn().mockResolvedValue(undefined);
      const e = engine({ forceDestroy, destroy });
      engines.set('s1', e);

      fences.evictAndForceDestroy('s1', e);

      expect(engines.has('s1')).toBe(false);
      await Promise.resolve();
      await Promise.resolve();
      expect(forceDestroy).toHaveBeenCalledTimes(1);
      expect(destroy).not.toHaveBeenCalled();
    });

    it('leaves a replacement engine registered and still force-destroys the stale one', async () => {
      const { fences, engines } = makeFences();
      const staleKill = jest.fn().mockResolvedValue(undefined);
      const liveKill = jest.fn().mockResolvedValue(undefined);
      const stale = engine({ forceDestroy: staleKill });
      const live = engine({ forceDestroy: liveKill });
      engines.set('s1', live);

      fences.evictAndForceDestroy('s1', stale);

      expect(engines.get('s1')).toBe(live);
      await Promise.resolve();
      await Promise.resolve();
      expect(staleKill).toHaveBeenCalledTimes(1);
      expect(liveKill).not.toHaveBeenCalled();
    });
  });
});
