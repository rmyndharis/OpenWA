import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { AuditService } from '../audit/audit.service';
import { PluginLoaderService } from '../../core/plugins/plugin-loader.service';
import { Session } from '../session/entities/session.entity';
import { PluginInstanceService } from './plugin-instance.service';
import { PluginInstance } from './entities/plugin-instance.entity';
import { createLogger } from '../../common/services/logger.service';

/**
 * Owns the provisioning bridge that makes a persisted plugin instance's config reach the ingress
 * worker: it mirrors the instance config into the plugin's per-session config and toggles the bound
 * session in activeSessions, so `dispatchWebhookForInstance` resolves it as `ctx.config`. Extracted
 * from IntegrationInstanceController so the SAME binding runs both on provisioning (create/patch/remove)
 * and as a boot-time reconciliation over the authoritative `plugin_instances` rows.
 */
@Injectable()
export class ScopeBindingService implements OnApplicationBootstrap {
  private readonly logger = createLogger('ScopeBindingService');

  constructor(
    private readonly instances: PluginInstanceService,
    private readonly loader: PluginLoaderService,
    private readonly audit: AuditService,
    @InjectRepository(Session, 'data')
    private readonly sessions: Repository<Session>,
  ) {}

  /**
   * Re-derive every ENABLED instance's runtime scope binding from the persisted `plugin_instances`
   * rows, so a binding lost at provisioning time (the plugin was momentarily unloaded, so
   * applyScopeBinding was swallowed as a WARN audit) is restored on the next boot without an operator
   * re-PATCH — otherwise the row shows `enabled` but the ingress handler resolves base config only.
   * Runs after every module's onModuleInit (so PluginLoaderService has loaded all plugins).
   *
   * Only enabled rows are (re)activated: a disabled instance must never be force-activated, and issuing
   * its deactivate here could clear a scope a sibling ENABLED instance still binds. applyScopeBinding
   * already no-ops/logs for an unloaded plugin, and its internal try/catch means one instance's failure
   * cannot abort the rest.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.reconcile();
    } catch (err) {
      this.logger.error('Scope-binding reconciliation failed', String(err));
    }
  }

  /**
   * The boot pass itself, shared with {@link resyncAfterImport}. Rejects only when the instance rows
   * cannot be listed; a single binding failure is absorbed by applyScopeBinding.
   */
  async reconcile(): Promise<void> {
    const rows = await this.instances.listAll();

    // Order-independent reconciliation: listAll() is repo.find() with no ORDER BY, so its row order
    // is DB/restart-dependent (differs between SQLite and Postgres). applyScopeBinding mutates the
    // SAME in-memory plugin.activeSessions each iteration — the concrete-scope path strips '*' (unless
    // an enabled wildcard sibling still binds it) while the wildcard path overwrites with ['*'] — so for
    // a plugin with BOTH a wildcard and a concrete instance the final set would otherwise depend on row
    // order (a concrete processed after a wildcard could drop the '*'). Sort concrete scopes before
    // wildcard/null so the wildcard's ['*'] is the last write (correct: '*' subsumes every concrete
    // scope), making the result stable across DBs and restarts. instanceId is the deterministic
    // tiebreak among same-rank rows.
    rows.sort((a, b) => {
      const rank = (i: PluginInstance) => (!i.sessionScope || i.sessionScope === '*' ? 1 : 0);
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      return String(a.instanceId).localeCompare(String(b.instanceId));
    });

    let count = 0;
    for (const inst of rows) {
      if (!inst.enabled) continue;
      // Skip instances whose plugin isn't loaded — applyScopeBinding would only no-op/log for them.
      if (!this.loader.getPlugin(inst.pluginId)) continue;
      await this.applyScopeBinding(inst.pluginId, inst.sessionScope, inst.config ?? {}, true, { additive: true });
      await this.warnIfScopeHasNoSession(inst);
      count++;
    }

    if (count > 0) {
      this.logger.log(`Reconciled scope bindings for ${count} enabled plugin instance(s)`, {
        action: 'scope_bindings_reconciled',
        count,
      });
    }
  }

  /**
   * Bring the runtime bindings back in line after a restore replaced every `plugin_instances` row.
   *
   * The boot pass only adds, so on its own it can never retire a binding whose instance the restore
   * dropped (or restored disabled): the plugin would keep firing on that session with the retired
   * instance's config, across restarts. So first tear down every scope that was bound by an enabled
   * row BEFORE the import and is bound by no enabled row now, then re-run the boot pass over the
   * restored rows. The teardown set comes only from the pre-import rows, never from activeSessions,
   * so a session an operator activated through PUT /api/plugins/:id/sessions is left alone. The
   * teardown is additive for the same reason: a restore makes no new narrowing decision, so it drops
   * the retired scope without also retiring an operator's '*'. A retired wildcard still loses its '*'
   * unless a restored wildcard row keeps it. applyScopeBinding runs after the commit, so its sibling
   * checks read the restored rows.
   */
  async resyncAfterImport(
    previous: ReadonlyArray<{ pluginId: string; sessionScope: string | null; enabled: boolean }>,
  ): Promise<void> {
    const scopeKey = (scope: string | null): string => (!scope || scope === '*' ? '*' : scope);
    const bound = new Set(
      (await this.instances.listAll())
        .filter(row => row.enabled)
        .map(row => `${row.pluginId}\u0000${scopeKey(row.sessionScope)}`),
    );
    const retired = new Map<string, { pluginId: string; sessionScope: string | null }>();
    for (const row of previous) {
      const key = `${row.pluginId}\u0000${scopeKey(row.sessionScope)}`;
      if (row.enabled && !bound.has(key)) retired.set(key, row);
    }
    for (const { pluginId, sessionScope } of retired.values()) {
      if (!this.loader.getPlugin(pluginId)) continue;
      await this.applyScopeBinding(pluginId, sessionScope, {}, false, { additive: true });
    }
    await this.reconcile();
  }

  /**
   * Warn when a just-reconciled instance binds a concrete scope no session row matches — a session the
   * operator deleted, or a scope typed/copied wrong. The plugin is then activated for nothing: the
   * dispatch gate never matches that id, so it receives no events, while every signal an operator can
   * read stays reassuring (the instance row says `enabled`, the plugin's status says `enabled`, hooks
   * are registered and healthCheck is green). This log line is the only place that inertness surfaces.
   *
   * Diagnostic only — it never skips or alters the binding: the id may be recreated (an import or a
   * re-provision can restore the same session id), in which case the restored binding is exactly right.
   */
  private async warnIfScopeHasNoSession(inst: PluginInstance): Promise<void> {
    if (!inst.sessionScope || inst.sessionScope === '*') return;
    try {
      // The same row read SessionService.findOne performs ({ where: { id } }), straight through the
      // repository: a missing row resolves to null instead of throwing NotFoundException, and the
      // service's runtime-state projection is more than this existence check needs.
      const session = await this.sessions.findOne({ where: { id: inst.sessionScope } });
      // A null row (and only a null row) means the session is genuinely missing.
      if (session) return;
      this.logger.warn(
        `Plugin instance ${inst.pluginId}:${inst.instanceId} is bound to session '${inst.sessionScope}', which does not exist — it will receive no events until that session is restored or the instance is re-scoped`,
        {
          action: 'scope_binding_session_missing',
          pluginId: inst.pluginId,
          instanceId: inst.instanceId,
          sessionScope: inst.sessionScope,
        },
      );
    } catch {
      // A failure that throws (a DB hiccup mid-boot) is not evidence the session is gone, and
      // reporting it as gone would send an operator hunting a binding that is in fact fine — so
      // stay quiet rather than cry wolf.
    }
  }

  /**
   * Bind an instance's config to the plugin's runtime so an ingress handler resolves it as ctx.config
   * (see PluginLoaderService.dispatchWebhookForInstance) and activate the session — iff `activate` (a
   * disabled or removed instance must not keep firing). A concrete scope writes sessionConfig[scope] and
   * toggles that session in activeSessions; a null/'*' scope binds the base config + all sessions ('*').
   * A concrete teardown/activation never strips state a still-ENABLED sibling depends on: the scope's
   * session + sessionConfig survive while a sibling binds the same scope, and '*' survives while a
   * sibling binds a wildcard/null scope.
   * Best-effort: provisioning must not fail because the plugin is momentarily unloaded.
   *
   * `additive` is for the boot reconciler, which RESTORES bindings rather than deciding them. Retiring
   * '*' on a concrete activation is a provisioning-time decision — the operator just narrowed this
   * plugin to one session, so it should stop firing on all of them. At boot there is no such new
   * decision to apply: activeSessions (restored from registry.json) already encodes the outcome of
   * every prior decision, including an explicit PUT /api/plugins/:id/sessions. Re-deriving it from the
   * instance row would silently overwrite that operator choice — and bind the plugin to the row's
   * scope even when that session has since been deleted, leaving it activated for nothing. So the boot
   * path only ever ADDS the row's scope; it removes nothing.
   */
  async applyScopeBinding(
    pluginId: string,
    scope: string | null,
    config: Record<string, unknown>,
    activate: boolean,
    opts: { additive?: boolean } = {},
  ): Promise<void> {
    try {
      if (!scope || scope === '*') {
        // 'all sessions' → base config + activate ['*']. The merged base config cannot be cleanly torn
        // down (updatePluginConfig merges, so one instance's keys aren't separable), but the '*'
        // activation CAN be retired: on deactivate, drop '*' from activeSessions ONLY when no OTHER
        // enabled instance still binds a wildcard/null scope — otherwise disabling/deleting a wildcard
        // instance would leave the plugin firing on every session with stale config.
        if (activate) {
          this.loader.updatePluginConfig(pluginId, config);
          this.loader.setPluginSessions(pluginId, ['*']);
          return;
        }
        const anyWildcardLeft = (await this.instances.list(pluginId)).some(
          i => i.enabled && (!i.sessionScope || i.sessionScope === '*'),
        );
        if (!anyWildcardLeft) {
          const current = this.loader.getPlugin(pluginId)?.activeSessions ?? [];
          this.loader.setPluginSessions(
            pluginId,
            current.filter(s => s !== '*'),
          );
        }
        return;
      }
      // Concrete scope → per-session config + toggle that session in activeSessions. Mirror the
      // wildcard path's retirement guard in BOTH directions: runtime state a still-ENABLED sibling
      // instance depends on must survive this instance's change. The controller persists the row
      // first (PATCH updates/disables it, DELETE removes it), so the list below never counts the
      // instance being torn down.
      const siblings = await this.instances.list(pluginId);
      if (!activate && siblings.some(i => i.enabled && i.sessionScope === scope)) {
        // A sibling still binds this scope, so the SESSION stays active: dropping it would silence
        // that sibling until the next boot-time reconciliation.
        //
        // The config slice does NOT survive with it. It is keyed by scope, so it holds whichever
        // instance was projected last — usually the one being retired here — and once this teardown
        // leaves a single enabled instance on the scope, dispatch re-declares the slice attributable
        // to that survivor (PluginSandboxBridge.scopeHasAtMostOneInstance) and merges it beneath the
        // survivor's own row. A survivor relying on a plugin default for a key it does not define
        // was handed the retired tenant's endpoint and credentials for it — the cross-tenant collapse
        // per-instance resolution exists to prevent, reachable by disabling or deleting one of two
        // instances. Clearing costs the survivor nothing it owns: resolveInstanceConfig layers its
        // own row on top either way, and boot reconciliation re-projects it.
        //
        // An operator's per-session override (PUT /plugins/:id/config/:sessionId) shares this slice
        // and is cleared with it. That is the safe direction — provisioning already overwrites such
        // an override, and a missing default beats another tenant's credential.
        this.loader.setPluginSessionConfig(pluginId, scope, {});
        return;
      }
      this.loader.setPluginSessionConfig(pluginId, scope, activate ? config : {});
      const current = this.loader.getPlugin(pluginId)?.activeSessions ?? [];
      // Provisioning retires '*' (this instance narrows the plugin to one session); the additive boot
      // path keeps the restored set whole, so an operator's PUT /plugins/:id/sessions survives a restart.
      const set = new Set(opts.additive ? current : current.filter(s => s !== '*'));
      if (activate) set.add(scope);
      else set.delete(scope);
      // Preserve '*' while an enabled wildcard/null sibling still binds all sessions ('*' subsumes
      // every concrete scope): a concrete activation/teardown must not silence that sibling either.
      if (current.includes('*') && siblings.some(i => i.enabled && (!i.sessionScope || i.sessionScope === '*'))) {
        set.add('*');
      }
      this.loader.setPluginSessions(pluginId, [...set]);
    } catch (err) {
      // Best-effort: don't fail provisioning if the plugin is momentarily unloaded. WARN (not INFO):
      // the binding is LOST until the next boot-time reconciliation — the instance row reads `enabled`
      // but the ingress worker won't resolve its config — so this degradation must stand out in the
      // audit trail rather than blend into routine update rows.
      void this.audit.logWarn(AuditAction.INTEGRATION_INSTANCE_UPDATED, {
        metadata: { pluginId, scope, bridgeError: String(err) },
      });
    }
  }
}
