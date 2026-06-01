import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  MaxLength,
  IsUrl,
  ValidateIf,
  IsNumber,
  Min,
  Max,
  IsBoolean,
} from 'class-validator';

export class SendTextMessageDto {
  @ApiProperty({
    description: 'WhatsApp chat ID (phone@c.us for individual, groupId@g.us for groups)',
    example: '628123456789@c.us',
  })
  @IsString()
  @IsNotEmpty()
  chatId: string;

  @ApiProperty({
    description: 'Text message content',
    example: 'Hello from OpenWA!',
    maxLength: 4096,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  text: string;
}

export class SendMediaMessageDto {
  @ApiProperty({
    description: 'WhatsApp chat ID',
    example: '628123456789@c.us',
  })
  @IsString()
  @IsNotEmpty()
  chatId: string;

  @ApiPropertyOptional({
    description: 'Media URL (http/https)',
    example: 'https://example.com/image.jpg',
  })
  @IsOptional()
  @IsUrl()
  @ValidateIf((o: SendMediaMessageDto) => !o.base64)
  url?: string;

  @ApiPropertyOptional({
    description: 'Base64 encoded media data',
  })
  @IsOptional()
  @IsString()
  @ValidateIf((o: SendMediaMessageDto) => !o.url)
  base64?: string;

  @ApiPropertyOptional({
    description: 'Media MIME type (required when using base64)',
    example: 'image/jpeg',
  })
  @IsOptional()
  @IsString()
  mimetype?: string;

  @ApiPropertyOptional({
    description: 'Filename for the media',
    example: 'image.jpg',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  filename?: string;

  @ApiPropertyOptional({
    description: 'Caption for the media',
    example: 'Check out this image!',
    maxLength: 1024,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  caption?: string;
}

export class MessageResponseDto {
  @ApiProperty({ example: 'true_628123456789@c.us_3EB0123456789' })
  messageId: string;

  @ApiProperty({ example: 1706868000 })
  timestamp: number;
}

export class SendLocationMessageDto {
  @ApiProperty({ description: 'WhatsApp chat ID', example: '628123456789@c.us' })
  @IsString()
  @IsNotEmpty()
  chatId: string;

  @ApiProperty({ description: 'Latitude', example: -6.2, minimum: -90, maximum: 90 })
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude: number;

  @ApiProperty({ description: 'Longitude', example: 106.816666, minimum: -180, maximum: 180 })
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude: number;

  @ApiPropertyOptional({ description: 'Location description', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;

  @ApiPropertyOptional({ description: 'Location address', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;
}

export class SendContactMessageDto {
  @ApiProperty({ description: 'WhatsApp chat ID', example: '628123456789@c.us' })
  @IsString()
  @IsNotEmpty()
  chatId: string;

  @ApiProperty({ description: 'Contact display name', example: 'Support' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  contactName: string;

  @ApiProperty({ description: 'Contact phone number', example: '628123456789' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  contactNumber: string;
}

export class ReplyMessageDto {
  @ApiProperty({ description: 'WhatsApp chat ID', example: '628123456789@c.us' })
  @IsString()
  @IsNotEmpty()
  chatId: string;

  @ApiProperty({ description: 'Quoted WhatsApp message ID' })
  @IsString()
  @IsNotEmpty()
  quotedMessageId: string;

  @ApiProperty({ description: 'Reply text', maxLength: 4096 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  text: string;
}

export class ForwardMessageDto {
  @ApiProperty({ description: 'Source chat ID' })
  @IsString()
  @IsNotEmpty()
  fromChatId: string;

  @ApiProperty({ description: 'Destination chat ID' })
  @IsString()
  @IsNotEmpty()
  toChatId: string;

  @ApiProperty({ description: 'WhatsApp message ID to forward' })
  @IsString()
  @IsNotEmpty()
  messageId: string;
}

export class ReactMessageDto {
  @ApiProperty({ description: 'WhatsApp chat ID' })
  @IsString()
  @IsNotEmpty()
  chatId: string;

  @ApiProperty({ description: 'WhatsApp message ID' })
  @IsString()
  @IsNotEmpty()
  messageId: string;

  @ApiProperty({ description: 'Reaction emoji. Send an empty string to remove the reaction.' })
  @IsString()
  emoji: string;
}

export class DeleteMessageDto {
  @ApiProperty({ description: 'WhatsApp chat ID' })
  @IsString()
  @IsNotEmpty()
  chatId: string;

  @ApiProperty({ description: 'WhatsApp message ID' })
  @IsString()
  @IsNotEmpty()
  messageId: string;

  @ApiPropertyOptional({ description: 'Delete for everyone when supported', default: true })
  @IsOptional()
  @IsBoolean()
  forEveryone?: boolean;
}
