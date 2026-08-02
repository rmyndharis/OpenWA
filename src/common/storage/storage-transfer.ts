import { TarArchive } from 'archiver';
import * as tar from 'tar-stream';
import { createGunzip } from 'zlib';
import { Readable, PassThrough } from 'stream';
import { LoggerService } from '../services/logger.service';

/** Per-entry buffer cap for an import (200 MiB — 4× the inbound media cap). Bounds a decompression bomb. */
const DEFAULT_IMPORT_MAX_BYTES = 200 * 1024 * 1024;
/** Max number of entries an import archive may contain. Bounds an entry-count DoS. */
const DEFAULT_IMPORT_MAX_ENTRIES = 100_000;

function positiveIntFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// ============================================================================
// Export - Create tar.gz stream from current storage
// ============================================================================

export async function createExportStream(
  listFiles: () => Promise<string[]>,
  getFile: (filePath: string) => Promise<Buffer>,
  logger: LoggerService,
): Promise<PassThrough> {
  const files = await listFiles();
  const output = new PassThrough();

  const archive = new TarArchive({
    gzip: true,
    gzipOptions: { level: 6 },
  });

  // Surface archive-level failures (gzip/finalize) on the returned stream instead of
  // letting them become an unhandled rejection or a silently truncated download.
  archive.on('error', (err: Error) => {
    logger.error('Export archive failed', String(err));
    output.destroy(err);
  });

  archive.pipe(output);

  // Add files to archive
  for (const file of files) {
    try {
      const data = await getFile(file);
      archive.append(data, { name: file });
    } catch (error) {
      logger.warn(`Failed to export file: ${file}`, { error: String(error) });
    }
  }

  // finalize() rejections also emit via the 'error' handler above; catch the promise so it
  // never surfaces as an unhandled rejection.
  archive.finalize().catch(() => undefined);
  return output;
}

// ============================================================================
// Import - Extract tar.gz stream to current storage
// ============================================================================

// Best-effort, NOT atomic: a single bad/traversing entry is skipped and the rest still import, and a
// resource-cap breach aborts the rest but KEEPS the entries already written (no rollback). Callers
// re-running an import is safe (putFile overwrites). A staging-dir + atomic promote would make it
// transactional, but is out of scope here.
export async function importFromStream(
  inputStream: Readable,
  putFile: (filePath: string, data: Buffer) => Promise<void>,
  logger: LoggerService,
): Promise<number> {
  let importedCount = 0;
  let entryCount = 0;
  const maxEntryBytes = positiveIntFromEnv('STORAGE_IMPORT_MAX_BYTES', DEFAULT_IMPORT_MAX_BYTES);
  const maxEntries = positiveIntFromEnv('STORAGE_IMPORT_MAX_ENTRIES', DEFAULT_IMPORT_MAX_ENTRIES);

  const extract = tar.extract();
  const gunzip = createGunzip();

  return new Promise<number>((resolve, reject) => {
    let settled = false;
    // Abort the whole import: a per-entry overflow or too many entries is a (zip-bomb) attack, not
    // a per-file skip — tear down the pipeline and reject so nothing further is buffered or written.
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      extract.destroy();
      gunzip.destroy();
      // Destroying the input mid-pipe stops the source; without an error arg it emits no 'error'.
      inputStream.destroy();
      reject(err);
    };
    // Every stream in the pipeline needs an 'error' listener: an EventEmitter with none CRASHES the
    // process on error. pipe() does not forward errors, so a corrupt gzip (zlib error on gunzip) or
    // an input read failure (disk I/O, file replaced mid-read) would otherwise kill the server
    // mid-request instead of failing the import.
    gunzip.on('error', (err: Error) => {
      logger.error('Import failed (gzip)', String(err));
      fail(err);
    });
    inputStream.on('error', (err: Error) => {
      logger.error('Import failed (input)', String(err));
      fail(err);
    });

    extract.on('entry', (header, stream, next) => {
      if (settled) {
        stream.resume();
        return;
      }
      if (++entryCount > maxEntries) {
        stream.resume();
        fail(new Error(`Import aborted: archive exceeds the ${maxEntries}-entry limit`));
        return;
      }

      const chunks: Buffer[] = [];
      let entryBytes = 0;
      let entryAborted = false;

      stream.on('data', (chunk: Buffer) => {
        if (entryAborted || settled) return;
        entryBytes += chunk.length;
        if (entryBytes > maxEntryBytes) {
          entryAborted = true;
          stream.resume(); // drain the remainder so the source can end
          fail(new Error(`Import aborted: entry "${header.name}" exceeds the ${maxEntryBytes}-byte per-entry cap`));
        } else {
          chunks.push(chunk);
        }
      });

      stream.on('end', () => {
        if (entryAborted || settled) return;
        const data = Buffer.concat(chunks);
        putFile(header.name, data)
          .then(() => {
            importedCount++;
            logger.debug(`Imported file: ${header.name}`);
            next();
          })
          .catch((error: unknown) => {
            logger.error(`Failed to import file: ${header.name}`, String(error));
            next();
          });
      });
      stream.resume();
    });

    extract.on('finish', () => {
      if (settled) return;
      settled = true;
      logger.log(`Import completed: ${importedCount} files`);
      resolve(importedCount);
    });

    extract.on('error', (err: Error) => {
      logger.error('Import failed', String(err));
      fail(err);
    });

    inputStream.pipe(gunzip).pipe(extract);
  });
}
