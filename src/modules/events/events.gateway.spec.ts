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

  it('accepts a subscription to group.join (a live, engine-emitted event)', async () => {
    authService.validateApiKey.mockResolvedValue({ name: 'k', allowedSessions: null });
    const sock = makeSocket({ apiKey: 'good' });
    await gateway.handleConnection(asSocket(sock));

    const res = (await gateway.handleMessage(
      asSocket(sock),
      subscribeMsg('sess-1', ['group.join']),
    )) as WSSubscribedResponse;

    expect(res.type).toBe('subscribed');
    expect(res.events).toEqual(['group.join']);
    expect(sock.join).toHaveBeenCalledWith(buildRoomName('sess-1', 'group.join'));
  });

  it('rejects a subscription to an unknown, never-emitted event with INVALID_EVENTS', async () => {
    authService.validateApiKey.mockResolvedValue({ name: 'k', allowedSessions: null });
    const sock = makeSocket({ apiKey: 'good' });
    await gateway.handleConnection(asSocket(sock));

    const res = (await gateway.handleMessage(
      asSocket(sock),
      subscribeMsg('sess-1', ['session.connected']),
    )) as WSErrorResponse;

    expect(res.type).toBe('error');
    expect(res.code).toBe('INVALID_EVENTS');
    expect(sock.join).not.toHaveBeenCalled();
  });

  it('keeps the valid events when a subscription mixes a valid and an unknown event', async () => {
    authService.validateApiKey.mockResolvedValue({ name: 'k', allowedSessions: null });
    const sock = makeSocket({ apiKey: 'good' });
    await gateway.handleConnection(asSocket(sock));

    const res = (await gateway.handleMessage(
      asSocket(sock),
      subscribeMsg('sess-1', ['message.received', 'session.connected']),
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

    it('evicts a passive socket once its cached API key expires', async () => {
      authService.validateApiKey.mockResolvedValue({
        id: 'k1',
        name: 'k',
        allowedSessions: null,
        expiresAt: new Date('2026-01-01T00:00:00Z'),
      });
      const sock = makeSocket({ apiKey: 'good' });
      await gateway.handleConnection(asSocket(sock));

      (gateway as unknown as { sweepExpiredApiKeys: (now: number) => void }).sweepExpiredApiKeys(
        Date.parse('2026-01-01T00:00:01Z'),
      );

      expect(sock.disconnect).toHaveBeenCalledWith(true);
      expect(sock.emit).toHaveBeenCalledWith(
        'message',
        expect.objectContaining({ code: 'UNAUTHORIZED', message: 'API key has expired' }),
      );
    });

    it('keeps sockets with no expiry or a future expiry', async () => {
      const noExpiry = makeSocket({ apiKey: 'a' });
      const future = { ...makeSocket({ apiKey: 'b' }), id: 'sock-2' };
      authService.validateApiKey
        .mockResolvedValueOnce({ id: 'k1', name: 'a', allowedSessions: null, expiresAt: null })
        .mockResolvedValueOnce({
          id: 'k2',
          name: 'b',
          allowedSessions: null,
          expiresAt: new Date('2026-01-02T00:00:00Z'),
        });
      await gateway.handleConnection(asSocket(noExpiry));
      await gateway.handleConnection(asSocket(future));

      (gateway as unknown as { sweepExpiredApiKeys: (now: number) => void }).sweepExpiredApiKeys(
        Date.parse('2026-01-01T00:00:00Z'),
      );

      expect(noExpiry.disconnect).not.toHaveBeenCalled();
      expect(future.disconnect).not.toHaveBeenCalled();
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

  it('reserved webhook events (currently none) never overlap the socket-subscribable catalog', () => {
    // WEBHOOK_RESERVED_EVENTS is intentionally empty — the former group.* occupants are now live,
    // engine-emitted (and socket-subscribable) events covered by the equality guard above. The
    // export stays so a future declared-but-undispatched event can be whitelisted there; whenever
    // the list is non-empty, no reserved event may also be advertised as subscribable.
    expect(WEBHOOK_RESERVED_EVENTS).toHaveLength(0);
    for (const reserved of WEBHOOK_RESERVED_EVENTS) {
      expect(SUBSCRIBABLE_EVENTS).not.toContain(reserved);
    }
  });
});

// Rate limiting on the WS surface: the gateway sits outside the Nest guard pipeline, so the
// per-key frame bucket, the pre-auth per-IP handshake window, and the per-key socket cap are
// all enforced inside EventsGateway. The gateway reads its config from the env at construction,
// so these tests pin the WS_* env vars per test (and restore them afterwards).
describe('EventsGateway rate limiting', () => {
  const WS_ENV_KEYS = [
    'WS_RATE_LIMIT_FRAME_PER_SECOND',
    'WS_RATE_LIMIT_FRAME_BURST',
    'WS_RATE_LIMIT_HANDSHAKE_MAX',
    'WS_RATE_LIMIT_HANDSHAKE_WINDOW_MS',
    'WS_MAX_SOCKETS_PER_KEY',
  ] as const;

  let gateway: EventsGateway;
  let authService: { validateApiKey: jest.Mock };
  let auditService: { logWarn: jest.Mock };
  let savedEnv: Record<string, string | undefined>;

  const makeSock = (id: string, auth: { apiKey?: string } = {}): MockSocket => ({
    id,
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

  beforeEach(() => {
    savedEnv = {};
    for (const key of WS_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    authService = { validateApiKey: jest.fn() };
    auditService = { logWarn: jest.fn().mockResolvedValue(null) };
  });

  afterEach(() => {
    for (const key of WS_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    jest.useRealTimers();
  });

  const buildGateway = (): EventsGateway => {
    gateway = new EventsGateway(authService as unknown as AuthService, auditService as unknown as AuditService);
    return gateway;
  };

  // Typed view over the audit mock's calls so assertions on action/metadata don't wade through `any`.
  interface WarnContext {
    metadata?: Record<string, unknown>;
  }
  const warnCalls = (): [AuditAction, WarnContext?][] =>
    auditService.logWarn.mock.calls as [AuditAction, WarnContext?][];

  describe('per-key frame token bucket', () => {
    it('rejects the frame above the bucket with a RATE_LIMITED error frame and never reaches the handler', async () => {
      process.env.WS_RATE_LIMIT_FRAME_PER_SECOND = '2';
      process.env.WS_RATE_LIMIT_FRAME_BURST = '3';
      authService.validateApiKey.mockResolvedValue({ id: 'k1', name: 'k', allowedSessions: null });
      const gw = buildGateway();
      const sock = makeSock('s1', { apiKey: 'good' });
      await gw.handleConnection(asSocket(sock));
      expect(authService.validateApiKey).toHaveBeenCalledTimes(1);

      // The 3-frame burst passes; each subscribe re-validates the key.
      for (let i = 0; i < 3; i++) {
        const res = (await gw.handleMessage(asSocket(sock), subscribeMsg('sess-1', ['session.status']))) as {
          type: string;
        };
        expect(res.type).toBe('subscribed');
      }
      expect(authService.validateApiKey).toHaveBeenCalledTimes(4);

      // The frame above the bucket: error frame back to the client, and NOT dispatched —
      // in particular it never reaches the per-subscribe DB re-validation.
      const res = (await gw.handleMessage(
        asSocket(sock),
        subscribeMsg('sess-1', ['session.status']),
      )) as WSErrorResponse;
      expect(res.type).toBe('error');
      expect(res.code).toBe('RATE_LIMITED');
      expect(sock.emit).toHaveBeenCalledWith('message', expect.objectContaining({ code: 'RATE_LIMITED' }));
      expect(authService.validateApiKey).toHaveBeenCalledTimes(4);
    });

    it('lets a normal dashboard connect-time subscribe burst (8 frames) through untouched', async () => {
      // Defaults: 60 frames/s sustained + 120 burst — far above a page-mount burst.
      authService.validateApiKey.mockResolvedValue({ id: 'k1', name: 'k', allowedSessions: null });
      const gw = buildGateway();
      const sock = makeSock('s1', { apiKey: 'good' });
      await gw.handleConnection(asSocket(sock));

      for (let i = 0; i < 8; i++) {
        const res = (await gw.handleMessage(asSocket(sock), subscribeMsg('sess-1', ['session.status']))) as {
          type: string;
        };
        expect(res.type).toBe('subscribed');
      }
    });

    it('recovers after the refill window: a throttled key can send again', async () => {
      process.env.WS_RATE_LIMIT_FRAME_PER_SECOND = '2';
      process.env.WS_RATE_LIMIT_FRAME_BURST = '2';
      jest.useFakeTimers();
      authService.validateApiKey.mockResolvedValue({ id: 'k1', name: 'k', allowedSessions: null });
      const gw = buildGateway();
      const sock = makeSock('s1', { apiKey: 'good' });
      await gw.handleConnection(asSocket(sock));

      await gw.handleMessage(asSocket(sock), subscribeMsg('sess-1', ['session.status']));
      await gw.handleMessage(asSocket(sock), subscribeMsg('sess-1', ['session.status']));
      const limited = (await gw.handleMessage(asSocket(sock), subscribeMsg('sess-1', ['session.status']))) as {
        code?: string;
      };
      expect(limited.code).toBe('RATE_LIMITED');

      jest.advanceTimersByTime(1_000); // 2 tokens refill at 2/s
      const res = (await gw.handleMessage(asSocket(sock), subscribeMsg('sess-1', ['session.status']))) as {
        type: string;
      };
      expect(res.type).toBe('subscribed');
    });
  });

  describe('pre-auth per-IP handshake window', () => {
    it('rejects the handshake above the window BEFORE validateApiKey runs', async () => {
      process.env.WS_RATE_LIMIT_HANDSHAKE_MAX = '3';
      process.env.WS_RATE_LIMIT_HANDSHAKE_WINDOW_MS = '60000';
      // Failed handshakes are what the window is for — an authenticated one is refunded (below).
      authService.validateApiKey.mockRejectedValue(new Error('bad key'));
      const gw = buildGateway();

      for (let i = 0; i < 3; i++) {
        await gw.handleConnection(asSocket(makeSock(`s${i}`, { apiKey: 'good' })));
      }
      expect(authService.validateApiKey).toHaveBeenCalledTimes(3);

      // The 4th handshake from the same IP inside the window is gated pre-auth: the DB
      // validate is never reached.
      const blocked = makeSock('s-blocked', { apiKey: 'good' });
      await gw.handleConnection(asSocket(blocked));
      expect(authService.validateApiKey).toHaveBeenCalledTimes(3);
      expect(blocked.disconnect).toHaveBeenCalled();
      expect(blocked.emit).toHaveBeenCalledWith('message', expect.objectContaining({ code: 'RATE_LIMITED' }));
      const violations = warnCalls().filter(([action]) => action === AuditAction.RATE_LIMIT_EXCEEDED);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.[1]?.metadata).toEqual(
        expect.objectContaining({ surface: 'websocket', kind: 'handshake' }),
      );
    });

    it('emits the RATE_LIMITED error frame BEFORE disconnecting, so the client can tell throttling from a dead server', async () => {
      process.env.WS_RATE_LIMIT_HANDSHAKE_MAX = '1';
      authService.validateApiKey.mockRejectedValue(new Error('bad key'));
      const gw = buildGateway();

      await gw.handleConnection(asSocket(makeSock('s1', { apiKey: 'good' })));
      const blocked = makeSock('s-blocked', { apiKey: 'good' });
      await gw.handleConnection(asSocket(blocked));

      // Order is the client-visible contract: socket.io delivers the queued error frame ahead of
      // the disconnect packet, and the dashboard keys its reconnect banner on receiving a
      // distinguishable error plus the server-initiated close.
      expect(blocked.emit).toHaveBeenCalledWith(
        'message',
        expect.objectContaining({ type: 'error', code: 'RATE_LIMITED' }),
      );
      expect(blocked.disconnect).toHaveBeenCalled();
      const emitOrder = blocked.emit.mock.invocationCallOrder[0];
      const disconnectOrder = blocked.disconnect.mock.invocationCallOrder[0];
      expect(emitOrder).toBeLessThan(disconnectOrder);
    });

    it('does not spend the shared per-IP budget on handshakes that authenticate', async () => {
      // The window is charged pre-auth to keep a flood off the DB, but every client behind one
      // NAT/proxy IP shares the subject — charging successful connects too would let a few
      // dashboards re-mounting lock each other out. Authenticated volume is bounded by the
      // per-key socket cap instead.
      process.env.WS_RATE_LIMIT_HANDSHAKE_MAX = '2';
      process.env.WS_RATE_LIMIT_HANDSHAKE_WINDOW_MS = '60000';
      process.env.WS_MAX_SOCKETS_PER_KEY = '99';
      authService.validateApiKey.mockResolvedValue({ id: 'k1', name: 'k', allowedSessions: null });
      const gw = buildGateway();

      for (let i = 0; i < 6; i++) {
        const sock = makeSock(`ok${i}`, { apiKey: 'good' });
        await gw.handleConnection(asSocket(sock));
        expect(sock.disconnect).not.toHaveBeenCalled();
      }
      expect(authService.validateApiKey).toHaveBeenCalledTimes(6);
    });

    it('throttles an unauthenticated handshake flood before any credential/audit work', async () => {
      process.env.WS_RATE_LIMIT_HANDSHAKE_MAX = '2';
      const gw = buildGateway();

      // Three key-less handshakes from one IP: the first two reach the missing-key audit,
      // the third is gated by the limiter instead (no per-attempt auth failure processing).
      await gw.handleConnection(asSocket(makeSock('a')));
      await gw.handleConnection(asSocket(makeSock('b')));
      await gw.handleConnection(asSocket(makeSock('c')));

      const authFailed = warnCalls().filter(([action]) => action === AuditAction.API_KEY_AUTH_FAILED);
      expect(authFailed).toHaveLength(2);
      expect(authService.validateApiKey).not.toHaveBeenCalled();
    });

    it('recovers once the window slides past the oldest handshake', async () => {
      process.env.WS_RATE_LIMIT_HANDSHAKE_MAX = '1';
      process.env.WS_RATE_LIMIT_HANDSHAKE_WINDOW_MS = '60000';
      jest.useFakeTimers();
      authService.validateApiKey.mockRejectedValue(new Error('bad key'));
      const gw = buildGateway();

      await gw.handleConnection(asSocket(makeSock('a', { apiKey: 'good' })));
      const blocked = makeSock('b', { apiKey: 'good' });
      await gw.handleConnection(asSocket(blocked));
      expect(blocked.disconnect).toHaveBeenCalled();
      expect(authService.validateApiKey).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(60_001);
      const recovered = makeSock('c', { apiKey: 'good' });
      await gw.handleConnection(asSocket(recovered));
      // No longer shed by the window: it reaches the credential check. (It is still rejected here
      // because this test drives the window with failing credentials, so assert on WHICH rejection.)
      expect(authService.validateApiKey).toHaveBeenCalledTimes(2);
      expect(recovered.emit).toHaveBeenCalledWith('message', expect.objectContaining({ code: 'UNAUTHORIZED' }));
      expect(recovered.emit).not.toHaveBeenCalledWith('message', expect.objectContaining({ code: 'RATE_LIMITED' }));
    });

    it('samples the violation audit: one row per subject per minute, suppressed count folded in', async () => {
      process.env.WS_RATE_LIMIT_HANDSHAKE_MAX = '1';
      process.env.WS_RATE_LIMIT_HANDSHAKE_WINDOW_MS = '60000';
      jest.useFakeTimers();
      authService.validateApiKey.mockRejectedValue(new Error('bad key'));
      const gw = buildGateway();

      await gw.handleConnection(asSocket(makeSock('a', { apiKey: 'good' }))); // allowed
      await gw.handleConnection(asSocket(makeSock('b', { apiKey: 'good' }))); // rejected → audit #1
      await gw.handleConnection(asSocket(makeSock('c', { apiKey: 'good' }))); // rejected → suppressed

      jest.advanceTimersByTime(61_000);
      await gw.handleConnection(asSocket(makeSock('d', { apiKey: 'good' }))); // allowed again
      await gw.handleConnection(asSocket(makeSock('e', { apiKey: 'good' }))); // rejected → audit #2

      const rateLimited = warnCalls().filter(([action]) => action === AuditAction.RATE_LIMIT_EXCEEDED);
      expect(rateLimited).toHaveLength(2);
      expect(rateLimited[0]?.[1]?.metadata).toEqual(expect.objectContaining({ kind: 'handshake', suppressed: 0 }));
      expect(rateLimited[1]?.[1]?.metadata).toEqual(expect.objectContaining({ kind: 'handshake', suppressed: 1 }));
    });
  });

  describe('per-key simultaneous socket cap', () => {
    it('rejects the socket above the cap with a clear error, and frees the slot on disconnect', async () => {
      process.env.WS_MAX_SOCKETS_PER_KEY = '2';
      // Keep the handshake window out of the way: this test is about the socket cap.
      process.env.WS_RATE_LIMIT_HANDSHAKE_MAX = '100';
      authService.validateApiKey.mockResolvedValue({ id: 'k1', name: 'k', allowedSessions: null });
      const gw = buildGateway();

      const s1 = makeSock('s1', { apiKey: 'good' });
      const s2 = makeSock('s2', { apiKey: 'good' });
      await gw.handleConnection(asSocket(s1));
      await gw.handleConnection(asSocket(s2));
      expect(s1.disconnect).not.toHaveBeenCalled();
      expect(s2.disconnect).not.toHaveBeenCalled();

      // The 3rd simultaneous socket for the same key IS authenticated (the cap is a post-auth
      // fairness bound, not an auth failure) and then refused with a clear error.
      const s3 = makeSock('s3', { apiKey: 'good' });
      await gw.handleConnection(asSocket(s3));
      expect(authService.validateApiKey).toHaveBeenCalledTimes(3);
      expect(s3.disconnect).toHaveBeenCalled();
      expect(s3.emit).toHaveBeenCalledWith(
        'message',
        expect.objectContaining({
          code: 'RATE_LIMITED',
          message: expect.stringContaining('Too many concurrent connections') as unknown,
        }),
      );
      const violations = warnCalls().filter(([action]) => action === AuditAction.RATE_LIMIT_EXCEEDED);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.[1]?.metadata).toEqual(expect.objectContaining({ kind: 'sockets' }));

      // Disconnecting one socket frees the slot for the next connection.
      gw.handleDisconnect(asSocket(s2));
      const s4 = makeSock('s4', { apiKey: 'good' });
      await gw.handleConnection(asSocket(s4));
      expect(s4.disconnect).not.toHaveBeenCalled();
    });
  });
});
