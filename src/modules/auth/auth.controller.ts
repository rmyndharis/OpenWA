import { Controller, Get, Post, Put, Delete, Body, Param, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiSecurity } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { CreateApiKeyDto, UpdateApiKeyDto, ApiKeyResponseDto, ApiKeyCreatedResponseDto } from './dto';
import { RequireRole } from './decorators/auth.decorators';
import { ApiKeyRole } from './entities/api-key.entity';

@ApiTags('auth')
@ApiSecurity('X-API-Key')
@Controller('auth/api-keys')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post()
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Create a new API key (admin only)' })
  @ApiResponse({
    status: 201,
    description: 'API key created',
    type: ApiKeyCreatedResponseDto,
  })
  async create(@Body() dto: CreateApiKeyDto): Promise<ApiKeyCreatedResponseDto> {
    const { apiKey, rawKey } = await this.authService.createApiKey(dto);
    return {
      id: apiKey.id,
      name: apiKey.name,
      keyPrefix: apiKey.keyPrefix,
      role: apiKey.role,
      allowedIps: apiKey.allowedIps || undefined,
      allowedSessions: apiKey.allowedSessions || undefined,
      isActive: apiKey.isActive,
      expiresAt: apiKey.expiresAt || undefined,
      lastUsedAt: apiKey.lastUsedAt || undefined,
      usageCount: apiKey.usageCount,
      createdAt: apiKey.createdAt,
      apiKey: rawKey,
    };
  }

  @Get()
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'List all API keys (admin only)' })
  @ApiResponse({ status: 200, type: [ApiKeyResponseDto] })
  async findAll(): Promise<ApiKeyResponseDto[]> {
    const keys = await this.authService.findAll();
    return keys.map(k => ({
      id: k.id,
      name: k.name,
      keyPrefix: k.keyPrefix,
      role: k.role,
      allowedIps: k.allowedIps || undefined,
      allowedSessions: k.allowedSessions || undefined,
      isActive: k.isActive,
      expiresAt: k.expiresAt || undefined,
      lastUsedAt: k.lastUsedAt || undefined,
      usageCount: k.usageCount,
      createdAt: k.createdAt,
    }));
  }

  @Get(':id')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Get API key details (admin only)' })
  @ApiResponse({ status: 200, type: ApiKeyResponseDto })
  async findOne(@Param('id') id: string): Promise<ApiKeyResponseDto> {
    const k = await this.authService.findOne(id);
    return {
      id: k.id,
      name: k.name,
      keyPrefix: k.keyPrefix,
      role: k.role,
      allowedIps: k.allowedIps || undefined,
      allowedSessions: k.allowedSessions || undefined,
      isActive: k.isActive,
      expiresAt: k.expiresAt || undefined,
      lastUsedAt: k.lastUsedAt || undefined,
      usageCount: k.usageCount,
      createdAt: k.createdAt,
    };
  }

  @Put(':id')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Update API key (admin only)' })
  @ApiResponse({ status: 200, type: ApiKeyResponseDto })
  async update(@Param('id') id: string, @Body() dto: UpdateApiKeyDto): Promise<ApiKeyResponseDto> {
    const k = await this.authService.update(id, dto);
    return {
      id: k.id,
      name: k.name,
      keyPrefix: k.keyPrefix,
      role: k.role,
      allowedIps: k.allowedIps || undefined,
      allowedSessions: k.allowedSessions || undefined,
      isActive: k.isActive,
      expiresAt: k.expiresAt || undefined,
      lastUsedAt: k.lastUsedAt || undefined,
      usageCount: k.usageCount,
      createdAt: k.createdAt,
    };
  }

  @Delete(':id')
  @RequireRole(ApiKeyRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete API key (admin only)' })
  @ApiResponse({ status: 204, description: 'API key deleted' })
  async delete(@Param('id') id: string): Promise<void> {
    await this.authService.delete(id);
  }

  @Post(':id/revoke')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Revoke API key (admin only)' })
  @ApiResponse({ status: 200, type: ApiKeyResponseDto })
  async revoke(@Param('id') id: string): Promise<ApiKeyResponseDto> {
    const k = await this.authService.revoke(id);
    return {
      id: k.id,
      name: k.name,
      keyPrefix: k.keyPrefix,
      role: k.role,
      allowedIps: k.allowedIps || undefined,
      allowedSessions: k.allowedSessions || undefined,
      isActive: k.isActive,
      expiresAt: k.expiresAt || undefined,
      lastUsedAt: k.lastUsedAt || undefined,
      usageCount: k.usageCount,
      createdAt: k.createdAt,
    };
  }
}
