import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { DataSource, EntityManager, QueryFailedError, Repository } from 'typeorm';
import { SessionService } from './session.service';
import { SessionEngineLifecycle } from './session-engine-lifecycle.service';
import { SessionErrorStore } from './session-error-store.service';
import { SessionOwnershipService } from './session-ownership.service';
import { SessionRestrictionStore } from './session-restriction-store.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { Session, SessionStatus } from './entities/session.entity';

const ID = '88888888-8888-4888-8888-888888888888';

/** A driver error that says the database did not answer: a retry can succeed. */
const dropped = (): QueryFailedError =>
  new QueryFailedError('SELECT 1', [], new Error('Connection terminated unexpectedly'));

/** A driver error for a statement the database rejected: a retry cannot succeed. */
const rejected = (): QueryFailedError => new QueryFailedError('SELECT 1', [], new Error('no such column: missing'));

/** Runs fn as a database call does: on a later turn, a throw becoming the rejection. */
const later = <T>(fn: () => T): Promise<T> => Promise.resolve().then(fn);

const anyFn = (): unknown =>
  new Proxy({}, { get: (_t, prop) => (prop === 'then' ? undefined : jest.fn().mockResolvedValue(undefined)) });

/**
 * The real SessionService, lifecycle and engine controls over an in-memory row. Every database call is counted, and
 * the one numbered failAt throws, so a case names the statement that failed and what had been done by then.
 */
function stack(
  failAt: number | null,
  { engine = true, error = dropped }: { engine?: boolean; error?: () => Error } = {},
) {
  const effects: string[] = [];
  let calls = 0;
  let failed: string | undefined;
  const hit = (name: string): void => {
    calls += 1;
    if (calls === failAt) {
      failed = name;
      throw error();
    }
  };
  const stored = {
    id: ID,
    name: 'read-failure',
    phone: '628111',
    config: {},
    status: engine ? SessionStatus.READY : SessionStatus.DISCONNECTED,
    desiredState: null,
    nodeId: null,
  } as unknown as Session;
  let rowPresent = true;
  const repository = {
    findOne: jest.fn(() =>
      later(() => {
        hit('repo.findOne');
        return rowPresent ? { ...stored } : null;
      }),
    ),
    update: jest.fn((_where: unknown, patch: Partial<Session>) =>
      later(() => {
        hit('repo.update ' + Object.keys(patch).join(','));
        if (!rowPresent) return { affected: 0 };
        Object.assign(stored, patch);
        return { affected: 1 };
      }),
    ),
    exists: jest.fn().mockResolvedValue(false),
    find: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
  };
  const query = (): Record<string, unknown> => {
    const q: Record<string, unknown> = {};
    for (const name of [
      'select',
      'addSelect',
      'where',
      'andWhere',
      'orderBy',
      'addOrderBy',
      'limit',
      'update',
      'set',
    ]) {
      q[name] = jest.fn(() => q);
    }
    q.getRawMany = jest.fn().mockResolvedValue([]);
    q.execute = jest.fn(() =>
      later(() => {
        hit('manager.query.update');
        return { affected: 1 };
      }),
    );
    return q;
  };
  const manager = {
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
    remove: jest.fn(() =>
      later(() => {
        effects.push('row removed');
        rowPresent = false;
        return stored;
      }),
    ),
    exists: jest.fn(() =>
      later(() => {
        hit('manager.exists');
        return rowPresent;
      }),
    ),
    createQueryBuilder: jest.fn(query),
    getRepository: jest.fn(() => repository),
  };
  const dataSource = {
    options: { type: 'postgres' },
    getRepository: jest.fn(() => ({
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(query),
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
      target: 'Message',
    })),
    transaction: jest.fn((cb: (m: unknown) => Promise<void>) => cb(manager)),
  };
  const live = {
    destroy: jest.fn(() => later(() => void effects.push('engine.destroy'))),
    forceDestroy: jest.fn(() => later(() => void effects.push('engine.forceDestroy'))),
    disconnect: jest.fn(() => later(() => void effects.push('engine.disconnect'))),
    getStatus: jest.fn(() => 'READY'),
  };
  const factory = { purgeSessionData: jest.fn(() => later(() => void effects.push('purgeSessionData'))) };
  const ownership = {
    nodeId: 'node-a',
    claim: jest.fn((_id: string, onClaimed?: (owns: () => boolean) => void) =>
      later(() => {
        hit('ownership.claim');
        onClaimed?.(() => true);
        return true;
      }),
    ),
    release: jest.fn(() => later(() => hit('ownership.release'))),
    isHeldByOtherNode: jest.fn(() =>
      later(() => {
        hit('ownership.isHeldByOtherNode');
        return false;
      }),
    ),
    stopExpiredForeignClaim: jest.fn().mockResolvedValue(false),
    claimableWhere: jest.fn(() => [{}]),
    captureClaim: jest.fn(() => () => true),
    forget: jest.fn(),
    heldByOtherLiveNode: jest.fn(() => false),
    owns: jest.fn(() => true),
  };
  const registry = new EngineRegistry();
  const hooks = {
    execute: jest.fn((name: string) =>
      later(() => {
        effects.push('hook ' + name);
        return { continue: true };
      }),
    ),
  };
  const errors = new SessionErrorStore();
  const restrictions = new SessionRestrictionStore();
  const lifecycle = new SessionEngineLifecycle(
    repository as never,
    dataSource as never,
    factory as never,
    registry,
    { clear: jest.fn(), start: jest.fn(), stop: jest.fn() } as never,
    {} as never,
    errors,
    restrictions,
    { clear: jest.fn(), getOwnIntent: jest.fn(), setOwnIntent: jest.fn() } as never,
    anyFn() as never,
    anyFn() as never,
    hooks as never,
    anyFn() as never,
    undefined,
    undefined,
    { logWarn: jest.fn().mockResolvedValue(undefined), logInfo: jest.fn().mockResolvedValue(undefined) } as never,
    ownership as never,
  );
  const service = new SessionService(
    repository as never,
    { find: jest.fn().mockResolvedValue([]) } as never,
    dataSource as never,
    registry,
    { start: jest.fn(), stop: jest.fn(), clear: jest.fn() } as never,
    errors,
    restrictions,
    {} as never,
    hooks as never,
    lifecycle,
    {} as never,
    { get: jest.fn(<T>(_k: string, d?: T) => d) } as never,
    ownership as never,
  );
  if (engine) registry.set(ID, live as never);
  const marks = (lifecycle as unknown as { stoppingSessions: { has(id: string): boolean } }).stoppingSessions;
  const requests = (service as unknown as { stopRequests: Map<string, unknown> }).stopRequests;
  return {
    service,
    effects,
    restrictions,
    errors,
    get failed() {
      return failed;
    },
    get rowPresent() {
      return rowPresent;
    },
    removeRow: () => (rowPresent = false),
    marked: () => marks.has(ID),
    requests,
  };
}

const outcome = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

describe('a stop or delete whose row read fails before it acts answers 503', () => {
  beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it.each([true, false])('stop() with an engine loaded: %s', async engine => {
    // The holder check, then the lifecycle's read of the row.
    const f = stack(2, { engine });

    const error = await outcome(f.service.stop(ID));

    expect(f.failed).toBe('repo.findOne');
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as Error).message).toContain('nothing was stopped');
    expect(f.effects).toEqual([]);
    expect(f.marked()).toBe(false);
    expect(f.requests.size).toBe(0);
  });

  it.each([true, false])('delete() with an engine loaded: %s', async engine => {
    // The holder check, the claim, the owner write and the two stop records, then the lifecycle's read of the row.
    const f = stack(6, { engine });

    const error = await outcome(f.service.delete(ID));

    expect(f.failed).toBe('repo.findOne');
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as Error).message).toContain('nothing was deleted');
    expect(f.effects).toEqual([]);
    expect(f.rowPresent).toBe(true);
    expect(f.marked()).toBe(false);
    expect(f.requests.size).toBe(0);
  });
});

describe('the answers beside that read keep their own status', () => {
  beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it.each(['stop', 'delete'] as const)('%s() of a session whose row is gone answers 404', async verb => {
    const f = stack(null);
    f.removeRow();

    await expect(f.service[verb](ID)).rejects.toBeInstanceOf(NotFoundException);
    expect(f.marked()).toBe(false);
  });

  it('stop() whose row read the database rejected keeps that error', async () => {
    const f = stack(2, { error: rejected });

    await expect(f.service.stop(ID)).rejects.toBeInstanceOf(QueryFailedError);
  });

  it('delete() whose row read the database rejected keeps that error', async () => {
    const f = stack(6, { error: rejected });

    await expect(f.service.delete(ID)).rejects.toBeInstanceOf(QueryFailedError);
  });

  it('stop() that fails once the engine is disconnected keeps the error as it came', async () => {
    // The holder check, the row read and the stop record, then the status write after the teardown.
    const f = stack(4);

    const error = await outcome(f.service.stop(ID));

    expect(f.failed).toBe('repo.update status');
    expect(f.effects).toEqual(['engine.disconnect']);
    expect(error).toBeInstanceOf(QueryFailedError);
  });

  it('delete() that fails once it began removing keeps the error as it came', async () => {
    // The first write of the removal, after the engine teardown and the session:deleted hook.
    const f = stack(7);

    const error = await outcome(f.service.delete(ID));

    expect(f.failed).toBe('manager.query.update');
    expect(f.effects).toEqual(['engine.forceDestroy', 'hook session:deleted']);
    expect(error).toBeInstanceOf(QueryFailedError);
  });
});

/**
 * The reads a stop's record and a delete's record make once their writes found the row taken: whether the row is still
 * there, and whether a live peer holds it. Over a real SQLite database and the real ownership service.
 */
describe('the reads behind the 404 and the 409 of a stop or delete record', () => {
  let dataSource: DataSource;
  let sessions: Repository<Session>;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session],
      synchronize: true,
    });
    await dataSource.initialize();
    sessions = dataSource.getRepository(Session);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  /** A row a live peer took over after this node's first check of it. */
  const peerRow = (name: string): Promise<Session> =>
    sessions.save(
      sessions.create({
        name,
        status: SessionStatus.READY,
        config: {},
        nodeId: 'node-b',
        claimedAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + 60_000),
      }),
    );

  const build = () => {
    const cfg = { get: (k: string) => ({ 'session.nodeId': 'node-a', 'session.leaseTtlMs': 60_000 })[k] } as never;
    const ownership = new SessionOwnershipService(sessions, cfg);
    // The lifecycle as the engine controls run it: read the row, then afterRead (stop); delete removes nothing here.
    const lifecycle = {
      markStopping: () => 1,
      clearStopping: jest.fn(),
      clearFinishedStops: () => undefined,
      settleStopping: () => undefined,
      isEngineActive: () => false,
      holdDelete: () => () => undefined,
      stop: async (id: string, hooks: { afterRead?: () => Promise<void> }) => {
        const found = await sessions.findOneByOrFail({ id });
        await hooks.afterRead?.();
        return found;
      },
      delete: jest.fn().mockResolvedValue(undefined),
    };
    const passThrough = { attachTo: (s: Session) => s };
    const service = new SessionService(
      sessions,
      {} as never,
      dataSource,
      { onRetire: () => undefined, get: () => undefined } as never,
      {} as never,
      passThrough as never,
      passThrough as never,
      {} as never,
      {} as never,
      lifecycle as never,
      {} as never,
      undefined,
      ownership,
      undefined,
    );
    const requests = (service as unknown as { stopRequests: Map<string, unknown> }).stopRequests;
    return { ownership, lifecycle, service, requests };
  };

  it('stop() answers 503 when the check of whether a peer holds the row fails, and leaves nothing behind', async () => {
    const row = await peerRow('stop-check-fails');
    const { ownership, lifecycle, service, requests } = build();
    // The first check saw no peer; the one the record makes after its writes missed fails.
    jest.spyOn(ownership, 'isHeldByOtherNode').mockResolvedValueOnce(false).mockRejectedValueOnce(dropped());

    const error = await outcome(service.stop(row.id));

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as Error).message).toContain('nothing was stopped');
    expect(lifecycle.clearStopping).toHaveBeenCalled();
    expect(requests.size).toBe(0);
    expect((await sessions.findOneByOrFail({ id: row.id })).desiredState).toBeNull();
  });

  it('stop() still answers 409 when that check finds the peer', async () => {
    const row = await peerRow('stop-check-peer');
    const { ownership, service } = build();
    jest.spyOn(ownership, 'isHeldByOtherNode').mockResolvedValueOnce(false);

    await expect(service.stop(row.id)).rejects.toBeInstanceOf(ConflictException);
  });

  it('delete() answers 503 when the read that tells its 404 from its 409 fails, and removes nothing', async () => {
    const row = await peerRow('delete-check-fails');
    const { ownership, lifecycle, service, requests } = build();
    // A peer took the row between this delete's claim and its record, so the owner write misses.
    jest.spyOn(ownership, 'isHeldByOtherNode').mockResolvedValueOnce(false);
    jest.spyOn(ownership, 'claim').mockImplementationOnce((_id, onClaimed) => {
      onClaimed?.(() => true);
      return Promise.resolve(true);
    });
    jest.spyOn(EntityManager.prototype, 'exists').mockRejectedValueOnce(dropped());

    const error = await outcome(service.delete(row.id));

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as Error).message).toContain('nothing was deleted');
    expect(lifecycle.delete).not.toHaveBeenCalled();
    expect(requests.size).toBe(0);
    const kept = await sessions.findOneByOrFail({ id: row.id });
    expect(kept.desiredState).toBeNull();
    expect(kept.nodeId).toBe('node-b');
  });

  it('delete() still answers 409 when that read finds the row', async () => {
    const row = await peerRow('delete-check-peer');
    const { ownership, service } = build();
    jest.spyOn(ownership, 'isHeldByOtherNode').mockResolvedValueOnce(false);
    jest.spyOn(ownership, 'claim').mockImplementationOnce((_id, onClaimed) => {
      onClaimed?.(() => true);
      return Promise.resolve(true);
    });

    await expect(service.delete(row.id)).rejects.toBeInstanceOf(ConflictException);
  });
});
