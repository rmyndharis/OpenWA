import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { DataSource, Repository } from 'typeorm';
import { ScopeBindingService } from './scope-binding.service';
import { PluginInstanceService } from './plugin-instance.service';
import { PluginInstance } from './entities/plugin-instance.entity';
import { PluginLoaderService } from '../../core/plugins/plugin-loader.service';
import { PluginStorageService } from '../../core/plugins/plugin-storage.service';
import { PLUGIN_INSTANCE_PORT } from '../../core/plugins/plugin-host-ports';
import { HookManager } from '../../core/hooks';
import { PluginsService } from '../plugins/plugins.service';
import { AuditService } from '../audit/audit.service';
import { Session, SessionStatus } from '../session/entities/session.entity';
import type { PluginWorkerHost } from '../../core/plugins/sandbox/plugin-worker-host';

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

  // With "*" set by the operator and no wildcard instance, "*" is all that keeps the plugin active for the
  // sessions of its concrete instances. Retiring it has to leave those sessions bound, as the wildcard
  // teardown does, or every enabled instance but the one just provisioned stops receiving hooks.
  describe('retiring "*" while other concrete instances are enabled', () => {
    const instance = (instanceId: string, sessionScope: string, enabled = true) => ({
      pluginId: 'chatwoot',
      instanceId,
      sessionScope,
      enabled,
    });

    it('keeps their sessions bound when another concrete instance is provisioned', async () => {
      const { loader, audit, sessions, setPluginSessions } = build(true, ['*']);
      const instances = {
        list: jest.fn().mockResolvedValue([instance('a', 'sess-1'), instance('b', 'sess-2'), instance('c', 'sess-3')]),
      } as unknown as PluginInstanceService;

      await new ScopeBindingService(instances, loader, audit, sessions).applyScopeBinding(
        'chatwoot',
        'sess-3',
        {},
        true,
      );

      expect(sessionsWritten(setPluginSessions)).toEqual(new Set(['sess-1', 'sess-2', 'sess-3']));
    });

    it('keeps their sessions bound when one concrete instance is disabled', async () => {
      const { loader, audit, sessions, setPluginSessions } = build(true, ['*']);
      const instances = {
        list: jest.fn().mockResolvedValue([instance('a', 'sess-1'), instance('b', 'sess-2', false)]),
      } as unknown as PluginInstanceService;

      await new ScopeBindingService(instances, loader, audit, sessions).applyScopeBinding(
        'chatwoot',
        'sess-2',
        {},
        false,
      );

      expect(sessionsWritten(setPluginSessions)).toEqual(new Set(['sess-1']));
    });

    it('leaves an explicit session list alone: there is no "*" to retire', async () => {
      // The operator removed sess-2 from the plugin's sessions on purpose; provisioning sess-3 must not
      // bring it back.
      const { loader, audit, sessions, setPluginSessions } = build(true, ['sess-1']);
      const instances = {
        list: jest.fn().mockResolvedValue([instance('a', 'sess-1'), instance('b', 'sess-2'), instance('c', 'sess-3')]),
      } as unknown as PluginInstanceService;

      await new ScopeBindingService(instances, loader, audit, sessions).applyScopeBinding(
        'chatwoot',
        'sess-3',
        {},
        true,
      );

      expect(sessionsWritten(setPluginSessions)).toEqual(new Set(['sess-1', 'sess-3']));
    });
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
      // Both row orders end at exactly ['*'] ('*' subsumes the concrete scope).
      expect(plugin.activeSessions).toEqual(['*']);
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

  // Activating a wildcard overwrote activeSessions with ['*'], so the concrete scopes still-enabled
  // siblings bind are gone from it; retiring the wildcard must put them back, not leave the plugin on [].
  it('restores the scopes of enabled concrete siblings when the last wildcard is retired', async () => {
    const { svc, setPluginSessions } = build(['*']);
    await svc([row('a', true, 'sess-1'), row('b', false, null), row('c', false, 'sess-3')]).applyScopeBinding(
      'chatwoot',
      null,
      {},
      false,
    );
    expect(setPluginSessions).toHaveBeenCalledWith('chatwoot', ['sess-1']);
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

/**
 * A wildcard instance is projected into the plugin's BASE config, and that write merges, so it cannot
 * delete a key. A secret the instance no longer defines (the operator revoked it) stayed in the base
 * config, in registry.json and in every hook and ingress delivery's config, while the instance row and
 * its GET already showed it gone.
 */
describe('ScopeBindingService.applyScopeBinding retracts a secret an instance no longer defines', () => {
  const schema = {
    type: 'object',
    properties: {
      apiToken: { type: 'string', secret: true },
      baseUrl: { type: 'string' },
      replyDelayMs: { type: 'number' },
      crm: { type: 'object', properties: { key: { type: 'string', secret: true }, url: { type: 'string' } } },
    },
  };

  // What the earlier projection of the instance left in the plugin's base config.
  const projected = {
    apiToken: 'LEAKED',
    baseUrl: 'https://crm',
    replyDelayMs: 5,
    crm: { key: 'K', url: 'https://x' },
  };

  function build(baseConfig: Record<string, unknown> = projected) {
    const updatePluginConfig = jest.fn();
    const setPluginSessionConfig = jest.fn();
    const setPluginSessions = jest.fn();
    const loader = {
      getPlugin: jest.fn().mockReturnValue({
        manifest: { id: 'chatwoot', configSchema: schema },
        activeSessions: ['*'],
        config: baseConfig,
      }),
      setPluginSessionConfig,
      setPluginSessions,
      updatePluginConfig,
    } as unknown as PluginLoaderService;
    const audit = { logInfo: jest.fn(), logWarn: jest.fn() } as unknown as AuditService;
    const sessions = { findOne: jest.fn().mockResolvedValue({ id: 'sess-1' }) } as unknown as Repository<Session>;
    const list = jest.fn().mockResolvedValue([]);
    const svc = new ScopeBindingService({ list } as unknown as PluginInstanceService, loader, audit, sessions);
    return { svc, list, updatePluginConfig, setPluginSessionConfig, setPluginSessions };
  }

  const sibling = (
    instanceId: string,
    config: Record<string, unknown>,
    enabled = true,
    sessionScope: string | null = null,
  ) => ({
    pluginId: 'chatwoot',
    instanceId,
    sessionScope,
    config,
    enabled,
  });

  it('writes null for the removed secret together with the rest of the instance config', async () => {
    const { svc, updatePluginConfig } = build();

    await svc.applyScopeBinding('chatwoot', null, { baseUrl: 'https://crm' }, true, {
      previousConfig: { apiToken: 'LEAKED', baseUrl: 'https://crm' },
    });

    expect(updatePluginConfig).toHaveBeenCalledTimes(1);
    expect(updatePluginConfig).toHaveBeenCalledWith('chatwoot', { baseUrl: 'https://crm', apiToken: null });
  });

  it('retracts a secret nested under a key the instance dropped, and leaves a plain key alone', async () => {
    const { svc, updatePluginConfig } = build();

    await svc.applyScopeBinding('chatwoot', '*', { baseUrl: 'https://crm' }, true, {
      previousConfig: { baseUrl: 'https://crm', replyDelayMs: 5, crm: { key: 'K', url: 'https://x' } },
    });

    expect(updatePluginConfig).toHaveBeenCalledWith('chatwoot', { baseUrl: 'https://crm', crm: null });
  });

  it('hands the base the value another enabled wildcard instance still defines, not the removed one', async () => {
    const { svc, list, updatePluginConfig } = build();
    list.mockResolvedValue([
      sibling('a', { baseUrl: 'https://crm' }),
      sibling('b', { apiToken: 'B-OLD' }),
      sibling('c', { apiToken: 'C-TOKEN' }),
      sibling('d', { apiToken: 'D-DISABLED' }, false),
      sibling('e', { apiToken: 'E-CONCRETE' }, true, 'sess-1'),
    ]);

    await svc.applyScopeBinding('chatwoot', null, { baseUrl: 'https://crm' }, true, {
      previousConfig: { apiToken: 'LEAKED', baseUrl: 'https://crm' },
    });

    // The last wildcard instance by id wins, as it does when boot reconciliation replays them.
    expect(updatePluginConfig).toHaveBeenCalledWith('chatwoot', { baseUrl: 'https://crm', apiToken: 'C-TOKEN' });
  });

  // instances.list() is a find() with no ORDER BY, so SQLite and PostgreSQL return the rows in different orders.
  // Boot reconciliation replays the wildcard instances by id, so the base ends up with the value of the last
  // one; the value handed back has to be the same whichever order the database lists them in.
  it.each([
    ['c', 'a', 'b'],
    ['b', 'c', 'a'],
    ['a', 'b', 'c'],
  ])('hands back the value of the greatest instance id when the siblings are listed as %s, %s, %s', async (...ids) => {
    const { svc, list, updatePluginConfig } = build();
    list.mockResolvedValue(ids.map(id => sibling(id, { apiToken: `${id}-token` })));

    await svc.applyScopeBinding('chatwoot', null, {}, false, { previousConfig: { apiToken: 'LEAKED' } });

    expect(updatePluginConfig).toHaveBeenCalledWith('chatwoot', { apiToken: 'c-token' });
  });

  // A secret that was never set is nothing to take back: an empty or null value is not a credential the plugin
  // holds, and writing null over the base's own empty value would be a change nobody asked for.
  it.each([
    ['an empty string', ''],
    ['null', null],
  ])('takes nothing back for a previous secret that was %s', async (_label, held) => {
    const { svc, list, updatePluginConfig } = build({ ...projected, apiToken: held });

    await svc.applyScopeBinding('chatwoot', null, {}, false, { previousConfig: { apiToken: held } });

    expect(updatePluginConfig).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledTimes(1); // only the '*' retirement check reads the siblings
  });

  it('retracts every secret the instance held when it is torn down, and ends the "*" activation as before', async () => {
    const { svc, updatePluginConfig, setPluginSessions } = build();

    await svc.applyScopeBinding('chatwoot', null, {}, false, {
      previousConfig: { apiToken: 'LEAKED', baseUrl: 'https://crm', crm: { key: 'K', url: 'https://x' } },
    });

    expect(updatePluginConfig).toHaveBeenCalledTimes(1);
    expect(updatePluginConfig).toHaveBeenCalledWith('chatwoot', { apiToken: null, crm: null });
    expect(setPluginSessions).toHaveBeenCalledWith('chatwoot', []);
  });

  it('hands the base the value another enabled wildcard instance still defines when it is torn down', async () => {
    const { svc, list, updatePluginConfig } = build();
    list.mockResolvedValue([sibling('b', { apiToken: 'B-TOKEN' }), sibling('c', { baseUrl: 'https://c' })]);

    await svc.applyScopeBinding('chatwoot', '*', {}, false, { previousConfig: { apiToken: 'LEAKED' } });

    expect(updatePluginConfig).toHaveBeenCalledWith('chatwoot', { apiToken: 'B-TOKEN' });
  });

  it('leaves the base config alone on a teardown that holds no secret, or that is given no previous config', async () => {
    const { svc, list, updatePluginConfig } = build();

    await svc.applyScopeBinding('chatwoot', null, {}, false, { previousConfig: { baseUrl: 'https://crm' } });
    await svc.applyScopeBinding('chatwoot', null, {}, false, { previousConfig: null });
    await svc.applyScopeBinding('chatwoot', null, {}, false);

    expect(updatePluginConfig).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledTimes(3); // only the '*' retirement check reads the siblings
  });

  // The base config is shared. A value the operator has set on the plugin since, or one a sibling projected
  // after this instance, is not this instance's to take back.
  it('leaves a base value that is no longer the one the instance put there', async () => {
    const operator = build({ ...projected, apiToken: 'OPERATOR' });

    await operator.svc.applyScopeBinding('chatwoot', null, {}, false, { previousConfig: { apiToken: 'LEAKED' } });
    expect(operator.updatePluginConfig).not.toHaveBeenCalled();
    expect(operator.list).toHaveBeenCalledTimes(1); // only the '*' retirement check reads the siblings

    const partial = build({ ...projected, crm: { key: 'OTHER', url: 'https://x' } });
    await partial.svc.applyScopeBinding('chatwoot', null, { baseUrl: 'https://crm' }, true, {
      previousConfig: projected,
    });
    expect(partial.updatePluginConfig).toHaveBeenCalledWith('chatwoot', { apiToken: null, baseUrl: 'https://crm' });
  });

  it('only looks at siblings when a secret was removed', async () => {
    const { svc, list, updatePluginConfig } = build();

    await svc.applyScopeBinding('chatwoot', null, { apiToken: 'NEW' }, true, {
      previousConfig: { apiToken: 'OLD' },
    });
    await svc.applyScopeBinding('chatwoot', null, { baseUrl: 'https://crm' }, true);

    expect(list).not.toHaveBeenCalled();
    expect(updatePluginConfig).toHaveBeenNthCalledWith(1, 'chatwoot', { apiToken: 'NEW' });
    expect(updatePluginConfig).toHaveBeenNthCalledWith(2, 'chatwoot', { baseUrl: 'https://crm' });
  });

  it('never touches the base config for a concrete scope, whose slice is replaced whole', async () => {
    const { svc, updatePluginConfig, setPluginSessionConfig } = build();

    await svc.applyScopeBinding('chatwoot', 'sess-1', { baseUrl: 'https://crm' }, true, {
      previousConfig: { apiToken: 'LEAKED', baseUrl: 'https://crm' },
    });

    expect(updatePluginConfig).not.toHaveBeenCalled();
    expect(setPluginSessionConfig).toHaveBeenCalledWith('chatwoot', 'sess-1', { baseUrl: 'https://crm' });
  });
});

describe('Base host redirect sanitizes persisted plugin_instances rows across ingress dispatch and restart', () => {
  const PLUGIN_ID = 'crm-adapter';
  const manifestJson = {
    id: PLUGIN_ID,
    name: 'CRM Adapter',
    version: '1.0.0',
    type: 'extension',
    main: 'index.js',
    permissions: ['webhook:ingress', 'net:fetch'],
    ingress: [{ route: 'events', signature: { scheme: 'hmac-sha256', header: 'x-signature' } }],
    net: { allowConfigHosts: ['baseUrl'] },
    configSchema: {
      type: 'object',
      properties: {
        baseUrl: { type: 'string' },
        apiKey: { type: 'string', secret: true },
        label: { type: 'string' },
      },
    },
  };

  async function buildStack() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-inst-redirect-'));
    const pluginDir = path.join(tmpDir, 'plugins', PLUGIN_ID);
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'manifest.json'), JSON.stringify(manifestJson));
    fs.writeFileSync(path.join(pluginDir, 'index.js'), 'module.exports = {};');

    const ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [PluginInstance, Session],
      synchronize: true,
    });
    await ds.initialize();
    const sessionsRepo = ds.getRepository(Session);
    for (const sid of ['sess-A', 'sess-B']) {
      await sessionsRepo.save(
        sessionsRepo.create({ id: sid, name: sid, status: SessionStatus.DISCONNECTED, config: {} }),
      );
    }

    const instances = new PluginInstanceService(ds.getRepository(PluginInstance));
    const audit = { logInfo: jest.fn(), logWarn: jest.fn() } as unknown as AuditService;
    const configService = new ConfigService({
      dataDir: tmpDir,
      plugins: { directory: path.join(tmpDir, 'plugins') },
    });
    const moduleRef = {
      get: jest.fn((token: unknown) => {
        if (token === PLUGIN_INSTANCE_PORT) return instances;
        throw new Error(`Unexpected token: ${String(token)}`);
      }),
    } as unknown as ModuleRef;

    const bootLoader = () => {
      const storage = new PluginStorageService(configService);
      const loader = new PluginLoaderService(configService, new HookManager(), storage, moduleRef);
      loader.loadPlugin(pluginDir);
      const pluginsService = new PluginsService(loader, configService);
      const scopeBinding = new ScopeBindingService(instances, loader, audit, sessionsRepo);
      const webhookCalls: Array<{ instanceId: string; config?: Record<string, unknown> }> = [];
      (loader as unknown as { sandboxHosts: Map<string, PluginWorkerHost> }).sandboxHosts.set(PLUGIN_ID, {
        dispatchWebhook: (payload: { instanceId: string; config?: Record<string, unknown> }) => {
          webhookCalls.push({ instanceId: payload.instanceId, config: payload.config });
          return Promise.resolve({ ok: true, status: 200 });
        },
        sendConfigChange: jest.fn(),
      } as unknown as PluginWorkerHost);
      return { storage, loader, pluginsService, scopeBinding, webhookCalls };
    };

    const cleanup = async () => {
      if (ds.isInitialized) await ds.destroy();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    };

    return { instances, ds, bootLoader, cleanup };
  }

  it('strips inherited secrets from concrete and wildcard instances on base config redirect, blocks ingress leakage, and prevents resurrection on restart reconcile', async () => {
    const { instances, bootLoader, cleanup } = await buildStack();
    try {
      const first = bootLoader();
      expect(
        (
          await first.pluginsService.updateConfig(PLUGIN_ID, {
            baseUrl: 'https://good.example',
            apiKey: 'BASE-SECRET',
          })
        ).success,
      ).toBe(true);

      const instConcrete = await instances.create(PLUGIN_ID, 'inst-1', {
        sessionScope: 'sess-A',
        config: { apiKey: 'INST-SECRET', label: 'A' },
      });
      const instWild = await instances.create(PLUGIN_ID, 'inst-wild', {
        config: { apiKey: 'WILD-SECRET', label: 'W' },
      });
      const instOwn = await instances.create(PLUGIN_ID, 'inst-own', {
        sessionScope: 'sess-B',
        config: { baseUrl: 'https://own.example', apiKey: 'OWN-SECRET', label: 'B' },
      });

      await first.scopeBinding.applyScopeBinding(PLUGIN_ID, instConcrete.sessionScope, instConcrete.config!, true);
      await first.scopeBinding.applyScopeBinding(PLUGIN_ID, instOwn.sessionScope, instOwn.config!, true);
      await first.scopeBinding.applyScopeBinding(PLUGIN_ID, instWild.sessionScope, instWild.config!, true);

      // Redirect the base host away from good.example.
      expect(
        (await first.pluginsService.updateConfig(PLUGIN_ID, { baseUrl: 'https://attacker.example' })).success,
      ).toBe(true);

      // Immediate next ingress dispatches must never carry INST-SECRET or WILD-SECRET to attacker.example.
      await first.loader.dispatchWebhookForInstance({
        pluginId: PLUGIN_ID,
        instanceId: 'inst-1',
        route: 'events',
        deliveryId: 'd-1',
        sessionId: 'sess-A',
        payload: { headers: {}, query: {}, body: '{}', rawBody: '{}' },
      });
      await first.loader.dispatchWebhookForInstance({
        pluginId: PLUGIN_ID,
        instanceId: 'inst-wild',
        route: 'events',
        deliveryId: 'd-wild',
        payload: { headers: {}, query: {}, body: '{}', rawBody: '{}' },
      });
      await first.loader.dispatchWebhookForInstance({
        pluginId: PLUGIN_ID,
        instanceId: 'inst-own',
        route: 'events',
        deliveryId: 'd-own',
        sessionId: 'sess-B',
        payload: { headers: {}, query: {}, body: '{}', rawBody: '{}' },
      });

      expect(first.webhookCalls[0]).toEqual({
        instanceId: 'inst-1',
        config: { baseUrl: 'https://attacker.example', label: 'A' },
      });
      expect(first.webhookCalls[1]).toEqual({
        instanceId: 'inst-wild',
        config: { baseUrl: 'https://attacker.example', label: 'W' },
      });
      expect(first.webhookCalls[2]).toEqual({
        instanceId: 'inst-own',
        config: { baseUrl: 'https://own.example', apiKey: 'OWN-SECRET', label: 'B' },
      });

      // Persisted instance rows must reflect the stripped secrets while preserving inst-own.
      expect((await instances.resolve(PLUGIN_ID, 'inst-1'))?.config).toEqual({ label: 'A' });
      expect((await instances.resolve(PLUGIN_ID, 'inst-wild'))?.config).toEqual({ label: 'W' });
      expect((await instances.resolve(PLUGIN_ID, 'inst-own'))?.config).toEqual({
        baseUrl: 'https://own.example',
        apiKey: 'OWN-SECRET',
        label: 'B',
      });

      // Simulated restart + ScopeBindingService.reconcile() must NOT resurrect INST-SECRET or WILD-SECRET.
      const restarted = bootLoader();
      await restarted.scopeBinding.reconcile();
      const pluginAfterRestart = restarted.loader.getPlugin(PLUGIN_ID)!;
      expect(pluginAfterRestart.config).toEqual({ baseUrl: 'https://attacker.example', label: 'W' });
      expect(pluginAfterRestart.sessionConfig?.['sess-A']).toEqual({ label: 'A' });
      expect(pluginAfterRestart.sessionConfig?.['sess-B']).toEqual({
        baseUrl: 'https://own.example',
        apiKey: 'OWN-SECRET',
        label: 'B',
      });
    } finally {
      await cleanup();
    }
  });

  it('strips inherited secrets from sibling instances when a wildcard instance projection redirects the base host', async () => {
    const { instances, bootLoader, cleanup } = await buildStack();
    try {
      const stack = bootLoader();
      expect(
        (
          await stack.pluginsService.updateConfig(PLUGIN_ID, {
            baseUrl: 'https://good.example',
            apiKey: 'BASE-SECRET',
          })
        ).success,
      ).toBe(true);

      const instConcrete = await instances.create(PLUGIN_ID, 'inst-1', {
        sessionScope: 'sess-A',
        config: { apiKey: 'INST-SECRET', label: 'A' },
      });
      const instWildOld = await instances.create(PLUGIN_ID, 'inst-wild-old', {
        config: { apiKey: 'OLD-WILD-SECRET', label: 'W1' },
      });
      const instOwn = await instances.create(PLUGIN_ID, 'inst-own', {
        sessionScope: 'sess-B',
        config: { baseUrl: 'https://own.example', apiKey: 'OWN-SECRET', label: 'B' },
      });
      await stack.scopeBinding.applyScopeBinding(PLUGIN_ID, instConcrete.sessionScope, instConcrete.config!, true);
      await stack.scopeBinding.applyScopeBinding(PLUGIN_ID, instOwn.sessionScope, instOwn.config!, true);
      await stack.scopeBinding.applyScopeBinding(PLUGIN_ID, instWildOld.sessionScope, instWildOld.config!, true);

      // Provision a new wildcard instance pointing at a different origin with its own secret.
      const instWildNew = await instances.create(PLUGIN_ID, 'inst-wild-new', {
        config: { baseUrl: 'https://moved.example', apiKey: 'NEW-WILD-SECRET', label: 'W2' },
      });
      const sanitizeSpy = jest.spyOn(instances, 'sanitizeForBaseRedirect');
      await stack.scopeBinding.applyScopeBinding(PLUGIN_ID, instWildNew.sessionScope, instWildNew.config!, true);

      expect(sanitizeSpy).toHaveBeenCalledTimes(1);
      sanitizeSpy.mockRestore();

      expect((await instances.resolve(PLUGIN_ID, 'inst-1'))?.config).toEqual({ label: 'A' });
      expect((await instances.resolve(PLUGIN_ID, 'inst-wild-old'))?.config).toEqual({ label: 'W1' });
      expect((await instances.resolve(PLUGIN_ID, 'inst-wild-new'))?.config).toEqual({
        baseUrl: 'https://moved.example',
        apiKey: 'NEW-WILD-SECRET',
        label: 'W2',
      });
      expect((await instances.resolve(PLUGIN_ID, 'inst-own'))?.config).toEqual({
        baseUrl: 'https://own.example',
        apiKey: 'OWN-SECRET',
        label: 'B',
      });
    } finally {
      await cleanup();
    }
  });

  it('rejects a base host redirect and leaves registry.json untouched when instance DB sanitization fails', async () => {
    const { instances, ds, bootLoader, cleanup } = await buildStack();
    try {
      const stack = bootLoader();
      expect(
        (
          await stack.pluginsService.updateConfig(PLUGIN_ID, {
            baseUrl: 'https://good.example',
            apiKey: 'BASE-SECRET',
          })
        ).success,
      ).toBe(true);

      const instConcrete = await instances.create(PLUGIN_ID, 'inst-1', {
        sessionScope: 'sess-A',
        config: { apiKey: 'INST-SECRET', label: 'A' },
      });
      await stack.scopeBinding.applyScopeBinding(PLUGIN_ID, instConcrete.sessionScope, instConcrete.config!, true);

      const repo = ds.getRepository(PluginInstance);
      const updateSpy = jest.spyOn(repo, 'update').mockRejectedValueOnce(new Error('db write unavailable'));

      await expect(
        stack.pluginsService.updateConfig(PLUGIN_ID, { baseUrl: 'https://attacker.example' }),
      ).rejects.toThrow();

      // Neither runtime config nor persisted registry.json may be redirected when DB sanitization failed.
      expect(stack.loader.getPlugin(PLUGIN_ID)?.config).toMatchObject({ baseUrl: 'https://good.example' });
      expect(stack.storage.getPluginConfig(PLUGIN_ID)).toMatchObject({ baseUrl: 'https://good.example' });

      // Because the redirect was aborted, a subsequent read must NOT strip INST-SECRET via a phantom retry.
      updateSpy.mockRestore();
      expect((await instances.resolve(PLUGIN_ID, 'inst-1'))?.config).toEqual({ apiKey: 'INST-SECRET', label: 'A' });
    } finally {
      await cleanup();
    }
  });

  it('durably sanitizes plugin_instances before updateConfig resolves so an immediate cold restart cannot resurrect secrets', async () => {
    const { instances, ds, bootLoader, cleanup } = await buildStack();
    try {
      const first = bootLoader();
      expect(
        (
          await first.pluginsService.updateConfig(PLUGIN_ID, {
            baseUrl: 'https://good.example',
            apiKey: 'BASE-SECRET',
          })
        ).success,
      ).toBe(true);

      const instConcrete = await instances.create(PLUGIN_ID, 'inst-1', {
        sessionScope: 'sess-A',
        config: { apiKey: 'INST-SECRET', label: 'A' },
      });
      const instWild = await instances.create(PLUGIN_ID, 'inst-wild', {
        config: { apiKey: 'WILD-SECRET', label: 'W' },
      });
      await first.scopeBinding.applyScopeBinding(PLUGIN_ID, instConcrete.sessionScope, instConcrete.config!, true);
      await first.scopeBinding.applyScopeBinding(PLUGIN_ID, instWild.sessionScope, instWild.config!, true);

      // Slow DB updates so a non-awaited background sanitization would still be in flight when updateConfig returns.
      const repo = ds.getRepository(PluginInstance);
      const origUpdate = repo.update.bind(repo);
      const updateSpy = jest.spyOn(repo, 'update').mockImplementation(async (...args) => {
        await new Promise(resolve => setTimeout(resolve, 40));
        return origUpdate(...args);
      });

      const result = await first.pluginsService.updateConfig(PLUGIN_ID, { baseUrl: 'https://attacker.example' });
      expect(result.success).toBe(true);
      updateSpy.mockRestore();

      // Simulate a cold restart with a fresh PluginInstanceService (no in-memory barriers) immediately after return.
      const freshInstances = new PluginInstanceService(ds.getRepository(PluginInstance));
      const restarted = bootLoader();
      const restartedScopeBinding = new ScopeBindingService(
        freshInstances,
        restarted.loader,
        { logInfo: jest.fn(), logWarn: jest.fn() } as unknown as AuditService,
        ds.getRepository(Session),
      );
      await restartedScopeBinding.reconcile();

      expect(restarted.loader.getPlugin(PLUGIN_ID)?.config).toEqual({
        baseUrl: 'https://attacker.example',
        label: 'W',
      });
      expect(restarted.loader.getPlugin(PLUGIN_ID)?.sessionConfig?.['sess-A']).toEqual({ label: 'A' });
    } finally {
      await cleanup();
    }
  });
});
