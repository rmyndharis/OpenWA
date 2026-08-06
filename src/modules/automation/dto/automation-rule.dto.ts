import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Expose, plainToInstance } from 'class-transformer';
import { IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ToStrictBoolean, ToStrictNumber } from '../../../common/utils/strict-boolean';
import { MESSAGE_TEXT_MAX_LENGTH } from '../../message/dto/send-message.dto';
import { WebhookFilters } from '../../webhook/filters/filter-types';
import { IsValidWebhookFilters } from '../../webhook/filters/filter-validation';
import { AutomationRule } from '../entities/automation-rule.entity';

/** Longest quiet period a rule may ask for: one day. */
export const AUTOMATION_COOLDOWN_MAX_SECONDS = 86_400;

const CONDITIONS_DESCRIPTION =
  'Match conditions in the webhook filter format (message family: sender, recipient, body, type, ' +
  'isGroup, fromMe, hasMedia, mentions). All conditions must match (AND). Omitted or empty means ' +
  'the rule matches every inbound message.';

const COOLDOWN_DESCRIPTION =
  'Quiet period per chat, in seconds: after the rule replies in a chat it stays silent there for ' +
  'this long (default 60, 0 disables). This is the guard against two auto-repliers answering each ' +
  'other forever, so disable it knowingly.';

export class CreateAutomationRuleDto {
  @ApiProperty({ description: 'Display name for the rule', example: 'Greet new enquiries', maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @ApiProperty({
    description: 'Text sent back into the chat when the rule matches',
    example: 'Thanks for reaching out — we reply within the hour.',
    maxLength: MESSAGE_TEXT_MAX_LENGTH,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(MESSAGE_TEXT_MAX_LENGTH)
  replyText!: string;

  @ApiPropertyOptional({ description: CONDITIONS_DESCRIPTION })
  @IsOptional()
  @IsValidWebhookFilters()
  conditions?: WebhookFilters | null;

  @ApiPropertyOptional({
    description: COOLDOWN_DESCRIPTION,
    default: 60,
    minimum: 0,
    maximum: AUTOMATION_COOLDOWN_MAX_SECONDS,
  })
  @IsOptional()
  @ToStrictNumber()
  @IsInt()
  @Min(0)
  @Max(AUTOMATION_COOLDOWN_MAX_SECONDS)
  cooldownSeconds?: number;

  @ApiPropertyOptional({ description: 'Whether the rule is active', default: true })
  @IsOptional()
  @ToStrictBoolean()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateAutomationRuleDto {
  @ApiPropertyOptional({ description: 'Display name for the rule', maxLength: 100 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({
    description: 'Text sent back into the chat when the rule matches',
    maxLength: MESSAGE_TEXT_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MESSAGE_TEXT_MAX_LENGTH)
  replyText?: string;

  @ApiPropertyOptional({ description: CONDITIONS_DESCRIPTION })
  @IsOptional()
  @IsValidWebhookFilters()
  conditions?: WebhookFilters | null;

  @ApiPropertyOptional({ description: COOLDOWN_DESCRIPTION, minimum: 0, maximum: AUTOMATION_COOLDOWN_MAX_SECONDS })
  @IsOptional()
  @ToStrictNumber()
  @IsInt()
  @Min(0)
  @Max(AUTOMATION_COOLDOWN_MAX_SECONDS)
  cooldownSeconds?: number;

  @ApiPropertyOptional({ description: 'Whether the rule is active' })
  @IsOptional()
  @ToStrictBoolean()
  @IsBoolean()
  enabled?: boolean;
}

export class AutomationRuleResponseDto {
  @ApiProperty()
  @Expose()
  id!: string;

  @ApiProperty()
  @Expose()
  sessionId!: string;

  @ApiProperty()
  @Expose()
  name!: string;

  @ApiProperty()
  @Expose()
  enabled!: boolean;

  @ApiPropertyOptional({ description: CONDITIONS_DESCRIPTION, nullable: true })
  @Expose()
  conditions!: WebhookFilters | null;

  @ApiProperty()
  @Expose()
  replyText!: string;

  @ApiProperty()
  @Expose()
  cooldownSeconds!: number;

  @ApiProperty()
  @Expose()
  createdAt!: Date;

  @ApiProperty()
  @Expose()
  updatedAt!: Date;

  static fromEntity(rule: AutomationRule): AutomationRuleResponseDto {
    return plainToInstance(AutomationRuleResponseDto, rule, { excludeExtraneousValues: true });
  }
}
