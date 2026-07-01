import { createHmac } from 'node:crypto';
import { verifyIngressSignature } from './ingress-signature';

const secret = 'topsecret';
const rawBody = '{"event":"message_created"}';
const sig = (body: string) => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

describe('verifyIngressSignature', () => {
  const spec = {
    scheme: 'hmac-sha256' as const,
    header: 'X-Sig',
    contentTemplate: '{rawBody}',
    encoding: 'hex' as const,
    prefix: 'sha256=',
  };

  it('accepts a correct hmac-sha256 signature over the raw body', () => {
    const r = verifyIngressSignature(spec, { rawBody, headers: { 'x-sig': sig(rawBody) }, secret, now: 0 });
    expect(r.ok).toBe(true);
  });

  it('rejects a tampered body (constant-time mismatch)', () => {
    const r = verifyIngressSignature(spec, {
      rawBody: rawBody + ' ',
      headers: { 'x-sig': sig(rawBody) },
      secret,
      now: 0,
    });
    expect(r.ok).toBe(false);
  });

  it('rejects a stale timestamp beyond tolerance', () => {
    const withTs = { ...spec, timestampHeader: 'X-Ts', toleranceSec: 300, contentTemplate: '{timestamp}.{rawBody}' };
    const t = 1000;
    const signed = 'sha256=' + createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
    const r = verifyIngressSignature(withTs, {
      rawBody,
      headers: { 'x-sig': signed, 'x-ts': String(t) },
      secret,
      now: (t + 400) * 1000,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/replay|stale|tolerance/i);
  });

  it('accepts a fresh timestamp within tolerance', () => {
    const withTs = { ...spec, timestampHeader: 'X-Ts', toleranceSec: 300, contentTemplate: '{timestamp}.{rawBody}' };
    const t = 1000;
    const signed = 'sha256=' + createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
    const r = verifyIngressSignature(withTs, {
      rawBody,
      headers: { 'x-sig': signed, 'x-ts': String(t) },
      secret,
      now: (t + 10) * 1000,
    });
    expect(r.ok).toBe(true);
  });

  it('rejects a missing signature header', () => {
    const r = verifyIngressSignature(spec, { rawBody, headers: {}, secret, now: 0 });
    expect(r.ok).toBe(false);
  });

  it('accepts a shared-secret match and rejects a mismatch (constant time)', () => {
    const sharedSpec = { scheme: 'shared-secret' as const, header: 'X-Token' };
    expect(verifyIngressSignature(sharedSpec, { rawBody, headers: { 'x-token': secret }, secret, now: 0 }).ok).toBe(
      true,
    );
    expect(verifyIngressSignature(sharedSpec, { rawBody, headers: { 'x-token': 'nope' }, secret, now: 0 }).ok).toBe(
      false,
    );
  });

  it('accepts scheme "none" without a signature', () => {
    expect(verifyIngressSignature({ scheme: 'none' }, { rawBody, headers: {}, secret, now: 0 }).ok).toBe(true);
  });
});
