import { generateIdempotencyKey, generateDeliveryId } from './idempotency.util';

describe('Idempotency Utils', () => {
  describe('generateIdempotencyKey', () => {
    it('should generate a session-scoped key for message.received', () => {
      const key = generateIdempotencyKey('message.received', { messageId: 'ABC123', sessionId: 'A' });
      expect(key).toBe('msg_A_ABC123');
    });

    it('falls back to the legacy `ack` integer for message.ack when no `status` is present', () => {
      const key = generateIdempotencyKey('message.ack', { messageId: 'ABC123', ack: 3, sessionId: 'A' });
      expect(key).toBe('ack_A_ABC123_3');
    });

    it('should use the IncomingMessage `id` field for message.received (the real dispatch shape)', () => {
      // session.service dispatches the IncomingMessage object, which carries `id`, not `messageId`.
      const key = generateIdempotencyKey('message.received', { id: 'ABC123', sessionId: 'A' });
      expect(key).toBe('msg_A_ABC123');
    });

    it('should prefer `id` over a legacy `messageId` when both are present for message.received', () => {
      const key = generateIdempotencyKey('message.received', { id: 'REAL', messageId: 'LEGACY', sessionId: 'A' });
      expect(key).toBe('msg_A_REAL');
    });

    it('keys message.ack on the neutral `status` (the real dispatch shape), preferring it over `ack`', () => {
      const key = generateIdempotencyKey('message.ack', { id: 'ABC123', status: 'read', ack: 3, sessionId: 'A' });
      expect(key).toBe('ack_A_ABC123_read');
    });

    it('should use the `id` field for message.revoked (the real dispatch shape)', () => {
      const key = generateIdempotencyKey('message.revoked', { id: 'ABC123', sessionId: 'A' });
      expect(key).toBe('rev_A_ABC123');
    });

    it('gives the same waMessageId in different sessions DISTINCT keys', () => {
      const a = generateIdempotencyKey('message.ack', { id: 'X', status: 'delivered', sessionId: 'A' });
      const b = generateIdempotencyKey('message.ack', { id: 'X', status: 'delivered', sessionId: 'B' });
      expect(a).not.toBe(b);
    });

    it('should generate key for session.status', () => {
      const key = generateIdempotencyKey('session.status', {
        sessionId: 'sess_1',
        status: 'CONNECTED',
      });
      expect(key).toBe('sess_sess_1_CONNECTED');
    });

    it('should generate key for group.join', () => {
      const key = generateIdempotencyKey('group.join', {
        groupId: 'grp_1',
        participantId: 'user_1',
      });
      expect(key).toBe('grp_grp_1_user_1_join');
    });

    it('should generate fallback key for unknown events', () => {
      const key = generateIdempotencyKey('custom.event', {});
      expect(key).toMatch(/^evt_custom_event_[a-f0-9]{12}$/);
    });
  });

  describe('generateDeliveryId', () => {
    it('should generate unique delivery IDs', () => {
      const id1 = generateDeliveryId();
      const id2 = generateDeliveryId();

      expect(id1).toMatch(/^dlv_[a-f0-9-]{36}$/);
      expect(id2).toMatch(/^dlv_[a-f0-9-]{36}$/);
      expect(id1).not.toBe(id2);
    });
  });
});
