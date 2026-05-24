import { generateIdempotencyKey, generateDeliveryId } from './idempotency.util';

describe('Idempotency Utils', () => {
  describe('generateIdempotencyKey', () => {
    it('should generate key for message.received', () => {
      const key = generateIdempotencyKey('message.received', { messageId: 'ABC123' });
      expect(key).toBe('msg_ABC123');
    });

    it('should fallback to message id when messageId is missing', () => {
      const key = generateIdempotencyKey('message.received', { id: 'wamid.HBgM...' });
      expect(key).toBe('msg_wamid.HBgM...');
    });

    it('should not collapse missing message identifiers into msg_unknown', () => {
      const key1 = generateIdempotencyKey('message.received', { body: 'hola-1', timestamp: 1 });
      const key2 = generateIdempotencyKey('message.received', { body: 'hola-2', timestamp: 2 });

      expect(key1).toMatch(/^msg_[a-f0-9]{12}$/);
      expect(key2).toMatch(/^msg_[a-f0-9]{12}$/);
      expect(key1).not.toBe(key2);
    });

    it('should generate key for message.ack', () => {
      const key = generateIdempotencyKey('message.ack', { messageId: 'ABC123', ack: 3 });
      expect(key).toBe('ack_ABC123_3');
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
