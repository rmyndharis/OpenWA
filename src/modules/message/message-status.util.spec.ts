import { deliveryStatusToMessageStatus, deliveryStatusToAck, ackStatusTransitionFrom } from './message-status.util';
import { MessageStatus } from './entities/message.entity';

describe('deliveryStatusToMessageStatus', () => {
  it("maps 'failed' to FAILED", () => {
    expect(deliveryStatusToMessageStatus('failed')).toBe(MessageStatus.FAILED);
  });

  it("maps 'delivered' to DELIVERED", () => {
    expect(deliveryStatusToMessageStatus('delivered')).toBe(MessageStatus.DELIVERED);
  });

  it("maps 'read' to READ", () => {
    expect(deliveryStatusToMessageStatus('read')).toBe(MessageStatus.READ);
  });

  it("returns null for 'pending'/'sent' — no upgrade beyond SENT", () => {
    expect(deliveryStatusToMessageStatus('pending')).toBeNull();
    expect(deliveryStatusToMessageStatus('sent')).toBeNull();
  });
});

describe('deliveryStatusToAck (deprecated legacy ack integer)', () => {
  it('derives the legacy wwebjs-style ack integer from the neutral status', () => {
    expect(deliveryStatusToAck('failed')).toBe(-1);
    expect(deliveryStatusToAck('pending')).toBe(0);
    expect(deliveryStatusToAck('sent')).toBe(1);
    expect(deliveryStatusToAck('delivered')).toBe(2);
    expect(deliveryStatusToAck('read')).toBe(3);
  });
});

describe('ackStatusTransitionFrom (monotonic delivery-state guard)', () => {
  it('DELIVERED may advance only from PENDING/SENT (never downgrades a READ row)', () => {
    expect(ackStatusTransitionFrom(MessageStatus.DELIVERED)).toEqual([MessageStatus.PENDING, MessageStatus.SENT]);
    expect(ackStatusTransitionFrom(MessageStatus.DELIVERED)).not.toContain(MessageStatus.READ);
  });

  it('READ may advance from PENDING/SENT/DELIVERED', () => {
    expect(ackStatusTransitionFrom(MessageStatus.READ)).toEqual([
      MessageStatus.PENDING,
      MessageStatus.SENT,
      MessageStatus.DELIVERED,
    ]);
  });

  it('FAILED does not clobber an already delivered/read message', () => {
    const from = ackStatusTransitionFrom(MessageStatus.FAILED);
    expect(from).toEqual([MessageStatus.PENDING, MessageStatus.SENT]);
    expect(from).not.toContain(MessageStatus.DELIVERED);
    expect(from).not.toContain(MessageStatus.READ);
  });
});
