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
import { OnEvent } from '@nestjs/event-emitter';
import { AuthService } from '../auth/auth.service';
import { SessionEvents } from '../session/session.events';
import type { SessionStatusEvent, SessionMessageEvent, SessionAckEvent } from '../session/session.events';
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

@WebSocketGateway({
  cors: {
    origin: '*', // In production, restrict this
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
    // Extract API key from header or query param
    const apiKey = (client.handshake.headers['x-api-key'] as string) || (client.handshake.query.apiKey as string);

    if (!apiKey) {
      this.logger.warn(`Client ${client.id} rejected: No API key provided`);
      client.emit('message', this.createError('UNAUTHORIZED', 'API key required'));
      client.disconnect();
      return;
    }

    try {
      const validKey = await this.authService.validateApiKey(apiKey);
      if (!validKey) {
        this.logger.warn(`Client ${client.id} rejected: Invalid API key`);
        client.emit('message', this.createError('UNAUTHORIZED', 'Invalid API key'));
        client.disconnect();
        return;
      }

      // Store API key info on socket for later use
      (client.data as { apiKey: unknown }).apiKey = validKey;
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

  private handleSubscribe(client: Socket, message: WSSubscribeRequest): WSSubscribedResponse | WSErrorResponse {
    const { sessionId, events, requestId } = message;

    // Validate sessionId
    if (!sessionId || typeof sessionId !== 'string') {
      return this.createError('INVALID_SESSION', 'sessionId is required', requestId);
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

    // Chain all target rooms into a SINGLE emit. Socket.io delivers once to a
    // socket that belongs to several of these rooms; four separate .emit() calls
    // would deliver duplicates to clients subscribed to both exact and wildcard
    // rooms.
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
   * Emit message acknowledgment
   */
  emitMessageAck(sessionId: string, data: { messageId: string; ack: number; ackName: string }) {
    this.emitToRooms(sessionId, 'message.ack', data);
  }

  // ========== Session event-bus listeners ==========
  // Subscribe to SessionService domain events instead of being called directly,
  // decoupling the session lifecycle from the WebSocket transport. Each listener
  // guards its emit so a transport error never escapes as an unhandled rejection.

  @OnEvent(SessionEvents.STATUS)
  onSessionStatus(e: SessionStatusEvent): void {
    this.safeHandle('session.status', e.sessionId, () => this.emitSessionStatus(e.sessionId, e.status));
  }

  @OnEvent(SessionEvents.MESSAGE_RECEIVED)
  onSessionMessageReceived(e: SessionMessageEvent): void {
    this.safeHandle('message.received', e.sessionId, () => this.emitMessage(e.sessionId, e.message));
  }

  @OnEvent(SessionEvents.MESSAGE_SENT)
  onSessionMessageSent(e: SessionMessageEvent): void {
    this.safeHandle('message.sent', e.sessionId, () => this.emitMessageSent(e.sessionId, e.message));
  }

  @OnEvent(SessionEvents.MESSAGE_ACK)
  onSessionMessageAck(e: SessionAckEvent): void {
    this.safeHandle('message.ack', e.sessionId, () => this.emitMessageAck(e.sessionId, e.ack));
  }

  private safeHandle(event: string, sessionId: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.logger.error(
        `WS emit for '${event}' failed: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        { sessionId, action: 'ws_emit_failed' },
      );
    }
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
