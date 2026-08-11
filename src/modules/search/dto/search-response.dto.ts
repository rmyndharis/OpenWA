import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Response shapes for the search routes — the raw handler value, no envelope.
 * Decorated properties avoid named utility types: emitDecoratorMetadata wraps a named type in a
 * runtime guard whose other arm can never execute, leaving an uncoverable branch.
 */

export class SearchHitDto {
  @ApiProperty({ description: 'Gateway message row id.', example: '7c2e5a91-3b8d-4f6a-a05c-9d1e4b7f2306' })
  messageId!: string;

  @ApiProperty({ description: "WhatsApp's own message id.", example: 'true_628123456789@c.us_3EB0123' })
  waMessageId!: string;

  @ApiProperty({ example: '0a941dac-a965-45e7-b318-74ae8be134f0' }) sessionId!: string;
  @ApiProperty({ example: '628123456789@c.us' }) chatId!: string;

  @ApiProperty({ description: 'Full message text.', example: 'See you at 10' })
  body!: string;

  @ApiProperty({
    description:
      'Excerpt with `<mark>` highlight markers. Render it as TEXT, never as HTML — the markers come ' +
      'from the provider and the body is user-supplied.',
    example: 'See you at <mark>10</mark>',
  })
  snippet!: string;

  @ApiProperty({ description: 'Unix SECONDS of the message.', example: 1786000000 })
  timestamp!: number;

  @ApiProperty({ example: 'text' }) type!: string;
  @ApiProperty({ enum: ['incoming', 'outgoing'], example: 'incoming' }) direction!: string;

  @ApiProperty({ description: 'Sender id.', example: '628123456789@c.us' })
  from!: string;

  @ApiPropertyOptional({ description: 'Relevance score, when the provider reports one.', example: 0.87 })
  score?: number;
}

export class SearchResultsResponseDto {
  @ApiProperty({ type: [SearchHitDto] })
  hits!: SearchHitDto[];

  @ApiProperty({ description: 'Bounded exact count for pagination.', example: 42 })
  total!: number;

  @ApiProperty({ description: 'How long the provider took, in milliseconds.', example: 12 })
  tookMs!: number;

  @ApiProperty({ description: 'Which provider answered.', example: 'builtin-fts' })
  provider!: string;
}
