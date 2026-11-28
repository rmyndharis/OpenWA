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
  // Awaited before a write of a session row reaches the database, to run another request at that point.
  let beforeWrite: ((patch: Record<string, unknown>) => Promise<void>) | undefined;
  let nodes: Array<{ queue: RecoveryQueue; lifecycle: SessionEngineLifecycle }>;
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
    beforeWrite = undefined;
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
    const write = (...[where, patch]: Parameters<typeof update>): ReturnType<typeof update> => {
      const error = refuse?.(patch);
      return error ? Promise.reject(error) : update(where, patch);
    };
    jest
      .spyOn(sessions, 'update')
      .mockImplementation((where, patch) =>
        beforeWrite ? beforeWrite(patch).then(() => write(where, patch)) : write(where, patch),
      );
    id = (
      await sessions.save(
        sessions.create({ name: 'kept', status: SessionStatus.DISCONNECTED, phone: '628111', config: {} }),
      )
    ).id;
  });

  afterEach(async () => {
    refuse = undefined;
    beforeWrite = undefined;
    mockRetryPause = undefined;
    jest.useRealTimers();
    // A reconnect an unlink armed must not fire after the test.
    for (const node of nodes) await node.lifecycle.shutdown();
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
  async function restart(options: { nodeId?: string } = {}) {
    const node = boot(options);
    await node.service.onModuleInit();
    node.queue.ready();
    node.service.onApplicationBootstrap();
    await (node.service as unknown as { autoStartRun: Promise<void> }).autoStartRun;
    return node;
  }

  const rowOf = (): Promise<Session> => sessions.findOneByOrFail({ id });
  const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 20; turn++) await new Promise(resolve => setImmediate(resolve));
  };
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

  describe('the READY row', () => {
    /** A fresh link: the session has no number yet, its engine starts, and the database refuses the row its READY writes. */
    async function keptReady(pushName = 'Alice', options: { nodeId?: string } = {}) {
      await sessions.update(id, { phone: null });
      const node = boot(options);
      await node.service.start(id, { explicit: true });
      refuse = patch => ('status' in patch || 'phone' in patch ? unavailable() : undefined);
      node.callbacks().onReady!('628111', pushName);
      await settle();
      refuse = undefined;
      return node;
    }

    it('is written once the database answers', async () => {
      const node = await keptReady();

      await node.queue.flush();

      expect(await rowOf()).toMatchObject({ status: SessionStatus.READY, phone: '628111', pushName: 'Alice' });
      expect((await rowOf()).connectedAt).toBeInstanceOf(Date);
    });

    it('survives a restart before the database answers, and the session auto-starts', async () => {
      crash(await keptReady());

      const next = await restart();

      expect(next.factory.create).toHaveBeenCalledTimes(1);
      expect((await rowOf()).phone).toBe('628111');
    });

    it('gives way to a later status and binding this process wrote', async () => {
      const node = await keptReady();
      await node.lifecycle.updateStatus(id, SessionStatus.DISCONNECTED);
      node.callbacks().onReady!('628222', 'Bob');
      await settle();
      await node.lifecycle.updateStatus(id, SessionStatus.DISCONNECTED);

      await node.queue.flush();

      expect(await rowOf()).toMatchObject({ status: SessionStatus.DISCONNECTED, phone: '628222', pushName: 'Bob' });
    });

    it('gives way to a binding another node wrote since', async () => {
      const node = await keptReady();
      await sessions.update(id, { phone: '628333', status: SessionStatus.READY, nodeId: 'node-b' });

      await node.queue.flush();

      expect((await rowOf()).phone).toBe('628333');
    });

    it('lands after this node released its claim, as a stop does', async () => {
      const node = await keptReady('Alice', { nodeId: 'node-a' });
      await node.service.stop(id);
      expect((await rowOf()).nodeId).toBeNull();

      await node.queue.flush();

      expect((await rowOf()).phone).toBe('628111');
    });

    it('survives a restart of the same node of a cluster, and the session auto-starts', async () => {
      crash(await keptReady('Alice', { nodeId: 'node-a' }));

      const next = await restart({ nodeId: 'node-a' });
      next.ownership?.stopHeartbeat();

      expect(next.factory.create).toHaveBeenCalledTimes(1);
      expect(await rowOf()).toMatchObject({ phone: '628111', nodeId: 'node-a' });
    });

    it('keeps the push name the engine synced after it', async () => {
      const node = await keptReady('');
      node.callbacks().onPushNameChanged!('Alice');
      await settle();

      await node.queue.flush();

      expect(await rowOf()).toMatchObject({ phone: '628111', pushName: 'Alice' });
    });

    it('is given up with its own loss action for the binding', async () => {
      const node = await keptReady();
      refuse = patch => ('phone' in patch ? rejected() : undefined);

      for (let pass = 0; pass < 3; pass++) await node.queue.flush();

      expect((await rowOf()).phone).toBeNull();
      expect(logged()).toHaveBeenCalledWith(
        expect.any(String),
        undefined,
        expect.objectContaining({ sessionId: id, reason: 'failures', action: 'session_phone_write_lost' }),
      );
    });
  });

  describe('the phone clear after an unlink', () => {
    /** The session runs bound to 628111; WhatsApp unlinks it, and the database refuses the clear of its number. */
    async function keptClear() {
      const node = boot();
      await node.service.start(id, { explicit: true });
      refuse = patch => ('phone' in patch ? unavailable() : undefined);
      await node.lifecycle.handleEngineDisconnected(id, node.engine as never, 'LOGOUT');
      await settle();
      refuse = undefined;
      return node;
    }

    it('is written once the database answers', async () => {
      const node = await keptClear();
      expect((await rowOf()).phone).toBe('628111');

      await node.queue.flush();

      expect((await rowOf()).phone).toBeNull();
    });

    it('survives a restart before the database answers, so auto-start leaves the unlinked session down', async () => {
      crash(await keptClear());

      const next = await restart();

      expect((await rowOf()).phone).toBeNull();
      expect(next.factory.create).not.toHaveBeenCalled();
    });

    it('gives way to the number a later READY linked', async () => {
      const node = await keptClear();
      node.callbacks().onReady!('628222', 'Bob');
      await settle();

      await node.queue.flush();

      expect((await rowOf()).phone).toBe('628222');
    });

    it('gives way to a number another node linked since', async () => {
      const node = await keptClear();
      await sessions.update(id, { phone: '628333', nodeId: 'node-b' });

      await node.queue.flush();

      expect((await rowOf()).phone).toBe('628333');
    });

    it('gives way to the same number linked again since', async () => {
      const node = await keptClear();
      node.callbacks().onReady!('628111', 'Alice');
      await settle();

      await node.queue.flush();

      expect((await rowOf()).phone).toBe('628111');
    });

    it('of a logout is written once the database answers', async () => {
      const node = boot();
      await node.service.start(id, { explicit: true });
      refuse = patch => ('phone' in patch ? unavailable() : undefined);

      await expect(node.service.logout(id)).rejects.toThrow('disk I/O error');
      refuse = undefined;
      await node.queue.flush();

      expect((await rowOf()).phone).toBeNull();
    });
  });

  describe('a stop record', () => {
    /** The session runs; the database refuses the stop its force-kill records, and the kill goes on. */
    async function keptKill(options: { nodeId?: string } = {}) {
      const node = boot(options);
      await node.service.start(id, { explicit: true });
      refuse = patch => ('desiredState' in patch ? unavailable() : undefined);
      await node.service.forceKill(id);
      expect(node.engine.forceDestroy).toHaveBeenCalledTimes(1);
      refuse = undefined;
      return node;
    }

    it('of a force-kill is written once the database answers, and the kill does not wait for it', async () => {
      const node = await keptKill();
      expect((await rowOf()).desiredState).toBeNull();

      await node.queue.flush();

      expect((await rowOf()).desiredState).toBe('stopped');
    });

    it('of a force-kill survives a restart before the database answers, so auto-start leaves the session down', async () => {
      crash(await keptKill());

      const next = await restart();

      expect((await rowOf()).desiredState).toBe('stopped');
      expect(next.factory.create).not.toHaveBeenCalled();
    });

    it("is honoured by a start other than an operator's before it lands", async () => {
      const node = await keptKill();

      await expect(node.service.start(id)).rejects.toThrow('was stopped');

      expect(node.factory.create).toHaveBeenCalledTimes(1);
    });

    it("gives way to an operator's start sent after it", async () => {
      const node = await keptKill();
      await node.service.start(id, { explicit: true });

      await node.queue.flush();

      expect((await rowOf()).desiredState).toBeNull();
      expect(node.registry.has(id)).toBe(true);
    });

    it('gives way to another node that took the session since', async () => {
      const node = await keptKill({ nodeId: 'node-a' });
      await sessions.update(id, { nodeId: 'node-b', leaseExpiresAt: new Date(Date.now() + 60_000) });

      await node.queue.flush();

      expect((await rowOf()).desiredState).toBeNull();
    });

    it('of a force-kill lands after the kill handed the claim back', async () => {
      const node = await keptKill({ nodeId: 'node-a' });
      expect((await rowOf()).nodeId).toBeNull();

      await node.queue.flush();

      expect((await rowOf()).desiredState).toBe('stopped');
    });

    it('holds back no other kept write while a delete of its session runs on this node', async () => {
      const other = (
        await sessions.save(sessions.create({ name: 'other', status: SessionStatus.DISCONNECTED, config: {} }))
      ).id;
      const node = await keptKill();
      await node.lifecycle.updateStatus(other, SessionStatus.INITIALIZING);
      // The database still refuses: a pass finds it so, and from then on the queue tries one record first.
      refuse = () => unavailable();
      await expect(node.lifecycle.updateStatus(other, SessionStatus.FAILED)).rejects.toThrow('disk I/O error');
      await node.queue.flush();
      const endDelete = node.lifecycle.holdDelete(id);
      refuse = undefined;

      await node.queue.flush();
      endDelete();

      expect((await sessions.findOneByOrFail({ id: other })).status).toBe(SessionStatus.FAILED);
      expect((await rowOf()).desiredState).toBe('stopped');
    });

    it('that a stop landing during a start re-records is written once the database answers', async () => {
      // An explicit start clears the stop it read just after a new stop wrote the same record, erasing it.
      await sessions.update(id, { desiredState: 'stopped' });
      const node = boot();
      let stopping: Promise<unknown> | undefined;
      beforeWrite = async patch => {
        if (stopping || patch.desiredState !== null) return;
        stopping = node.service.stop(id);
        await stopping;
        refuse = next => (next.desiredState === 'stopped' ? unavailable() : undefined);
      };

      await node.service.start(id, { explicit: true });
      beforeWrite = undefined;
      refuse = undefined;
      expect((await rowOf()).desiredState).toBeNull();
      await node.queue.flush();

      expect((await rowOf()).desiredState).toBe('stopped');
      expect(node.registry.has(id)).toBe(false);
    });

    it('cleared after a failed delete, refused, is taken over by the next delete of the session', async () => {
      const node = boot();
      const fences = (node.lifecycle as unknown as { fences: { awaitPendingTeardown(name: string): Promise<void> } })
        .fences;
      jest
        .spyOn(fences, 'awaitPendingTeardown')
        .mockRejectedValueOnce(new Error('a logout teardown is pending'))
        .mockRejectedValueOnce(new Error('a logout teardown is pending'));
      refuse = patch => (patch.desiredState === null ? unavailable() : undefined);
      await expect(node.service.delete(id)).rejects.toThrow('a logout teardown is pending');
      refuse = undefined;

      await expect(node.service.delete(id)).rejects.toThrow('a logout teardown is pending');

      expect((await rowOf()).desiredState).toBeNull();
      expect([...node.queue.records('session')]).toHaveLength(0);
    });

    it('cleared after a delete that failed before removing anything is written once the database answers', async () => {
      const node = boot();
      const fences = (node.lifecycle as unknown as { fences: { awaitPendingTeardown(name: string): Promise<void> } })
        .fences;
      jest.spyOn(fences, 'awaitPendingTeardown').mockRejectedValueOnce(new Error('a logout teardown is pending'));
      refuse = patch => (patch.desiredState === null ? unavailable() : undefined);

      await expect(node.service.delete(id)).rejects.toThrow('a logout teardown is pending');
      refuse = undefined;
      expect((await rowOf()).desiredState).toBe('deleting');
      await node.queue.flush();

      expect((await rowOf()).desiredState).toBeNull();
    });

    it('is given up with its own loss action', async () => {
      const node = await keptKill();
      refuse = patch => ('desiredState' in patch ? rejected() : undefined);

      for (let pass = 0; pass < 3; pass++) await node.queue.flush();

      expect((await rowOf()).desiredState).toBeNull();
      expect(logged()).toHaveBeenCalledWith(
        expect.any(String),
        undefined,
        expect.objectContaining({ sessionId: id, reason: 'failures', action: 'session_stop_write_lost' }),
      );
    });
  });
});
