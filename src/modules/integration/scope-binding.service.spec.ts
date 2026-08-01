import { NotFoundException } from '@nestjs/common';
import { ScopeBindingService } from './scope-binding.service';
import { PluginInstanceService } from './plugin-instance.service';
import { PluginLoaderService } from '../../core/plugins/plugin-loader.service';
import { AuditService } from '../audit/audit.service';
import { SessionService } from '../session/session.service';

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
    // quiet unless a test asks for it (SessionService.findOne throws NotFoundException for a gone row).
    const sessions = { findOne: jest.fn().mockResolvedValue({ id: 'sess-1' }) } as unknown as SessionService;
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
    const sessions = {
      findOne: jest.fn().mockRejectedValue(new NotFoundException("Session with id 'gone-sess' not found")),
    } as unknown as SessionService;

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
    const sessions = { findOne: jest.fn().mockRejectedValue(new Error('db down')) } as unknown as SessionService;

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
    const sessionRows = { findOne: jest.fn().mockResolvedValue({ id: 'sess-1' }) } as unknown as SessionService;

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
