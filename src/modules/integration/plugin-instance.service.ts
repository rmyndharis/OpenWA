import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PluginInstance } from './entities/plugin-instance.entity';

const SECRET_MASK = '***';

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
}
