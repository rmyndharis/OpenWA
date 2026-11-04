import {
  IsString,
  IsOptional,
  IsEnum,
  IsArray,
  ArrayMaxSize,
  ArrayUnique,
  IsDateString,
  MinLength,
  Validate,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ToStrictArray, ToStrictString } from '../../../common/utils/strict-boolean';
import { MaxCodePoints } from '../../../common/validation/max-code-points';
import { ApiKeyRole } from '../entities/api-key.entity';
import { IsIpOrCidrConstraint } from './is-ip-or-cidr.validator';
import { IsSessionIdConstraint } from './is-session-id.validator';
import { IsChatIdConstraint } from './is-chat-id.validator';

/**
 * The most chats one key may be restricted to. A chat-restricted WebSocket holds a room per allowed id, two
 * address forms per phone, within the 4096 a socket may hold; past this bound a key subscribed to every event
 * could not subscribe at all. Search binds one SQL parameter per expanded id and reaches its own limit far
 * later, so it does not set this bound.
 */
export const ALLOWED_CHATS_MAX = 2000;

export class CreateApiKeyDto {
  @ApiProperty({
    description: 'Friendly name for the API key',
    example: 'Production Bot',
    minLength: 3,
    maxLength: 100,
  })
  @ToStrictString()
  @IsString()
  @MinLength(3)
  @MaxCodePoints(100)
  name!: string;

  @ApiPropertyOptional({
    description: 'Role/permission level',
    enum: ApiKeyRole,
    default: ApiKeyRole.OPERATOR,
  })
  @IsOptional()
  @IsEnum(ApiKeyRole)
  role?: ApiKeyRole;

  @ApiPropertyOptional({
    description: 'Allowed IP addresses (whitelist)',
    example: ['192.168.1.1', '10.0.0.0/8'],
  })
  @IsOptional()
  @ToStrictArray()
  @IsArray()
  @IsString({ each: true })
  @Validate(IsIpOrCidrConstraint, { each: true })
  allowedIps?: string[];

  @ApiPropertyOptional({
    description:
      'Session **ids** this key may act on — the server-generated UUIDs, not session names. Matched by ' +
      'exact equality against the id in the request path, so a name never matches and would silently ' +
      'scope the key to nothing. Omit or leave empty to let the key reach every session.',
    example: ['0a941dac-a965-45e7-b318-74ae8be134f0', '8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a'],
  })
  @IsOptional()
  @ToStrictArray()
  @IsArray()
  @IsString({ each: true })
  @ArrayUnique()
  @Validate(IsSessionIdConstraint, { each: true })
  allowedSessions?: string[];

  @ApiPropertyOptional({
    description:
      'Chat ids this key may read and send to — a curated allowlist independent of `allowedSessions`. ' +
      'Entries are a group `<id>@g.us`, a contact `<phone>@c.us` / `<lid>@lid`, or a bare phone number. ' +
      'A contact entry also matches its resolved `@lid` form (and vice versa) through the lid mapping ' +
      'table. Omit or leave empty to let the key reach every chat.',
    example: ['120363000000000000@g.us', '919999999999@c.us'],
    // @ArrayMaxSize is runtime-only; without this the schema, and every client generated from it,
    // advertises an unbounded list and learns the limit from a 400.
    maxItems: ALLOWED_CHATS_MAX,
  })
  @IsOptional()
  @ToStrictArray()
  @IsArray()
  @ArrayMaxSize(ALLOWED_CHATS_MAX)
  @IsString({ each: true })
  @ArrayUnique()
  @Validate(IsChatIdConstraint, { each: true })
  allowedChats?: string[];

  @ApiPropertyOptional({
    description: 'Expiration date (ISO 8601)',
    example: '2027-12-31T23:59:59Z',
  })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}

export class ApiKeyResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({
    description: 'First 12 characters of the key (for identification)',
  })
  keyPrefix!: string;

  @ApiProperty({ enum: ApiKeyRole })
  role!: ApiKeyRole;

  @ApiPropertyOptional()
  allowedIps?: string[];

  @ApiPropertyOptional()
  allowedSessions?: string[];

  @ApiPropertyOptional()
  allowedChats?: string[];

  @ApiProperty()
  isActive!: boolean;

  @ApiPropertyOptional()
  expiresAt?: Date;

  @ApiPropertyOptional()
  lastUsedAt?: Date;

  @ApiProperty()
  usageCount!: number;

  @ApiProperty()
  createdAt!: Date;
}

export class ApiKeyCreatedResponseDto extends ApiKeyResponseDto {
  @ApiProperty({
    description: 'Full API key (only shown once at creation)',
    example: 'owa_k1_abc123...',
  })
  apiKey!: string;
}

/** Result of `POST /auth/validate` — the guard's verdict on the presented key. */
export class ValidateApiKeyResponseDto {
  @ApiProperty({ description: 'Whether the presented API key is valid.', example: true })
  valid!: boolean;

  @ApiPropertyOptional({ enum: ApiKeyRole, description: "The key's role; present only when valid." })
  role?: ApiKeyRole;

  @ApiPropertyOptional({
    description: 'Engine the process resolved at boot; present only when valid.',
    example: 'baileys',
  })
  engineType?: string;

  @ApiPropertyOptional({
    description: 'Whether the key is restricted to selected sessions; present only when valid.',
    example: false,
  })
  scoped?: boolean;
}

export class UpdateApiKeyDto {
  @ApiPropertyOptional({ minLength: 3, maxLength: 100 })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @MinLength(3)
  @MaxCodePoints(100)
  name?: string;

  @ApiPropertyOptional({ enum: ApiKeyRole })
  @IsOptional()
  @IsEnum(ApiKeyRole)
  role?: ApiKeyRole;

  @ApiPropertyOptional()
  @IsOptional()
  @ToStrictArray()
  @IsArray()
  @IsString({ each: true })
  @Validate(IsIpOrCidrConstraint, { each: true })
  allowedIps?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @ToStrictArray()
  @IsArray()
  @IsString({ each: true })
  @ArrayUnique()
  @Validate(IsSessionIdConstraint, { each: true })
  allowedSessions?: string[];

  @ApiPropertyOptional({ maxItems: ALLOWED_CHATS_MAX })
  @IsOptional()
  @ToStrictArray()
  @IsArray()
  @ArrayMaxSize(ALLOWED_CHATS_MAX)
  @IsString({ each: true })
  @ArrayUnique()
  @Validate(IsChatIdConstraint, { each: true })
  allowedChats?: string[];

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Expiration date (ISO 8601); null clears it (an empty string is rejected)',
  })
  @IsOptional()
  @IsDateString()
  expiresAt?: string | null;
}
