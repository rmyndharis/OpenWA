import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsIn,
  IsArray,
  IsObject,
  IsOptional,
  IsNumber,
  IsBoolean,
  ValidateNested,
  MaxLength,
  Min,
  Max,
  ArrayMaxSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { Validate } from 'class-validator';
import { ToStrictBoolean } from '../../../common/utils/strict-boolean';
import {
  MENTIONS_DESCRIPTION,
  MENTIONS_MAX,
  MENTION_WID_MAX_LENGTH,
  MESSAGE_TEXT_MAX_LENGTH,
} from './send-message.dto';
import { IsMentionWidConstraint } from './is-mention-wid.validator';
import { BatchMessageStatus, BatchStatus } from '../entities/message-batch.entity';

class BulkMediaDto {
  @ApiPropertyOptional({ description: 'Media URL (http/https)' })
  @IsOptional()
  @IsString()
  url?: string;

  @ApiPropertyOptional({ description: 'Base64-encoded media data' })
  @IsOptional()
  @IsString()
  base64?: string;

  @ApiPropertyOptional({ description: 'Media MIME type' })
  @IsOptional()
  @IsString()
  mimetype?: string;

  @ApiPropertyOptional({ description: 'Filename (documents only)' })
  @IsOptional()
  @IsString()
  filename?: string;

  @ApiPropertyOptional({ description: 'Audio only: send as a WhatsApp voice note (PTT)' })
  @ToStrictBoolean()
  @IsOptional()
  @IsBoolean()
  ptt?: boolean;
}

class BulkMessageContentDto {
  @ApiPropertyOptional({ description: 'Text content for text messages', maxLength: MESSAGE_TEXT_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(MESSAGE_TEXT_MAX_LENGTH)
  text?: string;

  // Typed nested DTOs (not bare object literals) so the global ValidationPipe's whitelist /
  // forbidNonWhitelisted actually reaches their fields — otherwise unknown props inside a media
  // object pass straight through and are persisted verbatim.
  @ApiPropertyOptional({ description: 'Image URL or base64', type: BulkMediaDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => BulkMediaDto)
  image?: BulkMediaDto;

  @ApiPropertyOptional({ description: 'Video URL or base64', type: BulkMediaDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => BulkMediaDto)
  video?: BulkMediaDto;

  @ApiPropertyOptional({ description: 'Audio URL or base64', type: BulkMediaDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => BulkMediaDto)
  audio?: BulkMediaDto;

  @ApiPropertyOptional({ description: 'Document URL or base64', type: BulkMediaDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => BulkMediaDto)
  document?: BulkMediaDto;

  @ApiPropertyOptional({ description: 'Caption for media messages', maxLength: 1024 })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  caption?: string;

  // Applies to the text body and to a media caption alike, matching the single-send routes. Every
  // item in a batch names its own list: a batch fans out to many chats, and a WID is only taggable
  // in a chat the participant is in.
  @ApiPropertyOptional({ description: MENTIONS_DESCRIPTION, example: ['628123456789@c.us'], type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MENTIONS_MAX)
  @IsString({ each: true })
  @MaxLength(MENTION_WID_MAX_LENGTH, { each: true })
  @Validate(IsMentionWidConstraint, { each: true })
  mentions?: string[];
}

class BulkMessageItemDto {
  @ApiProperty({ description: 'Recipient chat ID', example: '628123456789@c.us' })
  @IsString()
  @IsNotEmpty()
  chatId!: string;

  @ApiProperty({ description: 'Message type', enum: ['text', 'image', 'video', 'audio', 'document'] })
  @IsIn(['text', 'image', 'video', 'audio', 'document'])
  type!: 'text' | 'image' | 'video' | 'audio' | 'document';

  @ApiProperty({ description: 'Message content based on type' })
  @ValidateNested()
  @Type(() => BulkMessageContentDto)
  content!: BulkMessageContentDto;

  @ApiPropertyOptional({ description: 'Variables for template substitution' })
  @IsOptional()
  @IsObject()
  variables?: Record<string, string>;
}

class BulkMessageOptionsDto {
  @ApiPropertyOptional({
    description: 'Delay between messages in ms.',
    default: 3000,
    minimum: 1000,
    maximum: 60000,
  })
  @IsOptional()
  @IsNumber()
  @Min(1000)
  @Max(60000)
  delayBetweenMessages?: number;

  @ApiPropertyOptional({ description: 'Add random 0-2s to delay', default: true })
  @ToStrictBoolean()
  @IsOptional()
  @IsBoolean()
  randomizeDelay?: boolean;

  @ApiPropertyOptional({ description: 'Stop batch on first error', default: false })
  @ToStrictBoolean()
  @IsOptional()
  @IsBoolean()
  stopOnError?: boolean;
}

export class SendBulkMessageDto {
  @ApiPropertyOptional({ description: 'Custom batch ID (auto-generated if not provided)' })
  @IsOptional()
  @IsString()
  batchId?: string;

  @ApiProperty({
    description:
      'Array of messages (max 100 per request; exact duplicate entries are collapsed — first occurrence wins)',
    type: [BulkMessageItemDto],
  })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => BulkMessageItemDto)
  messages!: BulkMessageItemDto[];

  @ApiPropertyOptional({ description: 'Batch processing options' })
  @IsOptional()
  @ValidateNested()
  @Type(() => BulkMessageOptionsDto)
  options?: BulkMessageOptionsDto;
}

export class BulkMessageResponseDto {
  @ApiProperty()
  batchId!: string;

  @ApiProperty()
  status!: string;

  @ApiProperty()
  totalMessages!: number;

  @ApiPropertyOptional()
  estimatedCompletionTime?: string;

  @ApiProperty()
  statusUrl!: string;
}

export class BatchProgressDto {
  @ApiProperty({ example: 10 })
  total!: number;

  @ApiProperty({ example: 7 })
  sent!: number;

  @ApiProperty({ example: 1 })
  failed!: number;

  @ApiProperty({ example: 2 })
  pending!: number;

  @ApiProperty({ example: 0 })
  cancelled!: number;
}

export class BatchMessageErrorDto {
  @ApiProperty({ description: 'Machine-readable failure code.', example: 'RECIPIENT_UNREACHABLE' })
  code!: string;

  @ApiProperty({ example: 'The number is not registered on WhatsApp' })
  message!: string;
}

/** Per-recipient outcome of a batch send. */
export class BatchMessageResultDto {
  @ApiProperty({ example: '628123456789@c.us' })
  chatId!: string;

  @ApiProperty({ enum: BatchMessageStatus, example: BatchMessageStatus.SENT })
  status!: BatchMessageStatus;

  @ApiPropertyOptional({
    description: 'Assigned on a successful send.',
    example: 'true_628123456789@c.us_3EB0123456789',
  })
  messageId?: string;

  @ApiPropertyOptional({ type: BatchMessageErrorDto, description: 'Present on a failed send.' })
  error?: BatchMessageErrorDto;

  @ApiPropertyOptional({ type: String, format: 'date-time', description: 'When the send completed.' })
  sentAt?: Date;
}

export class BatchStatusResponseDto {
  @ApiProperty({ example: 'batch_abc123' })
  batchId!: string;

  @ApiProperty({ enum: BatchStatus, example: BatchStatus.PROCESSING })
  status!: BatchStatus;

  @ApiProperty({ type: BatchProgressDto })
  progress!: BatchProgressDto;

  @ApiProperty({ type: [BatchMessageResultDto], description: 'One entry per recipient already attempted.' })
  results!: BatchMessageResultDto[];

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When processing started; null while the batch is pending.',
  })
  startedAt?: Date | null;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When the batch reached a terminal status; null while it is still running.',
  })
  completedAt?: Date | null;
}

export class BatchCancelResponseDto {
  @ApiProperty({ example: 'batch_abc123' })
  batchId!: string;

  @ApiProperty({ enum: BatchStatus, example: BatchStatus.CANCELLED })
  status!: BatchStatus;

  @ApiProperty({ type: BatchProgressDto })
  progress!: BatchProgressDto;
}
