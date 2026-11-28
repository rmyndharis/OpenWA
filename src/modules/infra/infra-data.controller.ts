import { Readable } from 'node:stream';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Query,
  Res,
  ServiceUnavailableException,
  StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags, ApiOperation, ApiResponse, ApiBody, ApiQuery } from '@nestjs/swagger';
import { InfraExportDataResponseDto, InfraImportDataResponseDto } from './dto/infra-response.dto';
import { ImportDataDto } from './dto/import-data.dto';
import { Capability, RequireRole, RequireUnrestrictedKey } from '../auth/decorators/auth.decorators';
import { ApiKeyCapability } from '../auth/api-key-permissions';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { InfraDataService, InfraImportDataResult } from './infra-data.service';
import { createLogger } from '../../common/services/logger.service';

/**
 * How long an export waits on a reader that takes nothing more: the bound a stored media download
 * gives its reader (S3_READER_IDLE_MS), which a client reading 2 KiB/s still meets. Until its reader is
 * done an export refuses every import and, on PostgreSQL, holds a snapshot open, so a reader that
 * stopped for good (a suspended client, a stuck proxy) must not hold them for good.
 */
const EXPORT_READER_IDLE_MS = 600_000;

/**
 * How long one export may take from its request to its last byte. The idle bound alone lets a reader
 * that takes a little every few minutes hold the snapshot for days. An hour carries the largest
 * archive the import accepts (about half a gigabyte) at 150 KiB/s.
 */
const EXPORT_MAX_DURATION_MS = 60 * 60_000;

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
@RequireUnrestrictedKey()
export class InfraDataController {
  private readonly logger = createLogger('InfraDataController');

  constructor(private readonly infraData: InfraDataService) {}

  @Capability(ApiKeyCapability.INFRA_WRITE)
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
    description:
      'Refused, with the reason in `code`. IMPORT_ALREADY_RUNNING: a data import is running; export after it finishes. EXPORT_IN_PROGRESS: another export is still being downloaded; one runs at a time.',
  })
  @ApiResponse({
    status: 503,
    description:
      'Refused with code EXPORT_TIMED_OUT: the export had not sent its first byte 60 minutes after the request. Back the database up with scripts/backup.sh instead. Refused with code EXPORT_STOPPED: the gateway stopped before the export sent its first byte, ending and removing a copy of the database written for it; export again once it is back.',
  })
  @ApiResponse({
    status: 507,
    description:
      'Refused with code EXPORT_NO_ROOM_FOR_SNAPSHOT before anything was read: a SQLite database that is not in WAL mode is exported from a copy written beside it, and the volume has no room for one that leaves a tenth of the database, at least 256 MiB, free for the database to go on writing. The message names the bytes the copy needs, that headroom and the bytes free.',
  })
  async exportData(
    @Query('includePluginSecrets') includePluginSecrets?: string,
    @Res({ passthrough: true }) res?: Response,
  ): Promise<StreamableFile> {
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
    // Everything that ends an export early goes through this signal: the service reads it between
    // its reads, and once the body exists its destruction returns a generator parked at a piece.
    const stop = new AbortController();
    let readerIdle: NodeJS.Timeout | undefined;
    const deadline = setTimeout(
      () =>
        stop.abort(
          new ServiceUnavailableException({
            statusCode: 503,
            error: 'Service Unavailable',
            message:
              'The export did not finish within 60 minutes. Back the database up with scripts/backup.sh instead.',
            code: 'EXPORT_TIMED_OUT',
          }),
        ),
      EXPORT_MAX_DURATION_MS,
    ).unref();
    const settle = (): void => {
      clearTimeout(deadline);
      clearTimeout(readerIdle);
    };
    // Also follows a response that ended in order, when nothing is left to stop. Until the body is
    // returned below, nothing else tells the service that its client has gone.
    res?.once('close', () => stop.abort(new HttpException('Client Closed Request', 499)));

    const pieces = this.infraData.exportData({ includePluginSecrets: includeSecrets, signal: stop.signal });
    // The first piece is awaited here, so a refusal or a read that fails before anything was sent
    // answers with its own status. Once the body has started the status has gone out, and a failure
    // cuts the connection instead: ending the response there would report half a backup as a success.
    let first: Promise<IteratorResult<string, void>> | undefined = pieces.next();
    await first.catch((error: unknown) => {
      settle();
      throw error;
    });
    const body: Readable = Readable.from(
      {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            clearTimeout(readerIdle);
            const step = await (first ?? pieces.next());
            first = undefined;
            if (step.done) {
              settle();
            } else {
              readerIdle = setTimeout(
                () => stop.abort(new Error('The export reader took nothing for too long')),
                EXPORT_READER_IDLE_MS,
              ).unref();
            }
            return step;
          },
          // Ends the export, and with it the import refusal, when the client goes away mid-download.
          return: () => {
            settle();
            return pieces.return();
          },
        }),
      },
      { objectMode: false },
    );
    stop.signal.addEventListener('abort', () => body.destroy(stop.signal.reason as Error));
    const file = new StreamableFile(body, { type: 'application/json; charset=utf-8' });
    const endResponse = file.errorHandler;
    return file.setErrorHandler((error, response) => {
      if (response.destroyed) return;
      // Closing in order is how a body with no length ends over HTTP/1.0, so a proxy speaking it
      // would hand the half it got to its client as a complete 200. A reset is an error to every hop.
      if (!response.headersSent || !res?.socket) return endResponse(error, response);
      this.logger.error('A data export failed after its first bytes were sent', String(error));
      res.socket.resetAndDestroy();
    });
  }

  @Capability(ApiKeyCapability.INFRA_WRITE)
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
  @ApiResponse({
    status: 413,
    description:
      'Body refused before it was parsed. Above `BODY_SIZE_LIMIT` or half the in-flight body budget: raise the limit. With code IMPORT_TOO_LARGE: the body is within the limit, but this process has no memory to restore it. The body is decoded to one string and parsed whole, which takes about 2.2 bytes of heap per byte of a backup all in ASCII, so before the body is read one above the free heap divided by 2.5, or above 536870888 bytes, is refused. A body with any character outside ASCII decodes to two bytes a character, so once read it is refused above the free heap divided by 4. The message names both figures; nothing was written. A caller without an admin key that no session or chat restriction limits (the only kind the route accepts) is refused above 26214400 bytes whatever the memory, and is not told the figures. A body without Content-Length counts as BODY_SIZE_LIMIT long; when that is above the limit, the message says the length is needed.',
  })
  @ApiResponse({
    status: 503,
    description:
      'Refused with code IMPORT_STOPPED: the gateway stopped while a SQLite restore ran, and the restore was rolled back, so the data is as it was. Restore again once the gateway is back.',
  })
  async importData(@Body() data: ImportDataDto): Promise<InfraImportDataResult> {
    return this.infraData.importData(data);
  }
}
