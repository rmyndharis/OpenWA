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
} from 'class-validator';
import { Expose, plainToInstance } from 'class-transformer';
import { Webhook } from '../entities/webhook.entity';
import { WebhookFilters } from '../filters/filter-types';
import { IsValidWebhookFilters } from '../filters/filter-validation';
import { IsHeaderMap } from './is-header-map.validator';

const FILTERS_API_DESCRIPTION =
  'Optional smart pre-filter. When set, every condition must match (AND) for the webhook to fire. Omit or null to fire on every subscribed event.';
const FILTERS_API_EXAMPLE = {
  conditions: [
    { field: 'sender', operator: 'is', value: ['1234567890@c.us'] },
    { field: 'body', operator: 'contains', value: 'invoice' },
  ],
};

// Reserved: valid webhook subscription targets that are not dispatched yet (no engine
// emit source). Kept in WEBHOOK_EVENTS so existing subscriptions validate; tracked
// separately so the catalog/emitter drift guard can whitelist them as intentional.
export const WEBHOOK_RESERVED_EVENTS = ['group.join', 'group.leave', 'group.update'] as const;

export const WEBHOOK_EVENTS = [
  'message.received',
  'message.sent',
  'message.ack',
  'message.failed',
  'message.revoked',
  'message.reaction',
  'session.status',
  'session.qr',
  'session.authenticated',
  'session.disconnected',
  ...WEBHOOK_RESERVED_EVENTS,
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

export class CreateWebhookDto {
  @ApiProperty({
    description: 'Webhook URL to receive events',
    example: 'https://your-server.com/webhook',
  })
  // require_tld:false allows hostnames without a dot (e.g. http://localhost:3000); the SSRF
  // guard still decides whether the host is actually allowed to be delivered to.
  @IsUrl({ require_tld: false })
  url: string;

  @ApiPropertyOptional({
    description: "Event types to subscribe to. '*' subscribes to all events.",
    example: ['message.received', 'session.status'],
    enum: [...WEBHOOK_EVENTS, '*'],
    type: String,
    isArray: true,
    minItems: 1,
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
  @IsHeaderMap()
  headers?: Record<string, string>;

  @ApiPropertyOptional({ description: FILTERS_API_DESCRIPTION, example: FILTERS_API_EXAMPLE })
  @IsOptional()
  @IsValidWebhookFilters()
  filters?: WebhookFilters | null;

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
  @IsUrl({ require_tld: false })
  url?: string;

  @ApiPropertyOptional({
    description: "Event types to subscribe to. '*' subscribes to all events.",
    enum: [...WEBHOOK_EVENTS, '*'],
    type: String,
    isArray: true,
    minItems: 1,
  })
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
  @IsHeaderMap()
  headers?: Record<string, string>;

  @ApiPropertyOptional({ description: FILTERS_API_DESCRIPTION, example: FILTERS_API_EXAMPLE })
  @IsOptional()
  @IsValidWebhookFilters()
  filters?: WebhookFilters | null;

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
  @ApiPropertyOptional({ description: FILTERS_API_DESCRIPTION, example: FILTERS_API_EXAMPLE })
  filters?: WebhookFilters | null;

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
