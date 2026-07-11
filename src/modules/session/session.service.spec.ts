import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { Repository, DataSource, In } from 'typeorm';
import { NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SessionService, ACK_RECONCILE_DELAY_MS, EngineInitTimeoutError } from './session.service';
import { Session, SessionStatus } from './entities/session.entity';
import { Message, MessageStatus } from '../message/entities/message.entity';
import { MessageBatch } from '../message/entities/message-batch.entity';
import { Webhook } from '../webhook/entities/webhook.entity';
import { Template } from '../template/entities/template.entity';
import { BaileysStoredMessage } from '../../engine/adapters/baileys-stored-message.entity';
import { EngineFactory } from '../../engine/engine.factory';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
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
  let configService: jest.Mocked<Partial<ConfigService>>;
  let lidMappingStore: jest.Mocked<Partial<LidMappingStoreService>>;
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
      // `create()` in TypeORM just builds the entity instance; it does NOT populate @PrimaryGeneratedColumn
      // or @CreateDateColumn. Mirror that: return the input as-is (no id/createdAt) so tests see the same
      // shape the production code does before the `insert()` generated-maps merge.
      create: jest.fn().mockImplementation((data: Partial<Message>) => ({ ...data }) as Message),
      save: jest.fn().mockResolvedValue(undefined),
      // `insert()` returns an InsertResult; `identifiers[0]` carries the PK on both SQLite + Postgres.
      // `generatedMaps[0]` carries createdAt (Postgres yes; SQLite historically no — left absent here to
      // match the local SQLite default DB).
      insert: jest.fn().mockResolvedValue({
        identifiers: [{ id: 'gen-uuid-1' }],
        generatedMaps: [],
        raw: undefined,
      }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    dataSource = {
      transaction: jest.fn().mockImplementation(async (cb: (manager: unknown) => Promise<unknown>) => {
        const manager = {
          save: jest.fn().mockImplementation((entity: unknown) => Promise.resolve(entity)),
          remove: jest.fn().mockResolvedValue(undefined),
          delete: jest.fn().mockResolvedValue({ affected: 0 }),
        };
        return cb(manager);
      }),
    };

    mockEngine = {
      initialize: jest.fn().mockResolvedValue(undefined),
      destroy: jest.fn().mockResolvedValue(undefined),
      forceDestroy: jest.fn().mockResolvedValue(undefined),
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
      purgeSessionData: jest.fn().mockResolvedValue(undefined),
    };

    eventsGateway = {
      emitSessionStatus: jest.fn(),
      emitSessionAuthenticated: jest.fn(),
      emitSessionDisconnected: jest.fn(),
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

    configService = {
      get: jest.fn().mockImplementation(<T>(_key: string, def?: T): T => def as T),
    };

    lidMappingStore = {
      remember: jest.fn().mockResolvedValue(undefined),
      getCached: jest.fn().mockReturnValue(undefined),
      lidsForPhone: jest.fn().mockReturnValue([]),
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
        { provide: ConfigService, useValue: configService },
        { provide: LidMappingStoreService, useValue: lidMappingStore },
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

    it('delete() completes when engine.forceDestroy() rejects — map reconciled, row removed, stop-mark cleared', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(createMockSession());
      const engine = { forceDestroy: jest.fn().mockRejectedValue(new Error('stuck chromium')) };
      enginesOf().set('sess-uuid-1', engine);

      await expect(service.delete('sess-uuid-1')).resolves.toBeUndefined();

      expect(engine.forceDestroy).toHaveBeenCalledTimes(1);
      expect(enginesOf().has('sess-uuid-1')).toBe(false); // Map reconciled despite the failure
      expect(stoppingOf().has('sess-uuid-1')).toBe(false); // stop-mark cleared (no wedge)
      expect(hookManager.execute).toHaveBeenCalledWith('session:deleted', expect.anything(), expect.anything());
      expect(dataSource.transaction).toHaveBeenCalled(); // DB removal still ran
    });

    it('delete() purges the engine on-disk auth dir (keyed by session NAME) so a same-name recreate starts clean', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(
        createMockSession({ id: 'sess-uuid-1', name: 'test-session' }),
      );
      enginesOf().set('sess-uuid-1', { forceDestroy: jest.fn().mockResolvedValue(undefined) });

      await service.delete('sess-uuid-1');

      expect(engineFactory.purgeSessionData).toHaveBeenCalledWith('test-session');
    });

    it('delete() purges even when no engine is loaded (a stopped session has none)', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(
        createMockSession({ id: 'sess-uuid-1', name: 'test-session' }),
      );
      // No engine in the map — the common delete case.

      await service.delete('sess-uuid-1');

      expect(engineFactory.purgeSessionData).toHaveBeenCalledWith('test-session');
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
      enginesOf().set('sess-uuid-1', { forceDestroy: jest.fn().mockResolvedValue(undefined) });

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

    it('maps a name UNIQUE-violation on insert to 409 when two concurrent creates race past the pre-check', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(null); // pre-check passes (TOCTOU window)
      (repository.create as jest.Mock).mockReturnValue(createMockSession());
      const uniqueErr = Object.assign(new Error('duplicate key value'), { driverError: { code: '23505' } });
      (dataSource.transaction as jest.Mock).mockRejectedValueOnce(uniqueErr);

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
      expect(repository.find).toHaveBeenCalledWith({ order: { createdAt: 'DESC' }, take: 1000, skip: 0 });
    });

    it('scopes results to a session-restricted key', async () => {
      (repository.find as jest.Mock).mockResolvedValue([]);

      await service.findAll(['sess-1', 'sess-2']);

      expect(repository.find).toHaveBeenCalledWith({
        where: { id: In(['sess-1', 'sess-2']) },
        order: { createdAt: 'DESC' },
        take: 1000,
        skip: 0,
      });
    });

    it('returns all sessions for an unrestricted key (null/empty allowlist)', async () => {
      (repository.find as jest.Mock).mockResolvedValue([]);

      await service.findAll(null);
      await service.findAll([]);

      expect(repository.find).toHaveBeenCalledTimes(2);
      expect(repository.find).toHaveBeenNthCalledWith(1, { order: { createdAt: 'DESC' }, take: 1000, skip: 0 });
      expect(repository.find).toHaveBeenNthCalledWith(2, { order: { createdAt: 'DESC' }, take: 1000, skip: 0 });
    });

    it('applies bounded pagination to the database query', async () => {
      (repository.find as jest.Mock).mockResolvedValue([]);

      await service.findAll(['sess-1'], { limit: 5000, offset: -5 });

      expect(repository.find).toHaveBeenCalledWith({
        where: { id: In(['sess-1']) },
        order: { createdAt: 'DESC' },
        take: 1000,
        skip: 0,
      });
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

    it('evicts and tears down the engine when engine.initialize() fails (no orphan wedging the session)', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(createMockSession());
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });
      (engineFactory.create as jest.Mock).mockClear().mockReturnValue(mockEngine);
      mockEngine.initialize.mockRejectedValueOnce(new Error('chromium launch failed'));

      await expect(service.start('sess-uuid-1')).rejects.toThrow('chromium launch failed');

      const engines = (service as unknown as { engines: Map<string, unknown> }).engines;
      expect(engines.has('sess-uuid-1')).toBe(false); // not left orphaned → session can be started again
      // forceDestroy(), not destroy(): initialize() failing usually means the browser/CDP
      // connection is already broken, so only a direct SIGKILL (forceDestroy) reliably reaps the
      // OS-level Chromium process — a graceful destroy() has nothing live to talk to and can only
      // time out, leaving the process orphaned (the actual bug this test now guards against).
      expect(mockEngine.forceDestroy).toHaveBeenCalled();
      expect(mockEngine.destroy).not.toHaveBeenCalled();
    });

    it('allows a fresh start after the previous one completed (reservation is cleared)', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(createMockSession());
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });
      (engineFactory.create as jest.Mock).mockClear().mockReturnValue(mockEngine);

      await service.start('sess-uuid-1');
      // Engine is now in the map, so a second start is 'already started' (not wedged at 'starting').
      await expect(service.start('sess-uuid-1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects starting a new session when MAX_CONCURRENT_SESSIONS is reached', async () => {
      (configService.get as jest.Mock).mockImplementation(<T>(key: string, def?: T): T | number => {
        if (key === 'sessions.maxConcurrent') return 1;
        return def as T;
      });
      (repository.findOne as jest.Mock).mockResolvedValue(createMockSession({ id: 'sess-2' }));
      const engines = (service as unknown as { engines: Map<string, unknown> }).engines;
      engines.set('sess-1', mockEngine);

      await expect(service.start('sess-2')).rejects.toThrow(/Maximum concurrent sessions reached/);
      expect(engineFactory.create).not.toHaveBeenCalled();
    });

    it('does not double-count a still-initializing session against MAX_CONCURRENT_SESSIONS', async () => {
      (configService.get as jest.Mock).mockImplementation(<T>(key: string, def?: T): T | number => {
        if (key === 'sessions.maxConcurrent') return 2;
        return def as T;
      });
      (repository.findOne as jest.Mock).mockResolvedValue(createMockSession({ id: 'sess-2' }));
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });
      (engineFactory.create as jest.Mock).mockClear().mockReturnValue(mockEngine);

      const internals = service as unknown as {
        engines: Map<string, unknown>;
        initializingSessions: Set<string>;
      };
      // 'sess-1' is mid-initialize: present in BOTH sets (the real overlap window). Deduplicated active
      // count is 1, below the cap of 2 — so starting 'sess-2' must be allowed. The old summed-size
      // logic counted it as 2 (engines.size + initializingSessions.size) and would wrongly reject.
      internals.engines.set('sess-1', mockEngine);
      internals.initializingSessions.add('sess-1');

      await expect(service.start('sess-2')).resolves.toBeDefined();
      expect(engineFactory.create).toHaveBeenCalled();

      internals.engines.clear();
      internals.initializingSessions.clear();
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

      // delete() reaps permanently, so it force-destroys (SIGKILL) rather than a graceful destroy().
      expect(mockEngine.forceDestroy).toHaveBeenCalled();
    });

    it('removes the session and all its child rows explicitly in one transaction (SQLite cascade is off)', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);

      const managerDelete = jest.fn().mockResolvedValue({ affected: 0 });
      const managerRemove = jest.fn().mockResolvedValue(undefined);
      (dataSource.transaction as jest.Mock).mockImplementationOnce(async (cb: (m: unknown) => Promise<unknown>) =>
        cb({ save: jest.fn(), remove: managerRemove, delete: managerDelete }),
      );

      await service.delete('sess-uuid-1');

      // messages/message_batches have no FK; webhooks/templates/baileys_stored_messages declare an
      // ON DELETE CASCADE FK, but SQLite runs with foreign_keys OFF so it never fires — delete() must
      // clear ALL of them explicitly or a session delete orphans them (webhooks retain the secret).
      expect(managerDelete).toHaveBeenCalledWith(Message, { sessionId: 'sess-uuid-1' });
      expect(managerDelete).toHaveBeenCalledWith(MessageBatch, { sessionId: 'sess-uuid-1' });
      expect(managerDelete).toHaveBeenCalledWith(Webhook, { sessionId: 'sess-uuid-1' });
      expect(managerDelete).toHaveBeenCalledWith(Template, { sessionId: 'sess-uuid-1' });
      expect(managerDelete).toHaveBeenCalledWith(BaileysStoredMessage, { sessionId: 'sess-uuid-1' });
      expect(managerRemove).toHaveBeenCalledWith(session);
    });
  });

  // ── start ─────────────────────────────────────────────────────────

  describe('start', () => {
    it('should create engine and set status to INITIALIZING', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      await service.start('sess-uuid-1');

      expect(engineFactory.create).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'test-session', dbSessionId: 'sess-uuid-1' }),
      );
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

  describe('terminal-failure engine eviction', () => {
    interface I {
      initializeEngine: (id: string, s: Session) => Promise<void>;
      executeReconnect: (id: string, s: Session, st: unknown) => Promise<void>;
      engines: Map<string, unknown>;
    }
    const intern = () => service as unknown as I;
    const flush = () => new Promise(resolve => setImmediate(resolve));

    it('onError evicts the failed engine and force-destroys it, so the slot frees and a restart is not blocked', async () => {
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });
      await intern().initializeEngine('sess-uuid-1', createMockSession());
      expect(intern().engines.get('sess-uuid-1')).toBe(mockEngine);

      const callbacks = (mockEngine.initialize.mock.calls[0] as [EngineEventCallbacks])[0];
      callbacks.onError?.('net::ERR_INVALID_AUTH_CREDENTIALS');
      await flush();

      expect(intern().engines.has('sess-uuid-1')).toBe(false);
      expect(mockEngine.forceDestroy).toHaveBeenCalledTimes(1);
    });

    it('executeReconnect evicts and force-destroys the half-initialized engine when re-init fails (no orphan on reconnect-exhaustion)', async () => {
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });
      (repository.findOne as jest.Mock).mockResolvedValue(createMockSession());
      // initializeEngine registers the engine, then engine.initialize() rejects — the half-built engine
      // must not be left in the map for the next start() to trip over as "already started".
      mockEngine.initialize.mockRejectedValueOnce(new Error('chromium launch failed'));
      // Suppress the real reconnect timer scheduled by the catch block.
      jest
        .spyOn(service as unknown as { scheduleReconnect: () => void }, 'scheduleReconnect')
        .mockImplementation(() => undefined);
      const state = { attempts: 1, timer: null, maxAttempts: 5, baseDelay: 5000 };

      await intern().executeReconnect('sess-uuid-1', createMockSession(), state);
      await flush();

      expect(intern().engines.has('sess-uuid-1')).toBe(false);
      expect(mockEngine.forceDestroy).toHaveBeenCalled();
    });
  });

  // ── initializeEngine init-timeout race (#667 follow-up) ───────────
  describe('initializeEngine init-timeout race', () => {
    type Intern = {
      engines: Map<string, unknown>;
      sessionErrors: Map<string, string>;
    };
    const intern = () => service as unknown as Intern;

    it('a REAL engine.initialize() rejection still becomes FAILED with the reason recorded (the timeout-scoped catch must NOT downgrade it to DISCONNECTED)', async () => {
      // Regression guard for #600/#631 diagnosability: a real init failure (e.g. Chromium can't launch)
      // must stay FAILED+reason. The catch inside initializeEngine handles ONLY the timeout case and
      // rethrows everything else untouched, so start()'s catch still owns the FAILED+reason path.
      (repository.findOne as jest.Mock).mockResolvedValue(createMockSession());
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });
      mockEngine.initialize.mockRejectedValueOnce(new Error('chromium launch failed'));

      await expect(service.start('sess-uuid-1')).rejects.toThrow('chromium launch failed');

      expect(intern().engines.has('sess-uuid-1')).toBe(false); // evicted, not left wedged
      expect(mockEngine.forceDestroy).toHaveBeenCalled();
      expect(repository.update).toHaveBeenCalledWith('sess-uuid-1', { status: SessionStatus.FAILED });
      expect(intern().sessionErrors.get('sess-uuid-1')).toBe('chromium launch failed');
    });

    it('a wedged engine.initialize() (never settles) is force-destroyed, evicted, marked DISCONNECTED, and rethrows after 60s', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(createMockSession());
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });
      // The hang: initialize() neither resolves nor rejects.
      mockEngine.initialize.mockReturnValue(new Promise<void>(() => undefined));

      jest.useFakeTimers();
      // A start()-path timeout must NOT auto-schedule a reconnect (reconnect is executeReconnect's
      // domain; a manual start that times out leaves the session DISCONNECTED for the operator).
      const scheduleReconnect = jest.spyOn(
        service as unknown as { scheduleReconnect: (...a: unknown[]) => void },
        'scheduleReconnect',
      );
      try {
        const pending = service.start('sess-uuid-1');
        // Attach the handler synchronously so the timeout rejection is never briefly unhandled
        // during the fake-timer tick (which would otherwise fail the test for the wrong reason).
        let caught: unknown;
        const settled = pending.catch((e: unknown) => {
          caught = e;
        });
        // Advance past the 60s init deadline (the async variant flushes microtasks so the
        // teardown + status writes settle within the same advance).
        await jest.advanceTimersByTimeAsync(60_000);
        await settled;

        expect(caught).toBeInstanceOf(EngineInitTimeoutError);
        expect(String(caught)).toMatch(/timed out after 60000ms/i);
        expect(mockEngine.forceDestroy).toHaveBeenCalled(); // wedged browser reaped
        expect(intern().engines.has('sess-uuid-1')).toBe(false); // slot freed for retry
        expect(repository.update).toHaveBeenCalledWith('sess-uuid-1', { status: SessionStatus.DISCONNECTED });
        expect(scheduleReconnect).not.toHaveBeenCalled(); // no auto-reconnect from a start() timeout
      } finally {
        jest.useRealTimers();
      }
    });

    it('extends the init deadline past 60s when WWEBJS_AUTH_TIMEOUT_MS is raised, so a legitimate slow auth wait is not cut short', async () => {
      // #353 slow-boot escape hatch: operators raise the auth wait because WA-Web's inject poll
      // legitimately takes longer on WSL2/low-resource containers. The init race must extend with
      // it, not SIGKILL the init at the 60s floor mid-auth.
      (repository.findOne as jest.Mock).mockResolvedValue(createMockSession());
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });
      mockEngine.initialize.mockReturnValue(new Promise<void>(() => undefined));
      process.env.WWEBJS_AUTH_TIMEOUT_MS = '120000'; // → derived deadline max(60s, 120s+30s) = 150s

      jest.useFakeTimers();
      try {
        const pending = service.start('sess-uuid-1');
        let caught: unknown;
        const settled = pending.catch((e: unknown) => {
          caught = e;
        });

        // At 60s the old hardcoded deadline would have fired and killed a healthy slow init; the
        // derived one must still be waiting.
        await jest.advanceTimersByTimeAsync(60_000);
        expect(caught).toBeUndefined();
        expect(mockEngine.forceDestroy).not.toHaveBeenCalled(); // NOT cut short mid-auth

        // Past the derived 150s deadline the race finally fires.
        await jest.advanceTimersByTimeAsync(90_000); // 60s + 90s = 150s
        await settled;
        expect(caught).toBeInstanceOf(EngineInitTimeoutError);
        expect(String(caught)).toMatch(/timed out after 150000ms/i);
      } finally {
        jest.useRealTimers();
        delete process.env.WWEBJS_AUTH_TIMEOUT_MS;
      }
    });
  });

  describe('scheduleReconnect (max attempts)', () => {
    it('reports "auto-reconnect disabled" (not "failed after 0 attempts") when maxAttempts is 0', async () => {
      const i = service as unknown as {
        reconnectStates: Map<string, { attempts: number; timer: null; maxAttempts: number; baseDelay: number }>;
        sessionErrors: Map<string, string>;
        scheduleReconnect: (id: string, session: Session) => void;
      };
      i.reconnectStates.set('sess-uuid-1', { attempts: 0, timer: null, maxAttempts: 0, baseDelay: 5000 });
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      i.scheduleReconnect('sess-uuid-1', createMockSession());
      await new Promise(resolve => setImmediate(resolve));

      // maxAttempts:0 means auto-reconnect is OFF, not that 0 attempts were tried and failed.
      expect(i.sessionErrors.get('sess-uuid-1')).toMatch(/auto-reconnect is disabled/i);
    });
  });

  describe('start() stale reconnect timer', () => {
    it('cancels a pending reconnect timer before recreating the engine', async () => {
      const i = service as unknown as {
        reconnectStates: Map<
          string,
          { attempts: number; timer: NodeJS.Timeout | null; maxAttempts: number; baseDelay: number }
        >;
        cancelReconnect: (id: string) => void;
      };
      // Spy clearTimeout directly so the assertion pins that the stale HANDLE was actually cleared —
      // not merely that cancelReconnect was reached (which would hold even if it forgot clearTimeout).
      const clearTimeoutSpy = jest.spyOn(globalThis, 'clearTimeout');
      const staleFired = jest.fn();
      // Seed a pending reconnect timer exactly as a failed executeReconnect leaves behind.
      // tsc resolves setTimeout to the DOM overload (number) in the spec context; force the field type.
      const staleTimer = setTimeout(staleFired, 30000) as unknown as NodeJS.Timeout;
      i.reconnectStates.set('sess-uuid-1', { attempts: 1, timer: staleTimer, maxAttempts: 5, baseDelay: 5000 });
      (repository.findOne as jest.Mock).mockResolvedValue(createMockSession());

      await service.start('sess-uuid-1');

      // start() must cancel the stale timer so it can't later destroy/replace the engine start() just
      // created (or orphan a Chromium process), then install a fresh reconnect state.
      expect(staleFired).not.toHaveBeenCalled();
      expect(clearTimeoutSpy).toHaveBeenCalledWith(staleTimer);
      const after = i.reconnectStates.get('sess-uuid-1');
      expect(after?.timer).toBeNull();
      expect(after?.attempts).toBe(0);
      clearTimeout(staleTimer);
      clearTimeoutSpy.mockRestore();
    });
  });

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

    it('tears down an engine created when a delete lands during init (session row gone, mark cleared)', async () => {
      const i = internals();
      // The delete↔reconnect race: delete() clears its teardown mark in finally (ms) AND removes the
      // session row, both well before a slow engine.initialize() (Chromium launch) resolves. Unlike
      // stop(), delete() does not leave the mark set, so the mark alone can't catch it — the post-init
      // guard must re-check that the session still exists before keeping the engine it just created.
      mockEngine.initialize.mockImplementation(() => {
        i.stoppingSessions.delete('sess-uuid-1');
        (repository.findOne as jest.Mock).mockResolvedValue(null);
        return Promise.resolve();
      });

      await i.executeReconnect('sess-uuid-1', createMockSession(), reconnectState);

      expect(mockEngine.destroy).toHaveBeenCalled();
      expect(i.engines.has('sess-uuid-1')).toBe(false);
    });

    it('still re-initializes when the old engine destroy() hangs (time-bounded teardown)', async () => {
      jest.useFakeTimers();
      try {
        const i = internals();
        // A wedged Chromium: destroy() never resolves — the exact condition that triggers a reconnect.
        const stuck = { destroy: jest.fn(() => new Promise<void>(() => undefined)) };
        i.engines.set('sess-uuid-1', stuck);

        const done = i.executeReconnect('sess-uuid-1', createMockSession(), reconnectState);
        await jest.advanceTimersByTimeAsync(10_000); // teardown timeout elapses

        // The hang no longer blocks reconnection: re-init proceeded instead of wedging forever.
        expect(stuck.destroy).toHaveBeenCalledTimes(1);
        expect(engineFactory.create).toHaveBeenCalled();
        await done;
      } finally {
        jest.useRealTimers();
      }
    });

    it('keeps a freshly-reconnected healthy engine when the post-init retirement check errors (transient DB)', async () => {
      const i = internals();
      (repository.findOne as jest.Mock).mockResolvedValue(createMockSession());
      // Re-init succeeds and registers a live engine; the retirement DB read then fails transiently.
      // It must NOT be misread as a reconnect failure that reaps the healthy engine we just recovered.
      jest
        .spyOn(service as unknown as { isSessionRetired: () => Promise<boolean> }, 'isSessionRetired')
        .mockRejectedValue(new Error('transient db blip'));

      await i.executeReconnect('sess-uuid-1', createMockSession(), reconnectState);

      expect(mockEngine.forceDestroy).not.toHaveBeenCalled();
      expect(mockEngine.destroy).not.toHaveBeenCalled();
      expect(i.engines.has('sess-uuid-1')).toBe(true);
    });

    it('does not stack reconnect timers when scheduled twice back-to-back', () => {
      jest.useFakeTimers();
      try {
        const i = service as unknown as {
          reconnectStates: Map<
            string,
            { attempts: number; timer: NodeJS.Timeout | null; maxAttempts: number; baseDelay: number }
          >;
          scheduleReconnect: (id: string, s: Session) => void;
        };
        i.reconnectStates.set('sess-uuid-1', { attempts: 0, timer: null, maxAttempts: 5, baseDelay: 5000 });

        // Two disconnect events in a row each schedule a reconnect. The second must clear the
        // first timer, leaving exactly one pending — otherwise both fire and double-init the engine.
        i.scheduleReconnect('sess-uuid-1', createMockSession());
        i.scheduleReconnect('sess-uuid-1', createMockSession());

        expect(jest.getTimerCount()).toBe(1);
      } finally {
        jest.clearAllTimers();
        jest.useRealTimers();
      }
    });
  });

  describe('scheduleReconnect during shutdown', () => {
    type ReconnectInternals = {
      reconnectStates: Map<
        string,
        { attempts: number; timer: NodeJS.Timeout | null; maxAttempts: number; baseDelay: number }
      >;
      scheduleReconnect: (id: string, s: Session) => void;
      executeReconnect: (...args: unknown[]) => Promise<void>;
      shutdownService?: { isShuttingDown: () => boolean };
    };

    it('does not spawn a fresh engine while the process is draining', () => {
      jest.useFakeTimers();
      try {
        const i = service as unknown as ReconnectInternals;
        i.reconnectStates.set('sess-uuid-1', { attempts: 0, timer: null, maxAttempts: 5, baseDelay: 5000 });
        // Drain in progress: a disconnect during the shutdown window must NOT schedule a reconnect that
        // would launch a fresh Chromium racing onModuleDestroy's teardown.
        i.shutdownService = { isShuttingDown: () => true };
        const exec = jest.spyOn(i, 'executeReconnect').mockResolvedValue(undefined);

        i.scheduleReconnect('sess-uuid-1', createMockSession());
        jest.advanceTimersByTime(120000);

        expect(exec).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(0);
        expect(i.reconnectStates.get('sess-uuid-1')!.attempts).toBe(0); // no attempt consumed
      } finally {
        jest.clearAllTimers();
        jest.useRealTimers();
      }
    });

    it('schedules a reconnect normally when not shutting down', () => {
      jest.useFakeTimers();
      try {
        const i = service as unknown as ReconnectInternals;
        i.reconnectStates.set('sess-uuid-2', { attempts: 0, timer: null, maxAttempts: 5, baseDelay: 5000 });
        i.shutdownService = { isShuttingDown: () => false };
        const exec = jest.spyOn(i, 'executeReconnect').mockResolvedValue(undefined);

        i.scheduleReconnect('sess-uuid-2', createMockSession());
        expect(i.reconnectStates.get('sess-uuid-2')!.attempts).toBe(1); // an attempt was scheduled
        jest.advanceTimersByTime(120000);
        expect(exec).toHaveBeenCalled();
      } finally {
        jest.clearAllTimers();
        jest.useRealTimers();
      }
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

    it('clears the stored failure reason when the session is deleted (no in-memory leak)', async () => {
      const callbacks = await startAndCapture();
      callbacks.onError?.('chromium missing');

      const sessionErrors = (service as unknown as { sessionErrors: Map<string, string> }).sessionErrors;
      expect(sessionErrors.has('sess-uuid-1')).toBe(true); // precondition: the FAILED reason is recorded

      (repository.findOne as jest.Mock).mockResolvedValue(createMockSession({ status: SessionStatus.FAILED }));
      await service.delete('sess-uuid-1');

      // Without cleanup, the entry would linger forever keyed by a deleted UUID (unbounded growth).
      expect(sessionErrors.has('sess-uuid-1')).toBe(false);
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

    it('cancels a pending reconnect timer when the engine then errors terminally', async () => {
      const callbacks = await startAndCapture();
      jest.useFakeTimers();
      try {
        const i = service as unknown as { scheduleReconnect: (id: string, s: Session) => void };
        // A prior onDisconnected scheduled a reconnect…
        i.scheduleReconnect('sess-uuid-1', createMockSession());
        expect(jest.getTimerCount()).toBe(1);

        // …then a terminal failure arrives. It must cancel the pending reconnect so the timer
        // can't resurrect a session the operator has to manually restart.
        callbacks.onError?.('fatal browser crash');
        // onError also evicts the engine; teardownEngineSafely schedules a transient timeout that is
        // cleared once forceDestroy settles. Flush microtasks so only the reconnect-cancellation (the
        // property under test) remains — the resurrection timer must be gone.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.clearAllTimers();
        jest.useRealTimers();
      }
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

    it('bridges session.authenticated to the socket when the live engine becomes ready', async () => {
      const callbacks = await startAndCapture();
      (eventsGateway.emitSessionAuthenticated as jest.Mock).mockClear();

      callbacks.onReady?.('628123', 'Tester');

      expect(eventsGateway.emitSessionAuthenticated).toHaveBeenCalledWith('sess-uuid-1', {
        phone: '628123',
        pushName: 'Tester',
      });
    });

    it('bridges session.disconnected (with reason) to the socket from the live engine', async () => {
      const callbacks = await startAndCapture();
      // The live onDisconnected handler schedules a reconnect timer after emitting; neutralize
      // it so the test leaves no pending timer (same pattern as the reconnect specs).
      jest
        .spyOn(service as unknown as { scheduleReconnect: (id: string, s: unknown) => void }, 'scheduleReconnect')
        .mockImplementation(() => {});
      (eventsGateway.emitSessionDisconnected as jest.Mock).mockClear();

      callbacks.onDisconnected?.('socket closed');

      expect(eventsGateway.emitSessionDisconnected).toHaveBeenCalledWith('sess-uuid-1', { reason: 'socket closed' });
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
      (messageRepository.insert as jest.Mock).mockClear();
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

      expect(messageRepository.insert).not.toHaveBeenCalled();
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

    it('emits an identical message.ack payload over the socket and the webhook (parity)', async () => {
      const callbacks = await startAndCaptureCallbacks();

      callbacks.onMessageAck!('wa-out-1', 'read');
      await flush();

      const ackCalls = (eventsGateway.emitMessageAck as jest.Mock).mock.calls as unknown[][];
      const socketPayload = ackCalls[0][1] as Record<string, unknown>;
      const webhookPayload = dispatchedEvents('message.ack')[0][2] as Record<string, unknown>;

      // A socket client coded against the webhook/doc ack shape must see the same fields.
      expect(socketPayload).toEqual(webhookPayload);
      expect(socketPayload).toMatchObject({ id: 'wa-out-1', messageId: 'wa-out-1', status: 'read' });
      expect(socketPayload.ack).toBeDefined();
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

      // Simulate a real DB: each findOne returns a FRESH snapshot of the persisted row, and the scoped
      // update writes the new metadata back. Without per-message serialization the two handlers read the
      // same empty snapshot and the second write clobbers the first sender's reaction.
      type Row = { metadata?: Record<string, unknown> };
      const clone = (r: Row): Row => JSON.parse(JSON.stringify(r)) as Row;
      let stored: Row = { metadata: {} };
      (messageRepository.findOne as jest.Mock).mockImplementation(() => Promise.resolve(clone(stored)));
      (messageRepository.update as jest.Mock).mockImplementation((_c: unknown, patch: Row) => {
        stored = clone({ ...stored, ...patch });
        return Promise.resolve({ affected: 1 });
      });

      callbacks.onMessageReaction!({ messageId: 'wa-1', chatId: 'c', senderId: 'alice', reaction: '👍' });
      callbacks.onMessageReaction!({ messageId: 'wa-1', chatId: 'c', senderId: 'bob', reaction: '🎉' });

      for (let i = 0; i < 5; i++) await flush();

      expect(stored.metadata?.reactions).toEqual({ alice: '👍', bob: '🎉' });
    });

    it('persists a reaction via a scoped metadata update, never a full-row save (protects ack status)', async () => {
      const callbacks = await startAndCaptureCallbacks();
      // The row was already advanced to DELIVERED by a concurrent ack. A full-row save(msg) would
      // re-persist the stale status read at findOne time and clobber it; the write must be scoped to
      // the metadata column only, keyed by (sessionId, waMessageId).
      (messageRepository.findOne as jest.Mock).mockResolvedValue({ status: 'delivered', metadata: {} });
      (messageRepository.save as jest.Mock).mockClear();
      (messageRepository.update as jest.Mock).mockClear().mockResolvedValue({ affected: 1 });

      callbacks.onMessageReaction!({ messageId: 'wa-1', chatId: 'c', senderId: 'alice', reaction: '👍' });
      for (let i = 0; i < 3; i++) await flush();

      expect(messageRepository.save).not.toHaveBeenCalled();
      expect(messageRepository.update).toHaveBeenCalledWith(
        { sessionId: 'sess-uuid-1', waMessageId: 'wa-1' },
        { metadata: { reactions: { alice: '👍' } } },
      );
    });

    it('removes a sender reaction on a cleared reaction event (delete branch)', async () => {
      const callbacks = await startAndCaptureCallbacks();
      type Row = { metadata?: Record<string, unknown> };
      const clone = (r: Row): Row => JSON.parse(JSON.stringify(r)) as Row;
      let stored: Row = { metadata: { reactions: { alice: '👍', bob: '🎉' } } };
      (messageRepository.findOne as jest.Mock).mockImplementation(() => Promise.resolve(clone(stored)));
      (messageRepository.update as jest.Mock).mockImplementation((_c: unknown, patch: Row) => {
        stored = clone({ ...stored, ...patch });
        return Promise.resolve({ affected: 1 });
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
      (messageRepository.update as jest.Mock)
        .mockRejectedValueOnce(new Error('write blip')) // alice's write fails
        .mockImplementation((_c: unknown, patch: Row) => {
          stored = clone({ ...stored, ...patch });
          return Promise.resolve({ affected: 1 });
        });

      callbacks.onMessageReaction!({ messageId: 'wa-1', chatId: 'c', senderId: 'alice', reaction: '👍' });
      callbacks.onMessageReaction!({ messageId: 'wa-1', chatId: 'c', senderId: 'bob', reaction: '🎉' });

      for (let i = 0; i < 5; i++) await flush();

      expect(stored.metadata?.reactions).toEqual({ bob: '🎉' }); // bob applied despite alice's failure
    });

    it('cleans up the per-message serialization entry after the chain drains (no leak)', async () => {
      const callbacks = await startAndCaptureCallbacks();
      (messageRepository.findOne as jest.Mock).mockResolvedValue({ metadata: {} });
      (messageRepository.update as jest.Mock).mockResolvedValue({ affected: 1 });

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
      (messageRepository.update as jest.Mock).mockImplementation((_c: unknown, patch: Row) => {
        stored = clone({ ...stored, ...patch });
        return Promise.resolve({ affected: 1 });
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

    it('skips persist and dispatch for ephemeral messages when STORE_EPHEMERAL_MESSAGES=false', async () => {
      process.env.STORE_EPHEMERAL_MESSAGES = 'false';
      const callbacks = await startAndCaptureCallbacks();
      (messageRepository.insert as jest.Mock).mockClear();

      callbacks.onMessage!(makeMessage({ id: 'wa-eph-1', ephemeralDuration: 86400 }));
      await flush();

      expect(messageRepository.insert).not.toHaveBeenCalled();
      expect(dispatchedEvents('message.received')).toHaveLength(0);
      delete process.env.STORE_EPHEMERAL_MESSAGES;
    });

    it('still persists ephemeral messages when STORE_EPHEMERAL_MESSAGES is unset (default)', async () => {
      delete process.env.STORE_EPHEMERAL_MESSAGES;
      const callbacks = await startAndCaptureCallbacks();
      (messageRepository.insert as jest.Mock).mockClear();

      callbacks.onMessage!(makeMessage({ id: 'wa-eph-2', ephemeralDuration: 86400 }));
      await flush();

      expect(messageRepository.insert).toHaveBeenCalled();
      expect(dispatchedEvents('message.received')).toHaveLength(1);
    });

    it('emits message:persisted with a non-empty message.id on inbound (insert generated PK merged)', async () => {
      // Asymmetry guard: the inbound path uses `insert()` (the dedup oracle), which — unlike `save()` —
      // does NOT merge @PrimaryGeneratedColumn/@CreateDateColumn back onto the entity. Without the
      // identifiers/generatedMaps merge, `dbMessage.id` is undefined here, while the outbound path
      // (MessageService.saveOutgoingMessage) emits a real id via `save()`. A plugin subscribing to
      // `message:persisted` would see id=undefined on inbound but a real id on outbound. This pins the
      // inbound payload to carry the DB-generated id, mirroring the outbound emit test.
      const callbacks = await startAndCaptureCallbacks();

      callbacks.onMessage!(makeMessage({ id: 'wa-in-1', fromMe: false }));
      await flush();

      const persistedCalls = (hookManager.execute as jest.Mock).mock.calls.filter(
        ([ev]: unknown[]) => ev === 'message:persisted',
      ) as unknown[][];
      expect(persistedCalls).toHaveLength(1);
      const payload = persistedCalls[0][1] as { sessionId: string; message: { id?: string } };
      expect(payload.sessionId).toBe('sess-uuid-1');
      expect(payload.message.id).toBeTruthy(); // the DB-generated id, not undefined
      expect(payload.message.id).toBe('gen-uuid-1'); // merged from InsertResult.identifiers[0]
      expect(persistedCalls[0][2]).toMatchObject({ sessionId: 'sess-uuid-1', source: 'SessionService' });
    });

    it('does not emit message:persisted on a duplicate re-fire (loses the dedup insert race)', async () => {
      // The emit lives AFTER the dedup gate. A re-fire that hits the UNIQUE(sessionId, waMessageId)
      // constraint must not emit message:persisted — no row was durably stored on this attempt.
      const callbacks = await startAndCaptureCallbacks();
      // Emulate the SQLite UNIQUE-violation phrasing that `isUniqueConstraintError` matches via regex.
      (messageRepository.insert as jest.Mock).mockRejectedValueOnce(
        new Error('UNIQUE constraint failed: messages.sessionId, messages.waMessageId'),
      );

      callbacks.onMessage!(makeMessage({ id: 'wa-dup-1', fromMe: false }));
      await flush();

      const persistedCalls = (hookManager.execute as jest.Mock).mock.calls.filter(
        ([ev]: unknown[]) => ev === 'message:persisted',
      );
      expect(persistedCalls).toHaveLength(0);
    });

    it('does not emit message:persisted when insert throws a transient (non-unique) error', async () => {
      // Fail-open on transient DB errors (SQLITE_BUSY, lock-timeout, connection drop) is correct for
      // webhook/WS dispatch — a real inbound message must never be dropped. But the row was never
      // stored and dbMessage.id is undefined, so the message:persisted hook must NOT fire (it would
      // hand plugins an id-less payload for a row that isn't in the DB). The hook is gated on a
      // `persisted` flag set only after the generated-maps merge succeeds. Webhook/WS still dispatch.
      const callbacks = await startAndCaptureCallbacks();
      (messageRepository.insert as jest.Mock).mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));

      callbacks.onMessage!(makeMessage({ id: 'wa-busy-1', fromMe: false }));
      await flush();

      const persistedCalls = (hookManager.execute as jest.Mock).mock.calls.filter(
        ([ev]: unknown[]) => ev === 'message:persisted',
      );
      expect(persistedCalls).toHaveLength(0);
      // Fail-open: webhook still dispatched so the inbound message is not silently dropped. (The
      // payload is `{}` here because the hook mock returns `data: {}`; the point is that dispatch
      // fired at all on a transient DB error — only the message:persisted hook is gated on `persisted`.)
      expect(webhookService.dispatch).toHaveBeenCalledWith('sess-uuid-1', 'message.received', expect.anything());
    });

    it('does not persist (no orphan row) when the session is deleted mid hook chain', async () => {
      // onMessage gates on isLiveEngine synchronously at entry, then awaits the message:received hook
      // chain before inserting. If delete() completes during that await (the engine leaves the live
      // map), a late continuation must NOT insert: the messages row has no FK, so an orphan persisted
      // here is exactly what the session-delete cleanup is meant to prevent.
      const callbacks = await startAndCaptureCallbacks();
      (messageRepository.insert as jest.Mock).mockClear();
      (webhookService.dispatch as jest.Mock).mockClear();
      const engines = (service as unknown as { engines: Map<string, unknown> }).engines;

      // Tear the session out of the live map while message:received is still awaiting.
      (hookManager.execute as jest.Mock).mockImplementationOnce((_event: string, data: unknown) => {
        engines.delete('sess-uuid-1');
        return Promise.resolve({ continue: true, data });
      });

      callbacks.onMessage!(makeMessage({ id: 'wa-orphan-1', fromMe: false }));
      await flush();

      expect(messageRepository.insert).not.toHaveBeenCalled();
      expect(dispatchedEvents('message.received')).toHaveLength(0);
    });

    it('does not process an own-send status echo (type=append) — no dispatch, no WS emit, no DB write', async () => {
      // Regression guard for the WhatsApp Status feature: posting a status produces an own-send echo
      // that Baileys delivers as `messages.upsert` with `type: 'append'` (NOT 'notify'). The adapter's
      // handleMessagesUpsert filters `type !== 'notify'` before processInboundMessage, so the echo never
      // reaches the engine callbacks. This test pins the engine-neutral last-chance guard —
      // `isStatusBroadcast` on both onMessageCreate and onMessage — so a future change can't silently
      // leak a status echo to websockets, webhooks, or the message table. Asserts the full no-side-effect
      // contract (webhook dispatch + WS emit + DB insert) for completeness, even though the existing
      // isStatusBroadcast tests above already cover the dispatch-only slice.
      const callbacks = await startAndCaptureCallbacks();
      (webhookService.dispatch as jest.Mock).mockClear();
      (eventsGateway.emitMessage as jest.Mock).mockClear();
      (eventsGateway.emitMessageSent as jest.Mock).mockClear();
      (messageRepository.insert as jest.Mock).mockClear();

      const statusEcho = makeMessage({
        id: 'wa-status-echo',
        from: 'me@c.us',
        to: 'status@broadcast',
        chatId: 'status@broadcast',
        fromMe: true,
        isStatusBroadcast: true,
      });

      // An own-send echo could in principle surface via either callback path; assert neither dispatches.
      callbacks.onMessageCreate!(statusEcho);
      callbacks.onMessage!(statusEcho);
      await flush();

      expect(webhookService.dispatch).not.toHaveBeenCalled();
      expect(eventsGateway.emitMessage).not.toHaveBeenCalled();
      expect(eventsGateway.emitMessageSent).not.toHaveBeenCalled();
      expect(messageRepository.insert).not.toHaveBeenCalled();
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
        // #583 R3 Phase 2: the resolved inbound @lid -> phone is persisted so the read-path can bridge
        // this contact's @lid and @c.us rows even if the operator never sent to them.
        expect(lidMappingStore.remember).toHaveBeenCalledWith('111', '628111222333', expect.any(String));
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

    it('flags the DB row by revokedId (the original), not the revocation notification id', async () => {
      const callbacks = await startAndCaptureCallbacks();

      // wwebjs shape: `id` is the revocation notification, `revokedId` the original message.
      callbacks.onMessageRevoked!({
        id: 'REVOKE_NOTIF',
        revokedId: 'ORIGINAL_MSG',
        chatId: 'peer@c.us',
        from: 'peer@c.us',
        to: 'me@c.us',
        type: 'revoked',
        body: '',
        timestamp: 1706868000,
      });
      await flush();

      expect(messageRepository.update as jest.Mock).toHaveBeenCalledWith(
        { sessionId: 'sess-uuid-1', waMessageId: 'ORIGINAL_MSG' },
        { body: '', type: 'revoked' },
      );

      // The DB flag is an internal side effect; the delivered payload is the public contract
      // this fix exists for. Webhook and WS consumers must receive `revokedId` (the original),
      // not just the revocation-notification `id`, so they can reconcile the deleted message.
      expect(dispatchedEvents('message.revoked')[0][2]).toEqual(
        expect.objectContaining({ id: 'REVOKE_NOTIF', revokedId: 'ORIGINAL_MSG' }),
      );
      expect(eventsGateway.emitMessageRevoked as jest.Mock).toHaveBeenCalledWith(
        'sess-uuid-1',
        expect.objectContaining({ id: 'REVOKE_NOTIF', revokedId: 'ORIGINAL_MSG' }),
      );
    });

    it('falls back to `id` for the DB flag when revokedId is absent (Baileys shape)', async () => {
      const callbacks = await startAndCaptureCallbacks();

      callbacks.onMessageRevoked!({
        id: 'ORIGINAL_MSG',
        chatId: 'peer@c.us',
        from: 'peer@c.us',
        to: 'me@c.us',
        type: 'revoked',
        body: '',
        timestamp: 1706868000,
      });
      await flush();

      expect(messageRepository.update as jest.Mock).toHaveBeenCalledWith(
        { sessionId: 'sess-uuid-1', waMessageId: 'ORIGINAL_MSG' },
        { body: '', type: 'revoked' },
      );
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

    it('does not double-EMIT session.status over WS when the same status is reported twice', async () => {
      const callbacks = await startAndCaptureCallbacks();
      (eventsGateway.emitSessionStatus as jest.Mock).mockClear();
      callbacks.onStateChanged!(EngineStatus.QR_READY);
      callbacks.onQRCode!('qr-data-abc'); // same QR_READY transition, second signal
      await flush();

      const qrEmits = ((eventsGateway.emitSessionStatus as jest.Mock).mock.calls as unknown[][]).filter(
        c => c[1] === SessionStatus.QR_READY,
      );
      expect(qrEmits).toHaveLength(1);
    });

    it('persists and dispatches message.received only once when the engine re-fires the same message', async () => {
      const callbacks = await startAndCaptureCallbacks();
      (messageRepository.insert as jest.Mock).mockReset();
      (webhookService.dispatch as jest.Mock).mockClear();
      (messageRepository.insert as jest.Mock)
        .mockResolvedValueOnce(undefined) // first delivery: new row
        .mockRejectedValueOnce({
          driverError: { code: 'SQLITE_CONSTRAINT_UNIQUE', message: 'UNIQUE constraint failed' },
        }); // re-fire

      const msg: IncomingMessage = {
        id: 'wa-1',
        from: 'peer@c.us',
        to: 'me@c.us',
        chatId: 'peer@c.us',
        body: 'hi',
        type: 'text',
        timestamp: 1,
        fromMe: false,
        isGroup: false,
      };
      callbacks.onMessage?.(msg);
      await flush();
      callbacks.onMessage?.(msg); // re-fired engine event
      await flush();

      expect(messageRepository.insert).toHaveBeenCalledTimes(2);
      expect(
        ((webhookService.dispatch as jest.Mock).mock.calls as unknown[][]).filter(c => c[1] === 'message.received'),
      ).toHaveLength(1);
    });

    it('still dispatches message.received when the insert fails with a non-constraint error (fail-open)', async () => {
      const callbacks = await startAndCaptureCallbacks();
      (messageRepository.insert as jest.Mock).mockReset();
      (webhookService.dispatch as jest.Mock).mockClear();
      (messageRepository.insert as jest.Mock).mockRejectedValueOnce(new Error('db down'));

      callbacks.onMessage?.({
        id: 'wa-2',
        from: 'peer@c.us',
        to: 'me@c.us',
        chatId: 'peer@c.us',
        body: 'hi',
        type: 'text',
        timestamp: 1,
        fromMe: false,
        isGroup: false,
      });
      await flush();

      expect(
        ((webhookService.dispatch as jest.Mock).mock.calls as unknown[][]).filter(c => c[1] === 'message.received'),
      ).toHaveLength(1);
    });

    // ── persistHistoryMessages collision tolerance ───────────────────
    describe('persistHistoryMessages collision tolerance', () => {
      it('uses an insert-or-ignore bulk insert so a colliding history row cannot abort the batch', async () => {
        const callbacks = await startAndCaptureCallbacks();
        const execute = jest.fn().mockResolvedValue({ identifiers: [] });
        const qb = {
          insert: jest.fn().mockReturnThis(),
          values: jest.fn().mockReturnThis(),
          orIgnore: jest.fn().mockReturnThis(),
          execute,
        };
        (messageRepository.createQueryBuilder as jest.Mock) = jest.fn().mockReturnValue(qb);
        (messageRepository.find as jest.Mock).mockResolvedValue([]); // nothing pre-seen
        (messageRepository.create as jest.Mock).mockImplementation((data: Record<string, unknown>) => ({ ...data }));
        (messageRepository.save as jest.Mock).mockClear();

        callbacks.onHistoryMessages?.([
          {
            id: 'h1',
            from: 'peer@c.us',
            to: 'me@c.us',
            chatId: 'peer@c.us',
            body: 'old',
            type: 'text',
            timestamp: 1,
            fromMe: false,
            isGroup: false,
          },
        ]);
        await flush();

        expect(qb.orIgnore).toHaveBeenCalled();
        expect(execute).toHaveBeenCalled();
        expect(messageRepository.save).not.toHaveBeenCalled(); // no longer the throwing path
      });
    });

    // ── persistHistoryMessages STORE_EPHEMERAL_MESSAGES guard ────────
    describe('persistHistoryMessages ephemeral guard', () => {
      const setupBulkQb = () => {
        const execute = jest.fn().mockResolvedValue({ identifiers: [] });
        const qb = {
          insert: jest.fn().mockReturnThis(),
          values: jest.fn().mockReturnThis(),
          orIgnore: jest.fn().mockReturnThis(),
          execute,
        };
        (messageRepository.createQueryBuilder as jest.Mock) = jest.fn().mockReturnValue(qb);
        (messageRepository.find as jest.Mock).mockResolvedValue([]);
        (messageRepository.create as jest.Mock).mockImplementation((data: Record<string, unknown>) => ({ ...data }));
        return { qb, execute };
      };

      it('skips a disappearing history message when STORE_EPHEMERAL_MESSAGES=false', async () => {
        process.env.STORE_EPHEMERAL_MESSAGES = 'false';
        const callbacks = await startAndCaptureCallbacks();
        const { qb, execute } = setupBulkQb();

        callbacks.onHistoryMessages?.([
          {
            id: 'h-eph',
            from: 'peer@c.us',
            to: 'me@c.us',
            chatId: 'peer@c.us',
            body: 'vanishing',
            type: 'text',
            timestamp: 1,
            fromMe: false,
            isGroup: false,
            ephemeralDuration: 86400,
          },
        ]);
        await flush();

        // The guard dropped the only message before de-dup, so the bulk insert was never reached.
        expect(qb.values).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
        delete process.env.STORE_EPHEMERAL_MESSAGES;
      });

      it('still persists a disappearing history message when STORE_EPHEMERAL_MESSAGES is unset (default)', async () => {
        delete process.env.STORE_EPHEMERAL_MESSAGES;
        const callbacks = await startAndCaptureCallbacks();
        const { qb } = setupBulkQb();

        callbacks.onHistoryMessages?.([
          {
            id: 'h-eph-default',
            from: 'peer@c.us',
            to: 'me@c.us',
            chatId: 'peer@c.us',
            body: 'vanishing',
            type: 'text',
            timestamp: 1,
            fromMe: false,
            isGroup: false,
            ephemeralDuration: 86400,
          },
        ]);
        await flush();

        expect(qb.values).toHaveBeenCalledTimes(1);
        const calls = qb.values.mock.calls as unknown[][];
        const insertedRows = calls[0][0] as { waMessageId: string }[];
        expect(insertedRows).toHaveLength(1);
        expect(insertedRows[0].waMessageId).toBe('h-eph-default');
      });

      it('persists a non-disappearing history message even with STORE_EPHEMERAL_MESSAGES=false', async () => {
        process.env.STORE_EPHEMERAL_MESSAGES = 'false';
        const callbacks = await startAndCaptureCallbacks();
        const { qb } = setupBulkQb();

        callbacks.onHistoryMessages?.([
          {
            id: 'h-normal',
            from: 'peer@c.us',
            to: 'me@c.us',
            chatId: 'peer@c.us',
            body: 'stays',
            type: 'text',
            timestamp: 1,
            fromMe: false,
            isGroup: false,
            // no ephemeralDuration — a regular chat message must never be dropped.
          },
        ]);
        await flush();

        expect(qb.values).toHaveBeenCalledTimes(1);
        const calls = qb.values.mock.calls as unknown[][];
        const insertedRows = calls[0][0] as { waMessageId: string }[];
        expect(insertedRows).toHaveLength(1);
        expect(insertedRows[0].waMessageId).toBe('h-normal');
        delete process.env.STORE_EPHEMERAL_MESSAGES;
      });
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
    const makeStatsQb = (rows: Array<{ status: string; count: string }>) => ({
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(rows),
    });

    it('should return correct session statistics', async () => {
      (repository.createQueryBuilder as jest.Mock) = jest.fn().mockReturnValue(
        makeStatsQb([
          { status: SessionStatus.READY, count: '2' },
          { status: SessionStatus.DISCONNECTED, count: '1' },
        ]),
      );

      const stats = await service.getStats();

      expect(stats.total).toBe(3);
      expect(stats.ready).toBe(2);
      expect(stats.disconnected).toBe(1);
      expect(stats.byStatus[SessionStatus.READY]).toBe(2);
      expect(stats.memoryUsage).toBeDefined();
    });

    it('counts every session via a grouped COUNT, not the bounded findAll (no undercount past the cap)', async () => {
      const findSpy = repository.find as jest.Mock;
      findSpy.mockClear();
      (repository.createQueryBuilder as jest.Mock) = jest
        .fn()
        .mockReturnValue(makeStatsQb([{ status: SessionStatus.READY, count: '1500' }]));

      const stats = await service.getStats();

      // 1500 > DEFAULT_LIST_LIMIT (1000): the old findAll-based path would have capped total at 1000.
      expect(stats.total).toBe(1500);
      expect(stats.ready).toBe(1500);
      expect(findSpy).not.toHaveBeenCalled();
    });

    it('scopes the stats to a restricted key (active counts only in-scope engines)', async () => {
      const qb = makeStatsQb([{ status: SessionStatus.READY, count: '1' }]);
      (repository.createQueryBuilder as jest.Mock) = jest.fn().mockReturnValue(qb);
      const engines = (service as unknown as { engines: Map<string, unknown> }).engines;
      engines.set('sess-A', {});
      engines.set('sess-B', {}); // global engine the scoped key must NOT see counted

      const stats = await service.getStats(['sess-A']);

      expect(qb.where).toHaveBeenCalledWith('session.id IN (:...scope)', { scope: ['sess-A'] });
      expect(stats.total).toBe(1);
      expect(stats.active).toBe(1); // not 2 (global engines.size)
      engines.clear();
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

    it('tears down the just-initialized engine if the session is deleted during start() (row gone, mark cleared)', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      // Unlike a stop(), a concurrent delete() clears its teardown mark in finally AND removes the
      // session row before this init resolves — the mark alone can't catch it, so the post-init guard
      // must re-check existence. start() then surfaces the now-missing session as NotFound.
      mockEngine.initialize.mockImplementationOnce(() => {
        (service as unknown as { stoppingSessions: Set<string> }).stoppingSessions.delete('sess-uuid-1');
        (repository.findOne as jest.Mock).mockResolvedValue(null);
        return Promise.resolve();
      });

      await expect(service.start('sess-uuid-1')).rejects.toThrow(NotFoundException);

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
