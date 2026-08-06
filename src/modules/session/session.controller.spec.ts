import type { SessionController } from './session.controller';
import { SessionController as SessionControllerClass } from './session.controller';
import { SessionStatus } from './entities/session.entity';
import type { Session } from './entities/session.entity';
import type { SessionService } from './session.service';
import type { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { BadGatewayException } from '@nestjs/common';

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
    nodeId: null,
    claimedAt: null,
    nodeUrl: null,
    leaseExpiresAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };

  let sessionService: { create: jest.Mock; isActive: jest.Mock };
  let auditService: { logInfo: jest.Mock };
  let controller: SessionController;

  beforeEach(() => {
    // transformSession reads live engine state for `engineLoaded`; a freshly created session has no
    // engine yet, which is what the response must say.
    sessionService = { create: jest.fn().mockResolvedValue({ ...entity }), isActive: jest.fn().mockReturnValue(false) };
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
      restriction: null,
      engineLoaded: false,
    });
  });

  // engineLoaded is live process state, not an entity column, so the only thing that can get it wrong
  // is the wiring. Assert both answers come from the service rather than from the row's status.
  it('reports engineLoaded from the live engine map, not from the row status', async () => {
    sessionService.isActive.mockReturnValue(true);

    const result = await controller.create({ name: 'test-session' });

    expect(result.engineLoaded).toBe(true);
    expect(sessionService.isActive).toHaveBeenCalledWith(entity.id);
  });

  it('still audits the creation with the session id and name', async () => {
    await controller.create({ name: 'test-session' });

    expect(auditService.logInfo).toHaveBeenCalledWith(
      'session_created',
      expect.objectContaining({ sessionId: entity.id, sessionName: entity.name }),
    );
  });
});

// POST /sessions/:id/logout audits SESSION_LOGGED_OUT only after the service resolves — an
// incomplete engine-backed attempt (502 SESSION_LOGOUT_INCOMPLETE) must NOT record a success
// audit row, and the service's structured rejection must be forwarded verbatim.
describe('SessionController — logout() audit + error forwarding contract', () => {
  const loggedOutEntity: Session = {
    id: 'sess-uuid-1',
    name: 'test-session',
    status: SessionStatus.DISCONNECTED,
    phone: null,
    pushName: null,
    config: {},
    proxyUrl: null,
    proxyType: null,
    connectedAt: null,
    lastActiveAt: null,
    nodeId: null,
    claimedAt: null,
    nodeUrl: null,
    leaseExpiresAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };

  let sessionService: { logout: jest.Mock; isActive: jest.Mock };
  let auditService: { logInfo: jest.Mock };
  let controller: SessionController;

  beforeEach(() => {
    sessionService = { logout: jest.fn(), isActive: jest.fn().mockReturnValue(false) };
    auditService = { logInfo: jest.fn().mockResolvedValue(undefined) };
    controller = new SessionControllerClass(
      sessionService as unknown as SessionService,
      auditService as unknown as AuditService,
    );
  });

  it('on a completed engine-backed unlink: returns a row carrying phone:null and writes exactly one SESSION_LOGGED_OUT audit row', async () => {
    sessionService.logout.mockResolvedValue({ ...loggedOutEntity, phone: null });

    const result = await controller.logout('sess-uuid-1');

    expect(result.phone).toBeNull();
    expect(auditService.logInfo).toHaveBeenCalledTimes(1);
    expect(auditService.logInfo).toHaveBeenCalledWith(
      AuditAction.SESSION_LOGGED_OUT,
      expect.objectContaining({ sessionId: loggedOutEntity.id, sessionName: loggedOutEntity.name }),
    );
  });

  it('on an incomplete engine-backed unlink (502): forwards the service rejection verbatim and does NOT write the SESSION_LOGGED_OUT audit row', async () => {
    // The service throws the structured 502 with the stable code; the controller must NOT swallow it
    // and must NOT record a success audit row for an unlink that never completed.
    const incomplete = new BadGatewayException({
      code: 'SESSION_LOGOUT_INCOMPLETE',
      message: 'Session was stopped locally, but the logout operation did not complete.',
    });
    sessionService.logout.mockRejectedValue(incomplete);

    await expect(controller.logout('sess-uuid-1')).rejects.toBe(incomplete);
    expect(auditService.logInfo).not.toHaveBeenCalled();
  });
});
