import { SessionEngineLifecycle } from './session-engine-lifecycle.service';
import { SessionErrorStore } from './session-error-store.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { Session, SessionStatus } from './entities/session.entity';
import type { EngineEventCallbacks } from '../../engine/interfaces/whatsapp-engine.interface';

const ID = '88888888-8888-4888-8888-888888888888';

/**
 * A relaunch that never finishes (WhatsApp Web unreachable, a proxy that accepts and never answers) hits the
 * init deadline. During a reconnect the session waits out the backoff before the next attempt, and that wait
 * must show the reason as a relaunch that rejects does: INITIALIZING with lastError, not DISCONNECTED.
 */
function fixture() {
  const stored = {
    id: ID,
    name: 'reconnect-init-timeout',
    phone: '628111',
    config: { reconnectBaseDelay: 1000 },
    status: SessionStatus.READY,
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
  const engines: Array<Record<'initialize' | 'destroy' | 'forceDestroy', jest.Mock>> = [];
  const factory = {
    create: jest.fn(() => {
      const engine = {
        // The first launch comes up; every relaunch hangs.
        initialize: jest.fn(() => (engines.length === 1 ? Promise.resolve() : new Promise<void>(() => undefined))),
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
  const errors = new SessionErrorStore();
  const restrictions = { attachTo: <T>(value: T): T => value, clear: jest.fn(), clearIfDisprovedByReady: jest.fn() };
  const events = {
    emitSessionStatus: jest.fn(),
    emitSessionDisconnected: jest.fn(),
    emitSessionAuthenticated: jest.fn(),
  };
  const registry = new EngineRegistry();
  const lifecycle = new SessionEngineLifecycle(
    repository as never,
    {} as never,
    factory as never,
    registry,
    { clear: jest.fn() } as never,
    {} as never,
    errors,
    restrictions as never,
    { clear: jest.fn(), getOwnIntent: jest.fn() } as never,
    events as never,
    { dispatch: jest.fn().mockResolvedValue(undefined) } as never,
    { execute: jest.fn().mockResolvedValue({ continue: true }) } as never,
    {} as never,
    undefined,
    undefined,
    { logWarn: jest.fn().mockResolvedValue(undefined), logInfo: jest.fn().mockResolvedValue(undefined) } as never,
  );
  const callbacksOf = (index: number): EngineEventCallbacks =>
    (engines[index].initialize.mock.calls as [EngineEventCallbacks][])[0][0];
  return { lifecycle, registry, stored, engines, errors, events, callbacksOf };
}

describe('a reconnect whose relaunch hits the init deadline', () => {
  const previous = process.env.WWEBJS_AUTH_TIMEOUT_MS;
  beforeEach(() => {
    delete process.env.WWEBJS_AUTH_TIMEOUT_MS;
    // No jitter: the first attempt fires after 1 s and the second 2 s after the first one fails.
    jest.spyOn(Math, 'random').mockReturnValue(0);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    if (previous === undefined) delete process.env.WWEBJS_AUTH_TIMEOUT_MS;
    else process.env.WWEBJS_AUTH_TIMEOUT_MS = previous;
  });

  it('stays initializing with the timeout as lastError while the next attempt waits', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    f.callbacksOf(0).onReady?.('628111', 'Bound');
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'Date'] });

    f.callbacksOf(0).onDisconnected?.('NAVIGATION');
    await jest.advanceTimersByTimeAsync(1_000);
    expect(f.engines).toHaveLength(2);
    expect(f.engines[1].initialize).toHaveBeenCalled();

    // The 60 s deadline fires; the second attempt is armed 2 s later.
    await jest.advanceTimersByTimeAsync(60_000);
    expect(f.engines[1].forceDestroy).toHaveBeenCalled();
    expect(f.registry.has(ID)).toBe(false);
    expect(f.engines).toHaveLength(2);

    expect(f.stored.status).toBe(SessionStatus.INITIALIZING);
    expect(f.errors.attachTo({ ...f.stored }).lastError).toMatch(/timed out after 60000ms/);
    expect(f.events.emitSessionStatus).toHaveBeenLastCalledWith(ID, SessionStatus.INITIALIZING);

    await jest.advanceTimersByTimeAsync(2_000);
    expect(f.engines).toHaveLength(3);
  });
});
