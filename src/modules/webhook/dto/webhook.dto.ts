import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { Expose, plainToInstance } from 'class-transformer';
import { Webhook } from '../entities/webhook.entity';
import { MAX_CONDITIONS } from '../filters/filter-types';
import type { FilterOperator, WebhookFilters } from '../filters/filter-types';
import { IsValidWebhookFilters } from '../filters/filter-validation';
import { IsHeaderMap } from './is-header-map.validator';
import { ToStrictBoolean, ToStrictNumber } from '../../../common/utils/strict-boolean';
import { MaxCodePoints } from '../../../common/validation/max-code-points';

/**
 * Swagger metadata for the smart-filter shape — `WebhookFilters` in filters/filter-types.ts is a
 * plain interface (validated at runtime by @IsValidWebhookFilters), which the scanner cannot
 * introspect: without these classes the `filters` field on every webhook DTO degraded to a bare
 * `{ "type": "object" }` in openapi.json, describing NEITHER side of the wire. Metadata only —
 * no validators here; the runtime types stay authoritative.
 */
class WebhookFilterConditionDto {
  @ApiProperty({ example: 'sender', description: 'Filterable field for the fired event family.' })
  field!: string;

  @ApiProperty({ enum: ['is', 'isNot', 'contains', 'equals'], example: 'is' })
  operator!: FilterOperator;

  @ApiProperty({
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }, { type: 'boolean' }],
    example: ['1234567890@c.us'],
  })
  value!: string | string[] | boolean;

  @ApiPropertyOptional({ description: 'Only meaningful for text fields. Defaults to false.' })
  caseSensitive?: boolean;
}

class WebhookFiltersDto {
  @ApiProperty({
    type: [WebhookFilterConditionDto],
    maxItems: MAX_CONDITIONS,
    description:
      'Every condition must match (AND) for the webhook to fire. An empty list means no filter: the webhook fires on every subscribed event.',
  })
  conditions!: WebhookFilterConditionDto[];
}

const FILTERS_API_DESCRIPTION =
  'Optional smart pre-filter. When set, every condition must match (AND) for the webhook to fire. Omit or null to fire on every subscribed event.';
// An update applies `filters` only when the field is present, so omission keeps the stored filter.
const UPDATE_FILTERS_API_DESCRIPTION =
  'Optional smart pre-filter. When set, every condition must match (AND) for the webhook to fire. Omit to keep the stored filters; send null or { conditions: [] } to clear them, so the webhook fires on every subscribed event.';
const FILTERS_API_EXAMPLE = {
  conditions: [
    { field: 'sender', operator: 'is', value: ['1234567890@c.us'] },
    { field: 'body', operator: 'contains', value: 'invoice' },
  ],
};

// Reserved: valid webhook subscription targets that are declared but have no engine emit
// source yet. Currently EMPTY — the former occupants (group.join/leave/update) are now
// dispatched by both engines. Kept as a named export so the catalog/emitter drift guard
// can whitelist any future intentionally-undeployed event without changing its imports.
export const WEBHOOK_RESERVED_EVENTS = [] as const;

export const WEBHOOK_EVENTS = [
  'message.received',
  'message.sent',
  'message.ack',
  'message.failed',
  'message.revoked',
  'message.reaction',
  'message.edited',
  'status.received',
  'session.status',
  'session.qr',
  'session.authenticated',
  'session.disconnected',
  'session.reconnect_loop',
  'session.restriction',
  'presence.update',
  'event.response',
  'group.join',
  'group.leave',
  'group.update',
  'group.join_request',
  'call.received',
  'call.accepted',
  'call.rejected',
  'call.missed',
  ...WEBHOOK_RESERVED_EVENTS,
] as const;

const WEBHOOK_URL_OPTIONS = { require_tld: false, require_protocol: true, protocols: ['http', 'https'] };

export class CreateWebhookDto {
  @ApiProperty({
    description: 'Webhook URL to receive events',
    example: 'https://your-server.com/webhook',
    maxLength: 2048,
  })
  // require_tld:false allows hostnames without a dot (e.g. http://localhost:3000); the SSRF
  // guard still decides whether the host is actually allowed to be delivered to. The scheme is
  // required and must be http(s): the defaults also took 'example.com/hook' and 'ftp://...', which
  // were stored and then failed every delivery. 2048 is the column width; PostgreSQL refuses a
  // longer value on insert with a 500.
  @IsUrl(WEBHOOK_URL_OPTIONS)
  @MaxCodePoints(2048)
  url!: string;

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
    description:
      'Secret key for HMAC signature verification. Never returned by any webhook route; it is used to ' +
      'compute the `X-OpenWA-Signature: sha256=<hex>` header on every delivery.',
    // Both bounds are spelled out because @MinLength/@MaxLength do not reach the published schema on
    // their own, and the example must satisfy them: the previous 15-character one was rejected by the
    // very route that offered it, so pasting it back from Swagger answered 400
    // ([#1491](https://github.com/rmyndharis/OpenWA/issues/1491)).
    minLength: 16,
    maxLength: 255,
    example: 'your-webhook-signing-secret',
  })
  @IsOptional()
  @IsString()
  // A short secret signs webhooks badly: HMAC-SHA256 over a 4-char key is brute-forcible from one
  // observed signature. 16 is the floor, not a recommendation.
  @MinLength(16)
  @MaxCodePoints(255)
  secret?: string;

  @ApiPropertyOptional({
    description:
      'Custom headers to include in webhook requests. Names must be unique ignoring case. Never returned by ' +
      'any webhook route. At delivery, `content-type`, `user-agent` and `x-openwa-*` names are stripped so a ' +
      'custom header cannot shadow a system one, ' +
      'and so are the connection-level names the HTTP client owns (`connection`, `content-length`, ' +
      '`expect`, `keep-alive`, `te`, `trailer`, `transfer-encoding`, `upgrade`).',
    example: { 'X-Custom-Header': 'value' },
  })
  @IsOptional()
  @IsHeaderMap()
  headers?: Record<string, string>;

  // `nullable` spelled out for the same reason lastTriggeredAt spells out its type: the field is
  // STORED as null whenever a webhook is created without filters (`dto.filters ?? null`), and the
  // description offers null as an input, so a schema without it rejects a value the route both
  // sends and accepts.
  @ApiPropertyOptional({
    type: WebhookFiltersDto,
    description: FILTERS_API_DESCRIPTION,
    example: FILTERS_API_EXAMPLE,
    nullable: true,
  })
  @IsOptional()
  @IsValidWebhookFilters()
  filters?: WebhookFilters | null;

  @ApiPropertyOptional({
    description:
      'Total delivery attempts per event, including the first (0 and 1 both mean a single attempt with no ' +
      'retry). An event that exhausts them is recorded in GET /api/webhooks/delivery-failures; the webhook ' +
      'stays active.',
    example: 3,
    minimum: 0,
    maximum: 5,
  })
  @ToStrictNumber()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5)
  retryCount?: number;
}

export class UpdateWebhookDto {
  @ApiPropertyOptional({ description: 'Webhook URL', maxLength: 2048 })
  // Not @IsOptional: that also skips validation for null, which these NOT NULL columns cannot store
  // (save() then failed with a 500). Only an omitted field means "leave unchanged".
  @ValidateIf((_: UpdateWebhookDto, v: unknown) => v !== undefined)
  @IsUrl(WEBHOOK_URL_OPTIONS)
  @MaxCodePoints(2048)
  url?: string;

  @ApiPropertyOptional({
    description: "Event types to subscribe to. '*' subscribes to all events.",
    enum: [...WEBHOOK_EVENTS, '*'],
    type: String,
    isArray: true,
    minItems: 1,
  })
  @ValidateIf((_: UpdateWebhookDto, v: unknown) => v !== undefined)
  @IsArray()
  @ArrayMinSize(1)
  @IsIn([...WEBHOOK_EVENTS, '*'], { each: true })
  events?: string[];

  @ApiPropertyOptional({
    // No `minLength` here, unlike create: this route also accepts the empty string as "clear the
    // secret", so a 16 in the schema would reject a value the route honours. The floor still applies
    // to every other value, which only the description can say.
    description:
      'Secret key for HMAC signature. At least 16 characters, or an empty string to clear it. ' +
      'Never returned by any webhook route.',
    maxLength: 255,
    // Deliberately no `example`, unlike create. This route patches a webhook that is already
    // signing deliveries, and a prefilled secret submitted whole would replace a working key with
    // a published one: every later delivery still verifies, so nothing looks broken while the
    // signature is forgeable by anyone reading these docs. The floor belongs in the description
    // here, where it costs a `400` to ignore rather than a silent downgrade.
  })
  @IsOptional()
  @IsString()
  // Same floor as create: a short secret is brute-forcible from one observed signature. The
  // floor is skipped only for the empty string, which this route treats as "clear the secret"
  // (the service stores null for it); a non-string value is still rejected by @IsString.
  @ValidateIf((o: UpdateWebhookDto) => o.secret !== '')
  @MinLength(16)
  @MaxCodePoints(255)
  secret?: string;

  @ApiPropertyOptional({
    description: 'Custom headers. Replaces the stored map wholesale. Never returned by any webhook route.',
    example: { 'X-Custom-Header': 'value' },
  })
  @ValidateIf((_: UpdateWebhookDto, v: unknown) => v !== undefined)
  @IsHeaderMap()
  headers?: Record<string, string>;

  // `nullable` spelled out for the same reason lastTriggeredAt spells out its type: the field is
  // STORED as null whenever a webhook is created without filters (`dto.filters ?? null`), and the
  // description offers null as an input, so a schema without it rejects a value the route both
  // sends and accepts.
  @ApiPropertyOptional({
    type: WebhookFiltersDto,
    description: UPDATE_FILTERS_API_DESCRIPTION,
    example: FILTERS_API_EXAMPLE,
    nullable: true,
  })
  @IsOptional()
  @IsValidWebhookFilters()
  filters?: WebhookFilters | null;

  @ApiPropertyOptional({ description: 'Enable/disable webhook' })
  @ToStrictBoolean()
  @ValidateIf((_: UpdateWebhookDto, v: unknown) => v !== undefined)
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({
    description:
      'Total delivery attempts per event, including the first (0 and 1 both mean a single attempt). Same ' +
      'range the create route enforces.',
    example: 3,
    minimum: 0,
    maximum: 5,
  })
  @ToStrictNumber()
  @ValidateIf((_: UpdateWebhookDto, v: unknown) => v !== undefined)
  @IsInt()
  @Min(0)
  @Max(5)
  retryCount?: number;
}

/**
 * Public response shape for a webhook. Deliberately omits `secret` (the HMAC
 * signing key) and `headers` (which may carry receiver credentials) — these are
 * write-only and never appear in a response built from this DTO. The backup route
 * (`GET /api/infra/export-data`) also omits both from its webhook rows.
 *
 * `@Expose()` is required on every field: `fromEntity` maps with
 * `excludeExtraneousValues: true`, so only exposed fields are serialized and any
 * undeclared entity field (secret, headers, the session relation) is dropped.
 */
export class WebhookResponseDto {
  @Expose()
  @ApiProperty()
  id!: string;

  @Expose()
  @ApiProperty()
  sessionId!: string;

  @Expose()
  @ApiProperty()
  url!: string;

  @Expose()
  // Same vocabulary the create and update bodies validate against: the stored list can only hold
  // values those routes accepted. Publishing a bare string[] understated the response, and left
  // every client's typed event list comparing against `array<string>` instead of the enum.
  @ApiProperty({ enum: [...WEBHOOK_EVENTS, '*'], type: String, isArray: true })
  events!: string[];

  @Expose()
  // `nullable` spelled out for the same reason lastTriggeredAt spells out its type: the field is
  // STORED as null whenever a webhook is created without filters (`dto.filters ?? null`), and the
  // description offers null as an input, so a schema without it rejects a value the route both
  // sends and accepts.
  @ApiPropertyOptional({
    type: WebhookFiltersDto,
    description: FILTERS_API_DESCRIPTION,
    example: FILTERS_API_EXAMPLE,
    nullable: true,
  })
  filters?: WebhookFilters | null;

  @Expose()
  @ApiProperty()
  active!: boolean;

  @Expose()
  @ApiProperty()
  retryCount!: number;

  @Expose()
  // Spelled out because a bare @ApiPropertyOptional() on `Date | null` emits `type: object`, and the
  // published schema then rejects both values this field actually carries.
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  lastTriggeredAt?: Date | null;

  @Expose()
  @ApiProperty()
  createdAt!: Date;

  @Expose()
  @ApiProperty()
  updatedAt!: Date;

  static fromEntity(entity: Webhook): WebhookResponseDto {
    return plainToInstance(WebhookResponseDto, entity, { excludeExtraneousValues: true });
  }

  static fromEntities(entities: Webhook[]): WebhookResponseDto[] {
    return entities.map(entity => WebhookResponseDto.fromEntity(entity));
  }
}

/**
 * A webhook delivery that exhausted its retries, or one not sent (attempts 0); the shape
 * `GET /webhooks/delivery-failures` serves. A shed or shutdown-refused delivery is replayed by the outbox
 * sweep; one rejected before sending (an over-cap or unserializable payload) is recorded once and not
 * replayed. A later successful delivery removes the row.
 */
export class WebhookDeliveryFailureDto {
  @ApiProperty({ example: '0a941dac-a965-45e7-b318-74ae8be134f0' })
  id!: string;

  @ApiProperty({ example: '0a941dac-a965-45e7-b318-74ae8be134f0' })
  webhookId!: string;

  @ApiProperty({ example: '0a941dac-a965-45e7-b318-74ae8be134f0' })
  sessionId!: string;

  @ApiProperty({ example: 'message.received' })
  event!: string;

  @ApiProperty({ example: 'https://receiver.example.com/hook' })
  url!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'The idempotency key the receiver would have deduped on.',
  })
  idempotencyKey?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  deliveryId?: string | null;

  @ApiProperty({
    description:
      'Attempts recorded for the delivery; 0 when it was shed, refused or failed before sending. With the ' +
      'queue disabled, a delivery that shutdown caught in a retry backoff also records 0, although earlier ' +
      'attempts were sent.',
    example: 5,
  })
  attempts!: number;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description: 'Last HTTP status when the failure was a non-2xx response; null for a network/timeout error.',
    example: null,
  })
  lastStatusCode?: number | null;

  @ApiProperty({ example: 'fetch failed' })
  lastError!: string;

  @ApiProperty({ type: String, format: 'date-time', description: 'When the failure was first recorded.' })
  createdAt!: Date;

  @ApiProperty({
    description:
      'True when the row still holds the event data and can be replayed with ' +
      '`POST /webhooks/delivery-failures/redrive`. Only terminal rows (attempts > 0) recorded while ' +
      '`WEBHOOK_FAILURE_PAYLOAD_RETENTION_HOURS` > 0 are, until that window passes.',
    example: false,
  })
  replayable!: boolean;
}

/** Body of `POST /webhooks/delivery-failures/redrive`. Every field narrows; an empty body takes eligible rows with the fewest attempts. */
export class RedriveWebhookDeliveriesDto {
  @ApiPropertyOptional({
    description: "Only rows of this session. Narrows within the calling key's allowedSessions, never past it.",
    example: 'my-session',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  sessionId?: string;

  @ApiPropertyOptional({ description: 'Only rows of this webhook.', example: '0a941dac-a965-45e7-b318-74ae8be134f0' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  webhookId?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Only these failure rows (ids from `GET /webhooks/delivery-failures`).',
    example: ['0a941dac-a965-45e7-b318-74ae8be134f0'],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(128, { each: true })
  ids?: string[];

  @ApiPropertyOptional({ description: 'Max rows replayed by this call (1-500, default 100).', example: 100 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

/** Outcome of `POST /webhooks/delivery-failures/redrive`. */
export class WebhookRedriveResultDto {
  @ApiProperty({ description: 'Rows replayed by this call; equals delivered.', example: 2 })
  redriven!: number;

  @ApiProperty({ description: 'Delivered by a direct POST; their failure rows were removed.', example: 2 })
  delivered!: number;

  @ApiProperty({
    description: 'Reserved for response compatibility; operator redrive uses direct POST and returns zero.',
    example: 0,
  })
  enqueued!: number;

  @ApiProperty({ description: 'Replays that failed again; their rows stay, with attempts raised by one.', example: 0 })
  failed!: number;

  @ApiProperty({
    description: 'Rows not replayed: the webhook was removed, disabled or unsubscribed, or a plugin cancelled it.',
    example: 0,
  })
  skipped!: number;

  @ApiProperty({ description: 'Replayable rows still in scope after this call.', example: 0 })
  remaining!: number;
}

/** Outcome of `POST /sessions/:sessionId/webhooks/:id/test`. */
export class WebhookTestResponseDto {
  @ApiProperty({ description: 'True when the receiver answered 2xx.', example: true })
  success!: boolean;

  @ApiPropertyOptional({ description: 'The HTTP status the receiver answered, when it answered.', example: 200 })
  statusCode?: number;

  @ApiPropertyOptional({ description: 'The delivery error, when the attempt failed.', example: 'timeout' })
  error?: string;
}
