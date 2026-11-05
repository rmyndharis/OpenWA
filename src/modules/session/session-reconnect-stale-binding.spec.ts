import { SessionEngineLifecycle } from './session-engine-lifecycle.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { Session, SessionStatus } from './entities/session.entity';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { EngineStatus, type EngineEventCallbacks } from '../../engine/interfaces/whatsapp-engine.interface';

const ID = '77777777-7777-4777-8777-777777777777';
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
    name: 'reconnect-stale-binding',
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
  const recordedUnlinks = (): unknown[][] =>
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
    recordedUnlinks,
    holdRead,
    holdInit,
    linkOther,
  };
}

describe('a disconnect read that overlaps the unlink record of the engine it replaced', () => {
  afterEach(() => jest.useRealTimers());

  it('keeps the binding released when the read started before the unlink was recorded', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    f.engines[0].getStatus.mockReturnValue(EngineStatus.READY);
    f.engines[0].getPhoneNumber = jest.fn(() => BOUND);
    f.callbacksOf(0).onStateChanged?.(EngineStatus.READY);
    f.callbacksOf(0).onReady?.(BOUND, 'Bound');
    await new Promise(resolve => setImmediate(resolve));
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'Date'] });

    // The watchdog schedules the attempt without the adapter having reported a disconnect.
    await f.lifecycle.handleEngineDisconnected(ID, f.engines[0] as never, 'liveness probe failed (watchdog)');
    const oldRead = f.holdRead();
    f.callbacksOf(0).onCredentialTeardownStarted?.(Promise.resolve());
    f.engines[0].getStatus.mockReturnValue(EngineStatus.DISCONNECTED);
    f.callbacksOf(0).onStateChanged?.(EngineStatus.DISCONNECTED);
    f.callbacksOf(0).onDisconnected?.('LOGOUT');

    // The old engine's unlink read is still pending when it is retired and the replacement initializes.
    await jest.advanceTimersByTimeAsync(2_000);
    await until(() => Boolean(f.engines[1]?.initialize.mock.calls.length), 'the initialized replacement');
    const state = (
      f.lifecycle as unknown as {
        reconnectStates: Map<string, { session?: Session; initInFlight?: boolean }>;
      }
    ).reconnectStates.get(ID)!;
    expect(state.initInFlight).toBe(false);

    // The replacement then crashes. Its row read saw the bound number, but the reply arrives after the unlink record.
    const readSnapshot = { ...f.stored };
    let answerDrop!: (row: Session) => void;
    f.repository.findOne.mockImplementationOnce(() => new Promise<Session>(resolve => (answerDrop = resolve)));
    f.callbacksOf(1).onStateChanged?.(EngineStatus.DISCONNECTED);
    f.callbacksOf(1).onDisconnected?.('Browser process closed or crashed');
    oldRead.answer();
    await f.handled.mock.results[1].value;
    expect(f.recordedUnlinks()).toHaveLength(1);
    expect(f.stored.phone).toBeNull();
    expect(state.session?.phone).toBeNull();
    answerDrop(readSnapshot);
    await f.settled();

    await jest.advanceTimersByTimeAsync(10_000);
    await until(() => Boolean(f.engines[2]?.initialize.mock.calls.length), 'the next replacement');
    await f.linkOther(2);
    try {
      expect({
        logouts: f.engines[2].logout.mock.calls.length,
        status: f.stored.status,
        phone: f.stored.phone,
      }).toEqual({
        logouts: 0,
        status: SessionStatus.READY,
        phone: OTHER,
      });
    } finally {
      await f.lifecycle.shutdown();
    }
  });

  it('keeps the binding released when the read started before the phone clear committed', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    f.engines[0].getStatus.mockReturnValue(EngineStatus.READY);
    f.engines[0].getPhoneNumber = jest.fn(() => BOUND);
    f.callbacksOf(0).onStateChanged?.(EngineStatus.READY);
    f.callbacksOf(0).onReady?.(BOUND, 'Bound');
    await new Promise(resolve => setImmediate(resolve));
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'Date'] });
    await f.lifecycle.handleEngineDisconnected(ID, f.engines[0] as never, 'liveness probe failed (watchdog)');
    const oldRead = f.holdRead();
    f.callbacksOf(0).onCredentialTeardownStarted?.(Promise.resolve());
    f.engines[0].getStatus.mockReturnValue(EngineStatus.DISCONNECTED);
    f.callbacksOf(0).onStateChanged?.(EngineStatus.DISCONNECTED);
    f.callbacksOf(0).onDisconnected?.('LOGOUT');
    await jest.advanceTimersByTimeAsync(2_000);
    await until(() => Boolean(f.engines[1]?.initialize.mock.calls.length), 'the initialized replacement');

    const write = f.repository.update.getMockImplementation()!;
    let releaseClear!: () => void;
    f.repository.update.mockImplementation((where: unknown, patch: Partial<Session>) => {
      if ('phone' in patch && patch.phone === null) {
        return new Promise<{ affected: number }>(resolve => (releaseClear = () => resolve(write(where, patch))));
      }
      return write(where, patch);
    });
    oldRead.answer();
    await f.handled.mock.results[1].value;
    expect(f.recordedUnlinks()).toHaveLength(1);
    expect(f.stored.phone).toBe(BOUND);

    // This read starts after the unlink was recorded but before its database write committed.
    f.callbacksOf(1).onStateChanged?.(EngineStatus.DISCONNECTED);
    f.callbacksOf(1).onDisconnected?.('Browser process closed or crashed');
    await f.settled();
    releaseClear();
    await new Promise(resolve => setImmediate(resolve));
    expect(f.stored.phone).toBeNull();
    await jest.advanceTimersByTimeAsync(10_000);
    await until(() => Boolean(f.engines[2]?.initialize.mock.calls.length), 'the next replacement');
    await f.linkOther(2);
    try {
      expect({
        logouts: f.engines[2].logout.mock.calls.length,
        status: f.stored.status,
        phone: f.stored.phone,
      }).toEqual({
        logouts: 0,
        status: SessionStatus.READY,
        phone: OTHER,
      });
    } finally {
      await f.lifecycle.shutdown();
    }
  });

  it('still refuses another account when no unlink was recorded', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    f.engines[0].getStatus.mockReturnValue(EngineStatus.READY);
    f.engines[0].getPhoneNumber = jest.fn(() => BOUND);
    f.callbacksOf(0).onStateChanged?.(EngineStatus.READY);
    f.callbacksOf(0).onReady?.(BOUND, 'Bound');
    await new Promise(resolve => setImmediate(resolve));
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'Date'] });

    await f.lifecycle.handleEngineDisconnected(ID, f.engines[0] as never, 'liveness probe failed (watchdog)');
    await jest.advanceTimersByTimeAsync(2_000);
    await until(() => Boolean(f.engines[1]?.initialize.mock.calls.length), 'the initialized replacement');
    f.callbacksOf(1).onStateChanged?.(EngineStatus.DISCONNECTED);
    f.callbacksOf(1).onDisconnected?.('Browser process closed or crashed');
    await f.settled();
    await jest.advanceTimersByTimeAsync(10_000);
    await until(() => Boolean(f.engines[2]?.initialize.mock.calls.length), 'the next replacement');
    await f.linkOther(2);
    try {
      expect(f.recordedUnlinks()).toHaveLength(0);
      expect({ logouts: f.engines[2].logout.mock.calls.length, status: f.stored.status }).toEqual({
        logouts: 1,
        status: SessionStatus.FAILED,
      });
    } finally {
      await f.lifecycle.shutdown();
    }
  });
});

describe('a start issued while the phone clear of a recorded unlink is pending', () => {
  it.each([false, true])(
    'accepts the next number when the clear committed before the reads is %s',
    async clearBeforeReads => {
      const f = fixture();
      await f.lifecycle.start(ID);
      f.engines[0].getStatus.mockReturnValue(EngineStatus.READY);
      f.engines[0].getPhoneNumber = jest.fn(() => BOUND);
      f.callbacksOf(0).onStateChanged?.(EngineStatus.READY);
      f.callbacksOf(0).onReady?.(BOUND, 'Bound');
      await new Promise(resolve => setImmediate(resolve));
      const oldRead = f.holdRead();
      f.engines[0].getStatus.mockReturnValue(EngineStatus.DISCONNECTED);
      f.callbacksOf(0).onStateChanged?.(EngineStatus.DISCONNECTED);
      f.callbacksOf(0).onDisconnected?.('LOGOUT');
      await f.lifecycle.stop(ID);
      f.stored.desiredState = 'stopped';

      const write = f.repository.update.getMockImplementation()!;
      let releaseClear!: () => void;
      let releaseAdmission: (() => void) | undefined;
      let clearReleased = false;
      f.repository.update.mockImplementation((where: unknown, patch: Partial<Session>) => {
        if ('phone' in patch && patch.phone === null) {
          return new Promise<{ affected: number }>(resolve => {
            releaseClear = () => {
              clearReleased = true;
              resolve(write(where, patch));
            };
          });
        }
        if (!clearReleased && 'desiredState' in patch && patch.desiredState === null) {
          return new Promise<{ affected: number }>(resolve => (releaseAdmission = () => resolve(write(where, patch))));
        }
        return write(where, patch);
      });
      oldRead.answer();
      await f.settled();
      expect(f.recordedUnlinks()).toHaveLength(1);
      expect(f.stored.phone).toBe(BOUND);

      if (clearBeforeReads) {
        releaseClear();
        await new Promise(resolve => setImmediate(resolve));
      }
      const restart = f.lifecycle.start(ID, { explicit: true });
      if (!clearBeforeReads) {
        // Both reads of the start return the bound number. Its admission write waits for the clear to commit first.
        await until(() => releaseAdmission !== undefined, 'start admission after its reads');
        releaseClear();
        await new Promise(resolve => setImmediate(resolve));
        expect(f.stored.phone).toBeNull();
        releaseAdmission!();
      }
      await restart;
      await f.linkOther(1);
      const actual = { logouts: f.engines[1].logout.mock.calls.length, status: f.stored.status, phone: f.stored.phone };
      await f.lifecycle.shutdown();
      expect(actual).toEqual({ logouts: 0, status: SessionStatus.READY, phone: OTHER });
    },
  );
});
