import { ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { SessionOwnershipService } from './session-ownership.service';
import { SessionService } from './session.service';
import { Session, SessionStatus } from './entities/session.entity';

const MISSING = '00000000-0000-4000-8000-000000000000';
const HELD = 'Session is held by another node';

// A claim is a conditional write, so it misses a row that is gone as it misses one a live peer holds. Only the peer is
// worth the warning: a single node answering 404 for a mistyped or deleted id must not log that another node holds it.
describe('the warning that another node holds a session', () => {
  let dataSource: DataSource;
  let sessions: Repository<Session>;
  let warn: jest.SpyInstance;

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

  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  const heldLines = (): string[] =>
    (warn.mock.calls as unknown[][]).map(call => String(call[0])).filter(line => line.includes(HELD));

  const build = (): { service: SessionService; ownership: SessionOwnershipService } => {
    const cfg = { get: (k: string) => ({ 'session.nodeId': 'node-a', 'session.leaseTtlMs': 60_000 })[k] } as never;
    const ownership = new SessionOwnershipService(sessions, cfg);
    const lifecycle = {
      markStopping: () => 1,
      clearStopping: () => undefined,
      clearFinishedStops: () => undefined,
      settleStopping: () => undefined,
      isEngineActive: () => false,
      holdDelete: () => () => undefined,
      startSlotHolders: () => new Set<string>(),
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
      { get: <T>(_k: string, fallback?: T) => fallback } as never,
      ownership,
      undefined,
    );
    return { service, ownership };
  };

  it.each(['start', 'delete'] as const)('is not logged by a %s of a session that does not exist', async verb => {
    const { service } = build();

    const call = verb === 'start' ? service.start(MISSING, { explicit: true }) : service.delete(MISSING);

    await expect(call).rejects.toBeInstanceOf(NotFoundException);
    expect(heldLines()).toEqual([]);
  });

  it.each(['start', 'delete'] as const)('is logged once by a %s of a session a live peer holds', async verb => {
    const row = await sessions.save(
      sessions.create({
        name: `held-${verb}`,
        status: SessionStatus.READY,
        config: {},
        nodeId: 'node-b',
        claimedAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + 60_000),
      }),
    );
    const { service, ownership } = build();
    // A delete checks the row before it claims it: the peer here takes it between that check and the claim.
    if (verb === 'delete') jest.spyOn(ownership, 'isHeldByOtherNode').mockResolvedValueOnce(false);
    const claim = verb === 'start' ? service.start(row.id, { explicit: true }) : service.delete(row.id);

    await expect(claim).rejects.toBeInstanceOf(ConflictException);
    expect(heldLines()).toHaveLength(1);
  });
});
