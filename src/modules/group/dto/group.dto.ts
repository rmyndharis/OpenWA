import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  ArrayNotEmpty,
  ArrayMaxSize,
  IsString,
  IsNotEmpty,
  MaxLength,
  IsBoolean,
  IsIn,
  IsInt,
  Min,
  IsOptional,
  IsUrl,
  Matches,
  ValidateIf,
} from 'class-validator';
import { ToStrictBoolean, ToStrictNumber } from '../../../common/utils/strict-boolean';
import type { GroupMemberAddMode } from '../../../engine/interfaces/whatsapp-engine.interface';

// Field caps shared with the agent-tool input schemas (src/core/agent-tools/tools/group.tools.ts)
// so MCP and REST enforce the same limits on the equivalent operations.
export const GROUP_NAME_MAX_LENGTH = 100;
export const GROUP_DESCRIPTION_MAX_LENGTH = 1024;

/**
 * Max participants accepted in one group-create or participant-batch request. The engine works the
 * list sequentially (one WhatsApp round-trip per participant, with an honest per-participant
 * result), so an unbounded array turns a single HTTP call into minutes of serial engine work.
 * 256 stays well inside WhatsApp's own group-size limit while keeping one request's work bounded;
 * larger imports batch across requests.
 */
export const GROUP_PARTICIPANTS_MAX = 256;

export class CreateGroupDto {
  @ApiProperty({ description: 'Group subject/name', maxLength: GROUP_NAME_MAX_LENGTH })
  @IsString()
  @IsNotEmpty()
  @MaxLength(GROUP_NAME_MAX_LENGTH)
  name!: string;

  @ApiProperty({
    description: 'Participant WhatsApp IDs (e.g. 628123456789@c.us)',
    type: [String],
    maxItems: GROUP_PARTICIPANTS_MAX,
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(GROUP_PARTICIPANTS_MAX)
  @IsString({ each: true })
  participants!: string[];
}

export class ParticipantsDto {
  @ApiProperty({
    description: 'Participant WhatsApp IDs (e.g. 628123456789@c.us)',
    type: [String],
    maxItems: GROUP_PARTICIPANTS_MAX,
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(GROUP_PARTICIPANTS_MAX)
  @IsString({ each: true })
  participants!: string[];
}

export class GroupSubjectDto {
  @ApiProperty({ description: 'New group subject/name', maxLength: GROUP_NAME_MAX_LENGTH })
  @IsString()
  @IsNotEmpty()
  @MaxLength(GROUP_NAME_MAX_LENGTH)
  subject!: string;
}

export class GroupDescriptionDto {
  @ApiProperty({
    description: 'New group description (may be empty to clear it)',
    maxLength: GROUP_DESCRIPTION_MAX_LENGTH,
  })
  @IsString()
  @MaxLength(GROUP_DESCRIPTION_MAX_LENGTH)
  description!: string;
}

export class JoinGroupDto {
  @ApiProperty({
    description: 'Group invite code (the token from a https://chat.whatsapp.com/<code> link)',
    maxLength: 128,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  inviteCode!: string;
}

/**
 * All fields optional, but at least one must be present — enforced in GroupService.updateGroupSettings
 * (a class-validator "at least one of" idiom does not exist; an empty body is a client error, 400).
 * ValidateIf (not @IsOptional) so an explicit `null` fails validation (400) instead of being applied
 * as a value; only `undefined` (absent) skips the field.
 */
/**
 * Group picture payload. Mirrors SetProfilePictureDto: provide exactly one of `url` or `base64`
 * (base64 wins when both are present), and a `mimetype` when using base64.
 */
export class SetGroupPictureDto {
  @ApiPropertyOptional({ description: 'Image URL (http/https)', example: 'https://example.com/group.jpg' })
  @IsOptional()
  @IsUrl()
  @ValidateIf((o: SetGroupPictureDto) => !o.base64)
  url?: string;

  @ApiPropertyOptional({ description: 'Base64 encoded image data' })
  @IsOptional()
  @IsString()
  @ValidateIf((o: SetGroupPictureDto) => !o.url)
  base64?: string;

  @ApiPropertyOptional({ description: 'Image MIME type (required when using base64)', example: 'image/jpeg' })
  @IsOptional()
  @IsString()
  // A group picture is an image by definition — reject non-image mimetypes fast (400) rather than
  // letting the engine accept an arbitrary payload.
  @Matches(/^image\//)
  mimetype?: string;
}

export class GroupSettingsDto {
  @ApiPropertyOptional({ description: 'Only admins can send messages (announce group)' })
  @ToStrictBoolean()
  @ValidateIf((o: GroupSettingsDto) => o.announce !== undefined)
  @IsBoolean()
  announce?: boolean;

  @ApiPropertyOptional({ description: 'Only admins can edit group info (locked group)' })
  @ToStrictBoolean()
  @ValidateIf((o: GroupSettingsDto) => o.locked !== undefined)
  @IsBoolean()
  locked?: boolean;

  @ApiPropertyOptional({
    description:
      'Disappearing-messages timer in seconds; 0 disables. Known values: 86400 (24h), 604800 (7d), 7776000 (90d)',
    minimum: 0,
  })
  @ToStrictNumber()
  @ValidateIf((o: GroupSettingsDto) => o.ephemeralSeconds !== undefined)
  @IsInt()
  @Min(0)
  ephemeralSeconds?: number;

  @ApiPropertyOptional({
    description: "Who may add participants: 'all' (any member) or 'admins' (admins only)",
    enum: ['all', 'admins'],
  })
  @ValidateIf((o: GroupSettingsDto) => o.memberAddMode !== undefined)
  @IsIn(['all', 'admins'])
  memberAddMode?: GroupMemberAddMode;
}
