import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsLatitude, IsLongitude, IsBoolean, MaxLength } from 'class-validator';

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
