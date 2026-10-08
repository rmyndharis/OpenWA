import { TarArchive } from 'archiver';
import * as tar from 'tar-stream';
import { createGunzip } from 'zlib';
import * as fs from 'fs';
import { Readable, PassThrough, Transform, pipeline } from 'stream';
import { LoggerService } from '../services/logger.service';

/** Per-entry buffer cap for an import (200 MiB — 4× the inbound media cap). Bounds a decompression bomb. */
const DEFAULT_IMPORT_MAX_BYTES = 200 * 1024 * 1024;
/** Max number of entries an import archive may contain. Bounds an entry-count DoS. */
const DEFAULT_IMPORT_MAX_ENTRIES = 100_000;
/** Cap on the bytes one import writes in total (10 GiB). The two caps above still allow terabytes. */
const DEFAULT_IMPORT_MAX_TOTAL_BYTES = 10 * 1024 * 1024 * 1024;

/**
 * True when a storage read failed because the object is simply not there.
 *
 * Both backends must be covered, and they report it differently: the local backend raises a POSIX
 * `ENOENT` (a `.code`), while S3 raises `NoSuchKey`/`NotFound`, which carries a `.name` and no
 * `.code` at all; `StorageService.getS3File` rethrows that original error when the local read-through
 * also misses. Checking only `.code` turns a missing S3 object into a 500 on the one backend where
 * retention and bucket lifecycle rules make a miss most likely.
 */
export function isMissingObjectError(error: unknown): boolean {
  const e = error as { code?: string; name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e?.code === 'ENOENT' || e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404
  );
}

function positiveIntFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// ============================================================================
// Export - Create tar.gz stream from current storage
// ============================================================================

/**
 * A file opened for export. `size` is the byte length the tar header declares; without it archiver
 * has to buffer that one entry to learn its length.
 */
export interface ExportFileSource {
  stream: Readable;
  size?: number;
}

// Returns the output as soon as the file list is known and fills the archive in the background, one
// entry at a time: each file is opened only after the previous entry has been written through to the
// consumer, so memory holds one file's in-flight chunks, not the whole store. A file deleted since the
// listing is skipped with a warning. Any other open failure (a throttled or unreachable store) destroys
// the output, so the export fails instead of reporting success for an archive missing that file; so
// does a read that fails part-way, because its tar header is already written and skipping it would
// leave a corrupt archive.
export async function createExportStream(
  listFiles: () => Promise<string[]>,
  openFile: (filePath: string) => Promise<ExportFileSource>,
  logger: LoggerService,
): Promise<PassThrough> {
  const files = await listFiles();
  // The importer aborts a whole archive past STORAGE_IMPORT_MAX_ENTRIES. Now that the export is
  // uncapped, a large store can produce one this gateway refuses to restore — and the operator would
  // only find out at restore time, after decommissioning the source. Say it at EXPORT time instead.
  // Compared against the LOWER of this deployment's configured limit and the shipped default. The
  // default alone is destination-agnostic, which is right when restoring elsewhere — but it stays
  // silent for an operator who LOWERED the limit here and restores onto this same gateway, which is
  // the one destination whose limit we actually know.
  const localImportCap = positiveIntFromEnv('STORAGE_IMPORT_MAX_ENTRIES', DEFAULT_IMPORT_MAX_ENTRIES);
  const warnAbove = Math.min(localImportCap, DEFAULT_IMPORT_MAX_ENTRIES);
  if (files.length > warnAbove) {
    logger.warn(
      `Export contains ${files.length} files, above the import limit of ${warnAbove} ` +
        `(this deployment: ${localImportCap}, shipped default: ${DEFAULT_IMPORT_MAX_ENTRIES}). ` +
        'Raise STORAGE_IMPORT_MAX_ENTRIES on the destination before restoring this archive.',
    );
  }
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

  appendEntries(files, openFile, archive, output, logger).catch((err: Error) => output.destroy(err));
  return output;
}

function enforceSize(file: string, size: number | undefined): Transform {
  let seen = 0;
  const mismatch = (): Error => new Error(`Export failed: ${file} changed size while being read (expected ${size})`);
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      callback(size !== undefined && seen > size ? mismatch() : null, chunk);
    },
    flush(callback) {
      callback(size !== undefined && seen < size ? mismatch() : null);
    },
  });
}

async function appendEntries(
  files: string[],
  openFile: (filePath: string) => Promise<ExportFileSource>,
  archive: TarArchive,
  output: PassThrough,
  logger: LoggerService,
): Promise<void> {
  let exportedBytes = 0;
  for (const file of files) {
    let source: ExportFileSource;
    try {
      source = await openFile(file);
    } catch (error) {
      // Only a per-object miss is skippable: ENOENT locally, NoSuchKey from S3 (openS3File returns it
      // once the local fallback also misses). isMissingObjectError also counts any 404, which includes
      // a bucket that is gone, and skipping that would report a partial archive as a finished export.
      const { code, name } = error as { code?: string; name?: string };
      if (code !== 'ENOENT' && name !== 'NoSuchKey') throw error;
      logger.warn(`Failed to export file: ${file}`, { error: String(error) });
      continue;
    }
    const { stream, size } = source;
    exportedBytes += size ?? 0;
    // The output closes early when the archive fails or the consumer goes away: stop reading files.
    // Checked synchronously before waiting, so a 'close' that already fired cannot be missed.
    if (output.destroyed) {
      stream.destroy();
      break;
    }
    // The tar sink fails with an error nothing can listen for when an entry's length differs from the
    // size in its header, which would crash the process. A file rewritten between open and read does
    // that, so the length is checked here and a mismatch fails the export like a read error, before
    // the sink sees the extra byte or the early end. pipeline() also forwards a source error, which
    // pipe() does not.
    const entry = pipeline(stream, enforceSize(file, size), err => {
      if (!err || output.destroyed) return;
      logger.error(`Export failed reading file: ${file}`, String(err));
      output.destroy(err);
    });
    await new Promise<void>(resolve => {
      const done = (): void => {
        archive.removeListener('entry', done);
        output.removeListener('close', done);
        resolve();
      };
      archive.on('entry', done);
      output.on('close', done);
      // Mode and date are set explicitly: archiver derives both from `stats` when present, and this
      // stand-in carries only the size.
      const stats = size === undefined ? undefined : ({ size } as fs.Stats);
      archive.append(entry, { name: file, mode: 0o644, date: new Date(), stats });
    });
    if (output.destroyed) {
      stream.destroy();
      break;
    }
  }
  if (output.destroyed) {
    archive.abort();
    return;
  }
  // Same reasoning as the entry-count warning in createExportStream, for the import's total-bytes cap.
  const localByteCap = positiveIntFromEnv('STORAGE_IMPORT_MAX_TOTAL_BYTES', DEFAULT_IMPORT_MAX_TOTAL_BYTES);
  const warnAboveBytes = Math.min(localByteCap, DEFAULT_IMPORT_MAX_TOTAL_BYTES);
  if (exportedBytes > warnAboveBytes) {
    logger.warn(
      `Export contains ${exportedBytes} bytes, above the import limit of ${warnAboveBytes} ` +
        `(this deployment: ${localByteCap}, shipped default: ${DEFAULT_IMPORT_MAX_TOTAL_BYTES}). ` +
        'Raise STORAGE_IMPORT_MAX_TOTAL_BYTES on the destination before restoring this archive.',
    );
  }
  // finalize() rejections also emit via the 'error' handler above; catch the promise so it
  // never surfaces as an unhandled rejection.
  archive.finalize().catch(() => undefined);
}

// ============================================================================
// Import - Extract tar.gz stream to current storage
// ============================================================================

// Best-effort, NOT atomic: a single bad/traversing entry is skipped and the rest still import, and a
// resource-cap breach aborts the rest but KEEPS the entries already written (no rollback). Callers
// re-running an import is safe (putFile overwrites). A staging-dir + atomic promote would make it
// transactional, but is out of scope here. Resolves with how many entries were written and how many
// putFile refused, so a caller can tell an import that wrote nothing from an empty archive.
export async function importFromStream(
  inputStream: Readable,
  putFile: (filePath: string, data: Buffer) => Promise<void>,
  logger: LoggerService,
): Promise<{ imported: number; failed: number }> {
  let importedCount = 0;
  let failedCount = 0;
  let entryCount = 0;
  let totalBytes = 0;
  const maxEntryBytes = positiveIntFromEnv('STORAGE_IMPORT_MAX_BYTES', DEFAULT_IMPORT_MAX_BYTES);
  const maxEntries = positiveIntFromEnv('STORAGE_IMPORT_MAX_ENTRIES', DEFAULT_IMPORT_MAX_ENTRIES);
  const maxTotalBytes = positiveIntFromEnv('STORAGE_IMPORT_MAX_TOTAL_BYTES', DEFAULT_IMPORT_MAX_TOTAL_BYTES);

  const extract = tar.extract();
  const gunzip = createGunzip();

  return new Promise<{ imported: number; failed: number }>((resolve, reject) => {
    let settled = false;
    // Abort the whole import: a per-entry or total overflow or too many entries is a (zip-bomb) attack, not
    // a per-file skip — tear down the pipeline and reject so nothing further is buffered or written.
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      extract.destroy();
      gunzip.destroy();
      // Destroying the input mid-pipe stops the source; without an error arg it emits no 'error'.
      inputStream.destroy();
      // The counts reached so far ride on the rejection for the caller's audit row. A lower bound: a
      // putFile already in flight when a gzip or input error lands can still complete afterwards.
      reject(Object.assign(err, { imported: importedCount, failed: failedCount }));
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
      // Only regular files are media. A directory or link entry carries no content, and writing it
      // through putFile would store an empty file over any existing object with that key.
      if (header.type !== 'file' && header.type !== 'contiguous-file') {
        logger.debug(`Skipped ${header.type ?? 'unknown'} entry: ${header.name}`);
        stream.on('end', () => next());
        stream.resume();
        return;
      }
      // An archive packed with `tar -C dir .` names every entry `./…`; the export's keys have no such
      // segment, and on S3 it would become part of the object key.
      const key = header.name.replace(/^(?:\.\/)+/, '');

      const chunks: Buffer[] = [];
      let entryBytes = 0;
      let entryAborted = false;

      stream.on('data', (chunk: Buffer) => {
        if (entryAborted || settled) return;
        entryBytes += chunk.length;
        totalBytes += chunk.length;
        if (entryBytes > maxEntryBytes) {
          entryAborted = true;
          stream.resume(); // drain the remainder so the source can end
          fail(new Error(`Import aborted: entry "${key}" exceeds the ${maxEntryBytes}-byte per-entry cap`));
        } else if (totalBytes > maxTotalBytes) {
          // The entry that crosses the cap is dropped, so no import writes more than maxTotalBytes.
          entryAborted = true;
          stream.resume();
          fail(
            new Error(
              `Import aborted: archive exceeds the ${maxTotalBytes}-byte total cap (STORAGE_IMPORT_MAX_TOTAL_BYTES)`,
            ),
          );
        } else {
          chunks.push(chunk);
        }
      });

      stream.on('end', () => {
        if (entryAborted || settled) return;
        const data = Buffer.concat(chunks);
        putFile(key, data)
          .then(() => {
            importedCount++;
            logger.debug(`Imported file: ${key}`);
            next();
          })
          .catch((error: unknown) => {
            failedCount++;
            logger.error(`Failed to import file: ${key}`, String(error));
            next();
          });
      });
      stream.resume();
    });

    extract.on('finish', () => {
      if (settled) return;
      settled = true;
      logger.log(`Import completed: ${importedCount} files, ${failedCount} failed`);
      resolve({ imported: importedCount, failed: failedCount });
    });

    extract.on('error', (err: Error) => {
      logger.error('Import failed', String(err));
      fail(err);
    });

    inputStream.pipe(gunzip).pipe(extract);
  });
}
