import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { IntegrationInstanceController } from './integration-instance.controller';
import { PluginInstanceService } from './plugin-instance.service';
import { PluginLoaderService } from '../../core/plugins/plugin-loader.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { AuditService } from '../audit/audit.service';
import { ScopeBindingService } from './scope-binding.service';
import { SessionService } from '../session/session.service';
import { ApiKey } from '../auth/entities/api-key.entity';

// ScopeBindingService reads session rows only for its boot-time "this scope matches no session"
// warning; provisioning never reaches it, so these tests hand it a resolving stub.
const sessions = { findOne: jest.fn().mockResolvedValue({ id: 'sess-1' }) } as unknown as SessionService;

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
    const audit = { logInfo: jest.fn(), logWarn: jest.fn() } as unknown as AuditService;
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
      maskedView: (i: unknown) => i,
    } as unknown as PluginInstanceService;
    const controller = new IntegrationInstanceController(
      instances,
      loader,
      audit,
      new ScopeBindingService(instances, loader, audit, sessions),
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
      new ScopeBindingService(instances, loader, audit, sessions),
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
      new ScopeBindingService(instances, loader, audit, sessions),
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
      new ScopeBindingService(instances, loader, audit, sessions),
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
      new ScopeBindingService(instances, loader, audit, sessions),
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
      new ScopeBindingService(instances, loader, audit, sessions),
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
      new ScopeBindingService(instances, loader, audit, sessions),
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
      new ScopeBindingService(instances, loader, audit, sessions),
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
      new ScopeBindingService(instances, loader, audit, sessions),
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
      new ScopeBindingService(instances, loader, audit, sessions),
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
      new ScopeBindingService(instances, loader, audit, sessions),
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

// sessionScope travels in the request body, which the ApiKeyGuard's route-param fence never sees —
// so the controller itself confines a session-scoped key to instances bound inside its
// allowedSessions (the body-scoping pattern; the plugin updateSessions route is NOT scoped this way
// — it is a full active-set replacement and is fenced with @RequireUnscopedKey).
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
    const audit = { logInfo: jest.fn(), logWarn: jest.fn() } as unknown as AuditService;
    const svc = { maskedView: (i: unknown) => i, ...instances } as unknown as PluginInstanceService;
    const controller = new IntegrationInstanceController(
      svc,
      loader,
      audit,
      new ScopeBindingService(svc, loader, audit, sessions),
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

// The create/regenerate responses are the ONE place plaintext appears — but only for the two fields
// documented as "revealed once" (the ingress secret + verifyToken). Config fields flagged `secret` in
// the plugin's schema must stay masked at any depth even there: a reveal that bypassed maskedView
// would echo a stored provider credential back to the caller.
describe('IntegrationInstanceController reveal masking', () => {
  const configSchema = {
    type: 'object' as const,
    properties: {
      baseUrl: { type: 'string' as const },
      credentials: {
        type: 'object' as const,
        properties: {
          apiToken: { type: 'string' as const, secret: true },
          region: { type: 'string' as const },
        },
      },
      webhooks: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          properties: {
            url: { type: 'string' as const },
            signingKey: { type: 'string' as const, secret: true },
          },
        },
      },
    },
  };

  const storedConfig = {
    baseUrl: 'https://chatwoot.example',
    credentials: { apiToken: 'tok-live-123', region: 'us' },
    webhooks: [{ url: 'https://hook.example', signingKey: 'whsec-live-456' }],
  };

  function build() {
    const loader = {
      getPlugin: jest.fn().mockReturnValue({
        manifest: {
          id: 'chatwoot-adapter',
          ingress: [{ route: 'chatwoot' }],
          permissions: ['webhook:ingress'],
          configSchema,
        },
        activeSessions: [],
      }),
      setPluginSessionConfig: jest.fn(),
      setPluginSessions: jest.fn(),
      updatePluginConfig: jest.fn(),
    } as unknown as PluginLoaderService;
    const audit = { logInfo: jest.fn(), logWarn: jest.fn() } as unknown as AuditService;
    const instance = {
      id: 'chatwoot-adapter:acct1',
      pluginId: 'chatwoot-adapter',
      instanceId: 'acct1',
      sessionScope: 'sess-1',
      secret: 'plaintext-ingress-secret',
      verifyToken: 'verify-token-plain',
      config: storedConfig,
      enabled: true,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    const instances = {
      create: jest.fn().mockResolvedValue(instance),
      resolve: jest.fn().mockResolvedValue(instance),
      regenerateSecret: jest.fn().mockResolvedValue({ ...instance, secret: 'new-plaintext-secret' }),
      list: jest.fn().mockResolvedValue([]),
      // The REAL redaction (not a stub) so the test fails if a reveal path ever bypasses it.
      maskedView: (...args: Parameters<PluginInstanceService['maskedView']>) =>
        PluginInstanceService.prototype.maskedView(...args),
    } as unknown as PluginInstanceService;
    const controller = new IntegrationInstanceController(
      instances,
      loader,
      audit,
      new ScopeBindingService(instances, loader, audit, sessions),
    );
    return { controller };
  }

  function expectMaskedConfig(config: Record<string, unknown>) {
    // Deep secrets masked; non-secret fields (incl. nested + array siblings) still visible.
    expect(config.baseUrl).toBe('https://chatwoot.example');
    expect((config.credentials as Record<string, unknown>).apiToken).toBe('***');
    expect((config.credentials as Record<string, unknown>).region).toBe('us');
    const hooks = config.webhooks as Array<Record<string, unknown>>;
    expect(hooks[0].url).toBe('https://hook.example');
    expect(hooks[0].signingKey).toBe('***');
    expect(JSON.stringify(config)).not.toContain('tok-live-123');
    expect(JSON.stringify(config)).not.toContain('whsec-live-456');
  }

  it('create reveals ONLY the ingress secret + verifyToken; nested config secrets stay masked', async () => {
    const { controller } = build();

    const view = await controller.create('chatwoot-adapter', {
      instanceId: 'acct1',
      sessionScope: 'sess-1',
      verifyToken: 'verify-token-plain',
      config: storedConfig,
    });

    expect(view.secret).toBe('plaintext-ingress-secret');
    expect(view.verifyToken).toBe('verify-token-plain');
    expectMaskedConfig(view.config as Record<string, unknown>);
  });

  it('regenerate-secret reveals the new secret + verifyToken; nested config secrets stay masked', async () => {
    const { controller } = build();

    const view = await controller.regenerate('chatwoot-adapter', 'acct1');

    expect(view.secret).toBe('new-plaintext-secret');
    expect(view.verifyToken).toBe('verify-token-plain');
    expectMaskedConfig(view.config as Record<string, unknown>);
  });

  it('a plain read masks secret, verifyToken, AND config secrets (unchanged behavior)', async () => {
    const { controller } = build();

    const view = await controller.getOne('chatwoot-adapter', 'acct1');

    expect(view.secret).toBe('***');
    expect(view.verifyToken).toBe('***');
    expectMaskedConfig(view.config as Record<string, unknown>);
  });
});

// A successful PATCH must leave an audit row; the metadata names the CHANGED FIELDS only — never the
// values, since a config patch can carry credentials and audit metadata is not a credential store.
describe('IntegrationInstanceController update audit', () => {
  function build() {
    const loader = {
      getPlugin: jest.fn().mockReturnValue({
        manifest: { id: 'chatwoot-adapter', ingress: [{ route: 'chatwoot' }], permissions: ['webhook:ingress'] },
        activeSessions: [],
      }),
      setPluginSessionConfig: jest.fn(),
      setPluginSessions: jest.fn(),
      updatePluginConfig: jest.fn(),
    } as unknown as PluginLoaderService;
    const audit = { logInfo: jest.fn(), logWarn: jest.fn() };
    const instance = {
      id: 'chatwoot-adapter:acct1',
      pluginId: 'chatwoot-adapter',
      instanceId: 'acct1',
      sessionScope: 'sess-1',
      secret: 's',
      verifyToken: null,
      config: { apiToken: 'super-secret-token' },
      enabled: true,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    const instances = {
      resolve: jest.fn().mockResolvedValue(instance),
      setEnabled: jest.fn().mockResolvedValue({ ...instance, enabled: false }),
      update: jest.fn().mockResolvedValue({ ...instance, config: { apiToken: 'rotated-token' } }),
      list: jest.fn().mockResolvedValue([]),
      maskedView: (i: unknown) => i,
    } as unknown as PluginInstanceService;
    const controller = new IntegrationInstanceController(
      instances,
      loader,
      audit as unknown as AuditService,
      new ScopeBindingService(instances, loader, audit as unknown as AuditService, sessions),
    );
    return { controller, audit, instances };
  }

  it('emits INTEGRATION_INSTANCE_UPDATED (INFO) on a successful patch with clean metadata', async () => {
    const { controller, audit } = build();

    await controller.patch('chatwoot-adapter', 'acct1', {
      enabled: false,
      config: { apiToken: 'rotated-token' },
    });

    expect(audit.logInfo).toHaveBeenCalledWith(AuditAction.INTEGRATION_INSTANCE_UPDATED, {
      metadata: { pluginId: 'chatwoot-adapter', instanceId: 'acct1', updated: ['enabled', 'config'] },
    });
    // The metadata must not carry any raw config/secret value.
    const calls = audit.logInfo.mock.calls as Array<[AuditAction, { metadata: Record<string, unknown> }]>;
    expect(JSON.stringify(calls[0][1].metadata)).not.toContain('rotated-token');
    expect(JSON.stringify(calls[0][1].metadata)).not.toContain('super-secret-token');
  });

  it('records a sessionScope-only change without dragging config into the metadata', async () => {
    const { controller, audit } = build();

    await controller.patch('chatwoot-adapter', 'acct1', { sessionScope: 'sess-2' });

    expect(audit.logInfo).toHaveBeenCalledWith(AuditAction.INTEGRATION_INSTANCE_UPDATED, {
      metadata: { pluginId: 'chatwoot-adapter', instanceId: 'acct1', updated: ['sessionScope'] },
    });
  });

  it('does not emit an update row when the patch is rejected', async () => {
    const { controller, audit, instances } = build();
    (instances.resolve as jest.Mock).mockResolvedValue(null);

    await expect(controller.patch('chatwoot-adapter', 'acct1', { enabled: false })).rejects.toThrow(NotFoundException);
    expect(audit.logInfo).not.toHaveBeenCalledWith(AuditAction.INTEGRATION_INSTANCE_UPDATED, expect.anything());
  });
});
