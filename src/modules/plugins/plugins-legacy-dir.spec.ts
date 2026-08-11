import AdmZip from 'adm-zip';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { PluginLoaderService } from '../../core/plugins/plugin-loader.service';
import { PluginStorageService } from '../../core/plugins/plugin-storage.service';
import { HookManager } from '../../core/hooks';
import { PluginType, type PluginManifest } from '../../core/plugins/plugin.interfaces';
import { PluginsService } from './plugins.service';

/**
 * The service half of the same defect: a package the loader found in the legacy plugins directory
 * had its config UI read, and its in-place update staged, under the CONFIGURED directory — where it
 * is not. The config UI answered 404; the update renamed a directory that did not exist, after
 * unloadPlugin had already dropped the plugin from the runtime.
 */

const manifest: PluginManifest = {
  id: 'legacy-plg',
  name: 'Legacy Plugin',
  version: '1.0.0',
  type: PluginType.EXTENSION,
  main: 'index.js',
  configUi: { entry: 'ui.html' },
};

const zipOf = (files: Record<string, string>): Buffer => {
  const z = new AdmZip();
  for (const [name, content] of Object.entries(files)) z.addFile(name, Buffer.from(content));
  return z.toBuffer();
};

describe('PluginsService — a plugin loaded from the legacy plugins directory', () => {
  let tmpDir: string;
  let configuredDir: string;
  let legacyDir: string;
  let loader: PluginLoaderService;
  let service: PluginsService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-legacy-svc-'));
    configuredDir = path.join(tmpDir, 'data', 'plugins');
    legacyDir = path.join(tmpDir, 'plugins');
    fs.mkdirSync(configuredDir, { recursive: true });

    const pkg = path.join(legacyDir, manifest.id);
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(pkg, 'index.js'), 'module.exports = class {};');
    fs.writeFileSync(path.join(pkg, 'ui.html'), '<p>legacy config ui</p>');

    const config = {
      get: (k: string) =>
        ({ dataDir: path.join(tmpDir, 'data'), 'plugins.dir': configuredDir, 'plugins.legacyDir': legacyDir })[k],
    } as unknown as ConfigService;
    loader = new PluginLoaderService(config, new HookManager(), new PluginStorageService(config), {
      the: 'unused',
    } as unknown as ModuleRef);
    loader.onModuleInit();
    service = new PluginsService(loader, config);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('serves its config UI from the tree it was loaded from', () => {
    expect(service.getConfigUiHtml(manifest.id)).toContain('legacy config ui');
  });

  it('updates in place, leaving the new version where the old one was', async () => {
    const next = { ...manifest, version: '2.0.0' };
    await service.updatePackage(
      manifest.id,
      zipOf({
        'manifest.json': JSON.stringify(next),
        'index.js': 'module.exports = class {};',
        'ui.html': '<p>v2 config ui</p>',
      }),
    );

    const onDisk = JSON.parse(
      fs.readFileSync(path.join(legacyDir, manifest.id, 'manifest.json'), 'utf8'),
    ) as PluginManifest;
    expect(onDisk.version).toBe('2.0.0');
    // The update must not have materialised a second copy under the configured root, which would
    // then win the next boot's duplicate-id skip and shadow the tree that was actually updated.
    expect(fs.existsSync(path.join(configuredDir, manifest.id))).toBe(false);
    expect(loader.getPlugin(manifest.id)?.manifest.version).toBe('2.0.0');
  });
});
