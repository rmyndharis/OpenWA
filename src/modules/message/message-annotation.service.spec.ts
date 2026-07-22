import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { HookManager } from '../../core/hooks';
import { Message } from './entities/message.entity';
import { MessageAnnotation } from './entities/message-annotation.entity';
import {
  ANNOTATION_ELIGIBLE_MESSAGE_TYPES,
  MAX_ANNOTATION_METADATA_ENTRIES,
  MAX_ANNOTATION_TEXT_LENGTH,
  MessageAnnotationService,
  UpsertMessageAnnotationInput,
} from './message-annotation.service';

describe('MessageAnnotationService', () => {
  let service: MessageAnnotationService;
  let messages: jest.Mocked<Pick<Repository<Message>, 'findOne'>>;
  let annotations: jest.Mocked<Pick<Repository<MessageAnnotation>, 'upsert'>>;
  let hooks: jest.Mocked<Pick<HookManager, 'execute'>>;

  const input = {
    kind: 'transcript' as const,
    status: 'complete' as const,
    language: 'en-US',
    text: 'A short derived transcript.',
    mediaFingerprint: 'a'.repeat(64),
    processorVersion: '1.0.0',
    externalProcessing: false,
    metadata: { durationMs: 1250, confidence: 0.98 },
  };

  beforeEach(() => {
    messages = { findOne: jest.fn().mockResolvedValue({ id: 'message-1' }) };
    annotations = { upsert: jest.fn().mockResolvedValue(undefined) };
    hooks = { execute: jest.fn().mockResolvedValue({ continue: true, data: {} }) };
    service = new MessageAnnotationService(
      messages as unknown as Repository<Message>,
      annotations as unknown as Repository<MessageAnnotation>,
      hooks as unknown as HookManager,
    );
  });

  it('persists a bounded transcript annotation against an explicitly scoped message and emits a text-free lifecycle event', async () => {
    const result = await service.upsert('session-1', 'message-1', 'example-transcriber', input);

    expect(messages.findOne).toHaveBeenCalledWith({
      select: { id: true },
      where: { id: 'message-1', sessionId: 'session-1' },
    });
    expect(annotations.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        messageId: 'message-1',
        provider: 'example-transcriber',
        text: input.text,
        metadata: input.metadata,
      }),
      { conflictPaths: ['sessionId', 'messageId', 'provider', 'kind'] },
    );
    expect(result).toEqual({
      messageId: 'message-1',
      provider: 'example-transcriber',
      kind: 'transcript',
      status: 'complete',
      language: 'en-US',
      externalProcessing: false,
    });
    expect(result).not.toHaveProperty('text');
    expect(result).not.toHaveProperty('metadata');
    expect(hooks.execute).toHaveBeenCalledWith(
      'message:annotation-updated',
      { sessionId: 'session-1', annotation: result },
      { sessionId: 'session-1', source: 'MessageAnnotationService' },
    );
  });

  it('does not reveal or write across sessions when the message does not belong to the requested session', async () => {
    messages.findOne.mockResolvedValue(null);

    await expect(service.upsert('session-2', 'message-1', 'example-transcriber', input)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(annotations.upsert).not.toHaveBeenCalled();
    expect(hooks.execute).not.toHaveBeenCalled();
  });

  it('rejects overlong text and unbounded metadata before accessing storage', async () => {
    await expect(
      service.upsert('session-1', 'message-1', 'example-transcriber', {
        ...input,
        text: 'x'.repeat(MAX_ANNOTATION_TEXT_LENGTH + 1),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      service.upsert('session-1', 'message-1', 'example-transcriber', {
        ...input,
        metadata: Object.fromEntries(
          Array.from({ length: MAX_ANNOTATION_METADATA_ENTRIES + 1 }, (_, index) => [`key${index}`, index]),
        ),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(messages.findOne).not.toHaveBeenCalled();
    expect(annotations.upsert).not.toHaveBeenCalled();
  });

  it('requires transcript text for a completed transcript and rejects unknown provider identities', async () => {
    await expect(
      service.upsert('session-1', 'message-1', 'example-transcriber', { ...input, text: undefined }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.upsert('session-1', 'message-1', 'bad provider', input)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('accepts a serializable expiry but rejects invalid fingerprints, expiry values, and non-scalar metadata', async () => {
    await service.upsert('session-1', 'message-1', 'example-transcriber', {
      ...input,
      expiresAt: '2026-08-01T12:00:00.000Z',
    });
    expect(annotations.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ expiresAt: new Date('2026-08-01T12:00:00.000Z') }),
      expect.anything(),
    );

    await expect(
      service.upsert('session-1', 'message-1', 'example-transcriber', { ...input, mediaFingerprint: 'not-a-hash' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.upsert('session-1', 'message-1', 'example-transcriber', { ...input, expiresAt: 'not-an-instant' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.upsert('session-1', 'message-1', 'example-transcriber', {
        ...input,
        metadata: { nested: { no: true } },
      } as unknown as UpsertMessageAnnotationInput),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('contains lifecycle observer failures so a provider write remains durable', async () => {
    hooks.execute.mockRejectedValueOnce(new Error('observer offline'));

    await expect(service.upsert('session-1', 'message-1', 'example-transcriber', input)).resolves.toEqual(
      expect.objectContaining({ messageId: 'message-1', status: 'complete' }),
    );
  });

  it('announces only eligible media by id/type, never message body or metadata', async () => {
    expect(ANNOTATION_ELIGIBLE_MESSAGE_TYPES.has('voice')).toBe(true);
    await service.requestForMessage({ id: 'message-1', sessionId: 'session-1', type: 'voice' });

    expect(hooks.execute).toHaveBeenCalledWith(
      'message:annotation-requested',
      {
        sessionId: 'session-1',
        annotation: { messageId: 'message-1', kind: 'transcript', messageType: 'voice' },
      },
      { sessionId: 'session-1', source: 'MessageAnnotationService' },
    );

    hooks.execute.mockClear();
    await service.requestForMessage({ id: 'message-2', sessionId: 'session-1', type: 'text' });
    expect(hooks.execute).not.toHaveBeenCalled();
  });
});
