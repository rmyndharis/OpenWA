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

  it('round-trips a normal key', async () => {
    await storage.set('state', { a: 1 });
    expect(await storage.get('state')).toEqual({ a: 1 });
    await storage.delete('state');
    expect(await storage.get('state')).toBeNull();
  });

  it('preserves JID-style keys containing : @ . -', async () => {
    await storage.set('group:sess-1:12345@g.us', { announced: true });
    expect(await storage.get('group:sess-1:12345@g.us')).toEqual({ announced: true });
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
