import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { AuditListResponseDto } from './dto/audit-response.dto';
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
  @ApiQuery({
    name: 'severity',
    required: false,
    enum: AuditSeverity,
    description: '`error` is reserved: nothing writes it, so that filter returns no rows.',
  })
  @ApiQuery({ name: 'sessionId', required: false })
  @ApiQuery({ name: 'apiKeyId', required: false })
  @ApiQuery({ name: 'limit', required: false, type: 'integer' })
  @ApiQuery({ name: 'offset', required: false, type: 'integer' })
  @ApiResponse({ status: 200, description: 'Paginated list of audit logs', type: AuditListResponseDto })
  @ApiResponse({ status: 400, description: 'action or severity is repeated or not one of the listed values' })
  async findAll(
    @CurrentApiKey() apiKey?: ApiKey,
    @Query('action') action?: AuditAction | AuditAction[],
    @Query('severity') severity?: AuditSeverity | AuditSeverity[],
    @Query('sessionId') sessionId?: string,
    @Query('apiKeyId') apiKeyId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<{ data: AuditLog[]; total: number }> {
    // The global pipe leaves these enum-typed params alone, so ?action=a&action=b arrives as an array,
    // which the driver rejects as a 500, and an unknown value would silently match nothing. An empty
    // value still means no filter.
    if (action && !(Object.values(AuditAction) as unknown[]).includes(action)) {
      throw new BadRequestException('action must be a single value from the AuditAction list');
    }
    if (severity && !(Object.values(AuditSeverity) as unknown[]).includes(severity)) {
      throw new BadRequestException(
        `severity must be a single value, one of: ${Object.values(AuditSeverity).join(', ')}`,
      );
    }
    const options: AuditQueryOptions = {};
    if (action) options.action = action as AuditAction;
    if (severity) options.severity = severity as AuditSeverity;
    if (sessionId) options.sessionId = sessionId;
    if (apiKeyId) options.apiKeyId = apiKeyId;
    if (limit) options.limit = parseInt(limit, 10);
    if (offset) options.offset = parseInt(offset, 10);

    // Scope to the calling key's allowedSessions so a session-restricted ADMIN key cannot read
    // another tenant's audit rows via the `sessionId` query param (which bypasses the guard fence).
    return this.auditService.findAll(options, apiKey?.allowedSessions);
  }
}
