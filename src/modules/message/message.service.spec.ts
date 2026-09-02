import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MessageService, spendInlineMediaBudget } from './message.service';
import { MessageSendService } from './message-send.service';
import { Message, MessageDirection } from './entities/message.entity';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { MessageProjector } from '../session/message-projector.service';
import type { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { HookManager } from '../../core/hooks';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { SendPacingService } from './send-pacing.service';

/** Pacing is off by default in these tests; the governor's own spec covers its behaviour. */
const inertPacing = (): SendPacingService =>
  ({
    assertSendAllowed: jest.fn().mockResolvedValue(undefined),
    recordSendFailure: jest.fn(),
    recordSendSuccess: jest.fn(),
  }) as unknown as SendPacingService;

function createMockEngine() {
  return {
    reactToMessage: jest.fn().mockResolvedValue(undefined),
    getMessageReactions: jest.fn().mockResolvedValue([]),
    deleteMessage: jest.fn().mockResolvedValue(undefined),
    pinMessage: jest.fn().mockResolvedValue(undefined),
    starMessage: jest.fn().mockResolvedValue(undefined),
    votePoll: jest.fn().mockResolvedValue(undefined),
    unpinMessage: jest.fn().mockResolvedValue(undefined),
    editMessage: jest.fn().mockResolvedValue({ id: 'wa-msg-1', timestamp: 1706868000 }),
    getChatHistory: jest.fn().mockResolvedValue([]),
  };
}

describe('MessageService', () => {
  let service: MessageService;
  let repository: jest.Mocked<Partial<Repository<Message>>>;
  let engines: EngineRegistry;
  let messageProjector: { recordOutboundMessageEdit: jest.Mock };
  let hookManager: jest.Mocked<Partial<HookManager>>;
  let lidMappingStore: { lidsForPhone: jest.Mock; getCached: jest.Mock };
  let mockEngine: ReturnType<typeof createMockEngine>;

  beforeEach(async () => {
    repository = {
      create: jest.fn().mockImplementation((data: Partial<Message>) => ({ id: 'msg-uuid-1', ...data }) as Message),
      save: jest.fn().mockImplementation(msg => Promise.resolve(msg)),
      findOne: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(),
    };

    mockEngine = createMockEngine();

    messageProjector = { recordOutboundMessageEdit: jest.fn().mockResolvedValue(undefined) };

    engines = new EngineRegistry();
    engines.set('sess-1', mockEngine as unknown as IWhatsAppEngine);

    hookManager = {
      // Echo the input straight back so the message:sending gate is a pass-through by default; the
      // edit tests override with continue:false (block) or a modified input.
      execute: jest
        .fn()
        .mockImplementation((_event: string, data: unknown) => Promise.resolve({ continue: true, data })),
    };

    lidMappingStore = { lidsForPhone: jest.fn().mockReturnValue([]), getCached: jest.fn().mockReturnValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessageService,
        // The send family lives on MessageSendService; nothing here exercises it, so a bare stub
        // stands in for the delegation target.
        { provide: MessageSendService, useValue: {} },
        {
          provide: SendPacingService,
          useValue: {
            assertSendAllowed: jest.fn().mockResolvedValue(undefined),
            recordSendFailure: jest.fn(),
            recordSendSuccess: jest.fn(),
          },
        },
        { provide: getRepositoryToken(Message, 'data'), useValue: repository },
        { provide: EngineRegistry, useValue: engines },
        { provide: MessageProjector, useValue: messageProjector },
        { provide: HookManager, useValue: hookManager },
        { provide: LidMappingStoreService, useValue: lidMappingStore },
      ],
    }).compile();

    service = module.get<MessageService>(MessageService);
  });

  // ── outbound send delegation ──────────────────────────────────────

  describe('outbound send delegation', () => {
    it('passes a send request straight through to MessageSendService and returns its answer', async () => {
      const sendText = jest.fn().mockResolvedValue({ messageId: 'wa-msg-1', timestamp: 1706868000 });
      const facade = new MessageService(
        repository as Repository<Message>,
        engines,
        messageProjector as unknown as MessageProjector,
        hookManager as HookManager,
        lidMappingStore as unknown as LidMappingStoreService,
        inertPacing(),
        { sendText } as unknown as MessageSendService,
      );

      const result = await facade.sendText('sess-1', { chatId: 'test@c.us', text: 'hi' });

      expect(sendText).toHaveBeenCalledWith('sess-1', { chatId: 'test@c.us', text: 'hi' });
      expect(result).toEqual({ messageId: 'wa-msg-1', timestamp: 1706868000 });
    });

    it('passes a reply straight through with its tag list intact', async () => {
      // This forwarder is the entry point the controller and the agent tool both call. Its parameter
      // was an inline three-field literal while the controller already handed it a fourth, so the
      // body reached the sender only because structural typing does not strip excess properties.
      const reply = jest.fn().mockResolvedValue({ messageId: 'wa-msg-2', timestamp: 1706868001 });
      const facade = new MessageService(
        repository as Repository<Message>,
        engines,
        messageProjector as unknown as MessageProjector,
        hookManager as HookManager,
        lidMappingStore as unknown as LidMappingStoreService,
        inertPacing(),
        { reply } as unknown as MessageSendService,
      );

      const body = { chatId: 'g@g.us', quotedMessageId: 'Q1', text: 'hi @62811', mentions: ['62811@c.us'] };
      await facade.reply('sess-1', body);

      expect(reply).toHaveBeenCalledWith('sess-1', body);
    });
  });

  // ── getMessages pagination guard ──────────────────────────────────

  describe('getMessages pagination guard', () => {
    interface QbMock {
      where: jest.Mock;
      orderBy: jest.Mock;
      addOrderBy: jest.Mock;
      skip: jest.Mock;
      take: jest.Mock;
      andWhere: jest.Mock;
      getManyAndCount: jest.Mock;
    }
    const makeQb = (): QbMock => {
      const qb: QbMock = {
        where: jest.fn(),
        orderBy: jest.fn(),
        addOrderBy: jest.fn(),
        skip: jest.fn(),
        take: jest.fn(),
        andWhere: jest.fn(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      };
      qb.where.mockReturnValue(qb);
      qb.orderBy.mockReturnValue(qb);
      qb.addOrderBy.mockReturnValue(qb);
      qb.skip.mockReturnValue(qb);
      qb.take.mockReturnValue(qb);
      qb.andWhere.mockReturnValue(qb);
      return qb;
    };

    it('falls back to defaults on NaN limit/offset (never take(NaN))', async () => {
      const qb = makeQb();
      (repository.createQueryBuilder as jest.Mock).mockReturnValue(qb);
      await service.getMessages('sess-1', { limit: NaN, offset: NaN });
      expect(qb.take).toHaveBeenCalledWith(50);
      expect(qb.skip).toHaveBeenCalledWith(0);
    });

    it('clamps an oversized limit to 100 and a negative offset to 0', async () => {
      const qb = makeQb();
      (repository.createQueryBuilder as jest.Mock).mockReturnValue(qb);
      await service.getMessages('sess-1', { limit: 999, offset: -5 });
      expect(qb.take).toHaveBeenCalledWith(100);
      expect(qb.skip).toHaveBeenCalledWith(0);
    });
  });

  // ── getMessages keyset cursor ─────────────────────────────────────

  describe('getMessages anchors on `after` instead of a count', () => {
    /** The cursor path clones for the count and reads rows separately, so getManyAndCount is unused. */
    const makeCursorQb = (rows: Message[]) => {
      const qb = {
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        clone: jest.fn(),
        getCount: jest.fn().mockResolvedValue(7),
        getMany: jest.fn().mockResolvedValue(rows),
        getManyAndCount: jest.fn(),
      };
      qb.clone.mockReturnValue(qb);
      return qb;
    };

    it('narrows on the anchor row and leaves skip() unused, so a concurrent write cannot shift the window', async () => {
      const qb = makeCursorQb([{ id: 'm-2' } as Message]);
      (repository.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      const result = await service.getMessages('sess-1', { after: 'm-1', offset: 500 });

      expect(qb.skip).not.toHaveBeenCalled();
      expect(qb.getManyAndCount).not.toHaveBeenCalled();
      const [clause, params] = qb.andWhere.mock.calls[0] as [string, Record<string, unknown>];
      expect(clause).toContain('(message.createdAt, message.id) <');
      // The anchor's sort key is resolved in SQL; only the id crosses the JS boundary.
      expect(clause).toContain('FROM messages anchor');
      expect(params).toEqual({ after: 'm-1', sessionId: 'sess-1' });
      // `total` counts the filter match, not the post-cursor remainder, so it stays stable per page.
      expect(result.total).toBe(7);
    });

    it('rejects a cursor that names no row in this session rather than reading as end-of-history', async () => {
      const qb = makeCursorQb([]);
      (repository.createQueryBuilder as jest.Mock).mockReturnValue(qb);
      repository.exists = jest.fn().mockResolvedValue(false);

      await expect(service.getMessages('sess-1', { after: 'nope' })).rejects.toThrow(BadRequestException);
      expect(repository.exists).toHaveBeenCalledWith({ where: { id: 'nope', sessionId: 'sess-1' } });
    });

    it('returns an empty page, not an error, when a valid cursor reaches the end of the history', async () => {
      const qb = makeCursorQb([]);
      (repository.createQueryBuilder as jest.Mock).mockReturnValue(qb);
      repository.exists = jest.fn().mockResolvedValue(true);

      await expect(service.getMessages('sess-1', { after: 'm-last' })).resolves.toEqual({ messages: [], total: 7 });
    });
  });

  // ── getMessages from-filter (lid resolution becomes a hit) ─────────
  describe('getMessages from-filter resolves a lid to a phone', () => {
    // A group message whose stored author is an unresolved lid, plus a plain DM from the same person.
    const lidRow = { id: 'm-lid', from: '111@lid', chatId: 'grp@g.us' } as Message;
    const dmRow = { id: 'm-dm', from: '628999@c.us', chatId: '628999@c.us' } as Message;
    const rows = [lidRow, dmRow];

    // A query-builder fake that actually filters by the `(from IN (:...froms) OR author IN (:...authorFroms))`
    // clause it receives, so the test exercises the resolution-driven expansion end to end (filter -> rows).
    const makeFilteringQb = () => {
      let froms: string[] | null = null;
      let authorFroms: string[] | null = null;
      const qb = {
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        andWhere: jest
          .fn()
          .mockImplementation((_clause: string, params?: { froms?: string[]; authorFroms?: string[] }) => {
            if (params?.froms) froms = params.froms;
            if (params?.authorFroms) authorFroms = params.authorFroms;
            return qb;
          }),
        getManyAndCount: jest.fn().mockImplementation(() => {
          const matched =
            froms || authorFroms
              ? rows.filter(
                  r => froms?.includes(r.from) || (r.author != null && (authorFroms?.includes(r.author) ?? false)),
                )
              : rows;
          return Promise.resolve([matched, matched.length]);
        }),
      };
      return qb;
    };

    it('returns the lid-authored message once the table maps the lid to that phone (the hit)', async () => {
      lidMappingStore.lidsForPhone.mockReturnValue(['111']); // table: lid 111 -> phone 628999
      const qb = makeFilteringQb();
      (repository.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      const { messages } = await service.getMessages('sess-1', { from: '628999' });

      expect(lidMappingStore.lidsForPhone).toHaveBeenCalledWith('628999');
      expect(messages.map(m => m.id).sort()).toEqual(['m-dm', 'm-lid']);
    });

    it('misses the lid-authored message when the table has no mapping (the prior silent miss)', async () => {
      lidMappingStore.lidsForPhone.mockReturnValue([]); // unresolved: no lid -> phone row yet
      const qb = makeFilteringQb();
      (repository.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      const { messages } = await service.getMessages('sess-1', { from: '628999' });

      expect(messages.map(m => m.id)).toEqual(['m-dm']); // only the @c.us DM matches
    });

    // `<n>@hosted` is the Meta-hosted dialect of the SAME phone account, which is why Baileys
    // rewrites it to `<n>@s.whatsapp.net` on every inbound message. Rows therefore land under the
    // plain dialect while a chat id we published may carry the hosted suffix, so a filter given the
    // hosted form has to expand to the phone dialects or it returns none of the person's history.
    it('expands a hosted id into the phone dialects, so it finds rows stored under @c.us', async () => {
      const qb = makeFilteringQb();
      (repository.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      const { messages } = await service.getMessages('sess-1', { from: '628999@hosted' });

      expect(messages.map(m => m.id)).toEqual(['m-dm']);
      expect(lidMappingStore.lidsForPhone).toHaveBeenCalledWith('628999');
      const calls = qb.andWhere.mock.calls as Array<[string, { froms?: string[] }?]>;
      const froms = calls.find(c => c[1]?.froms)?.[1]?.froms;
      expect(froms).toEqual(expect.arrayContaining(['628999@hosted', '628999@c.us', '628999@s.whatsapp.net']));
    });
  });

  // ── getMessages from-filter matches the group author ──────────────
  describe('getMessages from-filter matches the group author', () => {
    // Group rows: `from` holds the group JID; the real sender lives in `author`.
    const aliceGroupRow = { id: 'm-grp-alice', from: 'grp@g.us', author: '628999@c.us', chatId: 'grp@g.us' } as Message;
    const bobGroupRow = { id: 'm-grp-bob', from: 'grp@g.us', author: '628111@c.us', chatId: 'grp@g.us' } as Message;
    const aliceDmRow = { id: 'm-dm', from: '628999@c.us', chatId: '628999@c.us' } as Message;
    // A query-builder fake applying the chatId AND (from OR author) predicates like the real SQL.
    const makeAuthorQb = (rows: Message[]) => {
      let chatIds: string[] | null = null;
      let froms: string[] | null = null;
      let authorFroms: string[] | null = null;
      const qb = {
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        andWhere: jest
          .fn()
          .mockImplementation(
            (_clause: string, params?: { chatIds?: string[]; froms?: string[]; authorFroms?: string[] }) => {
              if (params?.chatIds) chatIds = params.chatIds;
              if (params?.froms) froms = params.froms;
              if (params?.authorFroms) authorFroms = params.authorFroms;
              return qb;
            },
          ),
        getManyAndCount: jest.fn().mockImplementation(() => {
          let matched = rows;
          if (chatIds) matched = matched.filter(r => chatIds!.includes(r.chatId));
          if (froms || authorFroms) {
            matched = matched.filter(
              r => froms?.includes(r.from) || (r.author != null && (authorFroms?.includes(r.author) ?? false)),
            );
          }
          return Promise.resolve([matched, matched.length]);
        }),
      };
      return qb;
    };

    it('returns group messages authored by the filtered phone (matched via author, not from)', async () => {
      lidMappingStore.lidsForPhone.mockReturnValue([]);
      const qb = makeAuthorQb([aliceGroupRow, bobGroupRow, aliceDmRow]);
      (repository.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      const { messages } = await service.getMessages('sess-1', { from: '628999' });

      // Alice's group row + her DM; Bob's group row (same `from` = group JID) stays out.
      expect(messages.map(m => m.id).sort()).toEqual(['m-dm', 'm-grp-alice']);
    });

    it('matches a group author stored as a lid once the table maps the lid to the phone', async () => {
      const lidAuthorRow = { id: 'm-grp-lid', from: 'grp@g.us', author: '111@lid', chatId: 'grp@g.us' } as Message;
      lidMappingStore.lidsForPhone.mockReturnValue(['111']); // table: lid 111 -> phone 628999
      const qb = makeAuthorQb([aliceGroupRow, bobGroupRow, aliceDmRow, lidAuthorRow]);
      (repository.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      const { messages } = await service.getMessages('sess-1', { from: '628999' });

      expect(messages.map(m => m.id).sort()).toEqual(['m-dm', 'm-grp-alice', 'm-grp-lid']);
    });

    it('still applies the chatId filter alongside the from/author match', async () => {
      lidMappingStore.lidsForPhone.mockReturnValue([]);
      const qb = makeAuthorQb([aliceGroupRow, bobGroupRow, aliceDmRow]);
      (repository.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      const { messages } = await service.getMessages('sess-1', { chatId: 'grp@g.us', from: '628999' });

      // Alice's DM is excluded by the chatId filter, Bob's row by the from/author filter.
      expect(messages.map(m => m.id)).toEqual(['m-grp-alice']);
    });
  });

  // ── candidate expansion is scoped by chat kind ────────────────────
  describe('getMessages candidate expansion is scoped by chat kind', () => {
    // Captures the candidate arrays the service binds, so the scoping is asserted directly.
    const makeCaptureQb = () => {
      const captured: { chatIds?: string[]; froms?: string[]; authorFroms?: string[] } = {};
      const qb = {
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        andWhere: jest
          .fn()
          .mockImplementation(
            (_clause: string, params?: { chatIds?: string[]; froms?: string[]; authorFroms?: string[] }) => {
              if (params?.chatIds) captured.chatIds = params.chatIds;
              if (params?.froms) captured.froms = params.froms;
              if (params?.authorFroms) captured.authorFroms = params.authorFroms;
              return qb;
            },
          ),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      };
      return { qb, captured };
    };

    it('does not expand a group chatId into the user dialects (fail-closed on the literal id)', async () => {
      const { qb, captured } = makeCaptureQb();
      (repository.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      await service.getMessages('sess-1', { chatId: '120363999@g.us' });

      // No `120363999@c.us`/`@s.whatsapp.net` and no lid-table probe with the group's digits.
      expect(captured.chatIds).toEqual(['120363999@g.us']);
      expect(lidMappingStore.lidsForPhone).not.toHaveBeenCalled();
      expect(lidMappingStore.getCached).not.toHaveBeenCalled();
    });

    it('does not expand a status broadcast or newsletter chatId', async () => {
      const { qb, captured } = makeCaptureQb();
      (repository.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      await service.getMessages('sess-1', { chatId: 'status@broadcast' });
      expect(captured.chatIds).toEqual(['status@broadcast']);

      await service.getMessages('sess-1', { chatId: '12345@newsletter' });
      expect(captured.chatIds).toEqual(['12345@newsletter']);

      expect(lidMappingStore.lidsForPhone).not.toHaveBeenCalled();
    });

    it('forward-resolves a @lid from-filter to its phone instead of minting <lid-digits>@c.us', async () => {
      lidMappingStore.getCached.mockReturnValue('628999'); // table: lid 111 -> phone 628999
      const { qb, captured } = makeCaptureQb();
      (repository.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      await service.getMessages('sess-1', { from: '111@lid' });

      expect(lidMappingStore.getCached).toHaveBeenCalledWith('111');
      expect(captured.froms).toEqual(['111@lid', '628999@c.us', '628999@s.whatsapp.net']);
      expect(captured.authorFroms).toEqual(captured.froms); // same candidates drive the author match
      expect(captured.froms).not.toContain('111@c.us'); // the lid's digits are not a phone
      expect(lidMappingStore.lidsForPhone).not.toHaveBeenCalled();
    });

    it('keeps an unresolved @lid filter to the literal id only', async () => {
      lidMappingStore.getCached.mockReturnValue(null); // known-unresolved
      const { qb, captured } = makeCaptureQb();
      (repository.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      await service.getMessages('sess-1', { from: '111@lid' });

      expect(captured.froms).toEqual(['111@lid']);
    });

    it('keeps the user-dialect expansion for a bare phone filter', async () => {
      lidMappingStore.lidsForPhone.mockReturnValue(['111']);
      const { qb, captured } = makeCaptureQb();
      (repository.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      await service.getMessages('sess-1', { from: '628999' });

      expect(captured.froms).toEqual(['628999', '628999@c.us', '628999@s.whatsapp.net', '111@lid']);
      expect(lidMappingStore.lidsForPhone).toHaveBeenCalledWith('628999');
    });
  });

  // ── getMessages chatId filter is dialect-agnostic ─────────────────
  describe('getMessages chatId filter matches across dialects', () => {
    // A message stored with the raw @s.whatsapp.net chatId (e.g. an outbound send addressed by a raw id).
    const stored = { id: 'm1', from: '628113@c.us', chatId: '6281316434311@s.whatsapp.net' } as Message;

    const makeChatQb = () => {
      let chatIds: string[] | null = null;
      const qb = {
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockImplementation((_clause: string, params?: { chatIds?: string[] }) => {
          if (params?.chatIds) chatIds = params.chatIds;
          return qb;
        }),
        getManyAndCount: jest.fn().mockImplementation(() => {
          const matched = chatIds && chatIds.includes(stored.chatId) ? [stored] : [];
          return Promise.resolve([matched, matched.length]);
        }),
      };
      return qb;
    };

    it('returns a @s.whatsapp.net-stored message when filtering by the neutral @c.us chat id', async () => {
      lidMappingStore.lidsForPhone.mockReturnValue([]);
      const qb = makeChatQb();
      (repository.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      const { messages } = await service.getMessages('sess-1', { chatId: '6281316434311@c.us' });

      expect(messages.map(m => m.id)).toEqual(['m1']);
    });
  });

  // ── saveIncomingMessage ───────────────────────────────────────────

  describe('saveIncomingMessage', () => {
    it('should save with INCOMING direction', async () => {
      await service.saveIncomingMessage('sess-1', {
        waMessageId: 'wa-in-1',
        chatId: 'sender@c.us',
        body: 'Hi there',
        type: 'text',
      });

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'sess-1',
          direction: MessageDirection.INCOMING,
        }),
      );
    });
  });

  // ── reactToMessage / deleteMessage ────────────────────────────────

  describe('reactToMessage', () => {
    it('should call engine.reactToMessage', async () => {
      await service.reactToMessage('sess-1', {
        chatId: 'test@c.us',
        messageId: 'wa-msg-1',
        emoji: '👍',
      });

      expect(mockEngine.reactToMessage).toHaveBeenCalledWith('test@c.us', 'wa-msg-1', '👍');
    });
  });

  describe('getChatHistory', () => {
    it('should call engine.getChatHistory with default limit and includeMedia=false', async () => {
      await service.getChatHistory('sess-1', 'test@c.us');
      expect(mockEngine.getChatHistory).toHaveBeenCalledWith('test@c.us', 50, false);
    });

    it('should pass through custom limit', async () => {
      await service.getChatHistory('sess-1', 'test@c.us', 10);
      expect(mockEngine.getChatHistory).toHaveBeenCalledWith('test@c.us', 10, false);
    });

    it('should pass through includeMedia flag', async () => {
      await service.getChatHistory('sess-1', 'test@c.us', 5, true);
      expect(mockEngine.getChatHistory).toHaveBeenCalledWith('test@c.us', 5, true);
    });

    it('should clamp the limit to [1, 100] and default non-finite values to 50', async () => {
      await service.getChatHistory('sess-1', 'test@c.us', 500);
      expect(mockEngine.getChatHistory).toHaveBeenLastCalledWith('test@c.us', 100, false);

      await service.getChatHistory('sess-1', 'test@c.us', 0);
      expect(mockEngine.getChatHistory).toHaveBeenLastCalledWith('test@c.us', 1, false);

      await service.getChatHistory('sess-1', 'test@c.us', Number.NaN);
      expect(mockEngine.getChatHistory).toHaveBeenLastCalledWith('test@c.us', 50, false);
    });

    it('should return engine result', async () => {
      const fake = [{ id: 'm1', body: 'hi', from: 'a', to: 'b', chatId: 'test@c.us' }];
      mockEngine.getChatHistory.mockResolvedValueOnce(fake);
      const result = await service.getChatHistory('sess-1', 'test@c.us');
      expect(result).toBe(fake);
    });

    it('threads an abort signal through to the engine when one is given', async () => {
      const { signal } = new AbortController();
      await service.getChatHistory('sess-1', 'test@c.us', 50, true, false, signal);
      expect(mockEngine.getChatHistory).toHaveBeenCalledWith('test@c.us', 50, true, undefined, signal);
    });

    describe('deep mode (#347)', () => {
      it('allows a limit above the standard 100 cap when deep=true', async () => {
        await service.getChatHistory('sess-1', 'test@c.us', 500, false, true);
        expect(mockEngine.getChatHistory).toHaveBeenLastCalledWith('test@c.us', 500, false);
      });

      it('clamps a deep limit to the 2000 ceiling', async () => {
        await service.getChatHistory('sess-1', 'test@c.us', 5000, false, true);
        expect(mockEngine.getChatHistory).toHaveBeenLastCalledWith('test@c.us', 2000, false);
      });

      it('forces includeMedia off in deep mode (metadata-only)', async () => {
        await service.getChatHistory('sess-1', 'test@c.us', 300, true, true);
        expect(mockEngine.getChatHistory).toHaveBeenLastCalledWith('test@c.us', 300, false);
      });

      it('still clamps to 100 when deep is not set (regression guard)', async () => {
        await service.getChatHistory('sess-1', 'test@c.us', 500, false, false);
        expect(mockEngine.getChatHistory).toHaveBeenLastCalledWith('test@c.us', 100, false);
      });
    });
  });

  describe('deleteMessage', () => {
    it('should call engine.deleteMessage with forEveryone default true', async () => {
      await service.deleteMessage('sess-1', {
        chatId: 'test@c.us',
        messageId: 'wa-msg-1',
      });

      expect(mockEngine.deleteMessage).toHaveBeenCalledWith('test@c.us', 'wa-msg-1', true);
    });

    it('should pass forEveryone=false when specified', async () => {
      await service.deleteMessage('sess-1', {
        chatId: 'test@c.us',
        messageId: 'wa-msg-1',
        forEveryone: false,
      });

      expect(mockEngine.deleteMessage).toHaveBeenCalledWith('test@c.us', 'wa-msg-1', false);
    });
  });

  describe('editMessage', () => {
    it('edits via the engine, delegates the stored-row update, and returns the engine result', async () => {
      const res = await service.editMessage('sess-1', { chatId: 'test@c.us', messageId: 'wa-msg-1', body: 'edited' });

      expect(mockEngine.editMessage).toHaveBeenCalledWith('test@c.us', 'wa-msg-1', 'edited');
      // Persistence is delegated to the session's per-message mutation queue (serialized with the
      // inbound edit path) — the service no longer writes the row directly.
      expect(messageProjector.recordOutboundMessageEdit).toHaveBeenCalledWith('sess-1', 'wa-msg-1', 'edited');
      expect(repository.update).not.toHaveBeenCalled();
      expect(res).toEqual({ messageId: 'wa-msg-1', timestamp: 1706868000 });
    });

    it('still succeeds when the delegated stored-row update is a no-op (the engine edit already happened)', async () => {
      // recordOutboundMessageEdit is best-effort by contract (never rejects); a missing row or a
      // failed write is logged inside the session service, not surfaced here.
      const res = await service.editMessage('sess-1', { chatId: 'test@c.us', messageId: 'wa-msg-1', body: 'edited' });

      expect(res).toEqual({ messageId: 'wa-msg-1', timestamp: 1706868000 });
    });

    it('propagates the engine not-found error as-is (MessageNotFoundError → 404)', async () => {
      mockEngine.editMessage.mockRejectedValueOnce(new NotFoundException('Message wa-msg-1 not found'));
      await expect(
        service.editMessage('sess-1', { chatId: 'test@c.us', messageId: 'wa-msg-1', body: 'edited' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(messageProjector.recordOutboundMessageEdit).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when the session is not started', async () => {
      engines.delete('sess-1');
      await expect(
        service.editMessage('sess-1', { chatId: 'test@c.us', messageId: 'wa-msg-1', body: 'edited' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockEngine.editMessage).not.toHaveBeenCalled();
    });

    // An edit replaces the text the recipient sees, so it belongs to the same moderation
    // chokepoint as every other sender rather than going out unseen by plugins.
    it('runs the message:sending gate tagged as an edit', async () => {
      await service.editMessage('sess-1', { chatId: 'test@c.us', messageId: 'wa-msg-1', body: 'edited' });

      expect(hookManager.execute).toHaveBeenCalledWith(
        'message:sending',
        expect.objectContaining({ type: 'edit' }),
        expect.any(Object),
      );
    });

    it('lets a plugin block an edit before the engine is called', async () => {
      (hookManager.execute as jest.Mock).mockResolvedValueOnce({ continue: false, data: {} });

      await expect(
        service.editMessage('sess-1', { chatId: 'test@c.us', messageId: 'wa-msg-1', body: 'edited' }),
      ).rejects.toThrow('Message sending blocked by plugin');

      expect(mockEngine.editMessage).not.toHaveBeenCalled();
      expect(messageProjector.recordOutboundMessageEdit).not.toHaveBeenCalled();
    });

    it('threads a plugin-rewritten edit body through to the engine and the stored row', async () => {
      (hookManager.execute as jest.Mock).mockResolvedValueOnce({
        continue: true,
        data: { input: { chatId: 'test@c.us', messageId: 'wa-msg-1', body: 'redacted' } },
      });

      await service.editMessage('sess-1', { chatId: 'test@c.us', messageId: 'wa-msg-1', body: 'secret' });

      expect(mockEngine.editMessage).toHaveBeenCalledWith('test@c.us', 'wa-msg-1', 'redacted');
      expect(messageProjector.recordOutboundMessageEdit).toHaveBeenCalledWith('sess-1', 'wa-msg-1', 'redacted');
    });

    it('honours a plugin that rewrites the tag list, not the list the caller sent', async () => {
      // message:sending is a moderation chokepoint, so a handler that drops a WID from the list must
      // win. Reading the caller's own dto here instead of the gated one would send the unredacted
      // tags while the hook reported success, and no other assertion in this file would notice.
      (hookManager.execute as jest.Mock).mockResolvedValueOnce({
        continue: true,
        data: { input: { chatId: 'g@g.us', messageId: 'wa-msg-1', body: 'hi @62811', mentions: ['62811@c.us'] } },
      });

      await service.editMessage('sess-1', {
        chatId: 'g@g.us',
        messageId: 'wa-msg-1',
        body: 'hi @62811 @62999',
        mentions: ['62811@c.us', '62999@c.us'],
      });

      expect(mockEngine.editMessage).toHaveBeenCalledWith('g@g.us', 'wa-msg-1', 'hi @62811', ['62811@c.us']);
    });
  });

  // ── pin / unpin ───────────────────────────────────────────────────

  describe('pinMessage / unpinMessage', () => {
    it('defaults the pin window to 24h when the caller does not choose one', async () => {
      await service.pinMessage('sess-1', { chatId: '621@c.us', messageId: 'M1' });
      expect(mockEngine.pinMessage).toHaveBeenCalledWith('621@c.us', 'M1', 86400);
    });

    it('passes an explicit window through untouched', async () => {
      await service.pinMessage('sess-1', { chatId: '621@c.us', messageId: 'M1', durationSeconds: 2592000 });
      expect(mockEngine.pinMessage).toHaveBeenCalledWith('621@c.us', 'M1', 2592000);
    });

    it('unpins without a duration', async () => {
      await service.unpinMessage('sess-1', { chatId: '621@c.us', messageId: 'M1' });
      expect(mockEngine.unpinMessage).toHaveBeenCalledWith('621@c.us', 'M1');
    });

    it('does not touch the stored message row — a pin is WhatsApp-owned chat state that expires', async () => {
      (repository.update as jest.Mock).mockClear();
      await service.pinMessage('sess-1', { chatId: '621@c.us', messageId: 'M1' });
      expect(repository.update).not.toHaveBeenCalled();
    });
  });

  describe('votePoll', () => {
    it('passes the option texts through unchanged', async () => {
      await service.votePoll('sess-1', { chatId: '621@c.us', pollMessageId: 'P1', options: ['A', 'B'] });
      expect(mockEngine.votePoll).toHaveBeenCalledWith('621@c.us', 'P1', ['A', 'B']);
    });

    it('forwards an empty selection, which clears the vote rather than being a no-op', async () => {
      await service.votePoll('sess-1', { chatId: '621@c.us', pollMessageId: 'P1', options: [] });
      expect(mockEngine.votePoll).toHaveBeenCalledWith('621@c.us', 'P1', []);
    });
  });

  describe('starMessage', () => {
    it.each([true, false])('passes star=%s straight through to the engine', async star => {
      await service.starMessage('sess-1', { chatId: '621@c.us', messageId: 'M1', star });
      expect(mockEngine.starMessage).toHaveBeenCalledWith('621@c.us', 'M1', star);
    });
  });

  // ── archived chat media (read path) ───────────────────────────────

  describe('getChatMedia', () => {
    const archived = (mimetype: string) => ({
      getMedia: jest.fn().mockResolvedValue({ path: 'chat-media/sess-1/abc.bin', mimetype }),
    });
    const storage = (buffer = Buffer.from('BYTES')) => ({ getFile: jest.fn().mockResolvedValue(buffer) });

    const build = (archive: unknown, store: unknown): MessageService =>
      new MessageService(
        repository as Repository<Message>,
        engines,
        messageProjector as unknown as MessageProjector,
        hookManager as HookManager,
        lidMappingStore as unknown as LidMappingStoreService,
        inertPacing(),
        {} as MessageSendService,
        archive as never,
        store as never,
      );

    it('serves an inert image type unchanged', async () => {
      const svc = build(archived('image/jpeg'), storage());
      await expect(svc.getChatMedia('sess-1', 'c@c.us', 'wa-1')).resolves.toEqual({
        buffer: Buffer.from('BYTES'),
        mimetype: 'image/jpeg',
      });
    });

    it.each([
      ['image/svg+xml', 'scriptable despite the image/ prefix'],
      ['text/html', 'a document a sender chose the type of'],
      ['application/pdf', 'renderable by the browser plugin'],
      ['application/javascript', 'outright active content'],
    ])('downgrades %s to octet-stream (%s)', async mimetype => {
      const svc = build(archived(mimetype), storage());
      const { mimetype: served } = await svc.getChatMedia('sess-1', 'c@c.us', 'wa-1');
      expect(served).toBe('application/octet-stream');
    });

    it('404s when nothing is archived for the message', async () => {
      const svc = build({ getMedia: jest.fn().mockResolvedValue(null) }, storage());
      await expect(svc.getChatMedia('sess-1', 'c@c.us', 'wa-1')).rejects.toThrow(NotFoundException);
    });

    it.each([
      ['local ENOENT', Object.assign(new Error('missing'), { code: 'ENOENT' })],
      // S3 reports a miss with a .name and NO .code — an ENOENT-only check turned this into a 500
      // on the one backend where retention/lifecycle rules make a missing object most likely.
      ['S3 NoSuchKey', Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' })],
      ['S3 NotFound', Object.assign(new Error('NotFound'), { name: 'NotFound' })],
      ['S3 404 metadata', Object.assign(new Error('gone'), { $metadata: { httpStatusCode: 404 } })],
    ])('404s when the row outlived its file (%s)', async (_label, err) => {
      const svc = build(archived('image/png'), { getFile: jest.fn().mockRejectedValue(err) });
      await expect(svc.getChatMedia('sess-1', 'c@c.us', 'wa-1')).rejects.toThrow(NotFoundException);
    });

    it('does not swallow a genuine storage fault as a 404', async () => {
      const svc = build(archived('image/png'), { getFile: jest.fn().mockRejectedValue(new Error('S3 500')) });
      await expect(svc.getChatMedia('sess-1', 'c@c.us', 'wa-1')).rejects.toThrow('S3 500');
    });

    // ── inline fallback (sent-message media, #1165) ──────────────────

    const inlineRow = (media: Record<string, unknown>) => ({ id: 'msg-uuid-1', metadata: { media } });
    const noArchive = () => ({ getMedia: jest.fn().mockResolvedValue(null) });

    it('serves the inline row copy when nothing is archived', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(
        inlineRow({ mimetype: 'image/jpeg', data: Buffer.from('INLINE').toString('base64') }),
      );
      const svc = build(noArchive(), storage());
      await expect(svc.getChatMedia('sess-1', 'c@c.us', 'wa-1')).resolves.toEqual({
        buffer: Buffer.from('INLINE'),
        mimetype: 'image/jpeg',
      });
      expect(repository.findOne).toHaveBeenCalledWith({
        where: { sessionId: 'sess-1', chatId: In(['c@c.us', 'c@s.whatsapp.net']), waMessageId: 'wa-1' },
      });
    });

    it('looks the row up across chatId dialects — outbound rows store the literal or the neutral form by race', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(
        inlineRow({ mimetype: 'image/jpeg', data: Buffer.from('SENT').toString('base64') }),
      );
      const svc = build(noArchive(), storage());
      await expect(svc.getChatMedia('sess-1', '628123456789@s.whatsapp.net', 'wa-1')).resolves.toEqual({
        buffer: Buffer.from('SENT'),
        mimetype: 'image/jpeg',
      });
      expect(repository.findOne).toHaveBeenCalledWith({
        where: {
          sessionId: 'sess-1',
          chatId: In(['628123456789@s.whatsapp.net', '628123456789@c.us']),
          waMessageId: 'wa-1',
        },
      });
    });

    it('prefers the archived file over the inline copy when both exist', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(
        inlineRow({ mimetype: 'image/png', data: Buffer.from('INLINE').toString('base64') }),
      );
      const svc = build(archived('image/png'), storage(Buffer.from('ARCHIVE-BYTES')));
      await expect(svc.getChatMedia('sess-1', 'c@c.us', 'wa-1')).resolves.toEqual({
        buffer: Buffer.from('ARCHIVE-BYTES'),
        mimetype: 'image/png',
      });
    });

    it('downgrades an active inline mimetype to octet-stream, matching the archive path', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(
        inlineRow({ mimetype: 'text/html', data: Buffer.from('<img>').toString('base64') }),
      );
      const svc = build(noArchive(), storage());
      const { mimetype: served } = await svc.getChatMedia('sess-1', 'c@c.us', 'wa-1');
      expect(served).toBe('application/octet-stream');
    });

    it.each([
      // A URL-based send persists the URL STRING in metadata.media.data (buildMediaInput:
      // `data: base64 || dto.url!`) — decoding it as base64 would serve garbage bytes.
      ['a URL string from a url-based send', { mimetype: 'image/png', data: 'https://example.com/cat.png' }],
      ['the omitted marker', { mimetype: 'image/png', omitted: true, sizeBytes: 99 }],
      ['a payload with no mimetype', { data: Buffer.from('X').toString('base64') }],
      ['a media object with no data', { mimetype: 'image/png' }],
    ])('404s when the inline copy is %s', async (_label, media) => {
      (repository.findOne as jest.Mock).mockResolvedValue(inlineRow(media));
      const svc = build(noArchive(), storage());
      await expect(svc.getChatMedia('sess-1', 'c@c.us', 'wa-1')).rejects.toThrow(NotFoundException);
    });

    it('falls back to the inline copy when the archived file was purged by retention', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(
        inlineRow({ mimetype: 'image/jpeg', data: Buffer.from('STILL-HERE').toString('base64') }),
      );
      const svc = build(archived('image/jpeg'), {
        getFile: jest.fn().mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' })),
      });
      await expect(svc.getChatMedia('sess-1', 'c@c.us', 'wa-1')).resolves.toEqual({
        buffer: Buffer.from('STILL-HERE'),
        mimetype: 'image/jpeg',
      });
    });

    it('serves the inline copy when no storage backend is configured', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(
        inlineRow({ mimetype: 'image/jpeg', data: Buffer.from('INLINE').toString('base64') }),
      );
      const svc = build(archived('image/jpeg'), undefined);
      await expect(svc.getChatMedia('sess-1', 'c@c.us', 'wa-1')).resolves.toEqual({
        buffer: Buffer.from('INLINE'),
        mimetype: 'image/jpeg',
      });
    });
  });

  // The budget is only worth anything if the read path actually applies it: the wiring is one line and
  // would vanish silently. This drives getMessages through a faked query builder and asserts the
  // response is bounded, not just that the helper exists.
  describe('MessageService.getMessages bounds its inline media', () => {
    it('applies the budget to the rows it returns', async () => {
      const prev = process.env.MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES;
      process.env.MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES = '25000';
      try {
        const rows = Array.from(
          { length: 100 },
          (_, i) =>
            ({
              id: `m${i}`,
              metadata: { media: { mimetype: 'image/jpeg', data: 'x'.repeat(10_000) } },
            }) as unknown as Message,
        );
        const builder = {
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          addOrderBy: jest.fn().mockReturnThis(),
          skip: jest.fn().mockReturnThis(),
          take: jest.fn().mockReturnThis(),
          getManyAndCount: jest.fn().mockResolvedValue([rows, 100]),
        };
        (repository.createQueryBuilder as unknown as jest.Mock).mockReturnValue(builder);

        const result = await service.getMessages('sess-1', { limit: 100 });

        const inlineBytes = result.messages
          .map(m => (m.metadata as { media?: { data?: unknown } }).media?.data)
          .filter((d): d is string => typeof d === 'string')
          .reduce((sum, d) => sum + d.length, 0);
        expect(result.messages).toHaveLength(100); // the page is intact
        expect(inlineBytes).toBeLessThanOrEqual(25_000); // its payload is not
      } finally {
        if (prev === undefined) delete process.env.MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES;
        else process.env.MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES = prev;
      }
    });
  });
});

describe('spendInlineMediaBudget', () => {
  const row = (id: string, base64Len: number, extra: Record<string, unknown> = {}): Message =>
    ({
      id,
      metadata: { media: { mimetype: 'image/jpeg', filename: 'a.jpg', data: 'x'.repeat(base64Len), ...extra } },
    }) as unknown as Message;

  const mediaOf = (m: Message): Record<string, unknown> => (m.metadata as { media: Record<string, unknown> }).media;

  it('keeps payloads while the budget lasts', () => {
    const rows = [row('a', 100), row('b', 100)];
    spendInlineMediaBudget(rows, 1000);
    expect(mediaOf(rows[0]).data).toHaveLength(100);
    expect(mediaOf(rows[1]).data).toHaveLength(100);
  });

  // The rows arrive newest-first, so the budget is spent on the most recent media and older rows
  // fall back to the marker the engine itself emits when inbound media is skipped.
  it('replaces the payload with the omitted marker once the budget is spent', () => {
    const rows = [row('newest', 600), row('older', 600)];
    spendInlineMediaBudget(rows, 1000);

    expect(mediaOf(rows[0]).data).toHaveLength(600);
    expect(mediaOf(rows[1]).data).toBeUndefined();
    expect(mediaOf(rows[1]).omitted).toBe(true);
    expect(mediaOf(rows[1]).mimetype).toBe('image/jpeg'); // the descriptive fields survive
    expect(typeof mediaOf(rows[1]).sizeBytes).toBe('number');
  });

  it('bounds the total inline bytes it lets through', () => {
    const rows = Array.from({ length: 100 }, (_, i) => row(`m${i}`, 10_000));
    spendInlineMediaBudget(rows, 25_000);

    const total = rows
      .map(m => mediaOf(m).data)
      .filter((d): d is string => typeof d === 'string')
      .reduce((sum, d) => sum + d.length, 0);
    expect(total).toBeLessThanOrEqual(25_000);
  });

  it('never touches a URL pointer, which is not a payload', () => {
    const rows = [row('pointer', 0, { data: 'https://cdn.example/a.jpg' })];
    spendInlineMediaBudget(rows, 0);
    expect(mediaOf(rows[0]).data).toBe('https://cdn.example/a.jpg');
    expect(mediaOf(rows[0]).omitted).toBeUndefined();
  });

  it('reports the decoded size the caller asked about, preferring a stored sizeBytes', () => {
    const rows = [row('a', 400, { sizeBytes: 4242 })];
    spendInlineMediaBudget(rows, 0);
    expect(mediaOf(rows[0]).sizeBytes).toBe(4242);
  });

  /**
   * A payload bigger than the whole budget was omitted even as the only media on the page, so a
   * single large photo or video — well inside the 50 MiB the gateway stores inline — could never be
   * read back through this route. The dashboard's thread has no other media source and fetches with
   * staleTime: Infinity, so the user saw a permanent 📎 placeholder for an image WhatsApp shows.
   *
   * The newest payload is therefore always let through when inlining is enabled at all. The budget
   * still bounds everything after it, and a budget of 0 still means "no inline media", so an
   * operator who switched inlining off does not get one payload back.
   */
  it('lets the newest payload through even when it alone exceeds the budget', () => {
    const rows = [row('huge', 5000)];
    spendInlineMediaBudget(rows, 1000);

    expect(mediaOf(rows[0]).data).toHaveLength(5000);
    expect(mediaOf(rows[0]).omitted).toBeUndefined();
  });

  // Negative twin: the allowance is for the FIRST payload only — it must not become a blanket pass.
  it('still omits the rows after an oversized newest payload', () => {
    const rows = [row('huge', 5000), row('next', 10), row('later', 10)];
    spendInlineMediaBudget(rows, 1000);

    expect(mediaOf(rows[0]).data).toHaveLength(5000);
    expect(mediaOf(rows[1]).data).toBeUndefined();
    expect(mediaOf(rows[1]).omitted).toBe(true);
    expect(mediaOf(rows[2]).omitted).toBe(true);
  });

  // A budget of 0 is an explicit "do not inline", not a small budget — no allowance applies.
  it('grants no allowance when inlining is switched off entirely', () => {
    const rows = [row('huge', 5000)];
    spendInlineMediaBudget(rows, 0);

    expect(mediaOf(rows[0]).data).toBeUndefined();
    expect(mediaOf(rows[0]).omitted).toBe(true);
  });
});
