import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsLatitude,
  IsLongitude,
  IsBoolean,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  MaxLength,
} from 'class-validator';

/**
 * Validated DTOs for the message action endpoints. These replaced inline
 * `@Body()` object-literal types, which erase at runtime so the global ValidationPipe had
 * no metadata to validate or whitelist against.
 */

export class SendLocationDto {
  @ApiProperty({ description: 'Chat ID (e.g. 628123456789@c.us)' })
  @IsString()
  @IsNotEmpty()
  chatId: string;

  @ApiProperty({ example: -6.2088 })
  @IsLatitude()
  latitude: number;

  @ApiProperty({ example: 106.8456 })
  @IsLongitude()
  longitude: number;

  @ApiPropertyOptional({ maxLength: 1024 })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  description?: string;

  @ApiPropertyOptional({ maxLength: 1024 })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  address?: string;
}

export class SendContactDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  chatId: string;

  @ApiProperty({ maxLength: 255 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  contactName: string;

  @ApiProperty({ maxLength: 30 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  contactNumber: string;
}

export class SendPollDto {
  @ApiProperty({ description: 'Chat ID (e.g. 628123456789@c.us or 1203630000@g.us)' })
  @IsString()
  @IsNotEmpty()
  chatId: string;

  @ApiProperty({ description: 'Poll question / title', maxLength: 255, example: 'Where should we meet?' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  // WhatsApp itself caps polls at 12 options and ~100 chars per option; validating here keeps the
  // failure a clean 400 instead of an engine error deep in the send path.
  @ApiProperty({
    description: 'Options to vote on (WhatsApp allows between 2 and 12)',
    type: [String],
    example: ['Park', 'Beach', 'Downtown'],
  })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(100, { each: true })
  options: string[];

  @ApiPropertyOptional({ description: 'Allow voters to pick several options (default single choice)' })
  @IsOptional()
  @IsBoolean()
  allowMultipleAnswers?: boolean;
}

export class ReplyMessageDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  chatId: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  quotedMessageId: string;

  @ApiProperty({ maxLength: 4096 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  text: string;
}

export class ForwardMessageDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  fromChatId: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  toChatId: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  messageId: string;
}

export class ReactMessageDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  chatId: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  messageId: string;

  // Empty string is VALID — it removes the reaction (endpoint contract). So @IsString, not @IsNotEmpty.
  @ApiProperty({ description: 'Emoji to react with. Send an empty string to remove the reaction.', maxLength: 32 })
  @IsString()
  @MaxLength(32)
  emoji: string;
}

export class DeleteMessageDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  chatId: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  messageId: string;

  @ApiPropertyOptional({ description: 'Delete for everyone (default true)' })
  @IsOptional()
  @IsBoolean()
  forEveryone?: boolean;
}
