import {
  IsString,
  IsOptional,
  ValidateNested,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  Matches,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

class StatusMediaInput {
  @ApiPropertyOptional({
    description: 'Public http(s) URL of the media (server-fetched, SSRF-guarded).',
    example: 'https://example.com/banner.jpg',
  })
  @IsOptional()
  @IsString()
  url?: string;

  @ApiPropertyOptional({
    description: 'Base64-encoded media. Requires mimetype.',
    example: 'data:image/jpeg;base64,...',
  })
  @IsOptional()
  @IsString()
  base64?: string;

  @ApiPropertyOptional({ description: 'MIME type. Required when sending base64.', example: 'image/jpeg' })
  @IsOptional()
  @IsString()
  mimetype?: string;
}

export class SendImageStatusDto {
  @ApiProperty({ description: 'Image source (URL or base64).', type: StatusMediaInput })
  @ValidateNested()
  @Type(() => StatusMediaInput)
  image: StatusMediaInput;

  @ApiPropertyOptional({ description: 'Optional caption.', example: 'New drop!', maxLength: 1024 })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  caption?: string;

  @ApiProperty({
    description: 'Recipient JIDs (1–256), @c.us or @lid.',
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
  @ValidateNested()
  @Type(() => StatusMediaInput)
  video: StatusMediaInput;

  @ApiPropertyOptional({ description: 'Optional caption.', example: 'Demo', maxLength: 1024 })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  caption?: string;

  @ApiProperty({
    description: 'Recipient JIDs (1–256), @c.us or @lid.',
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
