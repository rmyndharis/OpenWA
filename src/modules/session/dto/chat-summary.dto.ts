import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { ChatKind } from '../../../engine/identity/wa-id';

const CHAT_KINDS: ChatKind[] = ['individual', 'group', 'channel', 'status', 'broadcast', 'unknown'];

/** OpenAPI mirror of the engine `ChatSummary` (documentation only; the runtime returns the interface). */
export class ChatSummaryDto {
  @ApiProperty({ example: '628111@c.us' })
  id!: string;

  @ApiProperty({ example: 'Alice' })
  name!: string;

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
    description:
      'Whether the chat is currently muted. Absent when the active engine cannot report mute state ' +
      '(so a consumer can tell "unknown" apart from "not muted").',
    example: true,
  })
  isMuted?: boolean;

  @ApiPropertyOptional({
    description:
      'Unix seconds at which the mute expires (same unit as `timestamp`). `0` means muted ' +
      'indefinitely. Only present when `isMuted` is true.',
    example: 1700003600,
  })
  muteExpiration?: number;
}
