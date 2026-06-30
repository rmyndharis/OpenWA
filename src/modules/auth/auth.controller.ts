import { Controller, Get, Post, Put, Delete, Body, Param, Req, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { CreateApiKeyDto, UpdateApiKeyDto, ApiKeyResponseDto, ApiKeyCreatedResponseDto } from './dto';
import { RequireRole, CurrentApiKey } from './decorators/auth.decorators';
import { type ApiKey, ApiKeyRole } from './entities/api-key.entity';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from './../audit/entities/audit-log.entity';

@ApiTags('auth')
@Controller('auth/api-keys')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly auditService: AuditService,
  ) {}

  // Build the request-context block for an API-key lifecycle audit entry: who did it (the admin key from
  // the guard), the resolved client IP, and the HTTP method/path.
  private auditContext(
    req: Request,
    actor?: ApiKey,
  ): { apiKey?: ApiKey; ipAddress?: string; method?: string; path?: string } {
    return {
      apiKey: actor,
      ipAddress: (req as Request & { clientIp?: string }).clientIp ?? undefined,
      method: req.method,
      path: req.path,
    };
  }

  @Post()
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Create a new API key (admin only)' })
  @ApiResponse({
    status: 201,
    description: 'API key created',
    type: ApiKeyCreatedResponseDto,
  })
  async create(
    @Body() dto: CreateApiKeyDto,
    @Req() req: Request,
    @CurrentApiKey() actor?: ApiKey,
  ): Promise<ApiKeyCreatedResponseDto> {
    const { apiKey, rawKey } = await this.authService.createApiKey(dto);
    await this.auditService.logInfo(AuditAction.API_KEY_CREATED, {
      ...this.auditContext(req, actor),
      metadata: { targetKeyId: apiKey.id, targetKeyName: apiKey.name, role: apiKey.role },
    });
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
  async delete(@Param('id') id: string, @Req() req: Request, @CurrentApiKey() actor?: ApiKey): Promise<void> {
    const target = await this.authService.findOne(id);
    await this.authService.delete(id);
    await this.auditService.logInfo(AuditAction.API_KEY_DELETED, {
      ...this.auditContext(req, actor),
      metadata: { targetKeyId: id, targetKeyName: target?.name },
    });
  }

  @Post(':id/revoke')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Revoke API key (admin only)' })
  @ApiResponse({ status: 200, type: ApiKeyResponseDto })
  async revoke(
    @Param('id') id: string,
    @Req() req: Request,
    @CurrentApiKey() actor?: ApiKey,
  ): Promise<ApiKeyResponseDto> {
    const k = await this.authService.revoke(id);
    await this.auditService.logInfo(AuditAction.API_KEY_REVOKED, {
      ...this.auditContext(req, actor),
      metadata: { targetKeyId: k.id, targetKeyName: k.name },
    });
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
