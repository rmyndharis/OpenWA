import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { ChatKind } from '../../../engine/identity/wa-id';
import type { MessageType } from '../../../engine/interfaces/whatsapp-engine.interface';
import { MESSAGE_TYPES } from '../../webhook/filters/filter-types';

const CHAT_KINDS: ChatKind[] = ['individual', 'group', 'channel', 'status', 'broadcast', 'unknown'];

/** OpenAPI mirror of the engine `ChatSummary` (documentation only; the runtime returns the interface). */
export class ChatSummaryDto {
  @ApiProperty({ example: '628111@c.us' })
  id!: string;

  @ApiProperty({
    description:
      "The chat's name, an empty string for a Baileys chat held under a privacy id (@lid) that has no saved, " +
      'verified or push name, which a client titles by `phone`.',
    example: 'Alice',
  })
  name!: string;

  @ApiPropertyOptional({
    description:
      'Phone digits of a 1:1 chat WhatsApp holds under a privacy id (@lid), when this session can map it. ' +
      'Absent for a phone-keyed chat and when the mapping is unknown. Not a display name: an unnamed chat ' +
      'is titled from these digits, and a saved name still wins.',
    example: '5491154759191',
  })
  phone?: string;

  @ApiProperty({ description: 'Retained for back-compat; true for @g.us chats.', example: false })
  isGroup!: boolean;

  @ApiProperty({ enum: CHAT_KINDS, description: 'User-facing chat kind.', example: 'individual' })
  kind!: ChatKind;

  @ApiProperty({ example: 1 })
  unreadCount!: number;

  @ApiProperty({ description: 'Unix seconds of the last activity.', example: 1700000010 })
  timestamp!: number;

  @ApiPropertyOptional({ example: 'hi' })
  lastMessage?: string;

  @ApiPropertyOptional({
    enum: MESSAGE_TYPES,
    description: 'Engine-neutral type of the last message, when available.',
    example: 'image',
  })
  lastMessageType?: MessageType;

  @ApiProperty({ description: 'Archived state, as set via POST /sessions/{sessionId}/chats/archive.', example: false })
  archived!: boolean;

  @ApiProperty({ description: 'Pinned state, as set via POST /sessions/{sessionId}/chats/pin.', example: false })
  pinned!: boolean;

  @ApiProperty({
    description:
      'Whether the chat is muted right now, as set via POST /sessions/{sessionId}/chats/mute. The ' +
      'verdict rather than the expiry: whatsapp-web.js derives it itself from Chat.isMuted, and ' +
      'Baileys carries a muteEndTime that this gateway compares against now. muteExpiration carries ' +
      'the instant itself.',
    example: false,
  })
  muted!: boolean;

  @ApiPropertyOptional({
    description:
      'Epoch MILLISECONDS at which the mute ends, present only when muted is true; 0 means muted ' +
      'indefinitely. Milliseconds is the same unit as POST /sessions/{sessionId}/chats/mute ' +
      'muteUntil, so a finite value can be written straight back. The 0 an indefinite mute reports ' +
      'is the exception: muteUntil requires a real future instant, so re-apply an indefinite mute ' +
      'with a far-future timestamp rather than 0.',
    example: 1786003600000,
  })
  muteExpiration?: number;
}
