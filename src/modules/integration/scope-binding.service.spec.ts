import { Repository } from 'typeorm';
import { ScopeBindingService } from './scope-binding.service';
import { PluginInstanceService } from './plugin-instance.service';
import { PluginLoaderService } from '../../core/plugins/plugin-loader.service';
import { AuditService } from '../audit/audit.service';
import { Session } from '../session/entities/session.entity';

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
    // Default: every bound scope resolves to a real session row, so the missing-session warning stays
    // quiet unless a test asks for it (the repository findOne resolves null for a gone row).
    const sessions = { findOne: jest.fn().mockResolvedValue({ id: 'sess-1' }) } as unknown as Repository<Session>;
    return { loader, audit, sessions, setPluginSessionConfig, setPluginSessions, updatePluginConfig };
  }

  /** The service's own logger, for asserting the boot-time missing-session warning. */
  const loggerOf = (svc: ScopeBindingService): { warn: jest.Mock } =>
    (svc as unknown as { logger: { warn: jest.Mock } }).logger;

  /** The session list written by the nth setPluginSessions call, as an order-insensitive set. */
  const sessionsWritten = (mock: jest.Mock, call = 0): Set<string> =>
    new Set((mock.mock.calls[call] as [string, string[]])[1]);

  it('restores an enabled concrete-scope instance (sessionConfig + activeSessions) on boot', async () => {
    const { loader, audit, sessions, setPluginSessionConfig, setPluginSessions } = build();
    const instances = {
      listAll: jest
        .fn()
        .mockResolvedValue([
          { pluginId: 'chatwoot', instanceId: 'a', sessionScope: 'sess-1', config: { baseUrl: 'x' }, enabled: true },
        ]),
      list: jest.fn().mockResolvedValue([]),
    } as unknown as PluginInstanceService;

    await new ScopeBindingService(instances, loader, audit, sessions).onApplicationBootstrap();

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
    const { loader, audit, sessions, setPluginSessions } = build(true, ['*']);
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

    await new ScopeBindingService(instances, loader, audit, sessions).onApplicationBootstrap();

    expect(setPluginSessions).toHaveBeenCalledTimes(1);
    expect(sessionsWritten(setPluginSessions)).toEqual(new Set(['*', 'sess-1']));
  });

  it('does not drop an unrelated already-active concrete session when reconciling on boot', async () => {
    const { loader, audit, sessions, setPluginSessions } = build(true, ['sess-other']);
    const instances = {
      listAll: jest
        .fn()
        .mockResolvedValue([
          { pluginId: 'chatwoot', instanceId: 'a', sessionScope: 'sess-1', config: {}, enabled: true },
        ]),
      list: jest.fn().mockResolvedValue([]),
    } as unknown as PluginInstanceService;

    await new ScopeBindingService(instances, loader, audit, sessions).onApplicationBootstrap();

    expect(sessionsWritten(setPluginSessions)).toEqual(new Set(['sess-other', 'sess-1']));
  });

  // The counterpart to the regression test above: provisioning IS a decision (the operator just
  // narrowed this plugin to one session), so that path must keep retiring '*' exactly as before.
  it('still retires "*" on a provisioning-time concrete activation (non-boot path unchanged)', async () => {
    const { loader, audit, sessions, setPluginSessions } = build(true, ['*']);
    const instances = { list: jest.fn().mockResolvedValue([]) } as unknown as PluginInstanceService;

    await new ScopeBindingService(instances, loader, audit, sessions).applyScopeBinding('chatwoot', 'sess-1', {}, true);

    expect(setPluginSessions).toHaveBeenCalledWith('chatwoot', ['sess-1']);
  });

  it('restores an enabled wildcard/null-scope instance as base config + ["*"]', async () => {
    const { loader, audit, sessions, updatePluginConfig, setPluginSessions } = build();
    const instances = {
      listAll: jest
        .fn()
        .mockResolvedValue([
          { pluginId: 'chatwoot', instanceId: 'a', sessionScope: null, config: { token: 't' }, enabled: true },
        ]),
    } as unknown as PluginInstanceService;

    await new ScopeBindingService(instances, loader, audit, sessions).onApplicationBootstrap();

    expect(updatePluginConfig).toHaveBeenCalledWith('chatwoot', { token: 't' });
    expect(setPluginSessions).toHaveBeenCalledWith('chatwoot', ['*']);
  });

  it('does NOT activate a disabled instance (honors the real enabled flag, never force-activates)', async () => {
    const { loader, audit, sessions, setPluginSessionConfig, setPluginSessions } = build();
    const instances = {
      listAll: jest
        .fn()
        .mockResolvedValue([
          { pluginId: 'chatwoot', instanceId: 'a', sessionScope: 'sess-1', config: {}, enabled: false },
        ]),
    } as unknown as PluginInstanceService;

    await new ScopeBindingService(instances, loader, audit, sessions).onApplicationBootstrap();

    expect(setPluginSessionConfig).not.toHaveBeenCalled();
    expect(setPluginSessions).not.toHaveBeenCalled();
  });

  it('skips an instance whose plugin is not loaded', async () => {
    const { loader, audit, sessions, setPluginSessions } = build(/* loaded */ false);
    const instances = {
      listAll: jest
        .fn()
        .mockResolvedValue([{ pluginId: 'ghost', instanceId: 'a', sessionScope: 'sess-1', config: {}, enabled: true }]),
    } as unknown as PluginInstanceService;

    await new ScopeBindingService(instances, loader, audit, sessions).onApplicationBootstrap();

    expect(setPluginSessions).not.toHaveBeenCalled();
  });

  it('does not throw when listing instances fails (reconciliation is best-effort)', async () => {
    const { loader, audit, sessions } = build();
    const instances = {
      listAll: jest.fn().mockRejectedValue(new Error('db down')),
    } as unknown as PluginInstanceService;

    await expect(
      new ScopeBindingService(instances, loader, audit, sessions).onApplicationBootstrap(),
    ).resolves.toBeUndefined();
  });

  it('logs a failure after the listing without blaming the listing', async () => {
    const { loader, audit, sessions } = build();
    const instances = {
      listAll: jest
        .fn()
        .mockResolvedValue([
          { pluginId: 'chatwoot', instanceId: 'a', sessionScope: 'sess-1', config: {}, enabled: true },
        ]),
    } as unknown as PluginInstanceService;
    const svc = new ScopeBindingService(instances, loader, audit, sessions);
    jest.spyOn(svc, 'applyScopeBinding').mockRejectedValue(new Error('bind failed'));
    const error = jest.spyOn((svc as unknown as { logger: { error: jest.Mock } }).logger, 'error');
    error.mockImplementation(() => undefined);

    await expect(svc.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith('Scope-binding reconciliation failed', 'Error: bind failed');
  });

  // A scope pointing at a deleted session binds the plugin to nothing, and every other signal an
  // operator can read (instance `enabled`, plugin `status`, healthCheck) stays green — so the log line
  // is the only place the inertness can surface.
  it('warns when an enabled instance is bound to a session that no longer exists', async () => {
    const { loader, audit, setPluginSessions } = build();
    const instances = {
      listAll: jest
        .fn()
        .mockResolvedValue([
          { pluginId: 'chatwoot', instanceId: 'main', sessionScope: 'gone-sess', config: {}, enabled: true },
        ]),
      list: jest.fn().mockResolvedValue([]),
    } as unknown as PluginInstanceService;
    const sessions = { findOne: jest.fn().mockResolvedValue(null) } as unknown as Repository<Session>;

    const svc = new ScopeBindingService(instances, loader, audit, sessions);
    const warn = jest.spyOn(loggerOf(svc), 'warn').mockImplementation(() => undefined);
    await svc.onApplicationBootstrap();

    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toContain('chatwoot');
    expect(message).toContain('main');
    expect(message).toContain('gone-sess');
    // Warning only — the binding is still applied (the session id may be recreated).
    expect(setPluginSessions).toHaveBeenCalledWith('chatwoot', ['gone-sess']);
  });

  it('does not warn when the bound session exists', async () => {
    const { loader, audit, sessions } = build();
    const instances = {
      listAll: jest
        .fn()
        .mockResolvedValue([
          { pluginId: 'chatwoot', instanceId: 'main', sessionScope: 'sess-1', config: {}, enabled: true },
        ]),
      list: jest.fn().mockResolvedValue([]),
    } as unknown as PluginInstanceService;

    const svc = new ScopeBindingService(instances, loader, audit, sessions);
    const warn = jest.spyOn(loggerOf(svc), 'warn').mockImplementation(() => undefined);
    await svc.onApplicationBootstrap();

    expect(warn).not.toHaveBeenCalled();
  });

  // A DB hiccup is not evidence the session is gone: reporting one as missing would send an operator
  // hunting a scope that is in fact fine.
  it('stays quiet when the session lookup fails for a reason other than a missing row', async () => {
    const { loader, audit } = build();
    const instances = {
      listAll: jest
        .fn()
        .mockResolvedValue([
          { pluginId: 'chatwoot', instanceId: 'main', sessionScope: 'sess-1', config: {}, enabled: true },
        ]),
      list: jest.fn().mockResolvedValue([]),
    } as unknown as PluginInstanceService;
    const sessions = { findOne: jest.fn().mockRejectedValue(new Error('db down')) } as unknown as Repository<Session>;

    const svc = new ScopeBindingService(instances, loader, audit, sessions);
    const warn = jest.spyOn(loggerOf(svc), 'warn').mockImplementation(() => undefined);
    await expect(svc.onApplicationBootstrap()).resolves.toBeUndefined();

    expect(warn).not.toHaveBeenCalled();
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
    const sessionRows = { findOne: jest.fn().mockResolvedValue({ id: 'sess-1' }) } as unknown as Repository<Session>;

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
      await new ScopeBindingService(instances, loader, audit, sessionRows).onApplicationBootstrap();
      // The wildcard activation must survive in both row orders ('*' subsumes the concrete scope).
      expect(plugin.activeSessions).toContain('*');
    }
  });
});

/**
 * Retiring one instance must not leave its config behind for the tenant that survives.
 *
 * `sessionConfig` is keyed by SCOPE, so it holds whichever instance was projected onto that scope
 * last. Keeping it when an enabled sibling remained was deliberate — dropping the scope from
 * `activeSessions` would silence that sibling until the next boot — but the config slice is a
 * different thing, and once this teardown leaves a SINGLE enabled instance on the scope,
 * `PluginSandboxBridge.scopeHasAtMostOneInstance` re-declares the slice attributable to that
 * survivor and merges it under the survivor's own row. A survivor relying on a plugin default for a
 * key it does not define was therefore handed the retired tenant's value for it.
 */
describe('ScopeBindingService.applyScopeBinding retires an instance without leaking its config', () => {
  function build(activeSessions: string[] = ['sess-1']) {
    const setPluginSessionConfig = jest.fn();
    const setPluginSessions = jest.fn();
    const loader = {
      getPlugin: jest.fn().mockReturnValue({ manifest: { id: 'chatwoot' }, activeSessions }),
      setPluginSessionConfig,
      setPluginSessions,
      updatePluginConfig: jest.fn(),
    } as unknown as PluginLoaderService;
    const audit = { logInfo: jest.fn(), logWarn: jest.fn() } as unknown as AuditService;
    const sessions = { findOne: jest.fn().mockResolvedValue({ id: 'sess-1' }) } as unknown as Repository<Session>;
    const svc = (rows: unknown[]): ScopeBindingService =>
      new ScopeBindingService(
        { list: jest.fn().mockResolvedValue(rows) } as unknown as PluginInstanceService,
        loader,
        audit,
        sessions,
      );
    return { svc, setPluginSessionConfig, setPluginSessions };
  }

  /** The row shape `applyScopeBinding` reads: the controller persists it BEFORE calling us. */
  const row = (instanceId: string, enabled: boolean, sessionScope: string | null = 'sess-1') => ({
    pluginId: 'chatwoot',
    instanceId,
    sessionScope,
    config: {},
    enabled,
  });

  it('clears the scope config slice when a DISABLED sibling leaves one enabled instance behind', async () => {
    const { svc, setPluginSessionConfig, setPluginSessions } = build();
    // 'b' was provisioned last, so the slice holds ITS config. The controller has already persisted
    // b as disabled, so its row is still listed — just no longer enabled.
    await svc([row('a', true), row('b', false)]).applyScopeBinding('chatwoot', 'sess-1', {}, false);

    expect(setPluginSessionConfig).toHaveBeenCalledWith('chatwoot', 'sess-1', {});
    // …but the session stays active: dropping it would silence 'a' until the next boot.
    expect(setPluginSessions).not.toHaveBeenCalled();
  });

  it('clears it for a DELETED sibling too, whose row is gone entirely', async () => {
    const { svc, setPluginSessionConfig, setPluginSessions } = build();
    // DELETE removes the row before this runs, so 'b' is not in the list at all — the surviving
    // slice is the only trace of it, which is exactly what must not be inherited.
    await svc([row('a', true)]).applyScopeBinding('chatwoot', 'sess-1', {}, false);

    expect(setPluginSessionConfig).toHaveBeenCalledWith('chatwoot', 'sess-1', {});
    expect(setPluginSessions).not.toHaveBeenCalled();
  });

  // Negative twin: a DISABLED sibling is not a tenant receiving deliveries, so it must not hold the
  // scope open. With nothing enabled left, the full teardown still runs — slice cleared AND the
  // scope dropped from activeSessions. Without this, the fix above could be "always return early".
  it('still deactivates the session when no ENABLED sibling remains', async () => {
    const { svc, setPluginSessionConfig, setPluginSessions } = build();
    await svc([row('a', false)]).applyScopeBinding('chatwoot', 'sess-1', {}, false);

    expect(setPluginSessionConfig).toHaveBeenCalledWith('chatwoot', 'sess-1', {});
    expect(setPluginSessions).toHaveBeenCalledWith('chatwoot', []);
  });

  // Negative twin: a sibling on a DIFFERENT scope has no claim on this one.
  it('deactivates when the only enabled sibling binds another scope', async () => {
    const { svc, setPluginSessions } = build();
    await svc([row('a', true, 'sess-2')]).applyScopeBinding('chatwoot', 'sess-1', {}, false);
    expect(setPluginSessions).toHaveBeenCalledWith('chatwoot', []);
  });

  // Activation is untouched: it must still write the instance's config, not an empty slice.
  it('leaves the activation path writing the instance config', async () => {
    const { svc, setPluginSessionConfig } = build([]);
    await svc([]).applyScopeBinding('chatwoot', 'sess-1', { baseUrl: 'https://a.example' }, true);
    expect(setPluginSessionConfig).toHaveBeenCalledWith('chatwoot', 'sess-1', { baseUrl: 'https://a.example' });
  });
});

// A restore replaces every plugin_instances row, while the runtime bindings projected from the old
// rows live in the plugin registry and the boot pass only adds. resyncAfterImport retires what the
// restore dropped and re-applies what it restored.
describe('ScopeBindingService.resyncAfterImport', () => {
  /** A loader whose activeSessions / sessionConfig actually change, so the end state can be read. */
  function statefulLoader(initial: { activeSessions: string[]; sessionConfig: Record<string, unknown> }) {
    const plugin = { manifest: { id: 'chatwoot' }, ...initial };
    const loader = {
      getPlugin: jest.fn((id: string) => (id === 'chatwoot' ? plugin : undefined)),
      setPluginSessionConfig: jest.fn((_id: string, scope: string, config: Record<string, unknown>) => {
        plugin.sessionConfig = { ...plugin.sessionConfig, [scope]: config };
      }),
      setPluginSessions: jest.fn((_id: string, sessions: string[]) => {
        plugin.activeSessions = sessions;
      }),
      updatePluginConfig: jest.fn(),
    };
    return { plugin, loader };
  }

  function svc(loader: unknown, restored: unknown[]): ScopeBindingService {
    const rowsFor = (pluginId: string) =>
      (restored as Array<{ pluginId: string }>).filter(r => r.pluginId === pluginId);
    return new ScopeBindingService(
      {
        listAll: jest.fn().mockResolvedValue(restored),
        list: jest.fn((pluginId: string) => Promise.resolve(rowsFor(pluginId))),
      } as unknown as PluginInstanceService,
      loader as PluginLoaderService,
      { logInfo: jest.fn(), logWarn: jest.fn() } as unknown as AuditService,
      { findOne: jest.fn().mockResolvedValue({ id: 'x' }) } as unknown as Repository<Session>,
    );
  }

  const row = (
    instanceId: string,
    sessionScope: string | null,
    config: Record<string, unknown> = {},
    enabled = true,
  ) => ({
    pluginId: 'chatwoot',
    instanceId,
    sessionScope,
    config,
    enabled,
  });

  it('retires the scope of an instance the restore dropped, and keeps the restored one', async () => {
    const { plugin, loader } = statefulLoader({
      activeSessions: ['sess-1', 'sess-2'],
      sessionConfig: { 'sess-1': { token: 'dropped' }, 'sess-2': { token: 'old-kept' } },
    });

    await svc(loader, [row('kept', 'sess-2', { token: 'restored' })]).resyncAfterImport([
      { pluginId: 'chatwoot', sessionScope: 'sess-1', enabled: true },
      { pluginId: 'chatwoot', sessionScope: 'sess-2', enabled: true },
    ]);

    expect(plugin.activeSessions).toEqual(['sess-2']);
    expect(plugin.sessionConfig).toEqual({ 'sess-1': {}, 'sess-2': { token: 'restored' } });
  });

  it('retires a scope whose instance was restored DISABLED', async () => {
    const { plugin, loader } = statefulLoader({ activeSessions: ['sess-1'], sessionConfig: { 'sess-1': { t: 1 } } });

    await svc(loader, [row('a', 'sess-1', { t: 1 }, false)]).resyncAfterImport([
      { pluginId: 'chatwoot', sessionScope: 'sess-1', enabled: true },
    ]);

    expect(plugin.activeSessions).toEqual([]);
    expect(plugin.sessionConfig).toEqual({ 'sess-1': {} });
  });

  it('leaves an operator-activated session alone: the teardown set comes from the old rows only', async () => {
    // 'sess-op' was activated through PUT /plugins/:id/sessions with no instance behind it, and '*'
    // too; neither was bound by a pre-import row, so neither may be retired.
    const { plugin, loader } = statefulLoader({ activeSessions: ['*', 'sess-op', 'sess-1'], sessionConfig: {} });

    await svc(loader, []).resyncAfterImport([{ pluginId: 'chatwoot', sessionScope: 'sess-1', enabled: true }]);

    expect(new Set(plugin.activeSessions)).toEqual(new Set(['*', 'sess-op']));
  });

  it('drops "*" when the restore removed the only wildcard instance', async () => {
    const { plugin, loader } = statefulLoader({ activeSessions: ['*'], sessionConfig: {} });

    await svc(loader, []).resyncAfterImport([{ pluginId: 'chatwoot', sessionScope: null, enabled: true }]);

    expect(plugin.activeSessions).toEqual([]);
  });

  it('touches nothing for a pair that was disabled before the import, or a plugin that is not loaded', async () => {
    const { loader } = statefulLoader({ activeSessions: ['sess-1'], sessionConfig: {} });

    await svc(loader, []).resyncAfterImport([
      { pluginId: 'chatwoot', sessionScope: 'sess-1', enabled: false },
      { pluginId: 'not-loaded', sessionScope: 'sess-9', enabled: true },
    ]);

    expect(loader.setPluginSessionConfig).not.toHaveBeenCalled();
    expect(loader.setPluginSessions).not.toHaveBeenCalled();
  });

  it('rejects when the restored rows cannot be listed, so the caller can report it', async () => {
    const { loader } = statefulLoader({ activeSessions: [], sessionConfig: {} });
    const service = new ScopeBindingService(
      { listAll: jest.fn().mockRejectedValue(new Error('db down')) } as unknown as PluginInstanceService,
      loader as unknown as PluginLoaderService,
      { logInfo: jest.fn(), logWarn: jest.fn() } as unknown as AuditService,
      {} as Repository<Session>,
    );

    await expect(service.resyncAfterImport([])).rejects.toThrow('db down');
  });
});
