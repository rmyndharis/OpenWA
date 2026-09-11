import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentApiKey, RequireRole, RequireUnscopedKey } from '../auth/decorators/auth.decorators';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';
import { ClientMappingService } from './client-mapping.service';
import type { ClientMappingKind } from './entities/client-mapping.entity';
import {
  CLIENT_MAPPING_KINDS,
  ClientMappingResponseDto,
  CreateClientMappingDto,
  ResolveAndUpsertClientMappingDto,
  ResolveAndUpsertResultDto,
  UpdateClientMappingDto,
} from './dto/client-mapping.dto';

/**
 * Deployment-global (no :sessionId route param) admin directory of clients/teammates/groups, so it
 * is gated to unscoped ADMIN keys rather than being scope-filtered per session — see
 * global-route-fence-coverage.spec.ts for why every global route needs one or the other.
 */
@ApiTags('client-mapping')
@Controller('client-mappings')
@RequireRole(ApiKeyRole.ADMIN)
@RequireUnscopedKey()
export class ClientMappingController {
  constructor(private readonly mappings: ClientMappingService) {}

  @Post()
  @ApiOperation({ summary: 'Create a client/teammate/group mapping' })
  @ApiResponse({ status: 201, description: 'Mapping created.', type: ClientMappingResponseDto })
  @ApiResponse({
    status: 400,
    description: 'Invalid mapping (missing sessionId for contact/group, bad timezone, etc).',
  })
  @ApiResponse({ status: 409, description: 'A mapping for this jid/kind (/session) already exists.' })
  async create(@Body() dto: CreateClientMappingDto): Promise<ClientMappingResponseDto> {
    return ClientMappingResponseDto.fromEntity(await this.mappings.create(dto));
  }

  @Post('resolve-and-upsert')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Resolve a contact/group jid to phone (@lid aware) and return its mapping, creating one only if none exists — by resolved phone first, then by jid. ' +
      'The shared path every automatic writer (auto-tag, Import from Chats) should use instead of its own create-if-missing logic — see docs/32 §5.',
  })
  @ApiResponse({ status: 200, description: 'Resolved (existing or newly created).', type: ResolveAndUpsertResultDto })
  async resolveAndUpsert(@Body() dto: ResolveAndUpsertClientMappingDto): Promise<ResolveAndUpsertResultDto> {
    const { mapping, created } = await this.mappings.resolveAndUpsert(dto);
    return { mapping: ClientMappingResponseDto.fromEntity(mapping), created };
  }

  @Get()
  @ApiOperation({ summary: 'List mappings, optionally filtered' })
  @ApiQuery({ name: 'sessionId', required: false })
  @ApiQuery({ name: 'kind', required: false, enum: CLIENT_MAPPING_KINDS })
  @ApiQuery({ name: 'company', required: false })
  @ApiResponse({ status: 200, type: ClientMappingResponseDto, isArray: true })
  async findAll(
    @CurrentApiKey() apiKey?: ApiKey,
    @Query('sessionId') sessionId?: string,
    @Query('kind') kind?: ClientMappingKind,
    @Query('company') company?: string,
  ): Promise<ClientMappingResponseDto[]> {
    const mappings = await this.mappings.findAll({ sessionId, kind, company }, apiKey?.allowedSessions);
    return mappings.map(mapping => ClientMappingResponseDto.fromEntity(mapping));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one mapping' })
  @ApiResponse({ status: 200, type: ClientMappingResponseDto })
  @ApiResponse({ status: 404, description: 'No such mapping.' })
  async findOne(@Param('id') id: string): Promise<ClientMappingResponseDto> {
    return ClientMappingResponseDto.fromEntity(await this.mappings.findOne(id));
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update a mapping' })
  @ApiResponse({ status: 200, type: ClientMappingResponseDto })
  @ApiResponse({ status: 404, description: 'No such mapping.' })
  async update(@Param('id') id: string, @Body() dto: UpdateClientMappingDto): Promise<ClientMappingResponseDto> {
    return ClientMappingResponseDto.fromEntity(await this.mappings.update(id, dto));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a mapping' })
  @ApiResponse({ status: 204, description: 'Mapping deleted.' })
  @ApiResponse({ status: 404, description: 'No such mapping.' })
  async remove(@Param('id') id: string): Promise<void> {
    await this.mappings.remove(id);
  }
}
