import { Controller, Get, Post, Param, Body, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { CatalogService } from './catalog.service';
import { SendProductDto, SendCatalogDto, ProductQueryDto } from './dto/send-product.dto';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';

@ApiTags('catalog')
@Controller('sessions/:sessionId')
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  @Get('catalog')
  @ApiOperation({ summary: 'Get business catalog info (Baileys engine only)' })
  @ApiResponse({
    status: 501,
    description: 'Not supported by the active engine: whatsapp-web.js has no catalog API.',
  })
  async getCatalog(@Param('sessionId') sessionId: string) {
    return this.catalogService.getCatalog(sessionId);
  }

  @Get('catalog/products')
  @ApiOperation({ summary: 'List catalog products (Baileys engine only)' })
  @ApiResponse({
    status: 501,
    description: 'Not supported by the active engine: whatsapp-web.js has no catalog API.',
  })
  async getProducts(@Param('sessionId') sessionId: string, @Query() query: ProductQueryDto) {
    return this.catalogService.getProducts(sessionId, query.page, query.limit);
  }

  @Get('catalog/products/:productId')
  @ApiOperation({ summary: 'Get a specific product (Baileys engine only)' })
  @ApiResponse({
    status: 501,
    description: 'Not supported by the active engine: whatsapp-web.js has no catalog API.',
  })
  async getProduct(@Param('sessionId') sessionId: string, @Param('productId') productId: string) {
    return this.catalogService.getProduct(sessionId, productId);
  }

  @Post('messages/send-product')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Send a product message (Baileys engine only)' })
  @ApiResponse({ status: 404, description: 'Product id not found in the session catalog.' })
  @ApiResponse({ status: 400, description: 'Product has no image — a product card requires one.' })
  @ApiResponse({
    status: 501,
    description: 'Not supported by the active engine: whatsapp-web.js cannot send product messages.',
  })
  async sendProduct(@Param('sessionId') sessionId: string, @Body() dto: SendProductDto) {
    return this.catalogService.sendProduct(sessionId, dto.chatId, dto.productId, dto.body);
  }

  @Post('messages/send-catalog')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Send catalog link (not supported by any engine)' })
  @ApiResponse({ status: 501, description: 'Not supported by the active engine: no engine can send catalog links.' })
  async sendCatalog(@Param('sessionId') sessionId: string, @Body() dto: SendCatalogDto) {
    return this.catalogService.sendCatalog(sessionId, dto.chatId, dto.body);
  }
}
