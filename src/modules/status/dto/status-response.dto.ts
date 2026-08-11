import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Response shapes for the status routes. These describe what the handlers already return — the
 * payload is the raw handler value, not an envelope.
 *
 * Decorated properties avoid named utility types: emitDecoratorMetadata wraps a named type in a
 * runtime guard whose other arm can never execute, leaving an uncoverable branch.
 */
export class StatusContactDto {
  @ApiProperty({ description: 'Poster id.', example: '628123456789@c.us' })
  id!: string;

  @ApiPropertyOptional({ description: "Name from the account's addressbook, when saved." })
  name?: string;

  @ApiPropertyOptional({ description: 'Name the poster set for themselves.', example: 'Ada' })
  pushName?: string;
}

export class StatusDto {
  @ApiProperty({ description: 'Status id.', example: 'ABCD1234' })
  id!: string;

  @ApiProperty({ type: StatusContactDto, description: 'Who posted it.' })
  contact!: StatusContactDto;

  @ApiProperty({
    enum: ['text', 'image', 'video', 'voice'],
    description:
      '`voice` is an audio status posted as a voice note. Before voice posting existed, such a ' +
      'status read back as `text`, because anything that was not an image or a video collapsed to it.',
    example: 'image',
  })
  type!: string;

  @ApiPropertyOptional({ description: 'Caption, for an image or video status.' })
  caption?: string;

  @ApiPropertyOptional({ description: 'Media URL as the engine reported it.' })
  mediaUrl?: string;

  @ApiPropertyOptional({
    type: Object,
    description:
      'Downloaded media bytes, present only when the engine fetched them and they fit the inbound ' +
      'media cap. Absent is not an error — fetch the bytes from the media route instead.',
  })
  media?: object;

  @ApiPropertyOptional({ description: 'Background colour of a text or voice status.', example: '#0a5c36' })
  backgroundColor?: string;

  @ApiPropertyOptional({ description: 'Font index of a text or voice status.', example: 2 })
  font?: number;

  @ApiProperty({ description: 'ISO-8601 timestamp the status was posted.', example: '2026-08-07T12:00:00.000Z' })
  timestamp!: string;

  @ApiProperty({ description: 'ISO-8601 timestamp the status expires.', example: '2026-08-08T12:00:00.000Z' })
  expiresAt!: string;
}

export class StatusListResponseDto {
  @ApiProperty({ type: [StatusDto], description: 'Statuses, newest first.' })
  statuses!: StatusDto[];
}

export class StatusResultDto {
  @ApiProperty({ description: 'Id of the status that was posted.', example: 'ABCD1234' })
  statusId!: string;

  @ApiProperty({ description: 'ISO-8601 timestamp the engine stamped on it.', example: '2026-08-07T12:00:00.000Z' })
  timestamp!: string;

  @ApiProperty({ description: 'ISO-8601 timestamp it expires — 24 hours later.', example: '2026-08-08T12:00:00.000Z' })
  expiresAt!: string;
}

export class StatusDeletedResponseDto {
  @ApiProperty({ example: 'Status deleted successfully' })
  message!: string;
}
