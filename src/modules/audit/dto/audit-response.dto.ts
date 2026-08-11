import { ApiProperty } from '@nestjs/swagger';

/**
 * Response shapes for the audit routes — the raw handler value, no envelope.
 * Decorated properties avoid named utility types: emitDecoratorMetadata wraps a named type in a
 * runtime guard whose other arm can never execute, leaving an uncoverable branch.
 */

export class AuditLogDto {
  @ApiProperty({ example: '4f1c9b2a-8d3e-4c5b-9a17-2e6f0b4d8c31' }) id!: string;

  @ApiProperty({ description: 'What happened.', example: 'session.create' })
  action!: string;

  @ApiProperty({ enum: ['info', 'warn', 'error'], example: 'info' })
  severity!: string;

  @ApiProperty({ type: String, nullable: true, description: 'Null for an unauthenticated or system action.' })
  apiKeyId!: string | null;

  @ApiProperty({ type: String, nullable: true }) apiKeyName!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Null for a deployment-global action.' })
  sessionId!: string | null;

  @ApiProperty({ type: String, nullable: true }) sessionName!: string | null;
  @ApiProperty({ type: String, nullable: true }) ipAddress!: string | null;
  @ApiProperty({ type: String, nullable: true }) userAgent!: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'POST' }) method!: string | null;
  @ApiProperty({ type: String, nullable: true, example: '/api/sessions' }) path!: string | null;
  @ApiProperty({ type: Number, nullable: true, example: 201 }) statusCode!: number | null;

  @ApiProperty({
    type: Object,
    nullable: true,
    description: 'Free-form context for the action. Shape varies per action and is not part of the contract.',
  })
  metadata!: object | null;

  @ApiProperty({ type: String, nullable: true, description: 'Present only for a failed action.' })
  errorMessage!: string | null;

  @ApiProperty({ description: 'ISO-8601 timestamp the entry was written.', example: '2026-08-07T12:00:00.000Z' })
  createdAt!: string;
}

export class AuditListResponseDto {
  @ApiProperty({
    type: [AuditLogDto],
    description: 'The requested page. A session-scoped API key sees only entries within its scope.',
  })
  data!: AuditLogDto[];

  @ApiProperty({ description: 'Total matching entries, for paging.', example: 128 })
  total!: number;
}
