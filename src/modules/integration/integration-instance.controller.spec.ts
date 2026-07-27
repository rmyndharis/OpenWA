import { IntegrationInstanceController } from './integration-instance.controller';
import { PluginInstanceService } from './plugin-instance.service';
import { PluginLoaderService } from '../../core/plugins/plugin-loader.service';
import { AuditService } from '../audit/audit.service';
import { ScopeBindingService } from './scope-binding.service';

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
      list: jest.fn().mockResolvedValue([]),
    } as unknown as PluginInstanceService;
    const controller = new IntegrationInstanceController(
      instances,
      loader,
      audit,
      new ScopeBindingService(instances, loader, audit),
    );

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
      list: jest.fn().mockResolvedValue([]), // no sibling shares the scope
      maskedView: (i: unknown) => i,
    } as unknown as PluginInstanceService;
    const controller = new IntegrationInstanceController(
      instances,
      loader,
      audit,
      new ScopeBindingService(instances, loader, audit),
    );

    await controller.patch('chatwoot-adapter', 'acct1', { enabled: false });

    // A disabled instance must stop firing outbound: session cleared + removed from activeSessions.
    expect(setPluginSessionConfig).toHaveBeenCalledWith('chatwoot-adapter', 'sess-1', {});
    expect(setPluginSessions).toHaveBeenCalledWith('chatwoot-adapter', []);
  });

  it('retires the "*" activation when a wildcard-scope instance is disabled and no other wildcard remains', async () => {
    const { loader, audit, setPluginSessions } = build();
    (loader.getPlugin as jest.Mock).mockReturnValue({
      manifest: { id: 'chatwoot-adapter', ingress: [{ route: 'chatwoot' }], permissions: ['webhook:ingress'] },
      activeSessions: ['*'],
    });
    const base = { pluginId: 'chatwoot-adapter', instanceId: 'acct1', sessionScope: '*', config: {} };
    const instances = {
      resolve: jest.fn().mockResolvedValue({ ...base, enabled: true }),
      setEnabled: jest.fn().mockResolvedValue({ ...base, enabled: false }),
      update: jest.fn(),
      list: jest.fn().mockResolvedValue([{ ...base, enabled: false }]), // only this one, now disabled
      maskedView: (i: unknown) => i,
    } as unknown as PluginInstanceService;
    const controller = new IntegrationInstanceController(
      instances,
      loader,
      audit,
      new ScopeBindingService(instances, loader, audit),
    );

    await controller.patch('chatwoot-adapter', 'acct1', { enabled: false });

    // Previously a no-op: a disabled wildcard instance kept firing on every session. Now '*' is retired.
    expect(setPluginSessions).toHaveBeenCalledWith('chatwoot-adapter', []);
  });

  it('keeps "*" active when another enabled wildcard instance remains', async () => {
    const { loader, audit, setPluginSessions } = build();
    (loader.getPlugin as jest.Mock).mockReturnValue({
      manifest: { id: 'chatwoot-adapter', ingress: [{ route: 'chatwoot' }], permissions: ['webhook:ingress'] },
      activeSessions: ['*'],
    });
    const base = { pluginId: 'chatwoot-adapter', instanceId: 'acct1', sessionScope: '*', config: {} };
    const instances = {
      resolve: jest.fn().mockResolvedValue({ ...base, enabled: true }),
      setEnabled: jest.fn().mockResolvedValue({ ...base, enabled: false }),
      update: jest.fn(),
      list: jest.fn().mockResolvedValue([
        { ...base, enabled: false },
        { pluginId: 'chatwoot-adapter', instanceId: 'acct2', sessionScope: '*', config: {}, enabled: true },
      ]),
      maskedView: (i: unknown) => i,
    } as unknown as PluginInstanceService;
    const controller = new IntegrationInstanceController(
      instances,
      loader,
      audit,
      new ScopeBindingService(instances, loader, audit),
    );

    await controller.patch('chatwoot-adapter', 'acct1', { enabled: false });

    // A second wildcard instance is still enabled → '*' must NOT be retired.
    expect(setPluginSessions).not.toHaveBeenCalledWith('chatwoot-adapter', []);
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
      list: jest.fn().mockResolvedValue([]), // no sibling shares the old scope
      maskedView: (i: unknown) => i,
    } as unknown as PluginInstanceService;
    const controller = new IntegrationInstanceController(
      instances,
      loader,
      audit,
      new ScopeBindingService(instances, loader, audit),
    );

    await controller.patch('chatwoot-adapter', 'acct1', { sessionScope: 'sess-2' });

    expect(setPluginSessionConfig).toHaveBeenCalledWith('chatwoot-adapter', 'sess-1', {}); // old scope torn down
    expect(setPluginSessionConfig).toHaveBeenCalledWith('chatwoot-adapter', 'sess-2', { baseUrl: 'https://y' }); // new bound
  });

  it('keeps the session + its config when a disabled instance shares its scope with an ENABLED sibling', async () => {
    const { loader, audit, setPluginSessionConfig, setPluginSessions } = build();
    (loader.getPlugin as jest.Mock).mockReturnValue({
      manifest: { id: 'chatwoot-adapter', ingress: [{ route: 'chatwoot' }], permissions: ['webhook:ingress'] },
      activeSessions: ['sess-1'],
    });
    const base = { pluginId: 'chatwoot-adapter', instanceId: 'acct1', sessionScope: 'sess-1', config: {} };
    const instances = {
      resolve: jest.fn().mockResolvedValue({ ...base, enabled: true }),
      setEnabled: jest.fn().mockResolvedValue({ ...base, enabled: false }),
      update: jest.fn(),
      // The row is already disabled when the teardown lists instances; an ENABLED sibling still binds sess-1.
      list: jest.fn().mockResolvedValue([
        { ...base, enabled: false },
        { pluginId: 'chatwoot-adapter', instanceId: 'acct2', sessionScope: 'sess-1', config: {}, enabled: true },
      ]),
      maskedView: (i: unknown) => i,
    } as unknown as PluginInstanceService;
    const controller = new IntegrationInstanceController(
      instances,
      loader,
      audit,
      new ScopeBindingService(instances, loader, audit),
    );

    await controller.patch('chatwoot-adapter', 'acct1', { enabled: false });

    // The sibling still fires on sess-1: neither the session nor its sessionConfig may be torn down.
    expect(setPluginSessionConfig).not.toHaveBeenCalledWith('chatwoot-adapter', 'sess-1', {});
    expect(setPluginSessions).not.toHaveBeenCalled();
  });

  it('keeps the session + its config when a deleted instance shares its scope with an ENABLED sibling', async () => {
    const { loader, audit, setPluginSessionConfig, setPluginSessions } = build();
    (loader.getPlugin as jest.Mock).mockReturnValue({
      manifest: { id: 'chatwoot-adapter', ingress: [{ route: 'chatwoot' }], permissions: ['webhook:ingress'] },
      activeSessions: ['sess-1'],
    });
    const instances = {
      resolve: jest.fn().mockResolvedValue({
        pluginId: 'chatwoot-adapter',
        instanceId: 'acct1',
        sessionScope: 'sess-1',
        config: {},
        enabled: true,
      }),
      remove: jest.fn().mockResolvedValue(true),
      // The row is already deleted when the teardown lists instances; only the ENABLED sibling remains.
      list: jest
        .fn()
        .mockResolvedValue([
          { pluginId: 'chatwoot-adapter', instanceId: 'acct2', sessionScope: 'sess-1', config: {}, enabled: true },
        ]),
      maskedView: (i: unknown) => i,
    } as unknown as PluginInstanceService;
    const controller = new IntegrationInstanceController(
      instances,
      loader,
      audit,
      new ScopeBindingService(instances, loader, audit),
    );

    await controller.remove('chatwoot-adapter', 'acct1');

    expect(setPluginSessionConfig).not.toHaveBeenCalledWith('chatwoot-adapter', 'sess-1', {});
    expect(setPluginSessions).not.toHaveBeenCalled();
  });

  it('still tears down the session on delete when no ENABLED sibling shares its scope', async () => {
    const { loader, audit, setPluginSessionConfig, setPluginSessions } = build();
    (loader.getPlugin as jest.Mock).mockReturnValue({
      manifest: { id: 'chatwoot-adapter', ingress: [{ route: 'chatwoot' }], permissions: ['webhook:ingress'] },
      activeSessions: ['sess-1'],
    });
    const instances = {
      resolve: jest.fn().mockResolvedValue({
        pluginId: 'chatwoot-adapter',
        instanceId: 'acct1',
        sessionScope: 'sess-1',
        config: {},
        enabled: true,
      }),
      remove: jest.fn().mockResolvedValue(true),
      list: jest.fn().mockResolvedValue([]), // no instances left at all
      maskedView: (i: unknown) => i,
    } as unknown as PluginInstanceService;
    const controller = new IntegrationInstanceController(
      instances,
      loader,
      audit,
      new ScopeBindingService(instances, loader, audit),
    );

    await controller.remove('chatwoot-adapter', 'acct1');

    expect(setPluginSessionConfig).toHaveBeenCalledWith('chatwoot-adapter', 'sess-1', {});
    expect(setPluginSessions).toHaveBeenCalledWith('chatwoot-adapter', []);
  });

  it('keeps the OLD scope bound by an ENABLED sibling on a scope move (PATCH sessionScope) and binds the new one', async () => {
    const { loader, audit, setPluginSessionConfig, setPluginSessions } = build();
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
      // The row is already on sess-2 when the old scope's teardown lists instances; the sibling still binds sess-1.
      list: jest.fn().mockResolvedValue([
        { pluginId: 'chatwoot-adapter', instanceId: 'acct1', sessionScope: 'sess-2', config: {}, enabled: true },
        { pluginId: 'chatwoot-adapter', instanceId: 'acct2', sessionScope: 'sess-1', config: {}, enabled: true },
      ]),
      maskedView: (i: unknown) => i,
    } as unknown as PluginInstanceService;
    const controller = new IntegrationInstanceController(
      instances,
      loader,
      audit,
      new ScopeBindingService(instances, loader, audit),
    );

    await controller.patch('chatwoot-adapter', 'acct1', { sessionScope: 'sess-2' });

    expect(setPluginSessionConfig).not.toHaveBeenCalledWith('chatwoot-adapter', 'sess-1', {}); // old scope kept for the sibling
    expect(setPluginSessionConfig).toHaveBeenCalledWith('chatwoot-adapter', 'sess-2', { baseUrl: 'https://y' }); // new scope bound
    expect(setPluginSessions).toHaveBeenCalledWith('chatwoot-adapter', ['sess-1', 'sess-2']); // sess-1 never stripped
  });

  it('keeps "*" active when a concrete-scope instance is disabled while an ENABLED wildcard sibling remains', async () => {
    const { loader, audit, setPluginSessionConfig, setPluginSessions } = build();
    (loader.getPlugin as jest.Mock).mockReturnValue({
      manifest: { id: 'chatwoot-adapter', ingress: [{ route: 'chatwoot' }], permissions: ['webhook:ingress'] },
      activeSessions: ['*', 'sess-1'],
    });
    const base = { pluginId: 'chatwoot-adapter', instanceId: 'acct1', sessionScope: 'sess-1', config: {} };
    const instances = {
      resolve: jest.fn().mockResolvedValue({ ...base, enabled: true }),
      setEnabled: jest.fn().mockResolvedValue({ ...base, enabled: false }),
      update: jest.fn(),
      list: jest.fn().mockResolvedValue([
        { ...base, enabled: false },
        { pluginId: 'chatwoot-adapter', instanceId: 'acct2', sessionScope: null, config: {}, enabled: true },
      ]),
      maskedView: (i: unknown) => i,
    } as unknown as PluginInstanceService;
    const controller = new IntegrationInstanceController(
      instances,
      loader,
      audit,
      new ScopeBindingService(instances, loader, audit),
    );

    await controller.patch('chatwoot-adapter', 'acct1', { enabled: false });

    // Its own scope is torn down (no concrete sibling), but the wildcard sibling's '*' must survive.
    expect(setPluginSessionConfig).toHaveBeenCalledWith('chatwoot-adapter', 'sess-1', {});
    expect(setPluginSessions).toHaveBeenCalledWith('chatwoot-adapter', ['*']);
  });

  it('keeps "*" when a concrete-scope instance is created while an ENABLED wildcard instance exists', async () => {
    const { loader, audit, setPluginSessionConfig, setPluginSessions } = build();
    (loader.getPlugin as jest.Mock).mockReturnValue({
      manifest: { id: 'chatwoot-adapter', ingress: [{ route: 'chatwoot' }], permissions: ['webhook:ingress'] },
      activeSessions: ['*'],
    });
    const instances = {
      create: jest.fn().mockResolvedValue({
        id: 'chatwoot-adapter:acct2',
        pluginId: 'chatwoot-adapter',
        instanceId: 'acct2',
        sessionScope: 'sess-1',
        secret: 's',
        verifyToken: null,
        config: { baseUrl: 'https://x' },
        enabled: true,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }),
      list: jest.fn().mockResolvedValue([
        { pluginId: 'chatwoot-adapter', instanceId: 'acct1', sessionScope: '*', config: {}, enabled: true },
        { pluginId: 'chatwoot-adapter', instanceId: 'acct2', sessionScope: 'sess-1', config: {}, enabled: true },
      ]),
      maskedView: (i: unknown) => i,
    } as unknown as PluginInstanceService;
    const controller = new IntegrationInstanceController(
      instances,
      loader,
      audit,
      new ScopeBindingService(instances, loader, audit),
    );

    await controller.create('chatwoot-adapter', {
      instanceId: 'acct2',
      sessionScope: 'sess-1',
      config: { baseUrl: 'https://x' },
    });

    // Previously the concrete activation stripped '*', silencing the wildcard instance until the next boot.
    expect(setPluginSessionConfig).toHaveBeenCalledWith('chatwoot-adapter', 'sess-1', { baseUrl: 'https://x' });
    expect(setPluginSessions).toHaveBeenCalledWith('chatwoot-adapter', ['sess-1', '*']);
  });
});
