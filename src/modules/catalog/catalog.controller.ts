import { Controller, Get, Post, Param, Body, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { CatalogService } from './catalog.service';
import { SendProductDto, SendCatalogDto, ProductQueryDto } from './dto/send-product.dto';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { CatalogDto, PaginatedProductsDto, ProductDto, ProductMessageResponseDto } from './dto/catalog-response.dto';
import { ENGINE_NOT_READY_409, SESSION_NOT_STARTED_404 } from '../../common/openapi/engine-status-responses';

/**
 * Every catalog read walks WhatsApp's business-catalog IQ, which the server simply leaves
 * unanswered for an account without a catalog. The adapter bounds that walk with its own budget
 * rather than reporting an unanswered query as an empty catalog.
 */
const CATALOG_TIMEOUT_503 = 'WhatsApp did not answer the catalog query within the request budget — retry shortly.';

@ApiTags('catalog')
@Controller('sessions/:sessionId')
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  @Get('catalog')
  @ApiOperation({ summary: 'Get business catalog info (Baileys engine only)' })
  @ApiResponse({
    status: 200,
    description: 'Catalog summary, or an empty body when the account has no collection to describe.',
    type: CatalogDto,
  })
  @ApiResponse({
    status: 501,
    description: 'Not supported by the active engine: whatsapp-web.js has no catalog API.',
  })
  @ApiResponse({ status: 503, description: CATALOG_TIMEOUT_503 })
  @ApiResponse({ status: 409, description: ENGINE_NOT_READY_409 })
  @ApiResponse({ status: 404, description: SESSION_NOT_STARTED_404 })
  async getCatalog(@Param('sessionId') sessionId: string) {
    return this.catalogService.getCatalog(sessionId);
  }

  @Get('catalog/products')
  @ApiOperation({ summary: 'List catalog products (Baileys engine only)' })
  @ApiResponse({ status: 200, description: 'One page of catalog products', type: PaginatedProductsDto })
  @ApiResponse({
    status: 501,
    description: 'Not supported by the active engine: whatsapp-web.js has no catalog API.',
  })
  @ApiResponse({ status: 503, description: CATALOG_TIMEOUT_503 })
  @ApiResponse({ status: 409, description: ENGINE_NOT_READY_409 })
  @ApiResponse({ status: 404, description: SESSION_NOT_STARTED_404 })
  async getProducts(@Param('sessionId') sessionId: string, @Query() query: ProductQueryDto) {
    return this.catalogService.getProducts(sessionId, query.page, query.limit);
  }

  @Get('catalog/products/:productId')
  @ApiOperation({ summary: 'Get a specific product (Baileys engine only)' })
  @ApiResponse({
    status: 200,
    description: 'The product, or an empty body when no product in the catalog carries that id.',
    type: ProductDto,
  })
  @ApiResponse({
    status: 501,
    description: 'Not supported by the active engine: whatsapp-web.js has no catalog API.',
  })
  @ApiResponse({ status: 503, description: CATALOG_TIMEOUT_503 })
  @ApiResponse({ status: 409, description: ENGINE_NOT_READY_409 })
  @ApiResponse({ status: 404, description: SESSION_NOT_STARTED_404 })
  async getProduct(@Param('sessionId') sessionId: string, @Param('productId') productId: string) {
    return this.catalogService.getProduct(sessionId, productId);
  }

  @Post('messages/send-product')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Send a product message (Baileys engine only)' })
  @ApiResponse({ status: 201, description: 'Product message accepted for sending', type: ProductMessageResponseDto })
  @ApiResponse({ status: 404, description: 'Product id not found in the session catalog.' })
  @ApiResponse({ status: 400, description: 'Product has no image — a product card requires one.' })
  @ApiResponse({
    status: 501,
    description: 'Not supported by the active engine: whatsapp-web.js cannot send product messages.',
  })
  @ApiResponse({ status: 503, description: CATALOG_TIMEOUT_503 })
  @ApiResponse({ status: 409, description: ENGINE_NOT_READY_409 })
  async sendProduct(@Param('sessionId') sessionId: string, @Body() dto: SendProductDto) {
    return this.catalogService.sendProduct(sessionId, dto.chatId, dto.productId, dto.body);
  }

  @Post('messages/send-catalog')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Send catalog link (not supported by any engine)' })
  @ApiResponse({ status: 501, description: 'Not supported by the active engine: no engine can send catalog links.' })
  @ApiResponse({ status: 409, description: ENGINE_NOT_READY_409 })
  @ApiResponse({ status: 404, description: SESSION_NOT_STARTED_404 })
  async sendCatalog(@Param('sessionId') sessionId: string, @Body() dto: SendCatalogDto) {
    return this.catalogService.sendCatalog(sessionId, dto.chatId, dto.body);
  }
}
