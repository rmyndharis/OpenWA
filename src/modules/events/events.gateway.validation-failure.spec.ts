import 'reflect-metadata';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import type { ModuleRef } from '@nestjs/core';
import type { ConfigService } from '@nestjs/config';
import type { Socket } from 'socket.io';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';
import { AuthService } from '../auth/auth.service';
import { ApiKeyUsageTracker } from '../auth/api-key-usage-tracker.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction, AuditLog } from '../audit/entities/audit-log.entity';
import { EventsGateway } from './events.gateway';
import type { WSErrorResponse, WSSubscribedResponse } from './dto/ws-messages.dto';

/**
 * A key the gateway could not read is not a key it refused. When the key table fails, the handshake and the
 * subscribe answer a server failure, as the REST guard lets the error through as a 500, and no
 * API_KEY_AUTH_FAILED row is written for a credential nobody judged. Real AuthService and AuditService over
 * in-memory SQLite; only the key lookup is made to fail.
 */
describe('EventsGateway when the API key table cannot be read', () => {
  const SESSION = 'a0b1c2d3-0000-4000-8000-000000000002';

  let ds: DataSource;
  let keys: Repository<ApiKey>;
  let audits: Repository<AuditLog>;
  let service: AuthService;
  let gateway: EventsGateway;

  const makeSocket = (apiKey: unknown) => {
    const sock = {
      id: 'sock-db',
      handshake: { headers: {}, query: {}, auth: { apiKey }, address: '203.0.113.31' },
      data: {} as Record<string, unknown>,
      emit: jest.fn(),
      disconnect: jest.fn(() => {
        sock.disconnected = true;
      }),
      join: jest.fn(),
      leave: jest.fn(),
      rooms: new Set<string>(),
      disconnected: false,
    };
    return sock;
  };
  const lookupFailsOnce = (): void => {
    jest
      .spyOn(keys, 'findOne')
      .mockRejectedValueOnce(new QueryFailedError('SELECT', [], new Error('SQLITE_BUSY: database is locked')));
  };
  const codes = (sock: ReturnType<typeof makeSocket>): string[] =>
    sock.emit.mock.calls.map(([, frame]) => (frame as WSErrorResponse).code);
  const failedRows = async (): Promise<AuditLog[]> => {
    await new Promise(resolve => setTimeout(resolve, 20));
    return audits.find({ where: { action: AuditAction.API_KEY_AUTH_FAILED } });
  };

  beforeAll(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [ApiKey, AuditLog],
      synchronize: true,
    });
    await ds.initialize();
    keys = ds.getRepository(ApiKey);
    audits = ds.getRepository(AuditLog);
  });

  afterAll(async () => {
    await ds.destroy();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await keys.clear();
    await audits.clear();
    const moduleRef = { get: () => gateway } as unknown as ModuleRef;
    service = new AuthService(keys, new ApiKeyUsageTracker(keys), moduleRef);
    gateway = new EventsGateway(service, new AuditService(audits), {
      get: (_key: string, fallback?: unknown) => fallback,
    } as unknown as ConfigService);
  });

  it('answers the handshake as a server failure and audits no refused credential', async () => {
    const { rawKey } = await service.createApiKey({ name: 'db down at connect', role: ApiKeyRole.VIEWER });
    lookupFailsOnce();
    const sock = makeSocket(rawKey);
    await gateway.handleConnection(sock as unknown as Socket);

    expect(codes(sock)).toEqual(['INTERNAL_ERROR']);
    expect(sock.disconnect).toHaveBeenCalled();
    expect(await failedRows()).toEqual([]);
  });

  it('answers the subscribe as a server failure, keeps the socket and joins nothing', async () => {
    const { rawKey } = await service.createApiKey({ name: 'db down at subscribe', role: ApiKeyRole.VIEWER });
    const sock = makeSocket(rawKey);
    await gateway.handleConnection(sock as unknown as Socket);
    expect(sock.disconnect).not.toHaveBeenCalled();

    lookupFailsOnce();
    const failed = (await gateway.handleMessage(sock as unknown as Socket, {
      type: 'subscribe',
      sessionId: SESSION,
      events: ['message.received'],
    })) as WSErrorResponse;
    expect(failed.code).toBe('INTERNAL_ERROR');
    expect(sock.disconnect).not.toHaveBeenCalled();
    expect(sock.join).not.toHaveBeenCalled();
    expect(await failedRows()).toEqual([]);

    // Once the table answers again the same socket subscribes normally.
    const retried = (await gateway.handleMessage(sock as unknown as Socket, {
      type: 'subscribe',
      sessionId: SESSION,
      events: ['message.received'],
    })) as WSSubscribedResponse;
    expect(retried.type).toBe('subscribed');
  });

  it('still refuses and audits a handshake whose key is not a string', async () => {
    const sock = makeSocket(12345);
    await gateway.handleConnection(sock as unknown as Socket);

    expect(codes(sock)).toEqual(['UNAUTHORIZED']);
    expect(sock.disconnect).toHaveBeenCalled();
    expect(await failedRows()).toHaveLength(1);
  });
});
