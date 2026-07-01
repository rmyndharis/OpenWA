import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryDeepPartialEntity, Repository } from 'typeorm';
import { ConversationMapping, HandoverState } from './entities/conversation-mapping.entity';

export interface MappingKey {
  sessionId: string;
  chatId: string;
  pluginId: string;
  instanceId: string;
}

@Injectable()
export class ConversationMappingService {
  constructor(@InjectRepository(ConversationMapping, 'data') private readonly repo: Repository<ConversationMapping>) {}

  async upsert(key: MappingKey, providerConversationId: string, patch?: Partial<ConversationMapping>): Promise<void> {
    const existing = await this.repo.findOne({ where: key });
    if (existing) {
      await this.repo.update({ id: existing.id }, {
        providerConversationId,
        ...patch,
      } as QueryDeepPartialEntity<ConversationMapping>);
      return;
    }
    await this.repo.save(this.repo.create({ ...key, providerConversationId, handoverState: 'bot', ...patch }));
  }

  get(key: MappingKey): Promise<ConversationMapping | null> {
    return this.repo.findOne({ where: key });
  }

  // Handover-gate lookup: any mapped instance for this plugin's chat, without resolving a specific
  // instanceId at message time. The gate only needs "is THIS plugin's chat handed over?" — if a plugin
  // has multiple instances mapped to the same chat, they share handover intent for this purpose.
  findForChat(sessionId: string, chatId: string, pluginId: string): Promise<ConversationMapping | null> {
    return this.repo.findOne({ where: { sessionId, chatId, pluginId } });
  }

  getByProvider(
    pluginId: string,
    instanceId: string,
    providerConversationId: string,
  ): Promise<ConversationMapping | null> {
    return this.repo.findOne({ where: { pluginId, instanceId, providerConversationId } });
  }

  async setHandover(id: string, state: HandoverState): Promise<void> {
    await this.repo.update({ id }, { handoverState: state });
  }
}
