import { SessionEngineLifecycle } from './session-engine-lifecycle.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { Session, SessionStatus } from './entities/session.entity';
import { AuditAction } from '../audit/entities/audit-log.entity';
import type { EngineEventCallbacks } from '../../engine/interfaces/whatsapp-engine.interface';

const ID = '77777777-7777-4777-8777-777777777777';
const BOUND = '628111';
const OTHER = '628999';

/** Yields to the event loop until `condition` holds, failing after a real-time deadline. */
async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(resolve => setImmediate(resolve));
  }
}

/**
 * FAILED is terminal: neither the boot reset nor the takeover sweep resumes it, so a node whose lease lapsed
 * must not write it onto a row a peer may own now. These are the lifecycle and start-path writers of FAILED,
 * driven through the real lifecycle and registry; ownership is lost while the session runs here.
 */
function fixture({ config = {}, initFails = false }: { config?: object; initFails?: boolean } = {}) {
  const stored = {
    id: ID,
    name: 'failed-write-fence',
    phone: BOUND,
    config,
    status: SessionStatus.DISCONNECTED,
    desiredState: null,
    nodeId: null,
  } as unknown as Session;
  const repository = {
    findOne: jest.fn(() => Promise.resolve({ ...stored })),
    exists: jest.fn().mockResolvedValue(true),
    update: jest.fn((_where: unknown, patch: Partial<Session>) => {
      Object.assign(stored, patch);
      return Promise.resolve({ affected: 1 });
    }),
  };
  let owned = true;
  const engines: Array<{ initialize: jest.Mock; forceDestroy: jest.Mock; logout: jest.Mock }> = [];
  const factory = {
    create: jest.fn(() => {
      const engine = {
        initialize: jest.fn(() => {
          if (!initFails) return Promise.resolve();
          // The lease lapses during the launch, which then fails.
          if (!owned) loseLease();
          return Promise.reject(new Error('Chromium failed to launch'));
        }),
        destroy: jest.fn().mockResolvedValue(undefined),
        forceDestroy: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn().mockResolvedValue(undefined),
        logout: jest.fn().mockResolvedValue(undefined),
      };
      engines.push(engine);
      return engine;
    }),
    purgeSessionData: jest.fn().mockResolvedValue(undefined),
  };
  const errors = new Map<string, string>();
  const state = {
    attachTo: <T>(value: T): T => value,
    clear: jest.fn((id: string) => errors.delete(id)),
    set: jest.fn((id: string, reason: string) => errors.set(id, reason)),
    get: jest.fn((id: string) => errors.get(id)),
  };
  const restrictions = { attachTo: <T>(value: T): T => value, clear: jest.fn(), clearIfDisprovedByReady: jest.fn() };
  const audit = { logWarn: jest.fn().mockResolvedValue(undefined), logInfo: jest.fn().mockResolvedValue(undefined) };
  const registry = new EngineRegistry();
  const lifecycle = new SessionEngineLifecycle(
    repository as never,
    {} as never,
    factory as never,
    registry,
    { clear: jest.fn() } as never,
    {} as never,
    state as never,
    restrictions as never,
    { clear: jest.fn(), getOwnIntent: jest.fn() } as never,
    {
      emitSessionStatus: jest.fn(),
      emitSessionDisconnected: jest.fn(),
      emitSessionAuthenticated: jest.fn(),
      emitQRCode: jest.fn(),
    } as never,
    { dispatch: jest.fn().mockResolvedValue(undefined) } as never,
    { execute: jest.fn().mockResolvedValue({ continue: true }) } as never,
    {} as never,
    undefined,
    undefined,
    audit as never,
  );
  const internals = lifecycle as unknown as {
    ownership?: { owns: () => boolean };
    reconnectStates: Map<string, unknown>;
  };
  // No ownership service means this node owns every session; a lost lease swaps in one that owns none.
  const loseLease = (): void => {
    internals.ownership = { owns: () => false };
  };
  const failedWrites = (): number =>
    repository.update.mock.calls.filter(([, patch]) => patch.status === SessionStatus.FAILED).length;
  const callbacksOf = (index: number): EngineEventCallbacks =>
    (engines[index].initialize.mock.calls as unknown as [EngineEventCallbacks][])[0][0];
  return {
    lifecycle,
    registry,
    stored,
    engines,
    errors,
    audit,
    loseLease,
    failedWrites,
    reconnectStates: internals.reconnectStates,
    callbacksOf,
    /** Whether the lease still holds when the launch fails. */
    keepLeaseThroughLaunch: (value: boolean): void => {
      owned = value;
    },
  };
}

describe('the FAILED writers fenced on ownership', () => {
  const cases = [
    { node: 'owns', owns: true, writes: 1 },
    { node: 'no longer owns', owns: false, writes: 0 },
  ];

  it.each(cases)(
    'an exhausted reconnect writes FAILED $writes time(s) when this node $node the session',
    async ({ owns, writes }) => {
      const f = fixture({ config: { maxReconnectAttempts: 0 } });
      await f.lifecycle.start(ID);
      if (!owns) f.loseLease();

      await f.lifecycle.handleEngineDisconnected(ID, f.registry.get(ID)!, 'NAVIGATION');

      expect(f.failedWrites()).toBe(writes);
      // The rest of the terminal path runs either way: the reason, the eviction, the dropped reconnect.
      expect(f.errors.get(ID)).toMatch(/Auto-reconnect is disabled/);
      expect(f.registry.get(ID)).toBeUndefined();
      await until(() => f.engines[0].forceDestroy.mock.calls.length === 1, 'the engine to be destroyed');
      expect(f.reconnectStates.has(ID)).toBe(false);
    },
  );

  it.each(cases)(
    'a start whose launch fails writes FAILED $writes time(s) when this node $node the session',
    async ({ owns, writes }) => {
      const f = fixture({ initFails: true });
      f.keepLeaseThroughLaunch(owns);

      await expect(f.lifecycle.start(ID)).rejects.toThrow('Chromium failed to launch');

      expect(f.failedWrites()).toBe(writes);
      expect(f.errors.get(ID)).toBe('Chromium failed to launch');
      expect(f.engines[0].forceDestroy).toHaveBeenCalledTimes(1);
      expect(f.registry.get(ID)).toBeUndefined();
    },
  );

  it.each(cases)(
    'a rejected link from a different number writes FAILED $writes time(s) when this node $node the session',
    async ({ owns, writes }) => {
      const f = fixture();
      await f.lifecycle.start(ID);
      if (!owns) f.loseLease();
      const rejection = jest.spyOn(f.lifecycle as unknown as { rejectRebind: () => Promise<void> }, 'rejectRebind');

      f.callbacksOf(0).onReady?.(OTHER, 'Other');
      expect(rejection).toHaveBeenCalledTimes(1);
      await rejection.mock.results[0].value;

      expect(f.failedWrites()).toBe(writes);
      // The rejection is still recorded and the other account is still logged out of this device.
      expect(f.audit.logWarn).toHaveBeenCalledWith(
        AuditAction.SESSION_REBIND_REJECTED,
        expect.objectContaining({ sessionId: ID, metadata: { previousPhone: BOUND, incomingPhone: OTHER } }),
      );
      expect(f.engines[0].logout).toHaveBeenCalledTimes(1);
      expect(f.registry.get(ID)).toBeUndefined();
      expect(f.stored.phone).toBe(BOUND);
    },
  );
});
