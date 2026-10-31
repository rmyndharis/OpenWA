// A built-in engine's config is its env-derived blob, and the engine manifests declare no configSchema, so
// GET /plugins masks every value. PUT /plugins/:id/config takes a mask as "unchanged". Sending back what GET
// returned, with one key set, must persist only that key: the env-derived keys have to stay live, so a later
// .env change (a new Chromium path on a new image) still reaches the engine after a restart.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { PluginsService } from './plugins.service';
import { SECRET_SENTINEL } from './redact-config';
import { PluginLoaderService } from '../../core/plugins/plugin-loader.service';
import { PluginStorageService } from '../../core/plugins/plugin-storage.service';
import { PluginType } from '../../core/plugins/plugin.interfaces';
import { HookManager } from '../../core/hooks';

const engine = { id: 'whatsapp-web.js', name: 'WhatsApp Web.js Engine', version: '1.0.0', type: PluginType.ENGINE };

describe('PUT /plugins/:id/config on a built-in engine with the masked config sent back', () => {
  let tmpDir: string;
  let config: ConfigService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-echo-'));
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
    return { loader, service: new PluginsService(loader, config) };
  };

  it('persists only the key the request set, so the env-derived keys follow the next .env', () => {
    const first = boot({ puppeteer: { executablePath: '/old/chromium' }, sessionDataPath: './data/sessions' });
    const shown = first.service.findOne('whatsapp-web.js').config;
    expect(shown.puppeteer).toBe(SECRET_SENTINEL);

    const res = first.service.updateConfig('whatsapp-web.js', { ...shown, operatorKey: 'set' });
    expect(res.success).toBe(true);

    const second = boot({ puppeteer: { executablePath: '/new/chromium' }, sessionDataPath: './data/sessions' });
    expect(second.loader.getPlugin('whatsapp-web.js')?.config).toEqual({
      puppeteer: { executablePath: '/new/chromium' },
      sessionDataPath: './data/sessions',
      operatorKey: 'set',
    });
  });

  it('keeps a key the operator stored earlier when its mask is sent back', () => {
    const first = boot({ puppeteer: { executablePath: '/old/chromium' } });
    first.service.updateConfig('whatsapp-web.js', { puppeteer: { executablePath: '/pinned/chromium' } });
    const shown = first.service.findOne('whatsapp-web.js').config;

    expect(first.service.updateConfig('whatsapp-web.js', { ...shown, operatorKey: 'set' }).success).toBe(true);

    const second = boot({ puppeteer: { executablePath: '/new/chromium' } });
    expect(second.loader.getPlugin('whatsapp-web.js')?.config).toEqual({
      puppeteer: { executablePath: '/pinned/chromium' },
      operatorKey: 'set',
    });
  });

  it('keeps the stored secret of a plugin with a schema when its mask is sent back', () => {
    const pluginsDir = path.join(tmpDir, 'plugins');
    const dir = path.join(pluginsDir, 'relay');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({
        id: 'relay',
        name: 'Relay',
        version: '1.0.0',
        type: 'extension',
        main: 'index.js',
        configSchema: {
          type: 'object',
          properties: { apiKey: { type: 'string', secret: true }, lang: { type: 'string', default: 'en' } },
        },
      }),
    );
    fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = class {};');
    const { loader, service } = boot({});
    loader.loadPlugin(dir);
    service.updateConfig('relay', { apiKey: 'sk-live' });
    const shown = service.findOne('relay').config;
    expect(shown).toEqual({ apiKey: SECRET_SENTINEL, lang: 'en' });

    expect(service.updateConfig('relay', { ...shown, lang: 'de' }).success).toBe(true);

    expect(loader.getPlugin('relay')?.config).toEqual({ apiKey: 'sk-live', lang: 'de' });
    expect(loader.getRegistryEntry('relay')?.config).toEqual({ apiKey: 'sk-live', lang: 'de' });
  });
});
