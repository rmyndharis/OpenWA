// Spread the real fs so a test can spy on rmSync (the bare namespace is not configurable).
jest.mock('fs', () => ({ __esModule: true, ...jest.requireActual<typeof import('fs')>('fs') }));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { createLogger } from '../../common/services/logger.service';
import { PluginStorageService } from './plugin-storage.service';
import { PluginUninstaller } from './plugin-uninstaller';
import { PluginInstance, PluginStatus, PluginType } from './plugin.interfaces';

/**
 * The uninstall job, on the collaborator that owns it since the loader split. Construction only is
 * adapted from the loader-level specs these tests moved from: instead of loading plugins through the
 * boot scan, the shared registry Map and persisted entries are seeded directly — the inputs
 * uninstallPlugin actually reads. The unload seam is the callback the lifecycle would provide; every
 * assertion is unchanged.
 */
const makeUninstaller = (
  config: ConfigService,
  storage: PluginStorageService,
  pluginsDir: string,
  releaseTakeovers?: (pluginId: string) => Promise<void>,
) => {
  const plugins = new Map<string, PluginInstance>();
  const uninstaller = new PluginUninstaller(
    createLogger('PluginLoaderService'),
    plugins,
    storage,
    pluginsDir,
    // The lifecycle's unload drops the runtime record; that is all uninstall needs from it.
    pluginId => {
      plugins.delete(pluginId);
      return Promise.resolve();
    },
    null,
    releaseTakeovers,
  );
  return { uninstaller, plugins };
};

/** The registry record a boot-scan load would have left for an installed user plugin. */
const loadedUserPlugin = (id: string, packageDir: string): PluginInstance => ({
  manifest: { id, name: id, version: '1.0.0', type: PluginType.EXTENSION, main: 'index.js' },
  status: PluginStatus.INSTALLED,
  config: {},
  instance: null,
  loadedAt: new Date(),
  builtIn: false,
  packageDir,
});

const seedEntry = (storage: PluginStorageService, id: string, builtIn = false): void => {
  storage.setPluginEntry({
    id,
    type: 'extension',
    name: id,
    version: '1.0.0',
    status: 'installed',
    config: {},
    builtIn,
    installedAt: new Date(),
    updatedAt: new Date(),
  } as never);
};

describe('PluginUninstaller — uninstall', () => {
  let tmpDir: string;
  let pluginsDir: string;
  let storage: PluginStorageService;
  let uninstaller: PluginUninstaller;
  let plugins: Map<string, PluginInstance>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-uninst-'));
    pluginsDir = path.join(tmpDir, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    const config = {
      get: (k: string) => (k === 'plugins.dir' ? pluginsDir : k === 'dataDir' ? tmpDir : undefined),
    } as unknown as ConfigService;
    storage = new PluginStorageService(config);
    ({ uninstaller, plugins } = makeUninstaller(config, storage, pluginsDir));
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const writeUserPlugin = (id: string): string => {
    const dir = path.join(pluginsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ id, name: id, version: '1.0.0', type: 'extension', main: 'index.js' }),
    );
    fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = class {};');
    return dir;
  };

  it('removes the plugin directory, registry entry, and runtime instance', async () => {
    const dir = writeUserPlugin('user-plg');
    plugins.set('user-plg', loadedUserPlugin('user-plg', dir));
    seedEntry(storage, 'user-plg');
    expect(storage.getPluginEntry('user-plg')).toBeDefined();

    await uninstaller.uninstallPlugin('user-plg');

    expect(fs.existsSync(dir)).toBe(false);
    expect(storage.getPluginEntry('user-plg')).toBeUndefined();
    expect(plugins.get('user-plg')).toBeUndefined();
  });

  it('removes a legacy-directory package that failed to load (registry entry only)', async () => {
    // A load failure keeps the registry entry but records no runtime instance, so no packageDir either.
    const legacyDir = path.join(tmpDir, 'legacy-plugins');
    const pkg = path.join(legacyDir, 'old-plg');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'manifest.json'), '{}');
    const stray = path.join(legacyDir, 'not-a-plugin');
    fs.mkdirSync(stray, { recursive: true });
    seedEntry(storage, 'old-plg');
    seedEntry(storage, 'not-a-plugin');
    const withLegacy = new PluginUninstaller(
      createLogger('PluginLoaderService'),
      plugins,
      storage,
      pluginsDir,
      () => Promise.resolve(),
      legacyDir,
    );

    await withLegacy.uninstallPlugin('old-plg');
    await withLegacy.uninstallPlugin('not-a-plugin');

    expect(fs.existsSync(pkg)).toBe(false);
    expect(storage.getPluginEntry('old-plg')).toBeUndefined();
    // Only a real package directory (one holding a manifest.json) is removed from the legacy tree.
    expect(fs.existsSync(stray)).toBe(true);
  });

  it('also removes a legacy copy of a plugin that loaded from the configured tree', async () => {
    // The boot scan skips the legacy copy as a duplicate, so the runtime record points at the configured
    // copy. Left behind, the legacy copy would load again on the next boot as a new plugin.
    const dir = writeUserPlugin('dup-plg');
    const legacyDir = path.join(tmpDir, 'legacy-plugins');
    const legacyPkg = path.join(legacyDir, 'dup-plg');
    fs.mkdirSync(legacyPkg, { recursive: true });
    fs.writeFileSync(path.join(legacyPkg, 'manifest.json'), '{}');
    plugins.set('dup-plg', loadedUserPlugin('dup-plg', dir));
    seedEntry(storage, 'dup-plg');
    const withLegacy = new PluginUninstaller(
      createLogger('PluginLoaderService'),
      plugins,
      storage,
      pluginsDir,
      pluginId => {
        plugins.delete(pluginId);
        return Promise.resolve();
      },
      legacyDir,
    );

    await withLegacy.uninstallPlugin('dup-plg');

    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(legacyPkg)).toBe(false);
  });

  it('refuses to uninstall a built-in plugin', async () => {
    plugins.set('core-engine', { ...loadedUserPlugin('core-engine', pluginsDir), builtIn: true });
    seedEntry(storage, 'core-engine', true);
    await expect(uninstaller.uninstallPlugin('core-engine')).rejects.toThrow(/built-in/i);
  });

  // A takeover the plugin held would keep every other plugin silent on that chat for good.
  it('hands the takeovers of the plugin back once it no longer runs, before it removes anything', async () => {
    const dir = writeUserPlugin('relay');
    seedEntry(storage, 'relay');
    const config = { get: (k: string) => (k === 'plugins.dir' ? pluginsDir : tmpDir) } as unknown as ConfigService;
    const seen: Array<{ onDisk: boolean; running: boolean }> = [];
    const withRelease: ReturnType<typeof makeUninstaller> = makeUninstaller(config, storage, pluginsDir, () => {
      seen.push({
        onDisk: fs.existsSync(dir) && storage.getPluginEntry('relay') !== undefined,
        running: withRelease.plugins.has('relay'),
      });
      return Promise.resolve();
    });
    withRelease.plugins.set('relay', loadedUserPlugin('relay', dir));

    await withRelease.uninstaller.uninstallPlugin('relay');

    // Still running at the release would let it take a chat over again before its worker ends.
    expect(seen).toEqual([{ onDisk: true, running: false }]);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('keeps the plugin installed when its takeovers cannot be handed back, so the call can be repeated', async () => {
    const dir = writeUserPlugin('relay');
    seedEntry(storage, 'relay');
    const config = { get: (k: string) => (k === 'plugins.dir' ? pluginsDir : tmpDir) } as unknown as ConfigService;
    let storeUp = false;
    const flaky = makeUninstaller(config, storage, pluginsDir, () =>
      storeUp ? Promise.resolve() : Promise.reject(new Error('mapping store unavailable')),
    );
    flaky.plugins.set('relay', loadedUserPlugin('relay', dir));

    await expect(flaky.uninstaller.uninstallPlugin('relay')).rejects.toThrow('mapping store unavailable');

    // Nothing of the plugin was removed, though it no longer runs.
    expect(fs.existsSync(dir)).toBe(true);
    expect(storage.getPluginEntry('relay')).toBeDefined();
    expect(flaky.plugins.has('relay')).toBe(false);

    // The repeat finds no runtime, retries the release and removes the plugin.
    storeUp = true;
    await flaky.uninstaller.uninstallPlugin('relay');
    expect(fs.existsSync(dir)).toBe(false);
    expect(storage.getPluginEntry('relay')).toBeUndefined();
  });

  it('keeps the registry entry when the package folder cannot be removed, so the uninstall can be repeated', async () => {
    const dir = writeUserPlugin('relay');
    plugins.set('relay', loadedUserPlugin('relay', dir));
    seedEntry(storage, 'relay');
    const realRm = fs.rmSync.bind(fs);
    const rm = jest.spyOn(fs, 'rmSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    });

    await expect(uninstaller.uninstallPlugin('relay')).rejects.toThrow('EACCES');

    expect(fs.existsSync(dir)).toBe(true);
    expect(storage.getPluginEntry('relay')).toBeDefined();

    rm.mockImplementation(realRm);
    await uninstaller.uninstallPlugin('relay');
    expect(fs.existsSync(dir)).toBe(false);
    expect(storage.getPluginEntry('relay')).toBeUndefined();
    rm.mockRestore();
  });

  // The boot scan loads a folder by its manifest id, whatever the folder is called. The repeat of a
  // failed uninstall has no runtime record left to read the folder from.
  it('removes the package folder on the repeat of a failed uninstall when the folder is not the plugin id', async () => {
    const dir = path.join(pluginsDir, 'relay-v2-copy');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id: 'relay' }));
    seedEntry(storage, 'relay');
    const config = { get: (k: string) => (k === 'plugins.dir' ? pluginsDir : tmpDir) } as unknown as ConfigService;
    let storeUp = false;
    const flaky = makeUninstaller(config, storage, pluginsDir, () =>
      storeUp ? Promise.resolve() : Promise.reject(new Error('mapping store unavailable')),
    );
    flaky.plugins.set('relay', loadedUserPlugin('relay', dir));

    await expect(flaky.uninstaller.uninstallPlugin('relay')).rejects.toThrow('mapping store unavailable');
    expect(fs.existsSync(dir)).toBe(true);

    storeUp = true;
    await flaky.uninstaller.uninstallPlugin('relay');

    expect(fs.existsSync(dir)).toBe(false);
    expect(storage.getPluginEntry('relay')).toBeUndefined();
  });
});

describe('PluginUninstaller — uninstall cleans up split-dir plugin storage', () => {
  let tmpDir: string;
  let pluginsDir: string;
  let dataDir: string;
  let uninstaller: PluginUninstaller;
  let plugins: Map<string, PluginInstance>;
  let storage: PluginStorageService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-splitstore-'));
    // Split-dir deployment: the package dir and the ctx.storage data dir are NOT the same tree.
    pluginsDir = path.join(tmpDir, 'plugins');
    dataDir = path.join(tmpDir, 'data');
    fs.mkdirSync(pluginsDir, { recursive: true });
    const config = {
      get: (k: string) => (k === 'plugins.dir' ? pluginsDir : k === 'dataDir' ? dataDir : undefined),
    } as unknown as ConfigService;
    storage = new PluginStorageService(config);
    ({ uninstaller, plugins } = makeUninstaller(config, storage, pluginsDir));
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const writeUserPlugin = (id: string): string => {
    const dir = path.join(pluginsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ id, name: id, version: '1.0.0', type: 'extension', main: 'index.js' }),
    );
    fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = class {};');
    return dir;
  };

  it('removes the plugin’s storage dir on uninstall, and only that plugin’s', async () => {
    const dir = writeUserPlugin('user-plg');
    writeUserPlugin('other-plg');
    plugins.set('user-plg', loadedUserPlugin('user-plg', dir));
    plugins.set('other-plg', loadedUserPlugin('other-plg', path.join(pluginsDir, 'other-plg')));
    seedEntry(storage, 'user-plg');
    seedEntry(storage, 'other-plg');
    // Persist real ctx.storage state for both plugins (split-dir: under <dataDir>/plugins/<id>).
    await storage.createPluginStorage('user-plg').set('token', { secret: 'abc' });
    await storage.createPluginStorage('other-plg').set('token', { secret: 'xyz' });
    const userStorageDir = path.join(dataDir, 'plugins', 'user-plg');
    const otherStorageDir = path.join(dataDir, 'plugins', 'other-plg');
    expect(fs.existsSync(userStorageDir)).toBe(true);

    await uninstaller.uninstallPlugin('user-plg');

    expect(fs.existsSync(dir)).toBe(false); // package dir (unchanged behavior)
    expect(fs.existsSync(userStorageDir)).toBe(false); // split-dir storage is now cleaned too
    expect(fs.existsSync(otherStorageDir)).toBe(true); // another plugin's storage is untouched
    expect(await storage.createPluginStorage('other-plg').get('token')).toEqual({ secret: 'xyz' });
  });
});
