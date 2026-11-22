import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody, ApiQuery } from '@nestjs/swagger';
import { InfraExportDataResponseDto, InfraImportDataResponseDto } from './dto/infra-response.dto';
import { ImportDataDto } from './dto/import-data.dto';
import { RequireRole, RequireUnscopedKey } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { InfraDataService, InfraExportDataResult, InfraImportDataResult } from './infra-data.service';

/**
 * HTTP adapter for the data-DB backup endpoints. The export/import machinery (the entity-validated
 * export registry, the replace-all transaction, the single-flight and orphan-engine gates) lives in
 * InfraDataService; this layer owns routing, role guards, the validation DTO and the published
 * response metadata.
 */
@ApiTags('infrastructure')
@Controller('infra')
// Every route here is deployment-global (data export/import, infra config, service orchestration),
// so the guard's route-param session fence can never bite. Reject session-scoped keys outright at
// class level, which also covers routes added later. @Public routes are unaffected: the guard
// returns before it reads this metadata.
@RequireUnscopedKey()
export class InfraDataController {
  constructor(private readonly infraData: InfraDataService) {}

  @Get('export-data')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Export all data from Data DB for migration' })
  @ApiQuery({
    name: 'includePluginSecrets',
    required: false,
    type: Boolean,
    description:
      'Include plaintext plugin instance ingress secrets, verify tokens, and secret config fields (default: false)',
  })
  @ApiResponse({ status: 200, description: 'Exported data as JSON', type: InfraExportDataResponseDto })
  @ApiResponse({
    status: 400,
    description: 'Invalid query parameter: includePluginSecrets must be "true" or "false".',
  })
  @ApiResponse({
    status: 409,
    description: 'Refused with code IMPORT_ALREADY_RUNNING: a data import is running; export after it finishes.',
  })
  async exportData(@Query('includePluginSecrets') includePluginSecrets?: string): Promise<InfraExportDataResult> {
    let includeSecrets = false;
    if (includePluginSecrets !== undefined) {
      if (includePluginSecrets === 'true') {
        includeSecrets = true;
      } else if (includePluginSecrets === 'false') {
        includeSecrets = false;
      } else {
        throw new BadRequestException('includePluginSecrets must be "true" or "false"');
      }
    }
    return this.infraData.exportData({ includePluginSecrets: includeSecrets });
  }

  @Post('import-data')
  @HttpCode(HttpStatus.OK)
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Import data to Data DB (replaces existing data)' })
  // `type` is explicit: an @ApiBody carrying only a description does NOT fall back to the handler's
  // parameter type — it publishes `{"type": "string"}` for the whole body.
  @ApiBody({ description: 'Exported data from export-data endpoint', type: ImportDataDto })
  @ApiResponse({ status: 200, description: 'Data imported successfully', type: InfraImportDataResponseDto })
  @ApiResponse({
    status: 400,
    description:
      'Body rejected before the restore ran: `tables` absent or not an object, a table whose value is not an array of rows, a row that is not an object (`null`, a bare string, a nested array), a flag spelled as anything but a boolean or exact `true`/`false`, or a property this route does not accept. Nothing was written. Field-level detail is suppressed in production unless VALIDATION_ERROR_DETAIL=true.',
  })
  @ApiResponse({
    status: 409,
    description:
      'Refused, with the reason in `code`. IMPORT_ALREADY_RUNNING: another import is running — wait for it. EXPORT_IN_PROGRESS: a data export is running; wait for it. IMPORT_NESTED_TRANSACTION: another database transaction holds this connection, so a restore could not be made durable — retry with nothing else in flight. IMPORT_WOULD_ORPHAN_ENGINES: sessions the backup would remove are running, starting or waiting to relaunch here — retry with stopOrphans=true to stop them in-request, or force=true to proceed and restart after. Only the last of these is retryable with stopOrphans; the others leave nothing to decide',
  })
  async importData(@Body() data: ImportDataDto): Promise<InfraImportDataResult> {
    return this.infraData.importData(data);
  }
}
