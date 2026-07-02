import { randomBytes } from 'node:crypto';
import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PluginInstance } from './entities/plugin-instance.entity';
import type { PluginConfigSchema } from '../../core/plugins/plugin.interfaces';

const SECRET_MASK = '***';

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

// Mask every config value the plugin's schema marks `secret:true` (e.g. a Chatwoot apiToken) on operator
// reads — core does not otherwise redact instance `config`. Top-level fields only (the declarative
// configSchema is flat for secret credentials).
function redactSecrets(
  config: Record<string, unknown> | null,
  schema?: PluginConfigSchema,
): Record<string, unknown> | null {
  if (!config) return config;
  // Schema unavailable (plugin unloaded / failed to load) — we can't tell which fields are secret, so
  // fail closed by masking every value rather than risk leaking a credential such as an API token.
  if (!schema?.properties) return Object.fromEntries(Object.keys(config).map(key => [key, SECRET_MASK]));
  const out: Record<string, unknown> = { ...config };
  for (const [key, field] of Object.entries(schema.properties)) {
    if (key in out && field.secret) out[key] = SECRET_MASK;
  }
  return out;
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
  // provider apiToken) per the plugin's configSchema. Reuses the redact-config sentinel convention.
  maskedView(instance: PluginInstance, schema?: PluginConfigSchema): PluginInstance {
    return { ...instance, secret: SECRET_MASK, config: redactSecrets(instance.config, schema) };
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
  ): Promise<PluginInstance | null> {
    const inst = await this.resolve(pluginId, instanceId);
    if (!inst) return null;
    if (patch.sessionScope !== undefined) inst.sessionScope = patch.sessionScope || null;
    if (patch.config !== undefined) inst.config = patch.config;
    return this.repo.save(inst);
  }

  async remove(pluginId: string, instanceId: string): Promise<boolean> {
    const result = await this.repo.delete({ id: `${pluginId}:${instanceId}` });
    return (result.affected ?? 0) > 0;
  }
}
