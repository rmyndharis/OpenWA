import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { PluginsService } from './plugins.service';
import { PluginLoaderService } from '../../core/plugins/plugin-loader.service';
import { PluginStorageService } from '../../core/plugins/plugin-storage.service';
import { HookManager } from '../../core/hooks';

const packageOf = (version: string, intervalDefault: number): Buffer => {
  const zip = new AdmZip();
  zip.addFile(
    'manifest.json',
    Buffer.from(
      JSON.stringify({
        id: 'poller',
        name: 'Poller',
        version,
        type: 'extension',
        main: 'index.js',
        configSchema: {
          type: 'object',
          properties: {
            interval: { type: 'number', title: 'Poll interval (s)', default: intervalDefault },
            apiKey: { type: 'string', title: 'API key', secret: true },
          },
        },
      }),
    ),
  );
  zip.addFile('index.js', Buffer.from('module.exports = class {};'));
  return zip.toBuffer();
};

describe('updating a plugin whose schema default changed', () => {
  let tmpDir: string;
  let config: ConfigService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-default-'));
    config = {
      get: (k: string) => (k === 'dataDir' ? tmpDir : k === 'plugins.dir' ? path.join(tmpDir, 'plugins') : undefined),
    } as unknown as ConfigService;
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const boot = () => {
    const loader = new PluginLoaderService(config, new HookManager(), new PluginStorageService(config), {
      get: () => undefined,
    } as unknown as ModuleRef);
    loader.onModuleInit();
    return { loader, service: new PluginsService(loader, config) };
  };

  it('keeps a persisted default when the new version changes its schema default', async () => {
    const { loader, service } = boot();
    service.install({ buffer: packageOf('1.0.0', 60) });
    expect(service.updateConfig('poller', { apiKey: 'k-123' }).success).toBe(true);

    await service.updatePackage('poller', packageOf('2.0.0', 300));

    expect(loader.getPlugin('poller')?.manifest.version).toBe('2.0.0');
    expect(loader.getPlugin('poller')?.config).toEqual({ interval: 60, apiKey: 'k-123' });
  });

  it('keeps the persisted default after a restart too', async () => {
    const first = boot();
    first.service.install({ buffer: packageOf('1.0.0', 60) });
    first.service.updateConfig('poller', { apiKey: 'k-123' });
    await first.service.updatePackage('poller', packageOf('2.0.0', 300));

    const second = boot();

    expect(second.loader.getPlugin('poller')?.config).toEqual({ interval: 60, apiKey: 'k-123' });
  });

  it('keeps a value the operator set for that field', async () => {
    const { loader, service } = boot();
    service.install({ buffer: packageOf('1.0.0', 60) });
    service.updateConfig('poller', { interval: 45, apiKey: 'k-123' });

    await service.updatePackage('poller', packageOf('2.0.0', 300));

    expect(loader.getPlugin('poller')?.config).toEqual({ interval: 45, apiKey: 'k-123' });
  });

  it('keeps an explicitly saved value equal to the previous default', async () => {
    const { loader, service } = boot();
    service.install({ buffer: packageOf('1.0.0', 60) });
    service.updateConfig('poller', { interval: 60, apiKey: 'k-123' });
    await service.updatePackage('poller', packageOf('2.0.0', 300));
    expect(loader.getPlugin('poller')?.config).toEqual({ interval: 60, apiKey: 'k-123' });
  });

  it('seeds the current default for a fresh install', () => {
    const { loader, service } = boot();
    service.install({ buffer: packageOf('2.0.0', 300) });
    expect(loader.getPlugin('poller')?.config).toEqual({ interval: 300 });
  });
});
