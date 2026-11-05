import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { QueryFailedError } from 'typeorm';
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
  // The marks are the lifecycle's own: each operation of a session sets one, and a later one replaces it.
  const marks = new StopMarks();
  const lifecycle = {
    start: jest.fn().mockResolvedValue({ ...row }),
    stop: jest.fn().mockResolvedValue({ ...row }),
    delete: jest.fn().mockResolvedValue(undefined),
    // Another session holds the only slot when the cap is 1.
    startSlotHolders: jest.fn(() => new Set(['another-session'])),
    isEngineActive: jest.fn(() => false),
    markStopping: jest.fn((markedId: string) => {
      marks.add(markedId);
      return marks.stamp(markedId);
    }),
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

// Every stop and delete of a session sets a stop mark before it knows whether it may act, and a later one replaces the
// mark of the earlier. An earlier operation that fails before it did anything drops the mark it set, and only that one.
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
    expect(f.marks.stamp(ID)).not.toBe(deleteMark); // the stop's mark replaced the delete's

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

  it.each([
    ['carries the stamp of its own call', true, false],
    ['carries no stamp', false, false],
    ['carries the stamp of an earlier call', true, true],
  ])('stop() whose first read fails drops the mark when it %s', async (_name, stamped, earlierStamp) => {
    const marks = new StopMarks();
    const controls = new SessionEngineControls({
      sessionRepository: { findOne: jest.fn().mockRejectedValue(dropped()) },
      stoppingSessions: marks,
    } as never);
    marks.add(ID);
    const own = marks.stamp(ID);
    marks.add(ID); // a later stop or delete of the session replaced it
    const hooks = stamped ? { mark: earlierStamp ? own : marks.stamp(ID) } : {};

    await expect(controls.stop(ID, hooks)).rejects.toBeInstanceOf(QueryFailedError);

    // Dropped for the stamp of the mark that stands and for no stamp; kept for the stamp of the one it replaced.
    expect(marks.has(ID)).toBe(earlierStamp);
  });
});
