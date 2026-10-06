import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsEnum, IsInt, IsNumber, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { MessageDirection } from '../../message/entities/message.entity';
import type { MessageType } from '../../../engine/interfaces/whatsapp-engine.interface';
import { ToStrictNumber } from '../../../common/utils/strict-boolean';
import { SEARCH_OFFSET_MAX } from '../search.constants';

/**
 * Request shape for GET /search. Numeric fields are coerced from query-string strings via
 * `@Type(() => Number)` and then validated, so `?limit=abc` (Number('abc') → NaN) surfaces as a 400
 * from the global ValidationPipe, never reaching the provider as a NaN SQL param. The epoch-ms
 * bounds `dateFrom`/`dateTo` use `@IsNumber()`; `limit`/`offset` use `@IsInt()`, because they are
 * bound straight into `LIMIT ?`/`OFFSET ?` where better-sqlite3 rejects a fractional value with
 * SQLITE_MISMATCH: a fraction has to be a 400 here rather than a driver-level 500. `sessionIds` and
 * `chatIds` are intentionally absent: both scopes are injected by SearchService from the caller's
 * API-key allowedSessions/allowedChats (never user-supplied).
 */
export class SearchQueryDto {
  @ApiProperty({ description: 'Search term (required, non-empty)' })
  @IsString()
  @IsNotEmpty()
  q!: string;

  @ApiPropertyOptional({ description: 'Restrict to a single session' })
  @IsOptional()
  @IsString()
  sessionId?: string;

  @ApiPropertyOptional({ description: 'Restrict to a single chat id' })
  @IsOptional()
  @IsString()
  chatId?: string;

  @ApiPropertyOptional({ description: 'Sender filter' })
  @IsOptional()
  @IsString()
  from?: string;

  @ApiPropertyOptional({ enum: MessageDirection, description: 'incoming | outgoing' })
  @IsOptional()
  @IsEnum(MessageDirection)
  direction?: MessageDirection;

  @ApiPropertyOptional({ description: 'Message type filter (compared against stored messages.type)' })
  @IsOptional()
  @IsString()
  // `MessageType` is a string-literal union type alias, not a runtime enum, so @IsEnum can't validate
  // it. @IsString() accepts any string; the provider matches it against stored messages.type values.
  type?: MessageType;

  @ApiPropertyOptional({ description: 'Epoch-ms lower bound (inclusive)', type: Number })
  @ToStrictNumber()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  dateFrom?: number;

  @ApiPropertyOptional({ description: 'Epoch-ms upper bound (inclusive)', type: Number })
  @ToStrictNumber()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  dateTo?: number;

  @ApiPropertyOptional({ description: 'Max hits to return', type: 'integer', minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  @ApiPropertyOptional({
    description: `Pagination offset, at most ${SEARCH_OFFSET_MAX}`,
    type: 'integer',
    minimum: 0,
    maximum: SEARCH_OFFSET_MAX,
  })
  @IsOptional()
  @ToStrictNumber()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  // Rejected rather than clamped: a clamped offset silently returns the page at the cap again.
  @Max(SEARCH_OFFSET_MAX)
  offset?: number;
}
