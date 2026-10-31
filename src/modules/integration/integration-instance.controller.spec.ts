import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { IntegrationInstanceController } from './integration-instance.controller';
import { PluginInstanceService } from './plugin-instance.service';
import { PluginLoaderService } from '../../core/plugins/plugin-loader.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { AuditService } from '../audit/audit.service';
import { ScopeBindingService } from './scope-binding.service';
import { Repository } from 'typeorm';
import { Session } from '../session/entities/session.entity';
import { ApiKey } from '../auth/entities/api-key.entity';

// ScopeBindingService reads session rows only for its boot-time "this scope matches no session"
// warning; provisioning never reaches it, so these tests hand it a resolving stub.
const sessions = { findOne: jest.fn().mockResolvedValue({ id: 'sess-1' }) } as unknown as Repository<Session>;

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
      update: jest.fn().mockResolvedValue({ ...base, enabled: false }),
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
      update: jest.fn().mockResolvedValue({ ...base, enabled: false }),
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
      update: jest.fn().mockResolvedValue({ ...base, enabled: false }),
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

  describe('a secret removed from a wildcard instance', () => {
    const manifest = {
      id: 'chatwoot-adapter',
      ingress: [{ route: 'chatwoot' }],
      permissions: ['webhook:ingress'],
      configSchema: {
        type: 'object',
        properties: { apiToken: { type: 'string', secret: true }, baseUrl: { type: 'string' } },
      },
    };
    const row = (sessionScope: string | null, config: Record<string, unknown>, enabled = true) => ({
      pluginId: 'chatwoot-adapter',
      instanceId: 'acct1',
      sessionScope,
      config,
      enabled,
    });

    /**
     * `before` is the row PATCH reads; `after` is what update() stores; `others` are the sibling rows. The
     * plugin's base config holds what the instance projected into it, unless `base` says otherwise.
     */
    function patchWith(
      before: ReturnType<typeof row>,
      after: ReturnType<typeof row>,
      others: unknown[] = [],
      base: Record<string, unknown> = before.config,
    ) {
      const { loader, audit, updatePluginConfig, setPluginSessionConfig } = build();
      (loader.getPlugin as jest.Mock).mockReturnValue({ manifest, activeSessions: ['*'], config: base });
      const instances = {
        resolve: jest.fn().mockResolvedValue(before),
        update: jest.fn().mockResolvedValue(after),
        remove: jest.fn().mockResolvedValue(true),
        list: jest.fn().mockResolvedValue([after, ...others]),
        maskedView: (i: unknown) => i,
      } as unknown as PluginInstanceService;
      const controller = new IntegrationInstanceController(
        instances,
        loader,
        audit,
        new ScopeBindingService(instances, loader, audit, sessions),
      );
      return { controller, updatePluginConfig, setPluginSessionConfig };
    }

    /** DELETE reads the row, removes it, then lists what is left: only `others`. */
    function deleteWith(
      before: ReturnType<typeof row>,
      others: unknown[] = [],
      base: Record<string, unknown> = before.config,
    ) {
      const built = patchWith(before, before, others, base);
      const instances = (built.controller as unknown as { instances: { list: jest.Mock } }).instances;
      instances.list.mockResolvedValue(others);
      return built;
    }

    it('is retracted from the plugin base config, where the earlier projection left it', async () => {
      const { controller, updatePluginConfig } = patchWith(
        row(null, { apiToken: 'LEAKED', baseUrl: 'https://crm' }),
        row(null, { baseUrl: 'https://crm' }),
      );

      await controller.patch('chatwoot-adapter', 'acct1', { config: { apiToken: null, baseUrl: 'https://crm' } });

      expect(updatePluginConfig).toHaveBeenCalledWith('chatwoot-adapter', { baseUrl: 'https://crm', apiToken: null });
    });

    it('is also retracted when the config is replaced without it', async () => {
      const { controller, updatePluginConfig } = patchWith(
        row('*', { apiToken: 'LEAKED', baseUrl: 'https://crm' }),
        row('*', { baseUrl: 'https://crm' }),
      );

      await controller.patch('chatwoot-adapter', 'acct1', { config: { baseUrl: 'https://crm' } });

      expect(updatePluginConfig).toHaveBeenCalledWith('chatwoot-adapter', { baseUrl: 'https://crm', apiToken: null });
    });

    it('leaves the base config alone when the instance moves in from a concrete session', async () => {
      const { controller, updatePluginConfig } = patchWith(
        row('sess-1', { apiToken: 'SLICE-ONLY', baseUrl: 'https://crm' }),
        row(null, { baseUrl: 'https://crm' }),
      );

      await controller.patch('chatwoot-adapter', 'acct1', { sessionScope: null });

      expect(updatePluginConfig).toHaveBeenCalledWith('chatwoot-adapter', { baseUrl: 'https://crm' });
    });

    // The wildcard projection only merges, so whatever an instance projected stays in the base config after
    // it stops contributing. Its secrets are taken back when it is disabled, deleted or moved off the scope.
    const held = { apiToken: 'LEAKED', baseUrl: 'https://crm' };

    it('is retracted when the instance moves out to a concrete session, which keeps it in its own slice', async () => {
      const { controller, updatePluginConfig, setPluginSessionConfig } = patchWith(
        row(null, held),
        row('sess-1', held),
      );

      await controller.patch('chatwoot-adapter', 'acct1', { sessionScope: 'sess-1' });

      expect(updatePluginConfig).toHaveBeenCalledTimes(1);
      expect(updatePluginConfig).toHaveBeenCalledWith('chatwoot-adapter', { apiToken: null });
      expect(setPluginSessionConfig).toHaveBeenCalledWith('chatwoot-adapter', 'sess-1', held);
    });

    it('is retracted when the instance is disabled', async () => {
      const { controller, updatePluginConfig } = patchWith(row(null, held), row(null, held, false));

      await controller.patch('chatwoot-adapter', 'acct1', { enabled: false });

      expect(updatePluginConfig).toHaveBeenCalledTimes(1);
      expect(updatePluginConfig).toHaveBeenCalledWith('chatwoot-adapter', { apiToken: null });
    });

    it('is retracted when the instance is deleted', async () => {
      const { controller, updatePluginConfig } = deleteWith(row('*', held));

      await controller.remove('chatwoot-adapter', 'acct1');

      expect(updatePluginConfig).toHaveBeenCalledTimes(1);
      expect(updatePluginConfig).toHaveBeenCalledWith('chatwoot-adapter', { apiToken: null });
    });

    it('is left alone when the plugin config no longer holds the value the instance put there', async () => {
      const { controller, updatePluginConfig } = deleteWith(row(null, held), [], { ...held, apiToken: 'OPERATOR' });

      await controller.remove('chatwoot-adapter', 'acct1');

      expect(updatePluginConfig).not.toHaveBeenCalled();
    });

    it('is handed back as the value another enabled wildcard instance still defines', async () => {
      const sibling = { ...row(null, { apiToken: 'B-TOKEN' }), instanceId: 'acct2' };
      const { controller, updatePluginConfig } = deleteWith(row(null, held), [sibling]);

      await controller.remove('chatwoot-adapter', 'acct1');

      expect(updatePluginConfig).toHaveBeenCalledWith('chatwoot-adapter', { apiToken: 'B-TOKEN' });
    });

    it('stays while the instance only moves between the spellings of the wildcard scope', async () => {
      const { controller, updatePluginConfig } = patchWith(row(null, held), row('*', held));

      await controller.patch('chatwoot-adapter', 'acct1', { sessionScope: '*' });

      expect(updatePluginConfig).toHaveBeenCalledTimes(1);
      expect(updatePluginConfig).toHaveBeenCalledWith('chatwoot-adapter', held);
    });

    it('is not retracted for an instance that was not contributing: disabled, or on a concrete session', async () => {
      const disabled = patchWith(row(null, held, false), row(null, { baseUrl: 'https://crm' }, false));
      await disabled.controller.patch('chatwoot-adapter', 'acct1', { config: { baseUrl: 'https://crm' } });
      expect(disabled.updatePluginConfig).not.toHaveBeenCalled();

      // Enabling it without the secret must not wipe a value the operator set on the plugin meanwhile.
      const enabling = patchWith(row(null, held, false), row(null, { baseUrl: 'https://crm' }));
      await enabling.controller.patch('chatwoot-adapter', 'acct1', { enabled: true });
      expect(enabling.updatePluginConfig).toHaveBeenCalledWith('chatwoot-adapter', { baseUrl: 'https://crm' });

      const concrete = deleteWith(row('sess-1', held));
      await concrete.controller.remove('chatwoot-adapter', 'acct1');
      expect(concrete.updatePluginConfig).not.toHaveBeenCalled();
    });
  });

  it('returns a bound instance to all sessions on PATCH sessionScope:null', async () => {
    const { loader, audit, setPluginSessionConfig, setPluginSessions, updatePluginConfig } = build();
    (loader.getPlugin as jest.Mock).mockReturnValue({
      manifest: { id: 'chatwoot-adapter', ingress: [{ route: 'chatwoot' }], permissions: ['webhook:ingress'] },
      activeSessions: ['sess-1'],
    });
    const base = { pluginId: 'chatwoot-adapter', instanceId: 'acct1', config: { baseUrl: 'https://x' }, enabled: true };
    const update = jest.fn().mockResolvedValue({ ...base, sessionScope: null });
    const instances = {
      resolve: jest.fn().mockResolvedValue({ ...base, sessionScope: 'sess-1' }),
      update,
      // The row is already unscoped when the old scope's teardown lists instances.
      list: jest.fn().mockResolvedValue([{ ...base, sessionScope: null }]),
      maskedView: (i: unknown) => i,
    } as unknown as PluginInstanceService;
    const controller = new IntegrationInstanceController(
      instances,
      loader,
      audit,
      new ScopeBindingService(instances, loader, audit, sessions),
    );

    const view = await controller.patch('chatwoot-adapter', 'acct1', { sessionScope: null });

    expect(update).toHaveBeenCalledWith(
      'chatwoot-adapter',
      'acct1',
      { sessionScope: null, config: undefined },
      undefined,
      { net: undefined, beneath: undefined },
    );
    expect(view.sessionScope).toBeNull();
    expect(setPluginSessionConfig).toHaveBeenCalledWith('chatwoot-adapter', 'sess-1', {}); // old scope torn down
    expect(updatePluginConfig).toHaveBeenCalledWith('chatwoot-adapter', { baseUrl: 'https://x' });
    expect(setPluginSessions).toHaveBeenLastCalledWith('chatwoot-adapter', ['*']);
  });

  it('keeps the session but CLEARS its config when a disabled instance shares its scope with a sibling', async () => {
    const { loader, audit, setPluginSessionConfig, setPluginSessions } = build();
    (loader.getPlugin as jest.Mock).mockReturnValue({
      manifest: { id: 'chatwoot-adapter', ingress: [{ route: 'chatwoot' }], permissions: ['webhook:ingress'] },
      activeSessions: ['sess-1'],
    });
    const base = { pluginId: 'chatwoot-adapter', instanceId: 'acct1', sessionScope: 'sess-1', config: {} };
    const instances = {
      resolve: jest.fn().mockResolvedValue({ ...base, enabled: true }),
      update: jest.fn().mockResolvedValue({ ...base, enabled: false }),
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

    // The sibling still fires on sess-1, so the SESSION stays bound. Its config slice does not: it is
    // keyed by scope and holds the retiring instance's projection, which dispatch would hand to the
    // survivor as soon as this leaves one enabled instance on the scope.
    expect(setPluginSessionConfig).toHaveBeenCalledWith('chatwoot-adapter', 'sess-1', {});
    expect(setPluginSessions).not.toHaveBeenCalled();
  });

  it('keeps the session but CLEARS its config when a deleted instance shares its scope with a sibling', async () => {
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

    // Same rule as the disable path — and the delete case is the sharper one: the row is gone, so the
    // slice is the deleted tenant's only remaining trace and the survivor would inherit it.
    expect(setPluginSessionConfig).toHaveBeenCalledWith('chatwoot-adapter', 'sess-1', {});
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

  it('keeps the OLD scope ACTIVE for an ENABLED sibling on a scope move, and binds the new one', async () => {
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

    // Moving off sess-1 leaves the sibling alone on it, so the slice this instance projected there
    // must go with it — otherwise the sibling inherits the config of a tenant that has moved away.
    expect(setPluginSessionConfig).toHaveBeenCalledWith('chatwoot-adapter', 'sess-1', {});
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
      update: jest.fn().mockResolvedValue({ ...base, enabled: false }),
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

  function build(
    instances: Partial<PluginInstanceService>,
    net?: { allowConfigHosts: string[] },
    config?: Record<string, unknown>,
    loaded = true,
  ) {
    const loader = {
      getPlugin: jest.fn().mockReturnValue(
        loaded
          ? {
              manifest: {
                id: 'chatwoot-adapter',
                ingress: [{ route: 'chatwoot' }],
                permissions: ['webhook:ingress'],
                net,
              },
              config,
              activeSessions: [],
            }
          : undefined,
      ),
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
    await expect(controller.patch('chatwoot-adapter', 'acct1', { sessionScope: null }, scopedKey)).rejects.toThrow(
      ForbiddenException,
    );
    expect(update).not.toHaveBeenCalled();
  });

  // The service holds back a stored secret from a PATCH that moves a host key, but only knows the host keys if
  // the controller hands over the manifest's net rules.
  it('hands the manifest net rules to update(), so a moved host key is told from an unchanged one', async () => {
    const inst = { ...baseInstance, sessionScope: 'sess-1' };
    const update = jest.fn().mockResolvedValue(inst);
    const net = { allowConfigHosts: ['baseUrl'] };
    const { controller } = build({ resolve: jest.fn().mockResolvedValue(inst), update }, net, {
      baseUrl: 'https://base.example',
    });

    await controller.patch('chatwoot-adapter', 'acct1', { config: { baseUrl: 'https://x.example' } }, scopedKey);

    expect(update).toHaveBeenCalledWith('chatwoot-adapter', 'acct1', expect.any(Object), undefined, {
      net,
      beneath: { baseUrl: 'https://base.example' },
    });
  });

  // An instance row outlives its plugin. With the manifest gone there are no host keys to check a write against,
  // and echoing the mask would restore every stored secret beside whatever host the body names.
  it('refuses a config write while the plugin is not loaded', async () => {
    const inst = { ...baseInstance, sessionScope: 'sess-1' };
    const update = jest.fn().mockResolvedValue({ ...inst, enabled: false });
    const { controller } = build({ resolve: jest.fn().mockResolvedValue(inst), update }, undefined, undefined, false);

    await expect(
      controller.patch(
        'chatwoot-adapter',
        'acct1',
        { config: { baseUrl: 'https://evil.example', apiToken: '***' } },
        scopedKey,
      ),
    ).rejects.toThrow(ConflictException);
    expect(update).not.toHaveBeenCalled();
  });

  it('lets a scoped key patch an in-scope instance without touching sessionScope', async () => {
    const inst = { ...baseInstance, sessionScope: 'sess-1' };
    const update = jest.fn().mockResolvedValue({ ...inst, enabled: false });
    const { controller } = build({ resolve: jest.fn().mockResolvedValue(inst), update });

    await controller.patch('chatwoot-adapter', 'acct1', { enabled: false }, scopedKey);

    expect(update).toHaveBeenCalledWith(
      'chatwoot-adapter',
      'acct1',
      { enabled: false, sessionScope: undefined, config: undefined },
      undefined,
      { net: undefined, beneath: undefined },
    );
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
    const setPluginSessions = jest.fn();
    const loader = {
      getPlugin: jest.fn().mockReturnValue({
        manifest: { id: 'chatwoot-adapter', ingress: [{ route: 'chatwoot' }], permissions: ['webhook:ingress'] },
        activeSessions: [],
      }),
      setPluginSessionConfig: jest.fn(),
      setPluginSessions,
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
    const update = jest.fn().mockResolvedValue({ ...instance, config: { apiToken: 'rotated-token' } });
    const instances = {
      resolve: jest.fn().mockResolvedValue(instance),
      update,
      list: jest.fn().mockResolvedValue([]),
      maskedView: (i: unknown) => i,
    } as unknown as PluginInstanceService;
    const controller = new IntegrationInstanceController(
      instances,
      loader,
      audit as unknown as AuditService,
      new ScopeBindingService(instances, loader, audit as unknown as AuditService, sessions),
    );
    return { controller, audit, instances, update, setPluginSessions };
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

  it('answers 404, not 500, when the instance is deleted while the patch is in flight', async () => {
    const { controller, audit, update, setPluginSessions } = build();
    update.mockResolvedValue(null);

    await expect(controller.patch('chatwoot-adapter', 'acct1', { enabled: false })).rejects.toThrow(NotFoundException);
    expect(setPluginSessions).not.toHaveBeenCalled();
    expect(audit.logInfo).not.toHaveBeenCalledWith(AuditAction.INTEGRATION_INSTANCE_UPDATED, expect.anything());
  });

  it('answers 404, not 500, when the instance is deleted while regenerate-secret is in flight', async () => {
    const { controller, audit, instances } = build();
    Object.assign(instances, { regenerateSecret: jest.fn().mockResolvedValue(null) });

    await expect(controller.regenerate('chatwoot-adapter', 'acct1')).rejects.toThrow(NotFoundException);
    expect(audit.logInfo).not.toHaveBeenCalledWith(
      AuditAction.INTEGRATION_INSTANCE_SECRET_REGENERATED,
      expect.anything(),
    );
  });

  // `enabled` rides in the same update() as scope and config, so the row is written by ONE save. A
  // second write could fail after the first landed, leaving the row half-patched with the scope
  // binding and the audit entry skipped.
  it('writes enabled, sessionScope and config in a single update() call', async () => {
    const { controller, update } = build();

    await controller.patch('chatwoot-adapter', 'acct1', {
      enabled: false,
      sessionScope: 'sess-2',
      config: { apiToken: 'rotated-token' },
    });

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      'chatwoot-adapter',
      'acct1',
      { enabled: false, sessionScope: 'sess-2', config: { apiToken: 'rotated-token' } },
      undefined,
      { net: undefined, beneath: undefined },
    );
  });

  // update() can refuse the config with a 400 (a masked secret it cannot restore), before its save.
  // Nothing may be written ahead of it: an `enabled` already saved would stay flipped in the row while
  // the scope binding and the audit entry are skipped, so the DB and the runtime disagree.
  it('persists nothing when the config is rejected, even with enabled in the same body', async () => {
    const { controller, audit, update, setPluginSessions } = build();
    update.mockRejectedValue(new BadRequestException('re-enter the remaining secret values'));

    await expect(
      controller.patch('chatwoot-adapter', 'acct1', { enabled: false, config: { apiToken: '***' } }),
    ).rejects.toThrow(BadRequestException);

    expect(update).toHaveBeenCalledTimes(1);
    expect(setPluginSessions).not.toHaveBeenCalled();
    expect(audit.logInfo).not.toHaveBeenCalledWith(AuditAction.INTEGRATION_INSTANCE_UPDATED, expect.anything());
  });
});

describe('a session-restricted key provisioning an instance', () => {
  it.each(['create', 'config', 'move', 'disable', 'remove'] as const)(
    'leaves the operator all-sessions activation in place on %s',
    async operation => {
      const plugin = {
        manifest: { id: 'adapter', ingress: [{ route: 'event' }], permissions: ['webhook:ingress'] },
        activeSessions: ['*'],
      };
      let row = { id: 'adapter:a', pluginId: 'adapter', instanceId: 'a', enabled: true, sessionScope: 'A', config: {} };
      let present = true;
      const instances = {
        resolve: jest.fn(() => Promise.resolve(present ? row : null)),
        create: jest.fn(() => Promise.resolve(row)),
        update: jest.fn((_plugin: string, _instance: string, patch: Partial<typeof row>) => {
          row = { ...row, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) };
          return Promise.resolve(row);
        }),
        remove: jest.fn(() => {
          present = false;
          return Promise.resolve(true);
        }),
        list: jest.fn(() => Promise.resolve(present ? [row] : [])),
        maskedView: (instance: unknown) => instance,
      } as unknown as PluginInstanceService;
      const loader = {
        getPlugin: () => plugin,
        setPluginSessionConfig: jest.fn(),
        setPluginSessions: (_id: string, active: string[]) => {
          plugin.activeSessions = active;
        },
      } as unknown as PluginLoaderService;
      const audit = { logInfo: jest.fn(), logWarn: jest.fn() } as unknown as AuditService;
      const controller = new IntegrationInstanceController(
        instances,
        loader,
        audit,
        new ScopeBindingService(instances, loader, audit, sessions),
      );
      const key = { allowedSessions: ['A', 'C'], allowedChats: [] } as unknown as ApiKey;

      if (operation === 'create') await controller.create('adapter', { instanceId: 'a', sessionScope: 'A' }, key);
      if (operation === 'config')
        await controller.patch('adapter', 'a', { config: { endpoint: 'https://a.invalid' } }, key);
      if (operation === 'move') await controller.patch('adapter', 'a', { sessionScope: 'C' }, key);
      if (operation === 'disable') await controller.patch('adapter', 'a', { enabled: false }, key);
      if (operation === 'remove') await controller.remove('adapter', 'a', key);

      expect(plugin.activeSessions).toContain('*');
    },
  );
});
