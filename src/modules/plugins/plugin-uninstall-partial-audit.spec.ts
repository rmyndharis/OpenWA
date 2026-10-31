import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { BadRequestException } from '@nestjs/common';
import { PluginLoaderService } from '../../core/plugins/plugin-loader.service';
import { PluginStorageService } from '../../core/plugins/plugin-storage.service';
import { HookManager } from '../../core/hooks';
import { PluginType } from '../../core/plugins/plugin.interfaces';
import type { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { PluginsController } from './plugins.controller';
import { PluginsService } from './plugins.service';

const manifest = { id: 'p1', name: 'P1', version: '1.0.0', type: 'extension', main: 'index.js' };
function pkg(): Buffer {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)));
  zip.addFile('index.js', Buffer.from('module.exports = class {};'));
  return zip.toBuffer();
}

// An uninstall that fails after it stored the emptied registry entry has already erased the operator's config,
// secrets, session activation and enable decision, and stopped the plugin. It answers 400, and the audit log must
// still say what it changed. A refusal that changed nothing leaves no row.
describe('Audit trail of an uninstall that fails part-way', () => {
  let tmp: string;
  let configService: ConfigService;
  let releaseTakeovers: jest.Mock;
  let storage: PluginStorageService;
  let loader: PluginLoaderService;
  let logInfo: jest.Mock;
  let controller: PluginsController;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-uninstall-partial-'));
    const packagesRoot = path.join(tmp, 'packages');
    fs.mkdirSync(packagesRoot, { recursive: true });
    const values: Record<string, unknown> = { dataDir: path.join(tmp, 'data'), 'plugins.dir': packagesRoot };
    configService = { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
    storage = new PluginStorageService(configService);
    releaseTakeovers = jest.fn().mockResolvedValue(undefined);
    loader = new PluginLoaderService(configService, new HookManager(), storage, {
      get: jest.fn().mockReturnValue({ unregister: jest.fn(), releaseTakeovers }),
    } as unknown as ModuleRef);
    const service = new PluginsService(loader, configService);
    logInfo = jest.fn().mockResolvedValue(null);
    controller = new PluginsController(service, { logInfo } as unknown as AuditService);
    service.install({ buffer: pkg() });
    storage.setPluginConfig('p1', { token: 'operator-secret' });
    storage.setPluginSessions('p1', ['s1']);
    storage.setPluginEnabledByOperator('p1', true);
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('records the uninstall as partial when the takeover release fails after the entry was emptied', async () => {
    // The conversation store cannot answer (a database outage) once the plugin is unloaded.
    releaseTakeovers.mockRejectedValue(new Error('SQLITE_BUSY: database is locked'));

    const failure = await controller.uninstall('p1').catch((error: unknown) => error);

    // The answer itself is the 400 it always was.
    expect(failure).toBeInstanceOf(BadRequestException);
    expect((failure as BadRequestException).getResponse()).toEqual({
      statusCode: 400,
      message: 'SQLITE_BUSY: database is locked',
      error: 'Bad Request',
    });
    const onDisk = new PluginStorageService(configService).getPluginEntry('p1');
    expect(loader.getPlugin('p1')).toBeUndefined();
    expect(onDisk?.config).toEqual({});
    expect(onDisk?.enabledByOperator).toBe(false);
    expect(logInfo).toHaveBeenCalledTimes(1);
    expect(logInfo).toHaveBeenCalledWith(AuditAction.PLUGIN_UNINSTALLED, {
      sessionId: undefined,
      metadata: { pluginId: 'p1', partial: true, error: 'SQLITE_BUSY: database is locked' },
    });
  });

  it('records a repeat that completes as an ordinary uninstall', async () => {
    releaseTakeovers.mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));
    await expect(controller.uninstall('p1')).rejects.toThrow(BadRequestException);

    await expect(controller.uninstall('p1')).resolves.toEqual({
      success: true,
      message: 'Plugin p1 uninstalled successfully',
    });
    expect(logInfo).toHaveBeenLastCalledWith(AuditAction.PLUGIN_UNINSTALLED, {
      sessionId: undefined,
      metadata: { pluginId: 'p1' },
    });
  });

  it('leaves no row for the refusal of a built-in, which changes nothing', async () => {
    const builtIn = { id: 'core', name: 'Core', version: '1.0.0', type: PluginType.EXTENSION, main: 'index.js' };
    loader.registerBuiltInPlugin(builtIn, {}, {});

    await expect(controller.uninstall('core')).rejects.toThrow(BadRequestException);

    expect(loader.getPlugin('core')).toBeDefined();
    expect(logInfo).not.toHaveBeenCalled();
  });
});
