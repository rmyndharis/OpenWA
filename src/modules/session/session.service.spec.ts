import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { Repository, DataSource, In } from 'typeorm';
import { NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { SessionService, ACK_RECONCILE_DELAY_MS } from './session.service';
import { Session, SessionStatus } from './entities/session.entity';
import { Message, MessageStatus } from '../message/entities/message.entity';
import { EngineFactory } from '../../engine/engine.factory';
import { EventsGateway } from '../events/events.gateway';
import { WebhookService } from '../webhook/webhook.service';
import { HookManager } from '../../core/hooks';
import { IncomingMessage, EngineEventCallbacks, EngineStatus } from '../../engine/interfaces/whatsapp-engine.interface';
import { BaileysSessionStore } from '../../engine/adapters/baileys-session-store';

function createMockSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-uuid-1',
    name: 'test-session',
    status: SessionStatus.CREATED,
    phone: null,
    pushName: null,
    config: {},
    proxyUrl: null,
    proxyType: null,
    connectedAt: null,
    lastActiveAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('SessionService', () => {
  let service: SessionService;
  let repository: jest.Mocked<Partial<Repository<Session>>>;
  let messageRepository: jest.Mocked<Partial<Repository<Message>>>;
  let dataSource: jest.Mocked<Partial<DataSource>>;
  let engineFactory: jest.Mocked<Partial<EngineFactory>>;
  let eventsGateway: jest.Mocked<Partial<EventsGateway>>;
  let webhookService: jest.Mocked<Partial<WebhookService>>;
  let hookManager: jest.Mocked<Partial<HookManager>>;
  let mockEngine: Record<string, jest.Mock>;

  beforeEach(async () => {
    repository = {
      count: jest.fn(),
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      remove: jest.fn(),
      update: jest.fn(),
    };

    messageRepository = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      save: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    dataSource = {
      transaction: jest.fn().mockImplementation(async (cb: (manager: unknown) => Promise<unknown>) => {
        const manager = {
          save: jest.fn().mockImplementation((entity: unknown) => Promise.resolve(entity)),
          remove: jest.fn().mockResolvedValue(undefined),
        };
        return cb(manager);
      }),
    };

    mockEngine = {
      initialize: jest.fn().mockResolvedValue(undefined),
      destroy: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      getQRCode: jest.fn().mockReturnValue(null),
      getGroups: jest.fn().mockResolvedValue([]),
      getChats: jest.fn().mockResolvedValue([]),
      sendSeen: jest.fn().mockResolvedValue(true),
      markUnread: jest.fn().mockResolvedValue(true),
      deleteChat: jest.fn().mockResolvedValue(true),
      sendChatState: jest.fn().mockResolvedValue(undefined),
      resolveContactPhone: jest.fn().mockResolvedValue('628111222333'),
    };

    engineFactory = {
      create: jest.fn().mockReturnValue(mockEngine),
    };

    eventsGateway = {
      emitSessionStatus: jest.fn(),
      emitMessage: jest.fn(),
      emitMessageSent: jest.fn(),
      emitMessageAck: jest.fn(),
      emitMessageRevoked: jest.fn(),
      emitMessageReaction: jest.fn(),
      emitQRCode: jest.fn(),
    };

    webhookService = {
      dispatch: jest.fn().mockResolvedValue(undefined),
    };

    hookManager = {
      execute: jest.fn().mockResolvedValue({ continue: true, data: {} }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SessionService,
        {
          provide: getRepositoryToken(Session, 'data'),
          useValue: repository,
        },
        {
          provide: getRepositoryToken(Message, 'data'),
          useValue: messageRepository,
        },
        {
          provide: getDataSourceToken('data'),
          useValue: dataSource,
        },
        { provide: EngineFactory, useValue: engineFactory },
        { provide: EventsGateway, useValue: eventsGateway },
        { provide: WebhookService, useValue: webhookService },
        { provide: HookManager, useValue: hookManager },
      ],
    }).compile();

    service = module.get<SessionService>(SessionService);
  });

  // ── shutdown ──────────────────────────────────────────────────────

  describe('onModuleDestroy', () => {
    it('destroys every engine even if one destroy() throws, and clears the map', async () => {
      const good = { destroy: jest.fn().mockResolvedValue(undefined) };
      const bad = { destroy: jest.fn().mockRejectedValue(new Error('stuck chromium')) };
      const engines = (service as unknown as { engines: Map<string, unknown> }).engines;
      engines.set('s-good', good);
      engines.set('s-bad', bad);

      await expect(service.onModuleDestroy()).resolves.toBeUndefined();

      expect(good.destroy).toHaveBeenCalledTimes(1);
      expect(bad.destroy).toHaveBeenCalledTimes(1);
      expect(engines.size).toBe(0);
    });
  });

  // ── delete/stop teardown resilience ───────────────────────────────
  describe('teardown resilience', () => {
    const enginesOf = () => (service as unknown as { engines: Map<string, unknown> }).engines;
    const stoppingOf = () => (service as unknown as { stoppingSessions: Set<string> }).stoppingSessions;

    it('delete() completes when engine.destroy() rejects — map reconciled, row removed, stop-mark cleared', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(createMockSession());
      const engine = { destroy: jest.fn().mockRejectedValue(new Error('stuck chromium')) };
      enginesOf().set('sess-uuid-1', engine);

      await expect(service.delete('sess-uuid-1')).resolves.toBeUndefined();

      expect(engine.destroy).toHaveBeenCalledTimes(1);
      expect(enginesOf().has('sess-uuid-1')).toBe(false); // Map reconciled despite the failure
      expect(stoppingOf().has('sess-uuid-1')).toBe(false); // stop-mark cleared (no wedge)
      expect(hookManager.execute).toHaveBeenCalledWith('session:deleted', expect.anything(), expect.anything());
      expect(dataSource.transaction).toHaveBeenCalled(); // DB removal still ran
    });

    it('stop() completes when engine.disconnect() rejects — map reconciled, status updated', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(createMockSession());
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });
      const engine = { disconnect: jest.fn().mockRejectedValue(new Error('stuck socket')) };
      enginesOf().set('sess-uuid-1', engine);

      await expect(service.stop('sess-uuid-1')).resolves.toBeDefined();

      expect(engine.disconnect).toHaveBeenCalledTimes(1);
      expect(enginesOf().has('sess-uuid-1')).toBe(false);
    });

    it('delete() still surfaces a real DB-removal failure (engine teardown is best-effort, DB is not)', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(createMockSession());
      (dataSource.transaction as jest.Mock).mockRejectedValueOnce(new Error('db down'));
      enginesOf().set('sess-uuid-1', { destroy: jest.fn().mockResolvedValue(undefined) });

      await expect(service.delete('sess-uuid-1')).rejects.toThrow('db down');
      expect(stoppingOf().has('sess-uuid-1')).toBe(false); // mark still cleared on failure
    });

    it('forceKill() force-destroys the engine, reconciles the map, and marks the session stopping', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(createMockSession());
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });
      const engine = { forceDestroy: jest.fn().mockResolvedValue(undefined) };
      enginesOf().set('sess-uuid-1', engine);

      const result = await service.forceKill('sess-uuid-1');

      expect(engine.forceDestroy).toHaveBeenCalledTimes(1);
      expect(enginesOf().has('sess-uuid-1')).toBe(false); // map reconciled
      // Stop-mark stays set (like stop()): it blocks an in-flight reconnect from resurrecting the
      // session we just killed; a later start() clears it.
      expect(stoppingOf().has('sess-uuid-1')).toBe(true);
      expect(result).toBeDefined();
    });

    it('forceKill() completes even when forceDestroy() rejects (best-effort recovery)', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(createMockSession());
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });
      const engine = { forceDestroy: jest.fn().mockRejectedValue(new Error('still wedged')) };
      enginesOf().set('sess-uuid-1', engine);

      await expect(service.forceKill('sess-uuid-1')).resolves.toBeDefined();
      expect(enginesOf().has('sess-uuid-1')).toBe(false); // map reconciled despite the failure
    });

    it('forceKill() throws NotFoundException for an unknown session', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(null);
      await expect(service.forceKill('nope')).rejects.toThrow(NotFoundException);
    });
  });

  // ── create ────────────────────────────────────────────────────────

  describe('create', () => {
    it('should create a new session with CREATED status', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(null); // no duplicate
      (repository.create as jest.Mock).mockReturnValue(session);
      (repository.save as jest.Mock).mockResolvedValue(session);

      const result = await service.create({ name: 'test-session' });

      expect(result.name).toBe('test-session');
      expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ status: SessionStatus.CREATED }));
      expect(hookManager.execute).toHaveBeenCalledWith(
        'session:created',
        session,
        expect.objectContaining({ sessionId: session.id }),
      );
    });

    it('should throw ConflictException if session name already exists', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(createMockSession());

      await expect(service.create({ name: 'test-session' })).rejects.toThrow(ConflictException);
    });
  });

  // ── findAll / findOne / findByName ────────────────────────────────

  describe('findAll', () => {
    it('should return all sessions ordered by createdAt DESC', async () => {
      const sessions = [createMockSession(), createMockSession({ id: 'sess-2' })];
      (repository.find as jest.Mock).mockResolvedValue(sessions);

      const result = await service.findAll();

      expect(result).toHaveLength(2);
      expect(repository.find).toHaveBeenCalledWith({ order: { createdAt: 'DESC' } });
    });

    it('scopes results to a session-restricted key', async () => {
      (repository.find as jest.Mock).mockResolvedValue([]);

      await service.findAll(['sess-1', 'sess-2']);

      expect(repository.find).toHaveBeenCalledWith({
        where: { id: In(['sess-1', 'sess-2']) },
        order: { createdAt: 'DESC' },
      });
    });

    it('returns all sessions for an unrestricted key (null/empty allowlist)', async () => {
      (repository.find as jest.Mock).mockResolvedValue([]);

      await service.findAll(null);
      await service.findAll([]);

      expect(repository.find).toHaveBeenCalledTimes(2);
      expect(repository.find).toHaveBeenNthCalledWith(1, { order: { createdAt: 'DESC' } });
      expect(repository.find).toHaveBeenNthCalledWith(2, { order: { createdAt: 'DESC' } });
    });
  });

  describe('findOne', () => {
    it('should return session by id', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);

      const result = await service.findOne('sess-uuid-1');
      expect(result.id).toBe('sess-uuid-1');
    });

    it('should throw NotFoundException if session not found', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(null);

      await expect(service.findOne('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  // ── start (concurrency) ───────────────────────────────────────────
  describe('start concurrency', () => {
    it('rejects a concurrent second start for the same id, creating only one engine (no orphan)', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(createMockSession());
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });
      (engineFactory.create as jest.Mock).mockClear().mockReturnValue(mockEngine);

      // Two near-simultaneous start() calls for the SAME id. The has()->set() window spans an
      // awaited hook, so without a synchronous reservation both would create an engine and the
      // second set() would orphan the first's Chromium/lock dir.
      const results = await Promise.allSettled([service.start('sess-uuid-1'), service.start('sess-uuid-1')]);

      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.filter(r => r.status === 'rejected');
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(BadRequestException);
      // The decisive assertion: exactly ONE engine was ever created — no orphaned second engine.
      expect(engineFactory.create).toHaveBeenCalledTimes(1);
    });

    it('allows a fresh start after the previous one completed (reservation is cleared)', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(createMockSession());
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });
      (engineFactory.create as jest.Mock).mockClear().mockReturnValue(mockEngine);

      await service.start('sess-uuid-1');
      // Engine is now in the map, so a second start is 'already started' (not wedged at 'starting').
      await expect(service.start('sess-uuid-1')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('findByName', () => {
    it('should return session by name', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);

      const result = await service.findByName('test-session');
      expect(result.name).toBe('test-session');
    });

    it('should throw NotFoundException if name not found', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(null);

      await expect(service.findByName('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  // ── delete ────────────────────────────────────────────────────────

  describe('delete', () => {
    it('should stop engine and remove session from DB', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.remove as jest.Mock).mockResolvedValue(session);

      await service.delete('sess-uuid-1');

      expect(hookManager.execute).toHaveBeenCalledWith(
        'session:deleted',
        expect.objectContaining({ id: 'sess-uuid-1', name: 'test-session' }),
        expect.any(Object),
      );
    });

    it('should destroy running engine before deleting', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.save as jest.Mock).mockImplementation(s => Promise.resolve(s));
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });
      (repository.remove as jest.Mock).mockResolvedValue(session);

      // Start the session first to create an engine
      await service.start('sess-uuid-1');

      // Now delete
      await service.delete('sess-uuid-1');

      expect(mockEngine.destroy).toHaveBeenCalled();
    });
  });

  // ── start ─────────────────────────────────────────────────────────

  describe('start', () => {
    it('should create engine and set status to INITIALIZING', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      await service.start('sess-uuid-1');

      expect(engineFactory.create).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'test-session' }));
      expect(mockEngine.initialize).toHaveBeenCalled();
      expect(repository.update).toHaveBeenCalledWith('sess-uuid-1', {
        status: SessionStatus.INITIALIZING,
      });
    });

    it('should throw BadRequestException if session already started', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      await service.start('sess-uuid-1');

      await expect(service.start('sess-uuid-1')).rejects.toThrow(BadRequestException);
    });

    it('should execute session:starting hook before initializing engine', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      await service.start('sess-uuid-1');

      expect(hookManager.execute).toHaveBeenCalledWith(
        'session:starting',
        expect.objectContaining({ sessionId: 'sess-uuid-1' }),
        expect.any(Object),
      );
    });

    it('persists INITIALIZING before engine.initialize() runs (no post-init clobber) — #219', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      let initializingPersistedBeforeInit = false;
      mockEngine.initialize.mockImplementation(() => {
        initializingPersistedBeforeInit = (repository.update as jest.Mock).mock.calls.some(
          (call: unknown[]) => (call[1] as { status?: SessionStatus })?.status === SessionStatus.INITIALIZING,
        );
        return Promise.resolve();
      });

      await service.start('sess-uuid-1');

      // The engine drives status forward via callbacks during initialize(); writing
      // INITIALIZING afterwards would clobber that progress, so it must be set before.
      expect(initializingPersistedBeforeInit).toBe(true);
      const initializingWrites = (repository.update as jest.Mock).mock.calls.filter(
        (call: unknown[]) => (call[1] as { status?: SessionStatus })?.status === SessionStatus.INITIALIZING,
      );
      expect(initializingWrites).toHaveLength(1);
    });
  });

  // ── engine onError / lastError surfacing (#219) ───────────────────

  describe('reconnect/stop race', () => {
    interface Internals {
      executeReconnect: (id: string, session: Session, state: unknown) => Promise<void>;
      stoppingSessions: Set<string>;
      engines: Map<string, unknown>;
    }
    const internals = (): Internals => service as unknown as Internals;
    const reconnectState = { attempts: 1, timer: null, maxAttempts: 5, baseDelay: 5000 };

    it('does not create an engine when the session was already stopped (early guard)', async () => {
      const i = internals();
      i.stoppingSessions.add('sess-uuid-1');

      await i.executeReconnect('sess-uuid-1', createMockSession(), reconnectState);

      expect(i.engines.has('sess-uuid-1')).toBe(false);
      expect(engineFactory.create).not.toHaveBeenCalled();
    });

    it('tears down an engine created when a stop lands during init (post-init guard)', async () => {
      const i = internals();
      // Simulate a concurrent stop() during engine init: initialize() flips the teardown flag.
      mockEngine.initialize.mockImplementation(() => {
        i.stoppingSessions.add('sess-uuid-1');
        return Promise.resolve();
      });

      await i.executeReconnect('sess-uuid-1', createMockSession(), reconnectState);

      expect(mockEngine.destroy).toHaveBeenCalled();
      expect(i.engines.has('sess-uuid-1')).toBe(false);
    });
  });

  describe('engine onError', () => {
    type EngineCallbacks = { onError?: (reason: string) => void; onReady?: (phone: string, name: string) => void };

    const startAndCapture = async (): Promise<EngineCallbacks> => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });
      let captured: EngineCallbacks = {};
      mockEngine.initialize.mockImplementation((cb: EngineCallbacks) => {
        captured = cb;
        return Promise.resolve();
      });
      await service.start('sess-uuid-1');
      return captured;
    };

    it('marks the session FAILED and runs the session:error hook on a terminal engine error', async () => {
      const callbacks = await startAndCapture();

      callbacks.onError?.('Failed to launch the browser process: spawn ENOENT');

      expect(repository.update).toHaveBeenCalledWith('sess-uuid-1', { status: SessionStatus.FAILED });
      expect(hookManager.execute).toHaveBeenCalledWith(
        'session:error',
        expect.objectContaining({ reason: 'Failed to launch the browser process: spawn ENOENT' }),
        expect.objectContaining({ sessionId: 'sess-uuid-1' }),
      );
    });

    it('surfaces the failure reason via lastError when the session is FAILED', async () => {
      const callbacks = await startAndCapture();
      callbacks.onError?.('chromium missing');

      (repository.findOne as jest.Mock).mockResolvedValue(createMockSession({ status: SessionStatus.FAILED }));
      const result = await service.findOne('sess-uuid-1');

      expect(result.lastError).toBe('chromium missing');
    });

    it('does not surface lastError once the session has recovered', async () => {
      const callbacks = await startAndCapture();
      callbacks.onError?.('transient failure');
      // Engine later becomes ready, which clears the stored reason.
      callbacks.onReady?.('628123', 'Tester');

      (repository.findOne as jest.Mock).mockResolvedValue(createMockSession({ status: SessionStatus.READY }));
      const result = await service.findOne('sess-uuid-1');

      expect(result.lastError).toBeUndefined();
    });
  });

  // ── engine-identity guard: stale-callback isolation ───────────────
  // A callback can fire after its engine was torn down (post-stop) or after a newer engine
  // replaced it for the same id (post-restart / reconnect). Such a stale callback must not
  // mutate the session that now belongs to a different (or no) engine.
  describe('stale engine callback isolation', () => {
    const enginesOf = () => (service as unknown as { engines: Map<string, unknown> }).engines;

    const startAndCapture = async (): Promise<EngineEventCallbacks> => {
      (repository.findOne as jest.Mock).mockResolvedValue(createMockSession());
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });
      await service.start('sess-uuid-1');
      const calls = mockEngine.initialize.mock.calls as [EngineEventCallbacks][];
      return calls[0][0];
    };

    it('lets the live engine drive status (guard is a no-op for the active engine)', async () => {
      const callbacks = await startAndCapture();
      (repository.update as jest.Mock).mockClear();

      callbacks.onReady?.('628123', 'Tester');

      expect(repository.update).toHaveBeenCalledWith(
        'sess-uuid-1',
        expect.objectContaining({ status: SessionStatus.READY }),
      );
    });

    it('ignores onReady from an engine that was torn down (post-stop window)', async () => {
      const callbacks = await startAndCapture();
      enginesOf().delete('sess-uuid-1'); // stop()/forceKill() removes the engine from the live map
      (repository.update as jest.Mock).mockClear();

      callbacks.onReady?.('628123', 'Tester');

      expect(repository.update).not.toHaveBeenCalled();
    });

    it('ignores onDisconnected from a superseded engine after restart (stale generation)', async () => {
      const callbacks = await startAndCapture(); // engine A captured
      enginesOf().set('sess-uuid-1', { marker: 'engine-B' }); // a newer engine now owns the id
      (repository.update as jest.Mock).mockClear();
      (webhookService.dispatch as jest.Mock).mockClear();

      callbacks.onDisconnected?.('socket closed');

      expect(repository.update).not.toHaveBeenCalled();
      expect(webhookService.dispatch).not.toHaveBeenCalled();
    });

    it('ignores onMessage from a superseded engine (no persist, no webhook)', async () => {
      const callbacks = await startAndCapture();
      enginesOf().set('sess-uuid-1', { marker: 'engine-B' });
      (messageRepository.save as jest.Mock).mockClear();
      (webhookService.dispatch as jest.Mock).mockClear();

      callbacks.onMessage?.({
        id: 'wa-1',
        from: 'peer@c.us',
        to: 'me@c.us',
        chatId: 'peer@c.us',
        body: 'hi',
        type: 'text',
        timestamp: 1,
        fromMe: false,
        isGroup: false,
      });
      await new Promise(resolve => setImmediate(resolve));

      expect(messageRepository.save).not.toHaveBeenCalled();
      expect(webhookService.dispatch).not.toHaveBeenCalled();
    });
  });

  // ── engine message-event webhook dispatch ─────────────────────────

  describe('engine message-event webhook dispatch', () => {
    const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

    async function startAndCaptureCallbacks(): Promise<EngineEventCallbacks> {
      (repository.findOne as jest.Mock).mockResolvedValue(createMockSession());
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });
      await service.start('sess-uuid-1');
      const calls = mockEngine.initialize.mock.calls as [EngineEventCallbacks][];
      return calls[0][0];
    }

    function dispatchedEvents(event: string): unknown[][] {
      const calls = (webhookService.dispatch as jest.Mock).mock.calls as unknown[][];
      return calls.filter(call => call[1] === event);
    }

    const makeMessage = (overrides: Partial<IncomingMessage> = {}): IncomingMessage => ({
      id: 'wa-msg-1',
      from: 'peer@c.us',
      to: 'me@c.us',
      chatId: 'peer@c.us',
      body: 'hello',
      type: 'text',
      timestamp: 1706868000,
      fromMe: false,
      isGroup: false,
      ...overrides,
    });

    it('dispatches message.sent exactly once for an outgoing (message_create) event', async () => {
      const callbacks = await startAndCaptureCallbacks();
      expect(typeof callbacks.onMessageCreate).toBe('function');

      callbacks.onMessageCreate!(makeMessage({ id: 'wa-out-1', from: 'me@c.us', to: 'peer@c.us', fromMe: true }));
      await flush();

      const sent = dispatchedEvents('message.sent');
      expect(sent).toHaveLength(1);
      expect(sent[0][0]).toBe('sess-uuid-1');
    });

    it('does NOT persist an outgoing (message_create) self-message to the messages table', async () => {
      // Contract lock: message_create also fires for API sends (already persisted by the REST send
      // path), so a naive save here would double-persist. Phone-composed sends are therefore
      // webhooked/emitted but not mirrored to local history; safe persistence (unique index + dedup)
      // is a separate enhancement. This guards against the omission silently changing.
      const callbacks = await startAndCaptureCallbacks();

      callbacks.onMessageCreate!(makeMessage({ id: 'wa-out-2', from: 'me@c.us', to: 'peer@c.us', fromMe: true }));
      await flush();

      expect(dispatchedEvents('message.sent')).toHaveLength(1); // it IS webhooked/emitted
      expect(messageRepository.create).not.toHaveBeenCalled(); // but NOT persisted
      expect(messageRepository.save).not.toHaveBeenCalled();
    });

    it('scopes the ack status UPDATE by sessionId, not just waMessageId', async () => {
      const callbacks = await startAndCaptureCallbacks();
      expect(typeof callbacks.onMessageAck).toBe('function');

      callbacks.onMessageAck!('wa-msg-1', 'delivered');
      await flush();

      expect(messageRepository.update).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'sess-uuid-1', waMessageId: 'wa-msg-1' }),
        expect.objectContaining({ status: MessageStatus.DELIVERED }),
      );
    });

    it('does not dispatch message.sent for an incoming message_create event (fromMe=false)', async () => {
      const callbacks = await startAndCaptureCallbacks();

      callbacks.onMessageCreate!(makeMessage({ fromMe: false }));
      await flush();

      expect(dispatchedEvents('message.sent')).toHaveLength(0);
    });

    it('does not dispatch message.sent for a status/story broadcast (isStatusBroadcast flag)', async () => {
      const callbacks = await startAndCaptureCallbacks();

      // The adapter flags status broadcasts; session.service branches on the neutral flag, not the
      // engine-specific `status@broadcast` pseudo-JID.
      callbacks.onMessageCreate!(
        makeMessage({
          id: 'wa-status',
          from: 'me@c.us',
          to: 'status@broadcast',
          fromMe: true,
          isStatusBroadcast: true,
        }),
      );
      await flush();

      expect(dispatchedEvents('message.sent')).toHaveLength(0);
    });

    it('emits the realtime WS event for an outgoing message as message.sent, not message.received', async () => {
      const callbacks = await startAndCaptureCallbacks();

      callbacks.onMessageCreate!(makeMessage({ id: 'wa-out-2', from: 'me@c.us', to: 'peer@c.us', fromMe: true }));
      await flush();

      expect(eventsGateway.emitMessageSent as jest.Mock).toHaveBeenCalledWith('sess-uuid-1', expect.anything());
      expect(eventsGateway.emitMessage as jest.Mock).not.toHaveBeenCalled();
    });

    it('dispatches message.ack but never message.sent on a message_ack event', async () => {
      const callbacks = await startAndCaptureCallbacks();
      expect(typeof callbacks.onMessageAck).toBe('function');

      callbacks.onMessageAck!('wa-out-1', 'read');
      await flush();

      expect(dispatchedEvents('message.ack')).toHaveLength(1);
      expect(dispatchedEvents('message.sent')).toHaveLength(0);
    });

    it("reflects delivery on the stored message: 'delivered' updates status to DELIVERED (#220)", async () => {
      const callbacks = await startAndCaptureCallbacks();

      callbacks.onMessageAck!('wa-out-1', 'delivered');
      await flush();

      expect(messageRepository.update as jest.Mock).toHaveBeenCalledWith(
        expect.objectContaining({ waMessageId: 'wa-out-1' }),
        { status: MessageStatus.DELIVERED },
      );
    });

    it("marks the stored message FAILED and dispatches message.failed on a 'failed' status (#220)", async () => {
      const callbacks = await startAndCaptureCallbacks();

      callbacks.onMessageAck!('wa-out-1', 'failed');
      await flush();

      expect(messageRepository.update as jest.Mock).toHaveBeenCalledWith(
        expect.objectContaining({ waMessageId: 'wa-out-1' }),
        { status: MessageStatus.FAILED },
      );
      expect(dispatchedEvents('message.failed')).toHaveLength(1);
    });

    it('emits the message:ack hook for every ack so plugins (e.g. a delivery logger) can react', async () => {
      const callbacks = await startAndCaptureCallbacks();

      callbacks.onMessageAck!('wa-out-1', 'delivered');
      await flush();

      expect(hookManager.execute).toHaveBeenCalledWith(
        'message:ack',
        expect.objectContaining({ messageId: 'wa-out-1', status: 'delivered' }),
        expect.objectContaining({ source: 'Engine' }),
      );
    });

    it("surfaces delivery failures via message:ack with status 'failed' (not the send-time message:failed hook)", async () => {
      const callbacks = await startAndCaptureCallbacks();

      callbacks.onMessageAck!('wa-out-1', 'failed');
      await flush();

      expect(hookManager.execute).toHaveBeenCalledWith(
        'message:ack',
        expect.objectContaining({ messageId: 'wa-out-1', status: 'failed' }),
        expect.objectContaining({ source: 'Engine' }),
      );
      // message:failed stays reserved for send-time failures (a distinct {error,input} payload).
      expect(hookManager.execute).not.toHaveBeenCalledWith('message:failed', expect.anything(), expect.anything());
    });

    it("does not upgrade the stored status (or emit message.failed) for a 'sent' status", async () => {
      const callbacks = await startAndCaptureCallbacks();

      callbacks.onMessageAck!('wa-out-1', 'sent');
      await flush();

      expect(messageRepository.update as jest.Mock).not.toHaveBeenCalled();
      expect(dispatchedEvents('message.failed')).toHaveLength(0);
    });

    it('retries the ack update once after a delay when the row is not yet matchable (ack before commit)', async () => {
      const callbacks = await startAndCaptureCallbacks();
      (messageRepository.update as jest.Mock)
        .mockClear()
        .mockResolvedValueOnce({ affected: 0 }) // send's 2nd save (waMessageId) not committed yet
        .mockResolvedValueOnce({ affected: 1 }); // retry now matches the row

      jest.useFakeTimers();
      try {
        callbacks.onMessageAck!('wa-out-1', 'delivered');
        await jest.advanceTimersByTimeAsync(0); // flush the first update's microtasks
        expect(messageRepository.update as jest.Mock).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(ACK_RECONCILE_DELAY_MS);
        expect(messageRepository.update as jest.Mock).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });

    it('does not schedule a retry when the first ack update advances a row', async () => {
      const callbacks = await startAndCaptureCallbacks();
      (messageRepository.update as jest.Mock).mockClear().mockResolvedValue({ affected: 1 });

      jest.useFakeTimers();
      try {
        callbacks.onMessageAck!('wa-out-1', 'delivered');
        await jest.advanceTimersByTimeAsync(ACK_RECONCILE_DELAY_MS);
        expect(messageRepository.update as jest.Mock).toHaveBeenCalledTimes(1);
      } finally {
        jest.useRealTimers();
      }
    });

    it('handles a rejected ack update without an unhandled rejection', async () => {
      const callbacks = await startAndCaptureCallbacks();
      (messageRepository.update as jest.Mock).mockClear().mockRejectedValue(new Error('data DB down'));

      // Must not throw synchronously; the .catch keeps the rejection from escaping to the global backstop
      // (a missing .catch here would surface as an unhandled rejection and fail the suite).
      callbacks.onMessageAck!('wa-out-1', 'delivered');
      await flush();
      await flush();

      expect(messageRepository.update as jest.Mock).toHaveBeenCalled();
    });

    it('serializes concurrent reactions on the same message so neither sender is clobbered', async () => {
      const callbacks = await startAndCaptureCallbacks();

      // Simulate a real DB: each findOne returns a FRESH snapshot of the persisted row, and save
      // writes it back. Without per-message serialization the two handlers read the same empty
      // snapshot and the second save clobbers the first sender's reaction.
      type Row = { metadata?: Record<string, unknown> };
      const clone = (r: Row): Row => JSON.parse(JSON.stringify(r)) as Row;
      let stored: Row = { metadata: {} };
      (messageRepository.findOne as jest.Mock).mockImplementation(() => Promise.resolve(clone(stored)));
      (messageRepository.save as jest.Mock).mockImplementation((m: Row) => {
        stored = clone(m);
        return Promise.resolve(m);
      });

      callbacks.onMessageReaction!({ messageId: 'wa-1', chatId: 'c', senderId: 'alice', reaction: '👍' });
      callbacks.onMessageReaction!({ messageId: 'wa-1', chatId: 'c', senderId: 'bob', reaction: '🎉' });

      for (let i = 0; i < 5; i++) await flush();

      expect(stored.metadata?.reactions).toEqual({ alice: '👍', bob: '🎉' });
    });

    it('removes a sender reaction on a cleared reaction event (delete branch)', async () => {
      const callbacks = await startAndCaptureCallbacks();
      type Row = { metadata?: Record<string, unknown> };
      const clone = (r: Row): Row => JSON.parse(JSON.stringify(r)) as Row;
      let stored: Row = { metadata: { reactions: { alice: '👍', bob: '🎉' } } };
      (messageRepository.findOne as jest.Mock).mockImplementation(() => Promise.resolve(clone(stored)));
      (messageRepository.save as jest.Mock).mockImplementation((m: Row) => {
        stored = clone(m);
        return Promise.resolve(m);
      });

      callbacks.onMessageReaction!({ messageId: 'wa-1', chatId: 'c', senderId: 'alice', reaction: '' });

      for (let i = 0; i < 3; i++) await flush();

      expect(stored.metadata?.reactions).toEqual({ bob: '🎉' }); // alice removed, bob preserved
    });

    it('a failed reaction write does not block a later reaction on the same message', async () => {
      const callbacks = await startAndCaptureCallbacks();
      type Row = { metadata?: Record<string, unknown> };
      const clone = (r: Row): Row => JSON.parse(JSON.stringify(r)) as Row;
      let stored: Row = { metadata: {} };
      (messageRepository.findOne as jest.Mock).mockImplementation(() => Promise.resolve(clone(stored)));
      (messageRepository.save as jest.Mock)
        .mockRejectedValueOnce(new Error('write blip')) // alice's write fails
        .mockImplementation((m: Row) => {
          stored = clone(m);
          return Promise.resolve(m);
        });

      callbacks.onMessageReaction!({ messageId: 'wa-1', chatId: 'c', senderId: 'alice', reaction: '👍' });
      callbacks.onMessageReaction!({ messageId: 'wa-1', chatId: 'c', senderId: 'bob', reaction: '🎉' });

      for (let i = 0; i < 5; i++) await flush();

      expect(stored.metadata?.reactions).toEqual({ bob: '🎉' }); // bob applied despite alice's failure
    });

    it('cleans up the per-message serialization entry after the chain drains (no leak)', async () => {
      const callbacks = await startAndCaptureCallbacks();
      (messageRepository.findOne as jest.Mock).mockResolvedValue({ metadata: {} });
      (messageRepository.save as jest.Mock).mockResolvedValue(undefined);

      callbacks.onMessageReaction!({ messageId: 'wa-1', chatId: 'c', senderId: 'alice', reaction: '👍' });

      for (let i = 0; i < 3; i++) await flush();

      const chains = (service as unknown as { reactionChains: Map<string, unknown> }).reactionChains;
      expect(chains.size).toBe(0);
    });

    it('dispatches message.reaction to the webhook with the post-apply reactions snapshot', async () => {
      const callbacks = await startAndCaptureCallbacks();
      type Row = { metadata?: Record<string, unknown> };
      const clone = (r: Row): Row => JSON.parse(JSON.stringify(r)) as Row;
      let stored: Row = { metadata: {} };
      (messageRepository.findOne as jest.Mock).mockImplementation(() => Promise.resolve(clone(stored)));
      (messageRepository.save as jest.Mock).mockImplementation((m: Row) => {
        stored = clone(m);
        return Promise.resolve(m);
      });

      callbacks.onMessageReaction!({ messageId: 'wa-1', chatId: 'c', senderId: 'alice', reaction: '👍' });
      for (let i = 0; i < 3; i++) await flush();

      const dispatched = dispatchedEvents('message.reaction');
      expect(dispatched).toHaveLength(1);
      // Webhook payload mirrors the WS payload: the event plus the post-apply reactions snapshot.
      expect(dispatched[0][2]).toMatchObject({
        messageId: 'wa-1',
        chatId: 'c',
        senderId: 'alice',
        reaction: '👍',
        reactions: { alice: '👍' },
      });
    });

    it('dispatches message.received (not message.sent) on an incoming message event', async () => {
      const callbacks = await startAndCaptureCallbacks();

      callbacks.onMessage!(makeMessage({ fromMe: false }));
      await flush();

      expect(dispatchedEvents('message.received')).toHaveLength(1);
      expect(dispatchedEvents('message.sent')).toHaveLength(0);
    });

    it('does not dispatch message.received for a status/story broadcast via onMessage (isStatusBroadcast)', async () => {
      const callbacks = await startAndCaptureCallbacks();

      // Engine delivers a status@broadcast inbound — engine-neutral guard must drop it.
      callbacks.onMessage!(
        makeMessage({
          from: 'status@broadcast',
          to: 'me@c.us',
          chatId: 'status@broadcast',
          fromMe: false,
          isStatusBroadcast: true,
        }),
      );
      await flush();

      expect(dispatchedEvents('message.received')).toHaveLength(0);
    });

    // The default hookManager mock returns an empty `data: {}`; echo the message through so the
    // engine-set fields (isLidSender) survive the hook and reach the inline-resolution branch.
    const echoHook = () =>
      (hookManager.execute as jest.Mock).mockImplementation((_event: string, data: unknown) =>
        Promise.resolve({ continue: true, data }),
      );

    it('attaches senderPhone inline for an @lid sender when RESOLVE_LID_TO_PHONE is on (#263)', async () => {
      process.env.RESOLVE_LID_TO_PHONE = 'true';
      try {
        echoHook();
        mockEngine.resolveContactPhone.mockResolvedValue('628111222333');
        const callbacks = await startAndCaptureCallbacks();

        callbacks.onMessage!(makeMessage({ from: '111@lid', chatId: '111@lid', isLidSender: true }));
        await flush();

        const received = dispatchedEvents('message.received');
        expect(received).toHaveLength(1);
        expect((received[0][2] as IncomingMessage).senderPhone).toBe('628111222333');
        expect(mockEngine.resolveContactPhone).toHaveBeenCalledWith('111@lid');
      } finally {
        delete process.env.RESOLVE_LID_TO_PHONE;
      }
    });

    it('resolves senderPhone from a canonicalized @c.us author for a resolved-lid sender (#263)', async () => {
      // After JID canonicalization a resolved lid reaches the service as <phone>@c.us while isLidSender
      // stays true. Wire resolveContactPhone to the real store so the @c.us branch is genuinely exercised:
      // if resolvePhone regressed to null for @c.us, senderPhone would be null here.
      process.env.RESOLVE_LID_TO_PHONE = 'true';
      try {
        echoHook();
        const store = new BaileysSessionStore();
        store.addLidMappings([{ lid: '111@lid', pn: '628111222333@s.whatsapp.net' }]);
        mockEngine.resolveContactPhone.mockImplementation((id: string) => Promise.resolve(store.resolvePhone(id)));
        const callbacks = await startAndCaptureCallbacks();

        // Group lid author resolved to <phone>@c.us by the engine boundary.
        callbacks.onMessage!(
          makeMessage({ from: 'g@g.us', chatId: 'g@g.us', author: '628111222333@c.us', isLidSender: true }),
        );
        await flush();

        const received = dispatchedEvents('message.received');
        expect(received).toHaveLength(1);
        expect((received[0][2] as IncomingMessage).senderPhone).toBe('628111222333');
        expect(mockEngine.resolveContactPhone).toHaveBeenCalledWith('628111222333@c.us');
      } finally {
        delete process.env.RESOLVE_LID_TO_PHONE;
      }
    });

    it('does not resolve senderPhone when RESOLVE_LID_TO_PHONE is unset (default off)', async () => {
      delete process.env.RESOLVE_LID_TO_PHONE;
      echoHook();
      const callbacks = await startAndCaptureCallbacks();

      callbacks.onMessage!(makeMessage({ from: '111@lid', chatId: '111@lid', isLidSender: true }));
      await flush();

      const received = dispatchedEvents('message.received');
      expect(received).toHaveLength(1);
      expect((received[0][2] as IncomingMessage).senderPhone).toBeUndefined();
      expect(mockEngine.resolveContactPhone).not.toHaveBeenCalled();
    });

    it('does not resolve for a normal (non-lid) sender even when the flag is on', async () => {
      process.env.RESOLVE_LID_TO_PHONE = 'true';
      try {
        echoHook();
        const callbacks = await startAndCaptureCallbacks();

        callbacks.onMessage!(makeMessage({ from: 'peer@c.us', chatId: 'peer@c.us' })); // no isLidSender
        await flush();

        expect(mockEngine.resolveContactPhone).not.toHaveBeenCalled();
      } finally {
        delete process.env.RESOLVE_LID_TO_PHONE;
      }
    });

    it('caches @lid resolution so the same sender is queried only once (#263)', async () => {
      process.env.RESOLVE_LID_TO_PHONE = 'true';
      try {
        echoHook();
        mockEngine.resolveContactPhone.mockResolvedValue('628111222333');
        const callbacks = await startAndCaptureCallbacks();

        callbacks.onMessage!(makeMessage({ id: 'm1', from: '111@lid', chatId: '111@lid', isLidSender: true }));
        await flush();
        callbacks.onMessage!(makeMessage({ id: 'm2', from: '111@lid', chatId: '111@lid', isLidSender: true }));
        await flush();

        expect(mockEngine.resolveContactPhone).toHaveBeenCalledTimes(1);
      } finally {
        delete process.env.RESOLVE_LID_TO_PHONE;
      }
    });

    it('dispatches the message.revoked webhook and WS event on a revoke (#152)', async () => {
      const callbacks = await startAndCaptureCallbacks();
      expect(typeof callbacks.onMessageRevoked).toBe('function');

      callbacks.onMessageRevoked!({
        id: 'wa-rev-1',
        chatId: 'peer@c.us',
        from: 'peer@c.us',
        to: 'me@c.us',
        type: 'revoked',
        body: '',
        timestamp: 1706868000,
      });
      await flush();

      expect(dispatchedEvents('message.revoked')).toHaveLength(1);
      expect(eventsGateway.emitMessageRevoked as jest.Mock).toHaveBeenCalledWith('sess-uuid-1', expect.anything());
    });

    // ── session lifecycle events ──────────────────────────────────────

    it('dispatches session.qr with the QR payload when the engine emits a QR code', async () => {
      const callbacks = await startAndCaptureCallbacks();
      expect(typeof callbacks.onQRCode).toBe('function');

      callbacks.onQRCode!('qr-data-abc');
      await flush();

      const qr = dispatchedEvents('session.qr');
      expect(qr).toHaveLength(1);
      expect(qr[0][0]).toBe('sess-uuid-1');
      expect(qr[0][2]).toMatchObject({ sessionId: 'sess-uuid-1', qr: 'qr-data-abc' });
    });

    it('dispatches session.authenticated with phone/pushName when the engine reports ready', async () => {
      const callbacks = await startAndCaptureCallbacks();
      expect(typeof callbacks.onReady).toBe('function');

      callbacks.onReady!('628123', 'Alice');
      await flush();

      const auth = dispatchedEvents('session.authenticated');
      expect(auth).toHaveLength(1);
      expect(auth[0][0]).toBe('sess-uuid-1');
      expect(auth[0][2]).toMatchObject({ sessionId: 'sess-uuid-1', phone: '628123', pushName: 'Alice' });
    });

    it('dispatches session.disconnected with the reason when the engine disconnects', async () => {
      const callbacks = await startAndCaptureCallbacks();
      expect(typeof callbacks.onDisconnected).toBe('function');
      // Isolate the dispatch from the reconnect scheduler, which would otherwise leave a live timer.
      jest
        .spyOn(service as unknown as { scheduleReconnect: (id: string, s: unknown) => void }, 'scheduleReconnect')
        .mockImplementation(() => undefined);

      callbacks.onDisconnected!('logged out');
      await flush();

      const disc = dispatchedEvents('session.disconnected');
      expect(disc).toHaveLength(1);
      expect(disc[0][0]).toBe('sess-uuid-1');
      expect(disc[0][2]).toMatchObject({ sessionId: 'sess-uuid-1', reason: 'logged out' });
    });

    it('dispatches session.status on a session status transition', async () => {
      await startAndCaptureCallbacks();
      await flush();

      // start() transitions the session to INITIALIZING via updateStatus().
      const status = dispatchedEvents('session.status');
      expect(status.length).toBeGreaterThanOrEqual(1);
      expect(status[0][0]).toBe('sess-uuid-1');
      expect(status[0][2]).toMatchObject({ sessionId: 'sess-uuid-1', status: SessionStatus.INITIALIZING });
    });

    it('does not double-dispatch session.status when onStateChanged and a dedicated callback report the same status', async () => {
      const callbacks = await startAndCaptureCallbacks();
      // wwebjs signals a QR transition via BOTH onStateChanged(QR_READY) and onQRCode → updateStatus(QR_READY) twice.
      callbacks.onStateChanged!(EngineStatus.QR_READY);
      callbacks.onQRCode!('qr-data-abc');
      await flush();

      const qrStatus = dispatchedEvents('session.status').filter(
        c => (c[2] as { status?: string }).status === SessionStatus.QR_READY,
      );
      expect(qrStatus).toHaveLength(1);
    });
  });

  // ── stop ──────────────────────────────────────────────────────────

  describe('stop', () => {
    it('should disconnect engine and set status to DISCONNECTED', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      // Start first
      await service.start('sess-uuid-1');

      // Stop
      await service.stop('sess-uuid-1');

      expect(mockEngine.disconnect).toHaveBeenCalled();
      expect(repository.update).toHaveBeenCalledWith('sess-uuid-1', {
        status: SessionStatus.DISCONNECTED,
      });
    });
  });

  // ── getQRCode ─────────────────────────────────────────────────────

  describe('getQRCode', () => {
    it('should throw BadRequestException if engine not started', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);

      await expect(service.getQRCode('sess-uuid-1')).rejects.toThrow(BadRequestException);
    });

    it('should return QR code from engine', async () => {
      const session = createMockSession({ status: SessionStatus.QR_READY });
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      await service.start('sess-uuid-1');
      mockEngine.getQRCode.mockReturnValue('data:image/png;base64,iVBOR...');

      const result = await service.getQRCode('sess-uuid-1');

      expect(result.qrCode).toBe('data:image/png;base64,iVBOR...');
    });

    it('should throw if session is READY (already authenticated)', async () => {
      const session = createMockSession({ status: SessionStatus.READY });
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      await service.start('sess-uuid-1');
      mockEngine.getQRCode.mockReturnValue(null);

      await expect(service.getQRCode('sess-uuid-1')).rejects.toThrow('already authenticated');
    });
  });

  // ── getStats ──────────────────────────────────────────────────────

  describe('getStats', () => {
    it('should return correct session statistics', async () => {
      const sessions = [
        createMockSession({ status: SessionStatus.READY }),
        createMockSession({ id: 'sess-2', status: SessionStatus.READY }),
        createMockSession({ id: 'sess-3', status: SessionStatus.DISCONNECTED }),
      ];
      (repository.find as jest.Mock).mockResolvedValue(sessions);

      const stats = await service.getStats();

      expect(stats.total).toBe(3);
      expect(stats.ready).toBe(2);
      expect(stats.disconnected).toBe(1);
      expect(stats.byStatus[SessionStatus.READY]).toBe(2);
      expect(stats.memoryUsage).toBeDefined();
    });
  });

  // ── getChats ──────────────────────────────────────────────────────

  describe('getChats', () => {
    it('should delegate to engine.getChats for a started session', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      await service.start('sess-uuid-1');

      const chats = [{ id: '123@c.us', name: 'Alice', isGroup: false, unreadCount: 2, timestamp: 1700000000 }];
      mockEngine.getChats.mockResolvedValue(chats);

      const result = await service.getChats('sess-uuid-1');

      expect(mockEngine.getChats).toHaveBeenCalled();
      expect(result).toEqual(chats);
    });

    it('caps an unbounded chat list at the default limit (1000), most-recent first', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });
      await service.start('sess-uuid-1');

      const chats = Array.from({ length: 1500 }, (_, i) => ({
        id: `${i}@c.us`,
        name: `c${i}`,
        isGroup: false,
        unreadCount: 0,
        timestamp: i,
      }));
      mockEngine.getChats.mockResolvedValue(chats);

      const result = await service.getChats('sess-uuid-1');
      expect(result).toHaveLength(1000);
      expect(result[0].timestamp).toBe(1499); // sorted timestamp DESC before capping
      expect(result[999].timestamp).toBe(500);
    });

    it('applies limit/offset to the chat list', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });
      await service.start('sess-uuid-1');

      const chats = Array.from({ length: 50 }, (_, i) => ({
        id: `${i}@c.us`,
        name: `c${i}`,
        isGroup: false,
        unreadCount: 0,
        timestamp: i,
      }));
      mockEngine.getChats.mockResolvedValue(chats);

      const result = await service.getChats('sess-uuid-1', { limit: 5, offset: 0 });
      expect(result).toHaveLength(5);
      expect(result[0].timestamp).toBe(49); // most-recent first
    });

    it('should throw BadRequestException when session is not started', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);

      await expect(service.getChats('sess-uuid-1')).rejects.toThrow(BadRequestException);
    });
  });

  describe('getGroups pagination', () => {
    it('caps an unbounded group list at the default limit (1000)', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });
      await service.start('sess-uuid-1');

      const groups = Array.from({ length: 1500 }, (_, i) => ({ id: `g${i}`, name: `G${i}` }));
      mockEngine.getGroups.mockResolvedValue(groups);

      const result = await service.getGroups('sess-uuid-1');
      expect(result).toHaveLength(1000);
    });
  });

  describe('start() concurrent stop/delete guard', () => {
    it('tears down the just-initialized engine if a stop/delete lands during start() (no resurrection to READY)', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      // Simulate a concurrent stop()/delete() landing WHILE engine.initialize() is in flight.
      mockEngine.initialize.mockImplementationOnce(() => {
        (service as unknown as { stoppingSessions: Set<string> }).stoppingSessions.add('sess-uuid-1');
        return Promise.resolve();
      });

      await service.start('sess-uuid-1');

      // The engine registered during init must be torn down + removed, not left READY.
      expect(mockEngine.destroy).toHaveBeenCalled();
      expect(service.getEngine('sess-uuid-1')).toBeUndefined();
    });
  });

  // ── sendSeen (markChatRead) ───────────────────────────────────────

  describe('sendSeen', () => {
    it('should delegate to engine.sendSeen with the chatId', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      await service.start('sess-uuid-1');
      mockEngine.sendSeen.mockResolvedValue(true);

      const result = await service.sendSeen('sess-uuid-1', '123@c.us');

      expect(mockEngine.sendSeen).toHaveBeenCalledWith('123@c.us');
      expect(result).toBe(true);
    });

    it('should throw BadRequestException when session is not started', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);

      await expect(service.sendSeen('sess-uuid-1', '123@c.us')).rejects.toThrow(BadRequestException);
    });
  });

  // ── markUnread (markChatUnread) ───────────────────────────────────

  describe('markUnread', () => {
    it('should delegate to engine.markUnread with the chatId', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      await service.start('sess-uuid-1');
      mockEngine.markUnread.mockResolvedValue(true);

      const result = await service.markUnread('sess-uuid-1', '123@c.us');

      expect(mockEngine.markUnread).toHaveBeenCalledWith('123@c.us');
      expect(result).toBe(true);
    });

    it('should throw BadRequestException when session is not started', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);

      await expect(service.markUnread('sess-uuid-1', '123@c.us')).rejects.toThrow(BadRequestException);
    });
  });

  // ── onQRCode WebSocket emit ───────────────────────────────────────

  describe('onQRCode', () => {
    it('emits the QR over the WebSocket so subscribed clients get it without polling', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(createMockSession());
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });
      await service.start('sess-uuid-1');
      const callbacks = (mockEngine.initialize.mock.calls as [EngineEventCallbacks][])[0][0];

      callbacks.onQRCode?.('qr-data-123');

      expect(eventsGateway.emitQRCode).toHaveBeenCalledWith('sess-uuid-1', 'qr-data-123');
    });
  });

  // ── deleteChat ────────────────────────────────────────────────────

  describe('deleteChat', () => {
    it('should delegate to engine.deleteChat with the chatId', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      await service.start('sess-uuid-1');
      mockEngine.deleteChat.mockResolvedValue(true);

      const result = await service.deleteChat('sess-uuid-1', '1234567890-123@g.us');

      expect(mockEngine.deleteChat).toHaveBeenCalledWith('1234567890-123@g.us');
      expect(result).toBe(true);
    });

    it('should throw BadRequestException when session is not started', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);

      await expect(service.deleteChat('sess-uuid-1', '1234567890-123@g.us')).rejects.toThrow(BadRequestException);
    });
  });

  // ── sendChatState (typing/recording/paused) ───────────────────────

  describe('sendChatState', () => {
    it('should delegate to engine.sendChatState with the chatId and state', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      await service.start('sess-uuid-1');

      await service.sendChatState('sess-uuid-1', '123@c.us', 'typing');

      expect(mockEngine.sendChatState).toHaveBeenCalledWith('123@c.us', 'typing');
    });

    it('should throw BadRequestException when session is not started', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);

      await expect(service.sendChatState('sess-uuid-1', '123@c.us', 'typing')).rejects.toThrow(BadRequestException);
    });
  });

  // ── onMessageRevoked (no localized string) ────────────────────────

  describe('onMessageRevoked callback', () => {
    it('persists an empty body with type "revoked" and emits no localized string', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });
      (messageRepository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      await service.start('sess-uuid-1');

      // Grab the callbacks object passed to engine.initialize.
      const initializeCall = mockEngine.initialize.mock.calls[0] as unknown[];
      const callbacks = initializeCall[0] as {
        onMessageRevoked: (m: { id: string; type: string; body: string }) => void;
      };

      const revoked = {
        id: 'WA_MSG_1',
        chatId: '123@c.us',
        from: '123@c.us',
        to: 'me@c.us',
        type: 'revoked' as const,
        body: '' as const,
        timestamp: 1700000000,
      };

      callbacks.onMessageRevoked(revoked);
      // Allow the queued microtask (repository.update().then()) to resolve.
      await Promise.resolve();
      await Promise.resolve();

      // The stored update must carry an EMPTY body and the 'revoked' type — no display string.
      expect(messageRepository.update).toHaveBeenCalledWith(
        { sessionId: 'sess-uuid-1', waMessageId: 'WA_MSG_1' },
        { body: '', type: 'revoked' },
      );

      // The structured payload emitted to clients must not contain any localized text.
      expect(eventsGateway.emitMessageRevoked).toHaveBeenCalledWith(
        'sess-uuid-1',
        expect.objectContaining({
          id: 'WA_MSG_1',
          type: 'revoked',
          body: '',
        }),
      );
      const revokedCall = (eventsGateway.emitMessageRevoked as jest.Mock).mock.calls[0] as unknown[];
      const emittedPayload = revokedCall[1] as { body: string };
      expect(emittedPayload.body).toBe('');
    });
  });

  // ── getActiveCount / isActive ─────────────────────────────────────

  describe('getActiveCount', () => {
    it('should return 0 when no engines are running', () => {
      expect(service.getActiveCount()).toBe(0);
    });

    it('should return correct count after starting sessions', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      await service.start('sess-uuid-1');

      expect(service.getActiveCount()).toBe(1);
    });
  });

  describe('isActive', () => {
    it('should return false for inactive session', () => {
      expect(service.isActive('nonexistent')).toBe(false);
    });

    it('should return true for active session', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      await service.start('sess-uuid-1');

      expect(service.isActive('sess-uuid-1')).toBe(true);
    });
  });

  // ── onModuleInit ──────────────────────────────────────────────────

  describe('onModuleInit', () => {
    it('should reset active sessions to DISCONNECTED on startup', async () => {
      (repository.update as jest.Mock).mockResolvedValue({ affected: 3 });

      await service.onModuleInit();

      expect(repository.update).toHaveBeenCalledWith(expect.objectContaining({ status: expect.anything() as string }), {
        status: SessionStatus.DISCONNECTED,
      });
    });
  });

  // ── onModuleDestroy ───────────────────────────────────────────────

  describe('onModuleDestroy', () => {
    it('should destroy all running engines on shutdown', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      await service.start('sess-uuid-1');
      await service.onModuleDestroy();

      expect(mockEngine.destroy).toHaveBeenCalled();
      expect(service.getActiveCount()).toBe(0);
    });
  });

  // ── onApplicationBootstrap (auto-start) ───────────────────────────
  describe('onApplicationBootstrap', () => {
    const originalFlag = process.env.AUTO_START_SESSIONS;

    afterEach(() => {
      if (originalFlag === undefined) delete process.env.AUTO_START_SESSIONS;
      else process.env.AUTO_START_SESSIONS = originalFlag;
    });

    it('does nothing when AUTO_START_SESSIONS is not enabled', async () => {
      delete process.env.AUTO_START_SESSIONS;
      const startSpy = jest.spyOn(service, 'start').mockResolvedValue(undefined as never);

      await service.onApplicationBootstrap();

      expect(repository.find).not.toHaveBeenCalled();
      expect(startSpy).not.toHaveBeenCalled();
    });

    it('starts no engine when there are no previously-authenticated sessions', async () => {
      process.env.AUTO_START_SESSIONS = 'true';
      (repository.find as jest.Mock).mockResolvedValue([]);
      const startSpy = jest.spyOn(service, 'start').mockResolvedValue(undefined as never);

      await service.onApplicationBootstrap();

      expect(startSpy).not.toHaveBeenCalled();
    });

    it('auto-starts every previously-authenticated session', async () => {
      process.env.AUTO_START_SESSIONS = 'true';
      (repository.find as jest.Mock).mockResolvedValue([
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
      ]);
      jest.spyOn(service as unknown as { delay: () => Promise<void> }, 'delay').mockResolvedValue(undefined);
      const startSpy = jest.spyOn(service, 'start').mockResolvedValue(undefined as never);

      await service.onApplicationBootstrap();

      expect(startSpy).toHaveBeenCalledTimes(2);
      expect(startSpy).toHaveBeenCalledWith('a');
      expect(startSpy).toHaveBeenCalledWith('b');
    });

    it('keeps starting the remaining sessions when one fails', async () => {
      process.env.AUTO_START_SESSIONS = 'true';
      (repository.find as jest.Mock).mockResolvedValue([
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
      ]);
      jest.spyOn(service as unknown as { delay: () => Promise<void> }, 'delay').mockResolvedValue(undefined);
      const startSpy = jest
        .spyOn(service, 'start')
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce(undefined as never);

      await service.onApplicationBootstrap();

      expect(startSpy).toHaveBeenCalledTimes(2);
    });
  });
});
