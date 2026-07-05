// src/modules/events/dto/ws-messages.dto.ts

/**
 * WebSocket message types for subscription protocol
 */

// Client -> Server message types
export type WSClientMessageType = 'subscribe' | 'unsubscribe' | 'ping';

// Server -> Client message types
export type WSServerMessageType = 'subscribed' | 'unsubscribed' | 'event' | 'error' | 'pong';

// Valid event types that can be subscribed to over the socket. Every entry here MUST have a
// matching EventsGateway.emit* producer — the drift guard in events.gateway.spec asserts this.
// (group.* are NOT listed: they have no engine emit source and were never delivered; they stay
// reserved on the webhook side via WEBHOOK_RESERVED_EVENTS.)
export const SUBSCRIBABLE_EVENTS = [
  'message.received',
  'message.sent',
  'message.ack',
  'message.revoked',
  'message.reaction',
  'session.status',
  'session.qr',
  'session.authenticated',
  'session.disconnected',
] as const;

export type SubscribableEvent = (typeof SUBSCRIBABLE_EVENTS)[number] | '*';

// Client -> Server: Subscribe request
export interface WSSubscribeRequest {
  type: 'subscribe';
  sessionId: string; // Session ID or '*' for all
  events: string[]; // Event types or ['*'] for all
  requestId?: string;
}

// Client -> Server: Unsubscribe request
export interface WSUnsubscribeRequest {
  type: 'unsubscribe';
  sessionId: string;
  requestId?: string;
}

// Client -> Server: Ping
export interface WSPingRequest {
  type: 'ping';
  requestId?: string;
}

// Union type for all client messages
export type WSClientMessage = WSSubscribeRequest | WSUnsubscribeRequest | WSPingRequest;

// Server -> Client: Subscription confirmed
export interface WSSubscribedResponse {
  type: 'subscribed';
  sessionId: string;
  events: string[];
  requestId?: string;
  timestamp: string;
}

// Server -> Client: Unsubscription confirmed
export interface WSUnsubscribedResponse {
  type: 'unsubscribed';
  sessionId: string;
  requestId?: string;
  timestamp: string;
}

// Server -> Client: Event payload
export interface WSEventMessage {
  type: 'event';
  payload: {
    event: string;
    sessionId: string;
    data: unknown;
  };
  timestamp: string;
}

// Server -> Client: Error
export interface WSErrorResponse {
  type: 'error';
  code: string;
  message: string;
  requestId?: string;
  timestamp: string;
}

// Server -> Client: Pong
export interface WSPongResponse {
  type: 'pong';
  requestId?: string;
  timestamp: string;
}

// Union type for all server messages
export type WSServerMessage =
  WSSubscribedResponse | WSUnsubscribedResponse | WSEventMessage | WSErrorResponse | WSPongResponse;

// Room name builder
export function buildRoomName(sessionId: string, event: string): string {
  return `session:${sessionId}:${event}`;
}

// Parse room name back to components
export function parseRoomName(room: string): { sessionId: string; event: string } | null {
  const match = room.match(/^session:([^:]+):(.+)$/);
  if (!match) return null;
  return { sessionId: match[1], event: match[2] };
}
