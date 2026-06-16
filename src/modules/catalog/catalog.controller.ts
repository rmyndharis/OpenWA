import { Controller, Get, Post, Param, Body, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiSecurity } from '@nestjs/swagger';
import { CatalogService } from './catalog.service';
import { SendProductDto, SendCatalogDto, ProductQueryDto } from './dto/send-product.dto';

@ApiTags('Catalog')
@ApiSecurity('X-API-Key')
@Controller('sessions/:sessionId')
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  @Get('catalog')
  @ApiOperation({ summary: 'Get business catalog info' })
  async getCatalog(@Param('sessionId') sessionId: string) {
    return this.catalogService.getCatalog(sessionId);
  }

  @Get('catalog/products')
  @ApiOperation({ summary: 'List catalog products' })
  async getProducts(@Param('sessionId') sessionId: string, @Query() query: ProductQueryDto) {
    return this.catalogService.getProducts(sessionId, query.page, query.limit);
  }

  @Get('catalog/products/:productId')
  @ApiOperation({ summary: 'Get a specific product' })
  async getProduct(@Param('sessionId') sessionId: string, @Param('productId') productId: string) {
    return this.catalogService.getProduct(sessionId, productId);
  }

  @Post('messages/send-product')
  @ApiOperation({ summary: 'Send a product message' })
  async sendProduct(@Param('sessionId') sessionId: string, @Body() dto: SendProductDto) {
    return this.catalogService.sendProduct(sessionId, dto.chatId, dto.productId, dto.body);
  }

  @Post('messages/send-catalog')
  @ApiOperation({ summary: 'Send catalog link' })
  async sendCatalog(@Param('sessionId') sessionId: string, @Body() dto: SendCatalogDto) {
    return this.catalogService.sendCatalog(sessionId, dto.chatId, dto.body);
  }
}
