import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryDeepPartialEntity, Repository } from 'typeorm';
import { ConversationMapping, HandoverState } from './entities/conversation-mapping.entity';
import { isUniqueViolation } from '../../common/utils/db-errors';

export interface MappingKey {
  sessionId: string;
  chatId: string;
  pluginId: string;
  instanceId: string;
}

/**
 * Thrown when a providerConversationId is already bound to a DIFFERENT chat for the same plugin+instance
 * (the reverse unique key). Unlike a forward-key race — which converges by updating the existing row —
 * this is a genuine conflict with no row to fall back to, so it surfaces instead of corrupting state.
 */
export class ConversationMappingConflict extends Error {
  constructor(
    readonly key: MappingKey,
    readonly providerConversationId: string,
  ) {
    super(
      `conversation mapping conflict: providerConversationId "${providerConversationId}" is already bound to ` +
        `a different chat for plugin "${key.pluginId}" instance "${key.instanceId}"`,
    );
    this.name = 'ConversationMappingConflict';
  }
}

@Injectable()
export class ConversationMappingService {
  constructor(@InjectRepository(ConversationMapping, 'data') private readonly repo: Repository<ConversationMapping>) {}

  async upsert(key: MappingKey, providerConversationId: string, patch?: Partial<ConversationMapping>): Promise<void> {
    const existing = await this.repo.findOne({ where: key });
    if (existing) {
      await this.updateById(existing.id, key, providerConversationId, patch);
      return;
    }
    try {
      await this.repo.save(this.repo.create({ ...key, providerConversationId, handoverState: 'bot', ...patch }));
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // A concurrent writer inserted between our findOne and save (forward-key race) OR the reverse
      // unique (pluginId,instanceId,providerConversationId) is bound to another chat. Re-read the
      // FORWARD key: found → converge by updating it; not found → genuine reverse conflict → surface.
      const raced = await this.repo.findOne({ where: key });
      if (raced) {
        await this.updateById(raced.id, key, providerConversationId, patch);
        return;
      }
      throw new ConversationMappingConflict(key, providerConversationId);
    }
  }

  // Update guarded against a reverse-unique collision: moving a row's providerConversationId onto a value
  // already bound to another chat throws ConversationMappingConflict rather than a raw QueryFailedError.
  private async updateById(
    id: string,
    key: MappingKey,
    providerConversationId: string,
    patch?: Partial<ConversationMapping>,
  ): Promise<void> {
    try {
      await this.repo.update({ id }, {
        providerConversationId,
        ...patch,
      } as QueryDeepPartialEntity<ConversationMapping>);
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConversationMappingConflict(key, providerConversationId);
      throw err;
    }
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
