import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  MaxLength,
  IsUrl,
  ValidateIf,
  IsArray,
  ArrayMaxSize,
  IsBoolean,
} from 'class-validator';

const MENTIONS_DESCRIPTION =
  'WIDs to @mention (e.g. ["62811@c.us"]). The text/caption must also contain the @<number> token.';

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

  @ApiPropertyOptional({ description: MENTIONS_DESCRIPTION, example: ['628123456789@c.us'], type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1024)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  mentions?: string[];
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

  @ApiPropertyOptional({ description: MENTIONS_DESCRIPTION, example: ['628123456789@c.us'], type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1024)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  mentions?: string[];
}

export class SendAudioMessageDto extends SendMediaMessageDto {
  @ApiPropertyOptional({
    description:
      'Send as a WhatsApp voice note (PTT — mic bubble + waveform). Provide audio/ogg; codecs=opus ' +
      'bytes for reliable playback; when the mimetype is omitted it defaults to that for voice notes. ' +
      'Expects a JSON boolean. Default false = plain audio file. Only valid on send-audio.',
  })
  @IsOptional()
  @IsBoolean()
  ptt?: boolean;
}

export class MessageResponseDto {
  @ApiProperty({ example: 'true_628123456789@c.us_3EB0123456789' })
  messageId: string;

  @ApiProperty({ example: 1706868000 })
  timestamp: number;
}
