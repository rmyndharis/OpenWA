import { Test } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
import { SessionStoppedException } from './session-engine-controls';
import { ConfigService } from '@nestjs/config';
import { SessionService } from './session.service';
import { SessionEngineLifecycle, type ReconnectState } from './session-engine-lifecycle.service';
import { SessionErrorStore } from './session-error-store.service';
import { SessionRestrictionStore } from './session-restriction-store.service';
import { PresenceStore } from './presence-store.service';
import { Session, SessionStatus } from './entities/session.entity';
import { Message } from '../message/entities/message.entity';
import { EngineFactory } from '../../engine/engine.factory';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { SessionLidResolver } from './session-lid-resolver.service';
import { SessionLivenessWatchdog } from './session-liveness-watchdog.service';
import { MessageProjector } from './message-projector.service';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { EventsGateway } from '../events/events.gateway';
import { WebhookService } from '../webhook/webhook.service';
import { HookManager } from '../../core/hooks';
import { StatusStoreService } from '../status-store/status-store.service';
import {
  EngineStatus,
  type EngineEventCallbacks,
  type IWhatsAppEngine,
} from '../../engine/interfaces/whatsapp-engine.interface';

const ID = 'sess-uuid-1';
const NAME = 'test-session';

const session = (overrides: Partial<Session> = {}): Session => ({
  id: ID,
  name: NAME,
  status: SessionStatus.CREATED,
  phone: null,
  pushName: null,
  config: {},
  proxyUrl: null,
  proxyType: null,
  connectedAt: null,
  lastActiveAt: null,
  nodeId: null,
  claimedAt: null,
  leaseExpiresAt: null,
  desiredState: null,
  nodeUrl: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const makeEngine = (): Record<string, jest.Mock> => ({
  initialize: jest.fn().mockResolvedValue(undefined),
  destroy: jest.fn().mockResolvedValue(undefined),
  forceDestroy: jest.fn().mockResolvedValue(undefined),
  disconnect: jest.fn().mockResolvedValue(undefined),
  logout: jest.fn().mockResolvedValue(undefined),
  getQRCode: jest.fn().mockReturnValue(null),
});

/** A promise the test settles by hand. */
const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
};

interface Internals {
  engines: EngineRegistry;
  controls: { reapRetiredEngine(id: string, engine: IWhatsAppEngine): Promise<void> };
  stoppingSessions: Set<string>;
  reconnectStates: Map<string, ReconnectState>;
  logger: { warn: (...args: unknown[]) => void };
  executeReconnect(id: string, session: Session, state: ReconnectState): Promise<void>;
  scheduleReconnect(id: string, session: Session): void;
  handleEngineReady(id: string, engine: unknown, phone: string, pushName: string): void;
  rejectRebind(id: string, engine: unknown, name: string, previous: string, incoming: string): Promise<void>;
}

describe('SessionEngineLifecycle races', () => {
  let lifecycle: SessionEngineLifecycle;
  let internals: Internals;
  let repository: { findOne: jest.Mock; update: jest.Mock; exists: jest.Mock };
  let engineFactory: { create: jest.Mock; purgeSessionData: jest.Mock };
  let webhookService: { dispatch: jest.Mock };
  let config: Record<string, unknown>;
  let dataSource: Record<string, unknown>;
  let hookManager: { execute: jest.Mock };

  beforeEach(async () => {
    config = {};
    dataSource = {};
    hookManager = { execute: jest.fn().mockResolvedValue({ continue: true, data: {} }) };
    repository = {
      findOne: jest.fn().mockResolvedValue(session()),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      exists: jest.fn().mockResolvedValue(false),
    };
    engineFactory = {
      create: jest.fn().mockImplementation(() => makeEngine()),
      purgeSessionData: jest.fn().mockResolvedValue(undefined),
    };
    const module = await Test.createTestingModule({
      providers: [
        SessionService,
        SessionEngineLifecycle,
        SessionErrorStore,
        SessionRestrictionStore,
        PresenceStore,
        { provide: getRepositoryToken(Session, 'data'), useValue: repository },
        { provide: getRepositoryToken(Message, 'data'), useValue: { find: jest.fn().mockResolvedValue([]) } },
        { provide: getDataSourceToken('data'), useValue: dataSource },
        { provide: EngineFactory, useValue: engineFactory },
        EngineRegistry,
        SessionLidResolver,
        SessionLivenessWatchdog,
        MessageProjector,
        {
          provide: EventsGateway,
          useValue: {
            emitSessionStatus: jest.fn(),
            emitSessionDisconnected: jest.fn(),
            emitQRCode: jest.fn(),
            emitSessionAuthenticated: jest.fn(),
          },
        },
        { provide: WebhookService, useValue: { dispatch: jest.fn().mockResolvedValue(undefined) } },
        { provide: HookManager, useValue: hookManager },
        {
          provide: ConfigService,
          useValue: { get: jest.fn(<T>(key: string, def?: T): T => (key in config ? (config[key] as T) : (def as T))) },
        },
        { provide: LidMappingStoreService, useValue: { remember: jest.fn(), onSecondLid: jest.fn() } },
        { provide: StatusStoreService, useValue: { ingest: jest.fn() } },
      ],
    }).compile();
    lifecycle = module.get(SessionEngineLifecycle);
    internals = lifecycle as unknown as Internals;
    webhookService = module.get(WebhookService);
  });

  afterEach(() => {
    for (const state of internals.reconnectStates.values()) if (state.timer) clearTimeout(state.timer);
  });

  describe('MAX_CONCURRENT_SESSIONS', () => {
    it('counts a session waiting out a failed relaunch, which holds no engine', async () => {
      config['sessions.maxConcurrent'] = 1;
      const timer = setTimeout(() => undefined, 60_000);
      internals.reconnectStates.set('other', { attempts: 1, timer, maxAttempts: 5, baseDelay: 5000 });

      await expect(lifecycle.start(ID)).rejects.toThrow(
        new BadRequestException('Maximum concurrent sessions reached (1)'),
      );
      expect(engineFactory.create).not.toHaveBeenCalled();
    });

    it('does not count the reconnect state of the session being started', async () => {
      config['sessions.maxConcurrent'] = 1;
      const timer = setTimeout(() => undefined, 60_000);
      internals.reconnectStates.set(ID, { attempts: 1, timer, maxAttempts: 5, baseDelay: 5000 });

      await lifecycle.start(ID);

      expect(internals.engines.has(ID)).toBe(true);
    });
  });

  describe('stopOrphanEngines against a start still reading its row', () => {
    it('retires the start instead of letting it clear the stop mark', async () => {
      const read = deferred<Session>();
      repository.findOne.mockReturnValueOnce(read.promise);

      const starting = lifecycle.start(ID);
      const outcome = starting.then(
        () => undefined,
        (e: unknown) => e,
      );
      await flush();
      await expect(lifecycle.stopOrphanEngines([ID])).resolves.toEqual({
        stopped: [],
        notRunning: [ID],
        failed: [],
      });
      read.resolve(session());

      expect(await outcome).toBeInstanceOf(SessionStoppedException);
      expect(engineFactory.create).not.toHaveBeenCalled();
      expect(internals.engines.has(ID)).toBe(false);
    });

    it('still clears a stop mark left from before the start began', async () => {
      await lifecycle.stopOrphanEngines([ID]);

      await lifecycle.start(ID);

      expect(internals.engines.has(ID)).toBe(true);
    });

    it('retires the start when an older stop mark was already present', async () => {
      await lifecycle.stopOrphanEngines([ID]);
      const read = deferred<Session>();
      repository.findOne.mockReturnValueOnce(read.promise);

      const outcome = lifecycle.start(ID).then(
        () => undefined,
        (e: unknown) => e,
      );
      await flush();
      await expect(lifecycle.stopOrphanEngines([ID])).resolves.toEqual({
        stopped: [],
        notRunning: [ID],
        failed: [],
      });
      read.resolve(session());

      expect(await outcome).toBeInstanceOf(SessionStoppedException);
      expect(engineFactory.create).not.toHaveBeenCalled();
    });
  });

  // A delete removes the rows of a session with a long history in many batches, long after its engine is gone.
  // The stop mark it set cannot refuse a start for that long: start() takes a mark that was already there when
  // it began for a stale one and clears it, which for the mark of a delete left an engine running on the
  // deleted session.
  describe('start against a delete in flight', () => {
    type Gate = { promise: Promise<unknown[]>; resolve: (rows: unknown[]) => void };
    let gates: Gate[];
    let transaction: jest.Mock;

    // The next delete to look up rows waits here, which is where a delete spends its time on a long history.
    const hold = (): Gate => {
      const gate = deferred<unknown[]>();
      gates.push(gate);
      return gate;
    };

    // What the delete ended with: nothing, or its error.
    const settle = (deleting: Promise<void>): Promise<unknown> =>
      deleting.then(
        () => undefined,
        (e: unknown) => e,
      );

    // Starts a delete and leaves it waiting on its first batch, after it evicted the engine of a running session.
    const deleteInBatchPhase = async (): Promise<{ gate: Gate; settled: Promise<unknown> }> => {
      await lifecycle.start(ID);
      const gate = hold();
      const settled = settle(lifecycle.delete(ID));
      await flush();
      expect(internals.engines.has(ID)).toBe(false);
      return { gate, settled };
    };

    beforeEach(() => {
      gates = [];
      const read = jest.fn(() => gates.shift()?.promise ?? Promise.resolve([]));
      // The messages of a session are read through a query builder: every chain call returns itself.
      const query: Record<string, jest.Mock> = { getRawMany: read };
      for (const name of ['select', 'addSelect', 'where', 'andWhere', 'orderBy', 'addOrderBy', 'limit']) {
        query[name] = jest.fn().mockReturnValue(query);
      }
      const rows = { find: read, createQueryBuilder: jest.fn(() => query), delete: jest.fn() };
      const manager = { delete: jest.fn().mockResolvedValue({ affected: 0 }), remove: jest.fn() };
      transaction = jest.fn((work: (m: unknown) => Promise<void>) => work(manager));
      Object.assign(dataSource, {
        options: { type: 'better-sqlite3' },
        getRepository: jest.fn(() => rows),
        transaction,
      });
    });

    it.each([
      ['an operator start', { explicit: true }],
      ['a boot or takeover start', { explicit: false }],
    ])('refuses %s and registers no engine', async (_who, options) => {
      const { gate, settled } = await deleteInBatchPhase();

      await expect(lifecycle.start(ID, options)).rejects.toBeInstanceOf(SessionStoppedException);

      expect(engineFactory.create).toHaveBeenCalledTimes(1);
      expect(internals.engines.has(ID)).toBe(false);
      gate.resolve([]);
      expect(await settled).toBeUndefined();
      expect(internals.engines.has(ID)).toBe(false);
    });

    it('leaves the stop mark of the delete in place for the whole delete', async () => {
      const { gate, settled } = await deleteInBatchPhase();

      await expect(lifecycle.start(ID)).rejects.toBeInstanceOf(SessionStoppedException);

      expect(internals.stoppingSessions.has(ID)).toBe(true);
      gate.resolve([]);
      await settled;
      expect(internals.stoppingSessions.has(ID)).toBe(false);
    });

    it('counts the delete as live until the rows are gone, so the lease of the session is renewed', async () => {
      expect(lifecycle.isEngineActive(ID)).toBe(false);
      const { gate, settled } = await deleteInBatchPhase();

      // The engine is evicted and nothing is starting or reconnecting: only the delete is left.
      expect(lifecycle.isEngineActive(ID)).toBe(true);

      gate.resolve([]);
      await settled;
      expect(lifecycle.isEngineActive(ID)).toBe(false);
    });

    it('lets the session start again when the delete failed', async () => {
      transaction.mockRejectedValueOnce(new Error('canceling statement due to statement timeout'));
      const { gate, settled } = await deleteInBatchPhase();

      gate.resolve([]);
      expect(((await settled) as Error).message).toContain('statement timeout');
      expect(lifecycle.isEngineActive(ID)).toBe(false);

      await lifecycle.start(ID, { explicit: true });

      expect(internals.engines.has(ID)).toBe(true);
    });

    it('holds back a start until the last of two overlapping deletes ends', async () => {
      transaction.mockRejectedValueOnce(new Error('canceling statement due to statement timeout'));
      const first = await deleteInBatchPhase();
      const secondGate = hold();
      const second = settle(lifecycle.delete(ID));
      await flush();

      // The first delete fails and drops the stop mark the second one is still running under.
      first.gate.resolve([]);
      expect(((await first.settled) as Error).message).toContain('statement timeout');
      await expect(lifecycle.start(ID)).rejects.toBeInstanceOf(SessionStoppedException);
      expect(internals.engines.has(ID)).toBe(false);

      secondGate.resolve([]);
      expect(await second).toBeUndefined();
      await lifecycle.start(ID);
      expect(internals.engines.has(ID)).toBe(true);
    });

    it('retires a start whose row read was still pending when the delete began', async () => {
      const read = deferred<Session>();
      repository.findOne.mockReturnValueOnce(read.promise);
      const starting = lifecycle.start(ID, { explicit: true }).then(
        () => undefined,
        (e: unknown) => e,
      );
      await flush();
      const gate = hold();
      const settled = settle(lifecycle.delete(ID));
      await flush();

      read.resolve(session());

      expect(await starting).toBeInstanceOf(SessionStoppedException);
      expect(engineFactory.create).not.toHaveBeenCalled();
      gate.resolve([]);
      await settled;
      expect(internals.engines.has(ID)).toBe(false);
    });

    // A start waiting in its session:starting hook has armed no reconnect state yet, so the stop or delete that
    // retires it has nothing to cancel. The start arms the state afterwards and must drop it when it is retired.
    describe('a start retired while it waits in its session:starting hook', () => {
      const parkInHook = async (): Promise<{ release: () => void; outcome: Promise<unknown> }> => {
        const hook = deferred();
        hookManager.execute.mockImplementation(async (event: string) => {
          if (event === 'session:starting') await hook.promise;
          return { continue: true, data: {} };
        });
        const outcome = lifecycle.start(ID, { explicit: true }).then(
          () => undefined,
          (e: unknown) => e,
        );
        await flush();
        expect(internals.reconnectStates.has(ID)).toBe(false);
        return { release: hook.resolve, outcome };
      };

      it('leaves no reconnect state behind after a stop', async () => {
        const { release, outcome } = await parkInHook();
        await lifecycle.stop(ID);

        release();
        await outcome;

        expect(internals.engines.has(ID)).toBe(false);
        expect(internals.reconnectStates.has(ID)).toBe(false);
      });

      it('leaves no reconnect state behind after a delete that is still running', async () => {
        const { release, outcome } = await parkInHook();
        const gate = hold();
        const deleted = settle(lifecycle.delete(ID));
        await flush();

        release();
        await outcome;

        expect(internals.engines.has(ID)).toBe(false);
        expect(internals.reconnectStates.has(ID)).toBe(false);
        gate.resolve([]);
        await deleted;
      });

      it('leaves no reconnect state behind after a delete that has finished', async () => {
        const { release, outcome } = await parkInHook();
        await settle(lifecycle.delete(ID));
        repository.findOne.mockResolvedValue(null);

        release();
        await outcome;

        expect(internals.engines.has(ID)).toBe(false);
        expect(internals.reconnectStates.has(ID)).toBe(false);
      });

      it('keeps the state of an engine that registered while the retired one was torn down', async () => {
        const destroyed = deferred();
        const retired = { ...makeEngine(), destroy: jest.fn().mockReturnValue(destroyed.promise) };
        const replacement = makeEngine();
        const state: ReconnectState = { attempts: 0, timer: null, maxAttempts: 5, baseDelay: 5000 };
        internals.engines.set(ID, retired as never);

        const reaping = internals.controls.reapRetiredEngine(ID, retired as never);
        await flush();
        internals.engines.set(ID, replacement as never);
        internals.reconnectStates.set(ID, state);
        destroyed.resolve();
        await reaping;

        expect(internals.engines.get(ID)).toBe(replacement);
        expect(internals.reconnectStates.get(ID)).toBe(state);
      });
    });
  });

  describe('stop against an explicit start still reading its row', () => {
    it('yields to a stop that lands while it waits, after an earlier stop', async () => {
      repository.findOne.mockResolvedValue(session({ desiredState: 'stopped' }));
      await lifecycle.stop(ID);
      const read = deferred<Session>();
      repository.findOne.mockReturnValueOnce(read.promise);

      const outcome = lifecycle.start(ID, { explicit: true }).then(
        () => undefined,
        (e: unknown) => e,
      );
      await flush();
      await lifecycle.stop(ID);
      read.resolve(session({ desiredState: 'stopped' }));

      expect(await outcome).toBeInstanceOf(SessionStoppedException);
      expect(internals.engines.has(ID)).toBe(false);
    });
  });

  describe('rejectRebind', () => {
    const failedWrites = (): number =>
      repository.update.mock.calls.filter(
        ([, patch]) => (patch as { status?: unknown }).status === SessionStatus.FAILED,
      ).length;

    it("retires the refused account's engine before its logout runs", async () => {
      const logout = deferred();
      const engine = { ...makeEngine(), logout: jest.fn().mockReturnValue(logout.promise) };
      internals.engines.set(ID, engine as never);

      const rejecting = internals.rejectRebind(ID, engine, NAME, '628111', '628999');
      await flush();

      // Every inbound callback is gated on this, so nothing the refused account sends while the
      // logout runs is stored or dispatched under this session.
      expect(engine.logout).toHaveBeenCalledTimes(1);
      expect(internals.engines.isLive(ID, engine as never)).toBe(false);

      logout.resolve();
      await rejecting;
      expect(failedWrites()).toBe(1);
    });

    it('leaves a start that registered an engine during the logout alone', async () => {
      const logout = deferred();
      const engine = { ...makeEngine(), logout: jest.fn().mockReturnValue(logout.promise) };
      const replacement = makeEngine();
      internals.engines.set(ID, engine as never);

      const rejecting = internals.rejectRebind(ID, engine, NAME, '628111', '628999');
      await flush();
      internals.engines.set(ID, replacement as never);
      logout.resolve();
      await rejecting;

      expect(internals.engines.get(ID)).toBe(replacement);
      expect(failedWrites()).toBe(0);
    });
  });

  describe('stop hooks', () => {
    it('records the stop after the session read and before the teardown', async () => {
      await lifecycle.start(ID);
      const engine = (engineFactory.create.mock.results[0] as { value: Record<string, jest.Mock> }).value;
      const order: string[] = [];
      repository.findOne.mockImplementationOnce(() => {
        order.push('read');
        return Promise.resolve(session());
      });
      engine.disconnect.mockImplementation(() => {
        order.push('teardown');
        return Promise.resolve();
      });

      await lifecycle.stop(ID, {
        afterRead: () => {
          order.push('record');
          return Promise.resolve();
        },
      });

      expect(order).toEqual(['read', 'record', 'teardown']);
    });

    it('takes nothing down when recording the stop fails', async () => {
      await lifecycle.start(ID);
      const engine = (engineFactory.create.mock.results[0] as { value: Record<string, jest.Mock> }).value;

      await expect(lifecycle.stop(ID, { afterRead: () => Promise.reject(new Error('SQLITE_BUSY')) })).rejects.toThrow(
        'SQLITE_BUSY',
      );

      expect(engine.disconnect).not.toHaveBeenCalled();
      expect(internals.engines.has(ID)).toBe(true);
    });

    it.each([
      [
        'stop',
        (onReadFailed: () => void, afterRead: () => Promise<void>) => lifecycle.stop(ID, { afterRead, onReadFailed }),
      ],
      ['delete', (onReadFailed: () => void) => lifecycle.delete(ID, { onReadFailed })],
    ])('%s() reports a failed session read and records nothing', async (_verb, call) => {
      const onReadFailed = jest.fn();
      const afterRead = jest.fn().mockResolvedValue(undefined);
      repository.findOne.mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));

      await expect(call(onReadFailed, afterRead)).rejects.toThrow('Connection terminated unexpectedly');

      expect(onReadFailed).toHaveBeenCalledTimes(1);
      expect(afterRead).not.toHaveBeenCalled();
    });
  });

  describe('engine-driven status writes', () => {
    const rejectStatus = (status: SessionStatus): void => {
      repository.update.mockImplementation((_id: unknown, patch: { status?: unknown }) =>
        patch.status === status ? Promise.reject(new Error('SQLITE_BUSY')) : Promise.resolve({ affected: 1 }),
      );
    };

    it('logs a failed DISCONNECTED write instead of leaving it unhandled', async () => {
      const warn = jest.spyOn(internals.logger, 'warn');
      rejectStatus(SessionStatus.DISCONNECTED);
      const engine = makeEngine();
      internals.engines.set(ID, engine as never);

      await lifecycle.handleEngineDisconnected(ID, engine as never, 'NAVIGATION');
      await flush();

      expect(warn).toHaveBeenCalledWith('Failed to persist the disconnected status', {
        sessionId: ID,
        error: 'SQLITE_BUSY',
      });
    });

    it('logs a failed write of a status the engine reported', async () => {
      const warn = jest.spyOn(internals.logger, 'warn');
      await lifecycle.start(ID);
      const engine = (engineFactory.create.mock.results[0] as { value: Record<string, jest.Mock> }).value;
      const callbacks = (engine.initialize.mock.calls as [EngineEventCallbacks][])[0][0];
      rejectStatus(SessionStatus.AUTHENTICATING);

      callbacks.onStateChanged?.(EngineStatus.AUTHENTICATING);
      await flush();

      expect(warn).toHaveBeenCalledWith('Failed to persist an engine status', {
        sessionId: ID,
        status: SessionStatus.AUTHENTICATING,
        error: 'SQLITE_BUSY',
      });
    });

    it('logs a failed FAILED write when reconnect attempts run out', async () => {
      const warn = jest.spyOn(internals.logger, 'warn');
      rejectStatus(SessionStatus.FAILED);
      internals.reconnectStates.set(ID, { attempts: 5, timer: null, maxAttempts: 5, baseDelay: 5000 });

      internals.scheduleReconnect(ID, session());
      await flush();

      expect(warn).toHaveBeenCalledWith('Failed to persist the reconnect-exhausted FAILED state', {
        sessionId: ID,
        error: 'SQLITE_BUSY',
      });
    });
  });

  // The engine reports DISCONNECTED itself, so the liveness watchdog never probes it again, and it stays
  // registered with its lease renewed: a disconnect whose row read fails once is not handled again by anything.
  describe('a disconnect whose session read fails', () => {
    afterEach(() => jest.useRealTimers());

    const disconnectWithFailedRead = async (): Promise<{
      engine: Record<string, jest.Mock>;
      state: ReconnectState;
    }> => {
      await lifecycle.start(ID);
      const engine = (engineFactory.create.mock.results[0] as { value: Record<string, jest.Mock> }).value;
      const callbacks = (engine.initialize.mock.calls as [EngineEventCallbacks][])[0][0];
      const state = internals.reconnectStates.get(ID)!;
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
      repository.findOne.mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));

      callbacks.onDisconnected?.('NAVIGATION');
      await flush();
      return { engine, state };
    };

    it('handles the disconnect again, so a reconnect is armed once the read succeeds', async () => {
      const { engine, state } = await disconnectWithFailedRead();
      expect(state.attempts).toBe(0);
      expect(state.timer).not.toBeNull();

      jest.advanceTimersByTime(state.baseDelay);
      await flush();

      expect(state.attempts).toBe(1);
      expect(state.timer).not.toBeNull();
      expect(internals.engines.get(ID)).toBe(engine);
    });

    it('waits longer after each failed read, up to the reconnect backoff cap', async () => {
      const { state } = await disconnectWithFailedRead();
      repository.findOne.mockRejectedValue(new Error('SQLITE_BUSY: database is locked'));
      const base = state.baseDelay;
      const before = repository.findOne.mock.calls.length;
      const readsAfter = async (ms: number): Promise<number> => {
        jest.advanceTimersByTime(ms);
        await flush();
        return repository.findOne.mock.calls.length - before;
      };

      expect(await readsAfter(base)).toBe(1);
      expect(await readsAfter(2 * base - 1)).toBe(1);
      expect(await readsAfter(1)).toBe(2);
      expect(await readsAfter(4 * base)).toBe(3);
      expect(await readsAfter(8 * base)).toBe(4);
      expect(await readsAfter(16 * base)).toBe(5);
      expect(await readsAfter(32 * base)).toBe(6);
      // The next wait would be 64 times the base delay, past the 5-minute cap the reconnect backoff keeps.
      expect(await readsAfter(300_000)).toBe(7);
    });

    it('starts the backoff over once the session reaches READY', async () => {
      const { engine, state } = await disconnectWithFailedRead();
      repository.findOne.mockRejectedValue(new Error('SQLITE_BUSY: database is locked'));
      jest.advanceTimersByTime(state.baseDelay);
      await flush();
      jest.advanceTimersByTime(2 * state.baseDelay);
      await flush();
      internals.handleEngineReady(ID, engine, '628111', 'Push');
      await flush();
      expect(state.timer).toBeNull();

      const callbacks = (engine.initialize.mock.calls as [EngineEventCallbacks][])[0][0];
      const before = repository.findOne.mock.calls.length;
      callbacks.onDisconnected?.('NAVIGATION');
      await flush();
      expect(repository.findOne.mock.calls.length - before).toBe(1);

      jest.advanceTimersByTime(state.baseDelay);
      await flush();
      expect(repository.findOne.mock.calls.length - before).toBe(2);
    });

    it('drops the pending retry when another report of the same disconnect reads the row', async () => {
      const { engine, state } = await disconnectWithFailedRead();
      const retry = state.timer;
      expect(retry).not.toBeNull();
      const published = (): number =>
        webhookService.dispatch.mock.calls.filter(([, event]) => event === 'session.disconnected').length;

      await lifecycle.handleEngineDisconnected(ID, engine as unknown as IWhatsAppEngine, 'NAVIGATION');
      await flush();

      // The reconnect was armed by this report, in place of the retry, which would publish it again.
      expect(published()).toBe(1);
      expect(state.attempts).toBe(1);
      expect(state.timer).not.toBeNull();
      expect(state.timer).not.toBe(retry);
    });

    it('does not read again once a stop has retired the engine', async () => {
      const { state } = await disconnectWithFailedRead();
      await lifecycle.stop(ID);
      const reads = repository.findOne.mock.calls.length;

      jest.advanceTimersByTime(state.baseDelay * 2);
      await flush();

      expect(repository.findOne.mock.calls.length).toBe(reads);
      expect(internals.reconnectStates.has(ID)).toBe(false);
    });
  });

  describe('a reconnect attempt failing while the next one tears its engine down', () => {
    it.each(['older first', 'later first'])(
      'launches only the latest attempt when teardown finishes %s',
      async order => {
        const state: ReconnectState = { attempts: 2, timer: null, maxAttempts: 5, baseDelay: 5000 };
        internals.reconnectStates.set(ID, state);
        const olderDestroy = deferred();
        const laterDestroy = deferred();
        const oldEngine = {
          ...makeEngine(),
          destroy: jest.fn().mockReturnValueOnce(olderDestroy.promise).mockReturnValueOnce(laterDestroy.promise),
        };
        internals.engines.set(ID, oldEngine as unknown as IWhatsAppEngine);
        const older = internals.executeReconnect(ID, session(), state);
        await flush();
        const later = internals.executeReconnect(ID, session(), state);
        await flush();
        try {
          if (order === 'older first') {
            olderDestroy.resolve();
            await older;
            laterDestroy.resolve();
            await later;
          } else {
            laterDestroy.resolve();
            await later;
            olderDestroy.resolve();
            await older;
          }
          expect(engineFactory.create).toHaveBeenCalledTimes(1);
          const replacement = engineFactory.create.mock.results[0].value as Record<string, jest.Mock>;
          expect(internals.engines.get(ID)).toBe(replacement);
          expect(replacement.destroy).not.toHaveBeenCalled();
          expect(replacement.forceDestroy).not.toHaveBeenCalled();
          expect(state).toMatchObject({ attempts: 2, started: 2, timer: null });
          expect(internals.reconnectStates.get(ID)).toBe(state);
        } finally {
          olderDestroy.resolve();
          laterDestroy.resolve();
          await Promise.allSettled([older, later]);
        }
      },
    );

    it.each(['resolves', 'rejects'])(
      'keeps the later initialization and parked failure when the older one %s',
      async outcome => {
        const state: ReconnectState = { attempts: 2, timer: null, maxAttempts: 5, baseDelay: 5000 };
        internals.reconnectStates.set(ID, state);
        const olderInit = deferred();
        const laterInit = deferred();
        const olderEngine = { ...makeEngine(), initialize: jest.fn().mockReturnValue(olderInit.promise) };
        const laterEngine: Record<string, jest.Mock> = {
          ...makeEngine(),
          initialize: jest.fn().mockReturnValue(laterInit.promise),
        };
        engineFactory.create.mockReturnValueOnce(olderEngine).mockReturnValueOnce(laterEngine);
        const older = internals.executeReconnect(ID, session(), state);
        await flush();
        const later = internals.executeReconnect(ID, session(), state);
        await flush();
        try {
          const callbacks = (laterEngine.initialize.mock.calls as [EngineEventCallbacks][])[0][0];
          callbacks.onError?.('temporary network failure');
          const parked = state.parkedFailure;
          expect(parked).toBeDefined();
          if (outcome === 'resolves') olderInit.resolve();
          else olderInit.reject(new Error('Target closed'));
          await older;
          expect(state.initInFlight).toBe(true);
          expect(state.parkedFailure).toBe(parked);
          expect(internals.engines.get(ID)).toBe(laterEngine);
          expect(laterEngine.destroy).not.toHaveBeenCalled();
          expect(laterEngine.forceDestroy).not.toHaveBeenCalled();
          expect(state).toMatchObject({ attempts: 2, started: 2, timer: null });
        } finally {
          olderInit.resolve();
          laterInit.resolve();
          await Promise.allSettled([older, later]);
        }
      },
    );

    it.each(['removed', 'stopped'])(
      'keeps the replacement when an older retirement read finds the session %s',
      async retired => {
        const state: ReconnectState = { attempts: 2, timer: null, maxAttempts: 5, baseDelay: 5000 };
        internals.reconnectStates.set(ID, state);
        const read = deferred<Session | null>();
        repository.findOne.mockReturnValueOnce(read.promise);
        const olderEngine = makeEngine();
        const laterEngine = makeEngine();
        engineFactory.create.mockReturnValueOnce(olderEngine).mockReturnValueOnce(laterEngine);
        const older = internals.executeReconnect(ID, session(), state);
        await flush();
        const later = internals.executeReconnect(ID, session(), state);
        try {
          await later;
          read.resolve(retired === 'removed' ? null : session({ desiredState: 'stopped' }));
          await older;
          expect(internals.engines.get(ID)).toBe(laterEngine);
          expect(olderEngine.destroy).toHaveBeenCalledTimes(1);
          expect(laterEngine.destroy).not.toHaveBeenCalled();
          expect(laterEngine.forceDestroy).not.toHaveBeenCalled();
          expect(internals.reconnectStates.get(ID)).toBe(state);
          expect(state).toMatchObject({ attempts: 2, started: 2, timer: null });
        } finally {
          read.resolve(session());
          await Promise.allSettled([older, later]);
        }
      },
    );

    it('leaves the episode to the later attempt instead of arming another over it', async () => {
      const state: ReconnectState = { attempts: 1, timer: null, maxAttempts: 5, baseDelay: 5000 };
      internals.reconnectStates.set(ID, state);
      const initA = deferred();
      const destroyA = deferred();
      const engineA = {
        ...makeEngine(),
        initialize: jest.fn().mockReturnValue(initA.promise),
        destroy: jest.fn().mockReturnValue(destroyA.promise),
      };
      const engineB = makeEngine();
      engineFactory.create.mockReturnValueOnce(engineA).mockReturnValueOnce(engineB);

      const attemptA = internals.executeReconnect(ID, session(), state);
      await flush();
      expect(internals.engines.get(ID)).toBe(engineA);

      // Engine A drops mid-init: the next attempt is armed and fires, then waits on A's destroy.
      internals.scheduleReconnect(ID, session());
      clearTimeout(state.timer!);
      state.timer = null;
      const attemptB = internals.executeReconnect(ID, session(), state);
      await flush();

      // Closing A is what makes its pending initialize() reject, before B has registered anything.
      initA.reject(new Error('Target closed'));
      await attemptA;
      expect(state.timer).toBeNull();

      destroyA.resolve();
      await attemptB;
      await flush();

      expect(internals.engines.get(ID)).toBe(engineB);
      expect(state.timer).toBeNull();
      expect(engineFactory.create).toHaveBeenCalledTimes(2);
    });

    // The browser of an attempt dies during its own init: it reports the disconnect while the session
    // read fails once, which arms a read retry on the episode's timer, and the same crash rejects init.
    describe('when the disconnect of its own engine armed a read retry', () => {
      afterEach(() => jest.useRealTimers());

      const crashDuringInit = async (readFails: boolean): Promise<ReconnectState> => {
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
        const state: ReconnectState = {
          attempts: 1,
          timer: null,
          maxAttempts: Number.POSITIVE_INFINITY,
          baseDelay: 5000,
        };
        internals.reconnectStates.set(ID, state);
        const init = deferred();
        const engine = { ...makeEngine(), initialize: jest.fn().mockReturnValue(init.promise) };
        engineFactory.create.mockReturnValueOnce(engine);
        const attempt = internals.executeReconnect(ID, session(), state);
        await flush();
        const callbacks = (engine.initialize.mock.calls as [EngineEventCallbacks][])[0][0];

        if (readFails) repository.findOne.mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));
        callbacks.onDisconnected?.('NAVIGATION');
        await flush();
        init.reject(new Error('Protocol error: Target closed'));
        await attempt;
        await flush();
        return state;
      };

      it('arms the next attempt instead of leaving the session with no engine and no timer', async () => {
        const state = await crashDuringInit(true);

        for (let i = 0; i < 4; i++) {
          jest.advanceTimersByTime(300_000);
          await flush();
        }

        expect(engineFactory.create.mock.calls.length).toBeGreaterThan(1);
        expect(state.readRetry).toBeUndefined();
      });

      it('relaunches the same way when the read answered', async () => {
        await crashDuringInit(false);

        for (let i = 0; i < 4; i++) {
          jest.advanceTimersByTime(300_000);
          await flush();
        }

        expect(engineFactory.create.mock.calls.length).toBeGreaterThan(1);
      });
    });

    it('re-arms when the attempt armed after it was cancelled by a READY before it fired', async () => {
      const state: ReconnectState = { attempts: 1, timer: null, maxAttempts: 5, baseDelay: 5000 };
      internals.reconnectStates.set(ID, state);
      const initA = deferred();
      const engineA = { ...makeEngine(), initialize: jest.fn().mockReturnValue(initA.promise) };
      engineFactory.create.mockReturnValueOnce(engineA);

      const attemptA = internals.executeReconnect(ID, session(), state);
      await flush();
      expect(internals.engines.get(ID)).toBe(engineA);

      // Engine A drops mid-init and arms the next attempt, then reaches READY, which cancels that timer.
      internals.scheduleReconnect(ID, session());
      expect(state.timer).not.toBeNull();
      internals.handleEngineReady(ID, engineA, '628111', 'Push');
      expect(state.timer).toBeNull();

      // A's init still rejects afterwards: nothing else owns the episode, so A must arm a recovery.
      initA.reject(new Error('Engine initialization timed out'));
      await attemptA;

      expect(internals.engines.has(ID)).toBe(false);
      expect(state.timer).not.toBeNull();
    });
  });
});
