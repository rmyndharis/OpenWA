import { randomBytes } from 'node:crypto';
import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, QueryDeepPartialEntity, Repository } from 'typeorm';
import { PluginInstance } from './entities/plugin-instance.entity';
import { ConversationMapping } from './entities/conversation-mapping.entity';
import { isUniqueViolation } from '../../common/utils/db-errors';
import { awaitNoOpenTransaction } from '../../common/utils/shared-connection';
import type { PluginConfigSchema, PluginManifest } from '../../core/plugins/plugin.interfaces';
import { restorableConfig } from '../../core/plugins/plugin-activation';
import { redactSecretConfig, restoreSecretConfig, SECRET_SENTINEL } from '../plugins/redact-config';
// Type-only: the module binds this class to PLUGIN_INSTANCE_PORT with a `useExisting` alias, which
// TypeScript does not check, so `implements` is what keeps the two in step.
import type { PluginInstancePort } from '../../core/plugins/plugin-host-ports';

// A supplied ingress secret must be a real, guessing-resistant value; an empty/short one would make the
// public HMAC forgeable. Absent => auto-generate. Trimmed so pasted whitespace can't slip a weak secret in.
function normalizeSecret(supplied?: string): string {
  if (supplied === undefined) return randomBytes(32).toString('hex');
  const s = supplied.trim();
  if (s.length < 16) {
    throw new BadRequestException('instance secret must be a non-empty string of at least 16 characters');
  }
  return s;
}

export class InstanceExistsError extends Error {
  constructor(pluginId: string, instanceId: string) {
    super(`instance ${instanceId} already exists for plugin ${pluginId}`);
    this.name = 'InstanceExistsError';
  }
}

@Injectable()
export class PluginInstanceService implements PluginInstancePort {
  constructor(@InjectRepository(PluginInstance, 'data') private readonly repo: Repository<PluginInstance>) {}

  async mint(
    pluginId: string,
    instanceId: string,
    opts: { sessionScope?: string; verifyToken?: string; secret?: string; config?: Record<string, unknown> },
  ): Promise<PluginInstance> {
    const existing = await this.resolve(pluginId, instanceId);
    if (existing) return existing;
    return (
      (await this.insert(pluginId, instanceId, opts)) ?? ((await this.resolve(pluginId, instanceId)) as PluginInstance)
    );
  }

  // A plain INSERT, never save(): with the primary key set, save() re-selects and turns a concurrent
  // duplicate into an UPDATE that overwrites the first row's secret. Null when the id already exists.
  private async insert(
    pluginId: string,
    instanceId: string,
    opts: { sessionScope?: string; verifyToken?: string; secret?: string; config?: Record<string, unknown> },
  ): Promise<PluginInstance | null> {
    const inst = this.repo.create({
      id: `${pluginId}:${instanceId}`,
      pluginId,
      instanceId,
      sessionScope: opts.sessionScope || null,
      secret: normalizeSecret(opts.secret),
      verifyToken: opts.verifyToken || randomBytes(16).toString('hex'),
      config: opts.config ?? null,
      enabled: true,
    });
    try {
      await this.repo.insert(inst as QueryDeepPartialEntity<PluginInstance>);
    } catch (err) {
      if (isUniqueViolation(err)) return null;
      throw err;
    }
    return inst;
  }

  resolve(pluginId: string, instanceId: string): Promise<PluginInstance | null> {
    return this.repo.findOne({ where: { id: `${pluginId}:${instanceId}` } });
  }

  // Operator-facing view: never leak the raw secret, and mask any `secret:true` config field (e.g. a
  // provider apiToken) per the plugin's configSchema — recursively, at any depth, and fail-closed when
  // the schema is unavailable — by reusing the shared redactSecretConfig (single source of truth).
  maskedView(instance: PluginInstance, schema?: PluginConfigSchema): PluginInstance {
    return {
      ...instance,
      secret: SECRET_SENTINEL,
      config: instance.config == null ? instance.config : redactSecretConfig(instance.config, schema),
    };
  }

  async create(
    pluginId: string,
    instanceId: string,
    opts: { sessionScope?: string; verifyToken?: string; secret?: string; config?: Record<string, unknown> },
  ): Promise<PluginInstance> {
    if (await this.resolve(pluginId, instanceId)) throw new InstanceExistsError(pluginId, instanceId);
    const inst = await this.insert(pluginId, instanceId, opts);
    if (!inst) throw new InstanceExistsError(pluginId, instanceId);
    return inst;
  }

  list(pluginId: string): Promise<PluginInstance[]> {
    return this.repo.find({ where: { pluginId } });
  }

  /** Every persisted instance across all plugins — used by the boot-time scope-binding reconciliation. */
  listAll(): Promise<PluginInstance[]> {
    return this.repo.find();
  }

  // update() and regenerateSecret() write only the columns they change, and only to a row that still
  // exists: a whole-row save() would re-insert a row deleted meanwhile, or write back a stale secret
  // over a concurrent rotation. Both re-read the row after the write so the result carries the fresh
  // updatedAt the database stamped.
  async regenerateSecret(pluginId: string, instanceId: string): Promise<PluginInstance | null> {
    const inst = await this.resolve(pluginId, instanceId);
    const secret = randomBytes(32).toString('hex');
    const written = inst ? (await this.repo.update({ id: inst.id }, { secret })).affected : 0;
    return written ? this.resolve(pluginId, instanceId) : null;
  }

  async update(
    pluginId: string,
    instanceId: string,
    patch: { enabled?: boolean; sessionScope?: string | null; config?: Record<string, unknown> },
    schema?: PluginConfigSchema,
    layer?: { net?: PluginManifest['net']; beneath?: Record<string, unknown> },
  ): Promise<PluginInstance | null> {
    const inst = await this.resolve(pluginId, instanceId);
    if (!inst) return null;
    const changes: Partial<Pick<PluginInstance, 'enabled' | 'sessionScope' | 'config'>> = {};
    if (patch.enabled !== undefined) changes.enabled = patch.enabled;
    if (patch.sessionScope !== undefined) changes.sessionScope = patch.sessionScope || null;
    if (patch.config !== undefined) {
      // The operator view masks secrets as the sentinel, so a round-tripped config carries '***' for
      // unchanged secrets. Restore the stored values instead of persisting the mask (which would corrupt
      // the credential); genuinely-new values are written as provided.
      // A PATCH that points a host key at another origin gets no stored secret back, see restorableConfig.
      const stored = restorableConfig(
        inst.config ?? undefined,
        patch.config,
        { configSchema: schema, net: layer?.net },
        layer?.beneath,
      );
      changes.config = restoreSecretConfig(patch.config, stored, schema);
    }
    if (Object.keys(changes).length === 0) return inst;
    const { affected } = await this.repo.update({ id: inst.id }, changes as QueryDeepPartialEntity<PluginInstance>);
    return affected ? this.resolve(pluginId, instanceId) : null;
  }

  async remove(pluginId: string, instanceId: string): Promise<boolean> {
    // On SQLite every caller shares one connection: opened beside another caller's transaction, this one would be a
    // savepoint in it or carry that one's writes, and either rollback could undo what the other had answered for.
    if (!(await awaitNoOpenTransaction(this.repo.manager.dataSource))) {
      throw new ServiceUnavailableException(
        `Instance ${instanceId} was not deleted: another database transaction stayed open. Retry the delete.`,
      );
    }
    return this.repo.manager.transaction(async manager => {
      const result = await manager.delete(PluginInstance, { id: `${pluginId}:${instanceId}` });
      // Its conversation mappings stay, so the same instance provisioned again keeps its provider
      // conversations. A takeover they hold does not: it is scoped to the chat, not to the plugin, and
      // with the instance gone nothing can hand the chat back, so it would keep every other plugin
      // silent there for good.
      await manager.update(
        ConversationMapping,
        { pluginId, instanceId, handoverState: In(['human', 'closed']) },
        { handoverState: 'bot' },
      );
      return (result.affected ?? 0) > 0;
    });
  }
}
