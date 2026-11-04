jest.mock('fs', () => ({ __esModule: true, ...jest.requireActual<typeof import('fs')>('fs') }));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { PluginPackageScanner } from './plugin-package-scanner';
import { PluginStorageService } from './plugin-storage.service';
import { PluginInstance, PluginStatus, PluginType } from './plugin.interfaces';

describe('boot scan of a legacy-directory plugin that has stored data', () => {
  let tmpDir: string;
  let configuredDir: string;
  let legacyDir: string;
  let config: ConfigService;
  let storage: PluginStorageService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-legacy-storage-'));
    configuredDir = path.join(tmpDir, 'data', 'plugins');
    legacyDir = path.join(tmpDir, 'plugins');
    config = {
      get: (k: string) =>
        ({ dataDir: path.join(tmpDir, 'data'), 'plugins.dir': configuredDir, 'plugins.legacyDir': legacyDir })[k],
    } as unknown as ConfigService;
    storage = new PluginStorageService(config);

    const pkg = path.join(legacyDir, 'relay');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, 'manifest.json'),
      JSON.stringify({ id: 'relay', name: 'Relay', version: '1.0.0', type: 'extension', main: 'index.js' }),
    );
    fs.writeFileSync(path.join(pkg, 'index.js'), 'module.exports = class {};');
    storage.setPluginEntry({
      id: 'relay',
      type: PluginType.EXTENSION,
      name: 'Relay',
      version: '1.0.0',
      status: PluginStatus.INSTALLED,
      config: {},
      builtIn: false,
      installedAt: new Date(),
      updatedAt: new Date(),
      enabledByOperator: true,
    });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const scan = () => {
    const logger = { log: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const plugins = new Map<string, PluginInstance>();
    new PluginPackageScanner(logger as never, config, storage, configuredDir, legacyDir, plugins).scanAtBoot();
    const warned = (logger.warn.mock.calls as unknown[][]).map(
      call => (call[call.length - 1] as { action?: string } | undefined)?.action,
    );
    const errors = (logger.error.mock.calls as unknown[][]).map(
      call => (call[call.length - 1] as { action?: string } | undefined)?.action,
    );
    return { plugins, warned, errors };
  };

  it('loads it without reporting its code as missing', async () => {
    // What enabling it once did: its ctx.storage directory now exists in the configured tree.
    await storage.createPluginStorage('relay').set('cursor', { lastId: 'm1' });

    const { plugins, warned } = scan();

    expect(plugins.get('relay')?.packageDir).toBe(path.resolve(legacyDir, 'relay'));
    expect(warned).not.toContain('plugin_code_missing');
  });

  it('still reports a plugin whose code is really gone', async () => {
    await storage.createPluginStorage('relay').set('cursor', { lastId: 'm1' });
    fs.rmSync(path.join(legacyDir, 'relay'), { recursive: true, force: true });

    const { plugins, warned } = scan();

    expect(plugins.has('relay')).toBe(false);
    expect(warned).toContain('plugin_code_missing');
  });

  it('reports the real load failure without saying the legacy code is missing', async () => {
    await storage.createPluginStorage('relay').set('cursor', { lastId: 'm1' });
    fs.unlinkSync(path.join(legacyDir, 'relay', 'index.js'));

    const { plugins, warned, errors } = scan();

    expect(plugins.has('relay')).toBe(false);
    expect(errors).toContain('plugin_load_failed');
    expect(warned).not.toContain('plugin_code_missing');
    expect(warned).not.toContain('plugin_registry_without_code');
    expect(storage.getPluginStatus('relay')).toBe(PluginStatus.ERROR);
  });

  it('finds a differently named package after scanning its storage directory', async () => {
    await storage.createPluginStorage('relay').set('cursor', { lastId: 'm1' });
    fs.renameSync(path.join(legacyDir, 'relay'), path.join(configuredDir, 'z-package'));
    const entries = fs.readdirSync(configuredDir, { withFileTypes: true });
    entries.sort((a, b) => (a.name === 'relay' ? -1 : b.name === 'relay' ? 1 : 0));
    const read = fs.readdirSync;
    jest.spyOn(fs, 'readdirSync').mockImplementation(((dir: fs.PathLike, options: unknown) => {
      if (
        dir === configuredDir &&
        typeof options === 'object' &&
        options !== null &&
        (options as { withFileTypes?: boolean }).withFileTypes
      ) {
        return entries;
      }
      return read(dir, options as never);
    }) as never);

    const { plugins, warned } = scan();

    expect(plugins.get('relay')?.packageDir).toBe(path.join(configuredDir, 'z-package'));
    expect(warned).not.toContain('plugin_code_missing');
  });
});
