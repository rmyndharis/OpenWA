import { resolveBindHost, resolvePublicUrl } from './bind-host';

describe('HTTP bind host', () => {
  it('keeps development local by default', () => {
    expect(resolveBindHost(undefined, undefined)).toBe('127.0.0.1');
    expect(resolveBindHost('development', undefined)).toBe('127.0.0.1');
  });

  it('exposes production on the network by default', () => {
    expect(resolveBindHost('production', undefined)).toBe('0.0.0.0');
  });

  it('honors an explicit bind host for containers and advanced setups', () => {
    expect(resolveBindHost('development', '0.0.0.0')).toBe('0.0.0.0');
    expect(resolveBindHost('production', '192.168.1.20')).toBe('192.168.1.20');
  });

  it('uses localhost in development and the configured public URL in production', () => {
    expect(resolvePublicUrl('development', 'http://192.168.1.20:2785', 2785)).toBe('http://localhost:2785');
    expect(resolvePublicUrl('production', 'http://192.168.1.20:2785/', 2785)).toBe('http://192.168.1.20:2785');
  });
});
