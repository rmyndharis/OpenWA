import { SessionEngineLifecycle } from './session-engine-lifecycle.service';
import type { PhoneWrites } from './session-phone-writes';
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

const tick = (): Promise<unknown> => new Promise(resolve => setImmediate(resolve));

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
    registry,
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

type Fixture = ReturnType<typeof fixture>;

/**
 * Updates whose patch matches wait for the case: `release()` answers them, `release(true)` fails the answer. They are
 * executed when released, or at once when `executeAtOnce` (the database has committed, the answer is what is late).
 */
function holdUpdates(f: Fixture, matches: (patch: Partial<Session>) => boolean, executeAtOnce = false) {
  const original = f.repository.update.getMockImplementation()!;
  const pending: Array<(fail: boolean) => void> = [];
  f.repository.update.mockImplementation((where: unknown, patch: Partial<Session>) => {
    if (!matches(patch)) return original(where, patch);
    const done = executeAtOnce ? original(where, patch) : undefined;
    return new Promise<{ affected: number }>((resolve, reject) => {
      pending.push(fail =>
        fail ? reject(new Error('synthetic database failure')) : resolve(done ?? original(where, patch)),
      );
    });
  });
  return {
    count: (): number => pending.length,
    release: async (fail = false): Promise<void> => {
      for (const answer of pending.splice(0)) answer(fail);
      await tick();
    },
  };
}

const clearsPhone = (patch: Partial<Session>): boolean => 'phone' in patch && patch.phone === null;
const writesPhone =
  (phone: string) =>
  (patch: Partial<Session>): boolean =>
    patch.phone === phone;

const disconnect = (f: Fixture, index: number): void => {
  f.engines[index].getStatus.mockReturnValue(EngineStatus.DISCONNECTED);
  f.callbacksOf(index).onStateChanged?.(EngineStatus.DISCONNECTED);
  f.callbacksOf(index).onDisconnected?.('Browser process closed or crashed');
};

const outcome = (f: Fixture, index: number) => ({
  logouts: f.engines[index].logout.mock.calls.length,
  status: f.stored.status,
  phone: f.stored.phone,
});

/** The first engine is bound to BOUND and READY. */
async function bound(f: Fixture): Promise<void> {
  await f.lifecycle.start(ID);
  f.engines[0].getStatus.mockReturnValue(EngineStatus.READY);
  f.engines[0].getPhoneNumber = jest.fn(() => BOUND);
  f.callbacksOf(0).onStateChanged?.(EngineStatus.READY);
  f.callbacksOf(0).onReady?.(BOUND, 'Bound');
  await tick();
}

/**
 * The watchdog has scheduled a reconnect of the bound session; the old engine then reports LOGOUT and its session read is
 * held (`oldRead`), while the replacement has finished initializing and shows its QR.
 */
async function replacement() {
  const f = fixture();
  await bound(f);
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'Date'] });
  await f.lifecycle.handleEngineDisconnected(ID, f.engines[0] as never, 'liveness probe failed (watchdog)');
  const oldRead = f.holdRead();
  f.callbacksOf(0).onCredentialTeardownStarted?.(Promise.resolve());
  f.engines[0].getStatus.mockReturnValue(EngineStatus.DISCONNECTED);
  f.callbacksOf(0).onStateChanged?.(EngineStatus.DISCONNECTED);
  f.callbacksOf(0).onDisconnected?.('LOGOUT');
  await jest.advanceTimersByTimeAsync(2_000);
  await until(() => Boolean(f.engines[1]?.initialize.mock.calls.length), 'the initialized replacement');
  f.engines[1].getStatus.mockReturnValue(EngineStatus.QR_READY);
  return { f, oldRead };
}

/** The next reconnect attempt runs and its engine reports `phone` as the account that scanned. */
async function scan(f: Fixture, phone: string): Promise<void> {
  await jest.advanceTimersByTimeAsync(10_000);
  await until(() => Boolean(f.engines[2]?.initialize.mock.calls.length), 'the next attempt');
  f.engines[2].getPhoneNumber = jest.fn(() => phone);
  f.callbacksOf(2).onStateChanged?.(EngineStatus.READY);
  f.callbacksOf(2).onReady?.(phone, 'Scanned');
  for (let i = 0; i < 20; i++) await tick();
}

const ACCEPTED = { logouts: 0, status: SessionStatus.READY };
const THIRD = '628999';

// A row read that acts on the phone starts once the phone writes the process issued have been answered, and is repeated when
// another is issued while it runs; whichever order the database executes the statements in, it returns what was written last.
describe('a disconnect read that overlaps the phone writes of an unlink', () => {
  afterEach(() => jest.useRealTimers());

  it('is repeated when the unlink was recorded while it ran', async () => {
    const { f, oldRead } = await replacement();
    try {
      // The replacement crashes; its row read saw the bound number but answers after the unlink was recorded.
      const stale = { ...f.stored };
      let answer!: (row: Session) => void;
      f.repository.findOne.mockImplementationOnce(() => new Promise<Session>(resolve => (answer = resolve)));
      disconnect(f, 1);
      oldRead.answer();
      await f.handled.mock.results[1].value;
      expect(f.recordedUnlinks()).toHaveLength(1);
      expect(f.stored.phone).toBeNull();
      answer(stale);
      await f.settled();

      await scan(f, OTHER);
      expect(outcome(f, 2)).toEqual({ ...ACCEPTED, phone: OTHER });
    } finally {
      await f.lifecycle.shutdown();
    }
  });

  it('waits for the clear of the unlink before it reads', async () => {
    const { f, oldRead } = await replacement();
    try {
      const clear = holdUpdates(f, clearsPhone);
      oldRead.answer();
      await f.handled.mock.results[1].value;
      expect(f.recordedUnlinks()).toHaveLength(1);
      expect(f.stored.phone).toBe(BOUND);

      const reads = f.repository.findOne.mock.calls.length;
      disconnect(f, 1);
      await tick();
      expect(f.repository.findOne.mock.calls.length).toBe(reads);
      await clear.release();
      await f.settled();
      expect(f.repository.findOne.mock.calls.length).toBeGreaterThan(reads);

      await scan(f, OTHER);
      expect(outcome(f, 2)).toEqual({ ...ACCEPTED, phone: OTHER });
    } finally {
      await f.lifecycle.shutdown();
    }
  });

  it('does not bring the old number back when the replacement reports READY without one', async () => {
    const { f, oldRead } = await replacement();
    try {
      const clear = holdUpdates(f, clearsPhone);
      oldRead.answer();
      await f.handled.mock.results[1].value;
      expect(f.recordedUnlinks()).toHaveLength(1);

      // A READY that carries no number links nobody: the row keeps what the clear leaves of it.
      f.engines[1].getStatus.mockReturnValue(EngineStatus.READY);
      f.engines[1].getPhoneNumber = jest.fn(() => '');
      f.callbacksOf(1).onStateChanged?.(EngineStatus.READY);
      f.callbacksOf(1).onReady?.('', '');
      await tick();
      disconnect(f, 1);
      await tick();
      await clear.release();
      await f.settled();

      await scan(f, OTHER);
      expect(outcome(f, 2)).toEqual({ ...ACCEPTED, phone: OTHER });
    } finally {
      await f.lifecycle.shutdown();
    }
  });

  it('still refuses another account when no unlink was recorded', async () => {
    const f = fixture();
    await bound(f);
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'Date'] });
    try {
      await f.lifecycle.handleEngineDisconnected(ID, f.engines[0] as never, 'liveness probe failed (watchdog)');
      await jest.advanceTimersByTimeAsync(2_000);
      await until(() => Boolean(f.engines[1]?.initialize.mock.calls.length), 'the initialized replacement');
      disconnect(f, 1);
      await f.settled();

      await scan(f, OTHER);
      expect(f.recordedUnlinks()).toHaveLength(0);
      expect({ logouts: outcome(f, 2).logouts, status: outcome(f, 2).status }).toEqual({
        logouts: 1,
        status: SessionStatus.FAILED,
      });
    } finally {
      await f.lifecycle.shutdown();
    }
  });
});

describe('a binding linked after the unlink', () => {
  afterEach(() => jest.useRealTimers());

  // The clear is committed and its answer is late, or fails: the row of the READY is written once the answer came, and
  // the read waits for both before it returns the number the READY wrote.
  it.each([false, true])('is kept when the answer of the clear is late (answer failed: %s)', async failAnswer => {
    const { f, oldRead } = await replacement();
    try {
      const clear = holdUpdates(f, clearsPhone, true);
      oldRead.answer();
      await f.handled.mock.results[1].value;
      expect(f.recordedUnlinks()).toHaveLength(1);
      f.engines[1].getStatus.mockReturnValue(EngineStatus.READY);
      await f.linkOther(1);
      expect(f.stored.phone).toBeNull(); // the clear has committed, the row of the READY waits for its answer

      disconnect(f, 1);
      await tick();
      await clear.release(failAnswer);
      await f.settled();
      expect(f.stored.phone).toBe(OTHER);

      // The next attempt holds the number the READY linked, so a third account is refused.
      await scan(f, THIRD);
      expect(outcome(f, 2)).toEqual({ logouts: 1, status: SessionStatus.FAILED, phone: OTHER });
    } finally {
      await f.lifecycle.shutdown();
    }
  });

  // Both writes go to the same row from two connections: the clear must not be able to land after the READY's row and take
  // the new number out of it again.
  it('writes the row of its READY after the clear of the unlink issued before it', async () => {
    const { f, oldRead } = await replacement();
    try {
      const order: string[] = [];
      const write = f.repository.update.getMockImplementation()!;
      f.repository.update.mockImplementation((where: unknown, patch: Partial<Session>) => {
        if (clearsPhone(patch)) order.push('clear');
        if (patch.phone === OTHER) order.push('ready');
        return write(where, patch);
      });
      const clear = holdUpdates(f, clearsPhone);
      oldRead.answer();
      await f.handled.mock.results[1].value;
      f.engines[1].getStatus.mockReturnValue(EngineStatus.READY);
      await f.linkOther(1);
      expect(order).toEqual([]); // the clear is still on its way to the database, and the READY's row waits for it
      expect(f.stored.phone).toBe(BOUND);

      await clear.release();
      await tick();
      expect(order).toEqual(['clear', 'ready']);
      expect(f.stored.phone).toBe(OTHER);
    } finally {
      await f.lifecycle.shutdown();
    }
  });

  it.each([
    ['the same account scans again', OTHER, { ...ACCEPTED, phone: OTHER }],
    ['a third account scans', THIRD, { logouts: 1, status: SessionStatus.FAILED, phone: OTHER }],
  ])('is kept while the row of its READY is still being written: %s', async (_name, scanned, expected) => {
    const { f, oldRead } = await replacement();
    try {
      const clear = holdUpdates(f, clearsPhone);
      const ready = holdUpdates(f, writesPhone(OTHER));
      oldRead.answer();
      await f.handled.mock.results[1].value;
      f.engines[1].getStatus.mockReturnValue(EngineStatus.READY);
      await f.linkOther(1);
      expect(f.engines[1].logout).not.toHaveBeenCalled();
      expect(ready.count()).toBe(0); // behind the clear

      disconnect(f, 1);
      await tick();
      await clear.release();
      expect(ready.count()).toBe(1);
      await ready.release();
      await f.settled();

      await scan(f, scanned);
      expect(outcome(f, 2)).toEqual(expected);
    } finally {
      await f.lifecycle.shutdown();
    }
  });
});

describe('a start that overlaps the phone writes of an unlink', () => {
  afterEach(() => jest.useRealTimers());

  /** The first engine is unlinked after it was stopped: the unlink is recorded with no engine registered. */
  async function stoppedAfterUnlink(f: Fixture) {
    await bound(f);
    const oldRead = f.holdRead();
    f.engines[0].getStatus.mockReturnValue(EngineStatus.DISCONNECTED);
    f.callbacksOf(0).onStateChanged?.(EngineStatus.DISCONNECTED);
    f.callbacksOf(0).onDisconnected?.('LOGOUT');
    await f.lifecycle.stop(ID);
    f.stored.desiredState = 'stopped';
    return oldRead;
  }

  it.each([false, true])(
    'reads its row once the clear has been answered (answered before it began: %s)',
    async early => {
      const f = fixture();
      const oldRead = await stoppedAfterUnlink(f);
      try {
        const clear = holdUpdates(f, clearsPhone);
        oldRead.answer();
        await f.settled();
        expect(f.recordedUnlinks()).toHaveLength(1);
        expect(f.stored.phone).toBe(BOUND);

        if (early) await clear.release();
        const restart = f.lifecycle.start(ID, { explicit: true });
        await tick();
        if (!early) {
          expect(f.engines).toHaveLength(1); // the start waits for the clear: no engine yet
          await clear.release();
        }
        await restart;
        await f.linkOther(1);

        expect(outcome(f, 1)).toEqual({ ...ACCEPTED, phone: OTHER });
      } finally {
        await f.lifecycle.shutdown();
      }
    },
  );

  it('reads the number a stopped READY engine linked once its row was written', async () => {
    const { f, oldRead } = await replacement();
    try {
      const clear = holdUpdates(f, clearsPhone);
      const ready = holdUpdates(f, writesPhone(OTHER));
      oldRead.answer();
      await f.handled.mock.results[1].value;
      f.engines[1].getStatus.mockReturnValue(EngineStatus.READY);
      await f.linkOther(1);
      await f.lifecycle.stop(ID);
      f.stored.desiredState = 'stopped';

      const restart = f.lifecycle.start(ID, { explicit: true });
      await tick();
      expect(f.engines).toHaveLength(2); // the start waits for both writes: no new engine yet
      await clear.release();
      await ready.release();
      await restart;
      expect(f.stored.phone).toBe(OTHER);

      // The new engine holds the number that was linked, so the same account is accepted and another is refused.
      f.engines[2].getPhoneNumber = jest.fn(() => THIRD);
      f.callbacksOf(2).onStateChanged?.(EngineStatus.READY);
      f.callbacksOf(2).onReady?.(THIRD, 'Third');
      for (let i = 0; i < 20; i++) await tick();
      expect(outcome(f, 2)).toEqual({ logouts: 1, status: SessionStatus.FAILED, phone: OTHER });
    } finally {
      await f.lifecycle.shutdown();
    }
  });
});

// The row a READY writes is split: its status and times go to the database at once, and only the number it links takes its
// place behind the clear of an earlier unlink. What a stop, a failure or a logout wrote after the READY therefore stands,
// whatever the late answer of that clear does to the wait.
describe('a READY that waits behind the clear of an unlink', () => {
  afterEach(() => jest.useRealTimers());

  it('writes its status and times at once and only the number behind the clear', async () => {
    const { f, oldRead } = await replacement();
    try {
      const clear = holdUpdates(f, clearsPhone, true);
      oldRead.answer();
      await f.handled.mock.results[1].value;
      f.engines[1].getStatus.mockReturnValue(EngineStatus.READY);
      const earlier = f.stored.connectedAt;
      await f.linkOther(1);

      expect(f.stored.status).toBe(SessionStatus.READY);
      expect(f.stored.connectedAt).not.toBe(earlier); // written by this READY, not left from the first one
      expect(f.stored.phone).toBeNull(); // the number waits for the answer of the clear
      await clear.release();
      await tick();
      expect(f.stored.phone).toBe(OTHER);
    } finally {
      await f.lifecycle.shutdown();
    }
  });

  it.each([
    ['a stop', SessionStatus.DISCONNECTED],
    ['a terminal failure', SessionStatus.FAILED],
  ])('leaves the status %s wrote after it, and keeps the number it linked', async (ending, expected) => {
    const { f, oldRead } = await replacement();
    try {
      const clear = holdUpdates(f, clearsPhone, true);
      oldRead.answer();
      await f.handled.mock.results[1].value;
      f.engines[1].getStatus.mockReturnValue(EngineStatus.READY);
      await f.linkOther(1);
      if (ending === 'a stop') {
        await f.lifecycle.stop(ID);
        f.stored.desiredState = 'stopped';
      } else {
        f.engines[1].getStatus.mockReturnValue(EngineStatus.FAILED);
        f.callbacksOf(1).onStateChanged?.(EngineStatus.FAILED);
        f.callbacksOf(1).onError?.('engine failed');
        for (let i = 0; i < 20; i++) await tick();
      }
      expect(f.stored.status).toBe(expected);
      expect(f.registry.has(ID)).toBe(false);

      await clear.release();
      for (let i = 0; i < 20; i++) await tick();
      expect({ status: f.stored.status, phone: f.stored.phone, engineLoaded: f.registry.has(ID) }).toEqual({
        status: expected,
        phone: OTHER,
        engineLoaded: false,
      });
    } finally {
      await f.lifecycle.shutdown();
    }
  });
});

describe('a logout that overlaps the phone writes of a session', () => {
  afterEach(() => jest.useRealTimers());

  // The clear a logout issues is one of the phone writes: it goes after the number a READY linked, which is still waiting
  // for the answer of an earlier clear, so that number cannot come back once the logout has finished.
  it('clears the number a READY linked after the clear of an earlier unlink', async () => {
    const { f, oldRead } = await replacement();
    let logout: Promise<Session> | undefined;
    let holdingUnlink = true;
    const clear = holdUpdates(f, patch => holdingUnlink && clearsPhone(patch), true);
    try {
      oldRead.answer();
      await f.handled.mock.results[1].value;
      f.engines[1].getStatus.mockReturnValue(EngineStatus.READY);
      await f.linkOther(1);

      holdingUnlink = false; // only the answer of the unlink's clear is late; the logout's own clear is answered at once
      logout = f.lifecycle.logout(ID);
      await until(() => !f.registry.has(ID), 'the engine retired by the logout');
      await clear.release();
      await logout;
      for (let i = 0; i < 20; i++) await tick();
      expect({ status: f.stored.status, phone: f.stored.phone }).toEqual({
        status: SessionStatus.DISCONNECTED,
        phone: null,
      });
    } finally {
      await clear.release();
      await Promise.allSettled([logout]);
      await f.lifecycle.shutdown();
    }
  });

  // A start sees the engine gone from the registry and reads the row in the next step: the clear has to be on record by then.
  it('has its clear on record by the time the engine is gone from the registry', async () => {
    const f = fixture();
    await bound(f);
    const writes = (f.lifecycle as unknown as { phoneWrites: PhoneWrites }).phoneWrites;
    const evict = f.registry.deleteIfLive.bind(f.registry);
    let pendingAfterEviction: boolean | undefined;
    jest.spyOn(f.registry, 'deleteIfLive').mockImplementation((...args) => {
      const evicted = evict(...args);
      queueMicrotask(() => (pendingAfterEviction ??= writes.hasPending(ID)));
      return evicted;
    });
    try {
      await f.lifecycle.logout(ID);
      expect(pendingAfterEviction).toBe(true);
    } finally {
      await f.lifecycle.shutdown();
    }
  });

  // A start that reads the row while the clear is still being written would take the number the logout is removing, and
  // refuse the next account as another one.
  it.each([false, true])(
    'is not outrun by a start that reads the row (clear answered before the start began: %s)',
    async early => {
      const f = fixture();
      await bound(f);
      const clear = holdUpdates(f, clearsPhone);
      let logout: Promise<Session> | undefined;
      let restart: Promise<Session> | undefined;
      try {
        logout = f.lifecycle.logout(ID);
        await until(() => clear.count() === 1, 'the phone clear of the logout');
        expect(f.registry.has(ID)).toBe(false);
        if (early) {
          await clear.release();
          await logout;
        }
        restart = f.lifecycle.start(ID, { explicit: true });
        await tick();
        if (!early) {
          expect(f.engines).toHaveLength(1); // the start waits for the clear: no engine yet
          await clear.release();
          await logout;
        }
        await restart;
        expect(f.stored.phone).toBeNull();
        await f.linkOther(1);

        expect(outcome(f, 1)).toEqual({ ...ACCEPTED, phone: OTHER });
      } finally {
        await clear.release();
        await Promise.allSettled([logout, restart]);
        await f.lifecycle.shutdown();
      }
    },
  );
});

// The read of a disconnect is checked against the writes issued meanwhile where it is made, and acted on a few ticks later. An
// unlink recorded in between (the report of a retired engine whose own read failed) clears the binding the row still shows.
describe('a disconnect read that is used after an unlink was recorded', () => {
  afterEach(() => jest.useRealTimers());

  it.each([false, true])(
    'does not bring the number back into the reconnect (results delivered together: %s)',
    async together => {
      const { f, oldRead } = await replacement();
      const ready = holdUpdates(f, writesPhone(BOUND), true);
      try {
        f.engines[1].getStatus.mockReturnValue(EngineStatus.READY);
        f.engines[1].getPhoneNumber = jest.fn(() => BOUND);
        f.callbacksOf(1).onStateChanged?.(EngineStatus.READY);
        f.callbacksOf(1).onReady?.(BOUND, 'Bound');
        await tick();
        let answer!: (row: Session) => void;
        f.repository.findOne.mockImplementationOnce(() => new Promise<Session>(resolve => (answer = resolve)));
        disconnect(f, 1);
        await ready.release();
        await until(() => answer !== undefined, 'the read after the answer of the READY row');
        const row = { ...f.stored };

        if (together) {
          // Both results reach their callers in the same turn: the unlink is recorded between the check of the read and
          // the continuation that arms the reconnect with its row.
          answer(row);
          oldRead.fail(new Error('the earlier session read failed'));
        } else {
          oldRead.fail(new Error('the earlier session read failed'));
          await f.handled.mock.results[1].value;
          answer(row);
        }
        await f.settled();
        expect(f.recordedUnlinks()).toHaveLength(1);

        await scan(f, OTHER);
        expect(outcome(f, 2)).toEqual({ ...ACCEPTED, phone: OTHER });
      } finally {
        await ready.release();
        await f.lifecycle.shutdown();
      }
    },
  );
});

// A READY accepted while a reconnect attempt is still initializing writes the binding; the attempt may then fail and be
// retried, and the retry has to start from that binding, as a start that reads the row does.
describe('an account linked while a reconnect initializes', () => {
  afterEach(() => jest.useRealTimers());

  it.each([
    [false, OTHER, 0, SessionStatus.READY],
    [false, THIRD, 1, SessionStatus.FAILED],
    [true, OTHER, 0, SessionStatus.READY],
    [true, THIRD, 1, SessionStatus.FAILED],
  ])(
    'keeps its binding when the initialization then fails (explicit start: %s; next number: %s)',
    async (explicit, phone, logouts, status) => {
      const f = fixture();
      f.stored.phone = null;
      await f.lifecycle.start(ID);
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'Date'] });
      const pending = f.holdInit();
      try {
        disconnect(f, 0);
        await f.settled();
        await jest.advanceTimersByTimeAsync(2_000);
        await until(() => Boolean(f.engines[1]?.initialize.mock.calls.length), 'the pending initialization');
        f.engines[1].getStatus.mockReturnValue(EngineStatus.READY);
        await f.linkOther(1);
        expect(f.stored.phone).toBe(OTHER);
        expect(f.engines[1].logout).not.toHaveBeenCalled();

        f.engines[1].getStatus.mockReturnValue(EngineStatus.FAILED);
        f.callbacksOf(1).onStateChanged?.(EngineStatus.FAILED);
        f.callbacksOf(1).onError?.('temporary connection failure');
        pending.reject(new Error('temporary connection failure'));
        await until(() => !f.registry.has(ID), 'the failed attempt eviction');
        for (let i = 0; i < 20; i++) await tick();
        expect(f.stored.phone).toBe(OTHER);
        if (explicit) await f.lifecycle.start(ID, { explicit: true });
        else await jest.advanceTimersByTimeAsync(10_000);
        await until(() => Boolean(f.engines[2]?.initialize.mock.calls.length), 'the next initialized engine');
        f.engines[2].getPhoneNumber = jest.fn(() => phone);
        f.engines[2].getStatus.mockReturnValue(EngineStatus.READY);
        f.callbacksOf(2).onStateChanged?.(EngineStatus.READY);
        f.callbacksOf(2).onReady?.(phone, 'Next');
        for (let i = 0; i < 20; i++) await tick();

        expect(outcome(f, 2)).toEqual({ logouts, status, phone: OTHER });
      } finally {
        await f.lifecycle.shutdown();
      }
    },
  );
});
