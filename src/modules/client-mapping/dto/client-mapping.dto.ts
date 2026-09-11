import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Expose, Transform, plainToInstance } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  registerDecorator,
  ValidationOptions,
} from 'class-validator';
import { ToStrictBoolean } from '../../../common/utils/strict-boolean';
import { ClientMapping } from '../entities/client-mapping.entity';
import type { ClientMappingKind, ClientMappingStatus } from '../entities/client-mapping.entity';

export const CLIENT_MAPPING_KINDS: ClientMappingKind[] = ['contact', 'group', 'teammate'];
export const CLIENT_MAPPING_STATUSES: ClientMappingStatus[] = ['active', 'inactive'];

/**
 * `Intl.DateTimeFormat` throws for a bogus zone and accepts every real IANA name (including
 * legacy aliases `Intl.supportedValuesOf('timeZone')` omits), so it doubles as the validator
 * without shipping or maintaining a separate zone list.
 */
function IsIanaTimezone(options?: ValidationOptions): PropertyDecorator {
  return (object: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'isIanaTimezone',
      target: object.constructor,
      propertyName: propertyName as string,
      options,
      validator: {
        validate(value: unknown): boolean {
          if (typeof value !== 'string') return false;
          try {
            new Intl.DateTimeFormat('en-US', { timeZone: value });
            return true;
          } catch {
            return false;
          }
        },
        defaultMessage(): string {
          return 'timezone must be a valid IANA time zone name (e.g. "Asia/Jakarta")';
        },
      },
    });
  };
}

const KIND_DESCRIPTION = `What this row identifies: ${CLIENT_MAPPING_KINDS.join(' | ')}.`;

export class CreateClientMappingDto {
  @ApiPropertyOptional({
    description:
      'WhatsApp session this mapping belongs to. Required for kind=contact/group (a JID is only ' +
      'unique within a session); omit for kind=teammate.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  sessionId?: string;

  @ApiProperty({
    description: 'WhatsApp contact/group JID, or an internal teammate identifier for kind=teammate.',
  })
  @IsString()
  @IsNotEmpty()
  jid!: string;

  @ApiProperty({ description: KIND_DESCRIPTION, enum: CLIENT_MAPPING_KINDS })
  @IsIn(CLIENT_MAPPING_KINDS)
  kind!: ClientMappingKind;

  @ApiProperty({ maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional({ description: 'Nullable — groups do not have one.', maxLength: 32 })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string | null;

  @ApiProperty({
    description: 'The organization this mapping belongs to — your own company, or a client/customer name.',
    maxLength: 200,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  company!: string;

  @ApiPropertyOptional({ description: "Department, e.g. 'Performance', 'Design'.", maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  team?: string | null;

  @ApiPropertyOptional({ description: "Job title/function within team, e.g. 'Account Manager'.", maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  role?: string | null;

  @ApiPropertyOptional({ description: 'IANA time zone, e.g. "Asia/Jakarta".' })
  @IsOptional()
  @IsIanaTimezone()
  timezone?: string | null;

  @ApiPropertyOptional({ enum: CLIENT_MAPPING_STATUSES, default: 'active' })
  @IsOptional()
  @IsIn(CLIENT_MAPPING_STATUSES)
  status?: ClientMappingStatus;

  @ApiPropertyOptional({
    description: "Designated backup/secondary contact for this mapping: another mapping row's id.",
  })
  @IsOptional()
  @IsUUID()
  backupOwnerId?: string | null;

  @ApiPropertyOptional({
    description:
      'Per-group opt-out flag reserved for future sentiment/analytics features; not consumed by OpenWA core today.',
    default: true,
  })
  @IsOptional()
  @ToStrictBoolean()
  @IsBoolean()
  sentimentTracking?: boolean;

  @ApiPropertyOptional({ description: 'Free-text context about this contact/group.' })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string | null;
}

export class UpdateClientMappingDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ maxLength: 32 })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string | null;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  company?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  team?: string | null;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  role?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsIanaTimezone()
  timezone?: string | null;

  @ApiPropertyOptional({ enum: CLIENT_MAPPING_STATUSES })
  @IsOptional()
  @IsIn(CLIENT_MAPPING_STATUSES)
  status?: ClientMappingStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  backupOwnerId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @ToStrictBoolean()
  @IsBoolean()
  sentimentTracking?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string | null;
}

/**
 * The one request shape every automatic write path (auto-tag, "Import from Chats") uses instead
 * of each resolving identity and deciding "does this already exist" itself — see docs/32 §5.
 * Deliberately narrower than {@link CreateClientMappingDto} — no timezone/notes/backupOwnerId — an
 * automatic path never knows those; a human fills them in afterward via the normal update endpoint.
 */
export class ResolveAndUpsertClientMappingDto {
  @ApiProperty({ description: 'WhatsApp session this mapping belongs to.' })
  @IsString()
  @IsNotEmpty()
  sessionId!: string;

  @ApiProperty({ description: 'WhatsApp contact/group JID.' })
  @IsString()
  @IsNotEmpty()
  jid!: string;

  @ApiProperty({
    description: 'contact or group — teammate rows have no WhatsApp identity to resolve.',
    enum: ['contact', 'group'],
  })
  @IsIn(['contact', 'group'])
  kind!: 'contact' | 'group';

  @ApiPropertyOptional({ description: 'Display name to use only if this creates a new row.', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  nameHint?: string;

  @ApiPropertyOptional({
    description: 'Phone already known by the caller (e.g. parsed straight off a @c.us jid) — skips resolution.',
    maxLength: 32,
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  phoneHint?: string | null;

  @ApiPropertyOptional({ description: 'Company to use only if this creates a new row. Defaults to "Unknown".' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  company?: string;
}

export class ClientMappingResponseDto {
  @ApiProperty()
  @Expose()
  id!: string;

  @ApiPropertyOptional({ nullable: true })
  @Expose()
  sessionId!: string | null;

  @ApiProperty()
  @Expose()
  jid!: string;

  @ApiProperty({ enum: CLIENT_MAPPING_KINDS })
  @Expose()
  kind!: ClientMappingKind;

  @ApiProperty()
  @Expose()
  name!: string;

  @ApiPropertyOptional({ nullable: true })
  @Expose()
  phone!: string | null;

  @ApiProperty()
  @Expose()
  company!: string;

  @ApiPropertyOptional({ nullable: true })
  @Expose()
  team!: string | null;

  @ApiPropertyOptional({ nullable: true })
  @Expose()
  role!: string | null;

  @ApiPropertyOptional({ nullable: true })
  @Expose()
  timezone!: string | null;

  @ApiProperty({ enum: CLIENT_MAPPING_STATUSES })
  @Expose()
  status!: ClientMappingStatus;

  @ApiPropertyOptional({ nullable: true })
  @Expose()
  backupOwnerId!: string | null;

  @ApiProperty()
  @Expose()
  sentimentTracking!: boolean;

  @ApiPropertyOptional({ nullable: true })
  @Expose()
  notes!: string | null;

  @ApiPropertyOptional({
    type: [String],
    nullable: true,
    description:
      'Every other jid WhatsApp has used for this same real contact (e.g. a @lid seen in a group), matched by phone rather than by jid — see docs/32 §5. Informational — jid stays the address to use.',
  })
  @Expose()
  // Stored as a JSON string on the entity; parsed here so API consumers get a real array instead of
  // reimplementing the same JSON.parse + malformed-input guard client-mapping.service.ts already has.
  @Transform(({ value }: { value: string | null }) => {
    if (!value) return null;
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : null;
    } catch {
      return null;
    }
  })
  aliasJids!: string[] | null;

  @ApiProperty()
  @Expose()
  createdAt!: Date;

  @ApiProperty()
  @Expose()
  updatedAt!: Date;

  static fromEntity(mapping: ClientMapping): ClientMappingResponseDto {
    return plainToInstance(ClientMappingResponseDto, mapping, { excludeExtraneousValues: true });
  }
}

export class ResolveAndUpsertResultDto {
  @ApiProperty({ type: ClientMappingResponseDto })
  @Expose()
  mapping!: ClientMappingResponseDto;

  @ApiProperty({
    description:
      'True if this call created a new row; false if an existing row (by jid or by resolved phone) was returned instead.',
  })
  @Expose()
  created!: boolean;
}
