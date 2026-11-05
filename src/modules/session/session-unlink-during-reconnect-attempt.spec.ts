import { SessionEngineLifecycle } from './session-engine-lifecycle.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { Session, SessionStatus } from './entities/session.entity';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { EngineStatus, type EngineEventCallbacks } from '../../engine/interfaces/whatsapp-engine.interface';

const ID = '66666666-6666-4666-8666-666666666666';
const BOUND = '628444';
const OTHER = '628777';

/** Yields to the event loop until `condition` holds, failing after a real-time deadline. */
async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  await new Promise(resolve => setImmediate(resolve));
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(resolve => setImmediate(resolve));
  }
}

function fixture() {
  const stored = {
    id: ID,
    name: 'reconnect-stale-snapshot',
    phone: BOUND,
    config: { reconnectBaseDelay: 1000 },
    status: SessionStatus.READY,
    desiredState: null,
    nodeId: null,
  } as unknown as Session;
  const repository = {
    findOne: jest.fn(() => Promise.resolve({ ...stored })),
    exists: jest.fn(() => Promise.resolve(true)),
    update: jest.fn((_where: unknown, patch: Partial<Session>) => {
      Object.assign(stored, patch);
      return Promise.resolve({ affected: 1 });
    }),
  };
  const engines: Array<Record<string, jest.Mock>> = [];
  /** One entry per created engine: the promise its initialize() returns. */
  const initBehaviors: Array<Promise<void>> = [];
  const initGates: Array<{ reject: (error: Error) => void }> = [];
  const factory = {
    create: jest.fn(() => {
      const engine = {
        initialize: jest.fn(() => {
          const behavior = initBehaviors.shift();
          return behavior ?? Promise.resolve();
        }),
        destroy: jest.fn().mockResolvedValue(undefined),
        forceDestroy: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn().mockResolvedValue(undefined),
        logout: jest.fn().mockResolvedValue(undefined),
        getStatus: jest.fn(() => EngineStatus.DISCONNECTED),
      };
      engines.push(engine);
      return engine;
    }),
    purgeSessionData: jest.fn().mockResolvedValue(undefined),
  };
  /** The next created engine's initialize() returns a promise that settles only when the case rejects it. */
  const holdInit = (): { reject: (error: Error) => void } => {
    let reject!: (error: Error) => void;
    initBehaviors.push(new Promise<void>((_resolve, _reject) => (reject = _reject)));
    const gate = { reject };
    initGates.push(gate);
    return gate;
  };
  const audit = { logWarn: jest.fn().mockResolvedValue(undefined), logInfo: jest.fn().mockResolvedValue(undefined) };
  const webhooks = { dispatch: jest.fn().mockResolvedValue(undefined) };
  const hooks = { execute: jest.fn().mockResolvedValue({ continue: true }) };
  const registry = new EngineRegistry();
  const lifecycle = new SessionEngineLifecycle(
    repository as never,
    { options: { type: 'better-sqlite3' } } as never,
    factory as never,
    registry,
    { clear: jest.fn() } as never,
    {} as never,
    { attachTo: <T>(value: T): T => value, clear: jest.fn(), set: jest.fn(), get: jest.fn() } as never,
    { attachTo: <T>(value: T): T => value, clear: jest.fn(), clearIfDisprovedByReady: jest.fn() } as never,
    { clear: jest.fn(), getOwnIntent: jest.fn() } as never,
    {
      emitSessionStatus: jest.fn(),
      emitSessionDisconnected: jest.fn(),
      emitSessionAuthenticated: jest.fn(),
      emitQRCode: jest.fn(),
    } as never,
    webhooks as never,
    hooks as never,
    { clearSession: jest.fn() } as never,
    undefined,
    { isShuttingDown: () => false } as never,
    audit as never,
  );
  const handled = jest.spyOn(lifecycle, 'handleEngineDisconnected');
  const settled = async (): Promise<void> => {
    await Promise.all(handled.mock.results.map(result => result.value as Promise<void>));
  };
  const callbacksOf = (index: number): EngineEventCallbacks =>
    (engines[index].initialize.mock.calls as [EngineEventCallbacks][])[0][0];
  const unlinkAudits = (): unknown[][] =>
    (audit.logWarn.mock.calls as unknown[][]).filter(([action]) => action === AuditAction.SESSION_DISCONNECTED);
  /** The engine's next session read waits until the case answers or fails it. */
  const holdRead = (): { answer: () => void; fail: (error: Error) => void } => {
    let answer!: () => void;
    let fail!: (error: Error) => void;
    repository.findOne.mockImplementationOnce(
      () =>
        new Promise<Session>((resolve, reject) => {
          answer = () => resolve({ ...stored });
          fail = reject;
        }),
    );
    return { answer: () => answer(), fail: error => fail(error) };
  };
  /** The engine at that index links another number: READY, then the ready callback, as both adapters report them. */
  const linkOther = async (index: number): Promise<void> => {
    engines[index].getPhoneNumber = jest.fn(() => OTHER);
    callbacksOf(index).onStateChanged?.(EngineStatus.READY);
    callbacksOf(index).onReady?.(OTHER, 'Other');
    for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  };
  return {
    lifecycle,
    repository,
    stored,
    engines,
    handled,
    callbacksOf,
    settled,
    unlinkAudits,
    holdRead,
    holdInit,
    linkOther,
  };
}

describe('a terminal unlink recorded while a reconnect attempt is initializing', () => {
  afterEach(() => jest.useRealTimers());

  it('does not reschedule the next attempt with the stale binding', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'Date'] });

    // A transient drop arms the reconnect episode; its snapshot carries the bound phone.
    f.callbacksOf(0).onDisconnected?.('NAVIGATION');
    await f.settled();

    // The attempt tears the old engine down; hold its destroy so the old engine is still live here.
    let releaseDestroy!: () => void;
    f.engines[0].destroy.mockImplementationOnce(() => new Promise<void>(resolve => (releaseDestroy = () => resolve())));
    await jest.advanceTimersByTimeAsync(2_000);
    await until(() => f.engines[0].destroy.mock.calls.length === 1, 'the attempt to reach the teardown');

    // The unlink reports while the old engine is still live; its session read is held across the eviction.
    const read = f.holdRead();
    f.callbacksOf(0).onDisconnected?.('LOGOUT');

    // Let the teardown finish: the attempt evicts the old engine and registers its replacement, whose
    // initialize() is held, so the unlink's read answers while the replacement is initializing.
    const init = f.holdInit();
    releaseDestroy();
    await until(() => f.engines[1].initialize.mock.calls.length === 1, 'the replacement to start initializing');

    read.answer();
    await f.settled();
    expect(f.unlinkAudits()).toHaveLength(1);
    expect(f.stored.phone).toBeNull();

    // The attempt fails and reschedules from the episode snapshot.
    init.reject(new Error('browser launch failed'));
    await until(() => f.engines.length === 2, 'the failed engine to be reaped');
    await jest.advanceTimersByTimeAsync(10_000);
    await until(() => f.engines[2].initialize.mock.calls.length === 1, 'the next attempt to start');

    await f.linkOther(2);

    expect(f.engines[2].logout).not.toHaveBeenCalled();
    expect(f.stored.status).toBe(SessionStatus.READY);
    expect(f.stored.phone).toBe(OTHER);

    await f.lifecycle.shutdown();
  });
});
