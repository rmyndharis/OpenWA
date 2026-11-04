import 'reflect-metadata';
import { DataSource, Repository } from 'typeorm';
import type { ModuleRef } from '@nestjs/core';
import type { ConfigService } from '@nestjs/config';
import type { Socket } from 'socket.io';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';
import { AuthService } from '../auth/auth.service';
import { ApiKeyUsageTracker } from '../auth/api-key-usage-tracker.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction, AuditLog } from '../audit/entities/audit-log.entity';
import { EventsGateway } from './events.gateway';

/**
 * A refusal of a STORED key over the socket names that key in its audit row, as the REST guard,
 * Bull Board and the MCP gate do. Real AuthService and AuditService over an in-memory SQLite main
 * database, so the assertion reads the persisted row whatever way the key reaches it.
 */
describe('EventsGateway audit rows for a refused stored key', () => {
  const CLIENT_IP = '203.0.113.9';

  let ds: DataSource;
  let keys: Repository<ApiKey>;
  let audits: Repository<AuditLog>;
  let service: AuthService;
  let gateway: EventsGateway;

  const makeSocket = (apiKey: string) => {
    const sock = {
      id: 'sock-attr',
      handshake: { headers: {}, query: {}, auth: { apiKey }, address: CLIENT_IP },
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

  const failedRows = async (): Promise<AuditLog[]> => {
    // logWarn is fire-and-forget in the gateway; let the insert settle.
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
    await keys.clear();
    await audits.clear();
    const moduleRef = { get: () => gateway } as unknown as ModuleRef;
    service = new AuthService(keys, new ApiKeyUsageTracker(keys), moduleRef);
    gateway = new EventsGateway(service, new AuditService(audits), {
      get: (_key: string, fallback?: unknown) => fallback,
    } as unknown as ConfigService);
  });

  it('names the key when a subscribe is refused because the key was revoked after connect', async () => {
    const { apiKey, rawKey } = await service.createApiKey({ name: 'ws revoked later', role: ApiKeyRole.VIEWER });
    const sock = makeSocket(rawKey);
    await gateway.handleConnection(sock as unknown as Socket);
    expect(sock.disconnect).not.toHaveBeenCalled();

    // Revoked outside this process's API (another admin tool, a direct write), so no eviction ran.
    await keys.update({ id: apiKey.id }, { isActive: false });
    await gateway.handleMessage(sock as unknown as Socket, {
      type: 'subscribe',
      sessionId: 'a0b1c2d3-0000-4000-8000-000000000001',
      events: ['message.received'],
    });
    expect(sock.disconnect).toHaveBeenCalled();

    const rows = await failedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].errorMessage).toBe('API key is revoked');
    expect({ apiKeyId: rows[0].apiKeyId, apiKeyName: rows[0].apiKeyName }).toEqual({
      apiKeyId: apiKey.id,
      apiKeyName: 'ws revoked later',
    });
  });

  it('names the key when the handshake is refused for an expired stored key', async () => {
    const { apiKey, rawKey } = await service.createApiKey({ name: 'ws expired', role: ApiKeyRole.VIEWER });
    await keys.update({ id: apiKey.id }, { expiresAt: new Date(Date.now() - 60_000) });

    const sock = makeSocket(rawKey);
    await gateway.handleConnection(sock as unknown as Socket);
    expect(sock.disconnect).toHaveBeenCalled();

    const rows = await failedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].errorMessage).toBe('API key has expired');
    expect(rows[0].apiKeyId).toBe(apiKey.id);
  });

  it('names no key when the handshake presents one that matches no row', async () => {
    await service.createApiKey({ name: 'bystander', role: ApiKeyRole.ADMIN });
    const sock = makeSocket('owa_k1_matches_no_row');
    await gateway.handleConnection(sock as unknown as Socket);
    expect(sock.disconnect).toHaveBeenCalled();

    const rows = await failedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].errorMessage).toBe('Invalid API key');
    expect({ apiKeyId: rows[0].apiKeyId, apiKeyName: rows[0].apiKeyName }).toEqual({
      apiKeyId: null,
      apiKeyName: null,
    });
  });

  it('writes the WebSocket row without a request id, as before', async () => {
    const { apiKey, rawKey } = await service.createApiKey({ name: 'ws shape', role: ApiKeyRole.VIEWER });
    await keys.update({ id: apiKey.id }, { isActive: false });
    await gateway.handleConnection(makeSocket(rawKey) as unknown as Socket);

    const rows = await failedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toEqual({ surface: 'websocket' });
  });
});
