import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { AuditService } from '../audit/audit.service';
import { PluginLoaderService } from '../../core/plugins/plugin-loader.service';
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
  ) {}

  /**
   * Re-derive every ENABLED instance's runtime scope binding from the persisted `plugin_instances`
   * rows, so a binding lost at provisioning time (the plugin was momentarily unloaded, so
   * applyScopeBinding was swallowed as an INFO audit) is restored on the next boot without an operator
   * re-PATCH — otherwise the row shows `enabled` but the ingress handler resolves base config only.
   * Runs after every module's onModuleInit (so PluginLoaderService has loaded all plugins).
   *
   * Only enabled rows are (re)activated: a disabled instance must never be force-activated, and issuing
   * its deactivate here could clear a scope a sibling ENABLED instance still binds. applyScopeBinding
   * already no-ops/logs for an unloaded plugin, and its internal try/catch means one instance's failure
   * cannot abort the rest.
   */
  async onApplicationBootstrap(): Promise<void> {
    let rows: PluginInstance[];
    try {
      rows = await this.instances.listAll();
    } catch (err) {
      this.logger.error('Scope-binding reconciliation skipped (failed to list instances)', String(err));
      return;
    }

    // Order-independent reconciliation: listAll() is repo.find() with no ORDER BY, so its row order
    // is DB/restart-dependent (differs between SQLite and Postgres). applyScopeBinding mutates the
    // SAME in-memory plugin.activeSessions each iteration — the concrete-scope path strips '*' while
    // the wildcard path overwrites with ['*'] — so for a plugin with BOTH a wildcard and a concrete
    // instance the final set would otherwise depend on row order (a concrete processed after a
    // wildcard drops the '*'). Sort concrete scopes before wildcard/null so the wildcard's ['*'] is
    // the last write (correct: '*' subsumes every concrete scope), making the result stable across
    // DBs and restarts. instanceId is the deterministic tiebreak among same-rank rows.
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
      await this.applyScopeBinding(inst.pluginId, inst.sessionScope, inst.config ?? {}, true);
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
   * Bind an instance's config to the plugin's runtime so an ingress handler resolves it as ctx.config
   * (see PluginLoaderService.dispatchWebhookForInstance) and activate the session — iff `activate` (a
   * disabled or removed instance must not keep firing). A concrete scope writes sessionConfig[scope] and
   * toggles that session in activeSessions; a null/'*' scope binds the base config + all sessions ('*').
   * Best-effort: provisioning must not fail because the plugin is momentarily unloaded.
   */
  async applyScopeBinding(
    pluginId: string,
    scope: string | null,
    config: Record<string, unknown>,
    activate: boolean,
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
      this.loader.setPluginSessionConfig(pluginId, scope, activate ? config : {});
      const current = this.loader.getPlugin(pluginId)?.activeSessions ?? [];
      const set = new Set(current.filter(s => s !== '*'));
      if (activate) set.add(scope);
      else set.delete(scope);
      this.loader.setPluginSessions(pluginId, [...set]);
    } catch (err) {
      // Best-effort: don't fail provisioning if the plugin is momentarily unloaded.
      void this.audit.logInfo(AuditAction.INTEGRATION_INSTANCE_UPDATED, {
        metadata: { pluginId, scope, bridgeError: String(err) },
      });
    }
  }
}
