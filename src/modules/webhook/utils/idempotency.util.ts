import { randomUUID, createHash } from 'crypto';

/**
 * Safely convert an unknown value to a string for use in idempotency keys
 */
function toStr(value: unknown, fallback = 'unknown'): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

/**
 * Generate a short hash from data for use in idempotency keys.
 * Used when no unique identifier is available in the payload.
 */
function hashData(data: Record<string, unknown>): string {
  const str = JSON.stringify(data, Object.keys(data).sort());
  return createHash('sha256').update(str).digest('hex').substring(0, 12);
}

/**
 * Generate an idempotency key based on event type and data.
 * Same event with same data will produce the same key (deterministic).
 *
 * @remarks
 * Keys are content-based and do NOT include timestamps.
 * This ensures that replayed/retried events with identical payloads
 * produce the same key for proper deduplication.
 */
export function generateIdempotencyKey(event: string, data: Record<string, unknown>): string {
  switch (event) {
    case 'message.received':
    case 'message.sent':
      // Dispatched payload is an IncomingMessage, which carries `id`; fall back to a legacy `messageId`.
      // Resolve the value before toStr() — toStr() returns a truthy 'unknown' fallback, so chaining with
      // `||` would short-circuit before reaching the second field.
      // Scope by sessionId: waMessageIds are unique per account, not globally, so two
      // sessions could otherwise collide on the same key and wrongly dedupe each other's events.
      return `msg_${toStr(data.sessionId)}_${toStr(data.id ?? data.messageId)}`;

    case 'message.ack':
      // Message ID + delivery status together are unique. Key on the neutral `status`; fall back to
      // the legacy `ack` integer for backward compatibility with older payloads.
      return `ack_${toStr(data.sessionId)}_${toStr(data.id ?? data.messageId)}_${toStr(data.status ?? data.ack, '0')}`;

    case 'message.failed':
      return `failed_${toStr(data.sessionId)}_${toStr(data.id ?? data.messageId)}_${toStr(data.status ?? data.ack, '0')}`;

    case 'message.revoked':
      return `rev_${toStr(data.sessionId)}_${toStr(data.id ?? data.messageId)}`;

    case 'session.status':
      // Session + status combo (same status emitted once per transition)
      return `sess_${toStr(data.sessionId)}_${toStr(data.status)}`;

    case 'session.qr':
      // QR changes each time, use the QR data hash for uniqueness
      return `qr_${toStr(data.sessionId)}_${hashData({ qr: data.qr })}`;

    case 'session.authenticated':
      // Auth only happens once per session lifecycle
      return `auth_${toStr(data.sessionId)}_${hashData(data)}`;

    case 'session.disconnected':
      // Disconnect with reason for uniqueness
      return `disc_${toStr(data.sessionId)}_${hashData({ reason: data.reason })}`;

    case 'group.join':
      return `grp_${toStr(data.groupId)}_${toStr(data.participantId)}_join`;

    case 'group.leave':
      return `grp_${toStr(data.groupId)}_${toStr(data.participantId)}_leave`;

    case 'group.update':
      // Include what changed for uniqueness
      return `grp_${toStr(data.groupId)}_update_${hashData(data)}`;

    default:
      // Fallback: hash entire payload for determinism
      return `evt_${event.replace(/\./g, '_')}_${hashData(data)}`;
  }
}

/**
 * Generate a unique delivery ID for each webhook delivery attempt
 */
export function generateDeliveryId(): string {
  return `dlv_${randomUUID()}`;
}
