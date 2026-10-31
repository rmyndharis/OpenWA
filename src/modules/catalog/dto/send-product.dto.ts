import { IsString, IsOptional, IsInt, Min, IsNotEmpty, MaxLength, Matches } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MESSAGE_TEXT_MAX_LENGTH } from '../../message/dto/send-message.dto';
import { CHAT_ID_MAX_LENGTH, CHAT_JID_MESSAGE, CHAT_JID_PATTERN } from '../../message/dto/send-message.dto';
import { ToStrictString } from '../../../common/utils/strict-boolean';

/** WhatsApp catalog product ids are numeric strings of about 16-20 digits; this leaves wide headroom. */
export const PRODUCT_ID_MAX_LENGTH = 255;

export class SendProductDto {
  @ApiProperty({
    maxLength: CHAT_ID_MAX_LENGTH,
    description: 'Chat to send the product card to (@c.us or @g.us).',
    example: '628123456789@c.us',
  })
  @ToStrictString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(CHAT_ID_MAX_LENGTH)
  @Matches(CHAT_JID_PATTERN, { message: CHAT_JID_MESSAGE })
  chatId!: string;

  @ApiProperty({ description: 'Catalog product id to send.', example: 'product-42', maxLength: PRODUCT_ID_MAX_LENGTH })
  @ToStrictString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(PRODUCT_ID_MAX_LENGTH)
  productId!: string;

  @ApiPropertyOptional({
    description: 'Optional body text accompanying the product card.',
    example: 'Back in stock!',
    maxLength: MESSAGE_TEXT_MAX_LENGTH,
  })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @MaxLength(MESSAGE_TEXT_MAX_LENGTH)
  body?: string;
}

export class ProductQueryDto {
  @ApiPropertyOptional({ description: 'Result page (1-based).', example: 1, type: 'integer', minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ description: 'Page size.', example: 20, type: 'integer', minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 20;
}
