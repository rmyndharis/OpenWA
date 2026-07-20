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

    it('salts message.edited keys so an edit (same message, later time) is a distinct event', () => {
      const a = generateIdempotencyKey(
        'message.edited',
        { sessionId: 'A', messageId: 'MSG1' },
        '2026-06-20T00:00:00.000Z',
      );
      const b = generateIdempotencyKey(
        'message.edited',
        { sessionId: 'A', messageId: 'MSG1' },
        '2026-06-20T00:05:00.000Z',
      );
      expect(a).not.toBe(b);
    });

    it('is retry-stable for message.edited: the same occurrence regenerates the same key', () => {
      const at = '2026-06-20T00:00:00.000Z';
      const data = { sessionId: 'A', messageId: 'MSG1' };
      expect(generateIdempotencyKey('message.edited', data, at)).toBe(
        generateIdempotencyKey('message.edited', data, at),
      );
    });

    it('keys group.join on the group + affected participants (the real participantIds payload)', () => {
      const at = '2026-07-20T00:00:00.000Z';
      const key = generateIdempotencyKey(
        'group.join',
        { groupId: '123@g.us', participantIds: ['6281@c.us'], timestamp: 1782000000 },
        at,
      );
      expect(key).toMatch(/^grp_123@g\.us_[a-f0-9]{12}_join_2026-07-20T00:00:00\.000Z$/);
    });

    it('is retry-stable for group.join: the same occurrence regenerates the same key', () => {
      const at = '2026-07-20T00:00:00.000Z';
      const data = { groupId: '123@g.us', participantIds: ['6281@c.us'], timestamp: 1782000000 };
      expect(generateIdempotencyKey('group.join', data, at)).toBe(generateIdempotencyKey('group.join', data, at));
    });

    it('salts group.join keys so a leave-then-rejoin of the same user stays a distinct event', () => {
      const data = { groupId: '123@g.us', participantIds: ['6281@c.us'], timestamp: 1782000000 };
      const a = generateIdempotencyKey('group.join', data, '2026-07-20T00:00:00.000Z');
      const b = generateIdempotencyKey('group.join', data, '2026-07-20T01:00:00.000Z');
      expect(a).not.toBe(b);
    });

    it('gives different participants distinct group.join keys for the same occurrence', () => {
      const at = '2026-07-20T00:00:00.000Z';
      const a = generateIdempotencyKey('group.join', { groupId: '123@g.us', participantIds: ['u1@c.us'] }, at);
      const b = generateIdempotencyKey('group.join', { groupId: '123@g.us', participantIds: ['u2@c.us'] }, at);
      expect(a).not.toBe(b);
    });

    it('keys group.leave symmetrically to group.join (and distinct from it)', () => {
      const at = '2026-07-20T00:00:00.000Z';
      const data = { groupId: '123@g.us', participantIds: ['6281@c.us'] };
      const join = generateIdempotencyKey('group.join', data, at);
      const leave = generateIdempotencyKey('group.leave', data, at);
      expect(leave).toMatch(/^grp_123@g\.us_[a-f0-9]{12}_leave_/);
      expect(leave).not.toBe(join);
    });

    it('keys group.update on WHAT changed, salted per occurrence', () => {
      const at = '2026-07-20T00:00:00.000Z';
      const data = { groupId: '123@g.us', changes: { subject: 'New name' }, timestamp: 1782000000 };
      const a = generateIdempotencyKey('group.update', data, at);
      expect(a).toMatch(/^grp_123@g\.us_update_[a-f0-9]{12}_2026-07-20T00:00:00\.000Z$/);
      // Retry of the same delivery stays stable...
      expect(generateIdempotencyKey('group.update', data, at)).toBe(a);
      // ...a later identical update is a distinct occurrence...
      expect(generateIdempotencyKey('group.update', data, '2026-07-20T00:05:00.000Z')).not.toBe(a);
      // ...and a different change differs even inside the same dispatch window.
      expect(generateIdempotencyKey('group.update', { groupId: '123@g.us', changes: { announce: true } }, at)).not.toBe(
        a,
      );
    });

    it('keys call.received on the session + call id (unique per call, no occurrence salt needed)', () => {
      const at = '2026-07-20T00:00:00.000Z';
      const data = { sessionId: 'A', callId: 'CALL1', from: '628111@c.us', timestamp: 1782000000 };
      const key = generateIdempotencyKey('call.received', data, at);
      expect(key).toBe('call_A_CALL1');
      // Retry of the same dispatch regenerates the same key — occurredAt is ignored by design...
      expect(generateIdempotencyKey('call.received', data, '2026-07-20T01:00:00.000Z')).toBe(key);
      // ...while a distinct call (a new occurrence, always a new call id) gets a distinct key.
      expect(generateIdempotencyKey('call.received', { ...data, callId: 'CALL2' }, at)).not.toBe(key);
      // Scoped by session like the message keys: the same call id on another session must not dedupe.
      expect(generateIdempotencyKey('call.received', { ...data, sessionId: 'B' }, at)).not.toBe(key);
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
