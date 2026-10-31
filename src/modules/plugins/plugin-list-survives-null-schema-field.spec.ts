// A plugin manifest is third-party JSON, and nothing validates its configSchema before the loader accepts it:
// seedConfigDefaults already skips a property declared as null. Listing plugins must not fail for every plugin
// because one manifest declares such a property and that plugin's config holds the key.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { PluginsService } from './plugins.service';
import { PluginLoaderService } from '../../core/plugins/plugin-loader.service';
import { PluginStorageService } from '../../core/plugins/plugin-storage.service';
import { HookManager } from '../../core/hooks';

describe('GET /plugins with a manifest whose configSchema declares a property as null', () => {
  let tmpDir: string;
  let config: ConfigService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-nullfield-'));
    config = {
      get: (k: string) => (k === 'dataDir' ? tmpDir : k === 'plugins.dir' ? path.join(tmpDir, 'plugins') : undefined),
    } as unknown as ConfigService;
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const load = (configSchema: Record<string, unknown>) => {
    const dir = path.join(tmpDir, 'plugins', 'relay');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({
        id: 'relay',
        name: 'Relay',
        version: '1.0.0',
        type: 'extension',
        main: 'index.js',
        configSchema,
      }),
    );
    fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = class {};');
    const loader = new PluginLoaderService(
      config,
      new HookManager(),
      new PluginStorageService(config),
      {} as unknown as ModuleRef,
    );
    loader.loadPlugin(dir);
    return { loader, service: new PluginsService(loader, config) };
  };

  it('still lists the plugins, serving the schema without the null property', () => {
    const { loader, service } = load({
      type: 'object',
      properties: { baseUrl: { type: 'string' }, token: { type: 'string', secret: true }, legacy: null },
    });
    // The write an integration instance projection makes (scope-binding.service.ts), which runs no restore.
    loader.updatePluginConfig('relay', { baseUrl: 'https://relay.example', token: 't0k', legacy: 'on' });

    const [relay] = service.findAll();

    expect(relay.configSchema?.properties).toEqual({
      baseUrl: { type: 'string' },
      token: { type: 'string', secret: true },
    });
    // The undescribed key reads like any unknown key; the declared secret stays masked.
    expect(relay.config).toEqual({ baseUrl: 'https://relay.example', token: '***', legacy: 'on' });
    expect(service.findOne('relay').config).toEqual(relay.config);
  });

  it('saves a config that holds the key', () => {
    const { loader, service } = load({
      type: 'object',
      properties: { token: { type: 'string', secret: true }, legacy: null },
    });
    loader.updatePluginConfig('relay', { token: 't0k' });

    expect(service.updateConfig('relay', { token: '***', legacy: 'off' })).toEqual(
      expect.objectContaining({ success: true }),
    );
    expect(loader.getPlugin('relay')?.config).toEqual({ token: 't0k', legacy: 'off' });
  });

  it('lists the plugins when a nested property or an array item is declared as null', () => {
    const { loader, service } = load({
      type: 'object',
      properties: {
        outer: { type: 'object', properties: { key: { type: 'string', secret: true }, inner: null } },
        rows: { type: 'array', items: null },
      },
    });
    loader.updatePluginConfig('relay', { outer: { key: 'k', inner: 'x' }, rows: ['a'] });

    const [relay] = service.findAll();

    expect(relay.configSchema?.properties).toEqual({
      outer: { type: 'object', properties: { key: { type: 'string', secret: true } } },
      rows: { type: 'array' },
    });
    expect(relay.config).toEqual({ outer: { key: '***', inner: 'x' }, rows: ['a'] });
  });
});
