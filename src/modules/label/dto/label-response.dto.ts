import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Response shapes for the label routes. These describe what the handlers already return — the
 * payload is the raw handler value, not an envelope.
 *
 * Decorated properties avoid named utility types: emitDecoratorMetadata wraps a named type in a
 * runtime guard whose other arm can never execute, leaving an uncoverable branch.
 */
export class LabelDto {
  @ApiProperty({ description: 'Label id, assigned by WhatsApp.', example: '1' })
  id!: string;

  @ApiProperty({ description: 'Label text.', example: 'Paid' })
  name!: string;

  @ApiProperty({
    description:
      'Display colour as hex. The write path takes a colour INDEX (0-19) instead — neither engine ' +
      'exposes the index-to-hex mapping, so the two directions deliberately differ.',
    example: '#5bc0de',
  })
  hexColor!: string;
}

/** A chat carrying a label. Same summary projection the chats list uses. */
export class LabelChatDto {
  @ApiProperty({ description: "Chat id in the engine's native format.", example: '628123456789@c.us' })
  id!: string;

  @ApiProperty({ description: 'Chat title — contact name or group subject.', example: 'Ada Lovelace' })
  name!: string;

  @ApiProperty({ description: 'Retained for back-compat; `kind` is the full discriminator.', example: false })
  isGroup!: boolean;

  @ApiProperty({ description: 'User-facing chat kind.', example: 'individual' })
  kind!: string;

  @ApiProperty({ description: 'Unread messages in this chat.', example: 0 })
  unreadCount!: number;

  @ApiProperty({ description: 'Unix SECONDS of the most recent activity.', example: 1786000000 })
  timestamp!: number;

  @ApiPropertyOptional({ description: 'Preview of the last message, when there is one.', example: 'See you then' })
  lastMessage?: string;
}

export class LabelAckResponseDto {
  @ApiProperty({ description: 'Always true — a failure is reported as a non-2xx status, not as false.', example: true })
  success!: boolean;
}
