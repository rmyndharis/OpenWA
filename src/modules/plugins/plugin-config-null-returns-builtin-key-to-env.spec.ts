// A built-in engine's config is its env-derived blob with the operator's stored keys laid over it on every boot, so a
// stored key outranks the .env value it names. PUT /plugins/:id/config documents `null` as the way to remove a stored
// value. For a built-in engine, removing the stored key has to hand that key back to its .env value; a stored null that
// outranks .env is a new override, not a removal.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { PluginsService } from './plugins.service';
import { PluginLoaderService } from '../../core/plugins/plugin-loader.service';
import { PluginStorageService } from '../../core/plugins/plugin-storage.service';
import { PluginType } from '../../core/plugins/plugin.interfaces';
import { HookManager } from '../../core/hooks';

const engine = { id: 'whatsapp-web.js', name: 'WhatsApp Web.js Engine', version: '1.0.0', type: PluginType.ENGINE };
const baileys = { id: 'baileys', name: 'Baileys Engine', version: '1.0.0', type: PluginType.ENGINE };

describe('PUT /plugins/:id/config with null on a key stored over a built-in engine .env setting', () => {
  let tmpDir: string;
  let config: ConfigService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-null-'));
    config = {
      get: (k: string) => (k === 'dataDir' ? tmpDir : k === 'plugins.dir' ? path.join(tmpDir, 'plugins') : undefined),
    } as unknown as ConfigService;
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const boot = (envConfig: Record<string, unknown>) => {
    const loader = new PluginLoaderService(
      config,
      new HookManager(),
      new PluginStorageService(config),
      {} as unknown as ModuleRef,
    );
    loader.registerBuiltInPlugin({ ...engine, main: 'index.ts' }, {}, envConfig);
    loader.registerBuiltInPlugin({ ...baileys, main: 'index.ts' }, {}, envConfig);
    return { loader, service: new PluginsService(loader, config) };
  };

  it('hands the key back to the .env value on the next boot', () => {
    const first = boot({ puppeteer: { executablePath: '/usr/bin/chromium' } });
    // An override stored earlier: by an operator, or by an older release that stored a sent-back mask.
    expect(first.service.updateConfig('whatsapp-web.js', { puppeteer: { executablePath: '/old/chromium' } })).toEqual(
      expect.objectContaining({ success: true }),
    );

    const removal = first.service.updateConfig('whatsapp-web.js', { puppeteer: null });
    expect(removal.success).toBe(true);
    expect(first.loader.getRegistryEntry('whatsapp-web.js')?.config).toEqual({});

    const second = boot({ puppeteer: { executablePath: '/usr/lib/chromium/chromium' } });
    expect(second.loader.getPlugin('whatsapp-web.js')?.config.puppeteer).toEqual({
      executablePath: '/usr/lib/chromium/chromium',
    });
  });

  it('leaves the .env value in effect when nothing was stored for the key', () => {
    const first = boot({ puppeteer: { executablePath: '/usr/bin/chromium' } });

    expect(first.service.updateConfig('whatsapp-web.js', { puppeteer: null }).success).toBe(true);

    const second = boot({ puppeteer: { executablePath: '/usr/bin/chromium' } });
    expect(second.loader.getPlugin('whatsapp-web.js')?.config.puppeteer).toEqual({
      executablePath: '/usr/bin/chromium',
    });
  });

  it('puts the .env value back into the running config at once and keeps the other stored keys', () => {
    const { loader, service } = boot({
      puppeteer: { executablePath: '/usr/bin/chromium' },
      sessionDataPath: './data/sessions',
    });
    service.updateConfig('whatsapp-web.js', {
      puppeteer: { executablePath: '/old/chromium' },
      sessionDataPath: '/srv/sessions',
    });

    service.updateConfig('whatsapp-web.js', { puppeteer: null });

    expect(loader.getPlugin('whatsapp-web.js')?.config).toEqual({
      puppeteer: { executablePath: '/usr/bin/chromium' },
      sessionDataPath: '/srv/sessions',
    });
    expect(loader.getRegistryEntry('whatsapp-web.js')?.config).toEqual({ sessionDataPath: '/srv/sessions' });
  });

  it('drops a key that has no .env value from the running and the stored config', () => {
    const { loader, service } = boot({ puppeteer: { executablePath: '/usr/bin/chromium' } });
    service.updateConfig('whatsapp-web.js', { extra: 'x' });

    service.updateConfig('whatsapp-web.js', { extra: null });

    expect(loader.getPlugin('whatsapp-web.js')?.config).toEqual({ puppeteer: { executablePath: '/usr/bin/chromium' } });
    expect(loader.getRegistryEntry('whatsapp-web.js')?.config).toEqual({});
  });

  it('removes a stored key of the other built-in engine the same way', () => {
    const { loader, service } = boot({ baileys: { authDir: './data/baileys' } });
    service.updateConfig('baileys', { baileys: { authDir: '/old/baileys' } });

    service.updateConfig('baileys', { baileys: null });

    expect(loader.getPlugin('baileys')?.config.baileys).toEqual({ authDir: './data/baileys' });
    expect(loader.getRegistryEntry('baileys')?.config).toEqual({});
  });

  it('still stores a null sent for an extension plugin', () => {
    const dir = path.join(tmpDir, 'plugins', 'relay');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ id: 'relay', name: 'Relay', version: '1.0.0', type: 'extension', main: 'index.js' }),
    );
    fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = class {};');
    const { loader } = boot({});
    loader.loadPlugin(dir);
    loader.updatePluginConfig('relay', { apiKey: 'k', url: 'https://relay.example' });

    loader.updatePluginConfig('relay', { apiKey: null });

    expect(loader.getRegistryEntry('relay')?.config).toEqual({ apiKey: null, url: 'https://relay.example' });
    expect(loader.getPlugin('relay')?.config).toEqual({ apiKey: null, url: 'https://relay.example' });
  });
});
