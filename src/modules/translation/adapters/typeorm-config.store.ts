// src/modules/translation/adapters/typeorm-config.store.ts
import { Repository } from 'typeorm';
import { ConfigStore, GroupState } from '../core/ports';
import { TranslationGroup } from '../entities/translation-group.entity';

export class TypeOrmConfigStore implements ConfigStore {
  constructor(private readonly repo: Repository<TranslationGroup>) {}

  async load(sessionId: string, chatId: string): Promise<GroupState> {
    const row = await this.repo.findOne({ where: { sessionId, chatId } });
    if (!row) {
      return { sessionId, chatId, active: false, participants: {}, delegatedControllers: [], announced: false };
    }
    return {
      sessionId: row.sessionId,
      chatId: row.chatId,
      active: row.active,
      participants: row.participants ?? {},
      delegatedControllers: row.delegatedControllers ?? [],
      announced: row.announcedAt !== null && row.announcedAt !== undefined,
    };
  }

  async save(state: GroupState): Promise<void> {
    const existing = await this.repo.findOne({ where: { sessionId: state.sessionId, chatId: state.chatId } });
    const entity = existing ?? this.repo.create({ sessionId: state.sessionId, chatId: state.chatId });
    entity.active = state.active;
    entity.participants = state.participants;
    entity.delegatedControllers = state.delegatedControllers;
    if (state.announced && !entity.announcedAt) entity.announcedAt = new Date();
    await this.repo.save(entity);
  }
}
