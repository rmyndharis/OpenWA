import { SessionEngineLifecycle } from './session-engine-lifecycle.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { Session, SessionStatus } from './entities/session.entity';
import { AuditAction } from '../audit/entities/audit-log.entity';
import type { EngineEventCallbacks } from '../../engine/interfaces/whatsapp-engine.interface';

const ID = '66666666-6666-4666-8666-666666666666';
const BOUND = '628111';
const OTHER = '628999';
const WATCHDOG = 'liveness probe failed (watchdog)';

/** Yields to the event loop until `condition` holds, failing after a real-time deadline. */
async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(resolve => setImmediate(resolve));
  }
}

/** A step an engine fixture holds until the case settles it. */
type Gate = { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void };

/**
 * A disconnect whose session read fails is handled again once the row can be read: the retry sits on the
 * episode's reconnect timer. The fixture drives the real lifecycle and registry; the repository's rejected
 * reads are the database failure under test (SQLITE_BUSY, a PostgreSQL failover).
 */
function fixture() {
  const stored = {
    id: ID,
    name: 'disconnect-read-retry',
    phone: BOUND,
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
  const engines: Array<{ initialize: jest.Mock; destroy: jest.Mock }> = [];
  // A step of the engine created at that index that waits for the case to settle it: a wedged teardown, a slow init.
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
  const state = {
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
    state as never,
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
  // Every disconnect handling, the engine's, the watchdog's and a retry's, goes through this method.
  const handled = jest.spyOn(lifecycle, 'handleEngineDisconnected');
  const settled = async (): Promise<void> => {
    await Promise.all(handled.mock.results.map(result => result.value as Promise<void>));
  };
  const internals = lifecycle as unknown as {
    reconnectStates: Map<string, { timer: NodeJS.Timeout | null; initInFlight?: boolean; session?: Session }>;
    ownership?: { owns: () => boolean };
  };
  const reconnectState = () => internals.reconnectStates.get(ID);
  /** A lease lost: this node no longer owns the session (no ownership service means it owns them all). */
  const disown = (): void => {
    internals.ownership = { owns: () => false };
  };
  const unlinkAudits = (): unknown[][] =>
    (audit.logWarn.mock.calls as unknown[][]).filter(([action]) => action === AuditAction.SESSION_DISCONNECTED);
  const callbacksOf = (index: number): EngineEventCallbacks =>
    (engines[index].initialize.mock.calls as [EngineEventCallbacks][])[0][0];
  /** Fires the armed reconnect and waits until the engine it registers has finished initializing. */
  const runReconnect = async (count: number): Promise<void> => {
    await jest.advanceTimersByTimeAsync(3_000);
    await until(
      () => engines.length === count && engines[count - 1].initialize.mock.calls.length > 0,
      `engine ${count} to initialize`,
    );
    await until(() => !reconnectState()?.initInFlight, `reconnect ${count} to settle`);
  };
  /** The reasons session.disconnected went out with, in order; the socket event and the plugin hook must match. */
  const announced = (): string[] => {
    const webhook = (webhooks.dispatch.mock.calls as [string, string, { reason: string }][])
      .filter(([, event]) => event === 'session.disconnected')
      .map(([, , payload]) => payload.reason);
    const socket = (events.emitSessionDisconnected.mock.calls as [string, { reason: string }][]).map(
      ([, payload]) => payload.reason,
    );
    const hook = (hooks.execute.mock.calls as [string, { reason: string }][])
      .filter(([name]) => name === 'session:disconnected')
      .map(([, payload]) => payload.reason);
    expect(socket).toEqual(webhook);
    expect(hook).toEqual(webhook);
    return webhook;
  };
  return {
    lifecycle,
    registry,
    repository,
    stored,
    engines,
    audit,
    hold,
    announced,
    callbacksOf,
    settled,
    reconnectState,
    runReconnect,
    disown,
    unlinkAudits,
  };
}

/** The engine at that index links a number other than the one the session was bound to. */
async function linkOther(f: ReturnType<typeof fixture>, index = 1): Promise<void> {
  f.callbacksOf(index).onReady?.(OTHER, 'Other');
  await until(() => f.stored.phone === OTHER || f.stored.status === SessionStatus.FAILED, 'the link to settle');
}

/** Arms the watchdog reconnect and fires it, with the old engine's teardown held; returns that teardown. */
async function tearDownSlowly(f: ReturnType<typeof fixture>): Promise<Gate> {
  await f.lifecycle.start(ID);
  const teardown = f.hold('destroy', 0);
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'Date'] });
  await f.lifecycle.handleEngineDisconnected(ID, f.registry.get(ID)!, WATCHDOG);
  await jest.advanceTimersByTimeAsync(3_000);
  await until(() => f.engines[0].destroy.mock.calls.length > 0, 'the old engine teardown');
  return teardown;
}

/** Lets the teardown finish and waits for the engine the reconnect brings up. */
async function finishTeardown(f: ReturnType<typeof fixture>, teardown: Gate): Promise<void> {
  teardown.resolve();
  await until(() => f.engines.length === 2 && f.engines[1].initialize.mock.calls.length > 0, 'engine 2 to start');
  await until(() => !f.reconnectState()?.initInFlight, 'the reconnect to settle');
}

/** The numbers a link was refused under because the session was still bound to them. */
const refusedUnder = (f: ReturnType<typeof fixture>): string[] =>
  (f.audit.logWarn.mock.calls as [AuditAction, { metadata: { previousPhone: string } }][])
    .filter(([action]) => action === AuditAction.SESSION_REBIND_REJECTED)
    .map(([, entry]) => entry.metadata.previousPhone);

describe('a disconnect read retry armed for an engine already replaced', () => {
  afterEach(() => jest.useRealTimers());

  it.each([
    ['fails', true],
    ['answers', false],
  ])('leaves the next engine drop to be handled when the replaced engine read %s', async (_outcome, readFails) => {
    const f = fixture();
    await f.lifecycle.start(ID);
    const first = f.callbacksOf(0);
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'Date'] });

    // The watchdog arms a reconnect; the engine then reports a drop whose read is slow.
    await f.lifecycle.handleEngineDisconnected(ID, f.registry.get(ID)!, WATCHDOG);
    let answer!: (row: Session) => void;
    let fail!: (error: Error) => void;
    f.repository.findOne.mockImplementationOnce(
      () =>
        new Promise<Session>((resolve, reject) => {
          answer = resolve;
          fail = reject;
        }),
    );
    first.onDisconnected?.('NAVIGATION');

    // The reconnect fires and replaces the engine before that read settles.
    await f.runReconnect(2);
    if (readFails) fail(new Error('SQLITE_BUSY'));
    else answer({ ...f.stored });
    await f.settled();

    // The new engine drops, and its own read fails too.
    f.repository.findOne.mockRejectedValueOnce(new Error('SQLITE_BUSY'));
    f.callbacksOf(1).onDisconnected?.('NAVIGATION');
    await f.settled();
    expect(f.reconnectState()?.timer).not.toBeNull();

    // Its retry reads the row and arms the reconnect that replaces it.
    await jest.advanceTimersByTimeAsync(1_000);
    await f.settled();
    await f.runReconnect(3);
    expect(f.engines).toHaveLength(3);
  });
});

// The liveness watchdog reports an engine that still reads READY, so the engine's own unlink can follow it
// inside the same episode, while the timer the watchdog report armed is pending.
describe('a WhatsApp unlink whose session read fails while the episode timer is armed', () => {
  afterEach(() => jest.useRealTimers());

  it('is handled as an unlink once the row reads, when the report before it could not read the row either', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    const first = f.callbacksOf(0);
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'Date'] });

    f.repository.findOne.mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));
    f.repository.findOne.mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));
    await f.lifecycle.handleEngineDisconnected(ID, f.registry.get(ID)!, WATCHDOG);
    first.onDisconnected?.('LOGOUT');
    await f.settled();
    expect(f.unlinkAudits()).toHaveLength(0);

    // The database answers again: the pending retry handles the unlink and arms the reconnect.
    await jest.advanceTimersByTimeAsync(1_000);
    await f.settled();
    expect(f.unlinkAudits()).toEqual([
      [AuditAction.SESSION_DISCONNECTED, expect.objectContaining({ sessionId: ID, metadata: { reason: 'LOGOUT' } })],
    ]);
    expect(f.stored.phone).toBeNull();

    // The reconnect's engine links whichever number scans its QR, as after any unlink.
    await f.runReconnect(2);
    await linkOther(f);
    expect(f.stored.phone).toBe(OTHER);
    expect(f.stored.status).toBe(SessionStatus.READY);
  });

  it.each(['LOGOUT', 'logged out'])(
    'is recorded at once when a reconnect is armed and the read of a %s report fails',
    async reason => {
      const f = fixture();
      await f.lifecycle.start(ID);
      const first = f.callbacksOf(0);
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'Date'] });

      await f.lifecycle.handleEngineDisconnected(ID, f.registry.get(ID)!, WATCHDOG);
      f.repository.findOne.mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));
      first.onDisconnected?.(reason);
      await f.settled();

      expect(f.unlinkAudits()).toHaveLength(1);
      expect(f.stored.phone).toBeNull();
      expect(f.reconnectState()?.session?.phone).toBeNull();

      // The armed reconnect brings up one engine, which links whichever number scans its QR.
      await f.runReconnect(2);
      await linkOther(f);
      expect(f.stored.phone).toBe(OTHER);
      expect(f.stored.status).toBe(SessionStatus.READY);
      expect(f.engines).toHaveLength(2);
      expect(f.unlinkAudits()).toHaveLength(1);
    },
  );

  it.each([
    ['fails', true],
    ['answers', false],
  ])('is announced with its reason when a reconnect is armed and its read %s', async (_outcome, readFails) => {
    const f = fixture();
    await f.lifecycle.start(ID);
    const first = f.callbacksOf(0);
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'Date'] });

    await f.lifecycle.handleEngineDisconnected(ID, f.registry.get(ID)!, WATCHDOG);
    if (readFails) f.repository.findOne.mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));
    first.onDisconnected?.('LOGOUT');
    await f.settled();

    expect(f.unlinkAudits()).toHaveLength(1);
    expect(f.announced()).toEqual([WATCHDOG, 'LOGOUT']);
  });

  it('is audited once when it is reported again while its own read retry waits', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    const first = f.callbacksOf(0);
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'Date'] });

    f.repository.findOne.mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));
    f.repository.findOne.mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));
    first.onDisconnected?.('LOGOUT');
    await f.settled();
    first.onDisconnected?.('LOGOUT');
    await f.settled();
    await jest.advanceTimersByTimeAsync(1_000);
    await f.settled();
    await f.runReconnect(2);

    expect(f.unlinkAudits()).toHaveLength(1);
    expect(f.stored.phone).toBeNull();
    expect(f.engines).toHaveLength(2);
  });

  it('keeps the binding on the row and on the armed reconnect when this node no longer owns the session', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    const first = f.callbacksOf(0);
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'Date'] });

    await f.lifecycle.handleEngineDisconnected(ID, f.registry.get(ID)!, WATCHDOG);
    f.disown();
    f.repository.findOne.mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));
    first.onDisconnected?.('LOGOUT');
    await f.settled();

    // The audit row is not fenced, as on the path whose read answers; the phone clear is.
    expect(f.unlinkAudits()).toHaveLength(1);
    expect(f.repository.update).not.toHaveBeenCalledWith(ID, { phone: null });
    expect(f.stored.phone).toBe(BOUND);
    expect(f.reconnectState()?.session?.phone).toBe(BOUND);
  });

  it('is ignored when its engine was replaced before the read failed', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    const first = f.callbacksOf(0);
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'Date'] });

    await f.lifecycle.handleEngineDisconnected(ID, f.registry.get(ID)!, WATCHDOG);
    let fail!: (error: Error) => void;
    f.repository.findOne.mockImplementationOnce(() => new Promise<Session>((_resolve, reject) => (fail = reject)));
    first.onDisconnected?.('LOGOUT');

    // The reconnect replaces the engine, and the new one drops, which arms the next reconnect.
    await f.runReconnect(2);
    f.callbacksOf(1).onDisconnected?.('NAVIGATION');
    await until(() => f.reconnectState()?.timer != null, 'the next reconnect to be armed');

    fail(new Error('SQLITE_BUSY: database is locked'));
    await f.settled();
    expect(f.unlinkAudits()).toHaveLength(0);
    expect(f.stored.phone).toBe(BOUND);
    expect(f.reconnectState()?.session?.phone).toBe(BOUND);
  });

  it('leaves the binding alone for a drop whose read was retried', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'Date'] });

    f.repository.findOne.mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));
    await f.lifecycle.handleEngineDisconnected(ID, f.registry.get(ID)!, WATCHDOG);
    await jest.advanceTimersByTimeAsync(1_000);
    await f.settled();

    expect(f.unlinkAudits()).toHaveLength(0);
    expect(f.stored.phone).toBe(BOUND);
    expect(f.reconnectState()?.session?.phone).toBe(BOUND);
  });

  it('clears the armed reconnect binding even when the row write fails', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    const first = f.callbacksOf(0);
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'Date'] });
    const warn = jest.spyOn(
      (f.lifecycle as unknown as { logger: { warn: (message: string, meta?: unknown) => void } }).logger,
      'warn',
    );

    await f.lifecycle.handleEngineDisconnected(ID, f.registry.get(ID)!, WATCHDOG);
    f.repository.findOne.mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));
    f.repository.update.mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));
    first.onDisconnected?.('LOGOUT');
    await f.settled();
    await until(
      () => warn.mock.calls.some(([message]) => message === 'Failed to clear phone after a terminal unlink'),
      'the warning',
    );

    expect(f.stored.phone).toBe(BOUND);
    expect(f.reconnectState()?.session?.phone).toBeNull();
    await f.runReconnect(2);
    await linkOther(f);
    expect(f.stored.phone).toBe(OTHER);
    expect(f.stored.status).toBe(SessionStatus.READY);
  });

  it('leaves a drop whose read fails to the reconnect already armed', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    const first = f.callbacksOf(0);
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'Date'] });

    await f.lifecycle.handleEngineDisconnected(ID, f.registry.get(ID)!, WATCHDOG);
    const armed = f.reconnectState()?.timer;
    f.repository.findOne.mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));
    first.onDisconnected?.('NAVIGATION');
    await f.settled();

    expect(f.reconnectState()?.timer).toBe(armed);
    await f.runReconnect(2);
    expect(f.engines).toHaveLength(2);
    expect(f.unlinkAudits()).toHaveLength(0);
    expect(f.stored.phone).toBe(BOUND);
  });

  it('arms nothing for a read that fails after the session was stopped', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    const first = f.callbacksOf(0);
    let fail!: (error: Error) => void;
    f.repository.findOne.mockImplementationOnce(() => new Promise<Session>((_resolve, reject) => (fail = reject)));
    first.onDisconnected?.('LOGOUT');

    await f.lifecycle.stop(ID);
    fail(new Error('SQLITE_BUSY: database is locked'));
    await f.settled();

    expect(f.reconnectState()).toBeUndefined();
    expect(f.unlinkAudits()).toHaveLength(0);
    expect(f.stored.phone).toBe(BOUND);
  });
});

// The liveness watchdog arms a reconnect. It fires while the engine still reads READY, and a wedged Chromium keeps
// its teardown running; the engine is still the live one then, so its own report can arrive and fail to read.
describe('a disconnect whose session read fails while a running reconnect tears its engine down', () => {
  afterEach(() => jest.useRealTimers());

  /** The engine at that index drops, and its session read fails. */
  async function dropWithFailedRead(f: ReturnType<typeof fixture>, index: number, reason: string): Promise<void> {
    f.repository.findOne.mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));
    f.callbacksOf(index).onDisconnected?.(reason);
    await f.settled();
  }

  it.each(['LOGOUT', 'logged out'])(
    'records and announces a %s unlink once, and the next engine links whichever number scans its QR',
    async reason => {
      const f = fixture();
      const teardown = await tearDownSlowly(f);
      await dropWithFailedRead(f, 0, reason);
      await finishTeardown(f, teardown);

      expect(f.unlinkAudits()).toHaveLength(1);
      expect(f.stored.phone).toBeNull();
      expect(f.announced()).toEqual([WATCHDOG, reason]);

      // Nothing armed for the old engine runs later.
      await jest.advanceTimersByTimeAsync(3_000);
      await f.settled();
      await linkOther(f);
      expect(f.stored.phone).toBe(OTHER);
      expect(f.stored.status).toBe(SessionStatus.READY);
      expect(f.engines).toHaveLength(2);
      expect(f.unlinkAudits()).toHaveLength(1);
    },
  );

  it('reconnects the next engine when its own drop read fails too', async () => {
    const f = fixture();
    const teardown = await tearDownSlowly(f);
    await dropWithFailedRead(f, 0, 'NAVIGATION');
    await finishTeardown(f, teardown);

    await dropWithFailedRead(f, 1, 'NAVIGATION');
    await jest.advanceTimersByTimeAsync(1_000);
    await f.settled();
    await f.runReconnect(3);
    expect(f.engines).toHaveLength(3);
    expect(f.unlinkAudits()).toHaveLength(0);
  });

  it('reconnects the next engine whose drop read fails when the old engine reported nothing', async () => {
    const f = fixture();
    const teardown = await tearDownSlowly(f);
    await finishTeardown(f, teardown);

    await dropWithFailedRead(f, 1, 'NAVIGATION');
    await jest.advanceTimersByTimeAsync(1_000);
    await f.settled();
    await f.runReconnect(3);
    expect(f.engines).toHaveLength(3);
  });

  it('records the unlink once when its retry is still reading the row as the engine goes', async () => {
    const f = fixture();
    const teardown = await tearDownSlowly(f);
    await dropWithFailedRead(f, 0, 'LOGOUT');

    // The retry fires during the teardown and its read answers only once the engine is gone.
    let answer: ((row: Session) => void) | undefined;
    f.repository.findOne.mockImplementationOnce(() => new Promise<Session>(resolve => (answer = resolve)));
    await jest.advanceTimersByTimeAsync(1_000);
    await until(() => answer !== undefined, 'the retry to read the row');
    await finishTeardown(f, teardown);
    answer?.({ ...f.stored });
    await f.settled();

    expect(f.unlinkAudits()).toHaveLength(1);
    expect(f.announced()).toEqual([WATCHDOG, 'LOGOUT']);
    await linkOther(f);
    expect(f.stored.status).toBe(SessionStatus.READY);
  });

  it('records the unlink once when its retry fires during the teardown and fails to read again', async () => {
    const f = fixture();
    const teardown = await tearDownSlowly(f);
    f.repository.findOne.mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));
    await dropWithFailedRead(f, 0, 'LOGOUT');
    await jest.advanceTimersByTimeAsync(1_000);
    await f.settled();
    await finishTeardown(f, teardown);

    expect(f.unlinkAudits()).toHaveLength(1);
    expect(f.announced()).toEqual([WATCHDOG, 'LOGOUT']);
    await jest.advanceTimersByTimeAsync(3_000);
    await f.settled();
    await linkOther(f);
    expect(f.stored.status).toBe(SessionStatus.READY);
    expect(f.engines).toHaveLength(2);
    expect(f.unlinkAudits()).toHaveLength(1);
  });

  it('links whichever number scans the next QR when its retry reads the row before the teardown ends', async () => {
    const f = fixture();
    const teardown = await tearDownSlowly(f);
    await dropWithFailedRead(f, 0, 'LOGOUT');
    // A wedged teardown outlasts the retry delay: the retry fires and its read answers while the engine is live.
    await jest.advanceTimersByTimeAsync(1_000);
    await f.settled();
    expect(f.unlinkAudits()).toHaveLength(1);
    expect(f.stored.phone).toBeNull();
    expect(f.announced()).toEqual([WATCHDOG, 'LOGOUT']);

    await finishTeardown(f, teardown);
    await linkOther(f);
    expect({ status: f.stored.status, phone: f.stored.phone, refusedUnder: refusedUnder(f) }).toEqual({
      status: SessionStatus.READY,
      phone: OTHER,
      refusedUnder: [],
    });
  });

  it('lets the attempt that links the next engine record the unlink when two attempts share the teardown', async () => {
    const f = fixture();
    const teardown = await tearDownSlowly(f);
    // A drop whose read answers while the old engine is still the live one arms a second attempt, which fires
    // and waits on the same teardown.
    f.callbacksOf(0).onDisconnected?.('NAVIGATION');
    await f.settled();
    await jest.advanceTimersByTimeAsync(3_000);
    await until(() => f.engines[0].destroy.mock.calls.length > 1, 'the second attempt to tear the engine down');
    await dropWithFailedRead(f, 0, 'LOGOUT');
    await finishTeardown(f, teardown);

    expect(f.unlinkAudits()).toHaveLength(1);
    await linkOther(f);
    expect(f.stored.phone).toBe(OTHER);
    expect(f.stored.status).toBe(SessionStatus.READY);
    expect(f.engines).toHaveLength(2);
  });

  it('keeps the binding when this node no longer owns the session', async () => {
    const f = fixture();
    const teardown = await tearDownSlowly(f);
    f.disown();
    await dropWithFailedRead(f, 0, 'LOGOUT');
    teardown.resolve();
    await until(() => f.unlinkAudits().length > 0, 'the unlink to be recorded');
    await until(() => !f.reconnectState()?.initInFlight, 'the reconnect to settle');

    // The audit row is not fenced, as on the path whose read answers; the phone clear is.
    expect(f.unlinkAudits()).toHaveLength(1);
    expect(f.repository.update).not.toHaveBeenCalledWith(ID, { phone: null });
    expect(f.stored.phone).toBe(BOUND);
  });
});

// The same teardown, with the old engine's own report reading the row at once. The reconnect timer is spent while its
// attempt runs, so the report arms another attempt beside it; the running one still brings up the next engine.
describe('a disconnect whose session read answers while a running reconnect tears its engine down', () => {
  afterEach(() => jest.useRealTimers());

  it.each(['LOGOUT', 'logged out'])(
    'links whichever number scans the QR of the engine the running attempt brings up after a %s unlink',
    async reason => {
      const f = fixture();
      const teardown = await tearDownSlowly(f);
      f.callbacksOf(0).onDisconnected?.(reason);
      await f.settled();
      expect(f.unlinkAudits()).toHaveLength(1);
      expect(f.stored.phone).toBeNull();

      // The teardown ends before the other attempt's timer fires.
      await finishTeardown(f, teardown);
      await linkOther(f);
      expect({ status: f.stored.status, phone: f.stored.phone, refusedUnder: refusedUnder(f) }).toEqual({
        status: SessionStatus.READY,
        phone: OTHER,
        refusedUnder: [],
      });
      expect(f.announced()).toEqual([WATCHDOG, reason]);
    },
  );

  it('links whichever number scans the QR when the other attempt fires during the teardown', async () => {
    const f = fixture();
    const teardown = await tearDownSlowly(f);
    f.callbacksOf(0).onDisconnected?.('LOGOUT');
    await f.settled();
    await jest.advanceTimersByTimeAsync(5_000);
    await until(() => f.engines[0].destroy.mock.calls.length > 1, 'the other attempt to tear the engine down');
    await finishTeardown(f, teardown);
    await linkOther(f);
    expect(f.stored.status).toBe(SessionStatus.READY);
    expect(f.stored.phone).toBe(OTHER);
    expect(f.engines).toHaveLength(2);
  });

  it('keeps the binding for a drop that is not an unlink', async () => {
    const f = fixture();
    const teardown = await tearDownSlowly(f);
    f.callbacksOf(0).onDisconnected?.('NAVIGATION');
    await f.settled();
    await finishTeardown(f, teardown);
    await linkOther(f);
    expect({ status: f.stored.status, phone: f.stored.phone, refusedUnder: refusedUnder(f) }).toEqual({
      status: SessionStatus.FAILED,
      phone: BOUND,
      refusedUnder: [BOUND],
    });
  });
});

// The watchdog report reads the row slowly. The engine's own unlink report fails its read first and arms the read
// retry, and then the watchdog report's read answers.
describe('an unlink whose read retry an earlier report ends when its own read answers', () => {
  afterEach(() => jest.useRealTimers());

  it('is handled as that disconnect, announced once with the unlink reason', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    const first = f.callbacksOf(0);
    const engine = f.registry.get(ID)!;
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'Date'] });

    let answer!: (row: Session) => void;
    f.repository.findOne.mockImplementationOnce(() => new Promise<Session>(resolve => (answer = resolve)));
    const watchdog = f.lifecycle.handleEngineDisconnected(ID, engine, WATCHDOG);
    f.repository.findOne.mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));
    first.onDisconnected?.('LOGOUT');
    await until(() => f.reconnectState()?.timer != null, 'the read retry');

    answer({ ...f.stored });
    await watchdog;
    await f.settled();
    expect(f.unlinkAudits()).toHaveLength(1);
    expect(f.stored.phone).toBeNull();
    expect(f.announced()).toEqual(['LOGOUT']);

    await f.runReconnect(2);
    await linkOther(f);
    expect(f.stored.status).toBe(SessionStatus.READY);
    expect(f.engines).toHaveLength(2);
  });

  it('is recorded once when its retry already reads the row again as that report answers', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    const first = f.callbacksOf(0);
    const engine = f.registry.get(ID)!;
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'Date'] });

    const answers: Array<(row: Session) => void> = [];
    const slowRead = (): Promise<Session> => new Promise<Session>(resolve => answers.push(resolve));
    f.repository.findOne.mockImplementationOnce(slowRead);
    const watchdog = f.lifecycle.handleEngineDisconnected(ID, engine, WATCHDOG);
    f.repository.findOne.mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));
    first.onDisconnected?.('LOGOUT');
    await until(() => f.reconnectState()?.timer != null, 'the read retry');

    // The retry fires and reads the row slowly too, and the watchdog report's read answers first.
    f.repository.findOne.mockImplementationOnce(slowRead);
    await jest.advanceTimersByTimeAsync(1_000);
    await until(() => answers.length === 2, 'the retry to read the row');
    answers[0]({ ...f.stored });
    await watchdog;
    answers[1]({ ...f.stored });
    await f.settled();

    expect(f.unlinkAudits()).toHaveLength(1);
    expect(f.announced()).toEqual([WATCHDOG, 'LOGOUT']);
    expect(f.stored.phone).toBeNull();
  });
});

describe('an unlink whose read fails while the reconnect engine initializes', () => {
  afterEach(() => jest.useRealTimers());

  it('is recorded and announced when that init fails, and the next engine links whichever number scans its QR', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    const init = f.hold('initialize', 1);
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'Date'] });
    await f.lifecycle.handleEngineDisconnected(ID, f.registry.get(ID)!, WATCHDOG);
    await jest.advanceTimersByTimeAsync(3_000);
    await until(() => f.engines.length === 2 && f.engines[1].initialize.mock.calls.length > 0, 'engine 2 to start');

    f.repository.findOne.mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));
    f.callbacksOf(1).onDisconnected?.('LOGOUT');
    await f.settled();
    init.reject(new Error('Navigation failed'));
    await until(() => !f.reconnectState()?.initInFlight && f.reconnectState()?.timer != null, 'the next attempt');

    expect(f.unlinkAudits()).toHaveLength(1);
    expect(f.stored.phone).toBeNull();
    expect(f.announced()).toEqual([WATCHDOG, 'LOGOUT']);
    await f.runReconnect(3);
    await linkOther(f, 2);
    expect(f.stored.phone).toBe(OTHER);
    expect(f.stored.status).toBe(SessionStatus.READY);
  });
});
