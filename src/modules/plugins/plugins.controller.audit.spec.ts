import { PluginsController } from './plugins.controller';
import type { PluginsService } from './plugins.service';
import type { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';

/**
 * A plugin is third-party code that runs in the gateway process, so every successful mutation of one
 * leaves an audit row naming the plugin (the acting key and IP are stamped from the request context).
 */
describe('PluginsController audit trail', () => {
  const plugin = { id: 'relay', version: '1.2.3' };
  const done = { success: true, message: 'ok' };
  let service: Record<string, jest.Mock>;
  let logInfo: jest.Mock;
  let controller: PluginsController;

  beforeEach(() => {
    service = {
      installPackage: jest.fn().mockResolvedValue(plugin),
      installFromUrl: jest.fn().mockResolvedValue(plugin),
      updateFromUrl: jest.fn().mockResolvedValue(plugin),
      enable: jest.fn().mockResolvedValue(done),
      disable: jest.fn().mockResolvedValue(done),
      uninstall: jest.fn().mockResolvedValue(done),
      updateConfig: jest.fn().mockReturnValue(done),
      updateSessionConfig: jest.fn().mockReturnValue(done),
      updateSessions: jest.fn().mockReturnValue(plugin),
    };
    logInfo = jest.fn().mockResolvedValue(null);
    controller = new PluginsController(service as unknown as PluginsService, { logInfo } as unknown as AuditService);
  });

  it('records an upload install with the plugin id and version', async () => {
    await controller.install({ buffer: Buffer.from('zip') });

    expect(logInfo).toHaveBeenCalledWith(AuditAction.PLUGIN_INSTALLED, {
      sessionId: undefined,
      metadata: { pluginId: 'relay', version: '1.2.3', source: 'upload' },
    });
  });

  it('records a URL install with the download host only, never the path, credentials or query', async () => {
    await controller.installFromUrl({ url: 'https://user:secret@plugins.example.com:8443/relay.zip?token=abc' });

    const [action, context] = logInfo.mock.calls[0] as [AuditAction, { metadata: Record<string, unknown> }];
    expect(action).toBe(AuditAction.PLUGIN_INSTALLED);
    expect(context.metadata).toEqual({ pluginId: 'relay', version: '1.2.3', source: 'plugins.example.com:8443' });
    expect(JSON.stringify(context)).not.toMatch(/secret|token/);
  });

  it('records an in-place update with the version it ended on', async () => {
    await controller.update('relay', { url: 'https://plugins.example.com/relay.zip' });

    expect(logInfo).toHaveBeenCalledWith(AuditAction.PLUGIN_UPDATED, {
      sessionId: undefined,
      metadata: { pluginId: 'relay', version: '1.2.3', source: 'plugins.example.com' },
    });
  });

  it.each([
    ['enable', AuditAction.PLUGIN_ENABLED],
    ['disable', AuditAction.PLUGIN_DISABLED],
    ['uninstall', AuditAction.PLUGIN_UNINSTALLED],
  ] as const)('records %s', async (method, action) => {
    await controller[method]('relay');

    expect(logInfo).toHaveBeenCalledWith(action, { sessionId: undefined, metadata: { pluginId: 'relay' } });
  });

  it('records a configuration change by field name, never by value', () => {
    controller.updateConfig('relay', { config: { apiKey: 'sk-live-123', baseUrl: 'https://crm.example.com' } });

    const [action, context] = logInfo.mock.calls[0] as [AuditAction, { metadata: Record<string, unknown> }];
    expect(action).toBe(AuditAction.PLUGIN_CONFIG_UPDATED);
    expect(context.metadata).toEqual({ pluginId: 'relay', fields: ['apiKey', 'baseUrl'] });
    expect(JSON.stringify(context)).not.toContain('sk-live-123');
  });

  it('attributes a per-session configuration change to its session', () => {
    controller.updateSessionConfig('relay', 'sess-1', { config: { baseUrl: 'https://crm.example.com' } });

    expect(logInfo).toHaveBeenCalledWith(AuditAction.PLUGIN_CONFIG_UPDATED, {
      sessionId: 'sess-1',
      metadata: { pluginId: 'relay', fields: ['baseUrl'] },
    });
  });

  it('records which sessions a plugin was activated for', () => {
    controller.updateSessions('relay', { sessions: ['sess-1', 'sess-2'] });

    expect(logInfo).toHaveBeenCalledWith(AuditAction.PLUGIN_SESSIONS_UPDATED, {
      sessionId: undefined,
      metadata: { pluginId: 'relay', sessions: ['sess-1', 'sess-2'] },
    });
  });

  it('writes no row for a call that did not change anything', async () => {
    service.enable.mockResolvedValueOnce({ success: false, message: 'could not start' });
    service.uninstall.mockRejectedValueOnce(new Error('built-in'));

    await controller.enable('relay');
    await expect(controller.uninstall('relay')).rejects.toThrow('built-in');

    expect(logInfo).not.toHaveBeenCalled();
  });

  // The service answers a refused configuration change with 200 and success false (a masked secret list it
  // cannot restore, for one), so the audit row has to follow the outcome and not the call.
  it('writes no row for a configuration change the service refused', () => {
    const refused = { success: false, message: 'could not restore the masked secret' };
    service.updateConfig.mockReturnValueOnce(refused);
    service.updateSessionConfig.mockReturnValueOnce(refused);

    controller.updateConfig('relay', { config: { apiKeys: ['********'] } });
    controller.updateSessionConfig('relay', 'sess-1', { config: { apiKeys: ['********'] } });

    expect(logInfo).not.toHaveBeenCalled();
  });
});
