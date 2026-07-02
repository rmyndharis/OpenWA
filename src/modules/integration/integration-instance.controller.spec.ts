import { IntegrationInstanceController } from './integration-instance.controller';
import { PluginInstanceService } from './plugin-instance.service';
import { PluginLoaderService } from '../../core/plugins/plugin-loader.service';
import { AuditService } from '../audit/audit.service';

// The provisioning bridge is what makes a minted instance's config reach the ingress worker: on
// create/patch it mirrors the instance config into the plugin's per-session config and activates the
// bound session; on delete it clears both. dispatchWebhookForInstance then resolves it as ctx.config.
describe('IntegrationInstanceController provisioning bridge', () => {
  function build() {
    const setPluginSessionConfig = jest.fn();
    const setPluginSessions = jest.fn();
    const updatePluginConfig = jest.fn();
    const loader = {
      getPlugin: jest.fn().mockReturnValue({
        manifest: { id: 'chatwoot-adapter', ingress: [{ route: 'chatwoot' }], permissions: ['webhook:ingress'] },
        activeSessions: [],
      }),
      setPluginSessionConfig,
      setPluginSessions,
      updatePluginConfig,
    } as unknown as PluginLoaderService;
    const audit = { logInfo: jest.fn() } as unknown as AuditService;
    return { loader, audit, setPluginSessionConfig, setPluginSessions, updatePluginConfig };
  }

  it('bridges instance config into per-session config + activates the session on create', async () => {
    const { loader, audit, setPluginSessionConfig, setPluginSessions } = build();
    const instances = {
      create: jest.fn().mockResolvedValue({
        id: 'chatwoot-adapter:acct1',
        pluginId: 'chatwoot-adapter',
        instanceId: 'acct1',
        sessionScope: 'sess-1',
        secret: 's',
        verifyToken: null,
        config: { baseUrl: 'https://x' },
        enabled: true,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }),
    } as unknown as PluginInstanceService;
    const controller = new IntegrationInstanceController(instances, loader, audit);

    await controller.create('chatwoot-adapter', {
      instanceId: 'acct1',
      sessionScope: 'sess-1',
      config: { baseUrl: 'https://x' },
    });

    expect(setPluginSessionConfig).toHaveBeenCalledWith('chatwoot-adapter', 'sess-1', { baseUrl: 'https://x' });
    expect(setPluginSessions).toHaveBeenCalledWith('chatwoot-adapter', ['sess-1']);
  });

  it('deactivates the session + clears its config when the instance is disabled (PATCH enabled:false)', async () => {
    const { loader, audit, setPluginSessionConfig, setPluginSessions } = build();
    (loader.getPlugin as jest.Mock).mockReturnValue({
      manifest: { id: 'chatwoot-adapter', ingress: [{ route: 'chatwoot' }], permissions: ['webhook:ingress'] },
      activeSessions: ['sess-1'],
    });
    const base = {
      pluginId: 'chatwoot-adapter',
      instanceId: 'acct1',
      sessionScope: 'sess-1',
      config: { baseUrl: 'https://x' },
    };
    const instances = {
      resolve: jest.fn().mockResolvedValue({ ...base, enabled: true }),
      setEnabled: jest.fn().mockResolvedValue({ ...base, enabled: false }),
      update: jest.fn(),
      maskedView: (i: unknown) => i,
    } as unknown as PluginInstanceService;
    const controller = new IntegrationInstanceController(instances, loader, audit);

    await controller.patch('chatwoot-adapter', 'acct1', { enabled: false });

    // A disabled instance must stop firing outbound: session cleared + removed from activeSessions.
    expect(setPluginSessionConfig).toHaveBeenCalledWith('chatwoot-adapter', 'sess-1', {});
    expect(setPluginSessions).toHaveBeenCalledWith('chatwoot-adapter', []);
  });

  it('tears down the OLD scope when the bound session changes (PATCH sessionScope)', async () => {
    const { loader, audit, setPluginSessionConfig } = build();
    (loader.getPlugin as jest.Mock).mockReturnValue({
      manifest: { id: 'chatwoot-adapter', ingress: [{ route: 'chatwoot' }], permissions: ['webhook:ingress'] },
      activeSessions: ['sess-1'],
    });
    const instances = {
      resolve: jest.fn().mockResolvedValue({
        pluginId: 'chatwoot-adapter',
        instanceId: 'acct1',
        sessionScope: 'sess-1',
        config: { baseUrl: 'https://x' },
        enabled: true,
      }),
      setEnabled: jest.fn(),
      update: jest.fn().mockResolvedValue({
        pluginId: 'chatwoot-adapter',
        instanceId: 'acct1',
        sessionScope: 'sess-2',
        config: { baseUrl: 'https://y' },
        enabled: true,
      }),
      maskedView: (i: unknown) => i,
    } as unknown as PluginInstanceService;
    const controller = new IntegrationInstanceController(instances, loader, audit);

    await controller.patch('chatwoot-adapter', 'acct1', { sessionScope: 'sess-2' });

    expect(setPluginSessionConfig).toHaveBeenCalledWith('chatwoot-adapter', 'sess-1', {}); // old scope torn down
    expect(setPluginSessionConfig).toHaveBeenCalledWith('chatwoot-adapter', 'sess-2', { baseUrl: 'https://y' }); // new bound
  });
});
