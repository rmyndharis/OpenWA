import { ScopeBindingService } from './scope-binding.service';
import { PluginInstanceService } from './plugin-instance.service';
import { PluginLoaderService } from '../../core/plugins/plugin-loader.service';
import { AuditService } from '../audit/audit.service';

// The boot-time reconciler re-derives each ENABLED instance's runtime scope binding from the persisted
// plugin_instances rows, so a binding lost at provisioning time (plugin momentarily unloaded) is
// restored on the next boot without an operator re-PATCH.
describe('ScopeBindingService.onApplicationBootstrap reconciliation', () => {
  function build(loaded = true) {
    const setPluginSessionConfig = jest.fn();
    const setPluginSessions = jest.fn();
    const updatePluginConfig = jest.fn();
    const loader = {
      getPlugin: jest.fn().mockReturnValue(loaded ? { manifest: { id: 'chatwoot' }, activeSessions: [] } : undefined),
      setPluginSessionConfig,
      setPluginSessions,
      updatePluginConfig,
    } as unknown as PluginLoaderService;
    const audit = { logInfo: jest.fn() } as unknown as AuditService;
    return { loader, audit, setPluginSessionConfig, setPluginSessions, updatePluginConfig };
  }

  it('restores an enabled concrete-scope instance (sessionConfig + activeSessions) on boot', async () => {
    const { loader, audit, setPluginSessionConfig, setPluginSessions } = build();
    const instances = {
      listAll: jest
        .fn()
        .mockResolvedValue([
          { pluginId: 'chatwoot', instanceId: 'a', sessionScope: 'sess-1', config: { baseUrl: 'x' }, enabled: true },
        ]),
    } as unknown as PluginInstanceService;

    await new ScopeBindingService(instances, loader, audit).onApplicationBootstrap();

    expect(setPluginSessionConfig).toHaveBeenCalledWith('chatwoot', 'sess-1', { baseUrl: 'x' });
    expect(setPluginSessions).toHaveBeenCalledWith('chatwoot', ['sess-1']);
  });

  it('restores an enabled wildcard/null-scope instance as base config + ["*"]', async () => {
    const { loader, audit, updatePluginConfig, setPluginSessions } = build();
    const instances = {
      listAll: jest
        .fn()
        .mockResolvedValue([
          { pluginId: 'chatwoot', instanceId: 'a', sessionScope: null, config: { token: 't' }, enabled: true },
        ]),
    } as unknown as PluginInstanceService;

    await new ScopeBindingService(instances, loader, audit).onApplicationBootstrap();

    expect(updatePluginConfig).toHaveBeenCalledWith('chatwoot', { token: 't' });
    expect(setPluginSessions).toHaveBeenCalledWith('chatwoot', ['*']);
  });

  it('does NOT activate a disabled instance (honors the real enabled flag, never force-activates)', async () => {
    const { loader, audit, setPluginSessionConfig, setPluginSessions } = build();
    const instances = {
      listAll: jest
        .fn()
        .mockResolvedValue([
          { pluginId: 'chatwoot', instanceId: 'a', sessionScope: 'sess-1', config: {}, enabled: false },
        ]),
    } as unknown as PluginInstanceService;

    await new ScopeBindingService(instances, loader, audit).onApplicationBootstrap();

    expect(setPluginSessionConfig).not.toHaveBeenCalled();
    expect(setPluginSessions).not.toHaveBeenCalled();
  });

  it('skips an instance whose plugin is not loaded', async () => {
    const { loader, audit, setPluginSessions } = build(/* loaded */ false);
    const instances = {
      listAll: jest
        .fn()
        .mockResolvedValue([{ pluginId: 'ghost', instanceId: 'a', sessionScope: 'sess-1', config: {}, enabled: true }]),
    } as unknown as PluginInstanceService;

    await new ScopeBindingService(instances, loader, audit).onApplicationBootstrap();

    expect(setPluginSessions).not.toHaveBeenCalled();
  });

  it('does not throw when listing instances fails (reconciliation is best-effort)', async () => {
    const { loader, audit } = build();
    const instances = {
      listAll: jest.fn().mockRejectedValue(new Error('db down')),
    } as unknown as PluginInstanceService;

    await expect(new ScopeBindingService(instances, loader, audit).onApplicationBootstrap()).resolves.toBeUndefined();
  });

  it('ends at ["*"] for a plugin with a wildcard + concrete instance regardless of DB row order (order-independent)', async () => {
    // Simulate the real loader, where setPluginSessions MUTATES the plugin's activeSessions so a later
    // applyScopeBinding reads the prior write — the exact shared-state mutation that made the old
    // unordered loop order-dependent (a concrete scope processed after a wildcard used to strip '*').
    const plugin = { manifest: { id: 'chatwoot' }, activeSessions: [] as string[] };
    const loader = {
      getPlugin: jest.fn(() => plugin),
      setPluginSessionConfig: jest.fn(),
      setPluginSessions: jest.fn((_id: string, sessions: string[]) => {
        plugin.activeSessions = sessions;
      }),
      updatePluginConfig: jest.fn(),
    } as unknown as PluginLoaderService;
    const audit = { logInfo: jest.fn() } as unknown as AuditService;

    const wildcard = { pluginId: 'chatwoot', instanceId: 'wild', sessionScope: null, config: {}, enabled: true };
    const concrete = { pluginId: 'chatwoot', instanceId: 'conc', sessionScope: 'sess-1', config: {}, enabled: true };

    for (const rowOrder of [
      [wildcard, concrete], // the order that used to lose '*'
      [concrete, wildcard],
    ] as const) {
      plugin.activeSessions = [];
      const instances = { listAll: jest.fn().mockResolvedValue(rowOrder) } as unknown as PluginInstanceService;
      await new ScopeBindingService(instances, loader, audit).onApplicationBootstrap();
      // The wildcard activation must survive in both row orders ('*' subsumes the concrete scope).
      expect(plugin.activeSessions).toContain('*');
    }
  });
});
