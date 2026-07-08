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
  @ApiOperation({ summary: 'Get business catalog info' })
  @ApiResponse({ status: 200, description: 'Business catalog metadata for the session.' })
  async getCatalog(@Param('sessionId') sessionId: string) {
    return this.catalogService.getCatalog(sessionId);
  }

  @Get('catalog/products')
  @ApiOperation({ summary: 'List catalog products' })
  @ApiResponse({ status: 200, description: 'Paginated list of catalog products.' })
  async getProducts(@Param('sessionId') sessionId: string, @Query() query: ProductQueryDto) {
    return this.catalogService.getProducts(sessionId, query.page, query.limit);
  }

  @Get('catalog/products/:productId')
  @ApiOperation({ summary: 'Get a specific product' })
  @ApiResponse({ status: 200, description: 'The requested catalog product.' })
  async getProduct(@Param('sessionId') sessionId: string, @Param('productId') productId: string) {
    return this.catalogService.getProduct(sessionId, productId);
  }

  @Post('messages/send-product')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Send a product message' })
  @ApiResponse({ status: 201, description: 'Product message sent.' })
  async sendProduct(@Param('sessionId') sessionId: string, @Body() dto: SendProductDto) {
    return this.catalogService.sendProduct(sessionId, dto.chatId, dto.productId, dto.body);
  }

  @Post('messages/send-catalog')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Send catalog link' })
  @ApiResponse({ status: 201, description: 'Catalog link sent.' })
  async sendCatalog(@Param('sessionId') sessionId: string, @Body() dto: SendCatalogDto) {
    return this.catalogService.sendCatalog(sessionId, dto.chatId, dto.body);
  }
}
