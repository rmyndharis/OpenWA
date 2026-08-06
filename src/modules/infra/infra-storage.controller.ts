import {
  Controller,
  Get,
  Post,
  Body,
  BadRequestException,
  HttpCode,
  HttpStatus,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { RequireRole, RequireUnscopedKey } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { isPathWithin } from '../../common/utils/path-safety';
import { StorageService } from '../../common/storage/storage.service';
import { createLogger } from '../../common/services/logger.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { ImportStorageDto } from './dto/import-storage.dto';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

@ApiTags('infrastructure')
@Controller('infra')
// Every route here is deployment-global (data export/import, infra config, service orchestration),
// so the guard's route-param session fence can never bite. Reject session-scoped keys outright at
// class level, which also covers routes added later. @Public routes are unaffected: the guard
// returns before it reads this metadata.
@RequireUnscopedKey()
export class InfraStorageController implements OnApplicationBootstrap {
  private readonly logger = createLogger('InfraStorageController');

  constructor(
    private readonly storageService: StorageService,
    // Best-effort audit emission for the sensitive infra operations below. Injected @Optional and
    // appended last so it never shifts the existing positional args: the running app always provides
    // the @Global AuditService, while the direct-construction unit tests omit it — the `?.` at each
    // call site then makes emission a no-op there instead of forcing every test to wire a mock.
    @Optional()
    private readonly auditService?: AuditService,
  ) {}

  // Matches exactly the filename exportStorage writes: storage-export-<Date.now()>-<randomUUID()>.tar.gz.
  // The captured group is the creation epoch-ms, so the sweep reads the age from the name — anything
  // not in this exact shape (an operator's import candidate, any other file) is never touched.
  private static readonly EXPORT_ARCHIVE_PATTERN =
    /^storage-export-(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tar\.gz$/;

  /**
   * Boot sweep for orphaned storage-export archives. exportStorage deletes each archive on a TTL
   * timer, but that timer dies with the process — an archive whose process restarted or crashed
   * before the timer fired would accumulate on the data volume forever. At bootstrap, delete the
   * archives WE created whose embedded creation timestamp is older than
   * STORAGE_EXPORT_SWEEP_MAX_AGE_MS (default 24h; kept generous so the documented
   * export→restart→import migration flow still finds its file). Young archives and any
   * non-export file in data/exports/ are left untouched.
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.sweepStaleExportArchives();
  }

  /**
   * Delete export archives older than STORAGE_EXPORT_SWEEP_MAX_AGE_MS from exportDir. Sweep
   * failures are logged, never thrown: a leftover archive must not block boot.
   */
  async sweepStaleExportArchives(exportDir = path.join(process.cwd(), 'data', 'exports')): Promise<void> {
    const maxAgeRaw = Number.parseInt(process.env.STORAGE_EXPORT_SWEEP_MAX_AGE_MS ?? '', 10);
    const maxAgeMs = Number.isInteger(maxAgeRaw) && maxAgeRaw > 0 ? maxAgeRaw : 24 * 60 * 60 * 1000; // default 24h

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(exportDir, { withFileTypes: true });
    } catch (error) {
      // ENOENT just means no export has ever run on this deployment — nothing to sweep.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn('Storage export sweep could not read the exports directory', {
          exportDir,
          error: String(error),
        });
      }
      return;
    }

    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const match = InfraStorageController.EXPORT_ARCHIVE_PATTERN.exec(entry.name);
      if (!match) continue;
      if (now - Number(match[1]) < maxAgeMs) continue;
      try {
        await fs.promises.unlink(path.join(exportDir, entry.name));
        this.logger.log('Swept stale storage export archive', { file: entry.name });
      } catch (error) {
        this.logger.warn('Failed to sweep stale storage export archive', { file: entry.name, error: String(error) });
      }
    }
  }

  // ============================================================================
  // STORAGE MIGRATION API
  // ============================================================================

  @Get('storage/files/count')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Get file count in current storage' })
  @ApiResponse({ status: 200, description: 'File count and size' })
  async getStorageFileCount(): Promise<{
    storageType: string;
    count: number;
    sizeBytes: number;
    sizeMB: string;
  }> {
    const { count, sizeBytes } = await this.storageService.getFileCount();
    return {
      storageType: this.storageService.getCurrentStorageType(),
      count,
      sizeBytes,
      sizeMB: (sizeBytes / 1024 / 1024).toFixed(2),
    };
  }

  @Get('storage/export')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Export all storage files as tar.gz' })
  @ApiResponse({ status: 200, description: 'Tar.gz archive stream' })
  async exportStorage(): Promise<{ message: string; download: string }> {
    // Note: In production, this would return a StreamableFile
    // For simplicity, we'll save to a temp file and return the path
    const stream = await this.storageService.createExportStream();
    // Keep the export INSIDE data/ (under data/exports/): the import handler only accepts paths under
    // data/, and the documented backend-migration flow re-imports this file AFTER a container restart,
    // so it must live on the persistent volume — the OS temp dir is wiped on restart. The original
    // unbounded-accumulation leak is addressed by the TTL sweep below + a collision-proof filename
    // (a per-call UUID), not by relocating off the volume.
    const exportDir = path.join(process.cwd(), 'data', 'exports');
    if (!fs.existsSync(exportDir)) {
      fs.mkdirSync(exportDir, { recursive: true });
    }
    const exportPath = path.join(exportDir, `storage-export-${Date.now()}-${randomUUID()}.tar.gz`);

    const writeStream = fs.createWriteStream(exportPath);
    stream.pipe(writeStream);

    await new Promise<void>((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
      // pipe() does NOT forward source errors: an archiver/gzip failure surfaces as an 'error' event on
      // the source stream, which without a listener crashes the process. Fail the request instead and
      // tear down the sink so its fd isn't held open waiting for a 'finish' that never comes.
      stream.on('error', (err: Error) => {
        writeStream.destroy();
        reject(err);
      });
    });

    // Sweep the throwaway archive so repeated exports don't accumulate on the data volume.
    const ttlRaw = Number.parseInt(process.env.STORAGE_EXPORT_TTL_MS ?? '', 10);
    const ttlMs = Number.isInteger(ttlRaw) && ttlRaw > 0 ? ttlRaw : 60 * 60 * 1000; // default 1h
    setTimeout(() => {
      fs.promises.unlink(exportPath).catch(() => undefined);
    }, ttlMs).unref();

    // cwd-relative rather than an absolute host path: doesn't leak the filesystem layout, and the
    // import round-trip still works because importStorage's existsSync/createReadStream resolve a
    // relative filePath against the same cwd this was made relative to.
    const download = path.relative(process.cwd(), exportPath);

    // Audit the bulk media-export (all stored files leave the box as one archive).
    await this.auditService?.logInfo(AuditAction.INFRA_STORAGE_EXPORTED, { metadata: { download } });

    return {
      message: 'Storage export completed',
      download,
    };
  }

  @Post('storage/import')
  @HttpCode(HttpStatus.OK)
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Import storage files from tar.gz' })
  @ApiBody({ description: 'Path to tar.gz file to import' })
  @ApiResponse({ status: 200, description: 'Import result' })
  async importStorage(
    @Body() body: ImportStorageDto,
  ): Promise<{ imported: boolean; count: number; storageType: string }> {
    const { filePath } = body;

    // `filePath` is fully caller-controlled. Restrict it to the app's data
    // directory so it cannot point at arbitrary files on the host. Resolve once against the
    // same cwd-relative base used by exportStorage, then use that exact path for both the guard
    // and the file sink.
    const dataDir = path.join(process.cwd(), 'data');
    const resolved = path.resolve(process.cwd(), filePath || '');
    if (!filePath || !isPathWithin(dataDir, resolved)) {
      throw new BadRequestException('filePath must reference a file inside the data directory');
    }

    if (!fs.existsSync(resolved)) {
      throw new BadRequestException(`File not found: ${filePath}`);
    }

    const readStream = fs.createReadStream(resolved);
    // importFromStream rejects on archive/gzip/read failures (its streams carry error listeners, so a
    // bad file fails the request instead of crashing the process on an unhandled 'error' event). The
    // failures that reach here are almost always a problem with the caller-supplied file (not a gzip,
    // not a tar, unreadable, over the resource caps), so surface them as a 400 with the real reason
    // rather than an opaque 500.
    let count: number;
    try {
      count = await this.storageService.importFromStream(readStream);
    } catch (error) {
      throw new BadRequestException(`Storage import failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const storageType = this.storageService.getCurrentStorageType();

    // Audit the bulk media-import (files written into the active storage backend).
    await this.auditService?.logInfo(AuditAction.INFRA_STORAGE_IMPORTED, {
      metadata: { count, storageType },
    });

    return {
      imported: true,
      count,
      storageType,
    };
  }
}
