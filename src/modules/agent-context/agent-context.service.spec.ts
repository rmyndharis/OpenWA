import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { AgentContextService } from './agent-context.service';
import { Message, MessageDirection, MessageStatus } from '../message/entities/message.entity';
import { MessageQuote } from '../message/entities/message-quote.entity';
import { MessageReaction } from '../message/entities/message-reaction.entity';
import { LidMappingStoreService, type LidMappingStore } from '../../engine/identity/lid-mapping-store.service';

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    sessionId: 'session-a',
    waMessageId: 'wa-message-1',
    chatId: '123@lid',
    from: '123@lid',
    to: 'self@c.us',
    body: 'hello',
    type: 'text',
    direction: MessageDirection.INCOMING,
    timestamp: 1700000000,
    metadata: { raw: 'must never be exposed' },
    status: MessageStatus.SENT,
    createdAt: new Date('2026-01-01T12:00:00.000Z'),
    ...overrides,
  };
}

function lidStore(
  entries: Record<string, string | null> = {},
  aliases: Record<string, string[]> = {},
): LidMappingStore {
  return {
    getCached: jest.fn((lid: string) => entries[lid]),
    lidsForPhone: jest.fn((phone: string) => aliases[phone] ?? []),
    remember: jest.fn(),
  };
}

describe('AgentContextService', () => {
  let repository: jest.Mocked<Pick<Repository<Message>, 'findOne' | 'createQueryBuilder'>>;
  let quotes: jest.Mocked<Pick<Repository<MessageQuote>, 'find'>>;
  let reactions: jest.Mocked<Pick<Repository<MessageReaction>, 'find'>>;
  let recent: Message[];
  let queryBuilder: Record<string, jest.Mock>;

  beforeEach(() => {
    recent = [];
    queryBuilder = {
      select: jest.fn(),
      where: jest.fn(),
      andWhere: jest.fn(),
      orderBy: jest.fn(),
      addOrderBy: jest.fn(),
      take: jest.fn(),
      getMany: jest.fn(() => Promise.resolve(recent)),
    };
    for (const method of ['select', 'where', 'andWhere', 'orderBy', 'addOrderBy', 'take']) {
      queryBuilder[method].mockReturnValue(queryBuilder);
    }
    repository = {
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(() => queryBuilder),
      // The production data connection has this manager metadata; use SQLite semantics for this unit mock.
      manager: { connection: { options: { type: 'better-sqlite3' } } },
    } as unknown as jest.Mocked<Pick<Repository<Message>, 'findOne' | 'createQueryBuilder'>>;
    quotes = { find: jest.fn().mockResolvedValue([]) };
    reactions = { find: jest.fn().mockResolvedValue([]) };
  });

  const createService = (entries: Record<string, string | null> = {}, aliases: Record<string, string[]> = {}) =>
    new AgentContextService(
      repository as unknown as Repository<Message>,
      lidStore(entries, aliases) as LidMappingStoreService,
      quotes as unknown as Repository<MessageQuote>,
      reactions as unknown as Repository<MessageReaction>,
    );

  it('returns a bounded, read-only context with canonical identities, receipt status, and no raw metadata', async () => {
    const target = message({ body: 'x'.repeat(1200) });
    recent = Array.from({ length: 8 }, (_, index) =>
      message({ id: `00000000-0000-4000-8000-00000000000${index}`, body: `recent ${index}` }),
    );
    repository.findOne.mockResolvedValue(target);

    const context = await createService({ '123': '15551234567' }).getMessageContext('session-a', target.id);

    expect(context.message).toEqual({
      id: target.id,
      canonicalChat: { canonicalJid: '15551234567@c.us', kind: 'person', resolution: 'phone-resolved' },
      sender: { canonicalJid: '15551234567@c.us', kind: 'person', resolution: 'phone-resolved' },
      direction: 'incoming',
      type: 'text',
      body: 'x'.repeat(1000),
      occurredAt: '2023-11-14T22:13:20.000Z',
      receipt: { status: MessageStatus.SENT },
    });
    expect(context.conversation).toHaveLength(6);
    expect(JSON.stringify(context)).not.toContain('must never be exposed');
    expect(JSON.stringify(context)).not.toContain('wa-message-1');
    expect(repository.findOne).toHaveBeenCalledWith({
      where: { id: target.id, sessionId: 'session-a' },
      select: ['id', 'sessionId', 'chatId', 'from', 'body', 'type', 'direction', 'timestamp', 'status', 'createdAt'],
    });
    expect(queryBuilder.select).toHaveBeenCalledWith([
      'message.id',
      'message.sessionId',
      'message.chatId',
      'message.from',
      'message.body',
      'message.type',
      'message.direction',
      'message.timestamp',
      'message.status',
      'message.createdAt',
    ]);
    expect(queryBuilder.take).toHaveBeenCalledWith(6);
    expect(JSON.stringify(queryBuilder.select.mock.calls)).not.toContain('metadata');
  });

  it('anchors history at the trigger, includes it, and uses WhatsApp time rather than delayed DB arrival', async () => {
    const target = message({
      id: '00000000-0000-4000-8000-000000000010',
      timestamp: 100,
      createdAt: new Date('2026-01-10'),
    });
    const sameSecondButNotKnownEarlier = message({
      id: '00000000-0000-4000-8000-000000000001',
      timestamp: 100,
      createdAt: new Date('2026-03-10'),
    });
    const older = message({
      id: '00000000-0000-4000-8000-000000000009',
      timestamp: 99,
      createdAt: new Date('2026-02-10'),
    });
    // WhatsApp timestamps are only second-granularity. Until an engine sequence key exists, the
    // conservative database query includes only the exact trigger at this second.
    recent = [target, older];
    repository.findOne.mockResolvedValue(target);

    const context = await createService().getMessageContext('session-a', target.id);

    expect(context.conversation.map(item => item.id)).toEqual([target.id, older.id]);
    expect(context.conversation.map(item => item.occurredAt)).toEqual([
      '1970-01-01T00:01:40.000Z',
      '1970-01-01T00:01:39.000Z',
    ]);
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('message.id = :triggerId'),
      expect.objectContaining({ triggerId: target.id }),
    );
    expect(JSON.stringify(queryBuilder.andWhere.mock.calls)).not.toContain('<= :triggerId');
    expect(sameSecondButNotKnownEarlier.id).not.toBe(context.conversation[0]?.id);
  });

  it('excludes a later same-second message even when its random UUID sorts below the trigger UUID', async () => {
    const target = message({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', timestamp: 100 });
    const laterSameSecond = message({ id: '00000000-0000-4000-8000-000000000001', timestamp: 100 });
    // This is the exact SQL result the query must return: UUID sort is not a WhatsApp event sequence.
    recent = [target];
    repository.findOne.mockResolvedValue(target);

    const context = await createService().getMessageContext('session-a', target.id);

    expect(context.conversation.map(item => item.id)).toEqual([target.id]);
    expect(laterSameSecond.id < target.id).toBe(true);
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('message.id = :triggerId'),
      expect.objectContaining({ triggerId: target.id }),
    );
  });

  it('falls back to createdAt only when WhatsApp timestamp is absent', async () => {
    const target = message({ timestamp: null as unknown as number, createdAt: new Date('2026-01-01T00:00:00.000Z') });
    recent = [target];
    repository.findOne.mockResolvedValue(target);

    const context = await createService().getMessageContext('session-a', target.id);

    expect(context.message.occurredAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('uses one same-session raw-chat bucket for a resolved LID, its phone JID, and mapped LID aliases', async () => {
    const target = message({ id: '00000000-0000-4000-8000-000000000010', chatId: '123@lid', timestamp: 100 });
    const phoneHistory = message({
      id: '00000000-0000-4000-8000-000000000009',
      chatId: '15551234567@c.us',
      timestamp: 99,
    });
    const aliasHistory = message({
      id: '00000000-0000-4000-8000-000000000008',
      chatId: '456@lid',
      timestamp: 98,
    });
    recent = [target, phoneHistory, aliasHistory];
    repository.findOne.mockResolvedValue(target);

    const context = await createService(
      { '123': '15551234567', '456': '15551234567' },
      { '15551234567': ['123', '456'] },
    ).getMessageContext('session-a', target.id);

    expect(context.conversation.map(item => item.id)).toEqual([target.id, phoneHistory.id, aliasHistory.id]);
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('message.chatId IN (:...chatIds)', {
      chatIds: ['123@lid', '15551234567@c.us', '15551234567@s.whatsapp.net', '456@lid'],
    });
  });

  it('includes both direct-user JID dialects for a resolved phone trigger', async () => {
    const target = message({ chatId: '15551234567@c.us', timestamp: 100 });
    const protocolDialectHistory = message({
      id: '00000000-0000-4000-8000-000000000009',
      chatId: '15551234567@s.whatsapp.net',
      timestamp: 99,
    });
    recent = [target, protocolDialectHistory];
    repository.findOne.mockResolvedValue(target);

    const context = await createService().getMessageContext('session-a', target.id);

    expect(context.conversation.map(item => item.id)).toEqual([target.id, protocolDialectHistory.id]);
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('message.chatId IN (:...chatIds)', {
      chatIds: ['15551234567@c.us', '15551234567@s.whatsapp.net'],
    });
  });

  it('keeps an unresolved LID isolated and does not guess a phone/alias bucket', async () => {
    const target = message({ chatId: '999@lid', timestamp: 100 });
    recent = [target];
    repository.findOne.mockResolvedValue(target);
    const mappedAliases = jest.fn(() => ['123', '456']);
    const mappings: LidMappingStore = {
      getCached: jest.fn(() => null),
      lidsForPhone: mappedAliases,
      remember: jest.fn(),
    };
    const service = new AgentContextService(
      repository as unknown as Repository<Message>,
      mappings as LidMappingStoreService,
      quotes as unknown as Repository<MessageQuote>,
      reactions as unknown as Repository<MessageReaction>,
    );

    await service.getMessageContext('session-a', target.id);

    expect(queryBuilder.andWhere).toHaveBeenCalledWith('message.chatId IN (:...chatIds)', { chatIds: ['999@lid'] });
    expect(mappedAliases).not.toHaveBeenCalled();
  });

  it('projects only typed quote and bounded typed reactions', async () => {
    const target = message({ status: MessageStatus.READ });
    recent = [target];
    repository.findOne.mockResolvedValue(target);
    quotes.find.mockResolvedValue([
      {
        messageId: target.id,
        sessionId: 'session-a',
        quotedWaMessageId: 'quoted-id',
        body: 'q'.repeat(1200),
      },
    ]);
    reactions.find.mockResolvedValue([
      { messageId: target.id, sessionId: 'session-a', senderId: '123@lid', emoji: '👍' },
    ]);

    const context = await createService({ '123': '15551234567' }).getMessageContext('session-a', target.id);

    expect(context.message).toEqual(
      expect.objectContaining({
        receipt: { status: MessageStatus.READ },
        quote: { messageId: 'quoted-id', body: 'q'.repeat(1000) },
        reactions: [
          { sender: { canonicalJid: '15551234567@c.us', kind: 'person', resolution: 'phone-resolved' }, emoji: '👍' },
        ],
      }),
    );
    expect(reactions.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sessionId: 'session-a', messageId: target.id },
        take: 16,
        select: ['messageId', 'senderId', 'emoji'],
      }),
    );
  });

  it('does not use the surface as a general message reader', async () => {
    repository.findOne.mockResolvedValue(message({ direction: MessageDirection.OUTGOING }));
    await expect(
      createService().getMessageContext('session-a', '11111111-1111-4111-8111-111111111111'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('does not reveal whether a message exists in another session', async () => {
    repository.findOne.mockResolvedValue(null);
    await expect(
      createService().getMessageContext('session-a', '11111111-1111-4111-8111-111111111111'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('omits an absent body instead of synthesizing content from metadata', async () => {
    const target = message({
      body: null as unknown as string,
      metadata: { fallbackText: 'private metadata must not become body' },
    });
    recent = [target];
    repository.findOne.mockResolvedValue(target);
    const context = await createService().getMessageContext('session-a', target.id);
    expect(context.message).not.toHaveProperty('body');
    expect(JSON.stringify(context)).not.toContain('private metadata');
  });
});
