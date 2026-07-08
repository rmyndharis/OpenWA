import { IsString, IsOptional, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SendProductDto {
  @ApiProperty({ description: 'Chat to send the product card to (@c.us or @g.us).', example: '628123456789@c.us' })
  @IsString()
  chatId: string;

  @ApiProperty({ description: 'Catalog product id to send.', example: 'product-42' })
  @IsString()
  productId: string;

  @ApiPropertyOptional({ description: 'Optional body text accompanying the product card.', example: 'Back in stock!' })
  @IsOptional()
  @IsString()
  body?: string;
}

export class SendCatalogDto {
  @ApiProperty({ description: 'Chat to send the catalog to (@c.us or @g.us).', example: '628123456789@c.us' })
  @IsString()
  chatId: string;

  @ApiPropertyOptional({
    description: 'Optional body text accompanying the catalog.',
    example: 'Browse our full catalog',
  })
  @IsOptional()
  @IsString()
  body?: string;
}

export class ProductQueryDto {
  @ApiPropertyOptional({ description: 'Result page (1-based).', example: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ description: 'Page size.', example: 20, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 20;
}
