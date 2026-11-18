// Spread the real fs so every method passes through, but as configurable props the test can spy on.
jest.mock('fs', () => ({ __esModule: true, ...jest.requireActual<typeof import('fs')>('fs') }));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { PluginLoaderService, PluginStatus } from '../../core/plugins';
import { PluginStorageService } from '../../core/plugins/plugin-storage.service';
import { PluginWorkerHost } from '../../core/plugins/sandbox/plugin-worker-host';
import { HookManager } from '../../core/hooks';
import { PluginsService } from './plugins.service';

type FakeHost = { load: jest.Mock; runLifecycle: jest.Mock; terminate: jest.Mock; sendConfigChange: jest.Mock };

/** A loader whose sandbox workers are recorded fakes, so what an update does to the running plugin can be read. */
class RecordingLoader extends PluginLoaderService {
  readonly hosts: FakeHost[] = [];
  protected createSandboxHost(): PluginWorkerHost {
    const host: FakeHost = {
      load: jest.fn().mockResolvedValue(undefined),
      runLifecycle: jest.fn().mockResolvedValue(undefined),
      terminate: jest.fn().mockResolvedValue(undefined),
      sendConfigChange: jest.fn(),
    };
    this.hosts.push(host);
    return host as unknown as PluginWorkerHost;
  }
}

const packageOf = (version: string, extra: Record<string, unknown> = {}): Buffer => {
  const zip = new AdmZip();
  zip.addFile(
    'manifest.json',
    Buffer.from(
      JSON.stringify({
        id: 'demo',
        name: 'Demo',
        version,
        type: 'extension',
        main: 'index.cjs',
        permissions: ['webhook:ingress'],
        ...extra,
      }),
    ),
  );
  zip.addFile('index.cjs', Buffer.from('module.exports = class Demo {};'));
  return zip.toBuffer();
};

const route = (signature: { scheme: string }): Record<string, unknown> => ({
  route: 'hook',
  mode: 'async',
  verify: 'core',
  maxBodyBytes: 1000,
  signature,
});

// Packages that name an ingress declaration the host refuses at load, though nothing but the manifest and the
// ALLOW_UNSIGNED_INGRESS setting is needed to know it.
const REFUSED: Array<[string, Record<string, unknown>, RegExp]> = [
  [
    'an ingress route that skips the signature while unsigned ingress is off',
    { ingress: [route({ scheme: 'none' })] },
    /signature\.scheme 'none'/,
  ],
  [
    'an ingress declaration for an SDK major the host does not support',
    { sdkVersion: '2', ingress: [route({ scheme: 'shared-secret' })] },
    /SDK major 2 is not supported/,
  ],
  [
    'an ingress declaration without the permission for it',
    { permissions: [], ingress: [route({ scheme: 'shared-secret' })] },
    /missing the 'webhook:ingress' permission/,
  ],
];

describe('a package whose ingress declaration the host refuses to load', () => {
  let tmp: string;
  let pluginsDir: string;
  let values: Record<string, unknown>;
  let loader: RecordingLoader;
  let service: PluginsService;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-update-refused-'));
    pluginsDir = path.join(tmp, 'plugins');
    values = {
      dataDir: tmp,
      'plugins.dir': pluginsDir,
      'plugins.legacyDir': null,
      'ingress.allowUnsigned': false,
    };
    const config = { get: (key: string, fallback?: unknown) => values[key] ?? fallback } as unknown as ConfigService;
    const moduleRef = { get: () => undefined } as unknown as ModuleRef;
    loader = new RecordingLoader(config, new HookManager(), new PluginStorageService(config), moduleRef);
    service = new PluginsService(loader, config);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('as an update of a running plugin', () => {
    beforeEach(async () => {
      await service.installPackage({ buffer: packageOf('1.0.0') });
      await service.enable('demo');
    });

    it.each(REFUSED)('is refused with a 400 before the plugin is stopped: %s', async (_name, extra, message) => {
      const running = loader.hosts[0];
      const before = fs.readdirSync(pluginsDir);
      expect(loader.getPlugin('demo')?.status).toBe(PluginStatus.ENABLED);

      const refused = service.updatePackage('demo', packageOf('2.0.0', extra));
      await expect(refused).rejects.toThrow(BadRequestException);
      await expect(refused).rejects.toThrow(message);

      // The installed plugin is exactly as it was: no onDisable, no onUnload, no new worker, nothing staged.
      expect(running.runLifecycle).not.toHaveBeenCalledWith('onDisable', expect.anything());
      expect(running.runLifecycle).not.toHaveBeenCalledWith('onUnload', expect.anything());
      expect(running.terminate).not.toHaveBeenCalled();
      expect(loader.hosts).toHaveLength(1);
      expect(loader.getPlugin('demo')?.manifest.version).toBe('1.0.0');
      expect(loader.getPlugin('demo')?.status).toBe(PluginStatus.ENABLED);
      expect(fs.readdirSync(pluginsDir)).toEqual(before);
    });
  });

  describe('as an install', () => {
    it.each(REFUSED)('is refused with a 400 before anything is written: %s', async (_name, extra, message) => {
      const writes = [
        jest.spyOn(fs, 'mkdirSync'),
        jest.spyOn(fs, 'writeFileSync'),
        jest.spyOn(fs, 'renameSync'),
        jest.spyOn(fs, 'rmSync'),
      ];

      expect(() => service.install({ buffer: packageOf('1.0.0', extra) })).toThrow(BadRequestException);
      expect(() => service.install({ buffer: packageOf('1.0.0', extra) })).toThrow(message);
      await expect(service.installPackage({ buffer: packageOf('1.0.0', extra) })).rejects.toThrow(message);

      for (const spy of writes) expect(spy).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(pluginsDir, 'demo'))).toBe(false);
      expect(loader.getPlugin('demo')).toBeUndefined();
    });
  });

  describe('when the operator allows unsigned ingress', () => {
    beforeEach(() => {
      values['ingress.allowUnsigned'] = true;
    });

    it('installs and updates a package whose route skips the signature', async () => {
      const unsigned = { ingress: [route({ scheme: 'none' })] };

      await service.installPackage({ buffer: packageOf('1.0.0', unsigned) });
      await service.enable('demo');
      expect(loader.getPlugin('demo')?.manifest.version).toBe('1.0.0');

      await service.updatePackage('demo', packageOf('2.0.0', unsigned));
      expect(loader.getPlugin('demo')?.manifest.version).toBe('2.0.0');
      expect(loader.getPlugin('demo')?.status).toBe(PluginStatus.ENABLED);
    });

    it('still refuses an ingress declaration that is wrong for another reason', async () => {
      await expect(
        service.installPackage({
          buffer: packageOf('1.0.0', { sdkVersion: '2', ingress: [route({ scheme: 'none' })] }),
        }),
      ).rejects.toThrow(/SDK major 2 is not supported/);
    });
  });
});
