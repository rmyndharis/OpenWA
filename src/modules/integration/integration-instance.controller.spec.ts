import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { IntegrationInstanceController } from './integration-instance.controller';
import { PluginInstanceService } from './plugin-instance.service';
import { PluginLoaderService } from '../../core/plugins/plugin-loader.service';
import { AuditService } from '../audit/audit.service';
import { ScopeBindingService } from './scope-binding.service';
import { ApiKey } from '../auth/entities/api-key.entity';

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
});

// sessionScope travels in the request body, which the ApiKeyGuard's route-param fence never sees —
// so the controller itself confines a session-scoped key to instances bound inside its
// allowedSessions (the same pattern plugins.controller uses for updateSessions).
describe('IntegrationInstanceController session-scope fence', () => {
  const scopedKey = { allowedSessions: ['sess-1'] } as ApiKey;
  const unrestrictedKey = { allowedSessions: null } as unknown as ApiKey;

  function build(instances: Partial<PluginInstanceService>) {
    const loader = {
      getPlugin: jest.fn().mockReturnValue({
        manifest: { id: 'chatwoot-adapter', ingress: [{ route: 'chatwoot' }], permissions: ['webhook:ingress'] },
        activeSessions: [],
      }),
      setPluginSessionConfig: jest.fn(),
      setPluginSessions: jest.fn(),
      updatePluginConfig: jest.fn(),
    } as unknown as PluginLoaderService;
    const audit = { logInfo: jest.fn() } as unknown as AuditService;
    const svc = { maskedView: (i: unknown) => i, ...instances } as unknown as PluginInstanceService;
    const controller = new IntegrationInstanceController(
      svc,
      loader,
      audit,
      new ScopeBindingService(svc, loader, audit),
    );
    return { controller, svc };
  }

  const baseInstance = {
    id: 'chatwoot-adapter:acct1',
    pluginId: 'chatwoot-adapter',
    instanceId: 'acct1',
    sessionScope: 'sess-2',
    secret: 's',
    verifyToken: null,
    config: null,
    enabled: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };

  it('lets a scoped key create an instance bound to one of its own sessions', async () => {
    const create = jest.fn().mockResolvedValue({ ...baseInstance, sessionScope: 'sess-1' });
    const { controller } = build({ create });

    await controller.create('chatwoot-adapter', { instanceId: 'acct1', sessionScope: 'sess-1' }, scopedKey);

    expect(create).toHaveBeenCalled();
  });

  it('rejects create when sessionScope is outside the key fence — or omitted (all sessions)', async () => {
    const create = jest.fn();
    const { controller } = build({ create });

    await expect(
      controller.create('chatwoot-adapter', { instanceId: 'acct1', sessionScope: 'sess-2' }, scopedKey),
    ).rejects.toThrow(ForbiddenException);
    await expect(controller.create('chatwoot-adapter', { instanceId: 'acct1' }, scopedKey)).rejects.toThrow(
      ForbiddenException,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('lets an unrestricted key create an all-sessions instance', async () => {
    const create = jest.fn().mockResolvedValue({ ...baseInstance, sessionScope: null });
    const { controller } = build({ create });

    await controller.create('chatwoot-adapter', { instanceId: 'acct1' }, unrestrictedKey);

    expect(create).toHaveBeenCalled();
  });

  it('filters the list to instances inside the key fence', async () => {
    const { controller } = build({
      list: jest.fn().mockResolvedValue([
        { ...baseInstance, instanceId: 'own', sessionScope: 'sess-1' },
        { ...baseInstance, instanceId: 'other', sessionScope: 'sess-2' },
        { ...baseInstance, instanceId: 'global', sessionScope: null },
      ]),
    });

    const views = await controller.list('chatwoot-adapter', scopedKey);

    expect(views.map(v => v.instanceId)).toEqual(['own']);
  });

  it('answers 404 for getOne/regenerate/delete on an out-of-scope instance', async () => {
    const resolve = jest.fn().mockResolvedValue(baseInstance); // sessionScope: 'sess-2'
    const regenerateSecret = jest.fn();
    const remove = jest.fn();
    const { controller } = build({ resolve, regenerateSecret, remove });

    await expect(controller.getOne('chatwoot-adapter', 'acct1', scopedKey)).rejects.toThrow(NotFoundException);
    await expect(controller.regenerate('chatwoot-adapter', 'acct1', scopedKey)).rejects.toThrow(NotFoundException);
    await expect(controller.remove('chatwoot-adapter', 'acct1', scopedKey)).rejects.toThrow(NotFoundException);
    expect(regenerateSecret).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('answers 404 when patching an out-of-scope instance', async () => {
    const update = jest.fn();
    const { controller } = build({ resolve: jest.fn().mockResolvedValue(baseInstance), update });

    await expect(controller.patch('chatwoot-adapter', 'acct1', { enabled: false }, scopedKey)).rejects.toThrow(
      NotFoundException,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects moving an in-scope instance to a session outside the fence', async () => {
    const update = jest.fn();
    const { controller } = build({
      resolve: jest.fn().mockResolvedValue({ ...baseInstance, sessionScope: 'sess-1' }),
      update,
    });

    await expect(controller.patch('chatwoot-adapter', 'acct1', { sessionScope: 'sess-2' }, scopedKey)).rejects.toThrow(
      ForbiddenException,
    );
    // An explicit null (all sessions) is likewise outside a scoped key's fence.
    await expect(
      controller.patch('chatwoot-adapter', 'acct1', { sessionScope: null as unknown as string }, scopedKey),
    ).rejects.toThrow(ForbiddenException);
    expect(update).not.toHaveBeenCalled();
  });

  it('lets a scoped key patch an in-scope instance without touching sessionScope', async () => {
    const inst = { ...baseInstance, sessionScope: 'sess-1' };
    const setEnabled = jest.fn().mockResolvedValue({ ...inst, enabled: false });
    const { controller } = build({ resolve: jest.fn().mockResolvedValue(inst), setEnabled, update: jest.fn() });

    await controller.patch('chatwoot-adapter', 'acct1', { enabled: false }, scopedKey);

    expect(setEnabled).toHaveBeenCalledWith('chatwoot-adapter', 'acct1', false);
  });
});
