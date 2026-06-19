import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsUrl,
  IsArray,
  IsOptional,
  IsBoolean,
  IsInt,
  Min,
  Max,
  MaxLength,
  ArrayMinSize,
  IsIn,
  IsObject,
} from 'class-validator';
import { Expose, plainToInstance } from 'class-transformer';
import { Webhook } from '../entities/webhook.entity';

export const WEBHOOK_EVENTS = [
  'message.received',
  'message.sent',
  'message.ack',
  'message.failed',
  'message.revoked',
  'session.status',
  'session.qr',
  'session.authenticated',
  'session.disconnected',
  // Reserved: accepted on subscribe but not dispatched yet (no engine emit source).
  'group.join',
  'group.leave',
  'group.update',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

export class CreateWebhookDto {
  @ApiProperty({
    description: 'Webhook URL to receive events',
    example: 'https://your-server.com/webhook',
  })
  @IsUrl()
  url: string;

  @ApiPropertyOptional({
    description: "Event types to subscribe to. '*' subscribes to all events.",
    example: ['message.received', 'session.status'],
    enum: WEBHOOK_EVENTS,
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  // Must include '*' (wildcard subscribe-all) alongside the known events.
  @IsIn([...WEBHOOK_EVENTS, '*'], { each: true })
  events?: string[];

  @ApiPropertyOptional({
    description: 'Secret key for HMAC signature verification',
    example: 'your-secret-key',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  secret?: string;

  @ApiPropertyOptional({
    description: 'Custom headers to include in webhook requests',
    example: { 'X-Custom-Header': 'value' },
  })
  @IsOptional()
  @IsObject()
  headers?: Record<string, string>;

  @ApiPropertyOptional({
    description: 'Number of retry attempts on failure',
    example: 3,
    minimum: 0,
    maximum: 5,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5)
  retryCount?: number;
}

export class UpdateWebhookDto {
  @ApiPropertyOptional({ description: 'Webhook URL' })
  @IsOptional()
  @IsUrl()
  url?: string;

  @ApiPropertyOptional({ description: "Event types to subscribe to. '*' subscribes to all events." })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsIn([...WEBHOOK_EVENTS, '*'], { each: true })
  events?: string[];

  @ApiPropertyOptional({ description: 'Secret key for HMAC signature' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  secret?: string;

  @ApiPropertyOptional({ description: 'Custom headers' })
  @IsOptional()
  @IsObject()
  headers?: Record<string, string>;

  @ApiPropertyOptional({ description: 'Enable/disable webhook' })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({ description: 'Retry count' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5)
  retryCount?: number;
}

/**
 * Public response shape for a webhook. Deliberately omits `secret` (the HMAC
 * signing key) and `headers` (which may carry receiver credentials) — these are
 * write-only and must never appear in any API response.
 *
 * `@Expose()` is required on every field: `fromEntity` maps with
 * `excludeExtraneousValues: true`, so only exposed fields are serialized and any
 * undeclared entity field (secret, headers, the session relation) is dropped.
 */
export class WebhookResponseDto {
  @Expose()
  @ApiProperty()
  id: string;

  @Expose()
  @ApiProperty()
  sessionId: string;

  @Expose()
  @ApiProperty()
  url: string;

  @Expose()
  @ApiProperty()
  events: string[];

  @Expose()
  @ApiProperty()
  active: boolean;

  @Expose()
  @ApiProperty()
  retryCount: number;

  @Expose()
  @ApiPropertyOptional()
  lastTriggeredAt?: Date | null;

  @Expose()
  @ApiProperty()
  createdAt: Date;

  @Expose()
  @ApiProperty()
  updatedAt: Date;

  static fromEntity(entity: Webhook): WebhookResponseDto {
    return plainToInstance(WebhookResponseDto, entity, { excludeExtraneousValues: true });
  }

  static fromEntities(entities: Webhook[]): WebhookResponseDto[] {
    return entities.map(entity => WebhookResponseDto.fromEntity(entity));
  }
}
