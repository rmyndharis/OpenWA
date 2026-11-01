import { SessionEngineLifecycle } from './session-engine-lifecycle.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { Session, SessionStatus } from './entities/session.entity';
import type { EngineEventCallbacks } from '../../engine/interfaces/whatsapp-engine.interface';

const ID = '77777777-7777-4777-8777-777777777777';
const BOUND = '628111';
const WATCHDOG = 'liveness probe failed (watchdog)';

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(resolve => setImmediate(resolve));
  }
}

type Gate = { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void };

function fixture(maxReconnectAttempts = 1) {
  const stored = {
    id: ID,
    name: 'reconnect-teardown-overlap',
    phone: BOUND,
    config: { reconnectBaseDelay: 1000, maxReconnectAttempts },
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

  const engines: Array<{
    initialize: jest.Mock;
    destroy: jest.Mock;
    forceDestroy: jest.Mock;
  }> = [];
  const gates = new Map<string, Gate>();
  const hold = (step: 'initialize' | 'destroy', index: number): Gate => {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const gate = { promise, resolve, reject };
    gates.set(`${step}:${index}`, gate);
    return gate;
  };

  const factory = {
    create: jest.fn(() => {
      const index = engines.length;
      const step = (name: string) => (): Promise<void> => gates.get(`${name}:${index}`)?.promise ?? Promise.resolve();
      const engine = {
        initialize: jest.fn(step('initialize')),
        destroy: jest.fn(step('destroy')),
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
  const errorStore = {
    attachTo: <T>(value: T): T => value,
    clear: jest.fn((id: string) => errors.delete(id)),
    set: jest.fn((id: string, reason: string) => errors.set(id, reason)),
    get: jest.fn((id: string) => errors.get(id)),
  };
  const restrictions = { attachTo: <T>(value: T): T => value, clear: jest.fn(), clearIfDisprovedByReady: jest.fn() };
  const presence = { clear: jest.fn(), getOwnIntent: jest.fn() };
  const events = {
    emitSessionStatus: jest.fn(),
    emitSessionDisconnected: jest.fn(),
    emitSessionAuthenticated: jest.fn(),
    emitQRCode: jest.fn(),
  };
  const audit = { logWarn: jest.fn().mockResolvedValue(undefined), logInfo: jest.fn().mockResolvedValue(undefined) };
  const webhooks = { dispatch: jest.fn().mockResolvedValue(undefined) };
  const hooks = { execute: jest.fn().mockResolvedValue({ continue: true }) };
  const registry = new EngineRegistry();
  const lifecycle = new SessionEngineLifecycle(
    repository as never,
    {} as never,
    factory as never,
    registry,
    { clear: jest.fn() } as never,
    {} as never,
    errorStore as never,
    restrictions as never,
    presence as never,
    events as never,
    webhooks as never,
    hooks as never,
    {} as never,
    undefined,
    undefined,
    audit as never,
  );

  const handled = jest.spyOn(lifecycle, 'handleEngineDisconnected');
  const settled = async (): Promise<void> => {
    await Promise.all(handled.mock.results.map(result => result.value as Promise<void>));
  };
  const callbacksOf = (index: number): EngineEventCallbacks =>
    (engines[index].initialize.mock.calls as [EngineEventCallbacks][])[0][0];

  return {
    lifecycle,
    registry,
    stored,
    engines,
    hold,
    callbacksOf,
    settled,
  };
}

describe('disconnect report from the old engine during executeReconnect teardown', () => {
  afterEach(() => jest.useRealTimers());

  it('does not exhaust maxReconnectAttempts and abort the running reconnect attempt when the old engine emits onDisconnected during destroy', async () => {
    const f = fixture(1);
    await f.lifecycle.start(ID);
    const teardown = f.hold('destroy', 0);
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'Date'] });

    // Watchdog reports the stuck engine and schedules attempt 1 of 1.
    await f.lifecycle.handleEngineDisconnected(ID, f.registry.get(ID)!, WATCHDOG);
    await jest.advanceTimersByTimeAsync(3_000);
    await until(() => f.engines[0].destroy.mock.calls.length > 0, 'the old engine teardown to start');

    // While oldEngine.destroy() is closing the transport, oldEngine fires its own onDisconnected callback.
    f.callbacksOf(0).onDisconnected?.('Connection Closed');
    await f.settled();

    // Let oldEngine.destroy() finish so attempt 1 can create and initialize the replacement engine.
    teardown.resolve();
    await until(() => f.engines.length === 2 && f.engines[1].initialize.mock.calls.length > 0, 'engine 2 to start');
    expect(f.stored.status).not.toBe(SessionStatus.FAILED);
    expect(f.engines).toHaveLength(2);

    f.callbacksOf(1).onReady?.(BOUND, 'Bound');
    await until(() => f.stored.status === SessionStatus.READY, 'session to return to READY');
    expect(f.stored.status).toBe(SessionStatus.READY);
  });

  it('does not arm a parallel reconnect timer that tears down the replacement engine while it waits in QR_READY', async () => {
    const f = fixture(3);
    await f.lifecycle.start(ID);
    const teardown = f.hold('destroy', 0);
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'Date'] });

    // Attempt 1 is scheduled and enters executeReconnect teardown.
    await f.lifecycle.handleEngineDisconnected(ID, f.registry.get(ID)!, WATCHDOG);
    await jest.advanceTimersByTimeAsync(3_000);
    await until(() => f.engines[0].destroy.mock.calls.length > 0, 'the old engine teardown to start');

    // Old engine emits its close event during destroy().
    f.callbacksOf(0).onDisconnected?.('Connection Closed');
    await f.settled();

    // Teardown completes and replacement engine 1 initializes and reaches QR_READY.
    teardown.resolve();
    await until(() => f.engines.length === 2 && f.engines[1].initialize.mock.calls.length > 0, 'engine 2 to start');
    f.callbacksOf(1).onQRCode?.('qr-payload');
    await until(() => f.stored.status === SessionStatus.QR_READY, 'session to reach QR_READY');

    // Advancing past the reconnect backoff window must not tear down the healthy replacement engine waiting for QR scan.
    await jest.advanceTimersByTimeAsync(10_000);
    expect(f.engines).toHaveLength(2);
    expect(f.engines[1].destroy).not.toHaveBeenCalled();
    expect(f.stored.status).toBe(SessionStatus.QR_READY);
  });

  it('still schedules the next reconnect attempt when the replacement engine fails to initialize after oldEngine disconnected during teardown', async () => {
    const f = fixture(2);
    await f.lifecycle.start(ID);
    const teardown = f.hold('destroy', 0);
    const initAttempt1 = f.hold('initialize', 1);
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'Date'] });

    await f.lifecycle.handleEngineDisconnected(ID, f.registry.get(ID)!, WATCHDOG);
    await jest.advanceTimersByTimeAsync(3_000);
    await until(() => f.engines[0].destroy.mock.calls.length > 0, 'the old engine teardown to start');

    f.callbacksOf(0).onDisconnected?.('Connection Closed');
    await f.settled();

    teardown.resolve();
    await until(() => f.engines.length === 2 && f.engines[1].initialize.mock.calls.length > 0, 'engine 2 to start');

    // Attempt 1 takes 6s before failing in initializeEngine; no timer may fire during init, and attempt 2 of 2 must then be scheduled.
    await jest.advanceTimersByTimeAsync(6_000);
    expect(f.engines).toHaveLength(2);
    initAttempt1.reject(new Error('Navigation failed'));
    await jest.advanceTimersByTimeAsync(6_000);
    await until(() => f.engines.length === 3 && f.engines[2].initialize.mock.calls.length > 0, 'engine 3 to start');
    expect(f.stored.status).not.toBe(SessionStatus.FAILED);

    f.callbacksOf(2).onReady?.(BOUND, 'Bound');
    await until(() => f.stored.status === SessionStatus.READY, 'session to return to READY');
    expect(f.stored.status).toBe(SessionStatus.READY);
  });
});
