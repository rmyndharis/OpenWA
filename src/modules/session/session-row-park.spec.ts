// The pause before a launch's one retry: a test that sets `mockRetryPause` runs it at once, after its hook.
let mockRetryPause: (() => void) | undefined;
jest.mock('node:timers/promises', () => {
  const actual = jest.requireActual<typeof import('node:timers/promises')>('node:timers/promises');
  return {
    ...actual,
    setTimeout: (ms: number, value?: unknown) => {
      if (!mockRetryPause) return actual.setTimeout(ms, value);
      mockRetryPause();
      return Promise.resolve(value);
    },
  };
});

import 'reflect-metadata';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource, Repository } from 'typeorm';
import { Session, SessionStatus } from './entities/session.entity';
import { Message } from '../message/entities/message.entity';
import { SessionEngineLifecycle } from './session-engine-lifecycle.service';
import { SessionService } from './session.service';
import { SessionErrorStore } from './session-error-store.service';
import { SessionRestrictionStore } from './session-restriction-store.service';
import { SessionOwnershipService } from './session-ownership.service';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { resolveEngineInitTimeoutMs } from '../../engine/engine-init-timeout';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { EngineStatus, type EngineEventCallbacks } from '../../engine/interfaces/whatsapp-engine.interface';
import { RecoveryQueue, recoveryQueueOptions } from '../../common/utils/recovery-queue';
import { RecoveryJournal } from '../../common/utils/recovery-journal';
import { LoggerService } from '../../common/services/logger.service';

/**
 * A write of a session row the database refused (its status, the number a READY links or an unlink clears, an
 * operator's stop) is kept and written once the database answers, only while no later write reached the row, and
 * a restart finds it in the journal and writes it before the boot reset and auto-start read the rows.
 */
describe('Session row writes the database refused, kept until it answers (SQLite)', () => {
  let dir: string;
  let ds: DataSource;
  let sessions: Repository<Session>;
  let id: string;
  // Set while the database refuses the writes of the session rows it matches, with the error it answers.
  let refuse: ((patch: Record<string, unknown>) => Error | undefined) | undefined;
  let nodes: Array<{ queue: RecoveryQueue }>;
  const unavailable = (): Error => Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' });
  const rejected = (): Error =>
    Object.assign(new Error('CHECK constraint failed'), { code: 'SQLITE_CONSTRAINT_CHECK' });
  // eslint-disable-next-line @typescript-eslint/unbound-method -- a jest spy, read for its calls
  const logged = (): jest.Mock => LoggerService.prototype.error as jest.Mock;

  beforeEach(async () => {
    jest.spyOn(LoggerService.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(LoggerService.prototype, 'log').mockImplementation(() => undefined);
    refuse = undefined;
    mockRetryPause = undefined;
    nodes = [];
    dir = mkdtempSync(join(tmpdir(), 'session-row-park-'));
    ds = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session, Message],
      synchronize: true,
    }).initialize();
    sessions = ds.getRepository(Session);
    const update = sessions.update.bind(sessions);
    jest.spyOn(sessions, 'update').mockImplementation((where, patch) => {
      const error = refuse?.(patch);
      return error ? Promise.reject(error) : update(where, patch);
    });
    id = (
      await sessions.save(
        sessions.create({ name: 'kept', status: SessionStatus.DISCONNECTED, phone: '628111', config: {} }),
      )
    ).id;
  });

  afterEach(async () => {
    refuse = undefined;
    mockRetryPause = undefined;
    jest.useRealTimers();
    for (const node of nodes) await node.queue.drain(0);
    jest.restoreAllMocks();
    await ds.destroy();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * One process over the shared database: its journal (opened at start), queue, lifecycle and session service. With
   * `nodeId` it holds claims as that node does in a cluster.
   */
  function boot({ nodeId }: { nodeId?: string } = {}) {
    const journal = new RecoveryJournal(join(dir, 'recovery-journal.jsonl'));
    // Only the test's own flush runs a pass.
    const queue = new RecoveryQueue({
      ...recoveryQueueOptions(false, 60_000),
      baseDelayMs: 600_000,
      capDelayMs: 600_000,
      journal,
    });
    const registry = new EngineRegistry();
    let callbacks: EngineEventCallbacks | undefined;
    const engine = {
      initialize: jest.fn((cb: EngineEventCallbacks) => {
        callbacks = cb;
        return Promise.resolve();
      }),
      getStatus: () => EngineStatus.READY,
      destroy: jest.fn().mockResolvedValue(undefined),
      forceDestroy: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      logout: jest.fn().mockResolvedValue(undefined),
    };
    const factory = { create: jest.fn(() => engine), purgeSessionData: jest.fn().mockResolvedValue(undefined) };
    const events = {
      emitSessionStatus: jest.fn(),
      emitSessionDisconnected: jest.fn(),
      emitSessionAuthenticated: jest.fn(),
      emitQRCode: jest.fn(),
    };
    const hooks = { execute: jest.fn().mockResolvedValue({ continue: true }) };
    const settings: Record<string, unknown> = { features: { autoStartSessions: true }, 'session.nodeId': nodeId };
    const config = { get: (key: string, fallback?: unknown) => settings[key] ?? fallback };
    const ownership = nodeId ? new SessionOwnershipService(sessions, config as never) : undefined;
    const shutdown = { draining: false, isShuttingDown: () => shutdown.draining };
    const webhooks = { dispatch: jest.fn().mockResolvedValue(undefined), recoveryQueue: () => queue };
    const errors = new SessionErrorStore();
    const restrictions = new SessionRestrictionStore();
    const presence = { clear: jest.fn(), getOwnIntent: jest.fn() };
    const watchdog = { clear: jest.fn(), start: jest.fn(), stop: jest.fn() };
    const projector = {
      holdsInbound: false,
      settleParkedChanges: jest.fn().mockResolvedValue(undefined),
      forgetSession: jest.fn(),
    };
    const lifecycle = new SessionEngineLifecycle(
      sessions,
      ds,
      factory as never,
      registry,
      watchdog as never,
      projector as never,
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
      ds.getRepository(Message),
      ds,
      registry,
      watchdog as never,
      errors,
      restrictions,
      presence as never,
      hooks as never,
      lifecycle,
      {} as never,
      config as never,
      ownership,
      shutdown as never,
    );
    const node = {
      journal,
      queue,
      registry,
      lifecycle,
      service,
      factory,
      engine,
      events,
      hooks,
      shutdown,
      ownership,
      callbacks: () => callbacks!,
    };
    nodes.push(node);
    return node;
  }

  /** The process dies while the database refuses its writes: the journal is all it leaves. */
  const crash = (node: ReturnType<typeof boot>): void => node.journal.close();

  /** The next process starts as the gateway boots one: module init, the queue let go, then the bootstrap hooks. */
  async function restart() {
    const node = boot();
    await node.service.onModuleInit();
    node.queue.ready();
    node.service.onApplicationBootstrap();
    await (node.service as unknown as { autoStartRun: Promise<void> }).autoStartRun;
    return node;
  }

  const rowOf = (): Promise<Session> => sessions.findOneByOrFail({ id });
  describe('a status write', () => {
    /** The status is written once, then the database refuses the next one: a reconnect that ran out lands FAILED. */
    async function keptFailed() {
      const node = boot();
      await node.lifecycle.updateStatus(id, SessionStatus.INITIALIZING);
      refuse = patch => ('status' in patch ? unavailable() : undefined);
      await expect(node.lifecycle.updateStatus(id, SessionStatus.FAILED)).rejects.toThrow('disk I/O error');
      refuse = undefined;
      return node;
    }

    it('is written once the database answers, and announced', async () => {
      const node = await keptFailed();

      await node.queue.flush();

      expect((await rowOf()).status).toBe(SessionStatus.FAILED);
      expect(node.events.emitSessionStatus).toHaveBeenLastCalledWith(id, SessionStatus.FAILED);
    });

    it('lands at the next boot before the reset, so auto-start leaves the failed session down', async () => {
      crash(await keptFailed());

      const next = await restart();

      expect((await rowOf()).status).toBe(SessionStatus.FAILED);
      expect(next.factory.create).not.toHaveBeenCalled();
      // What a dead process saw is not announced as current.
      expect(next.events.emitSessionStatus).not.toHaveBeenCalled();
    });

    it('that says an engine runs lands as disconnected when the next boot could not land it before its reset', async () => {
      const node = boot();
      await node.lifecycle.updateStatus(id, SessionStatus.FAILED);
      refuse = patch => ('status' in patch ? unavailable() : undefined);
      await expect(node.lifecycle.updateStatus(id, SessionStatus.READY)).rejects.toThrow('disk I/O error');
      crash(node);
      // The next boot's first status write, the kept one, is refused; the reset goes through.
      let refused = false;
      refuse = patch => ('status' in patch && !refused ? ((refused = true), unavailable()) : undefined);

      const next = await restart();
      await next.queue.flush();

      expect((await rowOf()).status).toBe(SessionStatus.DISCONNECTED);
    });

    it('gives way to a later status this process wrote', async () => {
      const node = await keptFailed();
      await node.lifecycle.updateStatus(id, SessionStatus.DISCONNECTED);

      await node.queue.flush();

      expect((await rowOf()).status).toBe(SessionStatus.DISCONNECTED);
    });

    it('gives way to a status another node wrote since', async () => {
      const node = await keptFailed();
      await sessions.update(id, { status: SessionStatus.READY, nodeId: 'node-b' });

      await node.queue.flush();

      expect((await rowOf()).status).toBe(SessionStatus.READY);
    });

    it('gives way to a later write of this process that put back the status it was meant to replace', async () => {
      const node = boot();
      await node.lifecycle.updateStatus(id, SessionStatus.READY);
      refuse = patch => ('status' in patch ? unavailable() : undefined);
      await expect(node.lifecycle.updateStatus(id, SessionStatus.DISCONNECTED)).rejects.toThrow('disk I/O error');
      refuse = undefined;
      // The engine came back on its own.
      await node.lifecycle.updateStatus(id, SessionStatus.READY);

      await node.queue.flush();

      expect((await rowOf()).status).toBe(SessionStatus.READY);
    });

    it('is given up with its own loss action once the database rejects it for a reason of its own', async () => {
      const node = await keptFailed();
      refuse = patch => ('status' in patch ? rejected() : undefined);

      for (let pass = 0; pass < 3; pass++) await node.queue.flush();

      expect((await rowOf()).status).toBe(SessionStatus.INITIALIZING);
      expect(logged()).toHaveBeenCalledWith(
        expect.any(String),
        undefined,
        expect.objectContaining({ sessionId: id, reason: 'failures', action: 'session_status_write_lost' }),
      );
    });

    it('of a launch retired as it started is written once the database answers', async () => {
      const node = boot();
      await node.lifecycle.updateStatus(id, SessionStatus.INITIALIZING);
      node.registry.set(id, node.engine as never);
      refuse = patch => ('status' in patch ? unavailable() : undefined);
      const controls = (
        node.lifecycle as unknown as { controls: { retireLaunchedEngine(id: string, e: unknown): Promise<void> } }
      ).controls;

      await controls.retireLaunchedEngine(id, node.engine);
      refuse = undefined;
      await node.queue.flush();

      expect((await rowOf()).status).toBe(SessionStatus.DISCONNECTED);
    });

    it('of a start whose engine never finished starting is written once the database answers', async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
      const node = boot();
      node.engine.initialize.mockReturnValue(new Promise<void>(() => undefined));
      refuse = patch => (patch.status === SessionStatus.DISCONNECTED ? unavailable() : undefined);

      const started = node.lifecycle.start(id).catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(resolveEngineInitTimeoutMs());
      expect(await started).toMatchObject({ message: 'disk I/O error' });
      refuse = undefined;
      await node.queue.flush();

      expect((await rowOf()).status).toBe(SessionStatus.DISCONNECTED);
    });

    it('that hands a failed start back to the next boot, refused as shutdown begins, is written once the database answers', async () => {
      const node = boot();
      node.engine.initialize.mockRejectedValueOnce(new EngineTransportError('Protocol error: Target closed'));
      mockRetryPause = () => {
        node.shutdown.draining = true;
        refuse = patch => (patch.status === SessionStatus.DISCONNECTED ? unavailable() : undefined);
      };

      await expect(node.service.start(id, { explicit: true })).rejects.toThrow('Server is shutting down');
      expect((await rowOf()).status).toBe(SessionStatus.FAILED);
      refuse = undefined;
      await node.queue.flush();

      expect((await rowOf()).status).toBe(SessionStatus.DISCONNECTED);
    });

    it('of a released row a failed start left claiming to run is written once the database answers', async () => {
      // A node that vanished left the row READY on a lapsed lease; this node's start of it fails at launch.
      await sessions.update(id, {
        status: SessionStatus.READY,
        nodeId: 'node-x',
        claimedAt: new Date(Date.now() - 300_000),
        leaseExpiresAt: new Date(Date.now() - 1_000),
      });
      const node = boot({ nodeId: 'node-a' });
      node.factory.create.mockImplementationOnce(() => {
        throw new Error('EACCES: permission denied');
      });
      refuse = patch => (patch.status === SessionStatus.DISCONNECTED ? unavailable() : undefined);

      await expect(node.service.start(id, { explicit: true })).rejects.toThrow('EACCES');
      expect(await rowOf()).toMatchObject({ status: SessionStatus.READY, nodeId: null });
      refuse = undefined;
      await node.queue.flush();

      expect((await rowOf()).status).toBe(SessionStatus.DISCONNECTED);
    });
  });
});
