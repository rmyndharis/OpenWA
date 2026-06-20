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
 * Message keys are content-based (keyed on the unique message id), so two deliveries of the same
 * logical message dedupe. Lifecycle events (session.status/authenticated/disconnected) recur with
 * identical content — the same phone on every reconnect, a constant disconnect reason — so they are
 * salted with `occurredAt` (captured ONCE per dispatch and reused across retries): distinct
 * occurrences get distinct keys while retries of the same occurrence stay stable.
 *
 * @param occurredAt - ISO timestamp captured once per dispatch; salts recurring lifecycle keys.
 */
export function generateIdempotencyKey(event: string, data: Record<string, unknown>, occurredAt?: string): string {
  // Salt applied only to the recurring lifecycle keys below; message/qr keys ignore it.
  const occurrence = occurredAt ? `_${occurredAt}` : '';
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

    case 'message.reaction':
      // A reaction carries no unique id and is a read-modify-write of the message's reactions map; the
      // same sender can re-apply the same emoji over time (👍 → remove → 👍). Keying on
      // (sender, target message) alone would collapse a genuine re-reaction onto the earlier one, so salt
      // with occurredAt (captured once per dispatch, reused across retries): distinct occurrences get
      // distinct keys while retries of the same delivery stay stable.
      return `react_${toStr(data.sessionId)}_${toStr(data.messageId)}_${toStr(data.senderId)}${occurrence}`;

    case 'session.status':
      // Salted so repeated transitions to the same status (e.g. across disconnect/reconnect cycles)
      // stay distinct instead of collapsing onto one key.
      return `sess_${toStr(data.sessionId)}_${toStr(data.status)}${occurrence}`;

    case 'session.qr':
      // QR changes each time, use the QR data hash for uniqueness
      return `qr_${toStr(data.sessionId)}_${hashData({ qr: data.qr })}`;

    case 'session.authenticated':
      // Salted so each (re)authentication is a distinct event — phone/pushName repeat across reconnects.
      return `auth_${toStr(data.sessionId)}_${hashData(data)}${occurrence}`;

    case 'session.disconnected':
      // Salted so repeat disconnects stay distinct — `reason` alone can be a constant (Baileys
      // always sends 'logged out'), which would otherwise collapse every disconnect onto one key.
      return `disc_${toStr(data.sessionId)}_${hashData({ reason: data.reason })}${occurrence}`;

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
 * Generate a unique delivery ID for each webhook delivery (stable across retry attempts)
 */
export function generateDeliveryId(): string {
  return `dlv_${randomUUID()}`;
}
