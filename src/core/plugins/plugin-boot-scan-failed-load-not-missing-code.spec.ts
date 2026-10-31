// A plugin whose package is on disk but fails the load validation (here: it needs a newer OpenWA) is
// logged as plugin_load_failed with the reason. The boot must not also report it as a plugin whose code
// is missing and tell the operator to reinstall it: the code is there, and a reinstall is refused for the
// same reason.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { PluginPackageScanner } from './plugin-package-scanner';
import { PluginStorageService } from './plugin-storage.service';
import { PluginInstance, PluginStatus, PluginType } from './plugin.interfaces';

describe('boot scan of a plugin package that fails its load validation', () => {
  let tmpDir: string;
  let pluginsDir: string;
  let config: ConfigService;
  let storage: PluginStorageService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-scan-'));
    pluginsDir = path.join(tmpDir, 'plugins');
    config = { get: (k: string) => (k === 'dataDir' ? tmpDir : undefined) } as unknown as ConfigService;
    storage = new PluginStorageService(config);
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const placePackage = (folder: string, id: string) => {
    const dir = path.join(pluginsDir, folder);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({
        id,
        name: 'Needs Newer',
        version: '1.0.0',
        type: 'extension',
        main: 'index.js',
        minOpenWAVersion: '99.0.0',
      }),
    );
    fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = class {};');
  };

  // Installed and configured on an earlier boot, when the floor was met.
  const installed = (id: string) =>
    storage.setPluginEntry({
      id,
      type: PluginType.EXTENSION,
      name: id,
      version: '1.0.0',
      status: PluginStatus.INSTALLED,
      config: { greeting: 'hi' },
      builtIn: false,
      installedAt: new Date(),
      updatedAt: new Date(),
    });

  const scan = () => {
    const logger = { log: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
    new PluginPackageScanner(
      logger as never,
      config,
      storage,
      pluginsDir,
      null,
      new Map<string, PluginInstance>(),
    ).scanAtBoot();
    const actions = (mock: jest.Mock) =>
      (mock.mock.calls as unknown[][]).map(call => (call[call.length - 1] as { action?: string } | undefined)?.action);
    const missingCode = (logger.warn.mock.calls as unknown[][]).filter(
      call => (call[call.length - 1] as { action?: string } | undefined)?.action === 'plugin_registry_without_code',
    );
    return { errors: actions(logger.error), missingCode };
  };

  it('reports the load failure only, not code missing from the plugins directory', () => {
    placePackage('needs-newer', 'needs-newer');
    installed('needs-newer');

    const { errors, missingCode } = scan();

    expect(errors).toContain('plugin_load_failed');
    expect(missingCode).toHaveLength(0);
  });

  it('recognizes the failed package by its manifest id when its folder is named otherwise', () => {
    placePackage('hand-placed-copy', 'needs-newer');
    installed('needs-newer');

    const { errors, missingCode } = scan();

    expect(errors).toContain('plugin_load_failed');
    expect(missingCode).toHaveLength(0);
  });

  it('still reports a plugin whose code is really missing, and only that one', () => {
    placePackage('needs-newer', 'needs-newer');
    installed('needs-newer');
    installed('code-gone');

    const { missingCode } = scan();

    expect(missingCode).toHaveLength(1);
    const [message, context] = missingCode[0] as [string, { count?: number }];
    expect(message).toContain('code-gone');
    expect(message).not.toContain('needs-newer');
    expect(context.count).toBe(1);
  });
});
