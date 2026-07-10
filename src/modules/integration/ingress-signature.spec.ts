import { createHmac } from 'node:crypto';
import { verifyIngressSignature } from './ingress-signature';

const secret = 'topsecret';
const instanceId = 'inst-123';
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
    const r = verifyIngressSignature(spec, { rawBody, headers: { 'x-sig': sig(rawBody) }, secret, now: 0, instanceId });
    expect(r.ok).toBe(true);
  });

  it('rejects a tampered body (constant-time mismatch)', () => {
    const r = verifyIngressSignature(spec, {
      rawBody: rawBody + ' ',
      headers: { 'x-sig': sig(rawBody) },
      secret,
      now: 0,
      instanceId,
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
      instanceId,
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
      instanceId,
    });
    expect(r.ok).toBe(true);
  });

  it('rejects a missing signature header', () => {
    const r = verifyIngressSignature(spec, { rawBody, headers: {}, secret, now: 0, instanceId });
    expect(r.ok).toBe(false);
  });

  it('accepts a shared-secret match and rejects a mismatch (constant time)', () => {
    const sharedSpec = { scheme: 'shared-secret' as const, header: 'X-Token' };
    expect(
      verifyIngressSignature(sharedSpec, { rawBody, headers: { 'x-token': secret }, secret, now: 0, instanceId }).ok,
    ).toBe(true);
    expect(
      verifyIngressSignature(sharedSpec, { rawBody, headers: { 'x-token': 'nope' }, secret, now: 0, instanceId }).ok,
    ).toBe(false);
  });

  it('accepts a legitimately-signed body containing $-substitution sequences (no String.replace mangling)', () => {
    // A body with $&, $', $` , $$, $1 and even a literal {timestamp} must be HMAC'd verbatim. A naive
    // String.replace would interpret these in the replacement and diverge the signed bytes.
    const trickyBody = '{"a":"$& $\' $` $$ $1","b":"{timestamp}"}';
    const r = verifyIngressSignature(spec, {
      rawBody: trickyBody,
      headers: { 'x-sig': sig(trickyBody) },
      secret,
      now: 0,
      instanceId,
    });
    expect(r.ok).toBe(true);
  });

  it('accepts a timestamped body containing $-sequences with a multi-token template', () => {
    const withTs = { ...spec, timestampHeader: 'X-Ts', toleranceSec: 300, contentTemplate: '{timestamp}.{rawBody}' };
    const t = 1000;
    const trickyBody = 'payload-with-$&-and-$$';
    const signed = 'sha256=' + createHmac('sha256', secret).update(`${t}.${trickyBody}`).digest('hex');
    const r = verifyIngressSignature(withTs, {
      rawBody: trickyBody,
      headers: { 'x-sig': signed, 'x-ts': String(t) },
      secret,
      now: (t + 10) * 1000,
      instanceId,
    });
    expect(r.ok).toBe(true);
  });

  it('accepts scheme "none" without a signature', () => {
    expect(verifyIngressSignature({ scheme: 'none' }, { rawBody, headers: {}, secret, now: 0, instanceId }).ok).toBe(
      true,
    );
  });

  it('fails closed on an empty secret even for a structurally valid HMAC', () => {
    const emptySecretSpec = { scheme: 'hmac-sha256' as const, header: 'x-sig' };
    const digest = createHmac('sha256', '').update('body').digest('hex');
    const out = verifyIngressSignature(emptySecretSpec, {
      rawBody: 'body',
      headers: { 'x-sig': digest },
      secret: '',
      now: 0,
      instanceId,
    });
    expect(out.ok).toBe(false);
  });

  it('accepts a contentTemplate that uses the {id} placeholder (instance id mixed into the signature base)', () => {
    // RED without the {id} substitution: a provider that signs `{id}.{rawBody}` would be silently 401'd
    // because the placeholder is left literal in the signed bytes.
    const withId = {
      ...spec,
      contentTemplate: '{id}.{rawBody}',
    };
    const signed = 'sha256=' + createHmac('sha256', secret).update(`${instanceId}.${rawBody}`).digest('hex');
    const r = verifyIngressSignature(withId, {
      rawBody,
      headers: { 'x-sig': signed },
      secret,
      now: 0,
      instanceId,
    });
    expect(r.ok).toBe(true);

    // A different instance id must NOT verify (the {id} is actually part of the signed material).
    const r2 = verifyIngressSignature(withId, {
      rawBody,
      headers: { 'x-sig': signed },
      secret,
      now: 0,
      instanceId: 'other-inst',
    });
    expect(r2.ok).toBe(false);
  });
});
