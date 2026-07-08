import { Controller, Get, Query, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { RequireRole, CurrentApiKey } from '../auth/decorators/auth.decorators';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';
import { SearchService } from './search.service';
import { SearchQueryDto } from './dto/search-query.dto';
import type { SearchResults } from './search.types';

@ApiTags('search')
@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Search messages across sessions (active search provider)' })
  @ApiResponse({ status: 200, description: 'Search results from the active provider' })
  @ApiResponse({ status: 400, description: 'Empty or whitespace-only "q"' })
  @ApiResponse({ status: 501, description: 'No search provider configured' })
  @ApiQuery({ name: 'q', required: true, description: 'Search term (required, non-empty)' })
  @ApiQuery({ name: 'sessionId', required: false, description: 'Restrict to a single session' })
  @ApiQuery({ name: 'chatId', required: false, description: 'Restrict to a single chat id' })
  @ApiQuery({ name: 'direction', required: false, description: 'incoming | outgoing' })
  @ApiQuery({ name: 'type', required: false, description: 'Message type filter' })
  @ApiQuery({ name: 'from', required: false, description: 'Sender filter' })
  @ApiQuery({ name: 'dateFrom', required: false, description: 'Epoch-ms lower bound (inclusive)' })
  @ApiQuery({ name: 'dateTo', required: false, description: 'Epoch-ms upper bound (inclusive)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Max hits to return' })
  @ApiQuery({ name: 'offset', required: false, type: Number, description: 'Pagination offset' })
  async search(@Query() dto: SearchQueryDto, @CurrentApiKey() apiKey?: ApiKey): Promise<SearchResults> {
    if (!dto.q || !dto.q.trim()) {
      throw new BadRequestException('Query parameter "q" is required and must be non-empty.');
    }
    // callerSessionIds comes ONLY from the authenticated key's allowedSessions — never from the
    // query/body — so a scoped key cannot broaden its reach. A null/empty allowlist (e.g. ADMIN)
    // resolves to undefined → searches all sessions, mirroring GET /webhooks. The DTO carries no
    // `sessionIds` field (the global ValidationPipe's forbidNonWhitelisted would reject it anyway),
    // and SearchService makes scope authoritative by overwriting sessionIds at the provider boundary.
    return this.searchService.search(dto, apiKey?.allowedSessions ?? undefined);
  }
}
