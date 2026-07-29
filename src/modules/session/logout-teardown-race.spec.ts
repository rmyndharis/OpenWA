import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { BadGatewayException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SessionService } from './session.service';
import { Session, SessionStatus } from './entities/session.entity';
import { Message } from '../message/entities/message.entity';
import { EngineFactory } from '../../engine/engine.factory';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { EventsGateway } from '../events/events.gateway';
import { WebhookService } from '../webhook/webhook.service';
import { HookManager } from '../../core/hooks';
import { StatusStoreService } from '../status-store/status-store.service';

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

describe('SessionService logout() concurrent teardown tracking', () => {
  let service: SessionService;
  let repository: jest.Mocked<Partial<Repository<Session>>>;
  let engineFactory: jest.Mocked<Partial<EngineFactory>>;

  beforeEach(async () => {
    repository = {
      findOne: jest.fn().mockResolvedValue(createMockSession()),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const messageRepository = { find: jest.fn().mockResolvedValue([]) };
    const manager = { delete: jest.fn().mockResolvedValue({ affected: 1 }), remove: jest.fn() };
    const dataSource: Partial<DataSource> = {
      transaction: jest.fn(async (cb: (m: unknown) => Promise<void>) =>
        cb(manager),
      ) as unknown as DataSource['transaction'],
    };
    const mockEngine = {
      initialize: jest.fn().mockResolvedValue(undefined),
      destroy: jest.fn().mockResolvedValue(undefined),
      forceDestroy: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      getQRCode: jest.fn().mockReturnValue(null),
    };
    engineFactory = {
      create: jest.fn().mockReturnValue(mockEngine),
      purgeSessionData: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SessionService,
        { provide: getRepositoryToken(Session, 'data'), useValue: repository },
        { provide: getRepositoryToken(Message, 'data'), useValue: messageRepository },
        { provide: getDataSourceToken('data'), useValue: dataSource },
        { provide: EngineFactory, useValue: engineFactory },
        {
          provide: EventsGateway,
          useValue: { emitSessionStatus: jest.fn(), emitSessionDisconnected: jest.fn(), emitQRCode: jest.fn() },
        },
        { provide: WebhookService, useValue: { dispatch: jest.fn().mockResolvedValue(undefined) } },
        { provide: HookManager, useValue: { execute: jest.fn().mockResolvedValue({ continue: true, data: {} }) } },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockImplementation(<T>(_k: string, d?: T): T => d as T) },
        },
        { provide: LidMappingStoreService, useValue: { remember: jest.fn() } },
        { provide: StatusStoreService, useValue: { ingest: jest.fn() } },
      ],
    }).compile();

    service = module.get<SessionService>(SessionService);
  });

  const enginesOf = () => (service as unknown as { engines: Map<string, unknown> }).engines;
  const pendingOf = () => (service as unknown as { pendingTeardowns: Map<string, Promise<void>> }).pendingTeardowns;

  it('keeps the first teardown tracked when a second logout arrives mid-flight, so start() waits for it', async () => {
    // The first logout's teardown wedges (its profile fs.rm outlives the request); the second
    // logout's adapter call refuses immediately (the client is already being torn down).
    let settleFirst: () => void = () => undefined;
    const wedgedLogout = new Promise<void>(resolve => {
      settleFirst = resolve;
    });

    const logout = jest
      .fn()
      .mockReturnValueOnce(wedgedLogout)
      .mockReturnValueOnce(Promise.reject(new Error('No live WhatsApp Web client — the unlink was not sent')));

    enginesOf().set('sess-uuid-1', { logout });

    jest.useFakeTimers();
    try {
      const first = service.logout('sess-uuid-1');
      // let logout1 get past findOne and register its pendingTeardowns entry
      await jest.advanceTimersByTimeAsync(0);
      expect(pendingOf().has('sess-uuid-1')).toBe(true);

      // ---- a separate HTTP request, a macrotask later ----
      const second = service.logout('sess-uuid-1');
      await expect(second).rejects.toBeInstanceOf(BadGatewayException);
      expect(logout).toHaveBeenCalledTimes(2); // engine still in the map => 2nd logout passed the guard

      // The first (still-running) teardown must stay tracked: its late profile rm must gate start().
      expect(pendingOf().has('sess-uuid-1')).toBe(true);

      // start() must NOT re-create the profile while the first teardown's rm is pending.
      const startCall = service.start('sess-uuid-1');
      await jest.advanceTimersByTimeAsync(0);
      expect(engineFactory.create).not.toHaveBeenCalled();

      // Once the first teardown settles, start() proceeds.
      settleFirst();
      await jest.advanceTimersByTimeAsync(0);
      await expect(first).resolves.toMatchObject({ id: 'sess-uuid-1' });
      await jest.advanceTimersByTimeAsync(0);
      expect(engineFactory.create).toHaveBeenCalledTimes(1);
      await startCall;

      // Entry cleaned up after everything settled.
      expect(pendingOf().has('sess-uuid-1')).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('drops a wedged logout teardown entry when the session is deleted', async () => {
    // A logout teardown that never settles keeps its pendingTeardowns entry past the bounded waits;
    // deleting the session must drop it — the UUID can never be read again, so leaving it would
    // grow the map without bound across logout-fail/delete churn.
    const wedgedLogout = new Promise<void>(() => undefined);
    const logout = jest.fn().mockReturnValue(wedgedLogout);
    enginesOf().set('sess-uuid-1', { logout });

    jest.useFakeTimers();
    try {
      const logoutCall = service.logout('sess-uuid-1');
      await jest.advanceTimersByTimeAsync(10_000); // teardown loses its deadline race
      await expect(logoutCall).rejects.toBeInstanceOf(BadGatewayException);
      expect(pendingOf().has('sess-uuid-1')).toBe(true); // the wedged raw keeps its entry

      const deleteCall = service.delete('sess-uuid-1');
      await jest.advanceTimersByTimeAsync(10_000); // delete's bounded wait elapses
      await deleteCall;
      expect(pendingOf().has('sess-uuid-1')).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});
