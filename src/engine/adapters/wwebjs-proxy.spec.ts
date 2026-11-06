import { buildProxyLaunchConfig, bypassServiceWorkerOnLaunch } from './wwebjs-proxy';

describe('buildProxyLaunchConfig credential decoding', () => {
  // A lone `%` used to surface as a bare `URI malformed` that named nothing about the proxy.
  it.each(['http://u:p%zz@proxy:8080', 'socks5://us%er:pass@proxy:1080'])('names the proxy for %s', url => {
    expect(() => buildProxyLaunchConfig(url)).toThrow(
      'The session proxy URL has malformed percent-encoded credentials',
    );
  });

  it('accepts a correctly escaped literal %', () => {
    expect(buildProxyLaunchConfig('http://u:p%25zz@proxy:8080').proxyAuthentication).toEqual({
      username: 'u',
      password: 'p%zz',
    });
  });
});

describe('bypassServiceWorkerOnLaunch', () => {
  const fixture = () => {
    const calls: string[] = [];
    const page = {
      setBypassServiceWorker: jest.fn((bypass: boolean) => {
        calls.push(`bypass:${String(bypass)}`);
        return Promise.resolve();
      }),
    };
    const original = jest.fn(() => {
      calls.push('original');
      return Promise.resolve();
    });
    return { calls, page, original, strategy: { client: { pupPage: page }, afterBrowserInitialized: original } };
  };

  it('turns the service worker off for the page, then runs the hook the strategy already had', async () => {
    const { calls, strategy } = fixture();

    bypassServiceWorkerOnLaunch(strategy);
    await strategy.afterBrowserInitialized();

    expect(calls).toEqual(['bypass:true', 'original']);
  });

  it('runs the original hook with the strategy as its receiver', async () => {
    const seen: unknown[] = [];
    const strategy = {
      client: { pupPage: { setBypassServiceWorker: jest.fn(() => Promise.resolve()) } },
      afterBrowserInitialized(this: unknown) {
        seen.push(this);
        return Promise.resolve();
      },
    };

    bypassServiceWorkerOnLaunch(strategy);
    await strategy.afterBrowserInitialized();

    expect(seen).toEqual([strategy]);
  });

  it('fails the start when the page refuses, without running the original hook', async () => {
    const { page, original, strategy } = fixture();
    page.setBypassServiceWorker.mockRejectedValue(new Error('Target closed'));

    bypassServiceWorkerOnLaunch(strategy);

    await expect(strategy.afterBrowserInitialized()).rejects.toThrow('Target closed');
    expect(original).not.toHaveBeenCalled();
  });

  it('fails the start when there is no page yet, instead of skipping the call', async () => {
    const strategy = { client: {}, afterBrowserInitialized: jest.fn(() => Promise.resolve()) };

    bypassServiceWorkerOnLaunch(strategy);

    await expect(strategy.afterBrowserInitialized()).rejects.toThrow(TypeError);
  });
});
