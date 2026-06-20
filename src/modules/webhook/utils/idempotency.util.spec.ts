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

    it('salts session.status keys with the occurrence time so repeated transitions to the same status stay distinct', () => {
      const a = generateIdempotencyKey(
        'session.status',
        { sessionId: 'A', status: 'DISCONNECTED' },
        '2026-06-19T00:00:00.000Z',
      );
      const b = generateIdempotencyKey(
        'session.status',
        { sessionId: 'A', status: 'DISCONNECTED' },
        '2026-06-19T02:00:00.000Z',
      );
      expect(a).not.toBe(b);
    });

    it('salts session.authenticated keys so re-authentication (same phone, later time) is a distinct event', () => {
      const a = generateIdempotencyKey(
        'session.authenticated',
        { sessionId: 'A', phone: '628', pushName: 'Me' },
        '2026-06-19T00:00:00.000Z',
      );
      const b = generateIdempotencyKey(
        'session.authenticated',
        { sessionId: 'A', phone: '628', pushName: 'Me' },
        '2026-06-19T01:00:00.000Z',
      );
      expect(a).not.toBe(b);
    });

    it('salts session.disconnected keys so repeat disconnects with the same reason stay distinct', () => {
      const a = generateIdempotencyKey(
        'session.disconnected',
        { sessionId: 'A', reason: 'logged out' },
        '2026-06-19T00:00:00.000Z',
      );
      const b = generateIdempotencyKey(
        'session.disconnected',
        { sessionId: 'A', reason: 'logged out' },
        '2026-06-19T03:00:00.000Z',
      );
      expect(a).not.toBe(b);
    });

    it('is retry-stable: the same lifecycle occurrence regenerates the same key', () => {
      const at = '2026-06-19T00:00:00.000Z';
      const a = generateIdempotencyKey('session.disconnected', { sessionId: 'A', reason: 'logged out' }, at);
      const b = generateIdempotencyKey('session.disconnected', { sessionId: 'A', reason: 'logged out' }, at);
      expect(a).toBe(b);
    });

    it('does not salt message-event keys with the occurrence time (content-based dedup preserved)', () => {
      const a = generateIdempotencyKey(
        'message.ack',
        { id: 'X', status: 'read', sessionId: 'A' },
        '2026-06-19T00:00:00.000Z',
      );
      const b = generateIdempotencyKey(
        'message.ack',
        { id: 'X', status: 'read', sessionId: 'A' },
        '2026-06-19T09:00:00.000Z',
      );
      expect(a).toBe(b);
      expect(a).toBe('ack_A_X_read');
    });

    it('salts message.reaction keys so a re-reaction (same sender/emoji, later time) is a distinct event', () => {
      // A reaction has no unique id and is a read-modify-write: the same sender can go 👍 → remove → 👍.
      // Keying on (sender, message, emoji) alone would collapse the re-reaction onto the earlier one.
      const a = generateIdempotencyKey(
        'message.reaction',
        { sessionId: 'A', messageId: 'MSG1', senderId: '628111@c.us', reaction: '👍' },
        '2026-06-20T00:00:00.000Z',
      );
      const b = generateIdempotencyKey(
        'message.reaction',
        { sessionId: 'A', messageId: 'MSG1', senderId: '628111@c.us', reaction: '👍' },
        '2026-06-20T00:05:00.000Z',
      );
      expect(a).not.toBe(b);
    });

    it('is retry-stable for message.reaction: the same occurrence regenerates the same key', () => {
      const at = '2026-06-20T00:00:00.000Z';
      const data = { sessionId: 'A', messageId: 'MSG1', senderId: '628111@c.us', reaction: '👍' };
      expect(generateIdempotencyKey('message.reaction', data, at)).toBe(
        generateIdempotencyKey('message.reaction', data, at),
      );
    });

    it('gives two senders reacting to the same message DISTINCT message.reaction keys', () => {
      const at = '2026-06-20T00:00:00.000Z';
      const a = generateIdempotencyKey('message.reaction', { sessionId: 'A', messageId: 'M', senderId: 'S1' }, at);
      const b = generateIdempotencyKey('message.reaction', { sessionId: 'A', messageId: 'M', senderId: 'S2' }, at);
      expect(a).not.toBe(b);
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
