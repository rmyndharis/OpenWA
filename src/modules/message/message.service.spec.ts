import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BadRequestException, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { MessageService } from './message.service';
import { Message, MessageDirection, MessageStatus } from './entities/message.entity';
import { SessionService } from '../session/session.service';
import { HookManager } from '../../core/hooks';
import { TemplateService } from '../template/template.service';
import { Template } from '../template/entities/template.entity';
import { SsrfBlockedError } from '../../common/security/ssrf-guard';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';

const mockEngineResult = { id: 'wa-msg-1', timestamp: 1706868000 };

function createMockEngine() {
  return {
    sendTextMessage: jest.fn().mockResolvedValue(mockEngineResult),
    sendImageMessage: jest.fn().mockResolvedValue(mockEngineResult),
    sendVideoMessage: jest.fn().mockResolvedValue(mockEngineResult),
    sendAudioMessage: jest.fn().mockResolvedValue(mockEngineResult),
    sendDocumentMessage: jest.fn().mockResolvedValue(mockEngineResult),
    sendStickerMessage: jest.fn().mockResolvedValue(mockEngineResult),
    sendLocationMessage: jest.fn().mockResolvedValue(mockEngineResult),
    sendContactMessage: jest.fn().mockResolvedValue(mockEngineResult),
    replyToMessage: jest.fn().mockResolvedValue(mockEngineResult),
    forwardMessage: jest.fn().mockResolvedValue(mockEngineResult),
    reactToMessage: jest.fn().mockResolvedValue(undefined),
    getMessageReactions: jest.fn().mockResolvedValue([]),
    deleteMessage: jest.fn().mockResolvedValue(undefined),
    getChatHistory: jest.fn().mockResolvedValue([]),
    sendChatState: jest.fn().mockResolvedValue(undefined),
  };
}

describe('MessageService', () => {
  let service: MessageService;
  let repository: jest.Mocked<Partial<Repository<Message>>>;
  let sessionService: jest.Mocked<Partial<SessionService>>;
  let hookManager: jest.Mocked<Partial<HookManager>>;
  let templateService: jest.Mocked<Partial<TemplateService>>;
  let lidMappingStore: { lidsForPhone: jest.Mock };
  let mockEngine: ReturnType<typeof createMockEngine>;

  // Auto-typing is on by default; disable it for the unrelated send tests so they don't incur the
  // real setTimeout delay and don't add an extra sendChatState call. The auto-typing suite opts in.
  beforeEach(() => {
    process.env.SIMULATE_TYPING = 'false';
  });
  afterEach(() => {
    delete process.env.SIMULATE_TYPING;
    delete process.env.SIMULATE_TYPING_MAX_MS;
  });

  beforeEach(async () => {
    repository = {
      create: jest.fn().mockImplementation((data: Partial<Message>) => ({ id: 'msg-uuid-1', ...data }) as Message),
      save: jest.fn().mockImplementation(msg => Promise.resolve(msg)),
      findOne: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(),
    };

    mockEngine = createMockEngine();

    sessionService = {
      getEngine: jest.fn().mockReturnValue(mockEngine),
      findOne: jest.fn().mockResolvedValue({ id: 'sess-1', phone: '628123456789' }),
    };

    hookManager = {
      execute: jest.fn().mockResolvedValue({
        continue: true,
        data: { sessionId: 'sess-1', input: { chatId: '628123456789@c.us', text: 'Hello' }, type: 'text' },
      }),
    };

    templateService = {
      resolve: jest.fn(),
    };

    lidMappingStore = { lidsForPhone: jest.fn().mockReturnValue([]) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessageService,
        { provide: getRepositoryToken(Message, 'data'), useValue: repository },
        { provide: SessionService, useValue: sessionService },
        { provide: HookManager, useValue: hookManager },
        { provide: TemplateService, useValue: templateService },
        { provide: LidMappingStoreService, useValue: lidMappingStore },
      ],
    }).compile();

    service = module.get<MessageService>(MessageService);
  });

  // ── sendText ──────────────────────────────────────────────────────

  describe('auto-typing before send (SIMULATE_TYPING, on by default)', () => {
    it('sends a typing presence before the message by default', async () => {
      delete process.env.SIMULATE_TYPING; // default = on
      process.env.SIMULATE_TYPING_MAX_MS = '1'; // keep the humanising delay ~instant in tests

      await service.sendText('sess-1', { chatId: '628123456789@c.us', text: 'Hello' });

      expect(mockEngine.sendChatState).toHaveBeenCalledWith('628123456789@c.us', 'typing');
      expect(mockEngine.sendTextMessage).toHaveBeenCalledWith('628123456789@c.us', 'Hello');
    });

    it('does not send typing presence when SIMULATE_TYPING=false', async () => {
      process.env.SIMULATE_TYPING = 'false';
      await service.sendText('sess-1', { chatId: '628123456789@c.us', text: 'Hello' });
      expect(mockEngine.sendChatState).not.toHaveBeenCalled();
    });
  });

  describe('sendText', () => {
    it('should send text message and return messageId + timestamp', async () => {
      const result = await service.sendText('sess-1', {
        chatId: '628123456789@c.us',
        text: 'Hello',
      });

      expect(result.messageId).toBe('wa-msg-1');
      expect(result.timestamp).toBe(1706868000);
      expect(mockEngine.sendTextMessage).toHaveBeenCalledWith('628123456789@c.us', 'Hello');
    });

    it('threads mentions through to the engine (#530)', async () => {
      const input = { chatId: '120@g.us', text: 'hi @62811', mentions: ['62811@c.us'] };
      (hookManager.execute as jest.Mock).mockResolvedValueOnce({
        continue: true,
        data: { sessionId: 'sess-1', input, type: 'text' },
      });
      await service.sendText('sess-1', input);
      expect(mockEngine.sendTextMessage).toHaveBeenCalledWith('120@g.us', 'hi @62811', ['62811@c.us']);
    });

    it('should save outgoing message as pending before sending, then update to sent', async () => {
      await service.sendText('sess-1', {
        chatId: '628123456789@c.us',
        text: 'Hello',
      });

      // First save: pending message before engine send
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'sess-1',
          direction: MessageDirection.OUTGOING,
          type: 'text',
          body: 'Hello',
          status: MessageStatus.PENDING,
        }),
      );
      // save called twice: once for initial pending, once for status update to sent
      expect(repository.save).toHaveBeenCalledTimes(2);
    });

    it('returns success (not FAILED) when persisting the SENT state fails after a successful send', async () => {
      // 1st save (PENDING) ok; 2nd save (SENT-state, after WhatsApp already accepted the message) throws.
      (repository.save as jest.Mock)
        .mockImplementationOnce((msg: unknown) => Promise.resolve(msg))
        .mockRejectedValueOnce(new Error('transient db fault'));

      const result = await service.sendText('sess-1', { chatId: '628123456789@c.us', text: 'Hello' });

      // The send succeeded, so it is reported as success — not rethrown, not marked FAILED.
      expect(result.messageId).toBe('wa-msg-1');
      expect(result.timestamp).toBe(1706868000);
      expect(hookManager.execute).not.toHaveBeenCalledWith('message:failed', expect.anything(), expect.anything());
    });

    it('executes the message:sending hook (message:sent now fires once from the engine message_create path)', async () => {
      await service.sendText('sess-1', {
        chatId: '628123456789@c.us',
        text: 'Hello',
      });

      expect(hookManager.execute).toHaveBeenCalledWith(
        'message:sending',
        expect.objectContaining({ type: 'text' }),
        expect.any(Object),
      );
      // message:sent is no longer fired here — it is emitted solely by SessionService.onMessageCreate
      // with a consistent IncomingMessage payload for ALL sends (avoids the prior double dispatch).
      expect(hookManager.execute).not.toHaveBeenCalledWith('message:sent', expect.anything(), expect.anything());
    });

    it('should throw BadRequestException when plugin blocks sending', async () => {
      (hookManager.execute as jest.Mock).mockResolvedValueOnce({ continue: false, data: {} });

      await expect(service.sendText('sess-1', { chatId: 'test@c.us', text: 'blocked' })).rejects.toThrow(
        'Message sending blocked by plugin',
      );
    });

    it('should throw BadRequestException if session is not active', async () => {
      (sessionService.getEngine as jest.Mock).mockReturnValue(undefined);

      await expect(service.sendText('inactive', { chatId: 'test@c.us', text: 'hello' })).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ── sendTemplate ──────────────────────────────────────────────────

  describe('sendTemplate', () => {
    function mockTemplate(overrides: Partial<Template> = {}): Template {
      return {
        id: 'tpl-1',
        sessionId: 'sess-1',
        name: 'order-confirmation',
        body: 'Hi {{customer}}, your order {{orderId}} shipped.',
        header: null,
        footer: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        session: undefined as unknown as Template['session'],
        ...overrides,
      };
    }

    beforeEach(() => {
      // Echo the supplied input back through the hook so the rendered text
      // reaches the engine via the delegated sendText path.
      (hookManager.execute as jest.Mock).mockImplementation((event: string, data: unknown) =>
        Promise.resolve({ continue: true, data }),
      );
    });

    it('should resolve the template, render variables, and delegate to sendText', async () => {
      (templateService.resolve as jest.Mock).mockResolvedValue(mockTemplate());

      const result = await service.sendTemplate('sess-1', {
        chatId: '628123456789@c.us',
        templateName: 'order-confirmation',
        vars: { customer: 'Alice', orderId: '1234' },
      });

      expect(templateService.resolve).toHaveBeenCalledWith('sess-1', {
        templateId: undefined,
        templateName: 'order-confirmation',
      });
      expect(mockEngine.sendTextMessage).toHaveBeenCalledWith(
        '628123456789@c.us',
        'Hi Alice, your order 1234 shipped.',
      );
      expect(result.messageId).toBe('wa-msg-1');
    });

    it('should flatten header and footer around the body with blank lines', async () => {
      (templateService.resolve as jest.Mock).mockResolvedValue(
        mockTemplate({ header: 'OpenWA Store', body: 'Hello {{customer}}', footer: 'Reply STOP to opt out' }),
      );

      await service.sendTemplate('sess-1', {
        chatId: 'test@c.us',
        templateId: 'tpl-1',
        vars: { customer: 'Bob' },
      });

      expect(mockEngine.sendTextMessage).toHaveBeenCalledWith(
        'test@c.us',
        'OpenWA Store\n\nHello Bob\n\nReply STOP to opt out',
      );
    });

    it('should leave unmatched placeholders literal', async () => {
      (templateService.resolve as jest.Mock).mockResolvedValue(mockTemplate({ body: 'Hi {{customer}} {{unknown}}' }));

      await service.sendTemplate('sess-1', {
        chatId: 'test@c.us',
        templateId: 'tpl-1',
        vars: { customer: 'Alice' },
      });

      expect(mockEngine.sendTextMessage).toHaveBeenCalledWith('test@c.us', 'Hi Alice {{unknown}}');
    });

    it('should propagate NotFoundException when the template cannot be resolved', async () => {
      (templateService.resolve as jest.Mock).mockRejectedValue(new NotFoundException('Template not found'));

      await expect(service.sendTemplate('sess-1', { chatId: 'test@c.us', templateName: 'missing' })).rejects.toThrow(
        NotFoundException,
      );
      expect(mockEngine.sendTextMessage).not.toHaveBeenCalled();
    });
  });

  // ── sendImage ─────────────────────────────────────────────────────

  describe('sendImage', () => {
    it('should send image via URL', async () => {
      const result = await service.sendImage('sess-1', {
        chatId: '628123456789@c.us',
        url: 'https://example.com/img.jpg',
        caption: 'My image',
      });

      expect(result.messageId).toBe('wa-msg-1');
      expect(mockEngine.sendImageMessage).toHaveBeenCalledWith(
        '628123456789@c.us',
        expect.objectContaining({ data: 'https://example.com/img.jpg', caption: 'My image' }),
      );
    });

    it('should send image via base64 with mimetype', async () => {
      await service.sendImage('sess-1', {
        chatId: '628123456789@c.us',
        base64: 'iVBORw0KGgoAAAAN...',
        mimetype: 'image/png',
      });

      expect(mockEngine.sendImageMessage).toHaveBeenCalledWith(
        '628123456789@c.us',
        expect.objectContaining({ data: 'iVBORw0KGgoAAAAN...', mimetype: 'image/png' }),
      );
    });

    it('threads media mentions into the MediaInput (#530)', async () => {
      await service.sendImage('sess-1', {
        chatId: '120@g.us',
        base64: 'AAAA',
        mimetype: 'image/png',
        caption: 'look @62811',
        mentions: ['62811@c.us'],
      });
      expect(mockEngine.sendImageMessage).toHaveBeenCalledWith(
        '120@g.us',
        expect.objectContaining({ mentions: ['62811@c.us'] }),
      );
    });

    it('maps a blocked-media-URL SSRF error to HTTP 400', async () => {
      mockEngine.sendImageMessage.mockRejectedValueOnce(new SsrfBlockedError('Blocked internal address: 127.0.0.1'));

      await expect(
        service.sendImage('sess-1', { chatId: '628123456789@c.us', url: 'http://127.0.0.1/x.png' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a base64 image over the media cap before sending or persisting', async () => {
      process.env.MEDIA_DOWNLOAD_MAX_BYTES = '1024';
      try {
        await expect(
          service.sendImage('sess-1', {
            chatId: '628123456789@c.us',
            base64: Buffer.alloc(1025).toString('base64'),
            mimetype: 'image/png',
          }),
        ).rejects.toBeInstanceOf(PayloadTooLargeException);
        expect(mockEngine.sendImageMessage).not.toHaveBeenCalled();
      } finally {
        delete process.env.MEDIA_DOWNLOAD_MAX_BYTES;
      }
    });

    it('strips the base64 payload from a FAILED media row but keeps mimetype/filename', async () => {
      mockEngine.sendImageMessage.mockRejectedValueOnce(new Error('engine down'));

      await expect(
        service.sendImage('sess-1', {
          chatId: '628123456789@c.us',
          base64: 'QUJDREVGISBhIGJpZyBwYXlsb2Fk',
          mimetype: 'image/png',
          filename: 'pic.png',
        }),
      ).rejects.toThrow();

      // The persisted FAILED row must not retain the (often multi-MB) base64 — it's never displayed
      // or retried — but should keep the descriptive mimetype/filename.
      const calls = (repository.save as jest.Mock).mock.calls as [Message][];
      const saved = calls.at(-1)![0];
      expect(saved.status).toBe(MessageStatus.FAILED);
      const media = (saved.metadata as { media?: { data?: unknown; mimetype?: string; filename?: string } }).media;
      expect(media?.data).toBeUndefined();
      expect(media?.mimetype).toBe('image/png');
      expect(media?.filename).toBe('pic.png');
    });
  });

  // ── getMessages pagination guard ──────────────────────────────────

  describe('getMessages pagination guard', () => {
    interface QbMock {
      where: jest.Mock;
      orderBy: jest.Mock;
      skip: jest.Mock;
      take: jest.Mock;
      andWhere: jest.Mock;
      getManyAndCount: jest.Mock;
    }
    const makeQb = (): QbMock => {
      const qb: QbMock = {
        where: jest.fn(),
        orderBy: jest.fn(),
        skip: jest.fn(),
        take: jest.fn(),
        andWhere: jest.fn(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      };
      qb.where.mockReturnValue(qb);
      qb.orderBy.mockReturnValue(qb);
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

  // ── getMessages from-filter (lid resolution becomes a hit) ─────────
  describe('getMessages from-filter resolves a lid to a phone', () => {
    // A group message whose stored author is an unresolved lid, plus a plain DM from the same person.
    const lidRow = { id: 'm-lid', from: '111@lid', chatId: 'grp@g.us' } as Message;
    const dmRow = { id: 'm-dm', from: '628999@c.us', chatId: '628999@c.us' } as Message;
    const rows = [lidRow, dmRow];

    // A query-builder fake that actually filters by the `from IN (:...froms)` clause it receives, so the
    // test exercises the resolution-driven expansion end to end (filter -> rows returned).
    const makeFilteringQb = () => {
      let froms: string[] | null = null;
      const qb = {
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockImplementation((_clause: string, params?: { froms?: string[] }) => {
          if (params?.froms) froms = params.froms;
          return qb;
        }),
        getManyAndCount: jest.fn().mockImplementation(() => {
          const matched = froms ? rows.filter(r => froms!.includes(r.from)) : rows;
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

  // ── sendVideo / sendAudio / sendDocument / sendSticker ────────────

  describe('sendVideo', () => {
    it('should call engine.sendVideoMessage', async () => {
      await service.sendVideo('sess-1', {
        chatId: 'test@c.us',
        url: 'https://example.com/video.mp4',
      });
      expect(mockEngine.sendVideoMessage).toHaveBeenCalled();
    });
  });

  describe('sendAudio', () => {
    it('should call engine.sendAudioMessage', async () => {
      await service.sendAudio('sess-1', {
        chatId: 'test@c.us',
        url: 'https://example.com/audio.ogg',
      });
      expect(mockEngine.sendAudioMessage).toHaveBeenCalled();
    });

    it('sends a voice note (ptt) and defaults the mimetype to ogg/opus when omitted', async () => {
      await service.sendAudio('sess-1', {
        chatId: 'test@c.us',
        url: 'https://example.com/voice',
        ptt: true,
      });
      expect(mockEngine.sendAudioMessage).toHaveBeenCalledWith(
        'test@c.us',
        expect.objectContaining({ ptt: true, mimetype: 'audio/ogg; codecs=opus' }),
      );
    });

    it('respects a caller-supplied mimetype for a voice note', async () => {
      await service.sendAudio('sess-1', {
        chatId: 'test@c.us',
        url: 'https://example.com/voice.ogg',
        mimetype: 'audio/ogg',
        ptt: true,
      });
      expect(mockEngine.sendAudioMessage).toHaveBeenCalledWith(
        'test@c.us',
        expect.objectContaining({ ptt: true, mimetype: 'audio/ogg' }),
      );
    });

    it('persists a voice note as type "voice"', async () => {
      await service.sendAudio('sess-1', { chatId: 'test@c.us', url: 'https://example.com/voice', ptt: true });
      expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'voice' }));
    });

    it('persists a plain audio send (no ptt) as type "audio"', async () => {
      await service.sendAudio('sess-1', { chatId: 'test@c.us', url: 'https://example.com/audio.ogg' });
      expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'audio' }));
    });
  });

  describe('sendDocument', () => {
    it('should call engine.sendDocumentMessage with filename', async () => {
      await service.sendDocument('sess-1', {
        chatId: 'test@c.us',
        url: 'https://example.com/doc.pdf',
        filename: 'report.pdf',
      });
      expect(mockEngine.sendDocumentMessage).toHaveBeenCalledWith(
        'test@c.us',
        expect.objectContaining({ filename: 'report.pdf' }),
      );
    });
  });

  describe('sendSticker', () => {
    it('should call engine.sendStickerMessage', async () => {
      await service.sendSticker('sess-1', {
        chatId: 'test@c.us',
        url: 'https://example.com/sticker.webp',
      });
      expect(mockEngine.sendStickerMessage).toHaveBeenCalled();
    });
  });

  // ── sendLocation ──────────────────────────────────────────────────

  describe('sendLocation', () => {
    it('should send location with lat/lng', async () => {
      const result = await service.sendLocation('sess-1', {
        chatId: 'test@c.us',
        latitude: -6.2088,
        longitude: 106.8456,
        description: 'Jakarta',
      });

      expect(result.messageId).toBe('wa-msg-1');
      expect(mockEngine.sendLocationMessage).toHaveBeenCalledWith(
        'test@c.us',
        expect.objectContaining({ latitude: -6.2088, longitude: 106.8456 }),
      );
    });
  });

  // ── sendContact ───────────────────────────────────────────────────

  describe('sendContact', () => {
    it('should send contact with name and number', async () => {
      const result = await service.sendContact('sess-1', {
        chatId: 'test@c.us',
        contactName: 'John Doe',
        contactNumber: '+628123456789',
      });

      expect(result.messageId).toBe('wa-msg-1');
      expect(mockEngine.sendContactMessage).toHaveBeenCalledWith(
        'test@c.us',
        expect.objectContaining({ name: 'John Doe', number: '+628123456789' }),
      );
    });
  });

  // ── reply / forward ───────────────────────────────────────────────

  describe('reply', () => {
    it('should call engine.replyToMessage with quotedMessageId', async () => {
      await service.reply('sess-1', {
        chatId: 'test@c.us',
        quotedMessageId: 'wa-quoted-1',
        text: 'This is a reply',
      });

      expect(mockEngine.replyToMessage).toHaveBeenCalledWith('test@c.us', 'wa-quoted-1', 'This is a reply');
    });
  });

  describe('forward', () => {
    it('should call engine.forwardMessage with from/to chats', async () => {
      await service.forward('sess-1', {
        fromChatId: 'from@c.us',
        toChatId: 'to@c.us',
        messageId: 'wa-msg-to-fwd',
      });

      expect(mockEngine.forwardMessage).toHaveBeenCalledWith('from@c.us', 'to@c.us', 'wa-msg-to-fwd');
    });

    it('should save forwarded message with toChatId', async () => {
      await service.forward('sess-1', {
        fromChatId: 'from@c.us',
        toChatId: 'to@c.us',
        messageId: 'wa-msg-to-fwd',
      });

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 'to@c.us',
          body: '[Forwarded]',
          type: 'forward',
        }),
      );
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

  // ── buildMediaInput (via sendImage) ───────────────────────────────

  describe('buildMediaInput validation', () => {
    it('should throw when neither url nor base64 is provided', async () => {
      await expect(service.sendImage('sess-1', { chatId: 'test@c.us' })).rejects.toThrow(
        'Either url or base64 must be provided',
      );
    });

    it('should throw when base64 is provided without mimetype', async () => {
      await expect(
        service.sendImage('sess-1', {
          chatId: 'test@c.us',
          base64: 'data...',
        }),
      ).rejects.toThrow('mimetype is required when using base64 data');
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
});
