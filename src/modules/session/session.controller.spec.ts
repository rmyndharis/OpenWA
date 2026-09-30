import type { SessionController } from './session.controller';
import { SessionController as SessionControllerClass } from './session.controller';
import { SessionStatus } from './entities/session.entity';
import type { Session } from './entities/session.entity';
import type { SessionService } from './session.service';
import type { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { ChatScopeService } from '../auth/chat-scope.service';
import type { ChatSummary } from '../../engine/interfaces/whatsapp-engine.interface';
import { ApiKeyRole, type ApiKey } from '../auth/entities/api-key.entity';
import { REQUIRED_ROLE_KEY, UNSCOPED_KEY } from '../auth/decorators/auth.decorators';
import { BadGatewayException, BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';

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
    desiredState: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };

  let sessionService: { create: jest.Mock; engineLoaded: jest.Mock };
  let auditService: { logInfo: jest.Mock };
  let controller: SessionController;

  beforeEach(() => {
    // transformSession reads live engine state for `engineLoaded`; a freshly created session has no
    // engine yet, which is what the response must say.
    sessionService = {
      create: jest.fn().mockResolvedValue({ ...entity }),
      engineLoaded: jest.fn().mockReturnValue(false),
    };
    auditService = { logInfo: jest.fn().mockResolvedValue(undefined) };
    controller = new SessionControllerClass(
      sessionService as unknown as SessionService,
      auditService as unknown as AuditService,
      new ChatScopeService(),
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

  // engineLoaded is live state, not an entity column, so the only thing that can get it wrong
  // is the wiring. Assert both answers come from the service rather than from the row's status.
  it('reports engineLoaded from the live engine map, not from the row status', async () => {
    sessionService.engineLoaded.mockReturnValue(true);

    const result = await controller.create({ name: 'test-session' });

    expect(result.engineLoaded).toBe(true);
    expect(sessionService.engineLoaded).toHaveBeenCalledWith(expect.objectContaining({ id: entity.id }));
  });

  it('still audits the creation with the session id and name', async () => {
    await controller.create({ name: 'test-session' });

    expect(auditService.logInfo).toHaveBeenCalledWith(
      'session_created',
      expect.objectContaining({ sessionId: entity.id, sessionName: entity.name }),
    );
  });
});

// A session proxy is deployment-level egress: setting or clearing one needs an ADMIN key on every
// route that writes it.
describe('SessionController: session proxy writes are ADMIN only', () => {
  const key = (role: ApiKeyRole) => ({ id: 'k', role }) as ApiKey;
  let sessionService: { create: jest.Mock; engineLoaded: jest.Mock };
  let controller: SessionController;

  beforeEach(() => {
    sessionService = {
      create: jest.fn().mockResolvedValue({ id: 'sess-uuid-1', name: 'with-proxy', config: {} }),
      engineLoaded: jest.fn().mockReturnValue(false),
    };
    controller = new SessionControllerClass(
      sessionService as unknown as SessionService,
      { logInfo: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService,
      new ChatScopeService(),
    );
  });

  it('PATCH :sessionId/proxy requires the ADMIN role and an unscoped key', () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- reading route metadata, not invoking
    const handler = SessionControllerClass.prototype.updateProxy;
    expect(Reflect.getMetadata(REQUIRED_ROLE_KEY, handler)).toBe(ApiKeyRole.ADMIN);
    expect(Reflect.getMetadata(UNSCOPED_KEY, handler)).toBe(true);
  });

  it.each([
    ['an OPERATOR key', key(ApiKeyRole.OPERATOR)],
    ['no key', undefined],
  ])('POST /sessions with proxyUrl from %s is refused before anything is created', async (_, apiKey) => {
    await expect(
      controller.create({ name: 'with-proxy', proxyUrl: 'http://proxy.internal:8080' }, apiKey),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(sessionService.create).not.toHaveBeenCalled();
  });

  it('POST /sessions with proxyUrl from an ADMIN key, or without one from an OPERATOR key, creates', async () => {
    await controller.create({ name: 'with-proxy', proxyUrl: 'http://proxy.internal:8080' }, key(ApiKeyRole.ADMIN));
    await controller.create({ name: 'no-proxy' }, key(ApiKeyRole.OPERATOR));

    expect(sessionService.create).toHaveBeenCalledTimes(2);
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
    desiredState: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };

  let sessionService: { logout: jest.Mock; engineLoaded: jest.Mock };
  let auditService: { logInfo: jest.Mock };
  let controller: SessionController;

  beforeEach(() => {
    sessionService = { logout: jest.fn(), engineLoaded: jest.fn().mockReturnValue(false) };
    auditService = { logInfo: jest.fn().mockResolvedValue(undefined) };
    controller = new SessionControllerClass(
      sessionService as unknown as SessionService,
      auditService as unknown as AuditService,
      new ChatScopeService(),
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
    desiredState: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T01:00:00Z'),
  };

  let sessionService: { start: jest.Mock; stop: jest.Mock; forceKill: jest.Mock; engineLoaded: jest.Mock };
  let auditService: { logInfo: jest.Mock };
  let controller: SessionController;

  beforeEach(() => {
    sessionService = {
      start: jest.fn(),
      stop: jest.fn(),
      forceKill: jest.fn(),
      engineLoaded: jest.fn().mockReturnValue(false),
    };
    auditService = { logInfo: jest.fn().mockResolvedValue(undefined) };
    controller = new SessionControllerClass(
      sessionService as unknown as SessionService,
      auditService as unknown as AuditService,
      new ChatScopeService(),
    );
  });

  it('start returns the session with engineLoaded read from the live engine map', async () => {
    sessionService.start.mockResolvedValue({ ...runningEntity });
    sessionService.engineLoaded.mockReturnValue(true);

    const result = await controller.start('sess-uuid-1');

    expect(result.status).toBe(SessionStatus.READY);
    expect(result.engineLoaded).toBe(true);
    expect(sessionService.engineLoaded).toHaveBeenCalledWith(expect.objectContaining({ id: 'sess-uuid-1' }));
  });

  it('start is an explicit start, which clears an operator stop', async () => {
    sessionService.start.mockResolvedValue({ ...runningEntity });

    await controller.start('sess-uuid-1');

    expect(sessionService.start).toHaveBeenCalledWith('sess-uuid-1', { explicit: true });
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
      new ChatScopeService(),
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
  let sessionService: { findAll: jest.Mock; engineLoaded: jest.Mock };
  let controller: SessionController;

  beforeEach(() => {
    sessionService = { findAll: jest.fn().mockResolvedValue([]), engineLoaded: jest.fn().mockReturnValue(false) };
    controller = new SessionControllerClass(
      sessionService as unknown as SessionService,
      { logInfo: jest.fn() } as unknown as AuditService,
      new ChatScopeService(),
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
      new ChatScopeService(),
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
      new ChatScopeService(),
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

// GET /sessions/:sessionId/chats is the one list route a chat-restricted key may use, and it must
// FILTER BEFORE paginating: filtering the page instead hands back a short or empty window while an
// allowed chat sits just past it.
describe('SessionController — GET .../chats filters before paginating', () => {
  const chat = (id: string, timestamp: number): ChatSummary => ({
    id,
    name: id,
    isGroup: id.endsWith('@g.us'),
    kind: id.endsWith('@g.us') ? 'group' : 'individual',
    unreadCount: 0,
    timestamp,
    archived: false,
    pinned: false,
    muted: false,
  });

  let sessionService: { listChats: jest.Mock };
  let controller: SessionController;

  beforeEach(() => {
    sessionService = { listChats: jest.fn() };
    controller = new SessionControllerClass(
      sessionService as unknown as SessionService,
      { logInfo: jest.fn() } as unknown as AuditService,
      new ChatScopeService(),
    );
  });

  it('filters the full list before the window (a page-first filter would return nothing here)', async () => {
    // The disallowed chat is NEWEST, so a page of 1 taken before filtering would be all-disallowed.
    sessionService.listChats.mockResolvedValue([chat('999@g.us', 3), chat('123@g.us', 2), chat('123@g.us', 1)]);
    const apiKey = { allowedChats: ['123@g.us'] } as ApiKey;

    const out = await controller.getChats('sess-uuid-1', apiKey, '1', '0');

    expect(out.map(c => c.id)).toEqual(['123@g.us']);
  });

  it('passes the whole list through for an unrestricted key', async () => {
    sessionService.listChats.mockResolvedValue([chat('123@g.us', 3), chat('999@g.us', 2)]);
    const out = await controller.getChats('sess-uuid-1', { allowedChats: null } as ApiKey, undefined, undefined);
    expect(out).toHaveLength(2);
  });
});

// GET /sessions/:sessionId/groups follows the same rule: a restricted key sees only its groups, and
// the window is taken after the filter.
describe('SessionController: GET .../groups filters before paginating', () => {
  const group = (id: string) => ({ id, name: id, linkedParentJID: '777@g.us' });
  let sessionService: { listGroups: jest.Mock };
  let controller: SessionController;

  beforeEach(() => {
    sessionService = { listGroups: jest.fn() };
    controller = new SessionControllerClass(
      sessionService as unknown as SessionService,
      { logInfo: jest.fn() } as unknown as AuditService,
      new ChatScopeService(),
    );
  });

  it('filters the full list before the window, keeping the allowed group as returned', async () => {
    sessionService.listGroups.mockResolvedValue([group('999@g.us'), group('123@g.us'), group('456@g.us')]);
    const apiKey = { allowedChats: ['123@g.us', '456@g.us'] } as ApiKey;

    const out = await controller.getGroups('sess-uuid-1', apiKey, '1', '0');

    expect(out).toEqual([group('123@g.us')]);
  });

  it('pages the whole list for an unrestricted key', async () => {
    sessionService.listGroups.mockResolvedValue([group('1@g.us'), group('2@g.us'), group('3@g.us')]);
    const out = await controller.getGroups('sess-uuid-1', { allowedChats: null } as ApiKey, '2', '1');
    expect(out.map(g => g.id)).toEqual(['2@g.us', '3@g.us']);
  });

  it('caps an unbounded group list at the default limit (1000)', async () => {
    sessionService.listGroups.mockResolvedValue(Array.from({ length: 1500 }, (_, i) => group(`${i}@g.us`)));
    const out = await controller.getGroups('sess-uuid-1', { allowedChats: null } as ApiKey);
    expect(out).toHaveLength(1000);
  });
});
