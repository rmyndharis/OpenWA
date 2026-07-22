/**
 * Hook System Interfaces
 * Central event bus for plugin integration
 */

export type HookEvent =
  // Session lifecycle
  | 'session:created'
  | 'session:starting'
  | 'session:ready'
  | 'session:qr'
  | 'session:disconnected'
  | 'session:error'
  | 'session:deleted'
  // Message lifecycle
  | 'message:received'
  | 'message:sending'
  | 'message:sent'
  | 'message:failed'
  | 'message:ack'
  | 'message:persisted'
  // Webhook lifecycle
  | 'webhook:before'
  | 'webhook:queued' // After webhook job added to queue (queue mode only)
  | 'webhook:delivered' // After webhook successfully delivered (direct or queue)
  | 'webhook:after' // After webhook attempt (direct mode only, deprecated for queue)
  | 'webhook:error' // After webhook delivery failed (all retries exhausted)
  // Ingress (inbound provider webhook -> plugin) lifecycle
  | 'ingress:error'; // After an ingress dispatch failed (all retries exhausted)

// Runtime allowlist of every HookEvent. The Record is exhaustively typed, so adding a HookEvent above
// without listing it here is a COMPILE error — keeping the runtime set in lockstep with the type.
// Used to reject fabricated event names at the sandbox IPC boundary (HookEvent is type-only; the wire
// payload is an arbitrary string), bounding host-registry growth to this finite set.
const HOOK_EVENT_REGISTRY: Record<HookEvent, true> = {
  'session:created': true,
  'session:starting': true,
  'session:ready': true,
  'session:qr': true,
  'session:disconnected': true,
  'session:error': true,
  'session:deleted': true,
  'message:received': true,
  'message:sending': true,
  'message:sent': true,
  'message:failed': true,
  'message:ack': true,
  'message:persisted': true,
  'webhook:before': true,
  'webhook:queued': true,
  'webhook:delivered': true,
  'webhook:after': true,
  'webhook:error': true,
  'ingress:error': true,
};

export const KNOWN_HOOK_EVENTS: ReadonlySet<HookEvent> = new Set(Object.keys(HOOK_EVENT_REGISTRY) as HookEvent[]);

/** Type guard: is `event` one of the known HookEvent values? Narrows an untrusted string to HookEvent. */
export function isKnownHookEvent(event: string): event is HookEvent {
  return (KNOWN_HOOK_EVENTS as ReadonlySet<string>).has(event);
}

export interface HookContext<T = unknown> {
  event: HookEvent;
  data: T;
  sessionId?: string;
  timestamp: Date;
  source: string; // Which service emitted this
}

export interface HookResult<T = unknown> {
  /**
   * `false` stops the handler chain: the handlers registered after this one do not run.
   *
   * That is its whole meaning on a notification event (`message:received`, `message:sent`, …). The
   * message has already arrived at, or left, WhatsApp — a handler can keep other plugins from acting on
   * it, but the gateway still records it and still dispatches it to webhooks and the websocket. Use it
   * to claim an event ("I answered this, don't let another bot answer too"), not to hide one.
   *
   * On a pre-action event it is a veto, because the action has not happened yet: `false` on
   * `message:sending` blocks the send (core/hooks/sending-gate.ts), and on `webhook:before` it cancels
   * that delivery.
   */
  continue: boolean;
  data?: T; // Modified data (optional)
  error?: Error; // Error to propagate
}

export type HookHandler<T = unknown> = (ctx: HookContext<T>) => Promise<HookResult<T>>;

export interface HookRegistration {
  id: string;
  pluginId: string;
  event: HookEvent;
  handler: HookHandler;
  priority: number; // Lower = runs first
}
