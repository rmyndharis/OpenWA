// Spread the real fs so every method passes through, but as configurable props the test can spy on
// (the bare `import * as fs` namespace is non-configurable, so jest.spyOn can't redefine its methods).
jest.mock('fs', () => ({ __esModule: true, ...jest.requireActual<typeof import('fs')>('fs') }));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { PluginStorageService } from './plugin-storage.service';
import { PluginStatus, PluginType } from './plugin.interfaces';

describe('PluginStorageService sandboxed per-plugin storage containment', () => {
  let dataDir: string;
  let service: PluginStorageService;
  let storage: ReturnType<PluginStorageService['createPluginStorage']>;
  const pluginId = 'demo-plugin';

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-plugindata-'));
    const configService = {
      get: (k: string) => (k === 'dataDir' ? dataDir : undefined),
    } as unknown as ConfigService;
    service = new PluginStorageService(configService);
    storage = service.createPluginStorage(pluginId);
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const expectOwnerOnly = (p: string, expected: number): void => {
    expect(fs.existsSync(p)).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(p).mode & 0o777).toBe(expected);
    }
  };

  it('round-trips a normal key', async () => {
    await storage.set('state', { a: 1 });
    expect(await storage.get('state')).toEqual({ a: 1 });
    await storage.delete('state');
    expect(await storage.get('state')).toBeNull();
  });

  it('creates the per-plugin dir 0o700 and data files 0o600 (persisted secrets not world-readable)', async () => {
    await storage.set('secret', { token: 'shh' });
    const pluginDataDir = path.join(dataDir, 'plugins', pluginId);
    const secretFile = fs.readdirSync(pluginDataDir).find(f => f.endsWith('.json'));
    expect(secretFile).toBeDefined();
    expectOwnerOnly(pluginDataDir, 0o700);
    expectOwnerOnly(path.join(pluginDataDir, secretFile as string), 0o600);
  });

  it('is atomic: a write that fails mid-way leaves the previous file intact (no partial overwrite)', async () => {
    await storage.set('state', { good: true });
    // Simulate a crash after the temp file is written but before the rename — the target must keep its
    // old value, never a truncated/partial one. (A bare writeFileSync would corrupt it here.)
    const spy = jest.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('simulated crash before rename');
    });
    await expect(storage.set('state', { bad: true })).rejects.toThrow();
    spy.mockRestore();
    expect(await storage.get('state')).toEqual({ good: true });
    // And no temp file is left behind.
    const tmps: string[] = [];
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.includes('.tmp')) tmps.push(p);
      }
    };
    walk(dataDir);
    expect(tmps).toEqual([]);
  });

  it('preserves JID-style keys containing : @ . -', async () => {
    await storage.set('group:sess-1:12345@g.us', { announced: true });
    expect(await storage.get('group:sess-1:12345@g.us')).toEqual({ announced: true });
    expect(await storage.list()).toContain('group:sess-1:12345@g.us');

    const pluginDataDir = path.join(dataDir, 'plugins', pluginId);
    const files = fs.readdirSync(pluginDataDir).filter(f => f.endsWith('.json'));
    expect(files.some(f => f.includes(':'))).toBe(false);
  });

  it('reads legacy plain-key files for backwards compatibility', async () => {
    const pluginDataDir = path.join(dataDir, 'plugins', pluginId);
    fs.writeFileSync(path.join(pluginDataDir, 'legacy.json'), JSON.stringify({ old: true }));

    expect(await storage.get('legacy')).toEqual({ old: true });
    expect(await storage.list()).toContain('legacy');
  });

  it('keeps a legacy plain-key file on set but reads the encoded value first', async () => {
    const pluginDataDir = path.join(dataDir, 'plugins', pluginId);
    const legacyFile = path.join(pluginDataDir, 'legacy.json');
    fs.writeFileSync(legacyFile, JSON.stringify({ old: true }));

    await storage.set('legacy', { fresh: true });

    expect(fs.existsSync(legacyFile)).toBe(true); // never unlink outside the service-owned key-* namespace
    expect(await storage.get('legacy')).toEqual({ fresh: true });
    const jsonFiles = fs.readdirSync(pluginDataDir).filter(f => f.endsWith('.json'));
    expect(jsonFiles).toHaveLength(2);
  });

  it("does not let a key spelled like another key's encoded filename read or delete that key", async () => {
    // 'foo' is stored as key-Zm9v.json. The literal key 'key-Zm9v' has its own encoded file; its legacy
    // fallback (<key>.json) is that same path, which belongs to 'foo'.
    await storage.set('foo', { kept: true });

    expect(await storage.get('key-Zm9v')).toBeNull();
    await storage.delete('key-Zm9v');

    expect(await storage.get('foo')).toEqual({ kept: true });
    expect(await storage.list()).toEqual(['foo']);
  });

  it('does not list a canonical encoded filename whose key get and set would refuse', async () => {
    const pluginDataDir = path.join(dataDir, 'plugins', pluginId);
    await storage.set('real', { ok: true });
    const encoded = (key: string): string => `key-${Buffer.from(key).toString('base64url')}.json`;
    for (const key of ['', '../escape']) fs.writeFileSync(path.join(pluginDataDir, encoded(key)), '{}');

    expect(await storage.list()).toEqual(['real']);
  });

  it('deletes a legacy plain-key file', async () => {
    const pluginDataDir = path.join(dataDir, 'plugins', pluginId);
    fs.writeFileSync(path.join(pluginDataDir, 'legacy.json'), JSON.stringify({ old: true }));

    await storage.delete('legacy');

    expect(fs.existsSync(path.join(pluginDataDir, 'legacy.json'))).toBe(false);
    expect(await storage.get('legacy')).toBeNull();
  });

  it('never treats manifest.json or package.json as legacy storage files', async () => {
    const pluginDataDir = path.join(dataDir, 'plugins', pluginId);
    const manifestPath = path.join(pluginDataDir, 'manifest.json');
    const packagePath = path.join(pluginDataDir, 'package.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ id: pluginId }));
    fs.writeFileSync(packagePath, JSON.stringify({ name: pluginId }));

    expect(await storage.list()).toEqual([]); // a listed key must be one get()/delete() will act on
    expect(await storage.get('manifest')).toBeNull();
    await storage.set('manifest', { pluginState: true });
    await storage.delete('manifest');

    expect(JSON.parse(fs.readFileSync(manifestPath, 'utf8'))).toEqual({ id: pluginId });
    expect(JSON.parse(fs.readFileSync(packagePath, 'utf8'))).toEqual({ name: pluginId });
  });

  it('lists no package file as a key when storage shares the package directory', async () => {
    // By default <dataDir>/plugins/<id> is both the installed package and ctx.storage, so a
    // clear-all loop over list() must not reach the package's own root JSON files.
    const pluginDataDir = path.join(dataDir, 'plugins', pluginId);
    fs.writeFileSync(path.join(pluginDataDir, 'manifest.json'), JSON.stringify({ id: pluginId }));
    for (const name of ['tsconfig.json', 'package-lock.json', 'defaults.json']) {
      fs.writeFileSync(path.join(pluginDataDir, name), '{}');
    }
    await storage.set('real', 1);

    expect(await storage.list()).toEqual(['real']);
    for (const key of await storage.list()) await storage.delete(key);
    expect(fs.readdirSync(pluginDataDir).sort()).toEqual([
      'defaults.json',
      'manifest.json',
      'package-lock.json',
      'tsconfig.json',
    ]);
    // A legacy key the plugin names explicitly stays readable.
    expect(await storage.get('defaults')).toEqual({});
  });

  it('does not mangle a literal legacy filename that happens to start with "key-"', async () => {
    const pluginDataDir = path.join(dataDir, 'plugins', pluginId);
    // A pre-encoding plugin could have stored a key literally named "key-zzz" -> key-zzz.json.
    fs.writeFileSync(path.join(pluginDataDir, 'key-zzz.json'), JSON.stringify({ v: 1 }));

    expect(await storage.list()).toContain('key-zzz'); // returned verbatim, not base64-decoded into garbage
    expect(await storage.get('key-zzz')).toEqual({ v: 1 });
  });

  it('rejects a key containing a control character (NUL) on set', async () => {
    await expect(storage.set('a\u0000b', { x: 1 })).rejects.toThrow(/Unsafe plugin storage key/);
  });

  it('rejects a traversing set and writes nothing outside the plugin dir', async () => {
    await expect(storage.set('../../escape', { x: 1 })).rejects.toThrow();
    expect(fs.existsSync(path.join(dataDir, 'escape.json'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'plugins', 'escape.json'))).toBe(false);
  });

  it('refuses a traversing get WITHOUT reading the real outside file it targets', async () => {
    // Place a real JSON file at the location the malicious key would resolve to
    // (pluginDir/../../secret.json -> dataDir/secret.json). Containment must return null, not its content.
    fs.writeFileSync(path.join(dataDir, 'secret.json'), JSON.stringify({ topsecret: true }));
    expect(await storage.get('../../secret')).toBeNull();
  });

  it('rejects a traversing delete', async () => {
    await expect(storage.delete('../../escape')).rejects.toThrow();
  });
});

describe('PluginStorageService.deletePluginData (uninstall storage cleanup)', () => {
  let dataDir: string;
  let service: PluginStorageService;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-plugindata-rm-'));
    const configService = {
      get: (k: string) => (k === 'dataDir' ? dataDir : undefined),
    } as unknown as ConfigService;
    service = new PluginStorageService(configService);
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('removes the named plugin’s storage dir, leaving other plugins untouched', async () => {
    await service.createPluginStorage('gone-plg').set('token', { secret: 'abc' });
    await service.createPluginStorage('keep-plg').set('token', { secret: 'xyz' });

    service.deletePluginData('gone-plg');

    expect(fs.existsSync(path.join(dataDir, 'plugins', 'gone-plg'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'plugins', 'keep-plg'))).toBe(true);
    expect(await service.createPluginStorage('keep-plg').get('token')).toEqual({ secret: 'xyz' });
  });

  it('is a no-op for a plugin with no storage dir', () => {
    expect(() => service.deletePluginData('never-stored')).not.toThrow();
  });

  it('throws when the storage dir cannot be removed, so the caller does not report it gone', async () => {
    await service.createPluginStorage('stuck-plg').set('token', { secret: 'abc' });
    const rm = jest.spyOn(fs, 'rmSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
    });

    expect(() => service.deletePluginData('stuck-plg')).toThrow('EBUSY');

    rm.mockRestore();
    expect(fs.existsSync(path.join(dataDir, 'plugins', 'stuck-plg'))).toBe(true);
  });

  it('refuses a traversal id that resolves outside the storage root', () => {
    // A real directory the escaping id would resolve to — it must survive the call.
    const outside = path.join(dataDir, 'not-plugin-storage');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');

    service.deletePluginData('../not-plugin-storage');

    expect(fs.existsSync(path.join(outside, 'keep.txt'))).toBe(true);
  });
});

describe('PluginStorageService per-plugin storage quota', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-pluginquota-'));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const makeStorage = (maxBytes: number, pluginId = 'quota-plugin') => {
    const configService = {
      get: (k: string) => (k === 'dataDir' ? dataDir : k === 'plugins.storageMaxBytes' ? maxBytes : undefined),
    } as unknown as ConfigService;
    return new PluginStorageService(configService).createPluginStorage(pluginId);
  };

  it('rejects a single write larger than the quota and writes nothing', async () => {
    const storage = makeStorage(1024);
    await expect(storage.set('big', 'x'.repeat(2000))).rejects.toThrow(/storage quota exceeded/);
    expect(await storage.list()).toEqual([]);
  });

  it('bounds the SUM of a plugin’s keys, not just each write', async () => {
    const storage = makeStorage(1024);
    await storage.set('a', 'x'.repeat(500)); // 502 bytes on disk (quoted JSON string)
    await expect(storage.set('b', 'y'.repeat(800))).rejects.toThrow(/storage quota exceeded/);
    // A smaller second key that still fits under the quota is fine.
    await expect(storage.set('b', 'y'.repeat(300))).resolves.toBeUndefined();
  });

  it('does not double-count the key being overwritten', async () => {
    const storage = makeStorage(1024);
    await storage.set('a', 'x'.repeat(900)); // 902 bytes
    // Replacing 'a' must not count its old bytes against the new write.
    await expect(storage.set('a', 'z'.repeat(800))).resolves.toBeUndefined();
    expect(await storage.get('a')).toBe('z'.repeat(800));
  });

  it('counts only the plugin’s own keys — a second plugin has its own quota', async () => {
    const a = makeStorage(1024, 'plugin-a');
    const b = makeStorage(1024, 'plugin-b');
    await a.set('state', 'x'.repeat(900));
    await expect(b.set('state', 'y'.repeat(900))).resolves.toBeUndefined();
  });

  it('applies the 50 MiB default when no quota is configured', async () => {
    const configService = { get: (k: string) => (k === 'dataDir' ? dataDir : undefined) } as unknown as ConfigService;
    const storage = new PluginStorageService(configService).createPluginStorage('default-quota');
    await expect(storage.set('state', 'x'.repeat(1000))).resolves.toBeUndefined();
    // One byte over 50 MiB once JSON-quoted; refused before anything is written.
    await expect(storage.set('big', 'x'.repeat(50 * 1024 * 1024 - 1))).rejects.toThrow(
      /storage quota exceeded.*max 52428800\)/,
    );
  });

  describe('running total', () => {
    const pluginDir = (id = 'quota-plugin'): string => path.join(dataDir, 'plugins', id);

    it('reads the directory once, not on every write', async () => {
      const storage = makeStorage(10 * 1024 * 1024);
      const readdir = jest.spyOn(fs, 'readdirSync');
      try {
        for (let i = 0; i < 50; i++) await storage.set(`key-${i}`, 'x'.repeat(100));
        expect(readdir.mock.calls.filter(([dir]) => String(dir) === pluginDir())).toHaveLength(1);
      } finally {
        readdir.mockRestore();
      }
    });

    it('frees a deleted key and counts a replaced key at its new size', async () => {
      const storage = makeStorage(1024);
      await storage.set('a', 'x'.repeat(500)); // 502 bytes
      await storage.set('b', 'y'.repeat(400)); // 402 bytes
      await expect(storage.set('c', 'z'.repeat(300))).rejects.toThrow(/storage quota exceeded/);

      await storage.delete('a');
      await expect(storage.set('c', 'z'.repeat(300))).resolves.toBeUndefined(); // 402 + 302

      await storage.set('b', 'y'.repeat(10)); // 402 -> 12 bytes
      await expect(storage.set('d', 'w'.repeat(600))).resolves.toBeUndefined(); // 302 + 12 + 602
      await expect(storage.set('e', 'v'.repeat(300))).rejects.toThrow(/storage quota exceeded/);
    });

    it('recounts from the directory before refusing, so files removed behind its back do not block writes', async () => {
      const storage = makeStorage(1024);
      await storage.set('a', 'x'.repeat(900)); // 902 bytes

      for (const file of fs.readdirSync(pluginDir())) fs.unlinkSync(path.join(pluginDir(), file));

      await expect(storage.set('b', 'y'.repeat(900))).resolves.toBeUndefined();
      // The recount did not forget the new key: a third write that cannot fit is still refused.
      await expect(storage.set('c', 'z'.repeat(300))).rejects.toThrow(/storage quota exceeded/);
    });

    it('starts again from zero once the plugin data is deleted', async () => {
      const configService = {
        get: (k: string) => (k === 'dataDir' ? dataDir : k === 'plugins.storageMaxBytes' ? 1024 : undefined),
      } as unknown as ConfigService;
      const service = new PluginStorageService(configService);
      const first = service.createPluginStorage('reinstalled');
      await first.set('state', 'x'.repeat(900));

      service.deletePluginData('reinstalled');
      const second = service.createPluginStorage('reinstalled');

      await expect(second.set('state', 'y'.repeat(900))).resolves.toBeUndefined();
    });

    // The recount before a refusal puts a stale total right, so a write that ends up accepted cannot tell
    // one from a correct total. What a stale total costs is a directory read on the main thread.
    it('takes a deleted key out of the total, so a write that then fits does not read the directory', async () => {
      const storage = makeStorage(1024);
      await storage.set('a', 'x'.repeat(500)); // 502 bytes
      await storage.set('b', 'y'.repeat(400)); // 402 bytes
      await storage.delete('a');

      const readdir = jest.spyOn(fs, 'readdirSync');
      try {
        // 402 + 302 fits the quota only once the 502 bytes of 'a' are out of the total.
        await storage.set('c', 'z'.repeat(300));
        expect(readdir.mock.calls.filter(([dir]) => String(dir) === pluginDir())).toHaveLength(0);
      } finally {
        readdir.mockRestore();
      }
    });

    it('seeds the total again, once, after the plugin data is deleted', async () => {
      const configService = {
        get: (k: string) => (k === 'dataDir' ? dataDir : k === 'plugins.storageMaxBytes' ? 1024 : undefined),
      } as unknown as ConfigService;
      const service = new PluginStorageService(configService);
      await service.createPluginStorage('reinstalled').set('state', 'x'.repeat(100));

      service.deletePluginData('reinstalled');
      const second = service.createPluginStorage('reinstalled');

      const readdir = jest.spyOn(fs, 'readdirSync');
      try {
        // Small writes, so a total carried over from before the delete would still look right.
        await second.set('a', 'y'.repeat(100));
        await second.set('b', 'z'.repeat(100));
        expect(readdir.mock.calls.filter(([dir]) => String(dir) === pluginDir('reinstalled'))).toHaveLength(1);
      } finally {
        readdir.mockRestore();
      }
    });
  });
});

describe('PluginStorageService unreadable registry', () => {
  let dataDir: string;
  let configService: ConfigService;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-pluginreg-'));
    fs.mkdirSync(path.join(dataDir, 'plugins'));
    configService = { get: (k: string) => (k === 'dataDir' ? dataDir : undefined) } as unknown as ConfigService;
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const writeEntry = (service: PluginStorageService): void =>
    service.setPluginEntry({
      id: 'other',
      type: PluginType.EXTENSION,
      name: 'Other',
      version: '1.0.0',
      status: PluginStatus.INSTALLED,
      config: {},
      builtIn: false,
      installedAt: new Date(),
      updatedAt: new Date(),
    });

  it.each([
    ['fails to parse', '[{"id":"p","config":{"apiKey":"SECRET"},"enabledByOperator":true},]'],
    ['is not an array', '{"id":"p","config":{"apiKey":"SECRET"}}'],
  ])('moves a registry that %s aside instead of overwriting it on the next save', (_label, content) => {
    fs.writeFileSync(path.join(dataDir, 'plugins', 'registry.json'), content);

    writeEntry(new PluginStorageService(configService));

    const aside = fs.readdirSync(path.join(dataDir, 'plugins')).filter(f => f.startsWith('registry.json.corrupt-'));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(dataDir, 'plugins', aside[0]), 'utf-8')).toBe(content);
  });
});
