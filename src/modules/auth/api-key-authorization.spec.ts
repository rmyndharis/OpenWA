import { apiKeyAuthorizationFingerprint, apiKeyExpiryTime } from './api-key-authorization';
import { ApiKeyRole } from './entities/api-key.entity';

describe('apiKeyExpiryTime', () => {
  it.each([null, undefined])('reads %s as no expiry', value => {
    expect(apiKeyExpiryTime(value)).toBeNull();
  });

  it.each([new Date(123_456), '1970-01-01T00:02:03.456Z'])('reads the instant of %s', value => {
    expect(apiKeyExpiryTime(value)).toBe(123_456);
  });

  // REST refuses a key whose stored expiry is an Invalid Date (validateApiKey), so the socket sweep that
  // reads the same value must not mistake it for a key that never expires.
  it.each([new Date('not-a-date'), 'not-a-date'])('reads the unparseable expiry %s as already expired', value => {
    expect(apiKeyExpiryTime(value)).toBe(0);
  });
});

describe('apiKeyAuthorizationFingerprint', () => {
  const unscoped = { role: ApiKeyRole.OPERATOR, allowedIps: null, allowedSessions: null, allowedChats: null };

  it('tells an unparseable expiry from no expiry', () => {
    const open = apiKeyAuthorizationFingerprint({ ...unscoped, expiresAt: null });
    const broken = apiKeyAuthorizationFingerprint({ ...unscoped, expiresAt: new Date('not-a-date') });
    expect(open).toBe('["operator",null,null,null,null]');
    expect(broken).toBe('["operator",null,null,null,0]');
  });
});
