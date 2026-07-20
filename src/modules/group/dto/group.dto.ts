import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  ArrayNotEmpty,
  IsString,
  IsNotEmpty,
  MaxLength,
  IsBoolean,
  IsInt,
  Min,
  ValidateIf,
} from 'class-validator';

export class CreateGroupDto {
  @ApiProperty({ description: 'Group subject/name', maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiProperty({ description: 'Participant WhatsApp IDs (e.g. 628123456789@c.us)', type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  participants: string[];
}

export class ParticipantsDto {
  @ApiProperty({ description: 'Participant WhatsApp IDs (e.g. 628123456789@c.us)', type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  participants: string[];
}

export class GroupSubjectDto {
  @ApiProperty({ description: 'New group subject/name', maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  subject: string;
}

export class GroupDescriptionDto {
  @ApiProperty({ description: 'New group description (may be empty to clear it)', maxLength: 1024 })
  @IsString()
  @MaxLength(1024)
  description: string;
}

export class JoinGroupDto {
  @ApiProperty({
    description: 'Group invite code (the token from a https://chat.whatsapp.com/<code> link)',
    maxLength: 128,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  inviteCode: string;
}

/**
 * All fields optional, but at least one must be present — enforced in GroupService.updateGroupSettings
 * (a class-validator "at least one of" idiom does not exist; an empty body is a client error, 400).
 * ValidateIf (not @IsOptional) so an explicit `null` fails validation (400) instead of being applied
 * as a value; only `undefined` (absent) skips the field.
 */
export class GroupSettingsDto {
  @ApiPropertyOptional({ description: 'Only admins can send messages (announce group)' })
  @ValidateIf((o: GroupSettingsDto) => o.announce !== undefined)
  @IsBoolean()
  announce?: boolean;

  @ApiPropertyOptional({ description: 'Only admins can edit group info (locked group)' })
  @ValidateIf((o: GroupSettingsDto) => o.locked !== undefined)
  @IsBoolean()
  locked?: boolean;

  @ApiPropertyOptional({
    description:
      'Disappearing-messages timer in seconds; 0 disables. Known values: 86400 (24h), 604800 (7d), 7776000 (90d)',
    minimum: 0,
  })
  @ValidateIf((o: GroupSettingsDto) => o.ephemeralSeconds !== undefined)
  @IsInt()
  @Min(0)
  ephemeralSeconds?: number;
}
