import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { HookManager } from '../../core/hooks';
import { Message } from './entities/message.entity';
import {
  MessageAnnotation,
  MessageAnnotationKind,
  MessageAnnotationMetadata,
  MessageAnnotationStatus,
} from './entities/message-annotation.entity';

/** Kept deliberately small: providers can schedule derived work for these media-bearing message types only. */
export const ANNOTATION_ELIGIBLE_MESSAGE_TYPES = new Set(['audio', 'voice', 'video', 'image', 'document', 'sticker']);
export const MAX_ANNOTATION_TEXT_LENGTH = 20_000;
export const MAX_ANNOTATION_METADATA_ENTRIES = 16;
const MAX_ANNOTATION_METADATA_KEY_LENGTH = 64;
const MAX_ANNOTATION_METADATA_STRING_LENGTH = 256;
const MAX_ANNOTATION_METADATA_BYTES = 4_096;
const MAX_PROCESSOR_VERSION_LENGTH = 128;
const MAX_MESSAGE_ID_LENGTH = 255;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const SHA256_HEX = /^[a-fA-F0-9]{64}$/;
const ANNOTATION_STATUSES: ReadonlySet<MessageAnnotationStatus> = new Set(['pending', 'complete', 'failed', 'expired']);

export interface UpsertMessageAnnotationInput {
  kind: MessageAnnotationKind;
  status: MessageAnnotationStatus;
  language?: string;
  text?: string;
  mediaFingerprint?: string;
  processorVersion: string;
  externalProcessing: boolean;
  metadata?: MessageAnnotationMetadata;
  /** ISO-8601 instant; serializable across the sandbox worker boundary. */
  expiresAt?: string;
}

/** Safe lifecycle projection: no transcript or arbitrary metadata crosses a hook by default. */
export interface MessageAnnotationLifecycle {
  messageId: string;
  provider: string;
  kind: MessageAnnotationKind;
  status: MessageAnnotationStatus;
  language?: string;
  externalProcessing: boolean;
}

export interface MessageAnnotationRequest {
  messageId: string;
  kind: 'transcript';
  messageType: string;
}

@Injectable()
export class MessageAnnotationService {
  constructor(
    @InjectRepository(Message, 'data')
    private readonly messageRepository: Repository<Message>,
    @InjectRepository(MessageAnnotation, 'data')
    private readonly annotationRepository: Repository<MessageAnnotation>,
    private readonly hookManager: HookManager,
  ) {}

  /**
   * Write one provider-owned annotation. The parent check selects only Message.id and always includes
   * sessionId, so a plugin cannot turn this into a cross-session message read or metadata/media fetch.
   */
  async upsert(
    sessionId: string,
    messageId: string,
    provider: string,
    input: UpsertMessageAnnotationInput,
  ): Promise<MessageAnnotationLifecycle> {
    const annotation = this.validateInput(sessionId, messageId, provider, input);
    const message = await this.messageRepository.findOne({
      select: { id: true },
      where: { id: messageId, sessionId },
    });
    if (!message) throw new NotFoundException('Message not found');

    await this.annotationRepository.upsert(annotation, {
      conflictPaths: ['sessionId', 'messageId', 'provider', 'kind'],
    });

    const lifecycle: MessageAnnotationLifecycle = {
      messageId,
      provider,
      kind: annotation.kind,
      status: annotation.status,
      ...(annotation.language ? { language: annotation.language } : {}),
      externalProcessing: annotation.externalProcessing,
    };
    void this.hookManager
      .execute(
        'message:annotation-updated',
        { sessionId, annotation: lifecycle },
        { sessionId, source: MessageAnnotationService.name },
      )
      .catch(() => undefined);
    return lifecycle;
  }

  /** Emits a minimal scheduling notification after a live eligible media row has been persisted. */
  requestForMessage(message: Pick<Message, 'id' | 'sessionId' | 'type'>): Promise<void> {
    if (!message.id || !message.sessionId || !ANNOTATION_ELIGIBLE_MESSAGE_TYPES.has(message.type)) {
      return Promise.resolve();
    }
    const annotation: MessageAnnotationRequest = {
      messageId: message.id,
      kind: 'transcript',
      messageType: message.type,
    };
    void this.hookManager
      .execute(
        'message:annotation-requested',
        { sessionId: message.sessionId, annotation },
        { sessionId: message.sessionId, source: MessageAnnotationService.name },
      )
      .catch(() => undefined);
    return Promise.resolve();
  }

  private validateInput(
    sessionId: string,
    messageId: string,
    provider: string,
    input: UpsertMessageAnnotationInput,
  ): Omit<MessageAnnotation, 'createdAt'> {
    if (!this.isBoundedIdentifier(sessionId) || !this.isBoundedIdentifier(messageId) || !PROVIDER_ID.test(provider)) {
      throw new BadRequestException('Invalid annotation input');
    }
    if (input?.kind !== 'transcript' || !ANNOTATION_STATUSES.has(input.status)) {
      throw new BadRequestException('Invalid annotation input');
    }
    if (
      typeof input.processorVersion !== 'string' ||
      !this.isBoundedText(input.processorVersion, MAX_PROCESSOR_VERSION_LENGTH)
    ) {
      throw new BadRequestException('Invalid annotation input');
    }
    if (typeof input.externalProcessing !== 'boolean') throw new BadRequestException('Invalid annotation input');
    if (input.language !== undefined && (!LANGUAGE_TAG.test(input.language) || input.language.length > 35)) {
      throw new BadRequestException('Invalid annotation input');
    }
    if (
      input.text !== undefined &&
      (typeof input.text !== 'string' || input.text.length > MAX_ANNOTATION_TEXT_LENGTH)
    ) {
      throw new BadRequestException('Invalid annotation input');
    }
    if (input.status === 'complete' && !input.text?.trim()) throw new BadRequestException('Invalid annotation input');
    if (input.mediaFingerprint !== undefined && !SHA256_HEX.test(input.mediaFingerprint)) {
      throw new BadRequestException('Invalid annotation input');
    }
    const expiresAt = input.expiresAt === undefined ? null : this.parseExpiration(input.expiresAt);
    const metadata = this.validateMetadata(input.metadata);

    return {
      sessionId,
      messageId,
      provider,
      kind: input.kind,
      status: input.status,
      language: input.language ?? null,
      text: input.text ?? null,
      mediaFingerprint: input.mediaFingerprint?.toLowerCase() ?? null,
      processorVersion: input.processorVersion,
      externalProcessing: input.externalProcessing,
      metadata,
      expiresAt,
    };
  }

  private validateMetadata(metadata: MessageAnnotationMetadata | undefined): MessageAnnotationMetadata | null {
    if (metadata === undefined) return null;
    if (!this.isPlainObject(metadata)) throw new BadRequestException('Invalid annotation input');
    const entries = Object.entries(metadata);
    if (entries.length > MAX_ANNOTATION_METADATA_ENTRIES) throw new BadRequestException('Invalid annotation input');
    for (const [key, value] of entries) {
      if (!key || key.length > MAX_ANNOTATION_METADATA_KEY_LENGTH)
        throw new BadRequestException('Invalid annotation input');
      if (!(
        value === null ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value)) ||
        (typeof value === 'string' && value.length <= MAX_ANNOTATION_METADATA_STRING_LENGTH)
      )) {
        throw new BadRequestException('Invalid annotation input');
      }
    }
    if (Buffer.byteLength(JSON.stringify(metadata), 'utf8') > MAX_ANNOTATION_METADATA_BYTES) {
      throw new BadRequestException('Invalid annotation input');
    }
    return metadata;
  }

  private parseExpiration(value: string): Date {
    if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(value)) {
      throw new BadRequestException('Invalid annotation input');
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new BadRequestException('Invalid annotation input');
    return parsed;
  }

  private isBoundedIdentifier(value: string): boolean {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_MESSAGE_ID_LENGTH;
  }

  private isBoundedText(value: string, maximum: number): boolean {
    return value.length > 0 && value.length <= maximum;
  }

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    return (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype
    );
  }
}
