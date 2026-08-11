import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { PluginLoaderService } from './plugin-loader.service';
import { PluginStorageService } from './plugin-storage.service';
import { HookManager } from '../hooks';
import { PluginStatus, PluginType, type PluginManifest } from './plugin.interfaces';
import type { PluginWorkerHost } from './sandbox/plugin-worker-host';

/**
 * The loader scans the legacy plugins directory in addition to the configured one, so a host that
 * has not migrated keeps its plugins. What it did not record was WHICH directory each package came
 * from, and every later write against the package assumed the configured one — so a plugin loaded
 * from the legacy tree could be listed and reported as loaded, but not enabled, uninstalled or
 * updated. Nothing here had test coverage, which is why all four went unnoticed.
 */

const manifest: PluginManifest = {
  id: 'legacy-plg',
  name: 'Legacy Plugin',
  version: '1.0.0',
  type: PluginType.EXTENSION,
  main: 'index.js',
};

describe('PluginLoaderService — a plugin loaded from the legacy plugins directory', () => {
  let tmpDir: string;
  let configuredDir: string;
  let legacyDir: string;
  let config: ConfigService;
  let storage: PluginStorageService;
  let loader: LoaderWithFakeSandbox;

  /** Records what enableSandboxed asked the worker to require, and requires it for real. */
  const loadedMainPaths: string[] = [];

  class LoaderWithFakeSandbox extends PluginLoaderService {
    protected createSandboxHost(): PluginWorkerHost {
      return {
        load: (mainPath: string) => {
          loadedMainPaths.push(mainPath);
          // Exactly what sandbox/worker-bootstrap.ts does on a 'load' message. A path in the wrong
          // tree fails here with MODULE_NOT_FOUND, which is the defect's observable outcome.
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          require(mainPath);
          return Promise.resolve();
        },
        runLifecycle: () => Promise.resolve(),
        terminate: () => Promise.resolve(),
      } as unknown as PluginWorkerHost;
    }
  }

  const makeLoader = (): LoaderWithFakeSandbox =>
    new LoaderWithFakeSandbox(config, new HookManager(), storage, {} as unknown as ModuleRef);

  beforeEach(() => {
    loadedMainPaths.length = 0;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-legacy-dir-'));
    configuredDir = path.join(tmpDir, 'data', 'plugins');
    legacyDir = path.join(tmpDir, 'plugins');
    fs.mkdirSync(configuredDir, { recursive: true });

    // The package sits ONLY in the legacy tree — the shape of a host whose plugins predate the move.
    const pkg = path.join(legacyDir, manifest.id);
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(pkg, 'index.js'), 'module.exports = class {};');

    config = {
      get: (k: string) =>
        ({ dataDir: path.join(tmpDir, 'data'), 'plugins.dir': configuredDir, 'plugins.legacyDir': legacyDir })[k],
    } as unknown as ConfigService;
    storage = new PluginStorageService(config);
    loader = makeLoader();
    loader.onModuleInit();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('is loaded from the legacy directory in the first place', () => {
    expect(loader.getPlugin(manifest.id)).toBeDefined();
  });

  it('enables, requiring its entry from the tree it was loaded from', async () => {
    await loader.enablePlugin(manifest.id);

    expect(loader.getPlugin(manifest.id)?.status).toBe(PluginStatus.ENABLED);
    expect(loadedMainPaths).toEqual([path.join(legacyDir, manifest.id, 'index.js')]);
  });

  it('uninstalls the package itself, so it does not come back on the next boot', async () => {
    await loader.uninstallPlugin(manifest.id);

    expect(fs.existsSync(path.join(legacyDir, manifest.id))).toBe(false);

    // The real proof: a fresh loader over the same directories must find nothing to load. Deleting
    // the wrong tree left the package in place and the plugin reappeared, having reported success.
    const next = makeLoader();
    next.onModuleInit();
    expect(next.getPlugin(manifest.id)).toBeUndefined();
  });

  it('resolves its package directory to the legacy tree', () => {
    expect(loader.getPluginPackageDir(manifest.id)).toBe(path.resolve(legacyDir, manifest.id));
  });

  // The counterpart: nothing above may change where an ordinary plugin resolves to, and an id that
  // is not loaded still falls back to the configured directory, which is what a fresh install wants.
  it('leaves a plugin in the configured directory, and an unknown id, resolving as before', () => {
    const other: PluginManifest = { ...manifest, id: 'configured-plg' };
    const pkg = path.join(configuredDir, other.id);
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'manifest.json'), JSON.stringify(other));
    fs.writeFileSync(path.join(pkg, 'index.js'), 'module.exports = class {};');

    const fresh = makeLoader();
    fresh.onModuleInit();

    expect(fresh.getPluginPackageDir(other.id)).toBe(path.resolve(configuredDir, other.id));
    expect(fresh.getPluginPackageDir('never-installed')).toBe(path.join(configuredDir, 'never-installed'));
  });
});
