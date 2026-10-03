import { signXenwaSsoToken, verifyXenwaSsoToken, type XenwaSsoClaims } from './xenwa-sso-token';
import { decryptApiKey, encryptApiKey } from './xenwa-config';
import { addMonth, chargeKeyFor } from './xenwa-billing.service';

const SECRET = 'x'.repeat(48);
const AUD = 'wa.xenaitech.com';
const now = 1_800_000_000;

const claims = (over: Partial<XenwaSsoClaims> = {}): XenwaSsoClaims => ({
  sub: '65f0c0ffee',
  email: 'Owner@Example.com',
  name: 'Owner',
  role: 'client',
  nonce: 'n'.repeat(32),
  iat: now,
  exp: now + 60,
  aud: AUD,
  ...over,
});

describe('XenWA SSO token', () => {
  it('verifies a valid token and lowercases the email', () => {
    const out = verifyXenwaSsoToken(signXenwaSsoToken(claims(), SECRET), SECRET, AUD, now + 5);
    expect(out.sub).toBe('65f0c0ffee');
    expect(out.email).toBe('owner@example.com');
  });

  it('rejects a wrong signature', () => {
    expect(() => verifyXenwaSsoToken(signXenwaSsoToken(claims(), 'y'.repeat(48)), SECRET, AUD, now)).toThrow(/signature/);
  });

  it('rejects a wrong audience', () => {
    expect(() => verifyXenwaSsoToken(signXenwaSsoToken(claims({ aud: 'evil' }), SECRET), SECRET, AUD, now)).toThrow(/audience/);
  });

  it('rejects an expired token', () => {
    expect(() => verifyXenwaSsoToken(signXenwaSsoToken(claims(), SECRET), SECRET, AUD, now + 600)).toThrow(/expired/);
  });

  it('rejects an over-long lifetime', () => {
    expect(() =>
      verifyXenwaSsoToken(signXenwaSsoToken(claims({ exp: now + 3600 }), SECRET), SECRET, AUD, now),
    ).toThrow(/lifetime/);
  });

  it('rejects alg tampering', () => {
    const [, p, s] = signXenwaSsoToken(claims(), SECRET).split('.');
    const none = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    expect(() => verifyXenwaSsoToken(`${none}.${p}.${s}`, SECRET, AUD, now)).toThrow(/algorithm/);
  });

  it('refuses when the secret is too short (SSO off)', () => {
    expect(() => verifyXenwaSsoToken('a.b.c', 'short', AUD, now)).toThrow(/not configured/);
  });
});

describe('XenWA key cipher', () => {
  it('round-trips and fails closed with another secret', () => {
    const enc = encryptApiKey('owa_k1_abc', SECRET);
    expect(decryptApiKey(enc, SECRET)).toBe('owa_k1_abc');
    expect(decryptApiKey(enc, 'z'.repeat(48))).toBeNull();
  });
});

describe('XenWA billing helpers', () => {
  it('addMonth clamps to the end of a shorter month', () => {
    expect(addMonth(new Date('2026-01-31T10:00:00Z')).toISOString()).toBe('2026-02-28T10:00:00.000Z');
  });
  it('charge keys are per number per period month', () => {
    expect(chargeKeyFor('abc', new Date('2026-10-03T00:00:00Z'))).toBe('xenwa:abc:2026-10');
  });
});
