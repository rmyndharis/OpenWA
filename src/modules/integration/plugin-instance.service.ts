import { randomBytes } from 'node:crypto';
import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PluginInstance } from './entities/plugin-instance.entity';
import type { PluginConfigSchema } from '../../core/plugins/plugin.interfaces';
import { redactSecretConfig, restoreSecretConfig, SECRET_SENTINEL } from '../plugins/redact-config';

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
export class PluginInstanceService {
  constructor(@InjectRepository(PluginInstance, 'data') private readonly repo: Repository<PluginInstance>) {}

  async mint(
    pluginId: string,
    instanceId: string,
    opts: { sessionScope?: string; verifyToken?: string; secret?: string; config?: Record<string, unknown> },
  ): Promise<PluginInstance> {
    const id = `${pluginId}:${instanceId}`;
    const existing = await this.repo.findOne({ where: { id } });
    if (existing) return existing;
    const inst = this.repo.create({
      id,
      pluginId,
      instanceId,
      sessionScope: opts.sessionScope || null,
      secret: normalizeSecret(opts.secret),
      verifyToken: opts.verifyToken ?? null,
      config: opts.config ?? null,
      enabled: true,
    });
    return this.repo.save(inst);
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
    const id = `${pluginId}:${instanceId}`;
    if (await this.repo.findOne({ where: { id } })) throw new InstanceExistsError(pluginId, instanceId);
    const inst = this.repo.create({
      id,
      pluginId,
      instanceId,
      sessionScope: opts.sessionScope || null,
      secret: normalizeSecret(opts.secret),
      verifyToken: opts.verifyToken ?? null,
      config: opts.config ?? null,
      enabled: true,
    });
    return this.repo.save(inst);
  }

  list(pluginId: string): Promise<PluginInstance[]> {
    return this.repo.find({ where: { pluginId } });
  }

  /** Every persisted instance across all plugins — used by the boot-time scope-binding reconciliation. */
  listAll(): Promise<PluginInstance[]> {
    return this.repo.find();
  }

  async regenerateSecret(pluginId: string, instanceId: string): Promise<PluginInstance> {
    const inst = await this.resolve(pluginId, instanceId);
    if (!inst) throw new Error(`instance ${instanceId} not found for plugin ${pluginId}`);
    inst.secret = randomBytes(32).toString('hex');
    return this.repo.save(inst);
  }

  async setEnabled(pluginId: string, instanceId: string, enabled: boolean): Promise<PluginInstance | null> {
    const inst = await this.resolve(pluginId, instanceId);
    if (!inst) return null;
    inst.enabled = enabled;
    return this.repo.save(inst);
  }

  async update(
    pluginId: string,
    instanceId: string,
    patch: { sessionScope?: string; config?: Record<string, unknown> },
    schema?: PluginConfigSchema,
  ): Promise<PluginInstance | null> {
    const inst = await this.resolve(pluginId, instanceId);
    if (!inst) return null;
    if (patch.sessionScope !== undefined) inst.sessionScope = patch.sessionScope || null;
    if (patch.config !== undefined) {
      // The operator view masks secrets as the sentinel, so a round-tripped config carries '***' for
      // unchanged secrets. Restore the stored values instead of persisting the mask (which would corrupt
      // the credential); genuinely-new values are written as provided.
      inst.config = restoreSecretConfig(patch.config, inst.config ?? undefined, schema);
    }
    return this.repo.save(inst);
  }

  async remove(pluginId: string, instanceId: string): Promise<boolean> {
    const result = await this.repo.delete({ id: `${pluginId}:${instanceId}` });
    return (result.affected ?? 0) > 0;
  }
}
