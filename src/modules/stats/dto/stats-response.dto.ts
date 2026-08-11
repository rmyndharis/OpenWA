import { ApiProperty } from '@nestjs/swagger';

/**
 * Response shapes for the statistics routes — the raw handler value, no envelope.
 * Decorated properties avoid named utility types: emitDecoratorMetadata wraps a named type in a
 * runtime guard whose other arm can never execute, leaving an uncoverable branch.
 */

export class OverviewSessionsDto {
  @ApiProperty({ description: 'Sessions currently connected.', example: 2 })
  active!: number;

  @ApiProperty({ description: 'Sessions on record, connected or not.', example: 5 })
  total!: number;

  @ApiProperty({
    description: 'Session count per status value.',
    example: { ready: 2, disconnected: 3 },
    additionalProperties: { type: 'integer' },
  })
  byStatus!: { [status: string]: number };
}

export class OverviewTodayDto {
  @ApiProperty({ example: 12 }) sent!: number;
  @ApiProperty({ example: 34 }) received!: number;
}

export class OverviewMessagesDto {
  @ApiProperty({ description: 'All-time sent count.', example: 1024 })
  sent!: number;

  @ApiProperty({ description: 'All-time received count.', example: 2048 })
  received!: number;

  @ApiProperty({ description: 'Sends the gateway recorded as failed.', example: 3 })
  failed!: number;

  @ApiProperty({ type: OverviewTodayDto, description: "Today's counts, in the server's timezone." })
  today!: OverviewTodayDto;
}

export class OverviewStatsResponseDto {
  @ApiProperty({ type: OverviewSessionsDto })
  sessions!: OverviewSessionsDto;

  @ApiProperty({ type: OverviewMessagesDto })
  messages!: OverviewMessagesDto;
}

export class TimeSeriesPointDto {
  @ApiProperty({ description: 'Bucket start, ISO-8601.', example: '2026-08-07T12:00:00.000Z' })
  timestamp!: string;

  @ApiProperty({ example: 12 }) sent!: number;
  @ApiProperty({ example: 34 }) received!: number;
}

export class StatsBySessionDto {
  @ApiProperty({ example: '0a941dac-a965-45e7-b318-74ae8be134f0' }) sessionId!: string;
  @ApiProperty({ example: 'primary' }) name!: string;
  @ApiProperty({ example: 12 }) sent!: number;
  @ApiProperty({ example: 34 }) received!: number;
}

export class StatsTopChatDto {
  @ApiProperty({ example: '628123456789@c.us' })
  chatId!: string;

  @ApiProperty({ type: String, nullable: true, description: 'Null when no name is known for the chat.' })
  chatName!: string | null;

  @ApiProperty({ example: 42 }) messageCount!: number;
}

export class MessageStatsResponseDto {
  @ApiProperty({ type: [TimeSeriesPointDto], description: 'One point per bucket over the requested period.' })
  timeSeries!: TimeSeriesPointDto[];

  @ApiProperty({
    description: 'Message count per message type.',
    example: { text: 900, image: 124 },
    additionalProperties: { type: 'integer' },
  })
  byType!: { [messageType: string]: number };

  @ApiProperty({ type: [StatsBySessionDto] })
  bySession!: StatsBySessionDto[];

  @ApiProperty({ type: [StatsTopChatDto] })
  topChats!: StatsTopChatDto[];
}

export class SessionStatsSessionDto {
  @ApiProperty({ example: '0a941dac-a965-45e7-b318-74ae8be134f0' }) id!: string;
  @ApiProperty({ example: 'primary' }) name!: string;
  @ApiProperty({ example: 'ready' }) status!: string;
}

export class SessionStatsMessagesDto {
  @ApiProperty({ example: 1024 }) sent!: number;
  @ApiProperty({ example: 2048 }) received!: number;
  @ApiProperty({ example: 46 }) today!: number;
  @ApiProperty({ example: 3 }) failed!: number;
}

export class SessionStatsTopChatDto {
  @ApiProperty({ example: '628123456789@c.us' })
  chatId!: string;

  @ApiProperty({ type: String, nullable: true, description: 'Null when no name is known for the chat.' })
  chatName!: string | null;

  @ApiProperty({ example: 42 }) count!: number;

  @ApiProperty({ description: 'ISO-8601 timestamp of the last message.', example: '2026-08-07T12:00:00.000Z' })
  lastActive!: string;
}

export class SessionHourlyActivityDto {
  @ApiProperty({ description: 'Hour of day, 0-23.', example: 9 }) hour!: number;
  @ApiProperty({ example: 12 }) sent!: number;
  @ApiProperty({ example: 34 }) received!: number;
}

export class SessionStatsResponseDto {
  @ApiProperty({ type: SessionStatsSessionDto })
  session!: SessionStatsSessionDto;

  @ApiProperty({ type: SessionStatsMessagesDto })
  messages!: SessionStatsMessagesDto;

  @ApiProperty({ type: [SessionStatsTopChatDto] })
  topChats!: SessionStatsTopChatDto[];

  @ApiProperty({ type: [SessionHourlyActivityDto] })
  hourlyActivity!: SessionHourlyActivityDto[];
}
