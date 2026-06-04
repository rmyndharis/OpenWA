/**
 * Internal domain events emitted by SessionService from engine callbacks.
 *
 * Decouples the session lifecycle from its fan-out consumers: instead of
 * SessionService calling WebhookService and EventsGateway directly, it emits
 * these events and the consumers subscribe via `@OnEvent`. The hook pipeline
 * stays inside SessionService because it can mutate/halt the payload before the
 * event is emitted — listeners only run once the session layer decides to fan out.
 */
export const SessionEvents = {
  /** Session lifecycle status changed (initializing/qr/ready/disconnected/…). */
  STATUS: 'session.status',
  /** Inbound message accepted by the hook pipeline (payload already hook-modified). */
  MESSAGE_RECEIVED: 'session.message.received',
  /** Outbound message confirmed sent. */
  MESSAGE_SENT: 'session.message.sent',
  /** Delivery/read acknowledgement for an outbound message. */
  MESSAGE_ACK: 'session.message.ack',
} as const;

export interface SessionStatusEvent {
  sessionId: string;
  status: string;
}

export interface SessionMessageEvent {
  sessionId: string;
  message: Record<string, unknown>;
}

export interface SessionAckEvent {
  sessionId: string;
  ack: { messageId: string; ack: number; ackName: string };
}
