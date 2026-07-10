import { UnauthorizedException } from '@nestjs/common';
import { Socket } from 'socket.io';
import { EventsGateway, isSessionSubscriptionAllowed } from './events.gateway';
import { AuthService } from '../auth/auth.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { SUBSCRIBABLE_EVENTS, buildRoomName } from './dto/ws-messages.dto';
import type { WSClientMessage, WSErrorResponse, WSSubscribedResponse, WSEventMessage } from './dto/ws-messages.dto';
import { WEBHOOK_RESERVED_EVENTS } from '../webhook/dto/webhook.dto';

describe('isSessionSubscriptionAllowed (WS session-scope enforcement)', () => {
  it('allows an unrestricted key (null allowedSessions) to subscribe to anything, including *', () => {
    expect(isSessionSubscriptionAllowed(null, '*')).toBe(true);
    expect(isSessionSubscriptionAllowed(null, 'sess-1')).toBe(true);
  });

  it('allows an unrestricted key (empty allowedSessions) to subscribe to *', () => {
    expect(isSessionSubscriptionAllowed([], '*')).toBe(true);
  });

  it('forbids a session-scoped key from subscribing to the * wildcard', () => {
    expect(isSessionSubscriptionAllowed(['sess-1'], '*')).toBe(false);
  });

  it('allows a session-scoped key to subscribe to a session in its allowlist', () => {
    expect(isSessionSubscriptionAllowed(['sess-1', 'sess-2'], 'sess-2')).toBe(true);
  });

  it('forbids a session-scoped key from subscribing to a session outside its allowlist', () => {
    expect(isSessionSubscriptionAllowed(['sess-1'], 'sess-2')).toBe(false);
  });
});

interface MockSocket {
  id: string;
  handshake: {
    headers: Record<string, string>;
    query: Record<string, string>;
    auth: { apiKey?: string };
    address: string;
  };
  data: Record<string, unknown>;
  emit: jest.Mock;
  disconnect: jest.Mock;
  join: jest.Mock;
  rooms: Set<string>;
}

describe('EventsGateway connection auth + subscribe re-validation', () => {
  let gateway: EventsGateway;
  let authService: { validateApiKey: jest.Mock };

  const makeSocket = (auth: { apiKey?: string } = {}): MockSocket => ({
    id: 'sock-1',
    handshake: { headers: {}, query: {}, auth, address: '203.0.113.5' },
    data: {},
    emit: jest.fn(),
    disconnect: jest.fn(),
    join: jest.fn(),
    rooms: new Set<string>(),
  });
  const asSocket = (s: MockSocket): Socket => s as unknown as Socket;
  const subscribeMsg = (sessionId: string, events: string[]): WSClientMessage =>
    ({ type: 'subscribe', sessionId, events, requestId: 'r1' }) as unknown as WSClientMessage;

  let auditService: { logWarn: jest.Mock };

  beforeEach(() => {
    authService = { validateApiKey: jest.fn() };
    auditService = { logWarn: jest.fn().mockResolvedValue(null) };
    gateway = new EventsGateway(authService as unknown as AuthService, auditService as unknown as AuditService);
  });

  it('rejects a connection with no API key (and never calls validate)', async () => {
    const sock = makeSocket({});
    await gateway.handleConnection(asSocket(sock));
    expect(sock.disconnect).toHaveBeenCalled();
    expect(authService.validateApiKey).not.toHaveBeenCalled();
  });

  it('does NOT accept the API key from the query string (credential must not travel in the URL)', async () => {
    const sock = makeSocket({});
    sock.handshake.query.apiKey = 'leaky-key-in-url';
    await gateway.handleConnection(asSocket(sock));
    expect(authService.validateApiKey).not.toHaveBeenCalled(); // query key ignored → treated as missing
    expect(sock.disconnect).toHaveBeenCalled();
  });

  it('audits a rejected WebSocket auth attempt (forensic parity with the REST guard)', async () => {
    authService.validateApiKey.mockRejectedValue(new UnauthorizedException('Invalid API key'));
    const sock = makeSocket({ apiKey: 'bad' });
    await gateway.handleConnection(asSocket(sock));
    expect(auditService.logWarn).toHaveBeenCalledWith(
      AuditAction.API_KEY_AUTH_FAILED,
      expect.objectContaining({ ipAddress: '203.0.113.5', metadata: { surface: 'websocket' } }),
    );
  });

  it('rejects a connection when validateApiKey throws (the real auth-failure contract)', async () => {
    authService.validateApiKey.mockRejectedValue(new UnauthorizedException('Invalid API key'));
    const sock = makeSocket({ apiKey: 'bad' });
    await gateway.handleConnection(asSocket(sock));
    expect(sock.disconnect).toHaveBeenCalled();
  });

  it('accepts a valid key via handshake.auth and stores the raw key for re-validation', async () => {
    authService.validateApiKey.mockResolvedValue({ name: 'k', allowedSessions: null });
    const sock = makeSocket({ apiKey: 'good' });
    await gateway.handleConnection(asSocket(sock));
    expect(sock.disconnect).not.toHaveBeenCalled();
    expect(sock.data.rawApiKey).toBe('good');
  });

  it('re-validates on subscribe and disconnects a key revoked after connect', async () => {
    authService.validateApiKey.mockResolvedValueOnce({ name: 'k', allowedSessions: null }); // connect
    const sock = makeSocket({ apiKey: 'good' });
    await gateway.handleConnection(asSocket(sock));

    authService.validateApiKey.mockResolvedValueOnce(null); // revoked on the subscribe re-check
    const res = (await gateway.handleMessage(asSocket(sock), subscribeMsg('sess-1', ['*']))) as WSErrorResponse;

    expect(sock.disconnect).toHaveBeenCalled();
    expect(res.code).toBe('UNAUTHORIZED');
  });

  it('allows subscribe when the key still re-validates', async () => {
    authService.validateApiKey.mockResolvedValue({ name: 'k', allowedSessions: null });
    const sock = makeSocket({ apiKey: 'good' });
    await gateway.handleConnection(asSocket(sock));

    const res = (await gateway.handleMessage(
      asSocket(sock),
      subscribeMsg('sess-1', ['session.status']),
    )) as WSSubscribedResponse;

    expect(res.type).toBe('subscribed');
    expect(sock.join).toHaveBeenCalled();
  });

  it('rejects a subscription to a reserved, never-emitted event (group.*) with INVALID_EVENTS', async () => {
    authService.validateApiKey.mockResolvedValue({ name: 'k', allowedSessions: null });
    const sock = makeSocket({ apiKey: 'good' });
    await gateway.handleConnection(asSocket(sock));

    const res = (await gateway.handleMessage(
      asSocket(sock),
      subscribeMsg('sess-1', ['group.join']),
    )) as WSErrorResponse;

    expect(res.type).toBe('error');
    expect(res.code).toBe('INVALID_EVENTS');
    expect(sock.join).not.toHaveBeenCalled();
  });

  it('keeps the valid events when a subscription mixes a valid and a reserved event', async () => {
    authService.validateApiKey.mockResolvedValue({ name: 'k', allowedSessions: null });
    const sock = makeSocket({ apiKey: 'good' });
    await gateway.handleConnection(asSocket(sock));

    const res = (await gateway.handleMessage(
      asSocket(sock),
      subscribeMsg('sess-1', ['message.received', 'group.join']),
    )) as WSSubscribedResponse;

    expect(res.type).toBe('subscribed');
    expect(res.events).toEqual(['message.received']);
    expect(sock.join).toHaveBeenCalledWith(buildRoomName('sess-1', 'message.received'));
  });

  // Cross-tenant guard (#221): a session-scoped key must not subscribe to a foreign session or '*'.
  // The pure predicate is covered above; these drive it through handleSubscribe so a regression that
  // drops the check (or reads the stale connect-time key) is caught end-to-end.
  it('forbids a session-scoped key from subscribing to a session outside its allowlist', async () => {
    authService.validateApiKey.mockResolvedValue({ name: 'k', allowedSessions: ['sess-1'] });
    const sock = makeSocket({ apiKey: 'good' });
    await gateway.handleConnection(asSocket(sock));

    const res = (await gateway.handleMessage(asSocket(sock), subscribeMsg('sess-2', ['*']))) as WSErrorResponse;

    expect(res.type).toBe('error');
    expect(res.code).toBe('FORBIDDEN_SESSION');
    expect(sock.join).not.toHaveBeenCalled();
  });

  it('forbids a session-scoped key from subscribing to the * wildcard', async () => {
    authService.validateApiKey.mockResolvedValue({ name: 'k', allowedSessions: ['sess-1'] });
    const sock = makeSocket({ apiKey: 'good' });
    await gateway.handleConnection(asSocket(sock));

    const res = (await gateway.handleMessage(
      asSocket(sock),
      subscribeMsg('*', ['message.received']),
    )) as WSErrorResponse;

    expect(res.code).toBe('FORBIDDEN_SESSION');
    expect(sock.join).not.toHaveBeenCalled();
  });

  it('allows a session-scoped key to subscribe to a session in its allowlist', async () => {
    authService.validateApiKey.mockResolvedValue({ name: 'k', allowedSessions: ['sess-1'] });
    const sock = makeSocket({ apiKey: 'good' });
    await gateway.handleConnection(asSocket(sock));

    const res = (await gateway.handleMessage(
      asSocket(sock),
      subscribeMsg('sess-1', ['message.received']),
    )) as WSSubscribedResponse;

    expect(res.type).toBe('subscribed');
    expect(sock.join).toHaveBeenCalledWith(buildRoomName('sess-1', 'message.received'));
  });

  it('enforces scope using the FRESH re-validated key, not the connect-time key', async () => {
    // Connect with an unrestricted key, but the key is narrowed to ['sess-1'] by the subscribe re-check.
    authService.validateApiKey.mockResolvedValueOnce({ name: 'k', allowedSessions: null }); // connect
    const sock = makeSocket({ apiKey: 'good' });
    await gateway.handleConnection(asSocket(sock));

    authService.validateApiKey.mockResolvedValueOnce({ name: 'k', allowedSessions: ['sess-1'] }); // subscribe re-check
    const res = (await gateway.handleMessage(
      asSocket(sock),
      subscribeMsg('sess-2', ['message.received']),
    )) as WSErrorResponse;

    expect(res.code).toBe('FORBIDDEN_SESSION');
    expect(sock.join).not.toHaveBeenCalled();
  });

  // Client-IP resolution: an IP-restricted key (allowedIps set) must be ENFORCED at the WS surface,
  // not blanket-rejected. validateApiKey throws "Client IP could not be determined" when allowedIps is
  // set but no clientIp is supplied — so the gateway must pass the trusted-proxy-aware IP at connect
  // and at subscribe re-validation. Without the fix every IP-restricted key was locked out of WS.
  it('passes the trusted-proxy-aware client IP to validateApiKey at connect (RED-without-fix: undefined)', async () => {
    authService.validateApiKey.mockResolvedValue({ id: 'k1', name: 'k', allowedSessions: null });
    const sock = makeSocket({ apiKey: 'good' }); // address defaults to 203.0.113.5
    await gateway.handleConnection(asSocket(sock));
    expect(authService.validateApiKey).toHaveBeenCalledWith('good', '203.0.113.5');
    expect(sock.disconnect).not.toHaveBeenCalled();
  });

  it('passes the resolved client IP to validateApiKey on subscribe re-validation', async () => {
    authService.validateApiKey.mockResolvedValue({ id: 'k1', name: 'k', allowedSessions: null });
    const sock = makeSocket({ apiKey: 'good' });
    await gateway.handleConnection(asSocket(sock));
    authService.validateApiKey.mockClear();
    await gateway.handleMessage(asSocket(sock), subscribeMsg('sess-1', ['message.received']));
    expect(authService.validateApiKey).toHaveBeenCalledWith('good', '203.0.113.5');
  });

  it('honors TRUSTED_PROXIES + X-Forwarded-For when resolving the WS client IP', async () => {
    const prev = process.env.TRUSTED_PROXIES;
    process.env.TRUSTED_PROXIES = '10.0.0.1';
    try {
      authService.validateApiKey.mockResolvedValue({ id: 'k1', name: 'k', allowedSessions: null });
      const sock = makeSocket({ apiKey: 'good' });
      sock.handshake.address = '10.0.0.1'; // immediate peer is the trusted proxy
      sock.handshake.headers['x-forwarded-for'] = '198.51.100.7';
      await gateway.handleConnection(asSocket(sock));
      expect(authService.validateApiKey).toHaveBeenCalledWith('good', '198.51.100.7');
    } finally {
      process.env.TRUSTED_PROXIES = prev;
    }
  });

  // Revocation teardown: a revoked key's already-subscribed sockets are evicted immediately,
  // with a clean close (an UNAUTHORIZED reason) rather than lingering until natural disconnect.
  describe('evictApiKey (revoke/disable socket teardown)', () => {
    it('disconnects every active socket authenticated with the revoked key', async () => {
      authService.validateApiKey.mockResolvedValue({ id: 'k1', name: 'k', allowedSessions: null });
      const sock = makeSocket({ apiKey: 'good' });
      await gateway.handleConnection(asSocket(sock));
      expect(sock.disconnect).not.toHaveBeenCalled();

      gateway.evictApiKey('k1');

      expect(sock.disconnect).toHaveBeenCalledWith(true);
      expect(sock.emit).toHaveBeenCalledWith('message', expect.objectContaining({ code: 'UNAUTHORIZED' }));
    });

    it('does NOT evict sockets authenticated with a different (still-active) key', async () => {
      authService.validateApiKey.mockResolvedValue({ id: 'k1', name: 'k', allowedSessions: null });
      const sock = makeSocket({ apiKey: 'good' });
      await gateway.handleConnection(asSocket(sock));

      gateway.evictApiKey('some-other-key');

      expect(sock.disconnect).not.toHaveBeenCalled();
    });

    it('is a no-op when no sockets are tracked for the key', () => {
      expect(() => gateway.evictApiKey('nobody')).not.toThrow();
    });

    it('cleans up tracking on disconnect so an evicted key holds no stale socket refs', async () => {
      authService.validateApiKey.mockResolvedValue({ id: 'k1', name: 'k', allowedSessions: null });
      const sock = makeSocket({ apiKey: 'good' });
      await gateway.handleConnection(asSocket(sock));

      gateway.evictApiKey('k1');
      // Socket.IO fires the disconnect handler on disconnect(true); simulate it here to confirm
      // untracking is idempotent and leaves no dangling references.
      gateway.handleDisconnect(asSocket(sock));

      expect(() => gateway.evictApiKey('k1')).not.toThrow();
    });
  });
});

// A capturing, chainable Socket.IO server stub: server.to(r1).to(r2)...emit(...) all
// resolve to one operator whose emit() we count. Mirrors the real BroadcastOperator,
// where chained .to() accumulates rooms into a single deduped broadcast.
const makeCapturingServer = () => {
  const rooms: string[] = [];
  const emit = jest.fn();
  const op: { to: jest.Mock; emit: jest.Mock } = { to: jest.fn(), emit };
  op.to.mockImplementation((r: string) => {
    rooms.push(r);
    return op;
  });
  const server = { to: jest.fn((r: string) => (rooms.push(r), op)) };
  return { server, emit, rooms };
};

describe('EventsGateway.emitToRooms fan-out', () => {
  const gw = () =>
    new EventsGateway(
      { validateApiKey: jest.fn() } as unknown as AuthService,
      { logWarn: jest.fn().mockResolvedValue(null) } as unknown as AuditService,
    );

  it('delivers one event with a single broadcast across all four rooms (no per-room duplicate emit)', () => {
    const gateway = gw();
    const { server, emit, rooms } = makeCapturingServer();
    (gateway as unknown as { server: unknown }).server = server;

    gateway.emitMessage('sess-1', { id: 'm1' });

    // One broadcast, not one-emit-per-room: a socket in several of the rooms gets it once.
    expect(emit).toHaveBeenCalledTimes(1);
    const [channel, message] = emit.mock.calls[0] as [string, WSEventMessage];
    expect(channel).toBe('message');
    expect(message.type).toBe('event');
    expect(message.payload.event).toBe('message.received');
    expect(message.payload.sessionId).toBe('sess-1');
    // Still targets the specific room plus the three wildcard rooms.
    expect(new Set(rooms)).toEqual(
      new Set([
        buildRoomName('sess-1', 'message.received'),
        buildRoomName('sess-1', '*'),
        buildRoomName('*', 'message.received'),
        buildRoomName('*', '*'),
      ]),
    );
  });
});

describe('event catalog ⇔ emitter invariants (drift guard)', () => {
  // Derive the events the gateway ACTUALLY emits by invoking every public emit* room
  // method against a capturing server. Reflection-based so it cannot rot: a new emit*
  // method is auto-discovered; an advertised-but-unemitted event fails the equality.
  const deriveEmittedEvents = (): Set<string> => {
    const gateway = new EventsGateway(
      { validateApiKey: jest.fn() } as unknown as AuthService,
      { logWarn: jest.fn().mockResolvedValue(null) } as unknown as AuditService,
    );
    const captured: string[] = [];
    const op: { to: () => unknown; emit: (ch: string, msg: WSEventMessage) => boolean } = {
      to: () => op,
      emit: (_ch, msg) => (captured.push(msg.payload.event), true),
    };
    (gateway as unknown as { server: unknown }).server = { to: () => op };

    const proto = Object.getPrototypeOf(gateway) as object;
    const emitMethods = Object.getOwnPropertyNames(proto).filter(n => n.startsWith('emit') && n !== 'emitToRooms');
    for (const name of emitMethods) {
      (gateway as unknown as Record<string, (...a: unknown[]) => void>)[name]('sess-1', {});
    }
    return new Set(captured);
  };

  it('every advertised SUBSCRIBABLE_EVENT has a gateway emitter, and every emitter is advertised', () => {
    expect(new Set(SUBSCRIBABLE_EVENTS)).toEqual(deriveEmittedEvents());
  });

  it('reserved webhook group.* events are NOT advertised as socket-subscribable', () => {
    for (const reserved of WEBHOOK_RESERVED_EVENTS) {
      expect(SUBSCRIBABLE_EVENTS).not.toContain(reserved);
    }
  });
});
