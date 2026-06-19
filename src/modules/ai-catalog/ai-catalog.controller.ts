import {
  Controller, Get, Post, Put, Delete,
  Param, Body, Query, UseInterceptors, UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
import { AiCatalogService } from './ai-catalog.service';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { CatalogItem } from './entities/catalog-item.entity';

@ApiTags('AI Catalog')
@Controller('sessions/:sessionId/ai-catalog')
export class AiCatalogController {
  constructor(private readonly svc: AiCatalogService) {}

  @Get()
  @ApiOperation({ summary: 'List AI catalog items for a session' })
  @ApiParam({ name: 'sessionId' })
  list(@Param('sessionId') sessionId: string): Promise<CatalogItem[]> {
    return this.svc.list(sessionId);
  }

  @Post('import-csv')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Import catalog items from a CSV file upload' })
  @UseInterceptors(FileInterceptor('file'))
  // ponytail: Express.Multer.File unavailable without @types/multer; any is safe here, buffer is always present from FileInterceptor
  async importCsv(@Param('sessionId') sessionId: string, @UploadedFile() file: any) {
    const content = file.buffer.toString('utf8');
    return this.svc.importCsv(sessionId, content);
  }

  @Post('import-json')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Import catalog items from JSON body' })
  importJson(@Param('sessionId') sessionId: string, @Body() body: { items: Partial<CatalogItem>[] }) {
    return this.svc.importJson(sessionId, body.items);
  }

  @Put(':itemId')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Update a catalog item' })
  update(
    @Param('sessionId') sessionId: string,
    @Param('itemId') itemId: string,
    @Body() data: Partial<CatalogItem>,
  ) {
    return this.svc.updateItem(itemId, sessionId, data);
  }

  @Delete(':itemId')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Delete a catalog item' })
  async delete(@Param('sessionId') sessionId: string, @Param('itemId') itemId: string) {
    await this.svc.deleteItem(itemId, sessionId);
    return { success: true };
  }

  @Post('re-embed')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Re-embed all catalog items for semantic search' })
  async reEmbed(@Param('sessionId') sessionId: string) {
    await this.svc.embedAll(sessionId);
    return { success: true };
  }

  @Get('search')
  @ApiOperation({ summary: 'Semantic search over catalog items' })
  @ApiQuery({ name: 'q', required: true })
  @ApiQuery({ name: 'topK', required: false })
  search(
    @Param('sessionId') sessionId: string,
    @Query('q') q: string,
    @Query('topK') topK?: string,
  ) {
    return this.svc.search(sessionId, q, topK ? parseInt(topK, 10) : 5);
  }

  @Post('ask')
  @ApiOperation({ summary: 'Answer a product question using the catalog' })
  ask(@Param('sessionId') sessionId: string, @Body() body: { question: string }) {
    return this.svc.answerQuery(sessionId, body.question);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Catalog stats: total, embedded, available' })
  stats(@Param('sessionId') sessionId: string) {
    return this.svc.stats(sessionId);
  }
}
