import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { resolveCorsPolicy } from '../../config/bootstrap-security';
import { resolveClientIp as resolveRequestClientIp, type RequestLike } from '../../common/utils/ip';
import type { ApiKey } from '../auth/entities/api-key.entity';

/**
 * WebSocket CORS origin: reuse the HTTP CORS policy instead of a hardcoded '*'.
 * Dev → allow any origin; production → the configured CORS_ORIGINS allowlist (or none).
 * Read from process.env at module load (real env vars apply; same-origin is unaffected).
 */
function resolveWsCorsOrigin(): boolean | string[] {
  const policy = resolveCorsPolicy(process.env.CORS_ORIGINS, process.env.NODE_ENV);
  return policy.allowAnyOrigin ? true : policy.origins;
}

/**
 * Read TRUSTED_PROXIES once as a list — mirrors mcp.server.ts so the WS surface resolves the
 * client IP with the same trusted-proxy-aware logic as the REST guard and the MCP mount.
 */
function readTrustedProxies(): string[] {
  return (process.env.TRUSTED_PROXIES ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}
import type {
  WSClientMessage,
  WSSubscribeRequest,
  WSUnsubscribeRequest,
  WSSubscribedResponse,
  WSUnsubscribedResponse,
  WSEventMessage,
  WSErrorResponse,
  WSPongResponse,
} from './dto/ws-messages.dto';
import { SUBSCRIBABLE_EVENTS, buildRoomName } from './dto/ws-messages.dto';
import type { DeliveryStatus } from '../../engine/interfaces/whatsapp-engine.interface';

/**
 * Whether an API key may subscribe to a session's WebSocket event rooms.
 * An unrestricted key (no `allowedSessions`) may subscribe to anything, including
 * the `*` wildcard. A key scoped to specific sessions may NOT subscribe to `*`
 * (which would receive every session's events) nor to a session outside its
 * allowlist — preventing cross-tenant event leakage (#221).
 */
export function isSessionSubscriptionAllowed(allowedSessions: string[] | null | undefined, sessionId: string): boolean {
  if (!allowedSessions || allowedSessions.length === 0) {
    return true;
  }
  if (sessionId === '*') {
    return false;
  }
  return allowedSessions.includes(sessionId);
}

/** Why an API key's live WebSocket sockets are being torn down — drives the client-facing message. */
export type ApiKeyEvictionReason = 'revoked' | 'deleted' | 'authorization_changed';

const EVICTION_MESSAGES: Record<ApiKeyEvictionReason, string> = {
  revoked: 'API key has been revoked',
  deleted: 'API key has been deleted',
  authorization_changed: 'API key authorization changed; please reconnect',
};

@WebSocketGateway({
  cors: {
    origin: resolveWsCorsOrigin(),
  },
  namespace: '/events',
})
export class EventsGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private logger = new Logger('EventsGateway');

  /**
   * Active sockets keyed by their validating API-key id, so a key revoked/disabled
   * mid-connection can have its live subscriptions torn down immediately (otherwise
   * an already-subscribed socket keeps receiving events until it happens to disconnect).
   */
  private readonly socketsByKeyId = new Map<string, Set<Socket>>();

  constructor(
    private readonly authService: AuthService,
    private readonly auditService: AuditService,
  ) {}

  afterInit() {
    this.logger.log('WebSocket Gateway initialized');
  }

  /**
   * Resolve the trusted-proxy-aware client IP for a socket, reusing the same shared
   * `resolveClientIp` helper as the REST guard and MCP mount. X-Forwarded-For is only
   * honored when the immediate peer is a configured trusted proxy, preventing IP-spoofing
   * of the allowedIps allowlist over the WS surface.
   */
  private resolveClientIp(client: Socket): string {
    const handshake = client.handshake;
    const req: RequestLike = {
      ip: handshake.address,
      socket: { remoteAddress: handshake.address },
      headers: handshake.headers ?? {},
    };
    return resolveRequestClientIp(req, readTrustedProxies());
  }

  private trackSocket(keyId: string, client: Socket): void {
    let sockets = this.socketsByKeyId.get(keyId);
    if (!sockets) {
      sockets = new Set();
      this.socketsByKeyId.set(keyId, sockets);
    }
    sockets.add(client);
  }

  private untrackSocket(client: Socket): void {
    const keyId = (client.data as { apiKey?: Pick<ApiKey, 'id'> } | undefined)?.apiKey?.id;
    if (!keyId) return;
    const sockets = this.socketsByKeyId.get(keyId);
    if (!sockets) return;
    sockets.delete(client);
    if (sockets.size === 0) {
      this.socketsByKeyId.delete(keyId);
    }
  }

  /**
   * Tear down every active socket authenticated with `keyId`. Called by AuthService when a key is
   * revoked, deleted, or has its authorization (role/allowedSessions/allowedIps/expiry) narrowed, so
   * the key's already-subscribed sockets stop receiving events immediately instead of lingering until
   * they disconnect on their own. Each socket gets a clean close (an `UNAUTHORIZED` reason) reflecting
   * the actual trigger, rather than a silent drop.
   */
  evictApiKey(keyId: string, reason: ApiKeyEvictionReason = 'revoked'): void {
    const sockets = this.socketsByKeyId.get(keyId);
    if (!sockets || sockets.size === 0) return;
    this.logger.log(`Evicting ${sockets.size} WebSocket connection(s) (${reason}) for key ${keyId}`);
    this.socketsByKeyId.delete(keyId);
    const message = EVICTION_MESSAGES[reason];
    for (const client of sockets) {
      client.emit('message', this.createError('UNAUTHORIZED', message));
      client.disconnect(true);
    }
  }

  async handleConnection(client: Socket) {
    // Accept the key only via Socket.IO's `auth` field or the header — never the query string, which
    // leaks the credential into proxy/access logs. (The deprecated `?apiKey=` fallback was removed.)
    const handshakeAuth = client.handshake.auth as { apiKey?: string } | undefined;
    const apiKey = handshakeAuth?.apiKey || (client.handshake.headers['x-api-key'] as string);
    // Resolve the client IP once here so both the validation and the audit trail use the same
    // trusted-proxy-aware value (parity with the REST guard / MCP mount).
    const clientIp = this.resolveClientIp(client);

    if (!apiKey) {
      this.logger.warn(`Client ${client.id} rejected: No API key provided`);
      void this.auditService.logWarn(AuditAction.API_KEY_AUTH_FAILED, {
        ipAddress: clientIp,
        metadata: { surface: 'websocket' },
        errorMessage: 'missing API key',
      });
      client.emit('message', this.createError('UNAUTHORIZED', 'API key required'));
      client.disconnect();
      return;
    }

    try {
      // validateApiKey THROWS on any failure (it never resolves to a falsy value), so the rejection
      // path is the catch below — a separate `if (!validKey)` branch here was dead code. The clientIp
      // is passed so an IP-restricted key (allowedIps set) is ENFORCED rather than blanket-rejected
      // for "Client IP could not be determined".
      const validKey = await this.authService.validateApiKey(apiKey, clientIp);

      // Store the validated key AND the raw key — the raw key lets handleSubscribe
      // RE-validate on each subscription so a key revoked mid-connection is caught.
      (client.data as { apiKey: unknown; rawApiKey: string }).apiKey = validKey;
      (client.data as { rawApiKey: string }).rawApiKey = apiKey;
      this.trackSocket(validKey.id, client);
      this.logger.log(`Client connected: ${client.id} (key: ${validKey.name})`);
    } catch (error) {
      this.logger.warn(`Client ${client.id} rejected: Auth error`, {
        error: error instanceof Error ? error.message : String(error),
      });
      // Audit the rejected credential like the REST guard does, so probing over the WS surface leaves
      // a forensic trail too. Fire-and-forget: audit logging must never affect the rejection path.
      void this.auditService.logWarn(AuditAction.API_KEY_AUTH_FAILED, {
        ipAddress: clientIp,
        metadata: { surface: 'websocket' },
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      client.emit('message', this.createError('UNAUTHORIZED', 'Authentication failed'));
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    this.untrackSocket(client);
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('message')
  handleMessage(@ConnectedSocket() client: Socket, @MessageBody() message: WSClientMessage) {
    switch (message.type) {
      case 'subscribe':
        return this.handleSubscribe(client, message);
      case 'unsubscribe':
        return this.handleUnsubscribe(client, message);
      case 'ping':
        return this.handlePing(client, message.requestId);
      default:
        return this.createError(
          'INVALID_MESSAGE',
          `Unknown message type`,
          (message as { requestId?: string }).requestId,
        );
    }
  }

  private async handleSubscribe(
    client: Socket,
    message: WSSubscribeRequest,
  ): Promise<WSSubscribedResponse | WSErrorResponse> {
    const { sessionId, events, requestId } = message;

    // Validate sessionId
    if (!sessionId || typeof sessionId !== 'string') {
      return this.createError('INVALID_SESSION', 'sessionId is required', requestId);
    }

    // Re-validate the API key on every subscribe: a long-lived socket whose key was
    // revoked/expired after connect must not be able to keep opening new subscriptions.
    // The clientIp is re-resolved (trusted-proxy-aware) so an IP-restricted key is enforced
    // here too, not just at connect.
    const rawApiKey = (client.data as { rawApiKey?: string }).rawApiKey;
    const clientIp = this.resolveClientIp(client);
    let subscriberKey: { allowedSessions?: string[] | null } | null;
    try {
      subscriberKey = rawApiKey ? await this.authService.validateApiKey(rawApiKey, clientIp) : null;
    } catch {
      subscriberKey = null;
    }
    if (!subscriberKey) {
      client.emit('message', this.createError('UNAUTHORIZED', 'API key is no longer valid', requestId));
      client.disconnect();
      return this.createError('UNAUTHORIZED', 'API key is no longer valid', requestId);
    }

    // Enforce per-key session scope against the FRESH key: a key restricted to specific
    // sessions must not subscribe to '*' or a session outside its allowlist (#221).
    if (!isSessionSubscriptionAllowed(subscriberKey.allowedSessions, sessionId)) {
      return this.createError('FORBIDDEN_SESSION', 'API key is not authorized for this session', requestId);
    }

    // Validate events
    if (!events || !Array.isArray(events) || events.length === 0) {
      return this.createError('INVALID_EVENTS', 'events array is required', requestId);
    }

    // Validate each event type
    const validEvents = events.filter(
      e => e === '*' || SUBSCRIBABLE_EVENTS.includes(e as (typeof SUBSCRIBABLE_EVENTS)[number]),
    );
    if (validEvents.length === 0) {
      return this.createError(
        'INVALID_EVENTS',
        `No valid events. Valid: ${SUBSCRIBABLE_EVENTS.join(', ')}, *`,
        requestId,
      );
    }

    // Join rooms for each session/event combination
    const rooms: string[] = [];
    for (const event of validEvents) {
      const room = buildRoomName(sessionId, event);
      void client.join(room);
      rooms.push(room);
    }

    this.logger.debug(`Client ${client.id} subscribed to: ${rooms.join(', ')}`);

    return {
      type: 'subscribed',
      sessionId,
      events: validEvents,
      requestId,
      timestamp: new Date().toISOString(),
    };
  }

  private handleUnsubscribe(client: Socket, message: WSUnsubscribeRequest): WSUnsubscribedResponse {
    const { sessionId, requestId } = message;

    // Leave all rooms for this session
    const clientRooms = Array.from(client.rooms);
    const sessionPrefix = `session:${sessionId}:`;

    for (const room of clientRooms) {
      if (room.startsWith(sessionPrefix) || (sessionId === '*' && room.startsWith('session:'))) {
        void client.leave(room);
      }
    }

    this.logger.debug(`Client ${client.id} unsubscribed from session: ${sessionId}`);

    return {
      type: 'unsubscribed',
      sessionId,
      requestId,
      timestamp: new Date().toISOString(),
    };
  }

  private handlePing(_client: Socket, requestId?: string): WSPongResponse {
    return {
      type: 'pong',
      requestId,
      timestamp: new Date().toISOString(),
    };
  }

  private createError(code: string, message: string, requestId?: string): WSErrorResponse {
    return {
      type: 'error',
      code,
      message,
      requestId,
      timestamp: new Date().toISOString(),
    };
  }

  // ========== Event Emission Methods (room-based) ==========

  /**
   * Emit event to specific rooms based on sessionId and event type
   */
  private emitToRooms(sessionId: string, event: string, data: unknown): void {
    const eventMessage: WSEventMessage = {
      type: 'event',
      payload: { event, sessionId, data },
      timestamp: new Date().toISOString(),
    };

    // Emit once to the specific room + the three wildcard rooms. Chaining .to()
    // unions the rooms into a single broadcast, so a socket joined to several of
    // them receives the event exactly once (Socket.IO dedups recipients per
    // broadcast). Four separate .emit() calls would deliver one copy per room.
    this.server
      .to(buildRoomName(sessionId, event))
      .to(buildRoomName(sessionId, '*'))
      .to(buildRoomName('*', event))
      .to(buildRoomName('*', '*'))
      .emit('message', eventMessage);
  }

  /**
   * Emit session status change
   */
  emitSessionStatus(sessionId: string, status: string, data?: Record<string, unknown>) {
    this.emitToRooms(sessionId, 'session.status', { status, ...data });
  }

  /**
   * Emit session authenticated (engine reached READY). Mirrors the webhook payload.
   */
  emitSessionAuthenticated(sessionId: string, data: { phone: string; pushName: string }) {
    this.emitToRooms(sessionId, 'session.authenticated', data);
  }

  /**
   * Emit session disconnected. Carries the `reason` that the session.status flip drops.
   */
  emitSessionDisconnected(sessionId: string, data: { reason: string }) {
    this.emitToRooms(sessionId, 'session.disconnected', data);
  }

  /**
   * Emit QR code update for a session
   */
  emitQRCode(sessionId: string, qrCode: string) {
    this.emitToRooms(sessionId, 'session.qr', { qrCode });
  }

  /**
   * Emit new message notification
   */
  emitMessage(sessionId: string, message: Record<string, unknown>) {
    this.emitToRooms(sessionId, 'message.received', message);
  }

  /**
   * Emit message sent notification
   */
  emitMessageSent(sessionId: string, message: Record<string, unknown>) {
    this.emitToRooms(sessionId, 'message.sent', message);
  }

  /**
   * Emit a live delivery-status update. The payload mirrors the `message.ack` webhook exactly
   * (`id`, `messageId`, neutral `status`, and the deprecated legacy numeric `ack`) so a socket
   * client and a webhook consumer see the same shape.
   */
  emitMessageAck(sessionId: string, data: { id: string; messageId: string; status: DeliveryStatus; ack: number }) {
    this.emitToRooms(sessionId, 'message.ack', data);
  }

  /**
   * Emit message revoked ("deleted for everyone") notification
   */
  emitMessageRevoked(sessionId: string, message: Record<string, unknown>) {
    this.emitToRooms(sessionId, 'message.revoked', message);
  }

  /**
   * Emit message reaction notification
   */
  emitMessageReaction(sessionId: string, data: Record<string, unknown>) {
    this.emitToRooms(sessionId, 'message.reaction', data);
  }
}
