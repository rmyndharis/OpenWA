import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, MaxLength, IsOptional, IsUrl, Matches, ValidateIf } from 'class-validator';

export class SetProfileNameDto {
  @ApiProperty({ description: 'New display name (WhatsApp limit: 25 characters)', maxLength: 25 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(25)
  name: string;
}

export class SetProfileStatusDto {
  @ApiProperty({
    description: 'New about/status text (may be empty to clear it; WhatsApp limit: 139 characters)',
    maxLength: 139,
  })
  @IsString()
  @MaxLength(139)
  status: string;
}

/**
 * Media arrives as JSON — a public URL (server-fetched, SSRF-guarded) or inline base64 — the same
 * acceptance pattern as the message module's media endpoints (SendMediaMessageDto).
 */
export class SetProfilePictureDto {
  @ApiPropertyOptional({
    description: 'Image URL (http/https)',
    example: 'https://example.com/avatar.jpg',
  })
  @IsOptional()
  @IsUrl()
  @ValidateIf((o: SetProfilePictureDto) => !o.base64)
  url?: string;

  @ApiPropertyOptional({
    description: 'Base64 encoded image data',
  })
  @IsOptional()
  @IsString()
  @ValidateIf((o: SetProfilePictureDto) => !o.url)
  base64?: string;

  @ApiPropertyOptional({
    description: 'Image MIME type (required when using base64)',
    example: 'image/jpeg',
  })
  @IsOptional()
  @IsString()
  // A profile picture is an image by definition — fail non-image mimetypes fast (400) instead of
  // letting the engine reject (or worse, accept) an arbitrary payload.
  @Matches(/^image\//)
  mimetype?: string;
}
