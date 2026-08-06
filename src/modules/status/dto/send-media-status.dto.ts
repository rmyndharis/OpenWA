import {
  IsString,
  IsOptional,
  ValidateNested,
  IsArray,
  ArrayMaxSize,
  IsDefined,
  IsNotEmpty,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

class StatusMediaInput {
  @ApiPropertyOptional({
    description: 'Public http(s) URL of the media (server-fetched, SSRF-guarded).',
    example: 'https://example.com/banner.jpg',
  })
  @ValidateIf((media: StatusMediaInput) => media.base64 === undefined || media.url !== undefined)
  @IsString()
  @IsNotEmpty()
  url?: string;

  @ApiPropertyOptional({
    description: 'Base64-encoded media. Requires mimetype.',
    example: '/9j/4AAQSkZJRg...',
  })
  @ValidateIf((media: StatusMediaInput) => media.url === undefined || media.base64 !== undefined)
  @IsString()
  @IsNotEmpty()
  base64?: string;

  @ApiPropertyOptional({ description: 'MIME type. Required when sending base64.', example: 'image/jpeg' })
  @IsOptional()
  @IsString()
  mimetype?: string;
}

export class SendImageStatusDto {
  @ApiProperty({ description: 'Image source (URL or base64).', type: StatusMediaInput })
  @IsDefined()
  @ValidateNested()
  @Type(() => StatusMediaInput)
  image!: StatusMediaInput;

  @ApiPropertyOptional({ description: 'Optional caption.', example: 'New drop!', maxLength: 1024 })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  caption?: string;

  @ApiPropertyOptional({
    description:
      'Recipient JIDs (0–256), @c.us or @lid. Required on the Baileys engine (it posts to exactly this ' +
      "allow-list); ignored by whatsapp-web.js, which broadcasts to the account's status-privacy " +
      'audience — omit it there.',
    type: String,
    isArray: true,
    example: ['628123456789@c.us'],
    maxItems: 256,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(256)
  @IsString({ each: true })
  @Matches(/^\d+@(c\.us|lid)$/, { each: true, message: 'Invalid recipient JID' })
  recipients?: string[];
}

export class SendVideoStatusDto {
  @ApiProperty({ description: 'Video source (URL or base64).', type: StatusMediaInput })
  @IsDefined()
  @ValidateNested()
  @Type(() => StatusMediaInput)
  video!: StatusMediaInput;

  @ApiPropertyOptional({ description: 'Optional caption.', example: 'Demo', maxLength: 1024 })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  caption?: string;

  @ApiPropertyOptional({
    description:
      'Recipient JIDs (0–256), @c.us or @lid. Required on the Baileys engine (it posts to exactly this ' +
      "allow-list); ignored by whatsapp-web.js, which broadcasts to the account's status-privacy " +
      'audience — omit it there.',
    type: String,
    isArray: true,
    example: ['628123456789@c.us'],
    maxItems: 256,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(256)
  @IsString({ each: true })
  @Matches(/^\d+@(c\.us|lid)$/, { each: true, message: 'Invalid recipient JID' })
  recipients?: string[];
}

/**
 * A voice status carries no caption: WhatsApp has nowhere to render one on a status voice note.
 */
export class SendVoiceStatusDto {
  @ApiProperty({
    description:
      'Audio source (URL or base64). WhatsApp plays a status voice note only as Ogg/Opus, and neither ' +
      'engine transcodes — use the media conversion endpoint to produce it. The mimetype defaults to ' +
      "'audio/ogg; codecs=opus'.",
    type: StatusMediaInput,
  })
  @IsDefined()
  @ValidateNested()
  @Type(() => StatusMediaInput)
  audio!: StatusMediaInput;

  @ApiPropertyOptional({
    description:
      'Background colour as `#RRGGBB`, which WhatsApp renders behind the voice-note bubble. ' +
      'Baileys only — whatsapp-web.js exposes no styling for a status and ignores it.',
    example: '#25D366',
  })
  @IsOptional()
  @IsString()
  @Matches(/^#[0-9A-Fa-f]{6}$/, { message: 'backgroundColor must be a hex color (e.g., #25D366)' })
  backgroundColor?: string;

  @ApiPropertyOptional({
    description:
      'Recipient JIDs (0–256), @c.us or @lid. Required on the Baileys engine (it posts to exactly this ' +
      "allow-list); ignored by whatsapp-web.js, which broadcasts to the account's status-privacy " +
      'audience — omit it there.',
    type: String,
    isArray: true,
    example: ['628123456789@c.us'],
    maxItems: 256,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(256)
  @IsString({ each: true })
  @Matches(/^\d+@(c\.us|lid)$/, { each: true, message: 'Invalid recipient JID' })
  recipients?: string[];
}
