import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { QueryFailedError } from 'typeorm';
import { SessionController } from './session.controller';
import { SessionService } from './session.service';
import { ServerShuttingDownException } from './session-engine-controls';
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
  const lifecycle = {
    start: jest.fn().mockResolvedValue({ ...row }),
    stop: jest.fn().mockResolvedValue({ ...row }),
    delete: jest.fn().mockResolvedValue(undefined),
    // Another session holds the only slot when the cap is 1.
    startSlotHolders: jest.fn(() => new Set(['another-session'])),
    isEngineActive: jest.fn(() => false),
    markStopping: jest.fn(),
    clearStopping: jest.fn(),
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
  return { service, repository, lifecycle, ownership };
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

    expect(f.lifecycle.clearStopping).toHaveBeenCalledWith(ID);
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
