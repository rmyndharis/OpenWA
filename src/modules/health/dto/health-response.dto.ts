import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Response shapes for the health routes — the raw handler value, no envelope.
 * Decorated properties avoid named utility types: emitDecoratorMetadata wraps a named type in a
 * runtime guard whose other arm can never execute, leaving an uncoverable branch.
 */

export class HealthCheckResponseDto {
  @ApiProperty({ description: 'Liveness marker. This route does not probe dependencies.', example: 'ok' })
  status!: string;

  @ApiProperty({ description: 'ISO-8601 timestamp of the reply.', example: '2026-08-07T12:00:00.000Z' })
  timestamp!: string;

  @ApiPropertyOptional({
    description: 'Running application version. Included only when the request carries a valid API key.',
    example: '0.14.4',
  })
  version?: string;
}

export class LivenessResponseDto {
  @ApiProperty({ description: 'Always `ok` when the process can answer at all.', example: 'ok' })
  status!: string;
}

export class SessionsHealthResponseDto {
  @ApiProperty({ description: 'Always `ok`; the numbers carry the signal, not the status.', example: 'ok' })
  status!: string;

  @ApiProperty({ description: 'This node’s ownership identity (NODE_ID, defaulting to the hostname).' })
  nodeId!: string;

  @ApiProperty({
    description:
      'True once the node is draining (shutdown or POST /infra/drain): readiness is 503 and no new sessions start here.',
    example: false,
  })
  draining!: boolean;

  @ApiProperty({ description: 'Engines currently live or initializing in this process.', example: 4 })
  engines!: number;

  @ApiProperty({
    description:
      'Session rows assigned to this node, by state. `assigned` is the total; warm-up progress is `ready` approaching `assigned`.',
    example: { assigned: 5, ready: 4, connecting: 1, disconnected: 0, failed: 0 },
    additionalProperties: { type: 'number' },
  })
  sessions!: { [state: string]: number };
}

export class ReadinessResponseDto {
  @ApiProperty({
    description: 'Only `ok` reaches a 200 — a failing dependency answers 503 with this same shape.',
    example: 'ok',
  })
  status!: string;

  @ApiProperty({
    description: 'Per-dependency outcome, keyed by dependency name. Present on both the 200 and the 503.',
    example: { mainDatabase: { status: 'up' }, dataDatabase: { status: 'up' } },
    additionalProperties: { type: 'object' },
  })
  details!: { [dependency: string]: object };
}
