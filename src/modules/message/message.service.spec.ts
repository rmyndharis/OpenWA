import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BadRequestException, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { MessageService } from './message.service';
import { Message, MessageDirection, MessageStatus } from './entities/message.entity';
import { SessionService } from '../session/session.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { MessageProjector } from '../session/message-projector.service';
import type { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { HookManager } from '../../core/hooks';
import { TemplateService } from '../template/template.service';
import { Template } from '../template/entities/template.entity';
import { SsrfBlockedError } from '../../common/security/ssrf-guard';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { SendPacingService } from './send-pacing.service';

/** Pacing is off by default in these tests; the governor's own spec covers its behaviour. */
const inertPacing = (): SendPacingService =>
  ({
    assertSendAllowed: jest.fn().mockResolvedValue(undefined),
    recordSendFailure: jest.fn(),
    recordSendSuccess: jest.fn(),
  }) as unknown as SendPacingService;

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
    sendPollMessage: jest.fn().mockResolvedValue(mockEngineResult),
    replyToMessage: jest.fn().mockResolvedValue(mockEngineResult),
    forwardMessage: jest.fn().mockResolvedValue(mockEngineResult),
    reactToMessage: jest.fn().mockResolvedValue(undefined),
    getMessageReactions: jest.fn().mockResolvedValue([]),
    deleteMessage: jest.fn().mockResolvedValue(undefined),
    pinMessage: jest.fn().mockResolvedValue(undefined),
    starMessage: jest.fn().mockResolvedValue(undefined),
    votePoll: jest.fn().mockResolvedValue(undefined),
    unpinMessage: jest.fn().mockResolvedValue(undefined),
    editMessage: jest.fn().mockResolvedValue(mockEngineResult),
    getChatHistory: jest.fn().mockResolvedValue([]),
    sendChatState: jest.fn().mockResolvedValue(undefined),
  };
}

describe('MessageService', () => {
  let service: MessageService;
  let repository: jest.Mocked<Partial<Repository<Message>>>;
  let sessionService: jest.Mocked<Partial<SessionService>>;
  let engines: EngineRegistry;
  let messageProjector: { recordOutboundMessageEdit: jest.Mock };
  let hookManager: jest.Mocked<Partial<HookManager>>;
  let templateService: jest.Mocked<Partial<TemplateService>>;
  let lidMappingStore: { lidsForPhone: jest.Mock; getCached: jest.Mock };
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
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(),
    };

    mockEngine = createMockEngine();

    sessionService = {
      findOne: jest.fn().mockResolvedValue({ id: 'sess-1', phone: '628123456789' }),
    };

    messageProjector = { recordOutboundMessageEdit: jest.fn().mockResolvedValue(undefined) };

    engines = new EngineRegistry();
    engines.set('sess-1', mockEngine as unknown as IWhatsAppEngine);

    hookManager = {
      // Echo the input straight back so the message:sending gate is a pass-through by default; specific
      // tests override with continue:false (block) or a modified input.
      execute: jest
        .fn()
        .mockImplementation((_event: string, data: unknown) => Promise.resolve({ continue: true, data })),
    };

    templateService = {
      resolve: jest.fn(),
    };

    lidMappingStore = { lidsForPhone: jest.fn().mockReturnValue([]), getCached: jest.fn().mockReturnValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessageService,
        {
          provide: SendPacingService,
          useValue: {
            assertSendAllowed: jest.fn().mockResolvedValue(undefined),
            recordSendFailure: jest.fn(),
            recordSendSuccess: jest.fn(),
          },
        },
        { provide: getRepositoryToken(Message, 'data'), useValue: repository },
        { provide: SessionService, useValue: sessionService },
        { provide: EngineRegistry, useValue: engines },
        { provide: MessageProjector, useValue: messageProjector },
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

    // The parameter is only guaranteed in its suppressing direction, so what matters is that `false`
    // reaches the engine and that everything else leaves the existing call shape alone.
    it('threads a link-preview suppression through to the engine', async () => {
      const input = { chatId: '628123456789@c.us', text: 'see https://example.com', linkPreview: false };
      (hookManager.execute as jest.Mock).mockResolvedValueOnce({
        continue: true,
        data: { sessionId: 'sess-1', input, type: 'text' },
      });

      await service.sendText('sess-1', input);

      expect(mockEngine.sendTextMessage).toHaveBeenCalledWith(
        '628123456789@c.us',
        'see https://example.com',
        undefined,
        { linkPreview: false },
      );
    });

    // A send that asks for nothing must keep the exact call it made before this option existed —
    // a trailing undefined would be harmless to the engines but would rewrite every existing send.
    it('leaves the plain send shape untouched when no preview choice is made', async () => {
      await service.sendText('sess-1', { chatId: '628123456789@c.us', text: 'hi' });

      expect(mockEngine.sendTextMessage).toHaveBeenCalledWith('628123456789@c.us', 'hi');
    });

    it('threads a caller-supplied preview through to the engine', async () => {
      const input = {
        chatId: '628123456789@c.us',
        text: 'see https://example.com',
        customLinkPreview: { url: 'https://example.com', title: 'Example', description: 'A site' },
      };
      (hookManager.execute as jest.Mock).mockResolvedValueOnce({
        continue: true,
        data: { sessionId: 'sess-1', input, type: 'text' },
      });

      await service.sendText('sess-1', input);

      expect(mockEngine.sendTextMessage).toHaveBeenCalledWith(
        '628123456789@c.us',
        'see https://example.com',
        undefined,
        { customPreview: { url: 'https://example.com', title: 'Example', description: 'A site' } },
      );
    });

    // Suppressing the preview and supplying one are opposite requests; guessing which was meant
    // would send a message the caller did not ask for either way.
    it('refuses a suppression combined with a supplied preview, before reaching the engine', async () => {
      await expect(
        service.sendText('sess-1', {
          chatId: '628123456789@c.us',
          text: 'hi',
          linkPreview: false,
          customLinkPreview: { url: 'https://example.com', title: 'Example' },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mockEngine.sendTextMessage).not.toHaveBeenCalled();
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
      // message:sent is no longer fired here — it is emitted solely by the onMessageCreate wiring in
      // SessionEngineLifecycle (via MessageProjector)
      // with a consistent IncomingMessage payload for ALL sends (avoids the prior double dispatch).
      expect(hookManager.execute).not.toHaveBeenCalledWith('message:sent', expect.anything(), expect.anything());
    });

    it('emits message:persisted on BOTH the pending save and the finalized sent save (#906)', async () => {
      await service.sendText('sess-1', { chatId: '628123456789@c.us', text: 'hello' });

      const calls = (hookManager.execute as jest.Mock).mock.calls.filter(
        ([ev]: unknown[]) => ev === 'message:persisted',
      ) as unknown[][];
      expect(calls).toHaveLength(2);
      expect(calls[0][1]).toMatchObject({
        sessionId: 'sess-1',
        message: { chatId: '628123456789@c.us', status: MessageStatus.PENDING },
      });
      expect(calls[1][1]).toMatchObject({
        sessionId: 'sess-1',
        message: { status: MessageStatus.SENT, waMessageId: 'wa-msg-1' },
      });
      expect(calls[0][2]).toMatchObject({ sessionId: 'sess-1', source: 'MessageService' });
    });

    it('re-emits message:persisted with FAILED when the send itself fails (#906)', async () => {
      mockEngine.sendTextMessage.mockRejectedValueOnce(new Error('engine down'));

      await expect(service.sendText('sess-1', { chatId: '628123456789@c.us', text: 'hi' })).rejects.toThrow();

      const calls = (hookManager.execute as jest.Mock).mock.calls.filter(
        ([ev]: unknown[]) => ev === 'message:persisted',
      ) as unknown[][];
      expect(calls).toHaveLength(2);
      expect(calls[0][1]).toMatchObject({ message: { status: MessageStatus.PENDING } });
      expect(calls[1][1]).toMatchObject({ message: { status: MessageStatus.FAILED } });
    });

    it('reconciles provider indexes when the send echo won the race: upsert the surviving row + drop the ghost (#906)', async () => {
      const echoRow = {
        id: 'echo-uuid-9',
        sessionId: 'sess-1',
        waMessageId: 'wa-msg-1',
        status: MessageStatus.SENT,
      } as Message;
      (repository.save as jest.Mock)
        .mockImplementationOnce((msg: unknown) => Promise.resolve(msg)) // PENDING save
        .mockRejectedValueOnce(
          Object.assign(new Error('UNIQUE constraint failed'), { code: 'SQLITE_CONSTRAINT_UNIQUE' }),
        ); // SENT save collides with the echo row
      (repository.findOne as jest.Mock).mockResolvedValueOnce(echoRow);

      await service.sendText('sess-1', { chatId: '628123456789@c.us', text: 'hi' });

      // SENT state merged onto the echo row; the redundant PENDING row dropped.
      expect(repository.update).toHaveBeenCalledWith(
        { sessionId: 'sess-1', waMessageId: 'wa-msg-1' },
        expect.objectContaining({ status: MessageStatus.SENT }),
      );
      expect(repository.delete).toHaveBeenCalledWith({ id: 'msg-uuid-1' });
      const persisted = (hookManager.execute as jest.Mock).mock.calls.filter(
        ([ev]: unknown[]) => ev === 'message:persisted',
      ) as unknown[][];
      // PENDING + the surviving echo row (the failed SENT save itself emits nothing).
      expect(persisted).toHaveLength(2);
      expect(persisted[1][1]).toMatchObject({ message: { id: 'echo-uuid-9' } });
      const deleted = (hookManager.execute as jest.Mock).mock.calls.filter(
        ([ev]: unknown[]) => ev === 'message:deleted',
      ) as unknown[][];
      expect(deleted).toHaveLength(1);
      expect(deleted[0][1]).toMatchObject({ sessionId: 'sess-1', message: { id: 'msg-uuid-1' } });
      expect(deleted[0][2]).toMatchObject({ sessionId: 'sess-1', source: 'MessageService' });
    });

    it('should throw BadRequestException when plugin blocks sending', async () => {
      (hookManager.execute as jest.Mock).mockResolvedValueOnce({ continue: false, data: {} });

      await expect(service.sendText('sess-1', { chatId: 'test@c.us', text: 'blocked' })).rejects.toThrow(
        'Message sending blocked by plugin',
      );
    });

    it('should throw BadRequestException if session is not active', async () => {
      engines.delete('sess-1');

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

    it('rejects an over-cap render with a 400 naming the limit (never truncated silently)', async () => {
      (templateService.resolve as jest.Mock).mockResolvedValue(mockTemplate({ body: 'Hi {{customer}}' }));

      const error = await service
        .sendTemplate('sess-1', {
          chatId: 'test@c.us',
          templateId: 'tpl-1',
          vars: { customer: 'x'.repeat(70_000) },
        })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as Error).message).toContain('over the 65536-character limit');
      expect(mockEngine.sendTextMessage).not.toHaveBeenCalled();
    });

    it('renders at-or-under the cap unchanged', async () => {
      (templateService.resolve as jest.Mock).mockResolvedValue(mockTemplate({ body: 'Hi {{customer}}' }));
      // 'Hi ' + name lands exactly on the 64 KiB default cap — at the cap is NOT over it.
      const name = 'y'.repeat(64 * 1024 - 3);

      await service.sendTemplate('sess-1', { chatId: 'test@c.us', templateId: 'tpl-1', vars: { customer: name } });

      expect(mockEngine.sendTextMessage).toHaveBeenCalledWith('test@c.us', `Hi ${name}`);
    });

    it('honors a configured template.renderMaxChars override', async () => {
      const configService = {
        get: (key: string, fallback: unknown) => (key === 'template.renderMaxChars' ? 10 : fallback),
      } as unknown as ConstructorParameters<typeof MessageService>[8];
      const capped = new MessageService(
        repository as Repository<Message>,
        sessionService as unknown as SessionService,
        engines,
        messageProjector as unknown as MessageProjector,
        hookManager as HookManager,
        templateService as unknown as TemplateService,
        lidMappingStore as unknown as LidMappingStoreService,
        inertPacing(),
        configService,
      );
      (templateService.resolve as jest.Mock).mockResolvedValue(mockTemplate({ body: 'Hello {{customer}}' }));

      await expect(
        capped.sendTemplate('sess-1', { chatId: 'test@c.us', templateId: 'tpl-1', vars: { customer: 'Alice' } }),
      ).rejects.toThrow(/over the 10-character limit/);
      expect(mockEngine.sendTextMessage).not.toHaveBeenCalled();
    });
  });

  // ── send-hook chokepoint ──────────────────────────────────────────

  describe('send-hook chokepoint (message:sending gate + message:failed across all senders)', () => {
    it('runs the message:sending gate for a media send (sendImage) tagged with the media type', async () => {
      await service.sendImage('sess-1', { chatId: '628@c.us', url: 'https://e.com/i.jpg', caption: 'hi' });
      expect(hookManager.execute).toHaveBeenCalledWith(
        'message:sending',
        expect.objectContaining({ type: 'image' }),
        expect.any(Object),
      );
    });

    it('runs the message:sending gate for an extended send (sendPoll)', async () => {
      await service.sendPoll('sess-1', { chatId: '628@c.us', name: 'Q?', options: ['a', 'b'] });
      expect(hookManager.execute).toHaveBeenCalledWith(
        'message:sending',
        expect.objectContaining({ type: 'poll' }),
        expect.any(Object),
      );
    });

    it('lets a plugin block a media send (continue:false) before the engine is called', async () => {
      (hookManager.execute as jest.Mock).mockResolvedValueOnce({ continue: false, data: {} });
      await expect(service.sendImage('sess-1', { chatId: '628@c.us', url: 'https://e.com/i.jpg' })).rejects.toThrow(
        'Message sending blocked by plugin',
      );
      expect(mockEngine.sendImageMessage).not.toHaveBeenCalled();
    });

    it('threads a plugin-modified media input through to the engine', async () => {
      (hookManager.execute as jest.Mock).mockResolvedValueOnce({
        continue: true,
        data: {
          sessionId: 'sess-1',
          type: 'image',
          input: { chatId: '999@c.us', url: 'https://e.com/mod.jpg', caption: 'edited' },
        },
      });
      await service.sendImage('sess-1', { chatId: '628@c.us', url: 'https://e.com/i.jpg', caption: 'orig' });
      expect(mockEngine.sendImageMessage).toHaveBeenCalledWith(
        '999@c.us',
        expect.objectContaining({ data: 'https://e.com/mod.jpg', caption: 'edited' }),
      );
    });

    it('fires message:failed when a media send fails (previously only sendText did)', async () => {
      mockEngine.sendImageMessage.mockRejectedValueOnce(new Error('engine down'));
      await expect(service.sendImage('sess-1', { chatId: '628@c.us', url: 'https://e.com/i.jpg' })).rejects.toThrow(
        'engine down',
      );
      expect(hookManager.execute).toHaveBeenCalledWith(
        'message:failed',
        expect.objectContaining({ type: 'image', error: 'engine down' }),
        expect.any(Object),
      );
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

    it('maps a blocked-media-URL SSRF error to HTTP 400 with a generic message (no internal IP leak)', async () => {
      mockEngine.sendImageMessage.mockRejectedValueOnce(
        new SsrfBlockedError('Host x resolves to a blocked internal address: 169.254.169.254'),
      );

      // Generic client message — the resolved internal IP must NOT reach the caller (recon oracle).
      await expect(
        service.sendImage('sess-1', { chatId: '628123456789@c.us', url: 'http://127.0.0.1/x.png' }),
      ).rejects.toMatchObject({ response: { message: 'Destination address is not allowed' } });
    });

    it('does not leak the SSRF internal address into the message:failed hook payload (media sends now route there)', async () => {
      mockEngine.sendImageMessage.mockRejectedValueOnce(
        new SsrfBlockedError('Host x resolves to a blocked internal address: 169.254.169.254'),
      );

      await expect(
        service.sendImage('sess-1', { chatId: '628123456789@c.us', url: 'http://127.0.0.1/x.png' }),
      ).rejects.toThrow();

      const calls = (hookManager.execute as jest.Mock).mock.calls as [string, { error?: string }, unknown][];
      const failedCall = calls.find(c => c[0] === 'message:failed');
      expect(failedCall).toBeDefined();
      // The hook payload (now delivered to plugins for media sends) carries the generic message, NOT
      // the resolved internal IP that the raw SsrfBlockedError.message contains.
      expect(failedCall![1].error).toBe('Destination address is not allowed');
      expect(failedCall![1].error).not.toContain('169.254.169.254');
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

    // A query-builder fake that actually filters by the `(from IN (:...froms) OR author IN (:...authorFroms))`
    // clause it receives, so the test exercises the resolution-driven expansion end to end (filter -> rows).
    const makeFilteringQb = () => {
      let froms: string[] | null = null;
      let authorFroms: string[] | null = null;
      const qb = {
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
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

    it('labels the message:sending gate "voice" for a voice note (matches the persisted/failed type)', async () => {
      await service.sendAudio('sess-1', { chatId: 'test@c.us', url: 'https://example.com/voice', ptt: true });
      expect(hookManager.execute).toHaveBeenCalledWith(
        'message:sending',
        expect.objectContaining({ type: 'voice' }),
        expect.any(Object),
      );
    });

    it('labels the message:sending gate "audio" for a plain (non-ptt) audio send', async () => {
      await service.sendAudio('sess-1', { chatId: 'test@c.us', url: 'https://example.com/audio.ogg' });
      expect(hookManager.execute).toHaveBeenCalledWith(
        'message:sending',
        expect.objectContaining({ type: 'audio' }),
        expect.any(Object),
      );
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

  // ── sendPoll ──────────────────────────────────────────────────────

  describe('sendPoll', () => {
    it('should send a poll and default to single choice', async () => {
      const result = await service.sendPoll('sess-1', {
        chatId: '120363000@g.us',
        name: 'Where should we meet?',
        options: ['Park', 'Beach'],
      });

      expect(result.messageId).toBe('wa-msg-1');
      expect(mockEngine.sendPollMessage).toHaveBeenCalledWith('120363000@g.us', {
        name: 'Where should we meet?',
        options: ['Park', 'Beach'],
        allowMultipleAnswers: false,
      });
      // A poll has no plain-text body, so it is persisted as type 'poll' with the question as the body.
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'poll', body: '📊 Where should we meet?' }),
      );
    });

    it('should pass allowMultipleAnswers through to the engine', async () => {
      await service.sendPoll('sess-1', {
        chatId: '120363000@g.us',
        name: 'Pick toppings',
        options: ['Cheese', 'Ham', 'Olives'],
        allowMultipleAnswers: true,
      });

      expect(mockEngine.sendPollMessage).toHaveBeenCalledWith(
        '120363000@g.us',
        expect.objectContaining({ allowMultipleAnswers: true }),
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

    it('gates the forward against pacing by its destination chat', async () => {
      // ForwardMessageDto has no `chatId` — the gate must fall back to `toChatId`, or forwards skip
      // the cold-reachout rule entirely while their persisted row still drains the cold budget.
      const { assertSendAllowed } = (service as unknown as { pacing: { assertSendAllowed: jest.Mock } }).pacing;

      await service.forward('sess-1', {
        fromChatId: 'from@c.us',
        toChatId: 'to@c.us',
        messageId: 'wa-msg-to-fwd',
      });

      expect(assertSendAllowed).toHaveBeenCalledWith('sess-1', 'to@c.us');
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

    it('prefers base64 over url when both are provided (#670)', async () => {
      // When both are sent, base64 is the explicit local payload and must win over `url` — otherwise
      // a stale `url` is fetched and silently shadows the image. This aligns the send selection with
      // the base64-first persisted metadata and the `@ValidateIf((o) => !o.base64)` intent on `url`.
      await service.sendImage('sess-1', {
        chatId: '628123456789@c.us',
        url: 'https://example.com/img.jpg',
        base64: 'iVBORw0KGgoAAAAN...',
        mimetype: 'image/png',
      });

      expect(mockEngine.sendImageMessage).toHaveBeenCalledWith(
        '628123456789@c.us',
        expect.objectContaining({ data: 'iVBORw0KGgoAAAAN...' }),
      );
      expect(mockEngine.sendImageMessage).not.toHaveBeenCalledWith(
        '628123456789@c.us',
        expect.objectContaining({ data: 'https://example.com/img.jpg' }),
      );
    });

    it('strips a data-URI prefix before passing base64 bytes to the engine', async () => {
      await service.sendImage('sess-1', {
        chatId: '628123456789@c.us',
        base64: 'data:image/png;base64,QUJD',
        mimetype: 'image/png',
      });

      expect(mockEngine.sendImageMessage).toHaveBeenCalledWith(
        '628123456789@c.us',
        expect.objectContaining({ data: 'QUJD' }),
      );
    });

    it('rejects a data URI with no encoded payload', async () => {
      await expect(
        service.sendImage('sess-1', {
          chatId: '628123456789@c.us',
          base64: 'data:image/png;base64,',
          mimetype: 'image/png',
        }),
      ).rejects.toThrow('Either url or base64 must be provided');
      expect(mockEngine.sendImageMessage).not.toHaveBeenCalled();
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
  });

  /**
   * The empty id is the engine's "sent, but I couldn't read the id back" signal (#757). It has to reach
   * the DB as NULL: UQ_messages_sessionId_waMessageId is NOT partial, so '' collides with the next
   * id-less send in the same session, while NULLs stay exempt. In the bulk path that violation is
   * swallowed into a warning, so the row would vanish with nothing surfacing.
   */
  describe('saveOutgoingMessage id normalization (#757)', () => {
    it('stores an empty engine id as NULL rather than an empty string', async () => {
      await service.saveOutgoingMessage('sess-1', { waMessageId: '', chatId: '621@c.us', type: 'text' });

      expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ waMessageId: undefined }));
    });

    it('leaves a real id untouched', async () => {
      await service.saveOutgoingMessage('sess-1', {
        waMessageId: 'true_621@c.us_ABC',
        chatId: '621@c.us',
        type: 'text',
      });

      expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ waMessageId: 'true_621@c.us_ABC' }));
    });
  });

  describe('persistSentState vs the own-send echo (dedup race)', () => {
    it('merges state onto the echo row, then drops the redundant PENDING row', async () => {
      // The engine's message_create echo (onMessageCreate) won the insert race, so the SENT-state save
      // collides on UNIQUE(sessionId, waMessageId). The echo row carries only a media-less marker —
      // the merge must land status/timestamp/metadata on it BEFORE the placeholder is deleted, or the
      // payload is lost. The send still succeeds.
      (repository.save as jest.Mock)
        .mockImplementationOnce(msg => Promise.resolve(msg)) // saveOutgoingMessage (PENDING)
        .mockRejectedValueOnce(new Error('UNIQUE constraint failed: messages.sessionId, messages.waMessageId'));

      const result = await service.sendText('sess-1', { chatId: '621@c.us', text: 'hi' });

      expect(result.messageId).toBe('wa-msg-1'); // send reported success
      expect(repository.update).toHaveBeenCalledWith(
        { sessionId: 'sess-1', waMessageId: 'wa-msg-1' },
        expect.objectContaining({ status: MessageStatus.SENT, timestamp: 1706868000 }),
      );
      expect(repository.delete).toHaveBeenCalledWith({ id: 'msg-uuid-1' });
    });

    it('merges the media payload onto the echo row for a media send (no data loss after reload)', async () => {
      (repository.save as jest.Mock)
        .mockImplementationOnce(msg => Promise.resolve(msg))
        .mockRejectedValueOnce(new Error('UNIQUE constraint failed: messages.sessionId, messages.waMessageId'));

      await service.sendImage('sess-1', { chatId: '621@c.us', base64: 'QUJD', mimetype: 'image/png' });

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const patch = (repository.update as jest.Mock).mock.calls[0]?.[1] as Record<string, unknown> | undefined;
      expect((patch?.metadata as { media?: { data?: string } } | undefined)?.media?.data).toBe('QUJD');
      expect(repository.delete).toHaveBeenCalledWith({ id: 'msg-uuid-1' });
    });

    it('does NOT delete anything on a transient (non-unique) persist error', async () => {
      (repository.save as jest.Mock)
        .mockImplementationOnce(msg => Promise.resolve(msg))
        .mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));

      const result = await service.sendText('sess-1', { chatId: '621@c.us', text: 'hi' });

      expect(result.messageId).toBe('wa-msg-1'); // transient persist faults never fail the send
      expect(repository.delete).not.toHaveBeenCalled();
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
        sessionService as unknown as SessionService,
        engines,
        messageProjector as unknown as MessageProjector,
        hookManager as HookManager,
        templateService as unknown as TemplateService,
        lidMappingStore as unknown as LidMappingStoreService,
        inertPacing(),
        undefined,
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
  });
});
