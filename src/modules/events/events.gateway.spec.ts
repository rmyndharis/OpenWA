import { Socket } from 'socket.io';
import { EventsGateway, isSessionSubscriptionAllowed } from './events.gateway';
import { AuthService } from '../auth/auth.service';
import type { WSClientMessage, WSErrorResponse, WSSubscribedResponse } from './dto/ws-messages.dto';

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
  handshake: { headers: Record<string, string>; query: Record<string, string>; auth: { apiKey?: string } };
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
    handshake: { headers: {}, query: {}, auth },
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
    authService = { validateApiKey: jest.fn() };
    gateway = new EventsGateway(authService as unknown as AuthService);
  });

  it('rejects a connection with no API key (and never calls validate)', async () => {
    const sock = makeSocket({});
    await gateway.handleConnection(asSocket(sock));
    expect(sock.disconnect).toHaveBeenCalled();
    expect(authService.validateApiKey).not.toHaveBeenCalled();
  });

  it('rejects a connection with an invalid API key', async () => {
    authService.validateApiKey.mockResolvedValue(null);
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
});
