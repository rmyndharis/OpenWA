// A plugin manifest is third-party JSON. The dashboard renders its description, provides tags and localized
// name and description as React children on every plugin card, and an object there takes down the whole
// Plugins page, the page an operator would disable or uninstall the plugin from.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { PluginsService } from './plugins.service';
import { PluginLoaderService } from '../../core/plugins/plugin-loader.service';
import { PluginStorageService } from '../../core/plugins/plugin-storage.service';
import { HookManager } from '../../core/hooks';

describe('GET /plugins with a manifest whose display text is not text', () => {
  let tmpDir: string;
  let config: ConfigService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-displaytext-'));
    config = {
      get: (k: string) => (k === 'dataDir' ? tmpDir : k === 'plugins.dir' ? path.join(tmpDir, 'plugins') : undefined),
    } as unknown as ConfigService;
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const load = (fields: Record<string, unknown>) => {
    const dir = path.join(tmpDir, 'plugins', 'relay');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ id: 'relay', name: 'Relay', version: '1.0.0', type: 'extension', main: 'index.js', ...fields }),
    );
    fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = class {};');
    const loader = new PluginLoaderService(
      config,
      new HookManager(),
      new PluginStorageService(config),
      {} as unknown as ModuleRef,
    );
    loader.loadPlugin(dir);
    return new PluginsService(loader, config);
  };

  it('serves only the text, keeping every well-formed field', () => {
    const service = load({
      description: { en: 'Relay' },
      author: 'Acme',
      provides: ['relay', { kind: 'sms' }, 5],
      i18n: {
        es: {
          name: { text: 'Retransmisor' },
          description: 'Retransmite mensajes',
          config: { baseUrl: { title: { text: 'URL' }, description: 'La URL base' }, token: 'not-a-field' },
        },
        fr: 'not-a-locale',
        de: { name: 'Weiterleitung', config: 'not-a-map' },
      },
    });

    const [relay] = service.findAll();

    expect(relay.description).toBeUndefined();
    expect(relay.author).toBe('Acme');
    expect(relay.provides).toEqual(['relay']);
    expect(relay.i18n).toEqual({
      es: {
        description: 'Retransmite mensajes',
        config: { baseUrl: { description: 'La URL base' }, token: 'not-a-field' },
      },
      fr: 'not-a-locale',
      de: { name: 'Weiterleitung', config: 'not-a-map' },
    });
    expect(service.findOne('relay')).toEqual(relay);
  });

  it('serves no tags for a provides that is not a list, and leaves text fields as they are', () => {
    const service = load({ description: 'Relays messages', author: { name: 'Acme' }, provides: 'relay' });

    const [relay] = service.findAll();

    expect(relay.description).toBe('Relays messages');
    expect(relay.author).toBeUndefined();
    expect(relay.provides).toEqual([]);
  });
});
