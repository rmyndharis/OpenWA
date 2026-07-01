import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PluginInstance } from './entities/plugin-instance.entity';

const SECRET_MASK = '***';

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
    opts: { sessionScope?: string; verifyToken?: string; config?: Record<string, unknown> },
  ): Promise<PluginInstance> {
    const id = `${pluginId}:${instanceId}`;
    const existing = await this.repo.findOne({ where: { id } });
    if (existing) return existing;
    const inst = this.repo.create({
      id,
      pluginId,
      instanceId,
      sessionScope: opts.sessionScope ?? null,
      secret: randomBytes(32).toString('hex'),
      verifyToken: opts.verifyToken ?? null,
      config: opts.config ?? null,
      enabled: true,
    });
    return this.repo.save(inst);
  }

  resolve(pluginId: string, instanceId: string): Promise<PluginInstance | null> {
    return this.repo.findOne({ where: { id: `${pluginId}:${instanceId}` } });
  }

  // Operator-facing view: never leak the raw secret. Reuses the redact-config sentinel convention.
  maskedView(instance: PluginInstance): PluginInstance {
    return { ...instance, secret: SECRET_MASK };
  }

  async create(
    pluginId: string,
    instanceId: string,
    opts: { sessionScope?: string; verifyToken?: string; config?: Record<string, unknown> },
  ): Promise<PluginInstance> {
    const id = `${pluginId}:${instanceId}`;
    if (await this.repo.findOne({ where: { id } })) throw new InstanceExistsError(pluginId, instanceId);
    const inst = this.repo.create({
      id,
      pluginId,
      instanceId,
      sessionScope: opts.sessionScope ?? null,
      secret: randomBytes(32).toString('hex'),
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
    if (patch.sessionScope !== undefined) inst.sessionScope = patch.sessionScope;
    if (patch.config !== undefined) inst.config = patch.config;
    return this.repo.save(inst);
  }

  async remove(pluginId: string, instanceId: string): Promise<boolean> {
    const result = await this.repo.delete({ id: `${pluginId}:${instanceId}` });
    return (result.affected ?? 0) > 0;
  }
}
