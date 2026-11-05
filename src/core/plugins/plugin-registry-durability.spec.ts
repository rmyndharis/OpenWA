jest.mock('fs', () => ({ __esModule: true, ...jest.requireActual<typeof import('fs')>('fs') }));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { PluginRegistryWriteError, PluginStorageService } from './plugin-storage.service';
import { PluginStatus, PluginType } from './plugin.interfaces';

describe('plugin registry durability', () => {
  let dataDir: string;
  let service: PluginStorageService;
  let registryPath: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-registry-sync-'));
    registryPath = path.join(dataDir, 'plugins', 'registry.json');
    service = new PluginStorageService({
      get: (key: string) => (key === 'dataDir' ? dataDir : undefined),
    } as unknown as ConfigService);
    service.setPluginEntry({
      id: 'relay',
      name: 'Relay',
      version: '1.0.0',
      type: PluginType.EXTENSION,
      status: PluginStatus.INSTALLED,
      config: { mode: 'old' },
      builtIn: false,
      installedAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('synchronizes the temporary registry before replacing the target', () => {
    const sync = jest.spyOn(fs, 'fsyncSync');
    const rename = jest.spyOn(fs, 'renameSync');
    const close = jest.spyOn(fs, 'closeSync');

    service.setPluginConfig('relay', { mode: 'new' }, { mustPersist: true });

    expect(sync).toHaveBeenCalled();
    expect(sync.mock.invocationCallOrder[0]).toBeLessThan(rename.mock.invocationCallOrder[0]);
    expect(close.mock.invocationCallOrder[0]).toBeLessThan(rename.mock.invocationCallOrder[0]);
    if (process.platform !== 'win32') {
      expect(sync.mock.invocationCallOrder[1]).toBeGreaterThan(rename.mock.invocationCallOrder[0]);
    }
    const entries = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as { config: unknown }[];
    expect(entries[0].config).toEqual({ mode: 'new' });
  });

  it('does not synchronize ordinary plugin key writes', async () => {
    const store = service.createPluginStorage('relay');
    const sync = jest.spyOn(fs, 'fsyncSync');
    await store.set('state', { cursor: 2 });
    expect(sync).not.toHaveBeenCalled();
    await expect(store.get('state')).resolves.toEqual({ cursor: 2 });
  });

  it('retains the old registry and closes the temporary file when required synchronization fails', () => {
    const before = fs.readFileSync(registryPath, 'utf8');
    const close = jest.spyOn(fs, 'closeSync');
    jest.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('write sync failed'), { code: 'EIO' });
    });

    expect(() => service.setPluginConfig('relay', { mode: 'new' }, { mustPersist: true })).toThrow(
      PluginRegistryWriteError,
    );
    expect(service.getPluginConfig('relay')).toEqual({ mode: 'old' });
    expect(fs.readFileSync(registryPath, 'utf8')).toBe(before);
    expect(close).toHaveBeenCalled();
    expect(fs.readdirSync(path.dirname(registryPath)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  (process.platform === 'win32' ? it.skip : it).each(['EISDIR', 'EINVAL', 'EPERM', 'EIO'])(
    'keeps an already replaced registry when directory synchronization fails with %s',
    code => {
      const realSync = fs.fsyncSync;
      jest
        .spyOn(fs, 'fsyncSync')
        .mockImplementationOnce(fd => realSync(fd))
        .mockImplementationOnce(() => {
          throw Object.assign(new Error('directory sync unavailable'), { code });
        });

      expect(() => service.setPluginConfig('relay', { mode: 'new' }, { mustPersist: true })).not.toThrow();
      expect(service.getPluginConfig('relay')).toEqual({ mode: 'new' });
      const entries = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as { config: unknown }[];
      expect(entries[0].config).toEqual({ mode: 'new' });
    },
  );
});
