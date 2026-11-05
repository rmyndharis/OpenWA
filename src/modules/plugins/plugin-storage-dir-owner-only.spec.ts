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

const relayPackage = (): Buffer => {
  const zip = new AdmZip();
  zip.addFile(
    'manifest.json',
    Buffer.from(
      JSON.stringify({
        id: 'relay',
        name: 'Relay',
        version: '1.0.0',
        type: 'extension',
        main: 'index.js',
        permissions: ['storage:use'],
      }),
    ),
  );
  zip.addFile('index.js', Buffer.from('module.exports = class {};'));
  return zip.toBuffer();
};

describe('the ctx.storage directory of an installed plugin', () => {
  let tmpDir: string;
  let config: ConfigService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-storage-mode-'));
    config = {
      get: (k: string) => (k === 'dataDir' ? tmpDir : k === 'plugins.dir' ? path.join(tmpDir, 'plugins') : undefined),
    } as unknown as ConfigService;
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('is owner-only once the plugin stores something', async () => {
    const storage = new PluginStorageService(config);
    const loader = new PluginLoaderService(config, new HookManager(), storage, {} as unknown as ModuleRef);
    new PluginsService(loader, config).install({ buffer: relayPackage() });

    // What enabling the plugin builds for it, then a write of a secret it persists.
    await storage.createPluginStorage('relay').set('oauth', { refreshToken: 'r-123' });

    const dir = path.join(tmpDir, 'plugins', 'relay');
    expect(
      fs.statSync(
        path.join(
          dir,
          fs.readdirSync(dir).find(f => f.startsWith('key-'))!,
        ),
      ).mode & 0o777,
    ).toBe(0o600);
    expect((fs.statSync(dir).mode & 0o777).toString(8)).toBe('700');
  });
});
