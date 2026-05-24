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
      // Message ID is unique per message. Prefer messageId, fallback to id.
      if (typeof data.messageId === 'string' && data.messageId.trim()) {
        return `msg_${data.messageId.trim()}`;
      }
      if (typeof data.id === 'string' && data.id.trim()) {
        return `msg_${data.id.trim()}`;
      }
      // Last-resort deterministic fallback to avoid collapsing everything to msg_unknown.
      return `msg_${hashData(data)}`;

    case 'message.ack':
      // Message ID + ack status together are unique
      return `ack_${toStr(data.messageId)}_${toStr(data.ack, '0')}`;

    case 'message.revoked':
      return `rev_${toStr(data.messageId)}`;

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
