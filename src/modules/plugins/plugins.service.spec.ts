// Spread the real fs so every method passes through, but as configurable props the test can spy on
// (the bare `import * as fs` namespace is non-configurable, so jest.spyOn can't redefine its methods).
jest.mock('fs', () => ({ __esModule: true, ...jest.requireActual<typeof import('fs')>('fs') }));

// fetchSafeBuffer stays REAL by default (the SSRF redaction test below depends on it); individual
// integrity tests queue a one-shot resolved download instead of hitting the network.
jest.mock('./plugin-download', () => {
  const actual = jest.requireActual<typeof import('./plugin-download')>('./plugin-download');
  return { ...actual, fetchSafeBuffer: jest.fn(actual.fetchSafeBuffer) };
});

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import AdmZip from 'adm-zip';
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { PluginsService, isIngressCapable } from './plugins.service';
import { fetchSafeBuffer } from './plugin-download';
import { SECRET_SENTINEL } from './redact-config';
import { PluginLoaderService } from '../../core/plugins/plugin-loader.service';
import { PluginStorageService } from '../../core/plugins/plugin-storage.service';
import { PluginStatus } from '../../core/plugins/plugin.interfaces';
import { HookManager } from '../../core/hooks';

const manifest = { id: 'svc-plg', name: 'Svc Plugin', version: '1.0.0', type: 'extension', main: 'index.js' };

function pkg(over: Record<string, unknown> = {}): Buffer {
  const z = new AdmZip();
  z.addFile('manifest.json', Buffer.from(JSON.stringify({ ...manifest, ...over })));
  z.addFile('index.js', Buffer.from('module.exports = class {};'));
  return z.toBuffer();
}

describe('PluginsService — install / uninstall (real loader + disk)', () => {
  let tmpDir: string;
  let pluginsDir: string;
  let loader: PluginLoaderService;
  let service: PluginsService;
  let pluginStorage: PluginStorageService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-svc-'));
    pluginsDir = path.join(tmpDir, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    const config = {
      get: (k: string) => (k === 'plugins.dir' ? pluginsDir : k === 'dataDir' ? tmpDir : undefined),
    } as unknown as ConfigService;
    pluginStorage = new PluginStorageService(config);
    loader = new PluginLoaderService(config, new HookManager(), pluginStorage, {} as unknown as ModuleRef);
    service = new PluginsService(loader, config);
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('installs a valid package — writes the files, loads it, reports builtIn:false', () => {
    const dto = service.install({ buffer: pkg() });

    expect(dto.id).toBe('svc-plg');
    expect(dto.status).toBe('installed');
    expect(dto.builtIn).toBe(false);
    expect(fs.existsSync(path.join(pluginsDir, 'svc-plg', 'index.js'))).toBe(true);
    expect(loader.getPlugin('svc-plg')).toBeDefined();
  });

  it('rejects an empty upload', () => {
    expect(() => service.install({ buffer: Buffer.alloc(0) })).toThrow(/no plugin file/i);
  });

  it('rejects a duplicate install (already installed)', () => {
    service.install({ buffer: pkg() });
    expect(() => service.install({ buffer: pkg() })).toThrow(/already installed/i);
  });

  it('does not leave a directory behind when the package is invalid', () => {
    // Reserved id is rejected by the parser before anything is written.
    expect(() => service.install({ buffer: pkg({ id: 'baileys' }) })).toThrow(/reserved/i);
    expect(fs.existsSync(path.join(pluginsDir, 'baileys'))).toBe(false);
  });

  it('uninstalls a user plugin — removes its files, registry entry, and runtime instance', async () => {
    service.install({ buffer: pkg() });

    const res = await service.uninstall('svc-plg');

    expect(res.success).toBe(true);
    expect(fs.existsSync(path.join(pluginsDir, 'svc-plg'))).toBe(false);
    expect(loader.getPlugin('svc-plg')).toBeUndefined();
  });

  it('uninstalling an unknown plugin throws NotFound', async () => {
    await expect(service.uninstall('nope')).rejects.toThrow(/not found/i);
  });

  it('updatePackage swaps to the new version and preserves operator config', async () => {
    service.install({ buffer: pkg({ version: '1.0.0' }) });
    service.updateConfig('svc-plg', { apiKey: 'secret-123' });

    const dto = await service.updatePackage('svc-plg', pkg({ version: '2.0.0' }));

    expect(dto.version).toBe('2.0.0');
    // Read view masks config for a schemaless plugin (fail-closed), but the stored value survived the update.
    expect(dto.config).toEqual({ apiKey: SECRET_SENTINEL });
    expect(loader.getPlugin('svc-plg')?.config).toEqual({ apiKey: 'secret-123' });
    expect(fs.existsSync(path.join(pluginsDir, 'svc-plg', 'index.js'))).toBe(true);
    expect(fs.existsSync(path.join(pluginsDir, '.svc-plg.bak'))).toBe(false); // backup cleaned up
  });

  it('preserves ctx.storage state across an in-place package update', async () => {
    service.install({ buffer: pkg({ version: '1.0.0' }) });
    const storage = pluginStorage.createPluginStorage('svc-plg');
    await storage.set('cursor', { lastId: 'msg-42' });

    await service.updatePackage('svc-plg', pkg({ version: '2.0.0' }));

    expect(await storage.get('cursor')).toEqual({ lastId: 'msg-42' });
    const stateFile = fs.readdirSync(path.join(pluginsDir, 'svc-plg')).find(name => /^key-.*\.json$/.test(name));
    expect(stateFile).toBeDefined();
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(pluginsDir, 'svc-plg', stateFile as string)).mode & 0o777).toBe(0o600);
    }
  });

  it('updatePackage rejects a package whose id does not match', async () => {
    service.install({ buffer: pkg() });
    await expect(service.updatePackage('svc-plg', pkg({ id: 'other-plg' }))).rejects.toThrow(/does not match/i);
  });

  it('updatePackage on an unknown plugin throws NotFound', async () => {
    await expect(service.updatePackage('nope', pkg())).rejects.toThrow(/not found/i);
  });

  it('rolls back to the OLD version (loaded, on disk) when the new version fails to enable', async () => {
    service.install({ buffer: pkg({ version: '1.0.0' }) });
    // Pretend it was enabled so the update tries to re-enable — and that re-enable fails for the new version.
    loader.getPlugin('svc-plg')!.status = PluginStatus.ENABLED;
    const enableSpy = jest.spyOn(loader, 'enablePlugin').mockRejectedValue(new Error('worker failed to enable'));

    await expect(service.updatePackage('svc-plg', pkg({ version: '2.0.0' }))).rejects.toThrow(/Failed to update/i);

    // The rollback must leave the OLD version loaded — not the new, half-enabled (ERROR) instance.
    expect(loader.getPlugin('svc-plg')?.manifest.version).toBe('1.0.0');
    expect(fs.existsSync(path.join(pluginsDir, '.svc-plg.bak'))).toBe(false);
    const onDisk = JSON.parse(fs.readFileSync(path.join(pluginsDir, 'svc-plg', 'manifest.json'), 'utf8')) as {
      version: string;
    };
    expect(onDisk.version).toBe('1.0.0');

    enableSpy.mockRestore();
  });

  it('cleans up the staging + backup dirs after a successful update (swap happened)', async () => {
    service.install({ buffer: pkg({ version: '1.0.0' }) });

    const dto = await service.updatePackage('svc-plg', pkg({ version: '2.0.0' }));

    expect(dto.version).toBe('2.0.0');
    expect(loader.getPlugin('svc-plg')?.manifest.version).toBe('2.0.0');
    expect(fs.existsSync(path.join(pluginsDir, '.svc-plg.new'))).toBe(false);
    expect(fs.existsSync(path.join(pluginsDir, '.svc-plg.bak'))).toBe(false);
  });

  it('keeps the old install fully intact when the update fails BEFORE the swap (staging)', async () => {
    service.install({ buffer: pkg({ version: '1.0.0' }) });
    // A package whose entries collide as file-then-directory makes the staging WRITE fail:
    // 'index.js' lands as a file, then 'index.js/extra.js' needs it to be a directory.
    const z = new AdmZip();
    z.addFile('manifest.json', Buffer.from(JSON.stringify({ ...manifest, version: '2.0.0' })));
    z.addFile('index.js', Buffer.from('module.exports = class {};'));
    z.addFile('index.js/extra.js', Buffer.from('module.exports = class {};'));

    await expect(service.updatePackage('svc-plg', z.toBuffer())).rejects.toThrow(/Failed to stage/i);

    // The old version never stopped being the install: still loaded, still on disk, no leftovers.
    expect(loader.getPlugin('svc-plg')?.manifest.version).toBe('1.0.0');
    const onDisk = JSON.parse(fs.readFileSync(path.join(pluginsDir, 'svc-plg', 'manifest.json'), 'utf8')) as {
      version: string;
    };
    expect(onDisk.version).toBe('1.0.0');
    expect(fs.existsSync(path.join(pluginsDir, '.svc-plg.new'))).toBe(false);
    expect(fs.existsSync(path.join(pluginsDir, '.svc-plg.bak'))).toBe(false);
  });

  it('restores the previous version when the swap itself fails mid-way', async () => {
    service.install({ buffer: pkg({ version: '1.0.0' }) });

    // Let the first swap rename (live → backup) through, then fail the second (staging → live).
    const realRename = fs.renameSync;
    const spy = jest.spyOn(fs, 'renameSync').mockImplementation((a: fs.PathLike, b: fs.PathLike) => {
      if (String(a).endsWith('.new')) throw new Error('simulated swap failure');
      return realRename(a, b);
    });

    await expect(service.updatePackage('svc-plg', pkg({ version: '2.0.0' }))).rejects.toThrow(
      /Failed to update plugin/i,
    );
    spy.mockRestore();

    // The failed swap must leave the OLD version loadable: backup restored on disk and reloaded.
    expect(loader.getPlugin('svc-plg')?.manifest.version).toBe('1.0.0');
    const onDisk = JSON.parse(fs.readFileSync(path.join(pluginsDir, 'svc-plg', 'manifest.json'), 'utf8')) as {
      version: string;
    };
    expect(onDisk.version).toBe('1.0.0');
    expect(fs.existsSync(path.join(pluginsDir, '.svc-plg.new'))).toBe(false);
    expect(fs.existsSync(path.join(pluginsDir, '.svc-plg.bak'))).toBe(false);
  });

  it('serializes concurrent lifecycle operations on the same plugin id', async () => {
    service.install({ buffer: pkg() });
    let resolveFirst: () => void = () => undefined;
    const firstDone = new Promise<void>(r => (resolveFirst = r));
    let calls = 0;
    jest.spyOn(loader, 'uninstallPlugin').mockImplementation(() => {
      calls++;
      return calls === 1 ? firstDone : Promise.resolve();
    });

    const p1 = service.uninstall('svc-plg');
    const p2 = service.uninstall('svc-plg');
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(1); // the second op is queued behind the first, not run concurrently

    resolveFirst();
    await Promise.all([p1, p2]);
    expect(calls).toBe(2);
  });

  // A literal link-local IP is rejected synchronously by the SSRF guard before any fetch/DNS, so this
  // is fully offline. The download path follows redirects, so the guard always runs (no opt-out flag);
  // the rejected-IP detail must be redacted from the surfaced BadRequestException (recon oracle).
  it('installFromUrl redacts the resolved internal IP when the SSRF guard blocks the URL', async () => {
    const err = await service.installFromUrl('https://169.254.169.254/pkg.zip').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    const message = (err as BadRequestException).message;
    expect(message).toMatch(/^Failed to download plugin from URL: /);
    expect(message).not.toMatch(/169\.254\.169\.254/);
    expect(message).toBe('Failed to download plugin from URL: Destination address is not allowed');
  });
});

describe('PluginsService — download integrity (optional #sha256 pinning)', () => {
  let tmpDir: string;
  let pluginsDir: string;
  let loader: PluginLoaderService;
  let service: PluginsService;
  const fetchMock = fetchSafeBuffer as unknown as jest.Mock;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-dl-integrity-'));
    pluginsDir = path.join(tmpDir, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    const config = {
      get: (k: string) => (k === 'plugins.dir' ? pluginsDir : k === 'dataDir' ? tmpDir : undefined),
    } as unknown as ConfigService;
    loader = new PluginLoaderService(
      config,
      new HookManager(),
      new PluginStorageService(config),
      {} as unknown as ModuleRef,
    );
    service = new PluginsService(loader, config);
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  /** Queue a one-shot offline download; the mock then falls back to the real (SSRF-guarded) implementation. */
  const serveOnce = (buffer: Buffer): void => {
    fetchMock.mockImplementationOnce(() => Promise.resolve(buffer));
  };
  const sha256 = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex');

  it('installs when the #sha256 fragment matches the downloaded bytes', async () => {
    const buf = pkg();
    serveOnce(buf);

    const dto = await service.installFromUrl(`https://plugins.example/svc-plg.zip#sha256=${sha256(buf)}`);

    expect(dto.id).toBe('svc-plg');
    expect(loader.getPlugin('svc-plg')).toBeDefined();
  });

  it('ignores a ?sha256= query parameter — only the #sha256= fragment pins the digest', async () => {
    const buf = pkg();
    serveOnce(buf);
    const wrong = '0'.repeat(64);

    // The query digest does not match the bytes, yet the install still succeeds on the fragment's
    // verdict: a query param is never an integrity marker (it belongs to the download host).
    const dto = await service.installFromUrl(
      `https://plugins.example/svc-plg.zip?sha256=${wrong}#sha256=${sha256(buf)}`,
    );

    expect(dto.id).toBe('svc-plg');
    expect(loader.getPlugin('svc-plg')).toBeDefined();
  });

  it('fails closed when the pinned digest does not match (package substituted in transit)', async () => {
    serveOnce(pkg());
    const wrong = '0'.repeat(64);

    await expect(service.installFromUrl(`https://plugins.example/svc-plg.zip#sha256=${wrong}`)).rejects.toThrow(
      /integrity check failed/i,
    );

    // Nothing was installed from the substituted bytes.
    expect(loader.getPlugin('svc-plg')).toBeUndefined();
    expect(fs.existsSync(path.join(pluginsDir, 'svc-plg'))).toBe(false);
  });

  it('rejects a malformed integrity marker instead of silently skipping verification', async () => {
    serveOnce(pkg());

    await expect(service.installFromUrl('https://plugins.example/svc-plg.zip#sha256=not-hex')).rejects.toThrow(
      /integrity check failed/i,
    );
    expect(loader.getPlugin('svc-plg')).toBeUndefined();
  });

  it('rejects conflicting markers (fragment vs query disagree)', async () => {
    const buf = pkg();
    serveOnce(buf);
    const other = '1'.repeat(64);

    await expect(
      service.installFromUrl(`https://plugins.example/svc-plg.zip?sha256=${sha256(buf)}#sha256=${other}`),
    ).rejects.toThrow(/integrity check failed/i);
  });

  it('installs without a marker (HTTPS + the SSRF guard remain the baseline)', async () => {
    serveOnce(pkg());

    const dto = await service.installFromUrl('https://plugins.example/svc-plg.zip');

    expect(dto.id).toBe('svc-plg');
  });

  it('updateFromUrl fails closed on a mismatch and leaves the old version intact', async () => {
    service.install({ buffer: pkg({ version: '1.0.0' }) });
    serveOnce(pkg({ version: '2.0.0' }));
    const wrong = '0'.repeat(64);

    await expect(
      service.updateFromUrl('svc-plg', `https://plugins.example/svc-plg.zip#sha256=${wrong}`),
    ).rejects.toThrow(/integrity check failed/i);

    expect(loader.getPlugin('svc-plg')?.manifest.version).toBe('1.0.0');
  });
});

describe('PluginsService — getConfigUiHtml (sandboxed config editor)', () => {
  let tmpDir: string;
  let pluginsDir: string;
  let loader: PluginLoaderService;
  let service: PluginsService;

  const HTML = '<!doctype html><title>cfg</title><script>parent.postMessage({type:"config:get"},"*")</script>';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-cfgui-'));
    pluginsDir = path.join(tmpDir, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    const config = {
      get: (k: string) => (k === 'plugins.dir' ? pluginsDir : k === 'dataDir' ? tmpDir : undefined),
    } as unknown as ConfigService;
    loader = new PluginLoaderService(
      config,
      new HookManager(),
      new PluginStorageService(config),
      {} as unknown as ModuleRef,
    );
    service = new PluginsService(loader, config);
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  function installUi(over: Record<string, unknown> = {}, files: Record<string, string> = {}): void {
    const z = new AdmZip();
    z.addFile(
      'manifest.json',
      Buffer.from(JSON.stringify({ ...manifest, id: 'cfgui-plg', configUi: { entry: 'config/index.html' }, ...over })),
    );
    z.addFile('index.js', Buffer.from('module.exports = class {};'));
    for (const [p, c] of Object.entries(files)) z.addFile(p, Buffer.from(c));
    service.install({ buffer: z.toBuffer() });
  }

  it('serves the configUi entry HTML for an installed plugin', () => {
    installUi({}, { 'config/index.html': HTML });
    expect(service.getConfigUiHtml('cfgui-plg')).toBe(HTML);
  });

  it('exposes configUi on the DTO so the dashboard can render the iframe', () => {
    installUi({ configUi: { entry: 'config/index.html', height: 480 } }, { 'config/index.html': HTML });
    expect(service.findOne('cfgui-plg').configUi).toEqual({ entry: 'config/index.html', height: 480 });
  });

  it('throws NotFound when the plugin does not exist', () => {
    expect(() => service.getConfigUiHtml('ghost')).toThrow(/not found/i);
  });

  it('throws NotFound when the plugin declares no configUi', () => {
    const z = new AdmZip();
    z.addFile('manifest.json', Buffer.from(JSON.stringify({ ...manifest, id: 'no-ui' })));
    z.addFile('index.js', Buffer.from('module.exports = class {};'));
    service.install({ buffer: z.toBuffer() });
    expect(() => service.getConfigUiHtml('no-ui')).toThrow(/config ui/i);
  });

  it('throws NotFound when the entry file is missing from the package', () => {
    installUi({ configUi: { entry: 'config/missing.html' } }, { 'config/index.html': HTML });
    expect(() => service.getConfigUiHtml('cfgui-plg')).toThrow(/not found/i);
  });

  it('rejects a configUi entry that escapes the plugin directory (404, not a 500)', () => {
    installUi({ configUi: { entry: '../../../etc/passwd' } }, { 'config/index.html': HTML });
    expect(() => service.getConfigUiHtml('cfgui-plg')).toThrow(/not found/i);
  });

  it('rejects a non-string configUi entry from an untrusted manifest', () => {
    installUi({ configUi: { entry: 123 } }, { 'config/index.html': HTML });
    expect(() => service.getConfigUiHtml('cfgui-plg')).toThrow(/config ui/i);
  });

  it('rejects a configUi entry that is a symlink escaping the plugin directory', () => {
    installUi({ configUi: { entry: 'config/escape.html' } }, { 'config/index.html': HTML });
    const outside = path.join(tmpDir, 'outside-secret.txt');
    fs.writeFileSync(outside, 'TOP SECRET');
    fs.symlinkSync(outside, path.join(pluginsDir, 'cfgui-plg', 'config', 'escape.html'));
    expect(() => service.getConfigUiHtml('cfgui-plg')).toThrow(/not found/i);
  });
});

describe('PluginsService — per-session config', () => {
  let tmpDir: string;
  let pluginsDir: string;
  let loader: PluginLoaderService;
  let service: PluginsService;

  const schemaManifest = {
    ...manifest,
    id: 'sess-cfg',
    configSchema: {
      type: 'object',
      properties: { apiKey: { type: 'string', secret: true }, lang: { type: 'string' } },
    },
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-sesscfg-'));
    pluginsDir = path.join(tmpDir, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    const config = {
      get: (k: string) => (k === 'plugins.dir' ? pluginsDir : k === 'dataDir' ? tmpDir : undefined),
    } as unknown as ConfigService;
    loader = new PluginLoaderService(
      config,
      new HookManager(),
      new PluginStorageService(config),
      {} as unknown as ModuleRef,
    );
    service = new PluginsService(loader, config);
    const z = new AdmZip();
    z.addFile('manifest.json', Buffer.from(JSON.stringify(schemaManifest)));
    z.addFile('index.js', Buffer.from('module.exports = class {};'));
    service.install({ buffer: z.toBuffer() });
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('stores a per-session override and exposes it (secrets redacted) on the DTO', () => {
    service.updateSessionConfig('sess-cfg', 'sess-A', { apiKey: 'A-secret', lang: 'he' });
    const dto = service.findOne('sess-cfg');
    expect(dto.sessionConfig).toEqual({ 'sess-A': { apiKey: '***', lang: 'he' } });
  });

  it('restores the stored per-session secret when the incoming value is the sentinel', () => {
    service.updateSessionConfig('sess-cfg', 'sess-A', { apiKey: 'A-secret', lang: 'he' });
    // The dashboard PUTs the masked slice back; the real per-session secret must survive.
    service.updateSessionConfig('sess-cfg', 'sess-A', { apiKey: '***', lang: 'en' });
    expect(loader.getPlugin('sess-cfg')?.sessionConfig?.['sess-A']).toEqual({ apiKey: 'A-secret', lang: 'en' });
  });

  it('keeps the base config and per-session overrides independent', () => {
    service.updateConfig('sess-cfg', { apiKey: 'BASE', lang: 'en' });
    service.updateSessionConfig('sess-cfg', 'sess-A', { apiKey: 'A-secret', lang: 'he' });
    const plugin = loader.getPlugin('sess-cfg');
    expect(plugin?.config).toEqual({ apiKey: 'BASE', lang: 'en' });
    expect(plugin?.sessionConfig?.['sess-A']).toEqual({ apiKey: 'A-secret', lang: 'he' });
  });

  // The route is fenced with @RequireUnscopedKey, so the service signature no longer carries a
  // scope argument. updateSessions is a FULL replacement: each write overwrites the entire active
  // set, so the exact array survives each call (setPluginSessions assigns plugin.activeSessions).
  it('fully replaces the active set on each write (single, wildcard, then cleared)', () => {
    expect(service.updateSessions('sess-cfg', ['sess-A']).activeSessions).toEqual(['sess-A']);
    expect(service.updateSessions('sess-cfg', ['*']).activeSessions).toEqual(['*']);
    expect(service.updateSessions('sess-cfg', []).activeSessions).toEqual([]);
  });

  it('lets an unrestricted key activate for all sessions', () => {
    expect(service.updateSessions('sess-cfg', ['*']).activeSessions).toEqual(['*']);
  });

  it('clears the override when an empty slice is written', () => {
    service.updateSessionConfig('sess-cfg', 'sess-A', { lang: 'he' });
    service.updateSessionConfig('sess-cfg', 'sess-A', {});
    expect(loader.getPlugin('sess-cfg')?.sessionConfig?.['sess-A']).toBeUndefined();
  });

  it('404s for an unknown plugin', () => {
    expect(() => service.updateSessionConfig('ghost', 'sess-A', { lang: 'he' })).toThrow(/not found/i);
  });

  it('rejects per-session config for a global (non-session-scoped) plugin with 400', () => {
    const z = new AdmZip();
    z.addFile('manifest.json', Buffer.from(JSON.stringify({ ...manifest, id: 'global-plg', sessionScoped: false })));
    z.addFile('index.js', Buffer.from('module.exports = class {};'));
    service.install({ buffer: z.toBuffer() });
    expect(() => service.updateSessionConfig('global-plg', 'sess-A', { lang: 'he' })).toThrow(BadRequestException);
  });

  // A reload rebuilds the registry entry; it must NOT drop the operator's per-session config or
  // active-session selection. The wipe only surfaces on the SECOND restart (the first still has the
  // pre-wipe in-memory copy), so exercise two reload cycles.
  it('preserves per-session config and active sessions across two restarts', () => {
    const pluginDir = path.join(pluginsDir, 'sess-cfg');
    service.updateSessionConfig('sess-cfg', 'sess-A', { lang: 'he' });
    loader.setPluginSessions('sess-cfg', ['sess-A']);

    const reload = (): PluginLoaderService => {
      const l = new PluginLoaderService(
        {
          get: (k: string) => (k === 'plugins.dir' ? pluginsDir : k === 'dataDir' ? tmpDir : undefined),
        } as unknown as ConfigService,
        new HookManager(),
        new PluginStorageService({
          get: (k: string) => (k === 'plugins.dir' ? pluginsDir : k === 'dataDir' ? tmpDir : undefined),
        } as unknown as ConfigService),
        {} as unknown as ModuleRef,
      );
      l.loadPlugin(pluginDir);
      return l;
    };

    const boot2 = reload();
    expect(boot2.getPlugin('sess-cfg')?.sessionConfig?.['sess-A']).toEqual({ lang: 'he' });
    expect(boot2.getPlugin('sess-cfg')?.activeSessions).toEqual(['sess-A']);

    const boot3 = reload();
    expect(boot3.getPlugin('sess-cfg')?.sessionConfig?.['sess-A']).toEqual({ lang: 'he' });
    expect(boot3.getPlugin('sess-cfg')?.activeSessions).toEqual(['sess-A']);
  });
});

describe('PluginsService i18n passthrough', () => {
  function build(manifestI18n: unknown) {
    const plugin = {
      manifest: { id: 'p', name: 'P', version: '1.0.0', type: 'extension', main: 'dist/index.js', i18n: manifestI18n },
      status: 'enabled',
      config: {},
      activeSessions: ['*'],
    };
    const loader = {
      getAllPlugins: () => [plugin],
      getPlugin: () => plugin,
      isBuiltIn: () => false,
    } as unknown as PluginLoaderService;
    return new PluginsService(loader, { get: () => undefined } as unknown as ConfigService);
  }

  it('surfaces manifest.i18n on the DTO (findOne + findAll)', () => {
    const i18n = { es: { name: 'P-es', config: { k: { title: 'T-es' } } } };
    const svc = build(i18n);
    expect(svc.findOne('p').i18n).toEqual(i18n);
    expect(svc.findAll()[0].i18n).toEqual(i18n);
  });

  it('leaves i18n undefined when the manifest has none', () => {
    const svc = build(undefined);
    expect(svc.findOne('p').i18n).toBeUndefined();
  });
});

describe('isIngressCapable', () => {
  it('is true when the manifest has an ingress route AND the webhook:ingress permission', () => {
    expect(isIngressCapable({ ingress: [{ route: 'events' }], permissions: ['webhook:ingress'] })).toBe(true);
  });
  it('is false without an ingress route', () => {
    expect(isIngressCapable({ ingress: [], permissions: ['webhook:ingress'] })).toBe(false);
    expect(isIngressCapable({ permissions: ['webhook:ingress'] })).toBe(false);
  });
  it('is false without the webhook:ingress permission', () => {
    expect(isIngressCapable({ ingress: [{ route: 'events' }], permissions: [] })).toBe(false);
    expect(isIngressCapable({ ingress: [{ route: 'events' }] })).toBe(false);
  });
});

describe('PluginsService — disable when the plugin is not loaded', () => {
  let tmpDir: string;
  let pluginsDir: string;
  let config: ConfigService;

  const build = () => {
    const storage = new PluginStorageService(config);
    const loader = new PluginLoaderService(config, new HookManager(), storage, {} as unknown as ModuleRef);
    return { storage, loader, service: new PluginsService(loader, config) };
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-disable-'));
    pluginsDir = path.join(tmpDir, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    config = {
      get: (k: string) => (k === 'plugins.dir' ? pluginsDir : k === 'dataDir' ? tmpDir : undefined),
    } as unknown as ConfigService;
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  // Regression: a plugin whose package directory is gone (an interrupted update, or a directory that
  // was never on the data volume) still has a registry entry carrying enabledByOperator — the standing
  // instruction to enable it on every boot. disable() threw NotFound because the loader had nothing to
  // tear down, so the operator could not withdraw that decision by any route: reinstalling the code
  // brought the plugin straight back up.
  it('clears the boot decision for an installed plugin whose code is missing', async () => {
    const first = build();
    first.service.install({ buffer: pkg() });
    first.loader.setOperatorEnabled('svc-plg', true);

    // The code disappears; a restart re-reads the registry but loads nothing.
    fs.rmSync(path.join(pluginsDir, 'svc-plg'), { recursive: true, force: true });
    const restarted = build();
    expect(restarted.loader.getPlugin('svc-plg')).toBeUndefined();
    expect(restarted.storage.getPluginEntry('svc-plg')?.enabledByOperator).toBe(true);

    const res = await restarted.service.disable('svc-plg');

    expect(res.success).toBe(true);
    expect(restarted.storage.getPluginEntry('svc-plg')?.enabledByOperator).toBe(false);
  });

  it('still throws NotFound for an id with no registry entry at all', async () => {
    const { service } = build();
    await expect(service.disable('never-installed')).rejects.toThrow(/not found/i);
  });
});
