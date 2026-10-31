import { SessionEngineLifecycle } from './session-engine-lifecycle.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { Session, SessionStatus } from './entities/session.entity';

const ID = '55555555-5555-4555-8555-555555555555';

/**
 * INV-2 at the control level: the INITIALIZING update issued before initialize() may COMMIT after a
 * retiring control has issued its own write (a PostgreSQL pool runs them on different connections).
 * Each retiring verb awaits that pending write first, so its own effect lands last. Here the
 * INITIALIZING effect is applied only when its reply arrives, inside the verb's wait bound.
 */
function fixture() {
  let row: Session | null = { id: ID, name: 'late-commit', phone: '628111', config: {} } as Session;
  const ops: string[] = [];
  let releaseInitial!: () => void;
  const initialReply = new Promise<void>(resolve => (releaseInitial = resolve));
  let firstInitial = true;
  const repository = {
    findOne: jest.fn(() => Promise.resolve(row ? { ...row } : null)),
    exists: jest.fn().mockResolvedValue(false),
    update: jest.fn((_id: string, patch: Partial<Session>) => {
      const apply = (): { affected: number } => {
        if (row) Object.assign(row, patch);
        if (patch.status) ops.push(String(patch.status));
        return { affected: row ? 1 : 0 };
      };
      if (patch.status === SessionStatus.INITIALIZING && firstInitial) {
        firstInitial = false;
        return initialReply.then(apply);
      }
      return Promise.resolve(apply());
    }),
  };
  const query = {
    select: jest.fn(),
    addSelect: jest.fn(),
    where: jest.fn(),
    andWhere: jest.fn(),
    orderBy: jest.fn(),
    addOrderBy: jest.fn(),
    limit: jest.fn(),
    getRawMany: jest.fn().mockResolvedValue([]),
  };
  for (const method of ['select', 'addSelect', 'where', 'andWhere', 'orderBy', 'addOrderBy', 'limit'] as const) {
    query[method].mockReturnValue(query);
  }
  const manager = {
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
    remove: jest.fn(() => {
      row = null;
      ops.push('removed');
      return Promise.resolve();
    }),
  };
  const dataSource = {
    options: { type: 'postgres' },
    getRepository: (target: unknown) => ({
      target,
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: () => query,
    }),
    transaction: jest.fn((run: (m: unknown) => Promise<unknown>) => run(manager)),
  };
  const engine = {
    initialize: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    destroy: jest.fn().mockResolvedValue(undefined),
    forceDestroy: jest.fn().mockResolvedValue(undefined),
    logout: jest.fn().mockResolvedValue(undefined),
  };
  const state = { attachTo: <T>(value: T): T => value, clear: jest.fn(), set: jest.fn(), get: jest.fn() };
  const lifecycle = new SessionEngineLifecycle(
    repository as never,
    dataSource as never,
    { create: jest.fn(() => engine), purgeSessionData: jest.fn().mockResolvedValue(undefined) } as never,
    new EngineRegistry(),
    {} as never,
    {} as never,
    state as never,
    state as never,
    state as never,
    { emitSessionStatus: jest.fn() } as never,
    { dispatch: jest.fn().mockResolvedValue(undefined) } as never,
    { execute: jest.fn().mockResolvedValue({ continue: true }) } as never,
    {} as never,
  );
  const init = (lifecycle as unknown as { initializeEngine(id: string, s: Session): Promise<void> })
    .initializeEngine(ID, { ...row })
    .catch(() => undefined);
  return { lifecycle, ops, releaseInitial, init, row: () => row };
}

describe('a retiring control while the INITIALIZING write commits late', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it.each(['stop', 'logout', 'forceKill', 'delete'] as const)('%s lands after the INITIALIZING commit', async verb => {
    const f = fixture();
    const control = f.lifecycle[verb](ID).catch(() => undefined);
    // Let the control run as far as it goes without the INITIALIZING reply.
    await jest.advanceTimersByTimeAsync(0);
    f.releaseInitial();
    await jest.advanceTimersByTimeAsync(0);
    await control;
    await f.init;

    if (verb === 'delete') {
      expect(f.ops).toEqual([SessionStatus.INITIALIZING, 'removed']);
    } else {
      expect(f.ops[0]).toBe(SessionStatus.INITIALIZING);
      expect(f.row()?.status).toBe(SessionStatus.DISCONNECTED);
    }
  });
});
