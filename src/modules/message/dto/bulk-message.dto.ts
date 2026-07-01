import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
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
  @IsOptional()
  @IsBoolean()
  ptt?: boolean;
}

class BulkMessageContentDto {
  @ApiPropertyOptional({ description: 'Text content for text messages', maxLength: 4096 })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
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
}

class BulkMessageItemDto {
  @ApiProperty({ description: 'Recipient chat ID', example: '628123456789@c.us' })
  @IsString()
  chatId: string;

  @ApiProperty({ description: 'Message type', enum: ['text', 'image', 'video', 'audio', 'document'] })
  @IsIn(['text', 'image', 'video', 'audio', 'document'])
  type: 'text' | 'image' | 'video' | 'audio' | 'document';

  @ApiProperty({ description: 'Message content based on type' })
  @ValidateNested()
  @Type(() => BulkMessageContentDto)
  content: BulkMessageContentDto;

  @ApiPropertyOptional({ description: 'Variables for template substitution' })
  @IsOptional()
  @IsObject()
  variables?: Record<string, string>;
}

class BulkMessageOptionsDto {
  @ApiPropertyOptional({ description: 'Delay between messages in ms (min: 1000, default: 3000)', default: 3000 })
  @IsOptional()
  @IsNumber()
  @Min(1000)
  @Max(60000)
  delayBetweenMessages?: number;

  @ApiPropertyOptional({ description: 'Add random 0-2s to delay', default: true })
  @IsOptional()
  @IsBoolean()
  randomizeDelay?: boolean;

  @ApiPropertyOptional({ description: 'Stop batch on first error', default: false })
  @IsOptional()
  @IsBoolean()
  stopOnError?: boolean;
}

export class SendBulkMessageDto {
  @ApiPropertyOptional({ description: 'Custom batch ID (auto-generated if not provided)' })
  @IsOptional()
  @IsString()
  batchId?: string;

  @ApiProperty({ description: 'Array of messages (max 100 per request)', type: [BulkMessageItemDto] })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => BulkMessageItemDto)
  messages: BulkMessageItemDto[];

  @ApiPropertyOptional({ description: 'Batch processing options' })
  @IsOptional()
  @ValidateNested()
  @Type(() => BulkMessageOptionsDto)
  options?: BulkMessageOptionsDto;
}

export class BulkMessageResponseDto {
  @ApiProperty()
  batchId: string;

  @ApiProperty()
  status: string;

  @ApiProperty()
  totalMessages: number;

  @ApiPropertyOptional()
  estimatedCompletionTime?: string;

  @ApiProperty()
  statusUrl: string;
}
