jest.mock('fs', () => ({ __esModule: true, ...jest.requireActual<typeof import('fs')>('fs') }));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { PluginRegistryWriteError, PluginStorageService } from './plugin-storage.service';
import { PluginStatus, PluginType } from './plugin.interfaces';

describe('plugin storage directory permissions', () => {
  let dataDir: string;
  let service: PluginStorageService;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-plugin-permissions-'));
    service = new PluginStorageService({
      get: (key: string) => (key === 'dataDir' ? dataDir : undefined),
    } as unknown as ConfigService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const writeRegistry = () =>
    service.setPluginEntry({
      id: 'relay',
      name: 'Relay',
      version: '1.0.0',
      type: PluginType.EXTENSION,
      status: PluginStatus.INSTALLED,
      config: {},
      builtIn: false,
      installedAt: new Date(),
      updatedAt: new Date(),
    });

  (process.platform === 'win32' ? it.skip : it)('tightens an existing plugin storage directory', () => {
    const dir = path.join(dataDir, 'plugins', 'relay');
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o755);
    service.createPluginStorage('relay');
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  (process.platform === 'win32' ? it.skip : it)('tightens an existing registry directory', () => {
    const dir = path.join(dataDir, 'plugins');
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o755);
    writeRegistry();
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  (process.platform === 'win32' ? it.skip : it)('creates a fresh registry directory owner-only', () => {
    writeRegistry();
    expect(fs.statSync(path.join(dataDir, 'plugins')).mode & 0o777).toBe(0o700);
  });

  (process.platform === 'win32' ? it.skip : it).each([
    [0o1755, 0o1700],
    [0o2755, 0o2700],
    [0o4755, 0o4700],
  ])('preserves special bits while removing group and other access (mode %i)', (mode, expected) => {
    const registryDir = path.join(dataDir, 'plugins');
    const storageDir = path.join(registryDir, 'relay');
    fs.mkdirSync(storageDir, { recursive: true });
    fs.chmodSync(registryDir, mode);
    fs.chmodSync(storageDir, mode);

    // Some hosts ignore special bits in chmod (macOS drops setgid in tmpdir); whatever the
    // platform actually stored is what the tightening must keep.
    const platformSpecial = (fs.statSync(registryDir).mode | fs.statSync(storageDir).mode) & 0o7000;
    const want = 0o700 | (expected & platformSpecial);

    writeRegistry();
    service.createPluginStorage('relay');

    expect({
      registry: fs.statSync(registryDir).mode & 0o7777,
      storage: fs.statSync(storageDir).mode & 0o7777,
    }).toEqual({ registry: want, storage: want });
  });

  (process.platform === 'win32' ? it.skip : it)('preserves an owner-readonly registry directory', () => {
    writeRegistry();
    const dir = path.join(dataDir, 'plugins');
    fs.chmodSync(dir, 0o500);
    try {
      expect(() => service.setPluginConfig('relay', { mode: 'new' }, { mustPersist: true })).toThrow(
        PluginRegistryWriteError,
      );
      expect(fs.statSync(dir).mode & 0o777).toBe(0o500);
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });

  (process.platform === 'win32' ? it.skip : it)('preserves an owner-readonly storage directory', () => {
    const dir = path.join(dataDir, 'plugins', 'relay');
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o500);
    try {
      service.createPluginStorage('relay');
      expect(fs.statSync(dir).mode & 0o777).toBe(0o500);
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });

  it('still throws when a storage directory cannot be created', () => {
    jest.spyOn(fs, 'mkdirSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('directory creation denied'), { code: 'EACCES' });
    });
    expect(() => service.createPluginStorage('relay')).toThrow('directory creation denied');
  });

  it('keeps storage usable when tightening its directory is denied', async () => {
    const dir = path.join(dataDir, 'plugins', 'relay');
    fs.mkdirSync(dir, { recursive: true });
    jest.spyOn(fs, 'chmodSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('directory chmod denied'), { code: 'EPERM' });
    });
    const store = service.createPluginStorage('relay');
    jest.restoreAllMocks();
    await store.set('state', 1);
    await expect(store.get('state')).resolves.toBe(1);
  });
});
