import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsLatitude, IsLongitude, IsBoolean } from 'class-validator';

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

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  address?: string;
}

export class SendContactDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  chatId: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  contactName: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
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

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
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
  @ApiProperty({ description: 'Emoji to react with. Send an empty string to remove the reaction.' })
  @IsString()
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
