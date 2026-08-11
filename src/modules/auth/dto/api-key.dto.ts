import { IsString, IsOptional, IsEnum, IsArray, IsDateString, MinLength, MaxLength, Validate } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ApiKeyRole } from '../entities/api-key.entity';
import { IsIpOrCidrConstraint } from './is-ip-or-cidr.validator';

export class CreateApiKeyDto {
  @ApiProperty({
    description: 'Friendly name for the API key',
    example: 'Production Bot',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(100)
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
  @IsArray()
  @IsString({ each: true })
  allowedSessions?: string[];

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
    description: 'First 8 characters of the key (for identification)',
  })
  keyPrefix!: string;

  @ApiProperty({ enum: ApiKeyRole })
  role!: ApiKeyRole;

  @ApiPropertyOptional()
  allowedIps?: string[];

  @ApiPropertyOptional()
  allowedSessions?: string[];

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

export class UpdateApiKeyDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ enum: ApiKeyRole })
  @IsOptional()
  @IsEnum(ApiKeyRole)
  role?: ApiKeyRole;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Validate(IsIpOrCidrConstraint, { each: true })
  allowedIps?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedSessions?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}
