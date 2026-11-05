import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource, QueryFailedError } from 'typeorm';
import { SessionController } from './session.controller';
import { SessionService } from './session.service';
import { ServerShuttingDownException, SessionEngineControls, StopMarks } from './session-engine-controls';
import { SessionEngineLifecycle } from './session-engine-lifecycle.service';
import { SessionErrorStore } from './session-error-store.service';
import { SessionRestrictionStore } from './session-restriction-store.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { Session, SessionStatus } from './entities/session.entity';
import { AuditService } from '../audit/audit.service';
import { ChatScopeService } from '../auth/chat-scope.service';

const ID = '77777777-7777-4777-8777-777777777777';

/** A driver error that says the database did not answer: nothing was read, written or launched. */
const dropped = (): QueryFailedError =>
  new QueryFailedError('SELECT 1', [], new Error('Connection terminated unexpectedly'));

/** A driver error for a statement the database rejected: a retry cannot succeed. */
const rejected = (): QueryFailedError => new QueryFailedError('SELECT 1', [], new Error('no such column: missing'));

function fixture({ maxConcurrent = 0, id = ID }: { maxConcurrent?: number; id?: string } = {}) {
  const row = {
    id,
    name: 'ownership-read-failure',
    phone: '628333',
    config: {},
    status: SessionStatus.DISCONNECTED,
    desiredState: null,
    nodeId: null,
  } as unknown as Session;
  const repository = {
    findOne: jest.fn().mockResolvedValue({ ...row }),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  // The marks are the lifecycle's own: each operation of a session sets one of its own, and a later one is kept beside it.
  const marks = new StopMarks();
  const lifecycle = {
    start: jest.fn().mockResolvedValue({ ...row }),
    stop: jest.fn().mockResolvedValue({ ...row }),
    delete: jest.fn().mockResolvedValue(undefined),
    // Another session holds the only slot when the cap is 1.
    startSlotHolders: jest.fn(() => new Set(['another-session'])),
    isEngineActive: jest.fn(() => false),
    markStopping: jest.fn((markedId: string) => marks.hold(markedId)),
    settleStopping: jest.fn((markedId: string, stamp?: number) => {
      if (stamp !== undefined) marks.settle(markedId, stamp);
    }),
    clearFinishedStops: jest.fn((markedId: string) => marks.dropFinished(markedId)),
    clearStopping: jest.fn((markedId: string, stamp?: number) => {
      if (stamp === undefined) marks.delete(markedId);
      else marks.deleteStamped(markedId, stamp);
    }),
    holdDelete: jest.fn(() => () => undefined),
    announceStatus: jest.fn(),
  };
  const ownership = {
    nodeId: 'node-a',
    claim: jest.fn().mockResolvedValue(true),
    release: jest.fn().mockResolvedValue(undefined),
    isHeldByOtherNode: jest.fn().mockResolvedValue(false),
    stopExpiredForeignClaim: jest.fn().mockResolvedValue(false),
    claimableWhere: jest.fn(() => [{}]),
    captureClaim: jest.fn(() => () => true),
  };
  const configService = {
    get: jest.fn(<T>(key: string, fallback?: T) => (key === 'sessions.maxConcurrent' ? maxConcurrent : fallback)),
  };
  const service = new SessionService(
    repository as never,
    {} as never,
    {} as never,
    new EngineRegistry(),
    { start: jest.fn(), stop: jest.fn(), clear: jest.fn() } as never,
    new SessionErrorStore(),
    new SessionRestrictionStore(),
    {} as never,
    { execute: jest.fn().mockResolvedValue({ continue: true }) } as never,
    lifecycle as never,
    {} as never,
    configService as never,
    ownership as never,
  );
  return { service, repository, lifecycle, ownership, marks };
}

describe('a lifecycle route whose ownership bookkeeping cannot reach the database launches nothing and answers 503', () => {
  it('start() whose claim write fails answers 503', async () => {
    const f = fixture();
    f.ownership.claim.mockRejectedValueOnce(dropped());

    await expect(f.service.start(ID, { explicit: true })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(f.lifecycle.start).not.toHaveBeenCalled();
  });

  it('start() whose claim matched no row and whose row read then fails answers 503', async () => {
    const f = fixture();
    f.ownership.claim.mockResolvedValueOnce(false);
    f.repository.findOne.mockRejectedValueOnce(dropped());

    await expect(f.service.start(ID, { explicit: true })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(f.lifecycle.start).not.toHaveBeenCalled();
  });

  it('start() at MAX_CONCURRENT_SESSIONS whose row read fails answers 503', async () => {
    const f = fixture({ maxConcurrent: 1 });
    f.repository.findOne.mockRejectedValueOnce(dropped());

    await expect(f.service.start(ID, { explicit: true })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(f.ownership.claim).not.toHaveBeenCalled();
  });

  it('start() at MAX_CONCURRENT_SESSIONS whose ownership read fails answers 503', async () => {
    const f = fixture({ maxConcurrent: 1 });
    f.ownership.isHeldByOtherNode.mockRejectedValueOnce(dropped());

    await expect(f.service.start(ID, { explicit: true })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(f.ownership.claim).not.toHaveBeenCalled();
  });

  it('stop() whose ownership read fails answers 503', async () => {
    const f = fixture();
    f.ownership.isHeldByOtherNode.mockRejectedValueOnce(dropped());

    await expect(f.service.stop(ID)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(f.lifecycle.stop).not.toHaveBeenCalled();
  });

  it('delete() whose ownership read fails answers 503', async () => {
    const f = fixture();
    f.ownership.isHeldByOtherNode.mockRejectedValueOnce(dropped());

    await expect(f.service.delete(ID)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(f.lifecycle.delete).not.toHaveBeenCalled();
  });

  it('delete() whose claim matched no row and whose row read then fails answers 503', async () => {
    const f = fixture();
    f.ownership.claim.mockResolvedValueOnce(false);
    f.repository.findOne.mockRejectedValueOnce(dropped());

    await expect(f.service.delete(ID)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(f.lifecycle.delete).not.toHaveBeenCalled();
  });

  it('findOneForDelete() whose row read fails answers 503', async () => {
    const f = fixture();
    f.repository.findOne.mockRejectedValueOnce(dropped());

    await expect(f.service.findOneForDelete(ID)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('says what did not happen, as a plain 503 that the boot loops do not take for a shutdown', async () => {
    const start = fixture({ maxConcurrent: 1 });
    start.repository.findOne.mockRejectedValueOnce(dropped());
    const stop = fixture();
    stop.ownership.isHeldByOtherNode.mockRejectedValueOnce(dropped());
    const remove = fixture();
    remove.ownership.isHeldByOtherNode.mockRejectedValueOnce(dropped());

    const errors = await Promise.all([
      start.service.start(ID, { explicit: true }).catch((e: unknown) => e),
      stop.service.stop(ID).catch((e: unknown) => e),
      remove.service.delete(ID).catch((e: unknown) => e),
    ]);

    expect(errors.map(error => (error as Error).message)).toEqual([
      expect.stringContaining('nothing was started'),
      expect.stringContaining('nothing was stopped'),
      expect.stringContaining('nothing was deleted'),
    ]);
    for (const error of errors) expect(error).not.toBeInstanceOf(ServerShuttingDownException);
  });

  it('stop() that fails its ownership read drops the stop mark and leaves no stop request behind', async () => {
    const f = fixture();
    f.ownership.isHeldByOtherNode.mockRejectedValueOnce(dropped());

    await expect(f.service.stop(ID)).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(f.lifecycle.clearStopping).toHaveBeenCalledWith(ID, expect.any(Number));
    expect((f.service as unknown as { stopRequests: Map<string, unknown> }).stopRequests.size).toBe(0);
  });

  it('delete() whose claim matched no row and whose row read then fails drops the stop mark and the stop request', async () => {
    const f = fixture();
    f.ownership.claim.mockResolvedValueOnce(false);
    f.repository.findOne.mockRejectedValueOnce(dropped());

    await expect(f.service.delete(ID)).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(f.lifecycle.clearStopping).toHaveBeenCalledWith(ID, expect.any(Number));
    expect((f.service as unknown as { stopRequests: Map<string, unknown> }).stopRequests.size).toBe(0);
  });
});

describe('the refusals beside those reads keep their answers', () => {
  it.each(['stop', 'delete'] as const)('%s() of a session a live peer holds answers 409', async verb => {
    const f = fixture();
    f.ownership.isHeldByOtherNode.mockResolvedValueOnce(true);

    await expect(f.service[verb](ID)).rejects.toBeInstanceOf(ConflictException);
  });

  it('start() at the cap of a session a live peer holds answers 409, and of a missing session 404', async () => {
    const held = fixture({ maxConcurrent: 1 });
    held.ownership.isHeldByOtherNode.mockResolvedValueOnce(true);
    await expect(held.service.start(ID, { explicit: true })).rejects.toBeInstanceOf(ConflictException);

    const missing = fixture({ maxConcurrent: 1 });
    missing.repository.findOne.mockResolvedValueOnce(null);
    await expect(missing.service.start(ID, { explicit: true })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('start() and delete() whose claim matched no row for a missing session answer 404', async () => {
    const start = fixture();
    start.ownership.claim.mockResolvedValueOnce(false);
    start.repository.findOne.mockResolvedValueOnce(null);
    await expect(start.service.start(ID, { explicit: true })).rejects.toBeInstanceOf(NotFoundException);

    const remove = fixture();
    remove.ownership.claim.mockResolvedValueOnce(false);
    remove.repository.findOne.mockResolvedValueOnce(null);
    await expect(remove.service.delete(ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  // A safe id is any run of letters, digits and hyphens, and the 404 repeats it: one that spells a driver
  // failure must not be read as one.
  it('answers 404, not 503, for a missing session whose id contains the word connection', async () => {
    const f = fixture({ maxConcurrent: 1, id: 'connection-lost' });
    f.repository.findOne.mockResolvedValueOnce(null);

    await expect(f.service.start('connection-lost', { explicit: true })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('keeps a failure that a retry cannot fix as it was', async () => {
    const f = fixture();
    f.ownership.isHeldByOtherNode.mockRejectedValueOnce(rejected());

    await expect(f.service.stop(ID)).rejects.toBeInstanceOf(QueryFailedError);
  });
});

describe('DELETE /sessions/:sessionId when the database fails the first read', () => {
  let app: INestApplication<App>;
  const audit = { logInfo: jest.fn().mockResolvedValue(undefined) };
  const f = fixture();
  // Only the calls the route makes: handing Nest the service itself would run its module lifecycle hooks.
  const routeService = {
    findOne: (id: string) => f.service.findOne(id),
    findOneForDelete: (id: string) => f.service.findOneForDelete(id),
    delete: (id: string) => f.service.delete(id),
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [SessionController],
      providers: [
        { provide: SessionService, useValue: routeService },
        { provide: AuditService, useValue: audit },
        ChatScopeService,
      ],
    }).compile();
    app = mod.createNestApplication({ logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers 503 with nothing claimed, deleted or audited', async () => {
    f.repository.findOne.mockRejectedValueOnce(dropped());

    const res = await request(app.getHttpServer()).delete(`/sessions/${ID}`);

    expect(res.status).toBe(503);
    expect(f.ownership.claim).not.toHaveBeenCalled();
    expect(f.lifecycle.delete).not.toHaveBeenCalled();
    expect(audit.logInfo).not.toHaveBeenCalled();
  });
});

/** A promise a case settles by hand. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

// Every stop and delete of a session sets a stop mark before it knows whether it may act, and a later one is kept beside
// the mark of the earlier. An earlier operation that fails before it did anything drops the mark it set, and only that one.
describe('a stop or delete that fails before it acts drops its own stop mark, not a later one', () => {
  it('delete() whose claim matched no row and whose row read then fails leaves the mark a later stop set', async () => {
    const f = fixture();
    f.ownership.claim.mockResolvedValueOnce(false);
    const deletionRead = deferred<Session>();
    f.repository.findOne.mockImplementationOnce(() => deletionRead.promise);
    const stopCheck = deferred<boolean>();
    f.ownership.isHeldByOtherNode.mockResolvedValueOnce(false).mockImplementationOnce(() => stopCheck.promise);

    const deleting = f.service.delete(ID).catch((error: unknown) => error);
    await turn();
    const deleteMark = f.marks.stamp(ID);
    const stopping = f.service.stop(ID);
    await turn();
    expect(f.marks.stamp(ID)).not.toBe(deleteMark); // the stop holds a newer mark beside the delete's

    deletionRead.reject(dropped());
    expect(await deleting).toBeInstanceOf(ServiceUnavailableException);
    expect(f.marks.has(ID)).toBe(true);

    stopCheck.resolve(false);
    await stopping;
  });

  it('stop() whose ownership read fails leaves the mark a later delete set', async () => {
    const f = fixture();
    const stopCheck = deferred<boolean>();
    f.ownership.isHeldByOtherNode.mockImplementationOnce(() => stopCheck.promise);
    const claim = deferred<boolean>();
    f.ownership.claim.mockImplementationOnce(() => claim.promise);

    const stopping = f.service.stop(ID).catch((error: unknown) => error);
    await turn();
    const stopMark = f.marks.stamp(ID);
    const deleting = f.service.delete(ID).catch((error: unknown) => error);
    await turn();
    expect(f.marks.stamp(ID)).not.toBe(stopMark);

    stopCheck.reject(dropped());
    expect(await stopping).toBeInstanceOf(ServiceUnavailableException);
    expect(f.marks.has(ID)).toBe(true);

    claim.reject(dropped());
    expect(await deleting).toBeInstanceOf(ServiceUnavailableException);
    expect(f.marks.has(ID)).toBe(false); // the delete drops the mark it set itself
  });
});

describe('a stop that is still checking ownership keeps its mark when a later operation fails first', () => {
  it.each(['stop', 'delete'] as const)('the later %s fails its own ownership read', async newer => {
    const f = fixture();
    const olderCheck = deferred<boolean>();
    f.ownership.isHeldByOtherNode.mockImplementationOnce(() => olderCheck.promise).mockRejectedValueOnce(dropped());

    const older = f.service.stop(ID);
    await turn();
    const olderMark = f.marks.stamp(ID);
    const later = newer === 'stop' ? f.service.stop(ID) : f.service.delete(ID);

    await expect(later).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(f.marks.has(ID)).toBe(true); // the older stop has not acted yet and still needs its guard
    expect(f.marks.stamp(ID)).toBe(olderMark);

    olderCheck.resolve(false);
    await older;
  });
});

describe('the marks of stops and deletes that are still in flight or have finished', () => {
  it('keep a stop that is still checking ownership guarded however many later operations fail first', async () => {
    const f = fixture();
    const checks = Array.from({ length: 12 }, () => deferred<boolean>());
    for (const check of checks) f.ownership.isHeldByOtherNode.mockImplementationOnce(() => check.promise);
    const stops = checks.map(() => f.service.stop(ID).catch((error: unknown) => error));
    await turn();

    // Every later stop fails its own ownership read while the first one is still waiting for its answer.
    for (const check of checks.slice(1)) check.reject(dropped());
    for (const stop of stops.slice(1)) expect(await stop).toBeInstanceOf(ServiceUnavailableException);

    expect(f.marks.has(ID)).toBe(true);
    checks[0].resolve(false);
    await stops[0];
  });

  it('are reclaimed by a later stop that finds the session gone, while an operation in flight keeps its own', async () => {
    const f = fixture();
    f.ownership.isHeldByOtherNode.mockResolvedValueOnce(true);
    await expect(f.service.stop(ID)).rejects.toBeInstanceOf(ConflictException); // a live peer holds it: the mark stays
    expect(f.marks.has(ID)).toBe(true);

    f.lifecycle.stop.mockRejectedValueOnce(new NotFoundException(`Session with id '${ID}' not found`));
    await expect(f.service.stop(ID)).rejects.toBeInstanceOf(NotFoundException);

    expect(f.marks.has(ID)).toBe(false);
  });

  it('are not reclaimed from an operation still in flight when a later stop finds the session gone', async () => {
    const f = fixture();
    const olderCheck = deferred<boolean>();
    f.ownership.isHeldByOtherNode.mockImplementationOnce(() => olderCheck.promise);
    const older = f.service.stop(ID);
    await turn();

    f.lifecycle.stop.mockRejectedValueOnce(new NotFoundException(`Session with id '${ID}' not found`));
    await expect(f.service.stop(ID)).rejects.toBeInstanceOf(NotFoundException);

    expect(f.marks.has(ID)).toBe(true); // the older stop has not acted yet
    olderCheck.resolve(false);
    await older;
  });
});

describe('the stop marks of a session', () => {
  it('stay while any operation that set one still needs it, whichever of them drops its own first', () => {
    const marks = new StopMarks();
    marks.add(ID);
    const first = marks.stamp(ID) as number;
    marks.add(ID);
    const second = marks.stamp(ID) as number;

    marks.deleteStamped(ID, second);
    expect(marks.has(ID)).toBe(true);
    expect(marks.stamp(ID)).toBe(first);
    marks.deleteStamped(ID, first);
    expect(marks.has(ID)).toBe(false);

    marks.add(ID);
    const third = marks.stamp(ID) as number;
    marks.add(ID);
    marks.deleteStamped(ID, third);
    expect(marks.has(ID)).toBe(true);
    marks.delete(ID); // a clear that names no stamp takes them all
    expect(marks.has(ID)).toBe(false);
    expect(marks.stamp(ID)).toBeUndefined();
  });

  it('count as set after a look only when a newer mark exists, not when an older one is all that is left', () => {
    const marks = new StopMarks();
    expect(marks.markedSince(ID, undefined)).toBe(false);
    marks.add(ID);
    const completedStop = marks.stamp(ID);
    expect(marks.markedSince(ID, completedStop)).toBe(false); // there when the caller began, and unchanged
    expect(marks.markedSince(ID, undefined)).toBe(true); // the caller saw none
    marks.add(ID);
    const newer = marks.stamp(ID) as number;
    expect(marks.markedSince(ID, completedStop)).toBe(true);

    marks.deleteStamped(ID, newer); // the newer operation failed and dropped its own
    expect(marks.has(ID)).toBe(true);
    expect(marks.markedSince(ID, newer)).toBe(false); // a caller that saw the newer one is not refused for the older
    expect(marks.markedSince(ID, completedStop)).toBe(false);
  });

  it('never evict the mark of an operation in flight, however many marks finish around it', () => {
    const marks = new StopMarks();
    const held = Array.from({ length: 12 }, () => marks.hold(ID));
    for (let i = 0; i < 40; i++) marks.add(ID); // stops that finished

    for (const stamp of held.slice(1)) expect(marks.deleteStamped(ID, stamp)).toBe(true); // all but the first fail
    expect(marks.deleteStamped(ID, held[0])).toBe(true); // the first one is still there to drop
  });

  it('drop the marks of finished operations and keep the ones in flight', () => {
    const marks = new StopMarks();
    marks.add(ID); // a stop that finished
    const running = marks.hold(ID);
    const done = marks.hold(ID);
    marks.settle(ID, done);

    marks.dropFinished(ID);

    expect(marks.has(ID)).toBe(true);
    expect(marks.stamp(ID)).toBe(running);
    marks.deleteStamped(ID, running);
    expect(marks.has(ID)).toBe(false);
  });

  it('keep only the newest few stamps of a session that is stopped again and again', () => {
    const marks = new StopMarks();
    marks.add(ID);
    const oldest = marks.stamp(ID) as number;
    for (let i = 0; i < 40; i++) marks.add(ID);

    // An operation that old no longer holds the mark, and the list does not grow with every stop.
    expect(marks.deleteStamped(ID, oldest)).toBe(false);
    expect(marks.has(ID)).toBe(true);
  });
});

describe('the stop mark of the lifecycle', () => {
  const marksOf = (lifecycle: SessionEngineLifecycle): StopMarks =>
    (lifecycle as unknown as { stoppingSessions: StopMarks }).stoppingSessions;
  const bare = (): SessionEngineLifecycle =>
    Object.assign(Object.create(SessionEngineLifecycle.prototype) as SessionEngineLifecycle, {
      stoppingSessions: new StopMarks(),
    });

  it('is dropped by the stamp of the operation that set it, and kept for a later one', () => {
    const lifecycle = bare();
    const earlier = lifecycle.markStopping(ID);
    const later = lifecycle.markStopping(ID);

    lifecycle.clearStopping(ID, earlier);
    expect(marksOf(lifecycle).has(ID)).toBe(true);
    lifecycle.clearStopping(ID, later);
    expect(marksOf(lifecycle).has(ID)).toBe(false);
  });

  it('is dropped by a clear that names no stamp, as before', () => {
    const lifecycle = bare();
    lifecycle.markStopping(ID);
    lifecycle.markStopping(ID);

    lifecycle.clearStopping(ID);

    expect(marksOf(lifecycle).has(ID)).toBe(false);
  });

  it('stop() of a session with no row drops the marks of finished operations and keeps those in flight', async () => {
    const marks = new StopMarks();
    const controls = new SessionEngineControls({
      sessionRepository: { findOne: jest.fn().mockResolvedValue(null) },
      stoppingSessions: marks,
    } as never);
    marks.add(ID); // an earlier stop that finished
    const running = marks.hold(ID); // another operation still in flight
    const own = marks.hold(ID);

    await expect(controls.stop(ID, { mark: own })).rejects.toBeInstanceOf(NotFoundException);

    expect(marks.has(ID)).toBe(true);
    expect(marks.stamp(ID)).toBe(running);
    marks.deleteStamped(ID, running);
    expect(marks.has(ID)).toBe(false);
  });

  it.each([
    ['its own mark, set alone', 1, 0, false],
    ['its own mark, with the mark of another operation beside it', 2, 1, true],
    ['its own mark, with the mark of an earlier operation beside it', 2, 0, true],
    ['no stamp', 2, undefined, false],
  ])('stop() whose first read fails drops %s', async (_name, count, owner, markedAfter) => {
    const marks = new StopMarks();
    const controls = new SessionEngineControls({
      sessionRepository: { findOne: jest.fn().mockRejectedValue(dropped()) },
      stoppingSessions: marks,
    } as never);
    const stamps: number[] = [];
    for (let i = 0; i < count; i++) {
      marks.add(ID);
      stamps.push(marks.stamp(ID) as number);
    }
    const hooks = owner === undefined ? {} : { mark: stamps[owner] };

    await expect(controls.stop(ID, hooks)).rejects.toBeInstanceOf(QueryFailedError);

    // The call drops the mark it names and the id stays marked for the others; a clear naming none takes every mark.
    expect(marks.has(ID)).toBe(markedAfter);
  });
});

describe('a delete refused at its second credential fence', () => {
  let source: DataSource;

  beforeAll(async () => {
    source = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [Session], synchronize: true });
    await source.initialize();
    await source.getRepository(Session).save({ id: ID, name: 'fence-refusal' });
  });

  afterAll(async () => {
    await source.destroy();
  });

  const controlsWith = (marks: StopMarks, secondFence: () => Promise<void>) => {
    const store = { clear: jest.fn(), attachTo: (row: Session) => row };
    return new SessionEngineControls({
      sessionRepository: source.getRepository(Session),
      engines: new EngineRegistry(),
      sessionErrors: store,
      sessionRestrictions: store,
      presence: store,
      hookManager: { execute: jest.fn().mockResolvedValue({ continue: true }) },
      logger: { log() {}, warn() {}, error() {}, debug() {} },
      dataSource: () => source,
      fences: {
        awaitPendingTeardown: jest.fn().mockResolvedValueOnce(undefined).mockImplementationOnce(secondFence),
        awaitInitialStatus: async () => {},
      },
      broadcaster: store,
      cancelReconnect() {},
      stoppingSessions: marks,
      operatorTeardowns: new Map(),
      reconnectStates: new Map(),
      stuckAuthRecoveryUsed: new Set(),
      initializingSessions: new Set(),
    } as never);
  };

  it('leaves the mark of a stop that finished when several deletes are refused one after another', async () => {
    const marks = new StopMarks();
    marks.add(ID); // a stop that finished leaves its mark
    const refusals = Array.from({ length: 4 }, () => deferred<void>());
    const deletes = refusals.map(refusal =>
      controlsWith(marks, () => refusal.promise)
        .delete(ID)
        .catch((error: unknown) => error),
    );
    await turn();

    for (const refusal of refusals) refusal.reject(new ConflictException('a logout is tearing it down'));
    for (const result of deletes) expect(await result).toBeInstanceOf(ConflictException);

    expect(marks.has(ID)).toBe(true);
    expect(marks.markedSince(ID, undefined)).toBe(true);
  });

  it('drops the mark it set itself', async () => {
    const marks = new StopMarks();
    const controls = controlsWith(marks, () => Promise.reject(new ConflictException('a logout is tearing it down')));

    await expect(controls.delete(ID)).rejects.toBeInstanceOf(ConflictException);

    expect(marks.has(ID)).toBe(false);
  });

  it('leaves the mark a stop set while the delete waited at the fence', async () => {
    const marks = new StopMarks();
    const controls = controlsWith(marks, () => {
      marks.add(ID); // a stop of the same session begins while the delete waits
      return Promise.reject(new ConflictException('a logout is tearing it down'));
    });

    await expect(controls.delete(ID)).rejects.toBeInstanceOf(ConflictException);

    expect(marks.has(ID)).toBe(true);
  });
});
