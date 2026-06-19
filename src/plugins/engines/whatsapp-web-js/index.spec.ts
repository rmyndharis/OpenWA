jest.mock('../../../engine/adapters/whatsapp-web-js.adapter', () => ({
  WhatsAppWebJsAdapter: jest.fn().mockImplementation((config: unknown) => ({ config })),
}));

import { WhatsAppWebJsPlugin } from './index';
import { WhatsAppWebJsAdapter } from '../../../engine/adapters/whatsapp-web-js.adapter';
import { PluginContext } from '../../../core/plugins';

describe('WhatsAppWebJsPlugin.createEngine (opaque config)', () => {
  beforeEach(() => {
    (WhatsAppWebJsAdapter as unknown as jest.Mock).mockClear();
  });

  function withContext(plugin: WhatsAppWebJsPlugin, config: Record<string, unknown>): void {
    // onLoad sets this.context synchronously; the returned promise can be ignored here.
    void plugin.onLoad({ config, logger: { log: jest.fn() } } as unknown as PluginContext);
  }

  it('reads browser config from context.config (the opaque engine blob), not per-call', () => {
    const plugin = new WhatsAppWebJsPlugin();
    withContext(plugin, {
      sessionDataPath: '/data/sessions',
      puppeteer: { headless: false, args: ['--single-process'], executablePath: '/usr/bin/chromium' },
    });

    plugin.createEngine({ sessionId: 'sess-1', proxyUrl: 'http://p', proxyType: 'http' });

    expect(WhatsAppWebJsAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-1',
        sessionDataPath: '/data/sessions',
        puppeteer: { headless: false, args: ['--single-process'], executablePath: '/usr/bin/chromium' },
        proxy: { url: 'http://p', type: 'http' },
      }),
    );
  });

  it('falls back to safe defaults when context has no config', () => {
    const plugin = new WhatsAppWebJsPlugin();

    plugin.createEngine({ sessionId: 'sess-2' });

    expect(WhatsAppWebJsAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-2',
        sessionDataPath: './data/sessions',
        puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'], executablePath: undefined },
      }),
    );
  });

  it('Uses the constructor-supplied engine config when onLoad never ran (enable-failure path)', () => {
    // EngineFactory now also passes the engine blob at construction. If enablePlugin fails before
    // onLoad runs, this.context is never set — the ctor blob must still supply operator config
    // instead of silently degrading to defaults (which dropped sessionDataPath/executablePath).
    const plugin = new WhatsAppWebJsPlugin({
      sessionDataPath: '/op/sessions',
      puppeteer: { headless: false, args: ['--flag'], executablePath: '/usr/bin/chromium' },
    });

    plugin.createEngine({ sessionId: 'sess-3' });

    expect(WhatsAppWebJsAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-3',
        sessionDataPath: '/op/sessions',
        puppeteer: { headless: false, args: ['--flag'], executablePath: '/usr/bin/chromium' },
      }),
    );
  });

  it('Prefers context.config over the constructor blob on the healthy enable path', () => {
    const plugin = new WhatsAppWebJsPlugin({ sessionDataPath: '/ctor/path' });
    withContext(plugin, { sessionDataPath: '/context/path' });

    plugin.createEngine({ sessionId: 'sess-4' });

    expect(WhatsAppWebJsAdapter).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-4', sessionDataPath: '/context/path' }),
    );
  });
});
