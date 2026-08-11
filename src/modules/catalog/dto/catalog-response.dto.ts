import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Response shapes for the catalog routes. These describe what the handlers already return — the
 * payload is the raw handler value, not an envelope — so that a change to the shape shows up as a
 * diff in the committed OpenAPI snapshot instead of reaching clients unannounced.
 *
 * Decorated properties avoid named utility types: emitDecoratorMetadata wraps a named type in a
 * runtime guard whose other arm can never execute, leaving an uncoverable branch.
 */
export class CatalogDto {
  @ApiProperty({
    description: 'Catalog id. Synthesized from the first collection — the only named grouping the engine exposes.',
    example: '1234567890123456',
  })
  id!: string;

  @ApiProperty({ description: 'Collection name.', example: 'Default' })
  name!: string;

  @ApiPropertyOptional({ description: 'Collection description, when the engine reports one.' })
  description?: string;

  @ApiProperty({ description: 'How many products the first collection holds.', example: 12 })
  productCount!: number;

  @ApiProperty({ description: 'Public catalog link for the account.', example: 'https://wa.me/c/628123456789' })
  url!: string;
}

export class ProductDto {
  @ApiProperty({ description: "Product id in the engine's native format.", example: '7891234567890' })
  id!: string;

  @ApiProperty({ description: 'Product name.', example: 'Kopi Gayo 200g' })
  name!: string;

  @ApiPropertyOptional({ description: 'Product description, when set.' })
  description?: string;

  @ApiProperty({ description: 'Price in the currency’s minor-unit-free numeric form.', example: 85000 })
  price!: number;

  @ApiProperty({ description: 'ISO currency code.', example: 'IDR' })
  currency!: string;

  @ApiProperty({
    description:
      'Price rendered for display. Synthesized by the gateway from price + currency, so an ' +
      'unrecognised currency code falls back to a plain "CODE amount" pair.',
    example: 'IDR 85,000.00',
  })
  priceFormatted!: string;

  @ApiPropertyOptional({
    description: 'First product image URL. Absent when the product carries no image.',
    example: 'https://pps.whatsapp.net/v/t61.24694-24/12345_678_910_n.jpg',
  })
  imageUrl?: string;

  @ApiProperty({ description: 'Product link, empty when the engine reports none.', example: 'https://wa.me/p/123/628' })
  url!: string;

  @ApiProperty({ description: 'Whether the engine reports the product as in stock.', example: true })
  isAvailable!: boolean;

  @ApiPropertyOptional({ description: "The merchant's own SKU, when set.", example: 'SKU-001' })
  retailerId?: string;
}

export class ProductPaginationDto {
  @ApiProperty({ description: 'Page that was returned (1-based).', example: 1 })
  page!: number;

  @ApiProperty({ description: 'Page size that was applied.', example: 20 })
  limit!: number;

  @ApiProperty({ description: 'Total products in the catalog, not on this page.', example: 12 })
  total!: number;

  @ApiProperty({ description: 'Total pages at this page size.', example: 1 })
  totalPages!: number;
}

export class PaginatedProductsDto {
  @ApiProperty({ type: [ProductDto], description: 'Products on the requested page.' })
  products!: ProductDto[];

  @ApiProperty({ type: ProductPaginationDto })
  pagination!: ProductPaginationDto;
}

/**
 * What POST /messages/send-product answers.
 *
 * Deliberately NOT MessageResponseDto: this route returns the engine's MessageResult unmapped, so
 * the id field is `id`, whereas every route that goes through MessageService answers `messageId`.
 * Documenting it as `messageId` here would be a contract that the code does not honour.
 */
export class ProductMessageResponseDto {
  @ApiProperty({
    description:
      'The message id, assigned when the gateway accepts the message for sending. Note the field ' +
      'name: the send routes served by MessageService answer `messageId` for the same value. A 2xx ' +
      'here means the message was handed to the WhatsApp client, not that it was delivered.\n\n' +
      'This route is Baileys-only, so the id is the bare key id Baileys assigns — not the ' +
      '`true_<jid>_<id>` serialized form the whatsapp-web.js send routes report.',
    example: '3EB0C767D26B8A3F6E',
  })
  id!: string;

  @ApiProperty({ description: 'Unix SECONDS the engine stamped on the outgoing message.', example: 1786000000 })
  timestamp!: number;
}
