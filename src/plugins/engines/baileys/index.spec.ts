import type { PluginContext } from '../../../core/plugins';

jest.mock('../../../engine/adapters/baileys.adapter', () => ({
  BaileysAdapter: jest.fn().mockImplementation((config: unknown) => ({ config })),
}));

import { BaileysPlugin } from './index';
import { BaileysAdapter } from '../../../engine/adapters/baileys.adapter';

describe('BaileysPlugin.createEngine (opaque config)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reads authDir from context.config.baileys and passes neutral per-call fields', () => {
    const plugin = new BaileysPlugin();
    void plugin.onLoad({
      config: { baileys: { authDir: '/data/baileys' } },
      logger: { log: jest.fn() },
    } as unknown as PluginContext);

    plugin.createEngine({ sessionId: 'sess-1', dbSessionId: 'db-1', proxyUrl: 'http://p', proxyType: 'http' });

    expect(BaileysAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-1',
        dbSessionId: 'db-1',
        authDir: '/data/baileys',
        proxyUrl: 'http://p',
        proxyType: 'http',
      }),
    );
  });

  it('falls back to the default authDir when context has no baileys config', () => {
    const plugin = new BaileysPlugin();
    plugin.createEngine({ sessionId: 'sess-2' });
    expect(BaileysAdapter).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-2', authDir: './data/baileys' }),
    );
  });

  it('advertises the slice-3b supported feature set', () => {
    expect(new BaileysPlugin().getFeatures()).toEqual([
      'text-messages',
      'typing-indicator',
      'media-messages',
      'location-messages',
      'contact-messages',
      'message-replies',
      'message-forwarding',
      'message-reactions',
      'message-deletion',
      'group-management',
      'read-receipts',
    ]);
  });

  it('reports the baileys library name', () => {
    expect(new BaileysPlugin().getEngineLibrary().name).toBe('@whiskeysockets/baileys');
  });

  it('passes the message store to the adapter', () => {
    const store = { put: jest.fn(), getMessage: jest.fn(), clearSession: jest.fn() };
    const plugin = new BaileysPlugin(store);
    plugin.createEngine({ sessionId: 'sess-1' });
    expect(BaileysAdapter).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-1', messageStore: store }));
  });

  it('Uses the constructor-supplied engine config when onLoad never ran (enable-failure path)', () => {
    const plugin = new BaileysPlugin(undefined, { baileys: { authDir: '/op/baileys' } });
    plugin.createEngine({ sessionId: 'sess-3' });
    expect(BaileysAdapter).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-3', authDir: '/op/baileys' }),
    );
  });

  it('Prefers context.config over the constructor blob on the healthy enable path', () => {
    const plugin = new BaileysPlugin(undefined, { baileys: { authDir: '/ctor/baileys' } });
    void plugin.onLoad({
      config: { baileys: { authDir: '/context/baileys' } },
      logger: { log: jest.fn() },
    } as unknown as PluginContext);
    plugin.createEngine({ sessionId: 'sess-4' });
    expect(BaileysAdapter).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-4', authDir: '/context/baileys' }),
    );
  });
});
