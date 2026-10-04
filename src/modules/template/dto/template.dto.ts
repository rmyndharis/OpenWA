import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, MaxLength, ValidateIf, IsIn } from 'class-validator';
import { MaxCodePoints } from '../../../common/validation/max-code-points';
import { NoNulCharacter } from '../../../common/validation/no-nul-character';

const NAME_MAX_LENGTH = 100;
const BODY_MAX_LENGTH = 4096;
const HEADER_FOOTER_MAX_LENGTH = 1024;
const MEDIA_URL_MAX_LENGTH = 4096;
export const TEMPLATE_TYPES = ['text', 'image'] as const;

export class CreateTemplateDto {
  @ApiProperty({
    description: 'Unique template name within the session',
    example: 'order-confirmation',
    maxLength: NAME_MAX_LENGTH,
  })
  @IsString()
  @IsNotEmpty()
  @MaxCodePoints(NAME_MAX_LENGTH)
  @NoNulCharacter()
  name!: string;

  @ApiProperty({
    description: 'Template body with {{variable}} placeholders',
    example: 'Hi {{customer}}, your order {{orderId}} has shipped.',
    maxLength: BODY_MAX_LENGTH,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(BODY_MAX_LENGTH)
  @NoNulCharacter()
  body!: string;

  @ApiPropertyOptional({
    description: 'Optional header text, prepended to the rendered body',
    example: 'OpenWA Store',
    maxLength: HEADER_FOOTER_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxLength(HEADER_FOOTER_MAX_LENGTH)
  @NoNulCharacter()
  header?: string;

  @ApiPropertyOptional({
    description: 'Optional footer text, appended to the rendered body',
    example: 'Reply STOP to unsubscribe.',
    maxLength: HEADER_FOOTER_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxLength(HEADER_FOOTER_MAX_LENGTH)
  @NoNulCharacter()
  footer?: string;

  @ApiPropertyOptional({ description: 'Template message type', enum: TEMPLATE_TYPES, default: 'text' })
  @IsOptional()
  @IsString()
  @IsIn(TEMPLATE_TYPES)
  type?: 'text' | 'image';

  @ApiPropertyOptional({
    description: 'Image URL for image templates. Supports {{variable}} placeholders.',
    example: '{{imageUrl}}',
    maxLength: MEDIA_URL_MAX_LENGTH,
  })
  @ValidateIf((o: CreateTemplateDto) => o.type === 'image' || o.mediaUrl !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(MEDIA_URL_MAX_LENGTH)
  @NoNulCharacter()
  mediaUrl?: string;
}

export class UpdateTemplateDto {
  @ApiPropertyOptional({ description: 'Template name', maxLength: NAME_MAX_LENGTH })
  // Not @IsOptional: that also skips null, which then reaches the NOT NULL column as a 500.
  @ValidateIf((o: UpdateTemplateDto) => o.name !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxCodePoints(NAME_MAX_LENGTH)
  @NoNulCharacter()
  name?: string;

  @ApiPropertyOptional({ description: 'Template body with {{variable}} placeholders', maxLength: BODY_MAX_LENGTH })
  @ValidateIf((o: UpdateTemplateDto) => o.body !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(BODY_MAX_LENGTH)
  @NoNulCharacter()
  body?: string;

  @ApiPropertyOptional({
    type: String,
    description: 'Optional header text',
    maxLength: HEADER_FOOTER_MAX_LENGTH,
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(HEADER_FOOTER_MAX_LENGTH)
  @NoNulCharacter()
  header?: string | null;

  @ApiPropertyOptional({
    type: String,
    description: 'Optional footer text',
    maxLength: HEADER_FOOTER_MAX_LENGTH,
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(HEADER_FOOTER_MAX_LENGTH)
  @NoNulCharacter()
  footer?: string | null;

  @ApiPropertyOptional({ description: 'Template message type', enum: TEMPLATE_TYPES })
  @ValidateIf((o: UpdateTemplateDto) => o.type !== undefined)
  @IsString()
  @IsIn(TEMPLATE_TYPES)
  type?: 'text' | 'image';

  @ApiPropertyOptional({
    type: String,
    description: 'Image URL for image templates. Supports {{variable}} placeholders.',
    maxLength: MEDIA_URL_MAX_LENGTH,
    nullable: true,
  })
  @ValidateIf((o: UpdateTemplateDto) => o.mediaUrl !== undefined && o.mediaUrl !== null)
  @IsString()
  @IsNotEmpty()
  @MaxLength(MEDIA_URL_MAX_LENGTH)
  @NoNulCharacter()
  mediaUrl?: string | null;
}

export class TemplateResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  sessionId!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  body!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  header?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  footer?: string | null;

  @ApiProperty({ enum: TEMPLATE_TYPES })
  type!: 'text' | 'image';

  @ApiPropertyOptional({ type: String, nullable: true })
  mediaUrl?: string | null;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}
