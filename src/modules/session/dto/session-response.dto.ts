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
    description: 'Human-readable reason for the most recent terminal engine failure (only set when status is FAILED).',
    example: 'Failed to launch the browser process: spawn /usr/bin/chromium ENOENT',
    nullable: true,
  })
  lastError?: string | null;

  /**
   * Map a Session entity to the public response shape, stripping sensitive
   * engine config fields (`config`, `proxyUrl`, `proxyType`) that must not
   * appear in any API response.
   */
  static fromEntity(session: Session): SessionResponseDto {
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
