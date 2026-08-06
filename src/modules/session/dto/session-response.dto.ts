import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { Session } from '../entities/session.entity';
import { SessionStatus } from '../entities/session.entity';

export class AccountRestrictionDto {
  @ApiProperty({
    enum: ['reachout_timelock', 'tos_block', 'proxy_block'],
    description:
      'What WhatsApp is restricting. `reachout_timelock` leaves the session connected and existing ' +
      'chats working, blocking only the start of new conversations. `tos_block` and `proxy_block` ' +
      'are connection-level refusals — the session cannot stay linked while one is in force, so ' +
      'seeing either alongside a `ready` status is not possible.',
    example: 'reachout_timelock',
  })
  kind!: 'reachout_timelock' | 'tos_block' | 'proxy_block';

  @ApiProperty({
    description:
      "The engine's own token for the cause, passed through verbatim so it can be searched for and " +
      'so a value newer than this gateway is still surfaced rather than flattened.',
    example: 'BIZ_QUALITY',
  })
  code!: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description:
      'When enforcement ends, if the engine states it. Only reachout timelocks carry an expiry; ' +
      'absent means the engine gave no end time, not that the restriction is permanent.',
    example: '2026-08-04T09:00:00Z',
    nullable: true,
  })
  expiresAt?: Date | null;
}

export class SessionResponseDto {
  @ApiProperty({ example: 'sess_123e4567-e89b-12d3-a456-426614174000' })
  id!: string;

  @ApiProperty({ example: 'my-bot' })
  name!: string;

  @ApiProperty({ enum: SessionStatus, example: SessionStatus.READY })
  status!: SessionStatus;

  @ApiPropertyOptional({ type: String, example: '628123456789', nullable: true })
  phone?: string | null;

  @ApiPropertyOptional({ type: String, example: 'John Doe', nullable: true })
  pushName?: string | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', example: '2025-02-02T10:00:00Z', nullable: true })
  connectedAt?: Date | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', example: '2025-02-02T10:30:00Z', nullable: true })
  lastActive?: Date | null;

  @ApiProperty({ example: '2025-02-02T09:00:00Z' })
  createdAt!: Date;

  @ApiProperty({ example: '2025-02-02T10:00:00Z' })
  updatedAt!: Date;

  @ApiPropertyOptional({
    type: String,
    description:
      'Human-readable reason carried while the status is FAILED (a terminal engine failure) or ' +
      'ACTION_REQUIRED (the engine is running but something needs a human). Cleared on any other status.',
    example: 'Failed to launch the browser process: spawn /usr/bin/chromium ENOENT',
    nullable: true,
  })
  lastError?: string | null;

  @ApiPropertyOptional({
    type: AccountRestrictionDto,
    description:
      "A restriction WhatsApp itself has placed on this session's account, or null when there is " +
      'none. Distinct from `lastError`, which describes a fault on our side of the link. Derived ' +
      'from live engine state, so it is never persisted: it is re-established on the next connect.',
    nullable: true,
  })
  restriction?: AccountRestrictionDto | null;

  @ApiProperty({
    description:
      'Whether the gateway currently holds a live engine for this session. This is the precondition ' +
      'the lifecycle routes actually enforce, and `status` alone does not imply it: a `disconnected` ' +
      'session keeps its engine for the duration of an automatic reconnect backoff, while a session ' +
      'stopped through `POST /sessions/:id/stop` carries the same status with no engine. When `true`, ' +
      '`stop`, `logout` and `force-kill` can act and `start` answers 400; when `false`, the reverse. ' +
      'Derived per request from live process state, so it is never persisted and never historical.',
    example: true,
  })
  engineLoaded!: boolean;

  /**
   * Map a Session entity to the public response shape, stripping sensitive
   * engine config fields (`config`, `proxyUrl`, `proxyType`) that must not
   * appear in any API response.
   *
   * `engineLoaded` is not on the entity — it is live process state owned by the session service, so
   * every caller must pass it in rather than letting it default. A required parameter is deliberate:
   * a default of `false` would silently tell clients "no engine" for whole surfaces (the MCP tools,
   * any future caller) and the dashboard would then offer Start to a running session.
   */
  static fromEntity(session: Session, engineLoaded: boolean): SessionResponseDto {
    return {
      id: session.id,
      name: session.name,
      status: session.status,
      phone: session.phone,
      pushName: session.pushName,
      connectedAt: session.connectedAt,
      lastActive: session.lastActiveAt,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      lastError: session.lastError ?? null,
      restriction: session.restriction
        ? {
            kind: session.restriction.kind,
            code: session.restriction.code,
            // Held as epoch ms internally (what the engine gives us); served as a date-time like
            // every other timestamp in this response.
            expiresAt: session.restriction.expiresAt ? new Date(session.restriction.expiresAt) : null,
          }
        : null,
      engineLoaded,
    };
  }
}

export class QRCodeResponseDto {
  @ApiProperty({
    description: 'QR code as data URL',
    example: 'data:image/png;base64,...',
  })
  qrCode!: string;

  @ApiProperty({ enum: SessionStatus, example: SessionStatus.QR_READY })
  status!: SessionStatus;
}
