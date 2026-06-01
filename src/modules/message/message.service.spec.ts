import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BadRequestException } from '@nestjs/common';
import { MessageService } from './message.service';
import { Message, MessageDirection, MessageStatus } from './entities/message.entity';
import { SessionService } from '../session/session.service';
import { HookManager } from '../../core/hooks';

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
  };
}

describe('MessageService', () => {
  let service: MessageService;
  let repository: jest.Mocked<Partial<Repository<Message>>>;
  let sessionService: jest.Mocked<Partial<SessionService>>;
  let hookManager: jest.Mocked<Partial<HookManager>>;
  let mockEngine: ReturnType<typeof createMockEngine>;

  beforeEach(async () => {
    repository = {
      create: jest.fn().mockImplementation((data: Partial<Message>) => ({ id: 'msg-uuid-1', ...data }) as Message),
      save: jest.fn().mockImplementation(msg => Promise.resolve(msg)),
      createQueryBuilder: jest.fn(),
    };

    mockEngine = createMockEngine();

    sessionService = {
      getEngine: jest.fn().mockReturnValue(mockEngine),
      resolveEngine: jest.fn().mockResolvedValue(mockEngine),
      findOne: jest.fn().mockResolvedValue({ id: 'sess-1', phone: '628123456789' }),
    };

    hookManager = {
      execute: jest.fn().mockResolvedValue({
        continue: true,
        data: { sessionId: 'sess-1', input: { chatId: '628123456789@c.us', text: 'Hello' }, type: 'text' },
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessageService,
        { provide: getRepositoryToken(Message, 'data'), useValue: repository },
        { provide: SessionService, useValue: sessionService },
        { provide: HookManager, useValue: hookManager },
      ],
    }).compile();

    service = module.get<MessageService>(MessageService);
  });

  // ── sendText ──────────────────────────────────────────────────────

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

    it('should execute message:sending and message:sent hooks', async () => {
      await service.sendText('sess-1', {
        chatId: '628123456789@c.us',
        text: 'Hello',
      });

      expect(hookManager.execute).toHaveBeenCalledWith(
        'message:sending',
        expect.objectContaining({ type: 'text' }),
        expect.any(Object),
      );
      expect(hookManager.execute).toHaveBeenCalledWith(
        'message:sent',
        expect.objectContaining({ result: mockEngineResult }),
        expect.any(Object),
      );
    });

    it('should throw BadRequestException when plugin blocks sending', async () => {
      (hookManager.execute as jest.Mock).mockResolvedValueOnce({ continue: false, data: {} });

      await expect(service.sendText('sess-1', { chatId: 'test@c.us', text: 'blocked' })).rejects.toThrow(
        'Message sending blocked by plugin',
      );
    });

    it('should throw BadRequestException if session is not active', async () => {
      (sessionService.resolveEngine as jest.Mock).mockRejectedValue(
        new BadRequestException(`Session 'inactive' is not active. Start the session first.`),
      );

      await expect(service.sendText('inactive', { chatId: 'test@c.us', text: 'hello' })).rejects.toThrow(
        BadRequestException,
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
