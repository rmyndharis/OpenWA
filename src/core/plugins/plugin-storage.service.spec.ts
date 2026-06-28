// Spread the real fs so every method passes through, but as configurable props the test can spy on
// (the bare `import * as fs` namespace is non-configurable, so jest.spyOn can't redefine its methods).
jest.mock('fs', () => ({ __esModule: true, ...jest.requireActual<typeof import('fs')>('fs') }));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { PluginStorageService } from './plugin-storage.service';

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

  it('migrates a legacy plain-key file off on the next set (no stale shadow copy)', async () => {
    const pluginDataDir = path.join(dataDir, 'plugins', pluginId);
    const legacyFile = path.join(pluginDataDir, 'legacy.json');
    fs.writeFileSync(legacyFile, JSON.stringify({ old: true }));

    await storage.set('legacy', { fresh: true });

    expect(fs.existsSync(legacyFile)).toBe(false); // stale legacy copy removed
    expect(await storage.get('legacy')).toEqual({ fresh: true });
    const jsonFiles = fs.readdirSync(pluginDataDir).filter(f => f.endsWith('.json'));
    expect(jsonFiles).toHaveLength(1); // only the encoded file remains
  });

  it('deletes a legacy plain-key file', async () => {
    const pluginDataDir = path.join(dataDir, 'plugins', pluginId);
    fs.writeFileSync(path.join(pluginDataDir, 'legacy.json'), JSON.stringify({ old: true }));

    await storage.delete('legacy');

    expect(fs.existsSync(path.join(pluginDataDir, 'legacy.json'))).toBe(false);
    expect(await storage.get('legacy')).toBeNull();
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
