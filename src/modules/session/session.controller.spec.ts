import type { SessionController } from './session.controller';
import { SessionController as SessionControllerClass } from './session.controller';
import { SessionStatus } from './entities/session.entity';
import type { Session } from './entities/session.entity';
import type { SessionService } from './session.service';
import type { AuditService } from '../audit/audit.service';

// POST /sessions declared a SessionResponseDto in its Swagger metadata but returned the raw
// TypeORM entity, leaking internal columns (config, proxyUrl, proxyType) and the entity-only
// lastActiveAt name. The response must go through the same SessionResponseDto.fromEntity mapping
// as every sibling endpoint.
describe('SessionController — create() response contract', () => {
  const entity: Session = {
    id: 'sess-uuid-1',
    name: 'test-session',
    status: SessionStatus.CREATED,
    phone: null,
    pushName: null,
    config: { engine: 'whatsapp-web.js', webhook: 'https://internal.example/hook' },
    proxyUrl: 'http://user:pass@proxy.internal:8080',
    proxyType: 'http',
    connectedAt: null,
    lastActiveAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };

  let sessionService: { create: jest.Mock };
  let auditService: { logInfo: jest.Mock };
  let controller: SessionController;

  beforeEach(() => {
    sessionService = { create: jest.fn().mockResolvedValue({ ...entity }) };
    auditService = { logInfo: jest.fn().mockResolvedValue(undefined) };
    controller = new SessionControllerClass(
      sessionService as unknown as SessionService,
      auditService as unknown as AuditService,
    );
  });

  it('strips internal entity fields from the response', async () => {
    const result = await controller.create({ name: 'test-session' });

    expect(result).not.toHaveProperty('config');
    expect(result).not.toHaveProperty('proxyUrl');
    expect(result).not.toHaveProperty('proxyType');
    expect(result).not.toHaveProperty('lastActiveAt');
  });

  it('keeps every documented SessionResponseDto field', async () => {
    const result = await controller.create({ name: 'test-session' });

    expect(result).toEqual({
      id: entity.id,
      name: entity.name,
      status: entity.status,
      phone: entity.phone,
      pushName: entity.pushName,
      connectedAt: entity.connectedAt,
      lastActive: entity.lastActiveAt,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      lastError: null,
    });
  });

  it('still audits the creation with the session id and name', async () => {
    await controller.create({ name: 'test-session' });

    expect(auditService.logInfo).toHaveBeenCalledWith(
      'session_created',
      expect.objectContaining({ sessionId: entity.id, sessionName: entity.name }),
    );
  });
});
