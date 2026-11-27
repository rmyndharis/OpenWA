import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { BrowserSession } from '../auth/entities/browser-session.entity';
import { LoggerService } from '../../common/services/logger.service';
import { ChatScopeService } from '../auth/chat-scope.service';

// ConfigService stub for the media-shed knob: no override means the default cap applies.
const asConfig = (): { get: jest.Mock } => ({ get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue) });
import { Socket } from 'socket.io';
import { EventsGateway, QR_DENIED_ROOM, isSessionSubscriptionAllowed } from './events.gateway';
import { AuthService } from '../auth/auth.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { SUBSCRIBABLE_EVENTS, buildRoomName } from './dto/ws-messages.dto';
import type { WSClientMessage, WSErrorResponse, WSSubscribedResponse, WSEventMessage } from './dto/ws-messages.dto';
import { WEBHOOK_RESERVED_EVENTS } from '../webhook/dto/webhook.dto';
import { SlidingWindowLimiter } from './ws-rate-limit';
import { ApiKeyCapability } from '../auth/api-key-permissions';

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
  /** socket.io sets this the moment the transport closes, before the disconnect handler runs. */
  disconnected?: boolean;
  emit: jest.Mock;
  disconnect: jest.Mock;
  join: jest.Mock;
  leave: jest.Mock;
  rooms: Set<string>;
}

describe('EventsGateway connection auth + subscribe re-validation', () => {
  let gateway: EventsGateway;
  let authService: { validateApiKey: jest.Mock };

  const makeSocket = (auth: { apiKey?: string } = {}): MockSocket => {
    const s: MockSocket = {
      id: 'sock-1',
      handshake: { headers: {}, query: {}, auth, address: '203.0.113.5' },
      data: {},
      emit: jest.fn(),
      // Like socket.io, a server-side close marks the socket disconnected at once.
      disconnect: jest.fn(() => {
        s.disconnected = true;
      }),
      join: jest.fn(),
      leave: jest.fn(),
      // Socket.IO puts every socket in a room named after its own id.
      rooms: new Set<string>(['sock-1']),
    };
    return s;
  };
  const unauthorizedEmits = (s: MockSocket): unknown[] =>
    s.emit.mock.calls.filter(([, frame]) => (frame as WSErrorResponse | undefined)?.code === 'UNAUTHORIZED');
  // Subscription rooms joined by the socket; the QR-denied role room is not a subscription.
  const sessionRoomJoins = (s: MockSocket): string[] =>
    s.join.mock.calls.map(([room]) => room as string).filter(room => room.startsWith('session:'));
  const asSocket = (s: MockSocket): Socket => s as unknown as Socket;
  const subscribeMsg = (sessionId: string, events: string[]): WSClientMessage =>
    ({ type: 'subscribe', sessionId, events, requestId: 'r1' }) as unknown as WSClientMessage;

  let auditService: { logWarn: jest.Mock };

  beforeEach(() => {
    authService = { validateApiKey: jest.fn() };
    auditService = { logWarn: jest.fn().mockResolvedValue(null) };
    gateway = new EventsGateway(
      authService as unknown as AuthService,
      auditService as unknown as AuditService,
      asConfig() as unknown as ConfigService,
    );
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

  it('rejects the handshake when the key blocks events:read', async () => {
    authService.validateApiKey.mockResolvedValue({
      id: 'k1',
      name: 'k',
      allowedSessions: null,
      deniedPermissions: [ApiKeyCapability.EVENTS_READ],
    });
    const sock = makeSocket({ apiKey: 'blocked' });

    await gateway.handleConnection(asSocket(sock));

    expect(sock.disconnect).toHaveBeenCalled();
    expect(sessionRoomJoins(sock)).toEqual([]);
  });

  it('accepts a chat-restricted key without granting global event rooms at the handshake', async () => {
    authService.validateApiKey.mockResolvedValue({ name: 'k', allowedSessions: null, allowedChats: ['123@g.us'] });
    const sock = makeSocket({ apiKey: 'good' });
    await gateway.handleConnection(asSocket(sock));
    expect(sock.disconnect).not.toHaveBeenCalled();
    expect(sessionRoomJoins(sock)).toEqual([]);
    expect(auditService.logWarn).not.toHaveBeenCalled();
  });

  it('keeps wildcard subscriptions inside the allowlist for a chat-restricted key', async () => {
    authService.validateApiKey.mockResolvedValue({
      name: 'k',
      allowedSessions: null,
      allowedChats: ['123@g.us'],
      deniedPermissions: [],
    });
    const sock = makeSocket({ apiKey: 'good' });
    await gateway.handleConnection(asSocket(sock));

    const res = (await gateway.handleMessage(asSocket(sock), subscribeMsg('sess-1', ['*']))) as WSSubscribedResponse;

    expect(res.type).toBe('subscribed');
    expect(res.events).toEqual(['*']);
    expect(sessionRoomJoins(sock)).toEqual([`${buildRoomName('sess-1', '*')}:chat:123%40g.us`]);
    expect(sessionRoomJoins(sock)).not.toContain(buildRoomName('sess-1', '*'));
  });

  it('refuses a subscribe once the key has gained allowedChats after connect', async () => {
    authService.validateApiKey.mockResolvedValueOnce({ name: 'k', allowedSessions: null }); // connect
    const sock = makeSocket({ apiKey: 'good' });
    await gateway.handleConnection(asSocket(sock));
    expect(sock.disconnect).not.toHaveBeenCalled();

    authService.validateApiKey.mockResolvedValueOnce({ name: 'k', allowedSessions: null, allowedChats: ['123@g.us'] });
    const res = (await gateway.handleMessage(asSocket(sock), subscribeMsg('sess-1', ['*']))) as WSErrorResponse;

    expect(res.code).toBe('UNAUTHORIZED');
    expect(sock.disconnect).toHaveBeenCalled();
    expect(sessionRoomJoins(sock)).toEqual([]);
    expect(unauthorizedEmits(sock)).toHaveLength(1);
    expect(auditService.logWarn).toHaveBeenCalledWith(
      AuditAction.API_KEY_AUTH_FAILED,
      expect.objectContaining({
        apiKey: expect.objectContaining({ allowedChats: ['123@g.us'] }) as unknown,
        ipAddress: '203.0.113.5',
        metadata: { surface: 'websocket' },
      }),
    );
  });

  it('re-validates on subscribe and disconnects a key revoked after connect', async () => {
    authService.validateApiKey.mockResolvedValueOnce({ name: 'k', allowedSessions: null }); // connect
    const sock = makeSocket({ apiKey: 'good' });
    await gateway.handleConnection(asSocket(sock));

    // validateApiKey throws on a revoked key; it never resolves to a falsy value.
    authService.validateApiKey.mockRejectedValueOnce(new UnauthorizedException('API key revoked'));
    const res = (await gateway.handleMessage(asSocket(sock), subscribeMsg('sess-1', ['*']))) as WSErrorResponse;

    expect(sock.disconnect).toHaveBeenCalled();
    expect(res.code).toBe('UNAUTHORIZED');
    expect(unauthorizedEmits(sock)).toHaveLength(1);
    expect(auditService.logWarn).toHaveBeenCalledWith(AuditAction.API_KEY_AUTH_FAILED, {
      // The key the socket connected with, so the row says which key to revoke or re-scope.
      apiKey: expect.objectContaining({ name: 'k' }) as unknown,
      ipAddress: '203.0.113.5',
      metadata: { surface: 'websocket' },
      errorMessage: 'API key revoked',
    });
  });

  it('refuses a subscribe when events:read was blocked after the handshake', async () => {
    authService.validateApiKey.mockResolvedValueOnce({ id: 'k1', name: 'k', allowedSessions: null });
    const sock = makeSocket({ apiKey: 'good' });
    await gateway.handleConnection(asSocket(sock));
    authService.validateApiKey.mockResolvedValueOnce({
      id: 'k1',
      name: 'k',
      allowedSessions: null,
      deniedPermissions: [ApiKeyCapability.EVENTS_READ],
    });

    const res = (await gateway.handleMessage(
      asSocket(sock),
      subscribeMsg('sess-1', ['session.status']),
    )) as WSErrorResponse;

    expect(res.code).toBe('FORBIDDEN_EVENTS');
    expect(sessionRoomJoins(sock)).toEqual([]);
  });

  it('removes message events from a wildcard when messages:read is blocked', async () => {
    const key = {
      id: 'k1',
      name: 'k',
      role: 'operator',
      allowedSessions: null,
      deniedPermissions: [ApiKeyCapability.MESSAGES_READ],
    };
    authService.validateApiKey.mockResolvedValue(key);
    const sock = makeSocket({ apiKey: 'good' });
    await gateway.handleConnection(asSocket(sock));

    const res = (await gateway.handleMessage(asSocket(sock), subscribeMsg('sess-1', ['*']))) as WSSubscribedResponse;

    expect(res.type).toBe('subscribed');
    expect(res.events).toContain('session.status');
    expect(res.events).not.toContain('message.received');
    expect(sessionRoomJoins(sock)).not.toContain(buildRoomName('sess-1', '*'));
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
    expect(sessionRoomJoins(sock)).toEqual([]);
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
    expect(sessionRoomJoins(sock)).toEqual([]);
  });

  // The session id becomes part of every room name the socket keeps until it disconnects, so an
  // oversized or malformed one must be refused before it costs a key lookup or a room.
  it.each([
    ['oversized', 'a'.repeat(129)],
    ['malformed', 'sess:1'],
  ])('refuses a %s sessionId with INVALID_SESSION', async (_label, sessionId) => {
    authService.validateApiKey.mockResolvedValue({ name: 'k', allowedSessions: null });
    const sock = makeSocket({ apiKey: 'good' });
    await gateway.handleConnection(asSocket(sock));
    authService.validateApiKey.mockClear();

    const res = (await gateway.handleMessage(asSocket(sock), subscribeMsg(sessionId, ['*']))) as WSErrorResponse;

    expect(res.code).toBe('INVALID_SESSION');
    expect(authService.validateApiKey).not.toHaveBeenCalled();
    expect(sessionRoomJoins(sock)).toEqual([]);
  });

  it('keeps one room per chat for a chat key that blocks nothing a chat room carries', async () => {
    authService.validateApiKey.mockResolvedValue({
      name: 'k',
      allowedSessions: null,
      allowedChats: ['123@g.us'],
      deniedPermissions: [ApiKeyCapability.SESSIONS_PAIR],
    });
    const sock = makeSocket({ apiKey: 'good' });
    await gateway.handleConnection(asSocket(sock));

    const res = (await gateway.handleMessage(asSocket(sock), subscribeMsg('sess-1', ['*']))) as WSSubscribedResponse;

    expect(res.events).toEqual(['*']);
    expect(sessionRoomJoins(sock)).toEqual([`${buildRoomName('sess-1', '*')}:chat:123%40g.us`]);
  });

  it('does not suggest "*" when a blocked chat event makes the wildcard cost a room per event', async () => {
    authService.validateApiKey.mockResolvedValue({
      name: 'k',
      allowedSessions: null,
      allowedChats: Array.from({ length: 2000 }, (_, i) => `${i}@g.us`),
      deniedPermissions: [ApiKeyCapability.MESSAGES_READ],
    });
    const sock = makeSocket({ apiKey: 'good' });
    await gateway.handleConnection(asSocket(sock));

    const res = (await gateway.handleMessage(asSocket(sock), subscribeMsg('sess-1', ['*']))) as WSErrorResponse;

    expect(res.code).toBe('TOO_MANY_SUBSCRIPTIONS');
    expect(res.message).toContain('name fewer events');
    expect(res.message).not.toContain('"*"');
  });

  it('refuses a subscribe that would take the socket past its room cap', async () => {
    authService.validateApiKey.mockResolvedValue({ name: 'k', allowedSessions: null });
    const sock = makeSocket({ apiKey: 'good' });
    await gateway.handleConnection(asSocket(sock));
    for (let i = 0; i < 4096; i++) sock.rooms.add(buildRoomName(`s${i}`, '*'));

    const res = (await gateway.handleMessage(asSocket(sock), subscribeMsg('sess-1', ['*']))) as WSErrorResponse;
    expect(res.code).toBe('TOO_MANY_SUBSCRIPTIONS');
    expect(sessionRoomJoins(sock)).toEqual([]);

    // Re-subscribing a room the socket already holds adds nothing, so it is still granted.
    const again = (await gateway.handleMessage(asSocket(sock), subscribeMsg('s1', ['*']))) as WSSubscribedResponse;
    expect(again.type).toBe('subscribed');
  });

  it('counts only subscription rooms toward the cap, not the own-id or role rooms', async () => {
    authService.validateApiKey.mockResolvedValue({ name: 'k', allowedSessions: null });
    const sock = makeSocket({ apiKey: 'good' });
    await gateway.handleConnection(asSocket(sock));
    sock.rooms.add(QR_DENIED_ROOM);
    for (let i = 0; i < 4095; i++) sock.rooms.add(buildRoomName(`s${i}`, '*'));

    const res = (await gateway.handleMessage(asSocket(sock), subscribeMsg('sess-1', ['*']))) as WSSubscribedResponse;
    expect(res.type).toBe('subscribed');
    expect(sessionRoomJoins(sock)).toEqual([buildRoomName('sess-1', '*')]);
  });

  it('pushes a command reply on the message event, not only through the ack callback', async () => {
    // The Socket.IO adapter delivers a handler's return value through the ack callback and nothing
    // else, so a client that emits without one (the dashboard, and the documented example client)
    // saw no answer at all: no subscribe confirmation, and none of the refusals.
    authService.validateApiKey.mockResolvedValue({ name: 'k', allowedSessions: ['sess-1'] });
    const sock = makeSocket({ apiKey: 'good' });
    await gateway.handleConnection(asSocket(sock));
    sock.emit.mockClear();

    const granted = (await gateway.handleMessage(
      asSocket(sock),
      subscribeMsg('sess-1', ['message.received']),
    )) as WSSubscribedResponse;
    expect(sock.emit).toHaveBeenCalledWith('message', granted);

    sock.emit.mockClear();
    const refused = (await gateway.handleMessage(asSocket(sock), subscribeMsg('sess-2', ['*']))) as WSErrorResponse;
    expect(refused.code).toBe('FORBIDDEN_SESSION');
    expect(sock.emit).toHaveBeenCalledWith('message', refused);

    sock.emit.mockClear();
    const pong = await gateway.handleMessage(asSocket(sock), { type: 'ping' } as unknown as WSClientMessage);
    expect(sock.emit).toHaveBeenCalledWith('message', pong);

    sock.emit.mockClear();
    const unsubscribed = await gateway.handleMessage(asSocket(sock), {
      type: 'unsubscribe',
      sessionId: 'sess-1',
      events: ['message.received'],
    } as unknown as WSClientMessage);
    expect(sock.emit).toHaveBeenCalledWith('message', unsubscribed);

    sock.emit.mockClear();
    const unknown = await gateway.handleMessage(asSocket(sock), { type: 'nonsense' } as unknown as WSClientMessage);
    expect((unknown as WSErrorResponse).code).toBe('INVALID_MESSAGE');
    expect(sock.emit).toHaveBeenCalledWith('message', unknown);

    // A 'message' emitted with no payload, or with null, is answered like any unknown frame rather
    // than throwing inside the handler.
    for (const nil of [undefined, null]) {
      sock.emit.mockClear();
      const invalid = await gateway.handleMessage(asSocket(sock), nil);
      expect((invalid as WSErrorResponse).code).toBe('INVALID_MESSAGE');
      expect(sock.emit).toHaveBeenCalledTimes(1);
      expect(sock.emit).toHaveBeenCalledWith('message', invalid);
    }
  });

  it('holds a frame that arrives while the handshake is still validating until it completes', async () => {
    // socket.io sends CONNECT before Nest runs handleConnection, so a client that subscribes from its
    // 'connect' handler can land here before the key is stored on the socket.
    let finishHandshake!: (key: unknown) => void;
    authService.validateApiKey.mockReturnValueOnce(new Promise(resolve => (finishHandshake = resolve)));
    authService.validateApiKey.mockResolvedValue({ id: 'k1', name: 'k', allowedSessions: null });
    const sock = makeSocket({ apiKey: 'good' });
    const connecting = gateway.handleConnection(asSocket(sock));

    const subscribing = gateway.handleMessage(asSocket(sock), subscribeMsg('sess-1', ['message.received']));
    finishHandshake({ id: 'k1', name: 'k', allowedSessions: null });
    await connecting;

    const res = (await subscribing) as WSSubscribedResponse;
    expect(res.type).toBe('subscribed');
    expect(sock.disconnect).not.toHaveBeenCalled();
    expect(sessionRoomJoins(sock)).toEqual([buildRoomName('sess-1', 'message.received')]);
  });

  it('drops a frame that arrived during a handshake that was then refused', async () => {
    let failHandshake!: (err: Error) => void;
    authService.validateApiKey.mockReturnValueOnce(new Promise((_, reject) => (failHandshake = reject)));
    const sock = makeSocket({ apiKey: 'bad' });
    sock.disconnect.mockImplementation(() => (sock.disconnected = true));
    const connecting = gateway.handleConnection(asSocket(sock));

    const subscribing = gateway.handleMessage(asSocket(sock), subscribeMsg('sess-1', ['message.received']));
    failHandshake(new UnauthorizedException('Invalid API key'));
    await connecting;

    expect(await subscribing).toBeUndefined();
    // Only the handshake's own refusal reached the client, and the frame never re-validated.
    expect(sock.emit).toHaveBeenCalledTimes(1);
    expect(authService.validateApiKey).toHaveBeenCalledTimes(1);
    expect(sessionRoomJoins(sock)).toEqual([]);
  });

  it('answers an unsubscribe without a sessionId with INVALID_SESSION and leaves the rooms alone', async () => {
    authService.validateApiKey.mockResolvedValue({ name: 'k', allowedSessions: null });
    const sock = makeSocket({ apiKey: 'good' });
    await gateway.handleConnection(asSocket(sock));
    sock.rooms.add(buildRoomName('sess-1', 'message.received'));

    for (const sessionId of [undefined, null, 5]) {
      const res = (await gateway.handleMessage(asSocket(sock), {
        type: 'unsubscribe',
        sessionId,
        requestId: 'r1',
      } as unknown as WSClientMessage)) as WSErrorResponse;
      expect(res.code).toBe('INVALID_SESSION');
      expect(res.requestId).toBe('r1');
    }
    expect(sock.leave).not.toHaveBeenCalledWith(buildRoomName('sess-1', 'message.received'));
  });

  // An unsubscribe is answered with the session id it names, so it is bound like the one a subscribe
  // accepts: a reply holds only "*" or a short session id, never whatever string the client sent.
  it.each([
    ['oversized', 'a'.repeat(129)],
    ['malformed', 'sess:1'],
  ])('refuses an unsubscribe with a %s sessionId instead of echoing it', async (_label, sessionId) => {
    authService.validateApiKey.mockResolvedValue({ name: 'k', allowedSessions: null });
    const sock = makeSocket({ apiKey: 'good' });
    await gateway.handleConnection(asSocket(sock));
    sock.rooms.add(buildRoomName('sess-1', 'message.received'));

    const res = (await gateway.handleMessage(asSocket(sock), {
      type: 'unsubscribe',
      sessionId,
      requestId: 'r1',
    } as unknown as WSClientMessage)) as WSErrorResponse;

    expect(res.code).toBe('INVALID_SESSION');
    expect(res.requestId).toBe('r1');
    expect(JSON.stringify(sock.emit.mock.calls)).not.toContain(sessionId);
    expect(sock.leave).not.toHaveBeenCalled();
  });

  it('still answers an unsubscribe from "*" and from a session id at the length limit', async () => {
    authService.validateApiKey.mockResolvedValue({ name: 'k', allowedSessions: null });
    const sock = makeSocket({ apiKey: 'good' });
    await gateway.handleConnection(asSocket(sock));
    const longest = 'a'.repeat(128);
    sock.rooms.add(buildRoomName(longest, 'message.received'));
    sock.rooms.add(buildRoomName('sess-2', 'message.received'));

    const one = await gateway.handleMessage(asSocket(sock), { type: 'unsubscribe', sessionId: longest } as never);
    expect(one).toMatchObject({ type: 'unsubscribed', sessionId: longest });
    expect(sock.leave).toHaveBeenCalledTimes(1);
    expect(sock.leave).toHaveBeenCalledWith(buildRoomName(longest, 'message.received'));

    const all = await gateway.handleMessage(asSocket(sock), { type: 'unsubscribe', sessionId: '*' } as never);
    expect(all).toMatchObject({ type: 'unsubscribed', sessionId: '*' });
    expect(sock.leave).toHaveBeenCalledWith(buildRoomName('sess-2', 'message.received'));
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
    expect(sessionRoomJoins(sock)).toEqual([]);
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
    expect(sessionRoomJoins(sock)).toEqual([]);
  });

  describe('pending subscription cancellation', () => {
    const pendingSubscribe = async (sessionId = 'sess-1') => {
      const apiKey = { id: 'k1', name: 'k', role: 'viewer', allowedSessions: null };
      authService.validateApiKey.mockResolvedValue(apiKey);
      const sock = makeSocket({ apiKey: 'good' });
      sock.join.mockImplementation((room: string) => sock.rooms.add(room));
      sock.leave.mockImplementation((room: string) => sock.rooms.delete(room));
      await gateway.handleConnection(asSocket(sock));
      let resolve!: (key: typeof apiKey) => void;
      let reject!: (error: Error) => void;
      const validation = new Promise<typeof apiKey>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      let entered!: () => void;
      const started = new Promise<void>(yes => (entered = yes));
      authService.validateApiKey.mockImplementationOnce(() => {
        entered();
        return validation;
      });
      const subscribing = gateway.handleMessage(asSocket(sock), subscribeMsg(sessionId, ['message.received']));
      await started;
      return { sock, apiKey, resolve, reject, subscribing };
    };
    const pendingFor = (sock: MockSocket) =>
      (gateway as unknown as { pendingSubscriptions: WeakMap<Socket, Set<unknown>> }).pendingSubscriptions.get(
        asSocket(sock),
      );

    it.each([
      ['sess-1', 'sess-1'],
      ['sess-1', '*'],
      ['*', '*'],
    ])('cancels a pending subscribe to %s when unsubscribing from %s', async (sessionId, unsubscribe) => {
      const pending = await pendingSubscribe(sessionId);
      expect(
        await gateway.handleMessage(asSocket(pending.sock), { type: 'unsubscribe', sessionId: unsubscribe }),
      ).toMatchObject({ type: 'unsubscribed' });
      pending.resolve(pending.apiKey);
      expect(await pending.subscribing).toMatchObject({ code: 'SUBSCRIPTION_CANCELLED', requestId: 'r1' });
      expect(sessionRoomJoins(pending.sock)).toEqual([]);
      expect(pendingFor(pending.sock)).toBeUndefined();

      expect(
        await gateway.handleMessage(asSocket(pending.sock), subscribeMsg(sessionId, ['message.received'])),
      ).toMatchObject({ type: 'subscribed' });
      expect(pending.sock.rooms.has(buildRoomName(sessionId, 'message.received'))).toBe(true);
    });

    it('does not cancel a pending subscribe when another session is unsubscribed', async () => {
      const pending = await pendingSubscribe();
      expect(
        await gateway.handleMessage(asSocket(pending.sock), { type: 'unsubscribe', sessionId: 'sess-2' }),
      ).toMatchObject({ type: 'unsubscribed' });
      pending.resolve(pending.apiKey);
      expect(await pending.subscribing).toMatchObject({ type: 'subscribed' });
      expect(pending.sock.rooms.has(buildRoomName('sess-1', 'message.received'))).toBe(true);
    });

    it('still refuses failed authorization after a cancellation and clears the pending subscription', async () => {
      const pending = await pendingSubscribe();
      await gateway.handleMessage(asSocket(pending.sock), { type: 'unsubscribe', sessionId: '*' });
      pending.reject(new UnauthorizedException('API key revoked'));
      expect(await pending.subscribing).toMatchObject({ code: 'UNAUTHORIZED' });
      expect(pending.sock.disconnected).toBe(true);
      expect(sessionRoomJoins(pending.sock)).toEqual([]);
      expect(pendingFor(pending.sock)).toBeUndefined();
    });
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

    // The periodic sweep (expiry, revocation, deletion, narrowing) reads the api_keys table, so it is
    // exercised against a real one in events.gateway.authz-sweep.spec.ts rather than a stub here.
  });

  it('runs the authorization sweep every minute from afterInit until onModuleDestroy', async () => {
    jest.useFakeTimers();
    try {
      const sweep = jest
        .spyOn(gateway as unknown as { sweepApiKeyAuthorization: () => Promise<void> }, 'sweepApiKeyAuthorization')
        .mockRejectedValueOnce(new Error('database is locked'))
        .mockResolvedValue(undefined);
      gateway.afterInit();

      await jest.advanceTimersByTimeAsync(60_000);
      expect(sweep).toHaveBeenCalledTimes(1);
      // A failed tick is logged, and the next one still runs.
      await jest.advanceTimersByTimeAsync(60_000);
      expect(sweep).toHaveBeenCalledTimes(2);

      await gateway.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(120_000);
      expect(sweep).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});

// A capturing, chainable Socket.IO server stub: server.to(r1).to(r2)...emit(...) all
// resolve to one operator whose emit() we count. Mirrors the real BroadcastOperator,
// where chained .to() accumulates rooms into a single deduped broadcast.
const makeCapturingServer = () => {
  const rooms: string[] = [];
  const emit = jest.fn();
  const op: { to: jest.Mock; except: jest.Mock; emit: jest.Mock } = { to: jest.fn(), except: jest.fn(), emit };
  op.to.mockImplementation((r: string) => {
    rooms.push(r);
    return op;
  });
  op.except.mockImplementation(() => op);
  const server = { to: jest.fn((r: string) => (rooms.push(r), op)) };
  return { server, emit, rooms };
};

describe('EventsGateway inline-media shedding on message events', () => {
  const gwWithCap = (cap?: number) => {
    const config = {
      get: jest.fn((_key: string, defaultValue?: unknown) => (cap === undefined ? defaultValue : cap)),
    };
    return new EventsGateway(
      { validateApiKey: jest.fn() } as unknown as AuthService,
      { logWarn: jest.fn().mockResolvedValue(null) } as unknown as AuditService,
      config as unknown as ConfigService,
    );
  };
  const bigMedia = (): Record<string, unknown> => ({
    id: 'm1',
    media: { mimetype: 'image/jpeg', filename: 'big.jpg', data: 'A'.repeat(1024 * 1024 * 2) }, // ~1.5 MB decoded
  });

  it('replaces an over-cap inline media blob with the omitted marker on message.received', () => {
    const gateway = gwWithCap();
    const { server, emit } = makeCapturingServer();
    (gateway as unknown as { server: unknown }).server = server;
    const message = bigMedia();

    gateway.emitMessage('sess-1', message);

    const [, sent] = emit.mock.calls[0] as [string, WSEventMessage];
    expect(sent.payload.event).toBe('message.received');
    const media = (sent.payload.data as Record<string, unknown>).media as Record<string, unknown>;
    expect(media.omitted).toBe(true);
    expect(media.data).toBeUndefined();
    expect(media.mimetype).toBe('image/jpeg');
    expect(media.filename).toBe('big.jpg');
    expect(typeof media.sizeBytes).toBe('number');
    // The caller's event object is never mutated: the webhook fan-out receives the same object.
    expect((message.media as Record<string, unknown>).data).toHaveLength(1024 * 1024 * 2);
  });

  it('sheds on message.sent with the same contract', () => {
    const gateway = gwWithCap();
    const { server, emit } = makeCapturingServer();
    (gateway as unknown as { server: unknown }).server = server;

    gateway.emitMessageSent('sess-1', bigMedia());

    const [, sent] = emit.mock.calls[0] as [string, WSEventMessage];
    expect(sent.payload.event).toBe('message.sent');
    expect(((sent.payload.data as Record<string, unknown>).media as Record<string, unknown>).omitted).toBe(true);
  });

  it('passes small inline media through untouched', () => {
    const gateway = gwWithCap();
    const { server, emit } = makeCapturingServer();
    (gateway as unknown as { server: unknown }).server = server;
    const small = { id: 'm2', media: { mimetype: 'image/png', data: 'aGk=' } };

    gateway.emitMessage('sess-1', small);

    const [, sent] = emit.mock.calls[0] as [string, WSEventMessage];
    expect((sent.payload.data as Record<string, unknown>).media).toEqual({ mimetype: 'image/png', data: 'aGk=' });
  });

  it('honors a tightened cap (0 sheds every inline blob, matching the webhook knob semantics)', () => {
    const gateway = gwWithCap(0);
    const { server, emit } = makeCapturingServer();
    (gateway as unknown as { server: unknown }).server = server;

    gateway.emitMessage('sess-1', { id: 'm3', media: { mimetype: 'image/png', data: 'aGk=' } });

    const [, sent] = emit.mock.calls[0] as [string, WSEventMessage];
    expect(((sent.payload.data as Record<string, unknown>).media as Record<string, unknown>).omitted).toBe(true);
  });
});

describe('EventsGateway.emitToRooms fan-out', () => {
  const gw = () =>
    new EventsGateway(
      { validateApiKey: jest.fn() } as unknown as AuthService,
      { logWarn: jest.fn().mockResolvedValue(null) } as unknown as AuditService,
      asConfig() as unknown as ConfigService,
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

// session.qr is a pairing credential: GET /sessions/:sessionId/qr requires OPERATOR, so the socket push
// must not hand it to a VIEWER key under any subscribe form. The stub below stands in for the Socket.IO
// adapter: it tracks each socket's rooms and resolves to()/except() like a real broadcast (union of the
// target rooms, minus sockets in an excluded room, one copy per socket).
describe('EventsGateway session.qr role gate', () => {
  interface RoomSocket {
    id: string;
    handshake: { headers: Record<string, string>; auth: { apiKey: string }; address: string };
    data: Record<string, unknown>;
    rooms: Set<string>;
    received: WSEventMessage[];
    emit: jest.Mock;
    disconnect: jest.Mock;
    join: (room: string) => void;
    leave: (room: string) => void;
  }
  type Broadcast = {
    to: (room: string) => Broadcast;
    except: (room: string) => Broadcast;
    emit: (channel: string, msg: WSEventMessage) => boolean;
  };

  let keys: Record<
    string,
    {
      id: string;
      name: string;
      role: string;
      allowedSessions: string[] | null;
      deniedPermissions?: ApiKeyCapability[];
    }
  >;
  let gateway: EventsGateway;
  let sockets: RoomSocket[];

  const broadcast = (to: string[], except: string[]): Broadcast => ({
    to: room => broadcast([...to, room], except),
    except: room => broadcast(to, [...except, room]),
    emit: (_channel, msg) => {
      for (const s of sockets) {
        if (to.some(r => s.rooms.has(r)) && !except.some(r => s.rooms.has(r))) s.received.push(msg);
      }
      return true;
    },
  });

  const connect = async (apiKey: string): Promise<RoomSocket> => {
    const rooms = new Set<string>();
    const sock: RoomSocket = {
      id: `sock-${sockets.length}`,
      handshake: { headers: {}, auth: { apiKey }, address: '203.0.113.5' },
      data: {},
      rooms,
      received: [],
      emit: jest.fn(),
      disconnect: jest.fn(),
      join: room => void rooms.add(room),
      leave: room => void rooms.delete(room),
    };
    sockets.push(sock);
    await gateway.handleConnection(sock as unknown as Socket);
    return sock;
  };
  const subscribe = (sock: RoomSocket, sessionId: string, events: string[]) =>
    gateway.handleMessage(
      sock as unknown as Socket,
      {
        type: 'subscribe',
        sessionId,
        events,
        requestId: 'r1',
      } as unknown as WSClientMessage,
    );
  const qrEvents = (sock: RoomSocket) => sock.received.filter(m => m.payload.event === 'session.qr');

  beforeEach(() => {
    sockets = [];
    keys = {
      viewer: { id: 'k-viewer', name: 'viewer', role: 'viewer', allowedSessions: null },
      operator: { id: 'k-operator', name: 'operator', role: 'operator', allowedSessions: null },
      admin: { id: 'k-admin', name: 'admin', role: 'admin', allowedSessions: null },
    };
    gateway = new EventsGateway(
      { validateApiKey: jest.fn((raw: string) => Promise.resolve({ ...keys[raw] })) } as unknown as AuthService,
      { logWarn: jest.fn().mockResolvedValue(null) } as unknown as AuditService,
      asConfig() as unknown as ConfigService,
    );
    (gateway as unknown as { server: unknown }).server = { to: (room: string) => broadcast([room], []) };
  });

  it('never delivers the QR to a VIEWER socket, whatever it subscribed to, while OPERATOR and ADMIN get it', async () => {
    const viewerByName = await connect('viewer');
    const viewerSessionWildcard = await connect('viewer');
    const viewerGlobalWildcard = await connect('viewer');
    const viewerEventWildcard = await connect('viewer');
    const operator = await connect('operator');
    const admin = await connect('admin');
    await subscribe(viewerByName, 'sess-1', ['session.qr']);
    await subscribe(viewerSessionWildcard, 'sess-1', ['*']);
    await subscribe(viewerGlobalWildcard, '*', ['*']);
    await subscribe(viewerEventWildcard, '*', ['session.qr']);
    await subscribe(operator, '*', ['*']);
    await subscribe(admin, 'sess-1', ['session.qr']);

    gateway.emitQRCode('sess-1', 'data:image/png;base64,QR');

    for (const viewer of [viewerByName, viewerSessionWildcard, viewerGlobalWildcard, viewerEventWildcard]) {
      expect(qrEvents(viewer)).toEqual([]);
    }
    expect(qrEvents(operator)).toHaveLength(1);
    expect(qrEvents(operator)[0].payload.data).toEqual({ qrCode: 'data:image/png;base64,QR' });
    expect(qrEvents(admin)).toHaveLength(1);
  });

  it('keeps delivering every other event to a VIEWER wildcard subscription', async () => {
    const viewer = await connect('viewer');
    await subscribe(viewer, '*', ['*']);

    gateway.emitSessionStatus('sess-1', 'qr_ready');

    expect(viewer.received.map(m => m.payload.event)).toEqual(['session.status']);
  });

  it('follows the role re-validated on subscribe: a narrowed key stops receiving the QR, a widened one starts', async () => {
    const narrowed = await connect('operator');
    const widened = await connect('viewer');
    await subscribe(widened, 'sess-1', ['*']);
    expect(widened.rooms.has(QR_DENIED_ROOM)).toBe(true);
    keys.operator.role = 'viewer';
    keys.viewer.role = 'operator';
    await subscribe(narrowed, 'sess-1', ['*']);
    await subscribe(widened, 'sess-1', ['*']);

    gateway.emitQRCode('sess-1', 'data:image/png;base64,QR');

    expect(qrEvents(narrowed)).toEqual([]);
    expect(qrEvents(widened)).toHaveLength(1);
  });

  it('denies the QR to a key with an unrecognised role', async () => {
    keys.viewer.role = 'unknown';
    const sock = await connect('viewer');
    await subscribe(sock, 'sess-1', ['session.qr']);

    gateway.emitQRCode('sess-1', 'data:image/png;base64,QR');

    expect(sock.rooms.has(QR_DENIED_ROOM)).toBe(true);
    expect(qrEvents(sock)).toEqual([]);
  });

  it('denies the QR to an operator blocked from sessions:pair', async () => {
    keys.operator.deniedPermissions = [ApiKeyCapability.SESSIONS_PAIR];
    const sock = await connect('operator');
    const response = (await subscribe(sock, 'sess-1', ['session.qr'])) as WSErrorResponse;

    gateway.emitQRCode('sess-1', 'data:image/png;base64,QR');

    expect(response.code).toBe('FORBIDDEN_EVENTS');
    expect(sock.rooms.has(QR_DENIED_ROOM)).toBe(true);
    expect(qrEvents(sock)).toEqual([]);
  });

  it('delivers message.receipt only to sockets that named it, never through a wildcard', async () => {
    const wildcard = await connect('operator');
    await subscribe(wildcard, '*', ['*']);
    const sessionWildcard = await connect('operator');
    await subscribe(sessionWildcard, 'sess-1', ['*']);
    const named = await connect('operator');
    await subscribe(named, 'sess-1', ['message.receipt']);
    const namedAllSessions = await connect('operator');
    await subscribe(namedAllSessions, '*', ['message.receipt']);

    gateway.emitMessageReceipt('sess-1', {
      id: 'OUT1',
      messageId: 'OUT1',
      chatId: '120363000000000001@g.us',
      participant: '628222@c.us',
      status: 'read',
      timestamp: 1700000000,
    });

    const events = (s: RoomSocket): string[] => s.received.map(m => m.payload.event);
    expect(events(wildcard)).toEqual([]);
    expect(events(sessionWildcard)).toEqual([]);
    expect(events(named)).toEqual(['message.receipt']);
    expect(events(namedAllSessions)).toEqual(['message.receipt']);
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
      asConfig() as unknown as ConfigService,
    );
    const captured: string[] = [];
    const op: { to: () => unknown; except: () => unknown; emit: (ch: string, msg: WSEventMessage) => boolean } = {
      to: () => op,
      except: () => op,
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

  const makeSock = (id: string, auth: { apiKey?: string } = {}, address = '203.0.113.5'): MockSocket => ({
    id,
    handshake: { headers: {}, query: {}, auth, address },
    data: {},
    emit: jest.fn(),
    disconnect: jest.fn(),
    join: jest.fn(),
    leave: jest.fn(),
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
    gateway = new EventsGateway(
      authService as unknown as AuthService,
      auditService as unknown as AuditService,
      asConfig() as unknown as ConfigService,
    );
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
      authService.validateApiKey.mockRejectedValue(new UnauthorizedException('Invalid API key'));
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
      authService.validateApiKey.mockRejectedValue(new UnauthorizedException('Invalid API key'));
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

    it.each([false, true])(
      'keeps newer failures charged after a delayed valid handshake (pruned: %s)',
      async pruned => {
        let now = 0;
        let finish!: (key: unknown) => void;
        const validation = new Promise(resolve => (finish = resolve));
        authService.validateApiKey.mockImplementation((raw: string) =>
          raw === 'good' ? validation : Promise.reject(new UnauthorizedException('Invalid API key')),
        );
        const gw = buildGateway();
        (gw as unknown as { handshakeLimiter: SlidingWindowLimiter }).handshakeLimiter = new SlidingWindowLimiter(
          2,
          1000,
          () => now,
        );
        const good = makeSock('good', { apiKey: 'good' });
        const connecting = gw.handleConnection(asSocket(good));
        now = pruned ? 1001 : 500;
        await gw.handleConnection(asSocket(makeSock('bad-1', { apiKey: 'bad' })));
        now = pruned ? 1002 : 600;
        finish({ id: 'k1', name: 'k', allowedSessions: null });
        await connecting;
        expect(good.disconnect).not.toHaveBeenCalled();
        expect(authService.validateApiKey).toHaveBeenCalledWith('good', '203.0.113.5');
        now = pruned ? 1003 : 1001;
        await gw.handleConnection(asSocket(makeSock('bad-2', { apiKey: 'bad' })));
        const blocked = makeSock('bad-3', { apiKey: 'bad' });
        await gw.handleConnection(asSocket(blocked));
        expect(blocked.emit).toHaveBeenCalledWith('message', expect.objectContaining({ code: 'RATE_LIMITED' }));
        expect(authService.validateApiKey).toHaveBeenCalledTimes(3);
        gw.handleDisconnect(asSocket(good));
      },
    );

    it('throttles an unauthenticated handshake flood before any credential/audit work', async () => {
      process.env.WS_RATE_LIMIT_HANDSHAKE_MAX = '2';
      const gw = buildGateway();
      const floodIp = '203.0.113.201';

      // Three key-less handshakes from one IP: the first two reach the missing-key audit,
      // the third is gated by the limiter instead (no per-attempt auth failure processing).
      await gw.handleConnection(asSocket(makeSock('a', {}, floodIp)));
      await gw.handleConnection(asSocket(makeSock('b', {}, floodIp)));
      await gw.handleConnection(asSocket(makeSock('c', {}, floodIp)));

      const authFailed = warnCalls().filter(([action]) => action === AuditAction.API_KEY_AUTH_FAILED);
      expect(authFailed).toHaveLength(2);
      expect(authService.validateApiKey).not.toHaveBeenCalled();
    });

    it('recovers once the window slides past the oldest handshake', async () => {
      process.env.WS_RATE_LIMIT_HANDSHAKE_MAX = '1';
      process.env.WS_RATE_LIMIT_HANDSHAKE_WINDOW_MS = '60000';
      jest.useFakeTimers();
      authService.validateApiKey.mockRejectedValue(new UnauthorizedException('Invalid API key'));
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
      authService.validateApiKey.mockRejectedValue(new UnauthorizedException('Invalid API key'));
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

  describe('IPv6 clients are limited on their /64', () => {
    const ipOf = ([, ctx]: [AuditAction, WarnContext?]): unknown =>
      (ctx as { ipAddress?: string } | undefined)?.ipAddress;

    it('refunds an authenticated handshake to the /64 bucket it was charged to', async () => {
      // The charge lands on the /64; a refund keyed on the full address finds no bucket, so every
      // authenticated connect from one IPv6 network would spend the shared window after all.
      process.env.WS_RATE_LIMIT_HANDSHAKE_MAX = '2';
      process.env.WS_RATE_LIMIT_HANDSHAKE_WINDOW_MS = '60000';
      process.env.WS_MAX_SOCKETS_PER_KEY = '99';
      authService.validateApiKey.mockResolvedValue({ id: 'k1', name: 'k', allowedSessions: null });
      const gw = buildGateway();

      const addresses = ['2001:db8:1:2::a', '2001:db8:1:2::a', '2001:db8:1:2::b', '2001:db8:1:2::c', '2001:db8:1:2::a'];
      for (const [i, address] of addresses.entries()) {
        const sock = makeSock(`ok${i}`, { apiKey: 'good' }, address);
        await gw.handleConnection(asSocket(sock));
        expect(sock.disconnect).not.toHaveBeenCalled();
      }
      expect(authService.validateApiKey).toHaveBeenCalledTimes(addresses.length);
    });

    it('shares the handshake window and the violation sample across a /64, keeping the real address', async () => {
      process.env.WS_RATE_LIMIT_HANDSHAKE_MAX = '1';
      authService.validateApiKey.mockRejectedValue(new UnauthorizedException('Invalid API key'));
      const gw = buildGateway();

      await gw.handleConnection(asSocket(makeSock('a', { apiKey: 'good' }, '2001:db8:1:2::a')));
      const rotatedOnce = makeSock('b', { apiKey: 'good' }, '2001:db8:1:2::b');
      await gw.handleConnection(asSocket(rotatedOnce));
      const rotatedTwice = makeSock('c', { apiKey: 'good' }, '2001:db8:1:2::c');
      await gw.handleConnection(asSocket(rotatedTwice));
      expect(rotatedOnce.emit).toHaveBeenCalledWith('message', expect.objectContaining({ code: 'RATE_LIMITED' }));
      expect(rotatedTwice.emit).toHaveBeenCalledWith('message', expect.objectContaining({ code: 'RATE_LIMITED' }));
      expect(authService.validateApiKey).toHaveBeenCalledTimes(1);

      const rateLimited = warnCalls().filter(([action]) => action === AuditAction.RATE_LIMIT_EXCEEDED);
      expect(rateLimited).toHaveLength(1);
      expect(ipOf(rateLimited[0])).toBe('2001:db8:1:2::b');

      await gw.handleConnection(asSocket(makeSock('d', { apiKey: 'good' }, '2001:db8:1:3::a')));
      expect(authService.validateApiKey).toHaveBeenCalledTimes(2);
    });

    it('meters a not-yet-authenticated socket on its /64', async () => {
      process.env.WS_RATE_LIMIT_FRAME_PER_SECOND = '1';
      process.env.WS_RATE_LIMIT_FRAME_BURST = '1';
      const gw = buildGateway();
      const ping = { type: 'ping', requestId: 'p' } as unknown as WSClientMessage;

      const first = (await gw.handleMessage(asSocket(makeSock('a', {}, '2001:db8:1:2::a')), ping)) as { type: string };
      expect(first.type).not.toBe('error');
      const sameSubnet = (await gw.handleMessage(asSocket(makeSock('b', {}, '2001:db8:1:2::b')), ping)) as {
        code?: string;
      };
      expect(sameSubnet.code).toBe('RATE_LIMITED');
      const frameViolation = warnCalls().find(([action]) => action === AuditAction.RATE_LIMIT_EXCEEDED);
      expect(frameViolation && ipOf(frameViolation)).toBe('2001:db8:1:2::b');

      const otherSubnet = (await gw.handleMessage(asSocket(makeSock('c', {}, '2001:db8:1:3::a')), ping)) as {
        type: string;
      };
      expect(otherSubnet.type).not.toBe('error');
    });
  });

  // A reply that carried client JSON back made the transport serialize whatever the client nested in it,
  // so every path that answers a frame is held to the same rule: a string of at most 128 characters, or none.
  describe('request id in replies', () => {
    const HOSTILE = ['x'.repeat(129), { a: { b: 1 } }, ['r'], 7, true, null];
    const idOf = (reply: unknown): unknown => (reply as { requestId?: unknown }).requestId;

    it('echoes a request id only when it is a short string, never structure the client built', async () => {
      process.env.WS_RATE_LIMIT_FRAME_PER_SECOND = '1000';
      process.env.WS_RATE_LIMIT_FRAME_BURST = '1000';
      const gw = buildGateway();
      const send = async (message: unknown) =>
        (await gw.handleMessage(asSocket(makeSock('a', {}, '203.0.113.9')), message as WSClientMessage)) as {
          requestId?: unknown;
          code?: string;
        };

      expect((await send({ type: 'ping', requestId: 'r1' })).requestId).toBe('r1');
      expect((await send({ type: 'ping', requestId: 'x'.repeat(128) })).requestId).toBe('x'.repeat(128));
      for (const hostile of HOSTILE) {
        expect((await send({ type: 'ping', requestId: hostile })).requestId).toBeUndefined();
        const refused = await send({ type: 'no-such-type', requestId: hostile });
        expect(refused.code).toBe('INVALID_MESSAGE');
        expect(refused.requestId).toBeUndefined();
      }
    });

    it('drops it from the RATE_LIMITED reply too, the one an abusive client is sent', async () => {
      process.env.WS_RATE_LIMIT_FRAME_PER_SECOND = '1';
      process.env.WS_RATE_LIMIT_FRAME_BURST = '1';
      jest.useFakeTimers();
      const gw = buildGateway();
      const sock = makeSock('a', {}, '203.0.113.9');
      await gw.handleMessage(asSocket(sock), { type: 'ping' }); // spends the one token

      for (const hostile of HOSTILE) {
        const reply = await gw.handleMessage(asSocket(sock), { type: 'ping', requestId: hostile } as never);
        expect(reply).toMatchObject({ type: 'error', code: 'RATE_LIMITED' });
        expect(idOf(reply)).toBeUndefined();
      }
      const short = await gw.handleMessage(asSocket(sock), { type: 'ping', requestId: 'r1' } as never);
      expect(short).toMatchObject({ code: 'RATE_LIMITED', requestId: 'r1' });
      // The frame the socket was pushed is the one a client reads: none of the hostile ids is in it.
      const pushed = sock.emit.mock.calls.map(([, frame]) => idOf(frame));
      expect(pushed.filter(id => id !== undefined)).toEqual(['r1']);
    });

    it('drops it from subscribe and unsubscribe replies, granted or refused', async () => {
      process.env.WS_RATE_LIMIT_FRAME_PER_SECOND = '1000';
      process.env.WS_RATE_LIMIT_FRAME_BURST = '1000';
      authService.validateApiKey.mockResolvedValue({ id: 'k1', name: 'k', allowedSessions: null });
      const gw = buildGateway();
      const sock = makeSock('s1', { apiKey: 'good' });
      await gw.handleConnection(asSocket(sock));
      const send = (message: Record<string, unknown>) =>
        gw.handleMessage(asSocket(sock), message as unknown as WSClientMessage);

      const commands: Array<[string, Record<string, unknown>, string]> = [
        ['subscribed', { type: 'subscribe', sessionId: 'sess-1', events: ['message.received'] }, 'subscribed'],
        ['refused subscribe', { type: 'subscribe', sessionId: 'sess:1', events: ['*'] }, 'error'],
        ['unsubscribed', { type: 'unsubscribe', sessionId: 'sess-1' }, 'unsubscribed'],
        ['refused unsubscribe', { type: 'unsubscribe', sessionId: 'sess:1' }, 'error'],
      ];
      for (const [label, command, type] of commands) {
        const kept = await send({ ...command, requestId: 'r1' });
        expect([label, kept]).toEqual([label, expect.objectContaining({ type, requestId: 'r1' })]);
        for (const hostile of HOSTILE) {
          const reply = await send({ ...command, requestId: hostile });
          expect([label, reply]).toEqual([label, expect.objectContaining({ type })]);
          expect([label, idOf(reply)]).toEqual([label, undefined]);
        }
      }
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

    it('does not spend a cap slot on a handshake whose transport closed while it was validating', async () => {
      // Nest runs the disconnect handler as soon as the transport closes, which can be before
      // handleConnection returns. That untrack ran before the key was on client.data and found
      // nothing, so the socket tracked a moment later stayed in the per-key set forever.
      process.env.WS_MAX_SOCKETS_PER_KEY = '1';
      process.env.WS_RATE_LIMIT_HANDSHAKE_MAX = '100';
      authService.validateApiKey.mockResolvedValue({ id: 'k1', name: 'k', allowedSessions: null });
      const gw = buildGateway();

      const aborted = makeSock('aborted', { apiKey: 'good' });
      const connecting = gw.handleConnection(asSocket(aborted));
      aborted.disconnected = true; // the client went away mid-validation
      gw.handleDisconnect(asSocket(aborted)); // Nest dispatches it before the connect resolves
      await connecting;

      // The one slot the key has must still be free.
      const next = makeSock('next', { apiKey: 'good' });
      await gw.handleConnection(asSocket(next));
      expect(next.disconnect).not.toHaveBeenCalled();
    });
  });

  describe('browser session cookie auth and CSWSH defense', () => {
    let browserSessionService: { validateSessionToken: jest.Mock; validateSessionById: jest.Mock };
    const savedEnv = { cors: process.env.CORS_ORIGINS, nodeEnv: process.env.NODE_ENV };

    const makeCookieSock = (
      id: string,
      headers: Record<string, string>,
      opts: { secure?: boolean; address?: string } = {},
    ): MockSocket => {
      const s: MockSocket = {
        id,
        handshake: {
          headers,
          query: {},
          auth: {},
          address: opts.address ?? '203.0.113.5',
          ...(opts.secure !== undefined ? { secure: opts.secure } : {}),
        },
        data: {},
        emit: jest.fn(),
        disconnect: jest.fn(() => {
          s.disconnected = true;
        }),
        join: jest.fn(),
        leave: jest.fn(),
        rooms: new Set<string>([id]),
      };
      return s;
    };

    const buildCookieGateway = () => {
      const Ctor = EventsGateway as unknown as new (...args: unknown[]) => EventsGateway;
      return new Ctor(authService, auditService, asConfig(), undefined, browserSessionService);
    };

    beforeEach(() => {
      browserSessionService = {
        validateSessionToken: jest.fn(),
        validateSessionById: jest.fn(),
      };
    });

    afterEach(() => {
      if (savedEnv.cors === undefined) delete process.env.CORS_ORIGINS;
      else process.env.CORS_ORIGINS = savedEnv.cors;
      if (savedEnv.nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = savedEnv.nodeEnv;
    });

    it('rejects cookie-authenticated WS handshakes missing Origin or from an untrusted Origin (CSWSH defense)', async () => {
      process.env.NODE_ENV = 'development';
      delete process.env.CORS_ORIGINS;
      const gw = buildCookieGateway();

      const missingOrigin = makeCookieSock('ws-no-origin', {
        cookie: 'openwa_session=tok-1',
        host: 'wa.example.com',
      });
      await gw.handleConnection(asSocket(missingOrigin));
      expect(missingOrigin.disconnect).toHaveBeenCalledWith(true);
      expect(browserSessionService.validateSessionToken).not.toHaveBeenCalled();

      const evilOrigin = makeCookieSock('ws-evil-origin', {
        cookie: 'openwa_session=tok-1',
        host: 'wa.example.com',
        origin: 'https://evil.example',
      });
      await gw.handleConnection(asSocket(evilOrigin));
      expect(evilOrigin.disconnect).toHaveBeenCalledWith(true);
      expect(browserSessionService.validateSessionToken).not.toHaveBeenCalled();

      // Scheme downgrade: http:// origin on a secure (wss/https) handshake must be refused.
      const downgradeOrigin = makeCookieSock(
        'ws-downgrade-origin',
        {
          cookie: 'openwa_session=tok-1',
          host: 'wa.example.com',
          origin: 'http://wa.example.com',
        },
        { secure: true },
      );
      await gw.handleConnection(asSocket(downgradeOrigin));
      expect(downgradeOrigin.disconnect).toHaveBeenCalledWith(true);
      expect(browserSessionService.validateSessionToken).not.toHaveBeenCalled();

      // Sec-Fetch-Site: cross-site or same-site without explicit CORS_ORIGINS is refused even if Origin matches Host.
      for (const site of ['cross-site', 'same-site']) {
        const crossSite = makeCookieSock(
          `ws-${site}`,
          {
            cookie: 'openwa_session=tok-1',
            host: 'wa.example.com',
            origin: 'https://wa.example.com',
            'sec-fetch-site': site,
          },
          { secure: true },
        );
        await gw.handleConnection(asSocket(crossSite));
        expect(crossSite.disconnect).toHaveBeenCalledWith(true);
      }

      // Origin-less polling handshake with Sec-Fetch-Site: same-origin but foreign/downgraded Referer is refused.
      const foreignReferer = makeCookieSock('ws-foreign-referer', {
        cookie: 'openwa_session=tok-1',
        host: 'wa.example.com',
        'sec-fetch-site': 'same-origin',
        referer: 'https://evil.example/sessions',
      });
      await gw.handleConnection(asSocket(foreignReferer));
      expect(foreignReferer.disconnect).toHaveBeenCalledWith(true);

      const downgradedReferer = makeCookieSock(
        'ws-downgraded-referer',
        {
          cookie: 'openwa_session=tok-1',
          host: 'wa.example.com',
          referer: 'http://wa.example.com/sessions',
        },
        { secure: true },
      );
      await gw.handleConnection(asSocket(downgradedReferer));
      expect(downgradedReferer.disconnect).toHaveBeenCalledWith(true);
      expect(browserSessionService.validateSessionToken).not.toHaveBeenCalled();
    });

    it('accepts Origin-less same-origin Socket.IO polling cookie handshakes verified by Sec-Fetch-Site or Referer', async () => {
      const key = {
        id: 'k-cookie-poll',
        name: 'Cookie Poll Key',
        role: 'admin',
        isActive: true,
        allowedSessions: null,
        allowedChats: null,
        allowedIps: null,
        expiresAt: null,
      };
      browserSessionService.validateSessionToken.mockResolvedValue({
        session: { id: 'bs-poll', apiKeyId: 'k-cookie-poll' },
        apiKey: key,
      });

      const gw = buildCookieGateway();

      // Modern browser HTTP long-polling GET omits Origin and sends Sec-Fetch-Site: same-origin + Referer.
      const pollingWithReferer = makeCookieSock('ws-poll-sfs-ref', {
        cookie: 'openwa_session=tok-poll',
        host: '127.0.0.1:2785',
        'sec-fetch-site': 'same-origin',
        referer: 'http://127.0.0.1:2785/sessions',
      });
      await gw.handleConnection(asSocket(pollingWithReferer));
      expect(pollingWithReferer.disconnect).not.toHaveBeenCalled();
      expect(pollingWithReferer.data.browserSessionId).toBe('bs-poll');

      // Modern browser with Referrer-Policy: no-referrer omits both Origin and Referer, sending Sec-Fetch-Site: same-origin.
      const pollingNoReferer = makeCookieSock('ws-poll-sfs-only', {
        cookie: 'openwa_session=tok-poll',
        host: '127.0.0.1:2785',
        'sec-fetch-site': 'same-origin',
      });
      await gw.handleConnection(asSocket(pollingNoReferer));
      expect(pollingNoReferer.disconnect).not.toHaveBeenCalled();

      // Older browser without Fetch Metadata omits Origin and Sec-Fetch-Site, sending same-origin Referer.
      const legacyPolling = makeCookieSock('ws-poll-legacy-ref', {
        cookie: 'openwa_session=tok-poll',
        host: 'wa.example.com',
        referer: 'https://wa.example.com/sessions',
      });
      await gw.handleConnection(asSocket(legacyPolling));
      expect(legacyPolling.disconnect).not.toHaveBeenCalled();
    });

    it('authenticates same-origin cookie WS without storing raw keys, re-validates via validateSessionById, and supports evictBrowserSession', async () => {
      const key = {
        id: 'k-cookie',
        name: 'Cookie Key',
        role: 'admin',
        isActive: true,
        allowedSessions: null,
        allowedChats: null,
        allowedIps: null,
        expiresAt: null,
      };
      browserSessionService.validateSessionToken.mockResolvedValue({
        session: { id: 'bs-42', apiKeyId: 'k-cookie' },
        apiKey: key,
      });
      browserSessionService.validateSessionById.mockResolvedValue({
        session: { id: 'bs-42', apiKeyId: 'k-cookie' },
        apiKey: key,
      });

      const gw = buildCookieGateway();
      const sock = makeCookieSock(
        'ws-ok',
        {
          cookie: 'openwa_session=tok-1',
          host: 'wa.example.com:443',
          origin: 'https://wa.example.com',
        },
        { secure: true },
      );

      await gw.handleConnection(asSocket(sock));
      expect(sock.disconnect).not.toHaveBeenCalled();
      expect(sock.data.browserSessionId).toBe('bs-42');
      expect(sock.data.apiKeyId).toBe('k-cookie');
      expect(sock.data.rawApiKey).toBeUndefined();

      const subRes = await gw.handleMessage(asSocket(sock), {
        type: 'subscribe',
        sessionId: 's1',
        events: ['session.status'],
        requestId: 'r1',
      } as unknown as WSClientMessage);
      expect(subRes).toEqual(expect.objectContaining({ type: 'subscribed', sessionId: 's1' }));
      expect(browserSessionService.validateSessionById).toHaveBeenCalledWith('bs-42', '203.0.113.5');

      // Evicting the browser session disconnects the bound socket immediately.
      (gw as unknown as { evictBrowserSession: (id: string) => void }).evictBrowserSession('bs-42');
      expect(sock.disconnect).toHaveBeenCalledWith(true);

      // Behind a trusted reverse proxy rewriting Host -> upstream and forwarding X-Forwarded-Host + X-Forwarded-Proto:
      const savedProxies = process.env.TRUSTED_PROXIES;
      delete process.env.TRUSTED_PROXIES;
      try {
        // Standard TLS-terminating reverse proxy over plain HTTP without TRUSTED_PROXIES configured:
        const plainHttpBehindTlsProxy = makeCookieSock(
          'ws-tls-proxy-default',
          {
            cookie: 'openwa_session=tok-1',
            host: 'wa.example.com',
            origin: 'https://wa.example.com',
          },
          { secure: false, address: '172.18.0.2' },
        );
        await gw.handleConnection(asSocket(plainHttpBehindTlsProxy));
        expect(plainHttpBehindTlsProxy.disconnect).not.toHaveBeenCalled();

        process.env.TRUSTED_PROXIES = '10.0.0.1';
        const proxiedSock = makeCookieSock(
          'ws-proxied',
          {
            cookie: 'openwa_session=tok-1',
            host: 'openwa-backend:2785',
            'x-forwarded-host': 'public.example.com:443',
            'x-forwarded-proto': 'http, https',
            origin: 'https://public.example.com',
          },
          { secure: false, address: '10.0.0.1' },
        );
        await gw.handleConnection(asSocket(proxiedSock));
        expect(proxiedSock.disconnect).not.toHaveBeenCalled();

        // Trusted proxy announcing HTTPS still refuses plain http:// downgrade Origin.
        const proxiedDowngradeSock = makeCookieSock(
          'ws-proxied-downgrade',
          {
            cookie: 'openwa_session=tok-1',
            host: 'wa.example.com',
            'x-forwarded-proto': 'https',
            origin: 'http://wa.example.com',
          },
          { secure: false, address: '10.0.0.1' },
        );
        await gw.handleConnection(asSocket(proxiedDowngradeSock));
        expect(proxiedDowngradeSock.disconnect).toHaveBeenCalledWith(true);
      } finally {
        if (savedProxies === undefined) delete process.env.TRUSTED_PROXIES;
        else process.env.TRUSTED_PROXIES = savedProxies;
      }
    });

    it('disconnects cookie-authenticated sockets during sweep when validateSessionById rejects', async () => {
      const key = {
        id: 'k-cookie',
        name: 'Cookie Key',
        role: 'admin',
        isActive: true,
        allowedSessions: null,
        allowedChats: null,
        allowedIps: null,
        expiresAt: null,
      };
      (authService as unknown as { findAuthorizationStates: jest.Mock }).findAuthorizationStates = jest
        .fn()
        .mockResolvedValue([key]);
      browserSessionService.validateSessionToken.mockResolvedValue({
        session: { id: 'bs-99', apiKeyId: 'k-cookie' },
        apiKey: key,
      });
      browserSessionService.validateSessionById.mockRejectedValue(
        new UnauthorizedException('Session has been revoked'),
      );

      const gw = buildCookieGateway();
      const sock = makeCookieSock(
        'ws-sweep',
        {
          cookie: 'openwa_session=tok-99',
          host: 'wa.example.com',
          origin: 'https://wa.example.com',
        },
        { secure: true },
      );
      await gw.handleConnection(asSocket(sock));
      expect(sock.disconnect).not.toHaveBeenCalled();

      await (gw as unknown as { sweepApiKeyAuthorization: () => Promise<void> }).sweepApiKeyAuthorization();
      expect(browserSessionService.validateSessionById).toHaveBeenCalledWith('bs-99', '203.0.113.5', undefined, {
        recordUsage: false,
      });
      expect(sock.disconnect).toHaveBeenCalledWith(true);
    });

    it('stores browserSessionExpiresAt on client.data, enforces offline expiry even if findAuthorizationStates throws, and batch-queries browser_sessions via In(sessionIds)', async () => {
      const ds = new DataSource({
        type: 'better-sqlite3',
        database: ':memory:',
        entities: [BrowserSession],
        synchronize: true,
      });
      await ds.initialize();
      try {
        const bsRepo = ds.getRepository(BrowserSession);
        const now = Date.now();
        await bsRepo.save([
          {
            id: 'bs-active',
            tokenHash: 'h1',
            apiKeyId: 'k-cookie',
            createdAt: new Date(now - 60_000),
            expiresAt: new Date(now + 600_000),
            revokedAt: null,
          },
          {
            id: 'bs-revoked',
            tokenHash: 'h2',
            apiKeyId: 'k-cookie',
            createdAt: new Date(now - 60_000),
            expiresAt: new Date(now + 600_000),
            revokedAt: new Date(now - 1_000),
          },
          {
            id: 'bs-offline-exp',
            tokenHash: 'h3',
            apiKeyId: 'k-cookie',
            createdAt: new Date(now - 60_000),
            expiresAt: new Date(now + 10_000),
            revokedAt: null,
          },
        ]);

        const key = {
          id: 'k-cookie',
          name: 'Cookie Key',
          role: 'admin',
          isActive: true,
          allowedSessions: null,
          allowedChats: null,
          allowedIps: null,
          expiresAt: null,
        };
        const findAuthSpy = jest.fn().mockRejectedValue(new Error('sqlite busy'));
        (authService as unknown as { findAuthorizationStates: jest.Mock }).findAuthorizationStates = findAuthSpy;
        browserSessionService.validateSessionToken
          .mockResolvedValueOnce({
            session: { id: 'bs-active', apiKeyId: 'k-cookie', expiresAt: new Date(now + 600_000) },
            apiKey: key,
          })
          .mockResolvedValueOnce({
            session: { id: 'bs-revoked', apiKeyId: 'k-cookie', expiresAt: new Date(now + 600_000) },
            apiKey: key,
          })
          .mockResolvedValueOnce({
            session: { id: 'bs-offline-exp', apiKeyId: 'k-cookie', expiresAt: new Date(now + 10_000) },
            apiKey: key,
          });

        const Ctor = EventsGateway as unknown as new (...args: unknown[]) => EventsGateway;
        const gw = new Ctor(
          authService,
          auditService,
          asConfig(),
          new ChatScopeService(),
          browserSessionService,
          undefined,
          undefined,
          ds,
        );

        const sActive = makeCookieSock(
          's-active',
          {
            cookie: 'openwa_session=t1',
            host: 'wa.example.com',
            origin: 'https://wa.example.com',
          },
          { secure: true },
        );
        const sRevoked = makeCookieSock(
          's-revoked',
          {
            cookie: 'openwa_session=t2',
            host: 'wa.example.com',
            origin: 'https://wa.example.com',
          },
          { secure: true },
        );
        const sExpired = makeCookieSock(
          's-exp',
          {
            cookie: 'openwa_session=t3',
            host: 'wa.example.com',
            origin: 'https://wa.example.com',
          },
          { secure: true },
        );

        await gw.handleConnection(asSocket(sActive));
        await gw.handleConnection(asSocket(sRevoked));
        await gw.handleConnection(asSocket(sExpired));
        expect(sExpired.data.browserSessionExpiresAt).toEqual(new Date(now + 10_000));

        const findSpy = jest.spyOn(bsRepo, 'find');
        const findBySpy = jest.spyOn(bsRepo, 'findBy');
        await (gw as unknown as { sweepApiKeyAuthorization: (ts?: number) => Promise<void> }).sweepApiKeyAuthorization(
          now + 20_000,
        );

        // Must enforce offline expiry + batch query even though findAuthorizationStates threw!
        expect(sExpired.disconnect).toHaveBeenCalledWith(true);
        expect(sRevoked.disconnect).toHaveBeenCalledWith(true);
        expect(sActive.disconnect).not.toHaveBeenCalled();
        expect(browserSessionService.validateSessionById).not.toHaveBeenCalled();
        expect(findSpy.mock.calls.length + findBySpy.mock.calls.length).toBe(1);
      } finally {
        await ds.destroy();
      }
    });

    it('throttles audit rows for unauthenticated WS handshake failures via allowUnauthenticatedAuditRow', async () => {
      const savedMax = process.env.WS_RATE_LIMIT_HANDSHAKE_MAX;
      process.env.WS_RATE_LIMIT_HANDSHAKE_MAX = '100';
      const gw = buildCookieGateway();
      const isolatedIp = '198.51.100.77';
      try {
        for (let i = 0; i < 15; i++) {
          const sock = makeCookieSock(`ws-anon-${i}`, { host: 'wa.example.com' }, { address: isolatedIp });
          await gw.handleConnection(asSocket(sock));
          expect(sock.disconnect).toHaveBeenCalledWith(true);
        }
        // allowUnauthenticatedAuditRow allows up to 10 rows per IP per minute; the rest are dropped.
        const authFailedRows = auditService.logWarn.mock.calls.filter(
          ([action]) => action === AuditAction.API_KEY_AUTH_FAILED,
        );
        expect(authFailedRows.length).toBeLessThanOrEqual(10);
      } finally {
        if (savedMax === undefined) delete process.env.WS_RATE_LIMIT_HANDSHAKE_MAX;
        else process.env.WS_RATE_LIMIT_HANDSHAKE_MAX = savedMax;
      }
    });

    it('bounds chatDeliveries queue depth per chat with a rate-limited warning when identity lookup stalls', async () => {
      const savedRedis = process.env.REDIS_ENABLED;
      process.env.REDIS_ENABLED = 'true';
      const warnSpy = jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
      try {
        let releaseLookup!: () => void;
        const slowScope = new ChatScopeService({
          phonesForLidsPersisted: jest.fn().mockResolvedValue({}),
          lidsForPhonesPersisted: jest.fn(
            () =>
              new Promise<Record<string, string[]>>(res => {
                releaseLookup = () => res({ '628111000111': ['111'] });
              }),
          ),
        } as never);
        const Ctor = EventsGateway as unknown as new (...args: unknown[]) => EventsGateway;
        const gw = new Ctor(authService, auditService, asConfig(), slowScope);
        const { server, emit } = makeCapturingServer();
        (gw as unknown as { server: unknown }).server = server;
        // Mark local restricted socket so emitToRooms enqueues into chatDeliveries.
        const restrictedSock = makeCookieSock('ws-r', {});
        restrictedSock.data.apiKey = {
          id: 'k-r',
          name: 'r',
          role: 'viewer',
          allowedSessions: null,
          allowedChats: ['628111000111@c.us'],
        };
        (gw as unknown as { socketsByKeyId: Map<string, Set<Socket>> }).socketsByKeyId.set(
          'k-r',
          new Set([asSocket(restrictedSock)]),
        );

        for (let i = 0; i < 150; i++) {
          gw.emitMessage('sess-stall', { chatId: '628111000111@c.us', id: `m-${i}` });
        }

        const queues = (gw as unknown as { chatDeliveries: Map<string, unknown[]> }).chatDeliveries;
        const queueDepth =
          queues.size > 0 ? Math.max(...[...queues.values()].map(q => (Array.isArray(q) ? q.length : 1))) : 0;
        expect(queueDepth).toBeLessThanOrEqual(64);
        expect(warnSpy).toHaveBeenCalled();

        releaseLookup?.();
        await new Promise(resolve => setImmediate(resolve));
        expect(emit).toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
        if (savedRedis === undefined) delete process.env.REDIS_ENABLED;
        else process.env.REDIS_ENABLED = savedRedis;
      }
    });

    it('reports per-session depth cap accurately when session queue limit triggers across chats', async () => {
      const savedRedis = process.env.REDIS_ENABLED;
      process.env.REDIS_ENABLED = 'true';
      const warnSpy = jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
      try {
        let releaseLookup!: () => void;
        const slowScope = new ChatScopeService({
          phonesForLidsPersisted: jest.fn().mockResolvedValue({}),
          lidsForPhonesPersisted: jest.fn(
            () =>
              new Promise<Record<string, string[]>>(res => {
                releaseLookup = () => res({ '628111000111': ['111'] });
              }),
          ),
        } as never);
        const Ctor = EventsGateway as unknown as new (...args: unknown[]) => EventsGateway;
        const gw = new Ctor(authService, auditService, asConfig(), slowScope);
        const { server } = makeCapturingServer();
        (gw as unknown as { server: unknown }).server = server;
        const restrictedSock = makeCookieSock('ws-r', {});
        restrictedSock.data.apiKey = {
          id: 'k-r',
          name: 'r',
          role: 'viewer',
          allowedSessions: null,
          allowedChats: ['628111000111@c.us'],
        };
        (gw as unknown as { socketsByKeyId: Map<string, Set<Socket>> }).socketsByKeyId.set(
          'k-r',
          new Set([asSocket(restrictedSock)]),
        );

        // Emit 1026 unique chats: item 0 is shifted immediately by the active drain,
        // leaving 1024 queued items when item 1025 arrives and triggers the session cap.
        for (let i = 0; i < 1026; i++) {
          gw.emitMessage('sess-cap', { chatId: `628111${String(i).padStart(6, '0')}@c.us`, id: `m-${i}` });
        }

        expect(warnSpy).toHaveBeenCalledWith(
          'Dropped oldest queued WebSocket chat delivery at per-session depth cap',
          expect.objectContaining({
            scope: 'session',
            maxQueued: 1024,
          }),
        );

        await gw.onModuleDestroy();
        releaseLookup?.();
        await new Promise(resolve => setImmediate(resolve));
      } finally {
        warnSpy.mockRestore();
        if (savedRedis === undefined) delete process.env.REDIS_ENABLED;
        else process.env.REDIS_ENABLED = savedRedis;
      }
    });

    it('guards against late emits and prevents drainChatDeliveries restart after onModuleDestroy()', async () => {
      const savedRedis = process.env.REDIS_ENABLED;
      process.env.REDIS_ENABLED = 'true';
      try {
        let releaseLookup!: () => void;
        const lidsForPhonesPersisted = jest.fn(
          () =>
            new Promise<Record<string, string[]>>(res => {
              releaseLookup = () => res({ '628111000111': ['111'] });
            }),
        );
        const slowScope = new ChatScopeService({
          phonesForLidsPersisted: jest.fn().mockResolvedValue({}),
          lidsForPhonesPersisted,
        } as never);
        const Ctor = EventsGateway as unknown as new (...args: unknown[]) => EventsGateway;
        const gw = new Ctor(authService, auditService, asConfig(), slowScope);
        const { server, emit } = makeCapturingServer();
        (gw as unknown as { server: unknown }).server = server;
        const restrictedSock = makeCookieSock('ws-r', {});
        restrictedSock.data.apiKey = {
          id: 'k-r',
          name: 'r',
          role: 'viewer',
          allowedSessions: null,
          allowedChats: ['628111000111@c.us'],
        };
        (gw as unknown as { socketsByKeyId: Map<string, Set<Socket>> }).socketsByKeyId.set(
          'k-r',
          new Set([asSocket(restrictedSock)]),
        );

        gw.emitMessage('sess-destroy', { chatId: '628111000111@c.us', id: 'm-inflight' });
        emit.mockClear();
        await gw.onModuleDestroy();

        // Simulate queued leftovers appearing concurrently before in-flight lookup resolves.
        const deliveries = (gw as unknown as { chatDeliveries: Map<string, unknown[]> }).chatDeliveries;
        deliveries.set('sess-destroy', [
          { chatId: 'x', sessionId: 'sess-destroy', event: 'message', eventMessage: {} },
        ]);

        releaseLookup?.();
        await new Promise(resolve => setImmediate(resolve));

        // Post-destroy emits must be ignored and in-flight drains must not emit or restart.
        gw.emitMessage('sess-destroy', { chatId: '628111000111@c.us', id: 'm-after' });
        expect(lidsForPhonesPersisted).toHaveBeenCalledTimes(1);
        expect(emit).not.toHaveBeenCalled();
        expect(deliveries.size).toBe(0);
        expect((gw as unknown as { chatDeliveryActive: Set<string> }).chatDeliveryActive.size).toBe(0);
      } finally {
        if (savedRedis === undefined) delete process.env.REDIS_ENABLED;
        else process.env.REDIS_ENABLED = savedRedis;
      }
    });
  });
});
