import { ScopeBindingService } from './scope-binding.service';
import { PluginInstanceService } from './plugin-instance.service';
import { PluginLoaderService } from '../../core/plugins/plugin-loader.service';
import { AuditService } from '../audit/audit.service';

// The boot-time reconciler re-derives each ENABLED instance's runtime scope binding from the persisted
// plugin_instances rows, so a binding lost at provisioning time (plugin momentarily unloaded) is
// restored on the next boot without an operator re-PATCH.
describe('ScopeBindingService.onApplicationBootstrap reconciliation', () => {
  // `activeSessions` seeds what the loader restored from registry.json — i.e. the state a prior
  // PUT /api/plugins/:id/sessions persisted, which the boot reconciler must not undo.
  function build(loaded = true, activeSessions: string[] = []) {
    const setPluginSessionConfig = jest.fn();
    const setPluginSessions = jest.fn();
    const updatePluginConfig = jest.fn();
    const loader = {
      getPlugin: jest.fn().mockReturnValue(loaded ? { manifest: { id: 'chatwoot' }, activeSessions } : undefined),
      setPluginSessionConfig,
      setPluginSessions,
      updatePluginConfig,
    } as unknown as PluginLoaderService;
    const audit = { logInfo: jest.fn(), logWarn: jest.fn() } as unknown as AuditService;
    return { loader, audit, setPluginSessionConfig, setPluginSessions, updatePluginConfig };
  }

  /** The session list written by the nth setPluginSessions call, as an order-insensitive set. */
  const sessionsWritten = (mock: jest.Mock, call = 0): Set<string> =>
    new Set((mock.mock.calls[call] as [string, string[]])[1]);

  it('restores an enabled concrete-scope instance (sessionConfig + activeSessions) on boot', async () => {
    const { loader, audit, setPluginSessionConfig, setPluginSessions } = build();
    const instances = {
      listAll: jest
        .fn()
        .mockResolvedValue([
          { pluginId: 'chatwoot', instanceId: 'a', sessionScope: 'sess-1', config: { baseUrl: 'x' }, enabled: true },
        ]),
      list: jest.fn().mockResolvedValue([]),
    } as unknown as PluginInstanceService;

    await new ScopeBindingService(instances, loader, audit).onApplicationBootstrap();

    expect(setPluginSessionConfig).toHaveBeenCalledWith('chatwoot', 'sess-1', { baseUrl: 'x' });
    expect(setPluginSessions).toHaveBeenCalledWith('chatwoot', ['sess-1']);
  });

  // Regression (live 0.12.1 host): an operator had put both plugins on ["*"] via
  // PUT /api/plugins/:id/sessions; it read back and persisted correctly. After a restart the boot
  // reconciler re-derived activeSessions from each instance row's concrete sessionScope and dropped
  // the '*' — binding both plugins to a session id that no longer existed, i.e. to nothing. Nothing
  // warned: the row still read `enabled`, hooks stayed registered, healthCheck stayed green, and the
  // plugins silently received no events. Boot RESTORES bindings, so it must only ever add.
  it('keeps an operator-set "*" when reconciling a concrete-scope instance on boot', async () => {
    const { loader, audit, setPluginSessions } = build(true, ['*']);
    const instances = {
      listAll: jest
        .fn()
        .mockResolvedValue([
          { pluginId: 'chatwoot', instanceId: 'a', sessionScope: 'sess-1', config: {}, enabled: true },
        ]),
      // No siblings: this must pass on the additive boot path alone, NOT on the wildcard-sibling
      // preservation guard, which would mask the bug here.
      list: jest.fn().mockResolvedValue([]),
    } as unknown as PluginInstanceService;

    await new ScopeBindingService(instances, loader, audit).onApplicationBootstrap();

    expect(setPluginSessions).toHaveBeenCalledTimes(1);
    expect(sessionsWritten(setPluginSessions)).toEqual(new Set(['*', 'sess-1']));
  });

  it('does not drop an unrelated already-active concrete session when reconciling on boot', async () => {
    const { loader, audit, setPluginSessions } = build(true, ['sess-other']);
    const instances = {
      listAll: jest
        .fn()
        .mockResolvedValue([
          { pluginId: 'chatwoot', instanceId: 'a', sessionScope: 'sess-1', config: {}, enabled: true },
        ]),
      list: jest.fn().mockResolvedValue([]),
    } as unknown as PluginInstanceService;

    await new ScopeBindingService(instances, loader, audit).onApplicationBootstrap();

    expect(sessionsWritten(setPluginSessions)).toEqual(new Set(['sess-other', 'sess-1']));
  });

  // The counterpart to the regression test above: provisioning IS a decision (the operator just
  // narrowed this plugin to one session), so that path must keep retiring '*' exactly as before.
  it('still retires "*" on a provisioning-time concrete activation (non-boot path unchanged)', async () => {
    const { loader, audit, setPluginSessions } = build(true, ['*']);
    const instances = { list: jest.fn().mockResolvedValue([]) } as unknown as PluginInstanceService;

    await new ScopeBindingService(instances, loader, audit).applyScopeBinding('chatwoot', 'sess-1', {}, true);

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
    const audit = { logInfo: jest.fn(), logWarn: jest.fn() } as unknown as AuditService;

    const wildcard = { pluginId: 'chatwoot', instanceId: 'wild', sessionScope: null, config: {}, enabled: true };
    const concrete = { pluginId: 'chatwoot', instanceId: 'conc', sessionScope: 'sess-1', config: {}, enabled: true };

    for (const rowOrder of [
      [wildcard, concrete], // the order that used to lose '*'
      [concrete, wildcard],
    ] as const) {
      plugin.activeSessions = [];
      const instances = {
        listAll: jest.fn().mockResolvedValue(rowOrder),
        list: jest.fn().mockResolvedValue([]),
      } as unknown as PluginInstanceService;
      await new ScopeBindingService(instances, loader, audit).onApplicationBootstrap();
      // The wildcard activation must survive in both row orders ('*' subsumes the concrete scope).
      expect(plugin.activeSessions).toContain('*');
    }
  });
});
