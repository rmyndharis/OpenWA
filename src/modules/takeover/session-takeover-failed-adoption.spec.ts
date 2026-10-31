import { randomUUID } from 'node:crypto';
import { DataSource, DataSourceOptions, Repository } from 'typeorm';
import { Session, SessionStatus } from '../session/entities/session.entity';
import { SessionOwnershipService } from '../session/session-ownership.service';
import { SessionEngineLifecycle } from '../session/session-engine-lifecycle.service';
import { SessionService } from '../session/session.service';
import { SessionErrorStore } from '../session/session-error-store.service';
import { SessionRestrictionStore } from '../session/session-restriction-store.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { EngineStatus } from '../../engine/interfaces/whatsapp-engine.interface';
import { postgresUtcExtra } from '../../database/postgres-utc';
import { SessionTakeoverService } from './session-takeover.service';

const TTL_MS = 60_000;

/** An engine that initializes at once and stays up, for a session this node really runs. */
function runningEngine() {
  return {
    initialize: jest.fn().mockResolvedValue(undefined),
    getStatus: () => EngineStatus.INITIALIZING,
    destroy: jest.fn().mockResolvedValue(undefined),
    forceDestroy: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    logout: jest.fn().mockResolvedValue(undefined),
  };
}

/**
 * One node's view of the cluster, wired from the real ownership, lifecycle, session and takeover services
 * over a shared database. Only the engine factory is a stand-in: with `failLaunch` it fails before any
 * engine exists, the way `EngineFactory.create` does when it cannot create the session's auth directory.
 */
function node(nodeId: string, db: DataSource, failLaunch: boolean) {
  const sessions: Repository<Session> = db.getRepository(Session);
  const settings: Record<string, unknown> = {
    'session.nodeId': nodeId,
    'session.leaseTtlMs': TTL_MS,
    features: { autoStartSessions: true },
  };
  const config = { get: (key: string, fallback?: unknown) => settings[key] ?? fallback };
  const ownership = new SessionOwnershipService(sessions, config as never);
  const registry = new EngineRegistry();
  const factory = {
    create: jest.fn(() => {
      if (failLaunch) throw new Error("EACCES: permission denied, mkdir './data/sessions/session-x'");
      return runningEngine();
    }),
    purgeSessionData: jest.fn().mockResolvedValue(undefined),
  };
  const errors = new SessionErrorStore();
  const restrictions = new SessionRestrictionStore();
  const presence = { clear: jest.fn(), getOwnIntent: jest.fn() };
  const events = {
    emitSessionStatus: jest.fn(),
    emitSessionDisconnected: jest.fn(),
    emitSessionAuthenticated: jest.fn(),
  };
  const webhooks = { dispatch: jest.fn().mockResolvedValue(undefined) };
  const hooks = { execute: jest.fn().mockResolvedValue({ continue: true }) };
  const lifecycle = new SessionEngineLifecycle(
    sessions,
    db,
    factory as never,
    registry,
    { clear: jest.fn() } as never,
    {} as never,
    errors,
    restrictions,
    presence as never,
    events as never,
    webhooks as never,
    hooks as never,
    {} as never,
    config as never,
    undefined,
    undefined,
    ownership,
  );
  const service = new SessionService(
    sessions,
    {} as never,
    db,
    registry,
    { clear: jest.fn() } as never,
    errors,
    restrictions,
    presence as never,
    hooks as never,
    lifecycle,
    {} as never,
    config as never,
    ownership,
  );
  const takeover = new SessionTakeoverService(service, ownership, config as never);
  return { service, takeover, ownership, factory, events };
}

describe('a start that fails before an engine exists on a session a vanished node left running', () => {
  const pg = process.env.DATABASE_TYPE === 'postgres';
  let db: DataSource;
  let schema: string | undefined;
  let sessions: Repository<Session>;

  beforeAll(async () => {
    if (pg) {
      schema = `session_takeover_failed_${randomUUID().replace(/-/g, '')}`;
      const options: DataSourceOptions = {
        type: 'postgres',
        host: process.env.DATABASE_HOST || 'localhost',
        port: Number(process.env.DATABASE_PORT || 5432),
        username: process.env.DATABASE_USERNAME || 'openwa',
        password: process.env.DATABASE_PASSWORD || 'openwa',
        database: process.env.DATABASE_NAME || 'openwa',
        schema,
        entities: [Session],
        extra: postgresUtcExtra(),
      };
      const setup = await new DataSource(options).initialize();
      await setup.query(`CREATE SCHEMA "${schema}"`);
      await setup.destroy();
      db = await new DataSource({ ...options, synchronize: true }).initialize();
    } else {
      db = await new DataSource({
        type: 'better-sqlite3',
        database: ':memory:',
        entities: [Session],
        synchronize: true,
      }).initialize();
    }
    sessions = db.getRepository(Session);
  });

  afterAll(async () => {
    if (schema) await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.destroy();
  });

  afterEach(async () => {
    await sessions.clear();
  });

  /** node-a ran the session and vanished; its lease lapsed a moment ago. */
  async function orphan(status: SessionStatus = SessionStatus.READY): Promise<string> {
    const row = await sessions.save(
      sessions.create({
        name: `orphaned-${randomUUID().slice(0, 8)}`,
        status,
        phone: '628111',
        config: {},
        nodeId: 'node-a',
        claimedAt: new Date(Date.now() - 5 * TTL_MS),
        leaseExpiresAt: new Date(Date.now() - 1_000),
      }),
    );
    return row.id;
  }

  async function rowOf(id: string): Promise<{ status: SessionStatus; nodeId: string | null }> {
    const row = await sessions.findOneByOrFail({ id });
    return { status: row.status, nodeId: row.nodeId };
  }

  it('does not leave a ready status that nothing runs after a takeover adoption fails', async () => {
    const id = await orphan();

    // node-b's sweep adopts it, and the launch fails before any engine or status write.
    const b = node('node-b', db, true);
    await b.takeover.sweep();
    expect(b.factory.create).toHaveBeenCalledTimes(1);

    // Every later sweep, on any node, long after node-a's lease ran out.
    const c = node('node-c', db, false);
    await c.takeover.sweep();
    await b.takeover.sweep();

    // A row no node holds is revisited by neither the lapsed-claim correction nor the adoption sweep.
    expect(await rowOf(id)).toEqual({ status: SessionStatus.DISCONNECTED, nodeId: null });
    expect(b.events.emitSessionStatus).toHaveBeenCalledWith(id, SessionStatus.DISCONNECTED);
  });

  it('marks the session disconnected when an explicit start of it fails the same way', async () => {
    const id = await orphan();
    const b = node('node-b', db, true);

    await expect(b.service.start(id, { explicit: true })).rejects.toThrow('EACCES');

    expect(await rowOf(id)).toEqual({ status: SessionStatus.DISCONNECTED, nodeId: null });
  });

  it('marks it disconnected when the release waited for a second start that then failed too', async () => {
    const id = await orphan();
    const b = node('node-b', db, true);
    // The second start is still waiting on its claim when the first launch fails, and that claim then
    // fails on the database: the start that leaves last owes the release.
    const claim = b.ownership.claim.bind(b.ownership);
    let openClaim: () => void = () => undefined;
    const gate = new Promise<void>(resolve => (openClaim = resolve));
    jest
      .spyOn(b.ownership, 'claim')
      .mockImplementationOnce(claim)
      .mockImplementationOnce(async () => {
        await gate;
        throw new Error('database is locked');
      });

    const first = b.service.start(id, { explicit: true });
    const second = b.service.start(id, { explicit: true });
    await expect(first).rejects.toThrow('EACCES');
    expect(await rowOf(id)).toEqual({ status: SessionStatus.READY, nodeId: 'node-b' });

    openClaim();
    await expect(second).rejects.toThrow('database is locked');

    expect(await rowOf(id)).toEqual({ status: SessionStatus.DISCONNECTED, nodeId: null });
    const announced = b.events.emitSessionStatus.mock.calls.filter(
      ([, status]) => status === SessionStatus.DISCONNECTED,
    );
    expect(announced).toHaveLength(1);
  });

  it('leaves a failed session failed', async () => {
    const id = await orphan(SessionStatus.FAILED);
    const b = node('node-b', db, true);

    await expect(b.service.start(id, { explicit: true })).rejects.toThrow('EACCES');

    expect(await rowOf(id)).toEqual({ status: SessionStatus.FAILED, nodeId: null });
  });

  it('writes no status when a start is refused because this node already runs the session', async () => {
    const id = await orphan();
    const b = node('node-b', db, false);
    await b.service.start(id, { explicit: true });
    const running = await rowOf(id);
    expect(running).toEqual({ status: SessionStatus.INITIALIZING, nodeId: 'node-b' });

    await expect(b.service.start(id, { explicit: true })).rejects.toThrow(/already/i);

    expect(await rowOf(id)).toEqual(running);
    expect(b.events.emitSessionStatus).not.toHaveBeenCalledWith(id, SessionStatus.DISCONNECTED);
  });

  it('leaves the status of a peer that claimed and started the session after the release', async () => {
    const id = await orphan();
    const b = node('node-b', db, true);
    const c = node('node-c', db, false);
    // node-b's release lands, and its correction is held back, as a slow write would be.
    const release = b.ownership.release.bind(b.ownership);
    let openCorrection: () => void = () => undefined;
    const correction = new Promise<void>(resolve => (openCorrection = resolve));
    let releasedResolve: () => void = () => undefined;
    const released = new Promise<void>(resolve => (releasedResolve = resolve));
    jest.spyOn(b.ownership, 'release').mockImplementationOnce(async (...args: Parameters<typeof release>) => {
      await release(...args);
      releasedResolve();
      await correction;
    });

    const failing = b.service.start(id, { explicit: true });
    await released;
    await c.service.start(id, { explicit: true });
    expect(await rowOf(id)).toEqual({ status: SessionStatus.INITIALIZING, nodeId: 'node-c' });

    openCorrection();
    await expect(failing).rejects.toThrow('EACCES');

    expect(await rowOf(id)).toEqual({ status: SessionStatus.INITIALIZING, nodeId: 'node-c' });
    expect(b.events.emitSessionStatus).not.toHaveBeenCalledWith(id, SessionStatus.DISCONNECTED);
  });
});
