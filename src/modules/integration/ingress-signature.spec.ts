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

  // --- default replay window (declared timestampHeader, no toleranceSec) ---
  describe('declared timestampHeader without toleranceSec (host default window)', () => {
    const original = process.env.INGRESS_TIMESTAMP_TOLERANCE_SEC;
    afterEach(() => {
      if (original === undefined) delete process.env.INGRESS_TIMESTAMP_TOLERANCE_SEC;
      else process.env.INGRESS_TIMESTAMP_TOLERANCE_SEC = original;
    });

    const tsSpec = { ...spec, timestampHeader: 'X-Ts', contentTemplate: '{timestamp}.{rawBody}' };
    const signAt = (t: number) => 'sha256=' + createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');

    it('rejects a stale timestamp against the 300s default (previously an always-401 trap)', () => {
      delete process.env.INGRESS_TIMESTAMP_TOLERANCE_SEC;
      const t = 1000;
      const r = verifyIngressSignature(tsSpec, {
        rawBody,
        headers: { 'x-sig': signAt(t), 'x-ts': String(t) },
        secret,
        now: (t + 301) * 1000,
        instanceId,
      });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/replay|tolerance/i);
    });

    it('accepts a fresh timestamp within the 300s default', () => {
      delete process.env.INGRESS_TIMESTAMP_TOLERANCE_SEC;
      const t = 1000;
      const r = verifyIngressSignature(tsSpec, {
        rawBody,
        headers: { 'x-sig': signAt(t), 'x-ts': String(t) },
        secret,
        now: (t + 10) * 1000,
        instanceId,
      });
      expect(r.ok).toBe(true);
    });

    it('honors INGRESS_TIMESTAMP_TOLERANCE_SEC when the manifest declares no toleranceSec', () => {
      process.env.INGRESS_TIMESTAMP_TOLERANCE_SEC = '10';
      const t = 1000;
      const stale = verifyIngressSignature(tsSpec, {
        rawBody,
        headers: { 'x-sig': signAt(t), 'x-ts': String(t) },
        secret,
        now: (t + 11) * 1000,
        instanceId,
      });
      expect(stale.ok).toBe(false);
      const fresh = verifyIngressSignature(tsSpec, {
        rawBody,
        headers: { 'x-sig': signAt(t), 'x-ts': String(t) },
        secret,
        now: (t + 10) * 1000,
        instanceId,
      });
      expect(fresh.ok).toBe(true);
    });

    it('lets a declared toleranceSec win over the env default', () => {
      process.env.INGRESS_TIMESTAMP_TOLERANCE_SEC = '10';
      const declared = { ...tsSpec, toleranceSec: 300 };
      const t = 1000;
      const r = verifyIngressSignature(declared, {
        rawBody,
        headers: { 'x-sig': signAt(t), 'x-ts': String(t) },
        secret,
        now: (t + 60) * 1000,
        instanceId,
      });
      expect(r.ok).toBe(true);
    });

    it('falls back to the 300s default when the env value is invalid', () => {
      process.env.INGRESS_TIMESTAMP_TOLERANCE_SEC = '0'; // a zero window would reject every delivery
      const t = 1000;
      const r = verifyIngressSignature(tsSpec, {
        rawBody,
        headers: { 'x-sig': signAt(t), 'x-ts': String(t) },
        secret,
        now: (t + 60) * 1000,
        instanceId,
      });
      expect(r.ok).toBe(true);
    });

    it('enforces freshness for shared-secret routes that declare a timestampHeader', () => {
      delete process.env.INGRESS_TIMESTAMP_TOLERANCE_SEC;
      const sharedSpec = { scheme: 'shared-secret' as const, header: 'X-Token', timestampHeader: 'X-Ts' };
      const t = 1000;
      const fresh = verifyIngressSignature(sharedSpec, {
        rawBody,
        headers: { 'x-token': secret, 'x-ts': String(t) },
        secret,
        now: (t + 10) * 1000,
        instanceId,
      });
      expect(fresh.ok).toBe(true);
      const stale = verifyIngressSignature(sharedSpec, {
        rawBody,
        headers: { 'x-token': secret, 'x-ts': String(t) },
        secret,
        now: (t + 301) * 1000,
        instanceId,
      });
      expect(stale.ok).toBe(false);
    });

    it('applies the env default to standard-webhooks when toleranceSec is undeclared', () => {
      process.env.INGRESS_TIMESTAMP_TOLERANCE_SEC = '10';
      const key = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
      const swSecretLocal = 'v1,whsec_' + key.toString('base64');
      const signSw = (id: string, t: number, body: string) =>
        'v1,' + createHmac('sha256', key).update(`${id}.${t}.${body}`).digest('base64');
      const r = verifyIngressSignature(
        { scheme: 'standard-webhooks' as const },
        {
          rawBody,
          headers: {
            'webhook-id': 'msg_1',
            'webhook-timestamp': '1000',
            'webhook-signature': signSw('msg_1', 1000, rawBody),
          },
          secret: swSecretLocal,
          now: (1000 + 11) * 1000,
          instanceId,
        },
      );
      expect(r.ok).toBe(false);
    });
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

  // --- standard-webhooks (Standard Webhooks spec; ported from supabase-otp-hook/verify.ts) ---
  const swRawKey = Buffer.from('0123456789abcdef0123456789abcdef', 'hex'); // 32 raw bytes
  const swSecret = 'v1,whsec_' + swRawKey.toString('base64');
  const swSign = (id: string, ts: number, body: string) =>
    'v1,' + createHmac('sha256', swRawKey).update(`${id}.${ts}.${body}`).digest('base64');
  const swSpec = { scheme: 'standard-webhooks' as const };

  it('standard-webhooks: accepts a correctly-signed request', () => {
    const r = verifyIngressSignature(swSpec, {
      rawBody,
      headers: {
        'webhook-id': 'msg_1',
        'webhook-timestamp': '1000',
        'webhook-signature': swSign('msg_1', 1000, rawBody),
      },
      secret: swSecret,
      now: 1000 * 1000,
      instanceId,
    });
    expect(r.ok).toBe(true);
  });

  it('standard-webhooks: rejects a tampered body', () => {
    const r = verifyIngressSignature(swSpec, {
      rawBody: rawBody + ' ',
      headers: {
        'webhook-id': 'msg_1',
        'webhook-timestamp': '1000',
        'webhook-signature': swSign('msg_1', 1000, rawBody),
      },
      secret: swSecret,
      now: 1000 * 1000,
      instanceId,
    });
    expect(r.ok).toBe(false);
  });

  it('standard-webhooks: rejects a wrong key (different secret)', () => {
    const otherKey = Buffer.alloc(32, 1);
    const otherSecret = 'v1,whsec_' + otherKey.toString('base64');
    const r = verifyIngressSignature(swSpec, {
      rawBody,
      headers: {
        'webhook-id': 'msg_1',
        'webhook-timestamp': '1000',
        'webhook-signature': swSign('msg_1', 1000, rawBody),
      },
      secret: otherSecret,
      now: 1000 * 1000,
      instanceId,
    });
    expect(r.ok).toBe(false);
  });

  it('standard-webhooks: rejects a wrong webhook-id', () => {
    const r = verifyIngressSignature(swSpec, {
      rawBody,
      headers: {
        'webhook-id': 'msg_2',
        'webhook-timestamp': '1000',
        'webhook-signature': swSign('msg_1', 1000, rawBody),
      },
      secret: swSecret,
      now: 1000 * 1000,
      instanceId,
    });
    expect(r.ok).toBe(false);
  });

  it('standard-webhooks: rejects a stale timestamp beyond tolerance (default 300s)', () => {
    const r = verifyIngressSignature(swSpec, {
      rawBody,
      headers: {
        'webhook-id': 'msg_1',
        'webhook-timestamp': '1000',
        'webhook-signature': swSign('msg_1', 1000, rawBody),
      },
      secret: swSecret,
      now: (1000 + 301) * 1000,
      instanceId,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/replay|tolerance/i);
  });

  it('standard-webhooks: honors a declared toleranceSec', () => {
    const r = verifyIngressSignature(
      { scheme: 'standard-webhooks' as const, toleranceSec: 10 },
      {
        rawBody,
        headers: {
          'webhook-id': 'msg_1',
          'webhook-timestamp': '1000',
          'webhook-signature': swSign('msg_1', 1000, rawBody),
        },
        secret: swSecret,
        now: (1000 + 11) * 1000,
        instanceId,
      },
    );
    expect(r.ok).toBe(false);
  });

  it('standard-webhooks: accepts a candidate list with a bogus and a valid v1, candidate', () => {
    const good = swSign('msg_1', 1000, rawBody);
    const sigHeader = `v1,deadbeef= v1,${good.slice(3)}`; // bogus candidate first, then the valid one
    const r = verifyIngressSignature(swSpec, {
      rawBody,
      headers: { 'webhook-id': 'msg_1', 'webhook-timestamp': '1000', 'webhook-signature': sigHeader },
      secret: swSecret,
      now: 1000 * 1000,
      instanceId,
    });
    expect(r.ok).toBe(true);
  });

  it('standard-webhooks: rejects when the secret is prefix-only (decodes to an empty key)', () => {
    const r = verifyIngressSignature(swSpec, {
      rawBody,
      headers: {
        'webhook-id': 'msg_1',
        'webhook-timestamp': '1000',
        'webhook-signature': swSign('msg_1', 1000, rawBody),
      },
      secret: 'v1,whsec_',
      now: 1000 * 1000,
      instanceId,
    });
    expect(r.ok).toBe(false);
  });

  it('standard-webhooks: rejects when a required header is missing', () => {
    const r = verifyIngressSignature(swSpec, {
      rawBody,
      headers: { 'webhook-id': 'msg_1', 'webhook-timestamp': '1000' }, // no webhook-signature
      secret: swSecret,
      now: 1000 * 1000,
      instanceId,
    });
    expect(r.ok).toBe(false);
  });
});
