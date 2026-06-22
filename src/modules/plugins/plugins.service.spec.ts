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

const manifest = { id: 'svc-plg', name: 'Svc Plugin', version: '1.0.0', type: 'extension', main: 'index.js' };

function pkg(over: Record<string, unknown> = {}): Buffer {
  const z = new AdmZip();
  z.addFile('manifest.json', Buffer.from(JSON.stringify({ ...manifest, ...over })));
  z.addFile('index.js', Buffer.from('module.exports = class {};'));
  return z.toBuffer();
}

describe('PluginsService — install / uninstall (real loader + disk)', () => {
  let tmpDir: string;
  let pluginsDir: string;
  let loader: PluginLoaderService;
  let service: PluginsService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-svc-'));
    pluginsDir = path.join(tmpDir, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    const config = {
      get: (k: string) => (k === 'plugins.dir' ? pluginsDir : k === 'dataDir' ? tmpDir : undefined),
    } as unknown as ConfigService;
    loader = new PluginLoaderService(
      config,
      new HookManager(),
      new PluginStorageService(config),
      {} as unknown as ModuleRef,
    );
    service = new PluginsService(loader);
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('installs a valid package — writes the files, loads it, reports builtIn:false', () => {
    const dto = service.install({ buffer: pkg() });

    expect(dto.id).toBe('svc-plg');
    expect(dto.status).toBe('installed');
    expect(dto.builtIn).toBe(false);
    expect(fs.existsSync(path.join(pluginsDir, 'svc-plg', 'index.js'))).toBe(true);
    expect(loader.getPlugin('svc-plg')).toBeDefined();
  });

  it('rejects an empty upload', () => {
    expect(() => service.install({ buffer: Buffer.alloc(0) })).toThrow(/no plugin file/i);
  });

  it('rejects a duplicate install (already installed)', () => {
    service.install({ buffer: pkg() });
    expect(() => service.install({ buffer: pkg() })).toThrow(/already installed/i);
  });

  it('does not leave a directory behind when the package is invalid', () => {
    // Reserved id is rejected by the parser before anything is written.
    expect(() => service.install({ buffer: pkg({ id: 'baileys' }) })).toThrow(/reserved/i);
    expect(fs.existsSync(path.join(pluginsDir, 'baileys'))).toBe(false);
  });

  it('uninstalls a user plugin — removes its files, registry entry, and runtime instance', async () => {
    service.install({ buffer: pkg() });

    const res = await service.uninstall('svc-plg');

    expect(res.success).toBe(true);
    expect(fs.existsSync(path.join(pluginsDir, 'svc-plg'))).toBe(false);
    expect(loader.getPlugin('svc-plg')).toBeUndefined();
  });

  it('uninstalling an unknown plugin throws NotFound', async () => {
    await expect(service.uninstall('nope')).rejects.toThrow(/not found/i);
  });
});
