import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { Session } from '../entities/session.entity';
import { SessionStatus } from '../entities/session.entity';

export class SessionResponseDto {
  @ApiProperty({ example: 'sess_123e4567-e89b-12d3-a456-426614174000' })
  id: string;

  @ApiProperty({ example: 'my-bot' })
  name: string;

  @ApiProperty({ enum: SessionStatus, example: SessionStatus.READY })
  status: SessionStatus;

  @ApiPropertyOptional({ type: String, example: '628123456789', nullable: true })
  phone?: string | null;

  @ApiPropertyOptional({ type: String, example: 'John Doe', nullable: true })
  pushName?: string | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', example: '2025-02-02T10:00:00Z', nullable: true })
  connectedAt?: Date | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', example: '2025-02-02T10:30:00Z', nullable: true })
  lastActive?: Date | null;

  @ApiProperty({ example: '2025-02-02T09:00:00Z' })
  createdAt: Date;

  @ApiProperty({ example: '2025-02-02T10:00:00Z' })
  updatedAt: Date;

  @ApiPropertyOptional({
    type: String,
    description:
      'Human-readable reason carried while the status is FAILED (a terminal engine failure) or ' +
      'ACTION_REQUIRED (the engine is running but something needs a human). Cleared on any other status.',
    example: 'Failed to launch the browser process: spawn /usr/bin/chromium ENOENT',
    nullable: true,
  })
  lastError?: string | null;

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
  engineLoaded: boolean;

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
      engineLoaded,
    };
  }
}

export class QRCodeResponseDto {
  @ApiProperty({
    description: 'QR code as data URL',
    example: 'data:image/png;base64,...',
  })
  qrCode: string;

  @ApiProperty({ enum: SessionStatus, example: SessionStatus.QR_READY })
  status: SessionStatus;
}
