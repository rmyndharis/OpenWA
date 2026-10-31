import { bearerToken, presentedApiKey } from './bearer-token';

describe('bearerToken', () => {
  it('reads the token of a Bearer header, the scheme in any case', () => {
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('bearer   abc  ')).toBe('abc');
    expect(bearerToken('BEARER abc')).toBe('abc');
  });

  it.each([undefined, '', 'Basic abc', 'Bearer', 'Bearer two tokens'])('refuses %p', header => {
    expect(bearerToken(header)).toBeUndefined();
  });
});

describe('presentedApiKey', () => {
  it('prefers the X-API-Key header over a Bearer token', () => {
    expect(presentedApiKey({ 'x-api-key': 'from-header', authorization: 'Bearer from-bearer' })).toBe('from-header');
  });

  it('falls back to the Bearer token when the header is absent or empty', () => {
    expect(presentedApiKey({ authorization: 'Bearer from-bearer' })).toBe('from-bearer');
    expect(presentedApiKey({ 'x-api-key': '', authorization: 'Bearer from-bearer' })).toBe('from-bearer');
  });

  it('returns the header as it was sent, whitespace included', () => {
    expect(presentedApiKey({ 'x-api-key': ' key ' })).toBe(' key ');
  });

  it('takes the first value of a repeated header', () => {
    expect(presentedApiKey({ 'x-api-key': ['first', 'second'] })).toBe('first');
    expect(presentedApiKey({ authorization: ['Bearer first', 'Bearer second'] })).toBe('first');
  });

  it('answers nothing when no key is presented or the Authorization header is not a Bearer one', () => {
    expect(presentedApiKey({})).toBeUndefined();
    expect(presentedApiKey({ authorization: 'Basic abc' })).toBeUndefined();
    expect(presentedApiKey({ 'x-api-key': [] })).toBeUndefined();
  });
});
