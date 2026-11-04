import { FindOperator } from 'typeorm';
import { SessionEngineLifecycle, type ReconnectState } from './session-engine-lifecycle.service';
import { SessionOwnershipService } from './session-ownership.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { Session, SessionStatus } from './entities/session.entity';
import { EngineStatus, type EngineEventCallbacks } from '../../engine/interfaces/whatsapp-engine.interface';

const ID = '22222222-2222-4222-8222-222222222222';
const ME = 'node-a';
const PEER = 'node-b';

/** What the row reads once the engine has initialized, which is what the post-init check sees. */
type AfterInit = 'peer-claimed' | 'own-lease-lapsed' | 'peer-stopped' | 'deleted';

/**
 * A start (or reconnect) whose post-init read finds the session retired meanwhile tears its own engine
 * down. Both shipped adapters report DISCONNECTED through onStateChanged from inside destroy()
 * (whatsapp-web.js via beginClientTeardown, Baileys via setStatus at the end of destroy), while the
 * engine is still registered. When a peer has claimed the row, that report must not land on it: the
 * peer's engine is the live one, and nothing on the peer rewrites a status it already holds. When the
 * row is still this node's, or has no owner, it must still end DISCONNECTED.
 */
function fixture(afterInit: AfterInit) {
  let initialized = false;
  let row: Session | null = {
    id: ID,
    name: 'retired-launch',
    phone: '628111',
    config: {},
    status: SessionStatus.DISCONNECTED,
    desiredState: null,
    nodeId: ME,
    leaseExpiresAt: new Date(Date.now() + 60_000),
  } as Session;
  const settle = (): void => {
    if (afterInit === 'deleted') row = null;
    else if (afterInit === 'peer-claimed')
      // The peer took the lapsed claim and its engine is already up.
      Object.assign(row!, { nodeId: PEER, leaseExpiresAt: new Date(Date.now() + 60_000), status: SessionStatus.READY });
    else if (afterInit === 'own-lease-lapsed')
      // A database stall longer than the TTL; nobody took the row.
      Object.assign(row!, { leaseExpiresAt: new Date(Date.now() - 1_000) });
    else
      // A peer's stop of the lapsed claim cleared it and recorded the stop.
      Object.assign(row!, { nodeId: null, leaseExpiresAt: null, desiredState: 'stopped' });
  };

  // A repository that honours the columns a where clause names, so a write the predicate keeps off the
  // row really changes nothing.
  const matches = (where: unknown): boolean => {
    if (!row) return false;
    if (typeof where === 'string') return where === row.id;
    if (Array.isArray(where)) return where.some(matches);
    return Object.entries(where as Record<string, unknown>).every(([column, expected]) => {
      const actual = (row as unknown as Record<string, unknown>)[column];
      if (expected instanceof FindOperator) return expected.type === 'isNull' ? actual == null : true;
      return actual === expected;
    });
  };
  let tearingDown = false;
  const teardownWrites: unknown[] = [];
  const repository = {
    findOne: jest.fn(() => Promise.resolve(row ? { ...row } : null)),
    exists: jest.fn().mockResolvedValue(true),
    update: jest.fn((where: unknown, patch: Partial<Session>) => {
      if (tearingDown) teardownWrites.push(patch);
      const hit = matches(where);
      if (hit) Object.assign(row!, patch);
      return Promise.resolve({ affected: hit ? 1 : 0 });
    }),
  };

  // The real ownership service, so "do we own it?" is answered by its own in-memory claim set.
  const claimQuery = {
    update: () => claimQuery,
    set: () => claimQuery,
    where: () => claimQuery,
    andWhere: () => claimQuery,
    execute: () => Promise.resolve({ affected: 1 }),
  };
  const ownershipRepository = {
    createQueryBuilder: () => claimQuery,
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    findOne: jest.fn(() => Promise.resolve(row ? { ...row } : null)),
  };
  const ownership = new SessionOwnershipService(
    ownershipRepository as never,
    {
      get: (key: string) => (key === 'session.nodeId' ? ME : undefined),
    } as never,
  );

  let callbacks: EngineEventCallbacks | undefined;
  // What both adapters do on entry to their teardown: report DISCONNECTED synchronously.
  const reportTeardown = (): Promise<void> => {
    tearingDown = true;
    callbacks?.onStateChanged?.(EngineStatus.DISCONNECTED);
    tearingDown = false;
    return Promise.resolve();
  };
  const engine = {
    initialize: jest.fn((cb: EngineEventCallbacks) => {
      callbacks = cb;
      initialized = true;
      settle();
      return Promise.resolve();
    }),
    getStatus: () => EngineStatus.INITIALIZING,
    destroy: jest.fn(reportTeardown),
    forceDestroy: jest.fn(reportTeardown),
    disconnect: jest.fn().mockResolvedValue(undefined),
  };
  const factory = { create: jest.fn(() => engine), purgeSessionData: jest.fn().mockResolvedValue(undefined) };
  const state = { attachTo: <T>(value: T): T => value, clear: jest.fn(), set: jest.fn(), get: jest.fn() };
  const emitSessionStatus = jest.fn();
  const registry = new EngineRegistry();
  const lifecycle = new SessionEngineLifecycle(
    repository as never,
    {} as never,
    factory as never,
    registry,
    { clear: jest.fn() } as never,
    {} as never,
    state as never,
    state as never,
    state as never,
    { emitSessionStatus } as never,
    { dispatch: jest.fn().mockResolvedValue(undefined) } as never,
    { execute: jest.fn().mockResolvedValue({ continue: true }) } as never,
    {} as never,
    undefined,
    undefined,
    undefined,
    ownership,
  );
  const announced = (status: SessionStatus): number =>
    emitSessionStatus.mock.calls.filter(([, emitted]) => emitted === status).length;
  const reconnect = (reconnectState: ReconnectState): Promise<void> =>
    (
      lifecycle as unknown as {
        executeReconnect(id: string, session: Session, state: ReconnectState): Promise<void>;
      }
    ).executeReconnect(ID, { ...row! }, reconnectState);
  const states = (): Map<string, ReconnectState> =>
    (lifecycle as unknown as { reconnectStates: Map<string, ReconnectState> }).reconnectStates;
  return {
    lifecycle,
    ownership,
    registry,
    engine,
    factory,
    repository,
    teardownWrites,
    announced,
    reconnect,
    states,
    row: () => row,
    initialized: () => initialized,
  };
}

const reconnectState = (): ReconnectState => ({ attempts: 1, timer: null, maxAttempts: 5, baseDelay: 5000 });

describe('a launch retired because a peer claimed its session', () => {
  it('start(): tears its own engine down without writing DISCONNECTED over the peer row', async () => {
    const f = fixture('peer-claimed');
    await expect(f.ownership.claim(ID)).resolves.toBe(true);

    await f.lifecycle.start(ID, { explicit: true });

    // The retirement happened: the engine this start built is gone.
    expect(f.engine.destroy).toHaveBeenCalled();
    expect(f.registry.has(ID)).toBe(false);
    // The row is the peer's; this node must not have written or announced a status for it after reading so.
    expect(f.teardownWrites).toEqual([]);
    expect(f.row()?.status).toBe(SessionStatus.READY);
    expect(f.announced(SessionStatus.DISCONNECTED)).toBe(0);
  });

  it('executeReconnect(): tears its own engine down without writing DISCONNECTED over the peer row', async () => {
    const f = fixture('peer-claimed');
    await expect(f.ownership.claim(ID)).resolves.toBe(true);
    const state = reconnectState();
    f.states().set(ID, state);

    await f.reconnect(state);

    expect(f.engine.destroy).toHaveBeenCalled();
    expect(f.registry.has(ID)).toBe(false);
    expect(f.teardownWrites).toEqual([]);
    expect(f.row()?.status).toBe(SessionStatus.READY);
    expect(f.announced(SessionStatus.DISCONNECTED)).toBe(0);
  });
});

describe('a launch retired on a row that is still this node or nobody', () => {
  // A launch retired on its OWN lapsed lease (nobody took the row) still settles the row to DISCONNECTED,
  // so it does not keep reading READY or INITIALIZING with no engine.
  it.each([
    ['start()', 'own-lease-lapsed'],
    ['executeReconnect()', 'own-lease-lapsed'],
    ['start()', 'peer-stopped'],
    ['executeReconnect()', 'peer-stopped'],
  ] as const)('%s settles the row to DISCONNECTED when it reads %s', async (path, afterInit) => {
    const f = fixture(afterInit);
    await expect(f.ownership.claim(ID)).resolves.toBe(true);

    if (path === 'start()') {
      await f.lifecycle.start(ID, { explicit: true });
    } else {
      const state = reconnectState();
      f.states().set(ID, state);
      await f.reconnect(state);
    }

    expect(f.engine.destroy).toHaveBeenCalled();
    expect(f.registry.has(ID)).toBe(false);
    expect(f.row()?.status).toBe(SessionStatus.DISCONNECTED);
    expect(f.announced(SessionStatus.DISCONNECTED)).toBe(1);
  });

  it('start(): announces no status for a session deleted while it initialized', async () => {
    const f = fixture('deleted');
    await expect(f.ownership.claim(ID)).resolves.toBe(true);

    await expect(f.lifecycle.start(ID, { explicit: true })).rejects.toThrow('not found');

    expect(f.engine.destroy).toHaveBeenCalled();
    expect(f.registry.has(ID)).toBe(false);
    expect(f.factory.purgeSessionData).toHaveBeenCalledWith(ID);
    expect(f.announced(SessionStatus.DISCONNECTED)).toBe(0);
  });

  // The engine is already gone when the status write runs, so a database that fails it must not turn the
  // retirement into a failed start: the start answers with the row it can read, as before.
  it('start(): still answers when the status write of the retirement fails', async () => {
    const f = fixture('own-lease-lapsed');
    const update = f.repository.update.getMockImplementation()!;
    f.repository.update.mockImplementation((where: unknown, patch: Partial<Session>) =>
      Array.isArray(where) ? Promise.reject(new Error('database unavailable')) : update(where, patch),
    );
    await expect(f.ownership.claim(ID)).resolves.toBe(true);

    await expect(f.lifecycle.start(ID, { explicit: true })).resolves.toMatchObject({ id: ID });

    expect(f.engine.destroy).toHaveBeenCalled();
    expect(f.registry.has(ID)).toBe(false);
    expect(f.announced(SessionStatus.DISCONNECTED)).toBe(0);
  });
});
