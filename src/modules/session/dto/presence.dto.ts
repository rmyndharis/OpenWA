import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class SubscribePresenceDto {
  @ApiProperty({
    description: "Chat ID in the active engine's native format (e.g. 1234567890@c.us on whatsapp-web.js)",
    example: '1234567890@c.us',
  })
  @IsString()
  @IsNotEmpty()
  // Same engine-neutral structural check the other chat-scoped DTOs use: localpart@host, no
  // whitespace, so a different engine's JID scheme is accepted and the adapter normalises further.
  @Matches(/^[^\s@]+@[^\s@]+$/, {
    message: 'chatId must be a valid chat JID in the form localpart@host',
  })
  chatId!: string;
}

export class ParticipantPresenceDto {
  @ApiProperty({ description: 'Participant id. In a 1:1 chat this is the chat itself.', example: '1234567890@c.us' })
  id!: string;

  @ApiProperty({
    enum: ['available', 'unavailable', 'composing', 'recording', 'paused'],
    description:
      '`composing` and `recording` mean actively typing or recording in this chat; `paused` means ' +
      'they stopped without sending. `available`/`unavailable` describe reachability.',
    example: 'composing',
  })
  state!: string;

  @ApiPropertyOptional({
    type: Number,
    description:
      "Unix SECONDS the contact was last seen. Absent whenever the contact's privacy settings hide " +
      'last-seen — the common case, and not an error.',
    example: 1786000000,
  })
  lastSeen?: number;
}

export class ChatPresenceResponseDto {
  @ApiProperty({ example: '1234567890@c.us' })
  chatId!: string;

  @ApiProperty({ type: [ParticipantPresenceDto] })
  participants!: ParticipantPresenceDto[];

  @ApiPropertyOptional({ type: Number, description: 'Online member count, groups only.', example: 3 })
  groupOnlineCount?: number;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      'When this gateway received the report — NOT a WhatsApp timestamp. Presence is short-lived, so ' +
      'an old `observedAt` means the state is stale rather than steady.',
    example: '2026-08-03T12:00:00Z',
  })
  observedAt!: Date;
}
