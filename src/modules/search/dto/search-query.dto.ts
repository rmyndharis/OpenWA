import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsEnum, IsNumber, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { MessageDirection } from '../../message/entities/message.entity';
import type { MessageType } from '../../../engine/interfaces/whatsapp-engine.interface';

/**
 * Request shape for GET /search. Numeric fields are coerced from query-string strings via
 * `@Type(() => Number)` and then validated with `@IsNumber()` — so `?limit=abc` (Number('abc') →
 * NaN) fails `@IsNumber()` and surfaces as a 400 from the global ValidationPipe, never reaching the
 * provider as a NaN SQL param. `sessionIds` is intentionally absent: scope is injected by
 * SearchService from the caller's API-key allowedSessions (never user-supplied).
 */
export class SearchQueryDto {
  @ApiProperty({ description: 'Search term (required, non-empty)' })
  @IsString()
  @IsNotEmpty()
  q: string;

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
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  dateFrom?: number;

  @ApiPropertyOptional({ description: 'Epoch-ms upper bound (inclusive)', type: Number })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  dateTo?: number;

  @ApiPropertyOptional({ description: 'Max hits to return', type: Number })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  limit?: number;

  @ApiPropertyOptional({ description: 'Pagination offset', type: Number })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  offset?: number;
}
