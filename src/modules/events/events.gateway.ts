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
import { resolveCorsPolicy } from '../../config/bootstrap-security';

/**
 * WebSocket CORS origin: reuse the HTTP CORS policy instead of a hardcoded '*'.
 * Dev → allow any origin; production → the configured CORS_ORIGINS allowlist (or none).
 * Read from process.env at module load (real env vars apply; same-origin is unaffected).
 */
function resolveWsCorsOrigin(): boolean | string[] {
  const policy = resolveCorsPolicy(process.env.CORS_ORIGINS, process.env.NODE_ENV);
  return policy.allowAnyOrigin ? true : policy.origins;
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

  constructor(private readonly authService: AuthService) {}

  afterInit() {
    this.logger.log('WebSocket Gateway initialized');
  }

  async handleConnection(client: Socket) {
    // Prefer Socket.IO's `auth` field (not logged in URLs), then the header; the query
    // param is a deprecated transition fallback (the key leaks into access logs).
    const handshakeAuth = client.handshake.auth as { apiKey?: string } | undefined;
    const apiKey =
      handshakeAuth?.apiKey ||
      (client.handshake.headers['x-api-key'] as string) ||
      (client.handshake.query.apiKey as string);

    if (!apiKey) {
      this.logger.warn(`Client ${client.id} rejected: No API key provided`);
      client.emit('message', this.createError('UNAUTHORIZED', 'API key required'));
      client.disconnect();
      return;
    }

    try {
      // validateApiKey THROWS on any failure (it never resolves to a falsy value), so the rejection
      // path is the catch below — a separate `if (!validKey)` branch here was dead code.
      const validKey = await this.authService.validateApiKey(apiKey);

      // Store the validated key AND the raw key — the raw key lets handleSubscribe
      // RE-validate on each subscription so a key revoked mid-connection is caught.
      (client.data as { apiKey: unknown; rawApiKey: string }).apiKey = validKey;
      (client.data as { rawApiKey: string }).rawApiKey = apiKey;
      this.logger.log(`Client connected: ${client.id} (key: ${validKey.name})`);
    } catch (error) {
      this.logger.warn(`Client ${client.id} rejected: Auth error`, {
        error: error instanceof Error ? error.message : String(error),
      });
      client.emit('message', this.createError('UNAUTHORIZED', 'Authentication failed'));
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
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
    const rawApiKey = (client.data as { rawApiKey?: string }).rawApiKey;
    let subscriberKey: { allowedSessions?: string[] | null } | null;
    try {
      subscriberKey = rawApiKey ? await this.authService.validateApiKey(rawApiKey) : null;
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
   * Emit a live delivery-status update (neutral DeliveryStatus, e.g. delivered/read/failed).
   */
  emitMessageAck(sessionId: string, data: { messageId: string; status: DeliveryStatus }) {
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

  /**
   * Emit webhook delivery status (broadcast to all - no session context)
   */
  emitWebhookStatus(webhookId: string, success: boolean, error?: string) {
    // This one broadcasts to all since webhooks don't have session context in the same way
    this.server.emit('webhook:delivery', {
      webhookId,
      success,
      error,
      timestamp: new Date().toISOString(),
    });
  }
}
