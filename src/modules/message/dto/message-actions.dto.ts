import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsLatitude,
  IsLongitude,
  IsBoolean,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  MaxLength,
  IsIn,
} from 'class-validator';
import { ToStrictBoolean, ToStrictNumber } from '../../../common/utils/strict-boolean';
import { MESSAGE_TEXT_MAX_LENGTH } from './send-message.dto';

/**
 * Validated DTOs for the message action endpoints. These replaced inline
 * `@Body()` object-literal types, which erase at runtime so the global ValidationPipe had
 * no metadata to validate or whitelist against.
 */

// Field caps shared with the agent-tool input schemas (src/core/agent-tools/tools/message.tools.ts)
// so MCP and REST enforce the same limits on the equivalent operations.
export const LOCATION_TEXT_MAX_LENGTH = 1024;
export const CONTACT_NAME_MAX_LENGTH = 255;
export const CONTACT_NUMBER_MAX_LENGTH = 30;
export const REACTION_EMOJI_MAX_LENGTH = 32;

export class SendLocationDto {
  @ApiProperty({ description: 'Chat ID (e.g. 628123456789@c.us)' })
  @IsString()
  @IsNotEmpty()
  chatId!: string;

  @ApiProperty({ example: -6.2088 })
  @ToStrictNumber()
  @IsLatitude()
  latitude!: number;

  @ApiProperty({ example: 106.8456 })
  @ToStrictNumber()
  @IsLongitude()
  longitude!: number;

  @ApiPropertyOptional({ maxLength: LOCATION_TEXT_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(LOCATION_TEXT_MAX_LENGTH)
  description?: string;

  @ApiPropertyOptional({ maxLength: LOCATION_TEXT_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(LOCATION_TEXT_MAX_LENGTH)
  address?: string;
}

export class SendContactDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  chatId!: string;

  @ApiProperty({ maxLength: CONTACT_NAME_MAX_LENGTH })
  @IsString()
  @IsNotEmpty()
  @MaxLength(CONTACT_NAME_MAX_LENGTH)
  contactName!: string;

  @ApiProperty({ maxLength: CONTACT_NUMBER_MAX_LENGTH })
  @IsString()
  @IsNotEmpty()
  @MaxLength(CONTACT_NUMBER_MAX_LENGTH)
  contactNumber!: string;
}

export class SendPollDto {
  @ApiProperty({ description: 'Chat ID (e.g. 628123456789@c.us or 1203630000@g.us)' })
  @IsString()
  @IsNotEmpty()
  chatId!: string;

  @ApiProperty({ description: 'Poll question / title', maxLength: 255, example: 'Where should we meet?' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  // WhatsApp itself caps polls at 12 options and ~100 chars per option; validating here keeps the
  // failure a clean 400 instead of an engine error deep in the send path.
  @ApiProperty({
    description: 'Options to vote on (WhatsApp allows between 2 and 12)',
    type: [String],
    example: ['Park', 'Beach', 'Downtown'],
  })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(100, { each: true })
  options!: string[];

  @ApiPropertyOptional({ description: 'Allow voters to pick several options (default single choice)' })
  // Read strictly for the same reason as DeleteMessageDto.forEveryone: without it the pipe's
  // implicit conversion turns any non-empty string into `true`, and this file's own spec has always
  // asserted that a non-boolean here is rejected.
  @ToStrictBoolean()
  @IsOptional()
  @IsBoolean()
  allowMultipleAnswers?: boolean;
}

export class ReplyMessageDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  chatId!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  quotedMessageId!: string;

  // Same body cap as SendTextMessageDto.text — a reply cannot exceed what a send allows.
  @ApiProperty({ maxLength: MESSAGE_TEXT_MAX_LENGTH })
  @IsString()
  @IsNotEmpty()
  @MaxLength(MESSAGE_TEXT_MAX_LENGTH)
  text!: string;
}

export class ForwardMessageDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  fromChatId!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  toChatId!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  messageId!: string;
}

export class ReactMessageDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  chatId!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  messageId!: string;

  // Empty string is VALID — it removes the reaction (endpoint contract). So @IsString, not @IsNotEmpty.
  @ApiProperty({
    description: 'Emoji to react with. Send an empty string to remove the reaction.',
    maxLength: REACTION_EMOJI_MAX_LENGTH,
  })
  @IsString()
  @MaxLength(REACTION_EMOJI_MAX_LENGTH)
  emoji!: string;
}

export class DeleteMessageDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  chatId!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  messageId!: string;

  @ApiPropertyOptional({ description: 'Delete for everyone (default true)' })
  // The field's only purpose is to say "no, delete locally" — the default is already true
  // (message.service.ts). Under the pipe's implicit conversion a string `"false"` would become
  // boolean `true`, turning an explicit local-only delete into an irreversible retraction from the
  // recipient's device, so the value is read strictly rather than interpreted.
  @ToStrictBoolean()
  @IsOptional()
  @IsBoolean()
  forEveryone?: boolean;
}

/**
 * The only pin windows WhatsApp recognises, in seconds. Anything else is rejected page-side by
 * whatsapp-web.js (a silent `false`) and is not representable in the Baileys pin payload, so it is
 * refused here with a 400 rather than turned into an engine-level mystery.
 */
export const PIN_DURATIONS_SECONDS = [86400, 604800, 2592000] as const;

export class PinMessageDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  chatId!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  messageId!: string;

  @ApiPropertyOptional({
    description: 'Pin duration in seconds: 86400 (24h), 604800 (7d) or 2592000 (30d). Defaults to 24h.',
    enum: PIN_DURATIONS_SECONDS,
    default: 86400,
  })
  // Strict conversion for the same reason as DeleteMessageDto.forEveryone: under the pipe's
  // implicit conversion a non-numeric string would arrive as NaN and slip past IsIn as a
  // "different" value rather than being rejected outright.
  @ToStrictNumber()
  @IsOptional()
  @IsIn(PIN_DURATIONS_SECONDS)
  durationSeconds?: number;
}

/** Cap on how many options one vote may select — WhatsApp polls hold at most 12. */
export const POLL_VOTE_MAX_OPTIONS = 12;

export class VotePollDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  chatId!: string;

  @ApiProperty({ description: 'The poll creation message to vote on.' })
  @IsString()
  @IsNotEmpty()
  pollMessageId!: string;

  @ApiProperty({
    description:
      'The option TEXTS to select, exactly as they appear on the poll. Replaces the current ' +
      'selection; an empty array clears the vote.',
    type: [String],
    maxItems: POLL_VOTE_MAX_OPTIONS,
  })
  @IsArray()
  @ArrayMaxSize(POLL_VOTE_MAX_OPTIONS)
  @IsString({ each: true })
  options!: string[];
}

export class StarMessageDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  chatId!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  messageId!: string;

  @ApiProperty({ description: 'true to star, false to remove the star.' })
  // Read strictly for the same reason as DeleteMessageDto.forEveryone: implicit conversion would
  // turn the string "false" into boolean true, silently inverting the caller's intent.
  @ToStrictBoolean()
  @IsBoolean()
  star!: boolean;
}

export class UnpinMessageDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  chatId!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  messageId!: string;
}

export class EditMessageDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  chatId!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  messageId!: string;

  // Same body cap as SendTextMessageDto.text — an edit cannot exceed what a send allows.
  @ApiProperty({ description: 'New text body for the message', maxLength: 4096 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  body!: string;
}
