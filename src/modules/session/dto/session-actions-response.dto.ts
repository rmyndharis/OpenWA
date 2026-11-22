import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Response shapes for the session-scoped chat / presence / group / stats routes — the raw handler
 * value, no envelope. Decorated properties avoid named utility types: emitDecoratorMetadata wraps a
 * named type in a runtime guard whose other arm can never execute, leaving an uncoverable branch.
 */

export class SessionActionResponseDto {
  @ApiProperty({
    description:
      'Whether the engine applied the change. Routes where the engine can decline spell out what ' +
      '`false` means in their own description; on the rest it is always `true`.',
    example: true,
  })
  success!: boolean;
}

export class SessionGroupSummaryDto {
  @ApiProperty({ description: 'Group id.', example: '120363000000000000@g.us' })
  id!: string;

  @ApiProperty({ description: 'Group subject.', example: 'Engineering' })
  name!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'JID of the parent community, or null when the group is standalone.',
    example: null,
  })
  linkedParentJID?: string | null;
}

export class SessionMemoryUsageDto {
  @ApiProperty({ description: 'V8 heap in use, in MiB.', example: 128 })
  heapUsed!: number;

  @ApiProperty({ description: 'V8 heap reserved, in MiB.', example: 256 })
  heapTotal!: number;

  @ApiProperty({ description: 'Resident set size, in MiB.', example: 512 })
  rss!: number;
}

export class SessionsOverviewResponseDto {
  @ApiProperty({ description: 'Sessions on record, connected or not.', example: 5 })
  total!: number;

  @ApiProperty({ description: 'Sessions with a live engine in this process.', example: 2 })
  active!: number;

  @ApiProperty({ description: "Sessions whose status is 'ready'.", example: 2 })
  ready!: number;

  @ApiProperty({ description: "Sessions whose status is 'disconnected'.", example: 3 })
  disconnected!: number;

  @ApiProperty({
    description: 'Session count per status value.',
    example: { ready: 2, disconnected: 3 },
    additionalProperties: { type: 'integer' },
  })
  byStatus!: { [status: string]: number };

  @ApiPropertyOptional({
    type: () => SessionMemoryUsageDto,
    description: 'Process memory usage of this gateway. Returned only to unscoped ADMIN callers.',
  })
  memoryUsage?: SessionMemoryUsageDto;
}
