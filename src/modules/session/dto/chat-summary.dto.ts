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
}
