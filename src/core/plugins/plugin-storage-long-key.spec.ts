import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { PluginStorageService } from './plugin-storage.service';

describe('a long ctx.storage key', () => {
  let tmpDir: string;
  let storage: PluginStorageService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-long-key-'));
    storage = new PluginStorageService({
      get: (k: string) => (k === 'dataDir' ? tmpDir : undefined),
    } as unknown as ConfigService);
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it.each(['k'.repeat(184), 'é'.repeat(92)])('stores a key of 184 UTF-8 bytes: %s', async key => {
    const store = storage.createPluginStorage('crm-sync');
    await store.set(key, 1);
    await expect(store.get(key)).resolves.toBe(1);
    await expect(store.list()).resolves.toEqual([key]);
  });

  it.each([
    { key: 'k'.repeat(185), bytes: 185 },
    { key: 'é'.repeat(93), bytes: 186 },
  ])('rejects a $bytes-byte key before writing a file', async ({ key, bytes }) => {
    const store = storage.createPluginStorage('crm-sync');
    const dir = path.join(tmpDir, 'plugins', 'crm-sync');
    const before = fs.readdirSync(dir);
    await expect(store.set(key, 1)).rejects.toThrow(new RegExp(`184 UTF-8 bytes.*${bytes}`));
    expect(fs.readdirSync(dir)).toEqual(before);
    await expect(store.get(key)).resolves.toBeNull();
    await expect(store.delete(key)).resolves.toBeUndefined();
  });

  it('rejects the key before quota accounting and leaves the quota available', async () => {
    const limited = new PluginStorageService({
      get: (k: string) => (k === 'dataDir' ? tmpDir : k === 'plugins.storageMaxBytes' ? 6 : undefined),
    } as unknown as ConfigService).createPluginStorage('crm-sync');
    await limited.set('first', 1);
    await expect(limited.set('k'.repeat(185), 'too large')).rejects.toThrow(/184 UTF-8 bytes.*185/);
    await limited.set('second', 2);
    await expect(limited.get('first')).resolves.toBe(1);
    await expect(limited.get('second')).resolves.toBe(2);
  });
});
