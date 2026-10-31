import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsObject,
  IsArray,
  ArrayMaxSize,
  MaxLength,
  IsBoolean,
  Validate,
  Matches,
} from 'class-validator';
import { ToStrictArray, ToStrictBoolean, ToStrictString } from '../../../common/utils/strict-boolean';
import {
  CHAT_ID_MAX_LENGTH,
  CHAT_JID_MESSAGE,
  CHAT_JID_PATTERN,
  MENTIONS_DESCRIPTION,
  MENTIONS_MAX,
  MENTION_WID_MAX_LENGTH,
} from './send-message.dto';
import { IsMentionWidConstraint } from './is-mention-wid.validator';

export class SendTemplateMessageDto {
  @ApiProperty({
    description: 'WhatsApp chat ID (phone@c.us for individual, groupId@g.us for groups)',
    example: '628123456789@c.us',
    maxLength: CHAT_ID_MAX_LENGTH,
  })
  @ToStrictString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(CHAT_ID_MAX_LENGTH)
  @Matches(CHAT_JID_PATTERN, { message: CHAT_JID_MESSAGE })
  chatId!: string;

  @ApiPropertyOptional({
    description: 'Template ID to render. Provide either templateId or templateName.',
    example: 'b1c2d3e4-f5a6-7890-bcde-f01234567890',
  })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @IsNotEmpty()
  templateId?: string;

  @ApiPropertyOptional({
    description: 'Template name to render. Provide either templateId or templateName.',
    example: 'order-confirmation',
  })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @IsNotEmpty()
  templateName?: string;

  @ApiPropertyOptional({
    description: 'Variables substituted into {{placeholder}} tokens in the template',
    example: { customer: 'Alice', orderId: '1234' },
  })
  @IsOptional()
  @IsObject()
  vars?: Record<string, string>;

  // The rendered body is dispatched through the same path as send-text, so it carries the same two
  // optionals. `quotedMessageId` is deliberately NOT among them: docs/06 publishes this route as one
  // that rejects it.
  @ApiPropertyOptional({
    description: MENTIONS_DESCRIPTION,
    example: ['628123456789@c.us'],
    type: [String],
    maxItems: MENTIONS_MAX,
    items: { type: 'string', maxLength: MENTION_WID_MAX_LENGTH },
  })
  @IsOptional()
  @ToStrictArray()
  @IsArray()
  @ArrayMaxSize(MENTIONS_MAX)
  @IsString({ each: true })
  @MaxLength(MENTION_WID_MAX_LENGTH, { each: true })
  @Validate(IsMentionWidConstraint, { each: true })
  mentions?: string[];

  @ApiPropertyOptional({
    description:
      'Controls the URL preview on the rendered body, with the same engine split as send-text: ' +
      'whatsapp-web.js builds one by default and `false` suppresses it, while on Baileys previews ' +
      'are opt-in and only `true` attaches one.',
    example: false,
  })
  // Same guard as send-text: implicit conversion would turn the string "false" into true.
  @ToStrictBoolean()
  @IsOptional()
  @IsBoolean()
  linkPreview?: boolean;
}
