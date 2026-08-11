import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Response shapes for the channel routes. These describe what the handlers already return — the
 * payload is the raw handler value, not an envelope.
 *
 * Decorated properties avoid named utility types: emitDecoratorMetadata wraps a named type in a
 * runtime guard whose other arm can never execute, leaving an uncoverable branch.
 */
export class ChannelDto {
  @ApiProperty({ description: 'Channel (newsletter) id.', example: '120363000000000000@newsletter' })
  id!: string;

  @ApiProperty({ description: 'Channel name.', example: 'Release notes' })
  name!: string;

  @ApiPropertyOptional({ description: 'Channel description, when set.' })
  description?: string;

  @ApiPropertyOptional({
    description: 'Invite code, when the engine discloses one. Absent does not mean the channel is private.',
    example: '0029Va...',
  })
  inviteCode?: string;

  @ApiPropertyOptional({ description: 'Subscriber count, when the engine reports it.', example: 1024 })
  subscriberCount?: number;

  @ApiPropertyOptional({ description: 'Channel picture URL, when set.' })
  picture?: string;

  @ApiPropertyOptional({ description: 'Whether WhatsApp marks the channel verified.', example: false })
  verified?: boolean;

  @ApiPropertyOptional({ description: 'Unix SECONDS the channel was created, when reported.', example: 1786000000 })
  createdAt?: number;
}

export class ChannelMessageDto {
  @ApiProperty({ description: 'Message id.', example: 'ABCD1234' })
  id!: string;

  @ApiProperty({ description: 'Message text. Empty for a media-only post.', example: 'v0.14.4 is out' })
  body!: string;

  @ApiProperty({ description: 'Unix SECONDS the message was posted.', example: 1786000000 })
  timestamp!: number;

  @ApiProperty({ description: 'Whether the post carries media.', example: false })
  hasMedia!: boolean;

  @ApiPropertyOptional({ description: 'Media URL, when the engine resolved one.' })
  mediaUrl?: string;
}

export class ChannelAckResponseDto {
  @ApiProperty({ description: 'Always true — a failure is reported as a non-2xx status, not as false.', example: true })
  success!: boolean;
}
