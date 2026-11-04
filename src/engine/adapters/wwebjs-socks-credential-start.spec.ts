import * as fs from 'fs';
import { Client } from 'whatsapp-web.js';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';

/**
 * Chromium cannot authenticate a SOCKS proxy, so a socks4:// or socks5:// URL with a user name and password launches
 * the browser without them (a proxy that admits the host by IP keeps working). When such a proxy refuses the browser,
 * the start ends in whatsapp-web.js's `auth timeout` (the pinned page boots from the local cache and nothing else
 * loads) or, when the main document itself cannot be fetched, in a Chromium `net::ERR_` navigation error. The reason
 * the session shows says what the URL cannot do next to either, and next to nothing else.
 */
describe('a whatsapp-web.js start through a SOCKS proxy URL that carries credentials', () => {
  const NETWORK_REASON = 'net::ERR_SOCKS_CONNECTION_FAILED at https://web.whatsapp.com/';
  let rmSpy: jest.SpyInstance;
  let clientInitSpy: jest.SpyInstance;
  let savedWebVersion: string | undefined;

  beforeEach(() => {
    savedWebVersion = process.env.WWEBJS_WEB_VERSION;
    process.env.WWEBJS_WEB_VERSION = 'off';
    rmSpy = jest.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);
    clientInitSpy = jest
      .spyOn(Client.prototype as unknown as { initialize: () => Promise<void> }, 'initialize')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    rmSpy.mockRestore();
    clientInitSpy.mockRestore();
    if (savedWebVersion === undefined) delete process.env.WWEBJS_WEB_VERSION;
    else process.env.WWEBJS_WEB_VERSION = savedWebVersion;
  });

  const adapterFor = (url: string): WhatsAppWebJsAdapter =>
    new WhatsAppWebJsAdapter({
      sessionId: 'sess-socks-credentials',
      sessionDataPath: './data/sessions',
      puppeteer: {},
      proxy: { url, type: 'socks5' },
    });

  it('keeps the reason Chromium reported first and says what the credentials cannot do', async () => {
    const failure = new Error(NETWORK_REASON);
    clientInitSpy.mockRejectedValue(failure);
    const adapter = adapterFor('socks5://user:pass@proxy.example.net:1080');
    const onError = jest.fn();

    await expect(adapter.initialize({ onError })).rejects.toBe(failure);

    expect(adapter.getStatus()).toBe(EngineStatus.FAILED);
    expect(onError).toHaveBeenCalledTimes(1);
    const reason = (onError.mock.calls[0] as [string])[0];
    expect(reason.startsWith(NETWORK_REASON)).toBe(true);
    expect(reason).toMatch(/SOCKS proxy/);
    expect(reason).toMatch(/credentials/);
    expect(reason).toMatch(/IP-authorized proxy or an HTTP\/HTTPS proxy/);
    expect(reason).not.toContain('user:pass');
    expect(reason).not.toContain('proxy.example.net');
  });

  // The bare string is what the engine init deadline's mapping to a 504 reads, so it has to stay the thrown value.
  it('says the same when the start ends in the library auth timeout, and throws that string unchanged', async () => {
    clientInitSpy.mockRejectedValue('auth timeout');
    const adapter = adapterFor('socks5://user:pass@proxy.example.net:1080');
    const onError = jest.fn();

    await expect(adapter.initialize({ onError })).rejects.toBe('auth timeout');

    expect(onError).toHaveBeenCalledTimes(1);
    const reason = (onError.mock.calls[0] as [string])[0];
    expect(reason.startsWith('auth timeout ')).toBe(true);
    expect(reason).toMatch(/credentials for a SOCKS proxy/);
    expect(reason).not.toContain('user:pass');
  });

  it('says the same for a socks4 URL', async () => {
    clientInitSpy.mockRejectedValue(new Error(NETWORK_REASON));
    const onError = jest.fn();

    await expect(adapterFor('socks4://user@proxy.example.net:1080').initialize({ onError })).rejects.toThrow(
      NETWORK_REASON,
    );

    expect((onError.mock.calls[0] as [string])[0]).toMatch(/SOCKS proxy/);
  });

  // Nothing here says the proxy refused the browser, so a sentence about the proxy would send the operator the wrong way.
  it.each([
    [
      'a page context destroyed under the inject',
      new Error('Execution context was destroyed, most likely because of a navigation.'),
    ],
    ['the library ready timeout', 'ready timeout'],
    [
      'a browser that did not launch',
      new Error('Failed to launch the browser process! spawn /usr/bin/chromium ENOENT'),
    ],
  ])('adds nothing when the start fails with %s', async (_label, failure) => {
    clientInitSpy.mockRejectedValue(failure);
    const onError = jest.fn();

    await expect(adapterFor('socks5://user:pass@proxy.example.net:1080').initialize({ onError })).rejects.toBe(failure);

    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0] as [string])[0]).not.toMatch(/SOCKS/);
  });

  it.each([
    ['an http proxy with credentials', 'http://user:pass@proxy.example.net:8080'],
    ['a socks proxy without credentials', 'socks5://proxy.example.net:1080'],
  ])('leaves the reason as the engine reported it for %s', async (_label, url) => {
    clientInitSpy.mockRejectedValue(new Error(NETWORK_REASON));
    const onError = jest.fn();

    await expect(adapterFor(url).initialize({ onError })).rejects.toThrow(NETWORK_REASON);

    expect(onError).toHaveBeenCalledWith(NETWORK_REASON);
  });

  it('still launches with the credential-less proxy server and no proxy login', async () => {
    const adapter = adapterFor('socks5://user:pass@proxy.example.net:1080');
    const onError = jest.fn();

    await adapter.initialize({ onError });

    expect(onError).not.toHaveBeenCalled();
    const options = (
      adapter as unknown as { client: { options: { puppeteer: { args: string[] }; proxyAuthentication?: unknown } } }
    ).client.options;
    expect(options.puppeteer.args).toContain('--proxy-server=socks5://proxy.example.net:1080');
    expect(options.puppeteer.args.join(' ')).not.toContain('pass');
    expect(options.proxyAuthentication).toBeUndefined();
  });
});
