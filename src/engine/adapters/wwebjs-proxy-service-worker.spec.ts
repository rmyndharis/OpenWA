import * as fs from 'fs';
import { Client } from 'whatsapp-web.js';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';

/**
 * A proxy that asks for a username and password is answered by `page.authenticate()`, which covers the page's own
 * requests only. A service worker WhatsApp Web registered in the saved profile takes the next start's navigation out
 * of that reach, so the page ignores it for a session whose proxy has credentials (#819).
 */
describe('a whatsapp-web.js start through a proxy URL', () => {
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

  type Launched = {
    client: { authStrategy: { afterBrowserInitialized: () => Promise<void> }; pupPage?: unknown };
  };

  // Runs the hook the library calls once the page exists, with a page that records the call.
  const afterLaunch = async (proxy?: { url: string; type: 'http' | 'socks5' }): Promise<jest.Mock> => {
    const adapter = new WhatsAppWebJsAdapter({
      sessionId: 'sess-proxy-sw',
      sessionDataPath: './data/sessions',
      puppeteer: {},
      ...(proxy ? { proxy } : {}),
    });
    await adapter.initialize({ onError: jest.fn() });
    const { client } = adapter as unknown as Launched;
    const setBypassServiceWorker = jest.fn(() => Promise.resolve());
    client.pupPage = { setBypassServiceWorker };
    await client.authStrategy.afterBrowserInitialized();
    return setBypassServiceWorker;
  };

  it('has the page ignore the service worker when the proxy has credentials', async () => {
    const setBypassServiceWorker = await afterLaunch({ url: 'http://user:pass@proxy.example.net:8080', type: 'http' });

    expect(setBypassServiceWorker).toHaveBeenCalledTimes(1);
    expect(setBypassServiceWorker).toHaveBeenCalledWith(true);
  });

  it.each([
    ['an http proxy without credentials', { url: 'http://proxy.example.net:8080', type: 'http' as const }],
    [
      'a socks proxy with credentials, which Chromium cannot log in to',
      { url: 'socks5://user:pass@proxy.example.net:1080', type: 'socks5' as const },
    ],
    ['no proxy', undefined],
  ])('leaves the service worker alone for %s', async (_label, proxy) => {
    const setBypassServiceWorker = await afterLaunch(proxy);

    expect(setBypassServiceWorker).not.toHaveBeenCalled();
  });
});
