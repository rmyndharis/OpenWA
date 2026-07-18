import {
  IsString,
  IsOptional,
  ValidateNested,
  IsArray,
  ArrayMinSize,
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
  image: StatusMediaInput;

  @ApiPropertyOptional({ description: 'Optional caption.', example: 'New drop!', maxLength: 1024 })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  caption?: string;

  @ApiProperty({
    description:
      'Recipient JIDs (1–256), @c.us or @lid. Honored on the Baileys engine only: whatsapp-web.js ignores ' +
      "this allow-list and broadcasts to the account's status-privacy audience.",
    type: String,
    isArray: true,
    example: ['628123456789@c.us'],
    minItems: 1,
    maxItems: 256,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(256)
  @IsString({ each: true })
  @Matches(/^\d+@(c\.us|lid)$/, { each: true, message: 'Invalid recipient JID' })
  recipients: string[];
}

export class SendVideoStatusDto {
  @ApiProperty({ description: 'Video source (URL or base64).', type: StatusMediaInput })
  @IsDefined()
  @ValidateNested()
  @Type(() => StatusMediaInput)
  video: StatusMediaInput;

  @ApiPropertyOptional({ description: 'Optional caption.', example: 'Demo', maxLength: 1024 })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  caption?: string;

  @ApiProperty({
    description:
      'Recipient JIDs (1–256), @c.us or @lid. Honored on the Baileys engine only: whatsapp-web.js ignores ' +
      "this allow-list and broadcasts to the account's status-privacy audience.",
    type: String,
    isArray: true,
    example: ['628123456789@c.us'],
    minItems: 1,
    maxItems: 256,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(256)
  @IsString({ each: true })
  @Matches(/^\d+@(c\.us|lid)$/, { each: true, message: 'Invalid recipient JID' })
  recipients: string[];
}
