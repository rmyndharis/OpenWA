import { Controller, Get, Query, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { SearchResultsResponseDto } from './dto/search-response.dto';
import { ChatScoped, CurrentApiKey, RequireRole } from '../auth/decorators/auth.decorators';
import { ChatScopeService } from '../auth/chat-scope.service';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';
import { SearchService } from './search.service';
import { SearchQueryDto } from './dto/search-query.dto';
import { SEARCH_OFFSET_MAX } from './search.constants';
import type { SearchResults } from './search.types';

@ApiTags('search')
@Controller('search')
export class SearchController {
  constructor(
    private readonly searchService: SearchService,
    private readonly chatScope: ChatScopeService,
  ) {}

  @ChatScoped('filtered')
  @Get()
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Search messages across sessions (active search provider)' })
  @ApiResponse({ status: 200, description: 'Search results from the active provider', type: SearchResultsResponseDto })
  @ApiResponse({ status: 400, description: 'Empty or whitespace-only "q"' })
  @ApiResponse({ status: 403, description: 'Chat scope denied or chat-restricted search uses a plugin provider' })
  @ApiResponse({ status: 501, description: 'No search provider configured' })
  @ApiResponse({
    status: 502,
    description:
      'The active plugin search provider returned a result shape that failed validation, so nothing ' +
      'trustworthy could be forwarded. The built-in provider never returns this.',
  })
  @ApiResponse({
    status: 503,
    description:
      'The active plugin search provider did not answer: its worker is not running, timed out, or reported ' +
      'a failure. The built-in provider never returns this. Retryable.',
  })
  @ApiQuery({ name: 'q', required: true, description: 'Search term (required, non-empty)' })
  @ApiQuery({ name: 'sessionId', required: false, description: 'Restrict to a single session' })
  @ApiQuery({ name: 'chatId', required: false, description: 'Restrict to a single chat id' })
  @ApiQuery({ name: 'direction', required: false, description: 'incoming | outgoing' })
  @ApiQuery({ name: 'type', required: false, description: 'Message type filter' })
  @ApiQuery({ name: 'from', required: false, description: 'Sender filter' })
  @ApiQuery({ name: 'dateFrom', required: false, description: 'Epoch-ms lower bound (inclusive)' })
  @ApiQuery({ name: 'dateTo', required: false, description: 'Epoch-ms upper bound (inclusive)' })
  @ApiQuery({ name: 'limit', required: false, type: 'integer', description: 'Max hits to return' })
  @ApiQuery({
    name: 'offset',
    required: false,
    type: 'integer',
    description: `Pagination offset, at most ${SEARCH_OFFSET_MAX}`,
  })
  async search(@Query() dto: SearchQueryDto, @CurrentApiKey() apiKey?: ApiKey): Promise<SearchResults> {
    if (!dto.q || !dto.q.trim()) {
      throw new BadRequestException('Query parameter "q" is required and must be non-empty.');
    }
    // callerSessionIds comes ONLY from the authenticated key's allowedSessions — never from the
    // query/body — so a scoped key cannot broaden its reach; the same holds for the chat scope,
    // expanded lid-aware here and applied inside the providers BEFORE limit/offset/total. A null/empty
    // session allowlist (e.g. ADMIN) resolves to undefined → searches all sessions, mirroring GET
    // /webhooks. The DTO carries no `sessionIds` or `chatIds` field (the global ValidationPipe's
    // forbidNonWhitelisted would reject it anyway), and SearchService makes both scopes authoritative
    // by overwriting them at the provider boundary. An optional `?chatId=` is additionally fenced by
    // the guard against the key's allowlist, so a restricted key cannot name another chat either.
    const chatIds = await this.chatScope.idsForFilter(apiKey);
    return this.searchService.search(dto, apiKey?.allowedSessions ?? undefined, chatIds);
  }
}
