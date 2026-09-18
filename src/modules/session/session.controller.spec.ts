import type { SessionController } from './session.controller';
import { SessionController as SessionControllerClass } from './session.controller';
import { SessionStatus } from './entities/session.entity';
import type { Session } from './entities/session.entity';
import type { SessionService } from './session.service';
import type { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import type { ApiKey } from '../auth/entities/api-key.entity';
import { BadGatewayException, BadRequestException, ConflictException } from '@nestjs/common';

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

// POST /sessions/:sessionId/logout audits SESSION_LOGGED_OUT only after the service resolves — an
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

// POST /sessions/:sessionId/start and /stop are thin, but they carry two contracts worth pinning: the
// success audit row is written ONLY after the service resolves (a refused lifecycle change — the
// engine-not-started 400, the foreign-node 409 — must leave no audit trace), and `engineLoaded`
// in the response comes from the live engine map, not from the row's status column.
describe('SessionController — start/stop lifecycle', () => {
  const runningEntity: Session = {
    id: 'sess-uuid-1',
    name: 'test-session',
    status: SessionStatus.READY,
    phone: '628123',
    pushName: null,
    config: {},
    proxyUrl: null,
    proxyType: null,
    connectedAt: new Date('2026-01-01T01:00:00Z'),
    lastActiveAt: null,
    nodeId: null,
    claimedAt: null,
    nodeUrl: null,
    leaseExpiresAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T01:00:00Z'),
  };

  let sessionService: { start: jest.Mock; stop: jest.Mock; forceKill: jest.Mock; isActive: jest.Mock };
  let auditService: { logInfo: jest.Mock };
  let controller: SessionController;

  beforeEach(() => {
    sessionService = {
      start: jest.fn(),
      stop: jest.fn(),
      forceKill: jest.fn(),
      isActive: jest.fn().mockReturnValue(false),
    };
    auditService = { logInfo: jest.fn().mockResolvedValue(undefined) };
    controller = new SessionControllerClass(
      sessionService as unknown as SessionService,
      auditService as unknown as AuditService,
    );
  });

  it('start returns the session with engineLoaded read from the live engine map', async () => {
    sessionService.start.mockResolvedValue({ ...runningEntity });
    sessionService.isActive.mockReturnValue(true);

    const result = await controller.start('sess-uuid-1');

    expect(result.status).toBe(SessionStatus.READY);
    expect(result.engineLoaded).toBe(true);
    expect(sessionService.isActive).toHaveBeenCalledWith('sess-uuid-1');
  });

  it('start audits SESSION_STARTED once the service has resolved', async () => {
    sessionService.start.mockResolvedValue({ ...runningEntity });

    await controller.start('sess-uuid-1');

    expect(auditService.logInfo).toHaveBeenCalledTimes(1);
    expect(auditService.logInfo).toHaveBeenCalledWith(
      AuditAction.SESSION_STARTED,
      expect.objectContaining({ sessionId: runningEntity.id, sessionName: runningEntity.name }),
    );
  });

  it('start forwards the service’s 400 verbatim and writes no audit row when the engine cannot start', async () => {
    const notStarted = new BadRequestException('Session is not started');
    sessionService.start.mockRejectedValue(notStarted);

    await expect(controller.start('sess-uuid-1')).rejects.toBe(notStarted);
    expect(auditService.logInfo).not.toHaveBeenCalled();
  });

  it('stop returns the stopped session (engineLoaded:false) and audits SESSION_STOPPED', async () => {
    sessionService.stop.mockResolvedValue({ ...runningEntity, status: SessionStatus.DISCONNECTED });

    const result = await controller.stop('sess-uuid-1');

    expect(result.status).toBe(SessionStatus.DISCONNECTED);
    expect(result.engineLoaded).toBe(false);
    expect(auditService.logInfo).toHaveBeenCalledWith(
      AuditAction.SESSION_STOPPED,
      expect.objectContaining({ sessionId: runningEntity.id, sessionName: runningEntity.name }),
    );
  });

  it('stop forwards a refusal verbatim and writes no audit row', async () => {
    const refused = new ConflictException('Another node holds this session');
    sessionService.stop.mockRejectedValue(refused);

    await expect(controller.stop('sess-uuid-1')).rejects.toBe(refused);
    expect(auditService.logInfo).not.toHaveBeenCalled();
  });

  it('forceKill audits SESSION_FORCE_KILLED after the teardown resolves', async () => {
    sessionService.forceKill.mockResolvedValue({ ...runningEntity, status: SessionStatus.DISCONNECTED });

    const result = await controller.forceKill('sess-uuid-1');

    expect(result.engineLoaded).toBe(false);
    expect(auditService.logInfo).toHaveBeenCalledWith(
      AuditAction.SESSION_FORCE_KILLED,
      expect.objectContaining({ sessionId: runningEntity.id, sessionName: runningEntity.name }),
    );
  });

  it('forceKill forwards the not-started 400 verbatim and writes no audit row', async () => {
    const notStarted = new BadRequestException('Session is not started');
    sessionService.forceKill.mockRejectedValue(notStarted);

    await expect(controller.forceKill('sess-uuid-1')).rejects.toBe(notStarted);
    expect(auditService.logInfo).not.toHaveBeenCalled();
  });
});

// Chat mute carries a nullable argument, which is the part worth pinning: `null` is the unmute
// instruction, so a controller that coalesced it away (`?? undefined`, `|| 0`) would silently turn
// every unmute into a mute-until-the-epoch. Both directions are asserted.
describe('SessionController — muteChat', () => {
  let sessionService: { muteChat: jest.Mock };
  let auditService: { logInfo: jest.Mock };
  let controller: SessionController;

  beforeEach(() => {
    sessionService = { muteChat: jest.fn().mockResolvedValue(undefined) };
    auditService = { logInfo: jest.fn().mockResolvedValue(undefined) };
    controller = new SessionControllerClass(
      sessionService as unknown as SessionService,
      auditService as unknown as AuditService,
    );
  });

  it('forwards the expiry second to the service', async () => {
    const result = await controller.muteChat('sess-uuid-1', { chatId: '628123@c.us', muteUntil: 1_800_000_000 });

    expect(sessionService.muteChat).toHaveBeenCalledWith('sess-uuid-1', '628123@c.us', 1_800_000_000);
    expect(result).toEqual({ success: true });
  });

  it('forwards a null expiry as null — that is the unmute instruction, not a missing value', async () => {
    await controller.muteChat('sess-uuid-1', { chatId: '628123@c.us', muteUntil: null });

    expect(sessionService.muteChat).toHaveBeenCalledWith('sess-uuid-1', '628123@c.us', null);
  });
});

describe('SessionController findAll name filter', () => {
  const apiKey = { allowedSessions: ['sess-uuid-1'] } as unknown as ApiKey;
  let sessionService: { findAll: jest.Mock; isActive: jest.Mock };
  let controller: SessionController;

  beforeEach(() => {
    sessionService = { findAll: jest.fn().mockResolvedValue([]), isActive: jest.fn().mockReturnValue(false) };
    controller = new SessionControllerClass(
      sessionService as unknown as SessionService,
      { logInfo: jest.fn() } as unknown as AuditService,
    );
  });

  it('forwards the name alongside the key allowlist and the window', async () => {
    await expect(controller.findAll(apiKey, '10', '5', 'my-bot')).resolves.toEqual([]);

    expect(sessionService.findAll).toHaveBeenCalledWith(['sess-uuid-1'], { limit: 10, offset: 5, name: 'my-bot' });
  });

  it('leaves the query unfiltered when name is absent', async () => {
    await controller.findAll(apiKey);

    expect(sessionService.findAll).toHaveBeenCalledWith(['sess-uuid-1'], {
      limit: undefined,
      offset: undefined,
      name: undefined,
    });
  });

  // A repeated key arrives as an array and an empty value as ''. Dropping either would return every
  // session to a caller that asked for one, so both are refused before the service is reached.
  it.each([[['a', 'b']], ['']])('rejects name=%p with 400', async name => {
    await expect(controller.findAll(apiKey, undefined, undefined, name)).rejects.toBeInstanceOf(BadRequestException);
    expect(sessionService.findAll).not.toHaveBeenCalled();
  });
});

// The pin route forwards a boolean the engine can refuse. The value worth pinning is that the
// engine's `false` reaches the caller: WhatsApp caps pinned chats at three, and a controller that
// hard-coded `{ success: true }` would report a refused pin as done.
describe('SessionController — pinChat', () => {
  let sessionService: { pinChat: jest.Mock };
  let auditService: { logInfo: jest.Mock };
  let controller: SessionController;

  beforeEach(() => {
    sessionService = { pinChat: jest.fn().mockResolvedValue(true) };
    auditService = { logInfo: jest.fn().mockResolvedValue(undefined) };
    controller = new SessionControllerClass(
      sessionService as unknown as SessionService,
      auditService as unknown as AuditService,
    );
  });

  it('forwards the chat id and the pin flag', async () => {
    const result = await controller.pinChat('sess-uuid-1', { chatId: '628123@c.us', pin: true });

    expect(sessionService.pinChat).toHaveBeenCalledWith('sess-uuid-1', '628123@c.us', true);
    expect(result).toEqual({ success: true });
  });

  it('surfaces a refused pin as success:false rather than reporting it done', async () => {
    sessionService.pinChat.mockResolvedValue(false);

    await expect(controller.pinChat('sess-uuid-1', { chatId: '628123@c.us', pin: true })).resolves.toEqual({
      success: false,
    });
  });

  it('forwards an unpin as pin:false', async () => {
    await controller.pinChat('sess-uuid-1', { chatId: '628123@c.us', pin: false });

    expect(sessionService.pinChat).toHaveBeenCalledWith('sess-uuid-1', '628123@c.us', false);
  });
});

describe('SessionController — proxy() response contract', () => {
  const proxyProjection = {
    enabled: true,
    proxyType: 'http' as const,
    proxyHost: 'proxy.internal:8080',
    hasCredentials: true,
  };

  let sessionService: { getProxy: jest.Mock; updateProxy: jest.Mock };
  let auditService: { logInfo: jest.Mock };
  let controller: SessionController;

  beforeEach(() => {
    sessionService = {
      getProxy: jest.fn().mockResolvedValue(proxyProjection),
      updateProxy: jest.fn().mockResolvedValue(proxyProjection),
    };
    auditService = { logInfo: jest.fn().mockResolvedValue(undefined) };
    controller = new SessionControllerClass(
      sessionService as unknown as SessionService,
      auditService as unknown as AuditService,
    );
  });

  it('getProxy returns the masked projection without proxyUrl', async () => {
    const result = await controller.getProxy('sess-uuid-1');

    expect(result).toEqual(proxyProjection);
    expect(result).not.toHaveProperty('proxyUrl');
  });

  it('updateProxy audits the masked state, not the request body', async () => {
    await controller.updateProxy('sess-uuid-1', {
      proxyUrl: 'http://user:secret@proxy.internal:8080',
    });

    expect(auditService.logInfo).toHaveBeenCalledWith(
      AuditAction.SESSION_CONFIG_UPDATED,
      expect.objectContaining({
        sessionId: 'sess-uuid-1',
        metadata: {
          proxyEnabled: true,
          proxyType: 'http',
          proxyHost: 'proxy.internal:8080',
        },
      }),
    );
  });
});
