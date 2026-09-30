import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyWebhookSignature } from '../src';
import type { WebhookDelivery } from '../src';

// Shared across the SDK suites; the gateway's generateSignature produces this header for this body.
const SECRET = 'test-secret-0123456789';
const BODY =
  '{"event":"message.received","timestamp":"2026-02-02T10:00:00.000Z","sessionId":"s1","idempotencyKey":"k",' +
  '"deliveryId":"dlv_1","data":{"text":"héllo \u{1F44B}"}}';
const HEX = 'd74a41bb687f31ed4c932f76f524116100ca4120d2cabb7a469ee5d928122f70';
const SIGNATURE = `sha256=${HEX}`;

describe('verifyWebhookSignature', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts the signature the gateway sends, over a string or the raw bytes', async () => {
    expect(await verifyWebhookSignature(BODY, SIGNATURE, SECRET)).toBe(true);
    expect(await verifyWebhookSignature(new TextEncoder().encode(BODY), SIGNATURE, SECRET)).toBe(true);
    expect(await verifyWebhookSignature(BODY, `sha256=${HEX.toUpperCase()}`, SECRET)).toBe(true);
  });

  it('rejects a changed body, a wrong secret and a malformed header without throwing', async () => {
    const tampered = new TextEncoder().encode(BODY);
    tampered[10] ^= 1;
    expect(await verifyWebhookSignature(tampered, SIGNATURE, SECRET)).toBe(false);
    expect(await verifyWebhookSignature(BODY, SIGNATURE, 'another-secret-012345')).toBe(false);
    for (const header of [
      HEX,
      `SHA256=${HEX}`,
      `sha256=${HEX.slice(1)}`,
      `sha256=${HEX.slice(1)}z`,
      '',
      null,
      undefined,
    ]) {
      expect(await verifyWebhookSignature(BODY, header, SECRET)).toBe(false);
    }
    expect(await verifyWebhookSignature(BODY, SIGNATURE, '')).toBe(false);
  });

  it('falls back to node:crypto where there is no global WebCrypto (Node 18)', async () => {
    vi.stubGlobal('crypto', undefined);
    expect(globalThis.crypto).toBeUndefined();
    expect(await verifyWebhookSignature(BODY, SIGNATURE, SECRET)).toBe(true);
    expect(await verifyWebhookSignature(BODY, SIGNATURE, 'another-secret-012345')).toBe(false);
  });

  it('types the delivery body, including the test event', () => {
    const test: WebhookDelivery = {
      event: 'test',
      timestamp: '2026-02-02T10:00:00.000Z',
      sessionId: 's1',
      idempotencyKey: 'k',
      deliveryId: 'dlv_1',
      data: {},
    };
    const received: WebhookDelivery<{ text: string }> = { ...test, event: 'message.received', data: { text: 'hi' } };
    expect(received.data.text).toBe('hi');
  });
});
