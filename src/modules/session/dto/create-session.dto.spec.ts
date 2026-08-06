import { validateSync } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateSessionDto } from './create-session.dto';

describe('CreateSessionDto proxyUrl validation', () => {
  const errs = (proxyUrl: string): ReturnType<typeof validateSync> =>
    validateSync(plainToInstance(CreateSessionDto, { name: 'my-bot', proxyUrl }));

  it.each([
    'http://proxy.example.com:8080',
    'http://user:pass@proxy.example.com:8080',
    'https://proxy.example.com:8443',
    'socks5://proxy.example.com:1080',
    'socks4://proxy.example.com:1080',
    // Single-label hosts are common in containerized setups (e.g. a `squid` service) — must validate.
    'http://localhost:8080',
    'http://squid:3128',
    'socks5://proxy:1080',
    'http://10.0.0.1:8080',
  ])('accepts a valid proxy URL: %s', url => {
    expect(errs(url)).toHaveLength(0);
  });

  it.each([
    'not a url',
    'proxy.example.com:8080', // no scheme
    'ftp://proxy.example.com:21', // unsupported scheme
    'javascript:alert(1)',
  ])('rejects an invalid / non-proxy-scheme proxyUrl: %s', url => {
    expect(errs(url).length).toBeGreaterThan(0);
  });

  it('allows an omitted proxyUrl (optional)', () => {
    expect(validateSync(plainToInstance(CreateSessionDto, { name: 'my-bot' }))).toHaveLength(0);
  });
});
