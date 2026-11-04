// A plugin whose manifest says sessionScoped: false runs for every session and has no session activation or
// per-session config. Ingress dispatch layers each instance's own config over the base config for it
// (PluginSandboxBridge.dispatchWebhookForInstance), so an instance of such a plugin needs no scope binding, and
// binding it must not be recorded as a lost binding in the audit log on every provisioning and every boot.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { ScopeBindingService } from './scope-binding.service';
import { PluginInstanceService } from './plugin-instance.service';
import { PluginLoaderService } from '../../core/plugins/plugin-loader.service';
import { PluginStorageService } from '../../core/plugins/plugin-storage.service';
import { HookManager } from '../../core/hooks';
import { AuditService } from '../audit/audit.service';
import { Session } from '../session/entities/session.entity';

describe('scope binding of an instance of a global (sessionScoped: false) ingress plugin', () => {
  let tmpDir: string;
  let loader: PluginLoaderService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-global-'));
    const pluginsDir = path.join(tmpDir, 'plugins');
    const dir = path.join(pluginsDir, 'relay');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({
        id: 'relay',
        name: 'Relay',
        version: '1.0.0',
        type: 'extension',
        main: 'index.js',
        sessionScoped: false,
        configSchema: {
          type: 'object',
          properties: { baseUrl: { type: 'string' }, token: { type: 'string', secret: true } },
        },
        permissions: ['webhook:ingress'],
        ingress: [
          { route: 'in', mode: 'async', verify: 'core', maxBodyBytes: 1024, signature: { scheme: 'hmac-sha256' } },
        ],
      }),
    );
    fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = class {};');
    const config = {
      get: (k: string) => (k === 'plugins.dir' ? pluginsDir : k === 'dataDir' ? tmpDir : undefined),
    } as unknown as ConfigService;
    loader = new PluginLoaderService(config, new HookManager(), new PluginStorageService(config), {} as ModuleRef);
    loader.loadPlugin(dir);
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const service = (rows: Record<string, unknown>[]) => {
    const instances = {
      listAll: jest.fn().mockResolvedValue(rows),
      list: jest.fn().mockResolvedValue(rows),
    } as unknown as PluginInstanceService;
    const logWarn = jest.fn();
    const audit = { logInfo: jest.fn(), logWarn } as unknown as AuditService;
    const sessions = { findOne: jest.fn().mockResolvedValue({ id: 'sess-1' }) } as unknown as Repository<Session>;
    return { svc: new ScopeBindingService(instances, loader, audit, sessions), logWarn };
  };

  it.each([
    ['a concrete scope', 'sess-1'],
    ['the wildcard scope', '*'],
  ])('writes no lost-binding warning for %s at boot', async (_label, sessionScope) => {
    const { svc, logWarn } = service([
      { pluginId: 'relay', instanceId: 'i1', sessionScope, config: { baseUrl: 'https://a.example' }, enabled: true },
    ]);

    await svc.reconcile();

    expect(logWarn).not.toHaveBeenCalled();
  });

  it('projects a wildcard instance into the base config and writes no session state', async () => {
    const { svc, logWarn } = service([]);

    await svc.applyScopeBinding('relay', '*', { baseUrl: 'https://a.example', token: 'T1' }, true);

    const plugin = loader.getPlugin('relay');
    expect(plugin?.config).toMatchObject({ baseUrl: 'https://a.example', token: 'T1' });
    expect(plugin?.activeSessions).toBeUndefined();
    expect(logWarn).not.toHaveBeenCalled();
  });

  it('writes nothing for an instance with a concrete scope', async () => {
    const { svc, logWarn } = service([]);

    await svc.applyScopeBinding('relay', 'sess-1', { baseUrl: 'https://a.example', token: 'T1' }, true);

    const plugin = loader.getPlugin('relay');
    expect(plugin?.config).not.toHaveProperty('token');
    expect(plugin?.sessionConfig).toBeUndefined();
    expect(logWarn).not.toHaveBeenCalled();
  });

  it('still takes back the secret of a wildcard instance that is torn down', async () => {
    const { svc, logWarn } = service([]);
    const projected = { baseUrl: 'https://a.example', token: 'T1' };
    await svc.applyScopeBinding('relay', '*', projected, true);

    await svc.applyScopeBinding('relay', '*', {}, false, { previousConfig: projected });

    expect(loader.getPlugin('relay')?.config.token).toBeNull();
    expect(logWarn).not.toHaveBeenCalled();
  });

  it('keeps the lost-binding warning for a plugin that is not loaded', async () => {
    const { svc, logWarn } = service([]);

    await svc.applyScopeBinding('not-loaded', '*', { baseUrl: 'https://a.example' }, true);

    expect(logWarn).toHaveBeenCalledTimes(1);
  });
});
