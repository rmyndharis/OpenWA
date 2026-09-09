import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BadRequestException, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { MessageSendService } from './message-send.service';
import { Message, MessageDirection, MessageStatus } from './entities/message.entity';
import { SessionService } from '../session/session.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import type { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { HookManager } from '../../core/hooks';
import { TemplateService } from '../template/template.service';
import { Template } from '../template/entities/template.entity';
import { SsrfBlockedError } from '../../common/security/ssrf-guard';
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
    sendChatState: jest.fn().mockResolvedValue(undefined),
  };
}

describe('MessageSendService', () => {
  let service: MessageSendService;
  let repository: jest.Mocked<Partial<Repository<Message>>>;
  let sessionService: jest.Mocked<Partial<SessionService>>;
  let engines: EngineRegistry;
  let hookManager: jest.Mocked<Partial<HookManager>>;
  let templateService: jest.Mocked<Partial<TemplateService>>;
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
    };

    mockEngine = createMockEngine();

    sessionService = {
      findOne: jest.fn().mockResolvedValue({ id: 'sess-1', phone: '628123456789' }),
    };

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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessageSendService,
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
        { provide: HookManager, useValue: hookManager },
        { provide: TemplateService, useValue: templateService },
      ],
    }).compile();

    service = module.get<MessageSendService>(MessageSendService);
  });

  // ── sendText ──────────────────────────────────────────────────────

  describe('auto-typing before send (SIMULATE_TYPING, opt-in)', () => {
    it('does not send typing presence by default when SIMULATE_TYPING is unset', async () => {
      delete process.env.SIMULATE_TYPING;

      await service.sendText('sess-1', { chatId: '628123456789@c.us', text: 'Hello' });

      expect(mockEngine.sendChatState).not.toHaveBeenCalled();
      expect(mockEngine.sendTextMessage).toHaveBeenCalledWith('628123456789@c.us', 'Hello');
    });

    it('sends a typing presence before the message when SIMULATE_TYPING=true', async () => {
      process.env.SIMULATE_TYPING = 'true';
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

      // Timestamp merged onto the echo row; the redundant PENDING row dropped. `status` is NOT
      // written: the echo row is already SENT and an ack may have advanced it further.
      const [, mergePatch] = (repository.update as jest.Mock).mock.calls[0] as [unknown, object];
      expect(mergePatch).not.toHaveProperty('status');
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

    it('carries mentions and linkPreview from the template body through to the send', async () => {
      // The rendered body is dispatched through sendText, so the two optionals it already honours
      // reach the engine unchanged rather than being dropped at the template DTO.
      (templateService.resolve as jest.Mock).mockResolvedValue(mockTemplate({ body: 'Hi @62811' }));

      await service.sendTemplate('sess-1', {
        chatId: 'group@g.us',
        templateId: 'tpl-1',
        mentions: ['62811@c.us'],
        linkPreview: false,
      });

      expect(mockEngine.sendTextMessage).toHaveBeenCalledWith('group@g.us', 'Hi @62811', ['62811@c.us'], {
        linkPreview: false,
      });
    });

    it('leaves a plain template send on its two-argument call shape', async () => {
      // Control for the case above: without either optional the call must not gain arguments, or
      // every existing template send changes shape.
      (templateService.resolve as jest.Mock).mockResolvedValue(mockTemplate({ body: 'Hi there' }));

      await service.sendTemplate('sess-1', { chatId: 'test@c.us', templateId: 'tpl-1' });

      expect(mockEngine.sendTextMessage).toHaveBeenCalledWith('test@c.us', 'Hi there');
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
      } as unknown as ConstructorParameters<typeof MessageSendService>[6];
      const capped = new MessageSendService(
        repository as Repository<Message>,
        sessionService as unknown as SessionService,
        engines,
        hookManager as HookManager,
        templateService as unknown as TemplateService,
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

  // ── quoted sends (issue #1271) ────────────────────────────────────

  describe('quotedMessageId on the send endpoints', () => {
    // One case per sender rather than the media funnel alone: location, contact and poll each build
    // their own engine payload, so a thread that covered only buildMediaInput would leave three
    // endpoints accepting the field and silently discarding it.
    it('sendImage forwards quotedMessageId in the media payload', async () => {
      await service.sendImage('sess-1', {
        chatId: 'test@c.us',
        url: 'https://example.com/a.png',
        quotedMessageId: 'wa-quoted-9',
      });

      expect(mockEngine.sendImageMessage).toHaveBeenCalledWith(
        'test@c.us',
        expect.objectContaining({ quotedMessageId: 'wa-quoted-9' }),
      );
    });

    it('sendLocation forwards quotedMessageId', async () => {
      await service.sendLocation('sess-1', {
        chatId: 'test@c.us',
        latitude: 1,
        longitude: 2,
        quotedMessageId: 'wa-quoted-9',
      });

      expect(mockEngine.sendLocationMessage).toHaveBeenCalledWith(
        'test@c.us',
        expect.objectContaining({ quotedMessageId: 'wa-quoted-9' }),
      );
    });

    it('sendContact forwards quotedMessageId', async () => {
      await service.sendContact('sess-1', {
        chatId: 'test@c.us',
        contactName: 'Alice',
        contactNumber: '628999',
        quotedMessageId: 'wa-quoted-9',
      });

      expect(mockEngine.sendContactMessage).toHaveBeenCalledWith(
        'test@c.us',
        expect.objectContaining({ quotedMessageId: 'wa-quoted-9' }),
      );
    });

    it('sendPoll forwards quotedMessageId', async () => {
      await service.sendPoll('sess-1', {
        chatId: 'test@c.us',
        name: 'Q',
        options: ['a', 'b'],
        quotedMessageId: 'wa-quoted-9',
      });

      expect(mockEngine.sendPollMessage).toHaveBeenCalledWith(
        'test@c.us',
        expect.objectContaining({ quotedMessageId: 'wa-quoted-9' }),
      );
    });

    it('sendText forwards quotedMessageId through the options bag', async () => {
      await service.sendText('sess-1', {
        chatId: 'test@c.us',
        text: 'hi',
        quotedMessageId: 'wa-quoted-9',
      });

      expect(mockEngine.sendTextMessage).toHaveBeenCalledWith(
        'test@c.us',
        'hi',
        undefined,
        expect.objectContaining({ quotedMessageId: 'wa-quoted-9' }),
      );
    });

    // Known-negative control: a plain text send must keep its narrow call shape. Without this an
    // implementation that always passed an options object would satisfy the assertion above while
    // rewriting every existing send.
    it('leaves an unquoted text send on its existing two-argument call shape', async () => {
      await service.sendText('sess-1', { chatId: 'test@c.us', text: 'hi' });

      expect(mockEngine.sendTextMessage).toHaveBeenCalledWith('test@c.us', 'hi');
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

    it('forwards the tag list to the engine, and keeps the untagged call three-argument', async () => {
      await service.reply('sess-1', {
        chatId: 'group@g.us',
        quotedMessageId: 'wa-quoted-1',
        text: 'hi @62811',
        mentions: ['62811@c.us'],
      });

      expect(mockEngine.replyToMessage).toHaveBeenCalledWith('group@g.us', 'wa-quoted-1', 'hi @62811', ['62811@c.us']);

      // Control: an empty list is not a tag request, so the call shape every existing reply makes is
      // left untouched rather than gaining a trailing argument.
      mockEngine.replyToMessage.mockClear();
      await service.reply('sess-1', {
        chatId: 'group@g.us',
        quotedMessageId: 'wa-quoted-1',
        text: 'plain',
        mentions: [],
      });
      expect(mockEngine.replyToMessage).toHaveBeenCalledWith('group@g.us', 'wa-quoted-1', 'plain');
    });

    it('honours a plugin that rewrites the tag list, not the list the caller sent', async () => {
      // message:sending is a moderation chokepoint. Reading the caller's own dto here instead of the
      // gated result would send the unredacted tags while the hook reported success.
      (hookManager.execute as jest.Mock).mockResolvedValueOnce({
        continue: true,
        data: {
          input: {
            chatId: 'group@g.us',
            quotedMessageId: 'wa-quoted-1',
            text: 'hi @62811',
            mentions: ['62811@c.us'],
          },
        },
      });

      await service.reply('sess-1', {
        chatId: 'group@g.us',
        quotedMessageId: 'wa-quoted-1',
        text: 'hi @62811 @62999',
        mentions: ['62811@c.us', '62999@c.us'],
      });

      expect(mockEngine.replyToMessage).toHaveBeenCalledWith('group@g.us', 'wa-quoted-1', 'hi @62811', ['62811@c.us']);
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

  // The bulk path persists AFTER the send with the engine id already known, so it races the own-send
  // echo on UNIQUE(sessionId, waMessageId). Losing that race used to drop the batch's media payload.
  describe('saveOutgoingMessage vs the own-send echo (dedup race)', () => {
    const uniqueViolation = new Error('UNIQUE constraint failed: messages.sessionId, messages.waMessageId');
    const bulkRow = {
      waMessageId: 'wa-bulk-1',
      chatId: '621@c.us',
      type: 'image',
      status: MessageStatus.SENT,
      timestamp: 1706868000,
      metadata: { media: { mimetype: 'image/png', data: 'QUJD', filename: 'a.png' } },
    };

    it('merges the media payload onto the echo row instead of losing it', async () => {
      (repository.save as jest.Mock).mockRejectedValueOnce(uniqueViolation);
      (repository.findOne as jest.Mock).mockResolvedValueOnce({ id: 'echo-row', ...bulkRow });

      const saved = await service.saveOutgoingMessage('sess-1', bulkRow);

      expect(repository.update).toHaveBeenCalledWith(
        { sessionId: 'sess-1', waMessageId: 'wa-bulk-1' },
        expect.objectContaining({
          timestamp: 1706868000,
          metadata: bulkRow.metadata,
        }),
      );
      const [, bulkPatch] = (repository.update as jest.Mock).mock.calls[0] as [unknown, object];
      expect(bulkPatch).not.toHaveProperty('status');
      expect(saved).toEqual(expect.objectContaining({ id: 'echo-row' }));
    });

    it('does not overwrite the echo row’s downloaded bytes with a URL pointer', async () => {
      // A wwjs echo carries the media it downloaded; a URL-based send carries only the URL string.
      // Merging ours over theirs would discard bytes the gateway already holds — and leave a row
      // the archive cannot use.
      (repository.save as jest.Mock).mockRejectedValueOnce(uniqueViolation);
      (repository.findOne as jest.Mock).mockResolvedValueOnce({ id: 'echo-row' });

      await service.saveOutgoingMessage('sess-1', {
        ...bulkRow,
        metadata: { media: { mimetype: 'image/png', data: 'https://example.com/cat.png' } },
      });

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const patch = (repository.update as jest.Mock).mock.calls[0]?.[1] as Record<string, unknown>;
      expect(patch).not.toHaveProperty('metadata');
    });

    it('leaves the echo row metadata alone when this write carries none', async () => {
      (repository.save as jest.Mock).mockRejectedValueOnce(uniqueViolation);
      (repository.findOne as jest.Mock).mockResolvedValueOnce({ id: 'echo-row' });

      await service.saveOutgoingMessage('sess-1', { ...bulkRow, type: 'text', metadata: undefined });

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const patch = (repository.update as jest.Mock).mock.calls[0]?.[1] as Record<string, unknown>;
      expect(patch).not.toHaveProperty('metadata');
    });

    it('rethrows a transient (non-unique) persist error', async () => {
      (repository.save as jest.Mock).mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));

      await expect(service.saveOutgoingMessage('sess-1', bulkRow)).rejects.toThrow('SQLITE_BUSY');
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('rethrows when there is no engine id to merge onto', async () => {
      (repository.save as jest.Mock).mockRejectedValueOnce(uniqueViolation);

      await expect(service.saveOutgoingMessage('sess-1', { chatId: '621@c.us', type: 'text' })).rejects.toThrow(
        uniqueViolation,
      );
      expect(repository.update).not.toHaveBeenCalled();
    });
  });

  describe('persistSentState vs the own-send echo (dedup race)', () => {
    it('merges state onto the echo row, then drops the redundant PENDING row', async () => {
      // The engine's message_create echo (onMessageCreate) won the insert race, so the SENT-state save
      // collides on UNIQUE(sessionId, waMessageId). The echo row carries only what the engine reported
      // — for a Baileys API send, a media-less marker — so the merge must land status/timestamp/metadata
      // on it BEFORE the placeholder is deleted, or the payload is lost. The send still succeeds.
      (repository.save as jest.Mock)
        .mockImplementationOnce(msg => Promise.resolve(msg)) // saveOutgoingMessage (PENDING)
        .mockRejectedValueOnce(new Error('UNIQUE constraint failed: messages.sessionId, messages.waMessageId'));

      const result = await service.sendText('sess-1', { chatId: '621@c.us', text: 'hi' });

      expect(result.messageId).toBe('wa-msg-1'); // send reported success
      expect(repository.update).toHaveBeenCalledWith(
        { sessionId: 'sess-1', waMessageId: 'wa-msg-1' },
        expect.objectContaining({ timestamp: 1706868000 }),
      );
      /**
       * The delivery state is not in that patch, and that is the point.
       *
       * The row it merges onto is the own-send echo's, inserted SENT, and the ack path advances it
       * forward-only. This merge could only ever write PENDING or SENT, so it was never an upgrade:
       * when a `delivered` ack won the race, writing SENT here dragged the row back and the
       * dashboard showed one tick for a message the recipient already had.
       */
      const [, sentPatch] = (repository.update as jest.Mock).mock.calls[0] as [unknown, object];
      expect(sentPatch).not.toHaveProperty('status');
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

    it('keeps the echo row’s downloaded bytes rather than merging a URL pointer over them', async () => {
      (repository.save as jest.Mock)
        .mockImplementationOnce(msg => Promise.resolve(msg))
        .mockRejectedValueOnce(new Error('UNIQUE constraint failed: messages.sessionId, messages.waMessageId'));

      await service.sendImage('sess-1', { chatId: '621@c.us', url: 'https://example.com/cat.png' });

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const patch = (repository.update as jest.Mock).mock.calls[0]?.[1] as Record<string, unknown> | undefined;
      expect(patch).not.toHaveProperty('metadata');
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

  // ── outbound archiving (CHAT_MEDIA_ARCHIVE_OUTBOUND) ─────────────

  describe('archiving media this account sent', () => {
    const withFlag = (archiveOutbound: boolean, archive: { archive: jest.Mock }): MessageSendService =>
      new MessageSendService(
        repository as Repository<Message>,
        sessionService as unknown as SessionService,
        engines,
        hookManager as HookManager,
        templateService as unknown as TemplateService,
        inertPacing(),
        {
          get: (key: string, fallback?: unknown) => (key === 'chatMedia.archiveOutbound' ? archiveOutbound : fallback),
        } as never,
        archive as never,
      );

    it('archives a SENT outbound row when the flag is on', async () => {
      const archive = { archive: jest.fn().mockResolvedValue('chat-media/k') };
      const svc = withFlag(true, archive);

      await svc.saveOutgoingMessage('sess-1', {
        waMessageId: 'wa-1',
        chatId: '621@c.us',
        type: 'image',
        status: MessageStatus.SENT,
        metadata: { media: { mimetype: 'image/png', data: 'QUJD' } },
      });

      expect(archive.archive).toHaveBeenCalledWith(expect.objectContaining({ waMessageId: 'wa-1' }));
    });

    it('archives nothing while the flag is off', async () => {
      const archive = { archive: jest.fn() };
      const svc = withFlag(false, archive);

      await svc.saveOutgoingMessage('sess-1', {
        waMessageId: 'wa-1',
        chatId: '621@c.us',
        type: 'image',
        status: MessageStatus.SENT,
        metadata: { media: { mimetype: 'image/png', data: 'QUJD' } },
      });

      expect(archive.archive).not.toHaveBeenCalled();
    });

    it('never archives a PENDING row — the merge may delete it and the reaper may rewrite it', async () => {
      const archive = { archive: jest.fn() };
      const svc = withFlag(true, archive);

      await svc.saveOutgoingMessage('sess-1', {
        chatId: '621@c.us',
        type: 'image',
        metadata: { media: { mimetype: 'image/png', data: 'QUJD' } },
      });

      expect(archive.archive).not.toHaveBeenCalled();
    });
  });
});
