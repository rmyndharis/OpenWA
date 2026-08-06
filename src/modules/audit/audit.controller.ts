import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { AuditService, AuditQueryOptions } from './audit.service';
import { AuditLog, AuditAction, AuditSeverity } from './entities/audit-log.entity';
import { RequireRole, CurrentApiKey } from '../auth/decorators/auth.decorators';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';

@ApiTags('audit')
@Controller('audit')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'List audit logs with optional filters' })
  @ApiQuery({ name: 'action', required: false, enum: AuditAction })
  @ApiQuery({ name: 'severity', required: false, enum: AuditSeverity })
  @ApiQuery({ name: 'sessionId', required: false })
  @ApiQuery({ name: 'apiKeyId', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiResponse({
    status: 200,
    description: 'Paginated list of audit logs',
  })
  async findAll(
    @CurrentApiKey() apiKey?: ApiKey,
    @Query('action') action?: AuditAction,
    @Query('severity') severity?: AuditSeverity,
    @Query('sessionId') sessionId?: string,
    @Query('apiKeyId') apiKeyId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<{ data: AuditLog[]; total: number }> {
    const options: AuditQueryOptions = {};
    if (action) options.action = action;
    if (severity) options.severity = severity;
    if (sessionId) options.sessionId = sessionId;
    if (apiKeyId) options.apiKeyId = apiKeyId;
    if (limit) options.limit = parseInt(limit, 10);
    if (offset) options.offset = parseInt(offset, 10);

    // Scope to the calling key's allowedSessions so a session-restricted ADMIN key cannot read
    // another tenant's audit rows via the `sessionId` query param (which bypasses the guard fence).
    return this.auditService.findAll(options, apiKey?.allowedSessions);
  }
}
