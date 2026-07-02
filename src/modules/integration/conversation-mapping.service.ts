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

  // Session+chat-scoped handover lookup for the core gate: the most-recently-updated human/closed row for
  // this chat, IGNORING pluginId. A handover taken by one plugin (e.g. the Chatwoot relay) then governs
  // every plugin on that chat — the gate exempts the owner and silences the rest.
  async findHandoverForChat(
    sessionId: string,
    chatId: string,
  ): Promise<{ pluginId: string; handoverState: HandoverState } | null> {
    const row = await this.repo.findOne({
      where: [
        { sessionId, chatId, handoverState: 'human' },
        { sessionId, chatId, handoverState: 'closed' },
      ],
      order: { updatedAt: 'DESC' },
    });
    return row ? { pluginId: row.pluginId, handoverState: row.handoverState } : null;
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
