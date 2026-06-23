import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { PluginsService } from './plugins.service';
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

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-svc-'));
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
    expect(dto.config).toEqual({ apiKey: 'secret-123' }); // config survived the in-place update
    expect(fs.existsSync(path.join(pluginsDir, 'svc-plg', 'index.js'))).toBe(true);
    expect(fs.existsSync(path.join(pluginsDir, 'svc-plg.bak'))).toBe(false); // backup cleaned up
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
    expect(fs.existsSync(path.join(pluginsDir, 'svc-plg.bak'))).toBe(false);
    const onDisk = JSON.parse(fs.readFileSync(path.join(pluginsDir, 'svc-plg', 'manifest.json'), 'utf8')) as {
      version: string;
    };
    expect(onDisk.version).toBe('1.0.0');

    enableSpy.mockRestore();
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

  // A session-restricted API key must not activate the plugin for sessions outside its allowedSessions
  // scope (the target sessions are in the request body the guard never inspects).
  it('rejects activating for a session outside a restricted key scope', () => {
    expect(() => service.updateSessions('sess-cfg', ['sess-B'], ['sess-A'])).toThrow(/not authorized/i);
    expect(() => service.updateSessions('sess-cfg', ['*'], ['sess-A'])).toThrow(/not authorized/i);
  });

  it('allows a restricted key to activate only within its scope', () => {
    expect(service.updateSessions('sess-cfg', ['sess-A'], ['sess-A']).activeSessions).toEqual(['sess-A']);
  });

  it('lets an unrestricted key activate for all sessions', () => {
    expect(service.updateSessions('sess-cfg', ['*'], undefined).activeSessions).toEqual(['*']);
    expect(service.updateSessions('sess-cfg', ['*'], []).activeSessions).toEqual(['*']);
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
