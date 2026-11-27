import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Req,
  HttpCode,
  HttpStatus,
  ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { CreateApiKeyDto, UpdateApiKeyDto, ApiKeyResponseDto, ApiKeyCreatedResponseDto } from './dto';
import { Capability, RequireRole, CurrentApiKey, RequireUnscopedKey } from './decorators/auth.decorators';
import { apiKeyDeniedCapabilities, ApiKeyCapability, normalizeDeniedCapabilities } from '../auth/api-key-permissions';
import { type ApiKey, ApiKeyRole } from './entities/api-key.entity';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from './../audit/entities/audit-log.entity';

// A key stored before expiresAt was validated can hold an unparseable expiry, which SQLite reads back as
// an Invalid Date. The gateway refuses such a key as expired, but JSON would serialize the expiry as null
// (no expiry). Report it as the epoch instead, so the key shows as expired and can be given a new expiry.
function readableExpiry(expiresAt: Date | null): Date | null {
  return expiresAt && Number.isNaN(expiresAt.getTime()) ? new Date(0) : expiresAt;
}

@ApiTags('auth')
@Controller('auth/api-keys')
// Key lifecycle routes have no session dimension, so a session-scoped ADMIN key could otherwise
// escape its confinement here (mint an unrestricted key, or clear another key's allowedSessions).
@RequireUnscopedKey()
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

  // The key's authorization scope as audited on create and update, so a key's scope can be read back
  // from the audit log whether or not it was ever edited.
  private authzSnapshot(key: ApiKey) {
    return {
      role: key.role,
      allowedIps: key.allowedIps,
      allowedSessions: key.allowedSessions,
      allowedChats: key.allowedChats,
      deniedPermissions: key.deniedPermissions,
      expiresAt: readableExpiry(key.expiresAt),
    };
  }

  private toResponse(k: ApiKey): ApiKeyResponseDto {
    return {
      id: k.id,
      name: k.name,
      keyPrefix: k.keyPrefix,
      role: k.role,
      allowedIps: k.allowedIps || undefined,
      allowedSessions: k.allowedSessions || undefined,
      allowedChats: k.allowedChats || undefined,
      deniedPermissions: k.deniedPermissions || undefined,
      isActive: k.isActive,
      expiresAt: readableExpiry(k.expiresAt) || undefined,
      lastUsedAt: k.lastUsedAt || undefined,
      usageCount: k.usageCount,
      createdAt: k.createdAt,
    };
  }

  /** A restricted admin may delegate key management, but never grant a capability it cannot use. */
  private inheritDeniedPermissions<T extends CreateApiKeyDto | UpdateApiKeyDto>(dto: T, actor?: ApiKey): T {
    const inherited = apiKeyDeniedCapabilities(actor);
    if (inherited.length === 0) return dto;
    const requested = normalizeDeniedCapabilities(dto.deniedPermissions) ?? [];
    return {
      ...dto,
      deniedPermissions: [...new Set([...requested, ...inherited])],
    };
  }

  @Capability(ApiKeyCapability.APIKEYS_MANAGE)
  @Post()
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Create a new API key (admin only)' })
  @ApiResponse({
    status: 201,
    description: 'API key created',
    type: ApiKeyCreatedResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Validation failed, or the body carries a field the DTO does not declare.' })
  async create(
    @Body() dto: CreateApiKeyDto,
    @Req() req: Request,
    @CurrentApiKey() actor?: ApiKey,
  ): Promise<ApiKeyCreatedResponseDto> {
    const { apiKey, rawKey } = await this.authService.createApiKey(this.inheritDeniedPermissions(dto, actor));
    await this.auditService.logInfo(AuditAction.API_KEY_CREATED, {
      ...this.auditContext(req, actor),
      metadata: {
        targetKeyId: apiKey.id,
        targetKeyName: apiKey.name,
        role: apiKey.role,
        scope: this.authzSnapshot(apiKey),
      },
    });
    return { ...this.toResponse(apiKey), apiKey: rawKey };
  }

  @Capability(ApiKeyCapability.APIKEYS_MANAGE)
  @Get()
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'List all API keys (admin only)' })
  @ApiResponse({
    status: 200,
    description: 'All API keys (the plaintext key is never returned; only the keyPrefix).',
    type: [ApiKeyResponseDto],
  })
  async findAll(): Promise<ApiKeyResponseDto[]> {
    const keys = await this.authService.findAll();
    return keys.map(k => this.toResponse(k));
  }

  @Capability(ApiKeyCapability.APIKEYS_MANAGE)
  @Get(':id')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Get API key details (admin only)' })
  @ApiResponse({
    status: 200,
    description: 'The API key (plaintext never returned; only the keyPrefix).',
    type: ApiKeyResponseDto,
  })
  @ApiResponse({ status: 404, description: 'No API key with this id.' })
  async findOne(@Param('id') id: string): Promise<ApiKeyResponseDto> {
    const k = await this.authService.findOne(id);
    return this.toResponse(k);
  }

  @Capability(ApiKeyCapability.APIKEYS_MANAGE)
  @Put(':id')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Update API key (admin only)' })
  @ApiResponse({ status: 200, description: 'The updated API key.', type: ApiKeyResponseDto })
  @ApiResponse({ status: 400, description: 'Validation failed, or the body carries a field the DTO does not declare.' })
  @ApiResponse({ status: 404, description: 'No API key with this id.' })
  @ApiResponse({
    status: 409,
    description: 'The change would remove the last usable admin key: no other usable admin key lasts at least as long.',
  })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateApiKeyDto,
    @Req() req: Request,
    @CurrentApiKey() actor?: ApiKey,
  ): Promise<ApiKeyResponseDto> {
    const before = await this.authService.findOne(id);
    const actorDenied = apiKeyDeniedCapabilities(actor);
    if (actorDenied.length > 0 && actor?.id === id && dto.deniedPermissions !== undefined) {
      const beforeDenied = apiKeyDeniedCapabilities(before);
      const requested = normalizeDeniedCapabilities(dto.deniedPermissions) ?? [];
      if (
        beforeDenied.length !== requested.length ||
        beforeDenied.some(capability => !requested.includes(capability))
      ) {
        throw new ForbiddenException('A capability-restricted API key cannot change its own blocked capabilities');
      }
    }
    const effectiveDto =
      actorDenied.length === 0
        ? dto
        : this.inheritDeniedPermissions(
            {
              ...dto,
              deniedPermissions:
                dto.deniedPermissions === undefined ? apiKeyDeniedCapabilities(before) : dto.deniedPermissions,
            },
            actor,
          );
    const k = await this.authService.update(id, effectiveDto);
    await this.auditService.logInfo(AuditAction.API_KEY_UPDATED, {
      ...this.auditContext(req, actor),
      metadata: {
        targetKeyId: k.id,
        targetKeyName: k.name,
        before: this.authzSnapshot(before),
        after: this.authzSnapshot(k),
      },
    });
    return this.toResponse(k);
  }

  @Capability(ApiKeyCapability.APIKEYS_MANAGE)
  @Delete(':id')
  @RequireRole(ApiKeyRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete API key (admin only)' })
  @ApiResponse({ status: 204, description: 'API key deleted' })
  @ApiResponse({ status: 404, description: 'No API key with this id.' })
  @ApiResponse({
    status: 409,
    description: 'The key is the last usable admin key: no other usable admin key lasts at least as long.',
  })
  async delete(@Param('id') id: string, @Req() req: Request, @CurrentApiKey() actor?: ApiKey): Promise<void> {
    const target = await this.authService.findOne(id);
    await this.authService.delete(id);
    await this.auditService.logInfo(AuditAction.API_KEY_DELETED, {
      ...this.auditContext(req, actor),
      metadata: { targetKeyId: id, targetKeyName: target?.name },
    });
  }

  @Capability(ApiKeyCapability.APIKEYS_MANAGE)
  @Post(':id/revoke')
  @RequireRole(ApiKeyRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke API key (admin only)' })
  @ApiResponse({ status: 200, description: 'The revoked API key (isActive now false).', type: ApiKeyResponseDto })
  @ApiResponse({ status: 404, description: 'No API key with this id.' })
  @ApiResponse({
    status: 409,
    description: 'The key is the last usable admin key: no other usable admin key lasts at least as long.',
  })
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
    return this.toResponse(k);
  }
}
