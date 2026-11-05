import { FindOperator } from 'typeorm';
import { SessionEngineLifecycle } from './session-engine-lifecycle.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { Session, SessionStatus } from './entities/session.entity';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { EngineStatus, type EngineEventCallbacks } from '../../engine/interfaces/whatsapp-engine.interface';

const ID = '55555555-5555-4555-8555-555555555555';
const BOUND = '628444';
const OTHER = '628777';

/** Yields to the event loop until `condition` holds, failing after a real-time deadline. */
async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(resolve => setImmediate(resolve));
  }
}

/** Whether a repository `where` (an id, an object or a list of objects, IsNull() included) matches the stored row. */
function matches(row: Record<string, unknown>, where: unknown): boolean {
  if (typeof where === 'string') return row.id === where;
  if (Array.isArray(where)) return where.some(each => matches(row, each));
  return Object.entries(where as Record<string, unknown>).every(([key, value]) =>
    value instanceof FindOperator ? value.type === 'isNull' && row[key] == null : row[key] === value,
  );
}

/**
 * A terminal unlink (WhatsApp removed this device) needs neither its session row nor a live engine: it is recorded
 * with the audit row, the phone clear that keeps the next start and boot from relaunching a dead binding, and the
 * session.disconnected announcement. The fixture drives the real lifecycle, wiring and registry; rejected or held
 * repository reads stand for a database failure or a slow PostgreSQL read.
 */
function fixture() {
  const stored = {
    id: ID,
    name: 'unlink-retired-engine',
    phone: BOUND,
    config: { reconnectBaseDelay: 1000 },
    status: SessionStatus.READY,
    desiredState: null,
    nodeId: null,
  } as unknown as Session;
  const write = (where: unknown, patch: Partial<Session>): Promise<{ affected: number }> => {
    if (!matches(stored as unknown as Record<string, unknown>, where)) return Promise.resolve({ affected: 0 });
    Object.assign(stored, patch);
    return Promise.resolve({ affected: 1 });
  };
  const repository = {
    findOne: jest.fn(() => Promise.resolve({ ...stored })),
    exists: jest.fn(() => Promise.resolve(true)),
    update: jest.fn(write),
  };
  const engines: Array<Record<string, jest.Mock>> = [];
  const factory = {
    create: jest.fn(() => {
      const engine = {
        initialize: jest.fn().mockResolvedValue(undefined),
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
  const errors = new Map<string, string>();
  const errorStore = {
    attachTo: <T>(value: T): T => value,
    clear: jest.fn((id: string) => errors.delete(id)),
    set: jest.fn((id: string, reason: string) => errors.set(id, reason)),
    get: jest.fn((id: string) => errors.get(id)),
  };
  const audit = { logWarn: jest.fn().mockResolvedValue(undefined), logInfo: jest.fn().mockResolvedValue(undefined) };
  const webhooks = { dispatch: jest.fn().mockResolvedValue(undefined) };
  const hooks = { execute: jest.fn().mockResolvedValue({ continue: true }) };
  let draining = false;
  const registry = new EngineRegistry();
  const lifecycle = new SessionEngineLifecycle(
    repository as never,
    { options: { type: 'better-sqlite3' } } as never,
    factory as never,
    registry,
    { clear: jest.fn() } as never,
    {} as never,
    errorStore as never,
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
    { isShuttingDown: () => draining } as never,
    audit as never,
  );
  const handled = jest.spyOn(lifecycle, 'handleEngineDisconnected');
  const settled = async (): Promise<void> => {
    await Promise.all(handled.mock.results.map(result => result.value as Promise<void>));
  };
  const internals = lifecycle as unknown as {
    ownership?: { owns: () => boolean; nodeId?: string };
    reconnectStates: Map<string, { timer: NodeJS.Timeout | null }>;
    controls: { retireLaunchedEngine: (id: string, engine: unknown) => Promise<void> };
  };
  const callbacksOf = (index: number): EngineEventCallbacks =>
    (engines[index].initialize.mock.calls as [EngineEventCallbacks][])[0][0];
  const unlinkAudits = (): unknown[][] =>
    (audit.logWarn.mock.calls as unknown[][]).filter(([action]) => action === AuditAction.SESSION_DISCONNECTED);
  const announced = (): string[] =>
    (webhooks.dispatch.mock.calls as [string, string, { reason: string }][])
      .filter(([, event]) => event === 'session.disconnected')
      .map(([, , payload]) => payload.reason);
  /** The engine's first session read waits until the case answers or fails it. */
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
  /** The first later repository write whose patch matches waits until the case releases it. */
  const holdWrite = (match: (patch: Partial<Session>) => boolean): { release: () => void; held: () => boolean } => {
    let release: (() => void) | undefined;
    repository.update.mockImplementation((where: unknown, patch: Partial<Session>) => {
      if (release || !match(patch)) return write(where, patch);
      return new Promise(resolve => (release = () => resolve(write(where, patch))));
    });
    return { release: () => release?.(), held: () => release !== undefined };
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
    unlinkAudits,
    announced,
    holdRead,
    holdWrite,
    hooks,
    retireLaunchedEngine: (engine: unknown) => internals.controls.retireLaunchedEngine(ID, engine),
    reconnectState: () => internals.reconnectStates.get(ID),
    drain: (): void => {
      draining = true;
    },
    /** A lease lost: this node no longer owns the session. */
    disown: (): void => {
      internals.ownership = { owns: () => false };
    },
    /** A peer claimed the row while this node's in-memory ownership has not caught up yet. */
    claimedByPeer: (): void => {
      internals.ownership = { owns: () => true, nodeId: 'node-a' };
      (stored as unknown as { nodeId: string }).nodeId = 'node-b';
    },
  };
}

/** The adapter's 401 handling up to the cleanup; returns the call that finishes the cleanup and reports the unlink. */
function loggedOut(callbacks: EngineEventCallbacks, reason = 'logged out'): () => Promise<void> {
  let finish!: () => void;
  const removed = new Promise<void>(resolve => (finish = resolve));
  callbacks.onStateChanged?.(EngineStatus.DISCONNECTED);
  const cleanup = (async (): Promise<void> => {
    await removed;
    callbacks.onDisconnected?.(reason);
  })();
  callbacks.onCredentialTeardownStarted?.(cleanup);
  return () => {
    finish();
    return cleanup;
  };
}

/** The engine at that index links another number: READY, then the ready callback, as both adapters report them. */
async function linkOther(f: ReturnType<typeof fixture>, index: number): Promise<void> {
  f.engines[index].getPhoneNumber = jest.fn(() => OTHER);
  f.callbacksOf(index).onStateChanged?.(EngineStatus.READY);
  f.callbacksOf(index).onReady?.(OTHER, 'Other');
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
}

describe('a terminal unlink whose first session read cannot be retried', () => {
  afterEach(() => jest.useRealTimers());

  it('is recorded when the read answers while the gateway is draining', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    f.drain();

    f.callbacksOf(0).onDisconnected?.('LOGOUT');
    await f.settled();

    expect(f.unlinkAudits()).toHaveLength(1);
    expect(f.stored.phone).toBeNull();
    expect(f.announced()).toEqual(['LOGOUT']);
  });

  it('is recorded when the read fails while the gateway is draining', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    f.drain();

    f.repository.findOne.mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));
    f.callbacksOf(0).onDisconnected?.('LOGOUT');
    await f.settled();

    expect(f.unlinkAudits()).toHaveLength(1);
    expect(f.stored.phone).toBeNull();
    expect(f.announced()).toEqual(['LOGOUT']);
  });

  it('records nothing for a drop that is not an unlink whose read fails while the gateway is draining', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    f.drain();

    f.repository.findOne.mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));
    f.callbacksOf(0).onDisconnected?.('NAVIGATION');
    await f.settled();

    expect(f.unlinkAudits()).toHaveLength(0);
    expect(f.stored.phone).toBe(BOUND);
    expect(f.announced()).toEqual([]);
  });

  it('audits without clearing the phone when the read fails while draining after the lease was lost', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    f.drain();
    f.disown();

    f.repository.findOne.mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));
    f.callbacksOf(0).onDisconnected?.('UNPAIRED');
    await f.settled();

    expect(f.unlinkAudits()).toHaveLength(1);
    expect(f.stored.phone).toBe(BOUND);
    expect(f.announced()).toEqual(['UNPAIRED']);
  });

  it('is recorded when shutdown runs while the read is in flight and the read then fails', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    const read = f.holdRead();

    f.callbacksOf(0).onDisconnected?.('logged out');
    await f.lifecycle.shutdown();
    read.fail(new Error('Connection terminated unexpectedly'));
    await f.settled();

    expect(f.unlinkAudits()).toHaveLength(1);
    expect(f.stored.phone).toBeNull();
    expect(f.announced()).toEqual(['logged out']);
  });

  it('is recorded when a stop retires the engine while the read is in flight and the read then answers', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    const read = f.holdRead();

    f.callbacksOf(0).onDisconnected?.('LOGOUT');
    await f.lifecycle.stop(ID);
    read.answer();
    await f.settled();

    expect(f.unlinkAudits()).toHaveLength(1);
    expect(f.stored.phone).toBeNull();
    expect(f.announced()).toEqual(['LOGOUT']);
    expect(f.reconnectState()).toBeUndefined();
  });

  it('is recorded when a stop retires the engine while the read is in flight and the read then fails', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    const read = f.holdRead();

    f.callbacksOf(0).onDisconnected?.('LOGOUT');
    await f.lifecycle.stop(ID);
    read.fail(new Error('SQLITE_BUSY: database is locked'));
    await f.settled();

    expect(f.unlinkAudits()).toHaveLength(1);
    expect(f.stored.phone).toBeNull();
    expect(f.announced()).toEqual(['LOGOUT']);
    expect(f.reconnectState()).toBeUndefined();
  });

  it('leaves the binding of a replacement that linked since alone', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    const read = f.holdRead();

    f.callbacksOf(0).onDisconnected?.('LOGOUT');
    await f.lifecycle.stop(ID);
    await f.lifecycle.start(ID);
    f.engines[1].getStatus.mockReturnValue(EngineStatus.READY);
    f.callbacksOf(1).onReady?.(BOUND, 'Bound');
    const log = jest.spyOn((f.lifecycle as unknown as { logger: { log: (...args: unknown[]) => void } }).logger, 'log');
    read.answer();
    await f.settled();

    expect(f.unlinkAudits()).toHaveLength(0);
    expect(f.stored.phone).toBe(BOUND);
    expect(f.announced()).toEqual([]);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('late unlink'),
      expect.objectContaining({ reason: 'LOGOUT', replacementStatus: EngineStatus.READY }),
    );
  });
});

describe('a terminal unlink carried by a read retry whose engine left', () => {
  afterEach(() => jest.useRealTimers());

  it('is recorded once when the retry re-reads during the drain and its read fails before shutdown', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'Date'] });

    f.repository.findOne.mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));
    f.callbacksOf(0).onDisconnected?.('LOGOUT');
    await f.settled();
    expect(f.unlinkAudits()).toHaveLength(0);

    f.drain();
    f.repository.findOne.mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));
    await jest.advanceTimersByTimeAsync(1_000);
    await f.settled();
    await f.lifecycle.shutdown();
    await f.settled();

    expect(f.unlinkAudits()).toHaveLength(1);
    expect(f.announced()).toEqual(['LOGOUT']);
    expect(f.stored.phone).toBeNull();
  });

  it('is recorded once when the engine leaves the registry before the retry fires', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    const engine = f.registry.get(ID)!;
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'Date'] });

    f.repository.findOne.mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));
    f.callbacksOf(0).onDisconnected?.('UNPAIRED_IDLE');
    await f.settled();

    f.registry.deleteIfLive(ID, engine);
    await jest.advanceTimersByTimeAsync(1_000);
    await f.settled();
    expect(f.unlinkAudits()).toHaveLength(1);

    await f.lifecycle.shutdown();
    expect(f.unlinkAudits()).toHaveLength(1);
    expect(f.announced()).toEqual(['UNPAIRED_IDLE']);
    expect(f.stored.phone).toBeNull();
  });

  it('is recorded once when the engine leaves the registry while the retry re-reads', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    const engine = f.registry.get(ID)!;
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'Date'] });

    f.repository.findOne.mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));
    f.callbacksOf(0).onDisconnected?.('LOGOUT');
    await f.settled();

    const read = f.holdRead();
    await jest.advanceTimersByTimeAsync(1_000);
    f.registry.deleteIfLive(ID, engine);
    read.answer();
    await f.settled();
    expect(f.unlinkAudits()).toHaveLength(1);

    await f.lifecycle.shutdown();
    expect(f.unlinkAudits()).toHaveLength(1);
    expect(f.announced()).toEqual(['LOGOUT']);
    expect(f.stored.phone).toBeNull();
  });
});

// The Baileys adapter reports a WhatsApp 401 as DISCONNECTED at once, and reports onDisconnected('logged out') only
// once it has removed the account's stored messages and its auth dir, a cleanup it registers as the credential
// teardown. The cases below follow that order.
describe('a Baileys unlink reported once its credential cleanup finished', () => {
  it('is recorded when nothing retires the engine during the cleanup', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    const finish = loggedOut(f.callbacksOf(0));

    await finish();
    await f.settled();

    expect(f.unlinkAudits()).toHaveLength(1);
    expect(f.stored.phone).toBeNull();
    expect(f.announced()).toEqual(['logged out']);
    // The live engine's unlink armed a reconnect.
    await f.lifecycle.shutdown();
  });

  it('leaves the phone of a row a peer claimed when the launch retired for the lost claim reports its unlink', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    const finish = loggedOut(f.callbacksOf(0));

    f.claimedByPeer();
    await f.retireLaunchedEngine(f.engines[0]);
    f.stored.phone = OTHER;
    await finish();

    expect(f.stored.phone).toBe(OTHER);
    expect(f.unlinkAudits()).toHaveLength(1);
    expect(f.announced()).toEqual(['logged out']);
  });

  it('is recorded when a stop lands during the cleanup', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    const finish = loggedOut(f.callbacksOf(0));

    await f.lifecycle.stop(ID);
    await finish();
    await f.settled();

    expect(f.unlinkAudits()).toHaveLength(1);
    expect(f.stored.phone).toBeNull();
    expect(f.announced()).toEqual(['logged out']);
    expect(f.handled).not.toHaveBeenCalled();
  });

  it('audits without clearing the phone when the lease was lost and the orphan teardown ran during the cleanup', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    const finish = loggedOut(f.callbacksOf(0));

    f.disown();
    await f.lifecycle.stopOrphanEngines([ID]);
    await finish();

    expect(f.unlinkAudits()).toHaveLength(1);
    expect(f.stored.phone).toBe(BOUND);
    expect(f.announced()).toEqual(['logged out']);
  });

  it('still drops a report that is not an unlink from a retired engine', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    const finish = loggedOut(f.callbacksOf(0), 'connection closed');

    await f.lifecycle.stop(ID);
    await finish();

    expect(f.unlinkAudits()).toHaveLength(0);
    expect(f.stored.phone).toBe(BOUND);
    expect(f.announced()).toEqual([]);
  });

  it('lets the start that waited on the cleanup link whichever number scans next', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    const finish = loggedOut(f.callbacksOf(0));

    await f.lifecycle.stop(ID);
    const reads = f.repository.findOne.mock.calls.length;
    const restart = f.lifecycle.start(ID);
    // The restart has read its row, still bound, and waits on the credential teardown.
    await until(() => f.repository.findOne.mock.calls.length > reads, 'the restart to read its row');
    await finish();
    await restart;

    f.callbacksOf(1).onReady?.(OTHER, 'Other');
    await f.settled();

    expect(f.engines[1].logout).not.toHaveBeenCalled();
    expect(f.stored.phone).toBe(OTHER);
  });
});

// A start that read the binding before a late unlink was recorded still launches, or already runs, with it. Once the
// unlink cleared it, the number that scans next is linked, wherever the start was when the record landed.
describe('a start that read the binding before a late unlink was recorded', () => {
  it('links another number when the unlink lands after the start launched its engine', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    const read = f.holdRead();
    f.callbacksOf(0).onDisconnected?.('LOGOUT');
    await f.lifecycle.stop(ID);
    await f.lifecycle.start(ID);

    read.answer();
    await f.settled();
    await linkOther(f, 1);

    expect(f.engines[1].logout).not.toHaveBeenCalled();
    expect(f.stored.phone).toBe(OTHER);
    expect(f.stored.status).toBe(SessionStatus.READY);
  });

  it('links another number when the unlink lands while the start waits in its starting hook', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    const read = f.holdRead();
    f.callbacksOf(0).onDisconnected?.('LOGOUT');
    await f.lifecycle.stop(ID);
    let releaseHook: (() => void) | undefined;
    f.hooks.execute.mockImplementationOnce(
      () => new Promise(resolve => (releaseHook = () => resolve({ continue: true }))),
    );
    const restart = f.lifecycle.start(ID);
    await until(() => releaseHook !== undefined, 'the restart to reach its starting hook');

    read.answer();
    await f.settled();
    releaseHook!();
    await restart;
    await linkOther(f, 1);

    expect(f.engines[1].logout).not.toHaveBeenCalled();
    expect(f.stored.phone).toBe(OTHER);
  });

  it('links another number when the unlink lands while the start writes its initializing status', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    const read = f.holdRead();
    f.callbacksOf(0).onDisconnected?.('LOGOUT');
    await f.lifecycle.stop(ID);
    const initializing = f.holdWrite(patch => patch.status === SessionStatus.INITIALIZING);
    const restart = f.lifecycle.start(ID);
    await until(() => initializing.held(), 'the restart to write its initializing status');

    read.answer();
    await f.settled();
    initializing.release();
    await restart;
    await linkOther(f, 1);

    expect(f.engines[1].logout).not.toHaveBeenCalled();
    expect(f.stored.phone).toBe(OTHER);
  });

  it('links another number when the phone clear is not written yet as the start that waited on the cleanup reads', async () => {
    const f = fixture();
    await f.lifecycle.start(ID);
    const finish = loggedOut(f.callbacksOf(0));
    await f.lifecycle.stop(ID);
    const clear = f.holdWrite(patch => 'phone' in patch && patch.phone === null);
    const reads = f.repository.findOne.mock.calls.length;
    const restart = f.lifecycle.start(ID);
    await until(() => f.repository.findOne.mock.calls.length > reads, 'the restart to read its row');

    await finish();
    // The restart reads its row again only once the clear has been answered, so it launches without the old number.
    await until(() => clear.held(), 'the clear of the recorded unlink');
    clear.release();
    await restart;
    await linkOther(f, 1);

    expect(f.engines[1].logout).not.toHaveBeenCalled();
    expect(f.stored.phone).toBe(OTHER);
  });
});
