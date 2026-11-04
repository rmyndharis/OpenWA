import * as tar from 'tar-stream';
import { createGunzip, createGzip } from 'zlib';
import { Readable, PassThrough, Transform, pipeline } from 'stream';
import { ServiceUnavailableException, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { createLogger, LoggerService } from '../services/logger.service';
import { positiveIntFromEnv } from '../utils/env-int';

/** Per-entry buffer cap for an import (200 MiB — 4× the inbound media cap). Bounds a decompression bomb. */
export const DEFAULT_IMPORT_MAX_BYTES = 200 * 1024 * 1024;
/** Max number of entries an import archive may contain. Bounds an entry-count DoS. */
export const DEFAULT_IMPORT_MAX_ENTRIES = 100_000;
/** Cap on the bytes one import extracts in total (10 GiB). The two caps above still allow terabytes. */
export const DEFAULT_IMPORT_MAX_TOTAL_BYTES = 10 * 1024 * 1024 * 1024;

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

// ============================================================================
// Export - Create tar.gz stream from current storage
// ============================================================================

/**
 * A file opened for export. `size` is the byte length the tar header declares; without it the entry
 * has to be buffered to learn its length.
 */
export interface ExportFileSource {
  stream: Readable;
  size?: number;
}

const storedFileLogger = createLogger('StoredFile');

/** Seconds a download refused for a full pool is told to wait: a place frees as soon as any open download ends. */
export const DOWNLOADS_BUSY_RETRY_AFTER_SECONDS = 1;

/** A download refused at once because the S3 download pool is full. */
export class DownloadsBusyException extends ServiceUnavailableException {
  constructor() {
    super('Too many media downloads are in progress; retry shortly');
  }
}

/** For a download route's `.catch`: a refusal for a full pool goes out with a Retry-After. Every error is rethrown. */
export function retryAfterWhenBusy(res: Response): (error: unknown) => never {
  return error => {
    if (error instanceof DownloadsBusyException) res.set('Retry-After', String(DOWNLOADS_BUSY_RETRY_AFTER_SECONDS));
    throw error;
  };
}

/**
 * Answer a stored file as an attachment, streamed rather than read into memory first. Content-Length
 * goes out only when the store reported a size. A read that fails before the first byte drops the
 * media headers and answers the JSON 500 a failed whole-file read used to; one that fails after it
 * cuts the connection, since the status line has gone out and a short body must not pass for the file.
 */
export function storedFileAttachment(res: Response, source: ExportFileSource, mimetype: string): StreamableFile {
  res.set({ 'Content-Type': mimetype, 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'attachment' });
  const file = new StreamableFile(source.stream, source.size === undefined ? {} : { length: source.size });
  const cutConnection = file.errorHandler;
  return file.setErrorHandler((error, response) => {
    if (response.destroyed || response.headersSent) return cutConnection(error, response);
    storedFileLogger.error('Reading a stored file failed before any of it was sent', String(error));
    res.removeHeader('Content-Type');
    res.removeHeader('Content-Disposition');
    res.removeHeader('Content-Length');
    res.status(500).json({ statusCode: 500, message: 'Internal server error' });
  });
}

type TarPack = ReturnType<typeof tar.pack>;

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
  // The importer aborts a whole archive past STORAGE_IMPORT_MAX_ENTRIES. The export carries the whole
  // store, so a large one can produce an archive this gateway refuses to restore, and the operator
  // would only find out at restore time, after decommissioning the source. Say it at EXPORT time instead.
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

  const pack = tar.pack();
  const gzip = createGzip({ level: 6 });

  // Surface archive-level failures (tar/gzip) on the returned stream instead of letting them become an
  // uncaught 'error' event or a silently truncated download.
  const failArchive = (err: Error): void => {
    logger.error('Export archive failed', String(err));
    output.destroy(err);
  };
  pack.on('error', failArchive);
  gzip.on('error', failArchive);

  pack.pipe(gzip).pipe(output);
  // The output closes early when the archive fails or the consumer goes away: release the tar and gzip
  // streams with whatever they still buffer. After a clean finish both have ended, so this does nothing.
  output.once('close', () => {
    pack.destroy();
    gzip.destroy();
  });

  appendEntries(files, openFile, pack, output, logger).catch((err: Error) => output.destroy(err));
  return output;
}

function enforceSize(file: string, size: number | undefined, onRead: (bytes: number) => void): Transform {
  let seen = 0;
  const mismatch = (): Error => new Error(`Export failed: ${file} changed size while being read (expected ${size})`);
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      callback(size !== undefined && seen > size ? mismatch() : null, chunk);
    },
    flush(callback) {
      if (size !== undefined && seen < size) return callback(mismatch());
      onRead(seen);
      callback();
    },
  });
}

/**
 * Write one tar entry from `source` and call `done` once it is complete or torn down. A known size is
 * piped straight into the entry; without one the source is buffered first, since a tar header has to
 * declare the length up front. A failed entry also destroys the pack, which fails the output through
 * its 'error' listener, so the entry's own error is not needed here; it still needs a listener of its
 * own, because an 'error' event nothing listens for would crash the process.
 */
function writeEntry(
  pack: TarPack,
  source: Readable,
  header: { name: string; mode: number; mtime: Date },
  size: number | undefined,
  output: PassThrough,
  done: () => void,
): void {
  if (size !== undefined) {
    const sink = pack.entry({ ...header, size }, () => done());
    sink.on('error', () => undefined);
    source.pipe(sink);
    return;
  }
  const chunks: Buffer[] = [];
  source.on('data', (chunk: Buffer) => chunks.push(chunk));
  source.on('end', () => {
    // The pack is gone once the output closed, and adding an entry to a destroyed pack throws.
    if (output.destroyed) return;
    pack.entry(header, Buffer.concat(chunks), () => done()).on('error', () => undefined);
  });
}

async function appendEntries(
  files: string[],
  openFile: (filePath: string) => Promise<ExportFileSource>,
  pack: TarPack,
  output: PassThrough,
  logger: LoggerService,
): Promise<void> {
  let exportedBytes = 0;
  let largest = { file: '', size: 0 };
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
    // The output closes early when the archive fails or the consumer goes away: stop reading files.
    // Checked synchronously before waiting, so a 'close' that already fired cannot be missed.
    if (output.destroyed) {
      stream.destroy();
      break;
    }
    // The tar sink fails with a bare "Size mismatch" when an entry's length differs from the size in
    // its header. A file rewritten between open and read does that, so the length is checked here and
    // a mismatch fails the export like a read error, naming the file, before the sink sees the extra
    // byte or the early end. pipeline() also forwards a source error, which pipe() does not.
    // The import-limit warnings below count the bytes read, since a backend may not report a length.
    const entry = pipeline(
      stream,
      enforceSize(file, size, bytes => {
        exportedBytes += bytes;
        if (bytes > largest.size) largest = { file, size: bytes };
      }),
      err => {
        if (!err || output.destroyed) return;
        logger.error(`Export failed reading file: ${file}`, String(err));
        output.destroy(err);
      },
    );
    await new Promise<void>(resolve => {
      const done = (): void => {
        output.removeListener('close', done);
        resolve();
      };
      output.on('close', done);
      writeEntry(pack, entry, { name: file, mode: 0o644, mtime: new Date() }, size, output, done);
    });
    if (output.destroyed) {
      stream.destroy();
      break;
    }
  }
  if (output.destroyed) return;
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
  // And for the per-entry cap: one file above it aborts the whole import.
  const localEntryCap = positiveIntFromEnv('STORAGE_IMPORT_MAX_BYTES', DEFAULT_IMPORT_MAX_BYTES);
  const warnAboveEntry = Math.min(localEntryCap, DEFAULT_IMPORT_MAX_BYTES);
  if (largest.size > warnAboveEntry) {
    logger.warn(
      `Export contains ${largest.file} (${largest.size} bytes), above the per-entry import limit of ${warnAboveEntry} ` +
        `(this deployment: ${localEntryCap}, shipped default: ${DEFAULT_IMPORT_MAX_BYTES}). ` +
        'Raise STORAGE_IMPORT_MAX_BYTES on the destination before restoring this archive.',
    );
  }
  pack.finalize();
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
    // Abort the whole import, not just the entry: a cap breach can be a decompression bomb or a store
    // larger than the configured limit. Tear down the pipeline and reject so nothing further is buffered
    // or written.
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
        fail(new Error(`Import aborted: archive exceeds the ${maxEntries}-entry limit (STORAGE_IMPORT_MAX_ENTRIES)`));
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
          fail(
            new Error(
              `Import aborted: entry "${key}" exceeds the ${maxEntryBytes}-byte per-entry cap (STORAGE_IMPORT_MAX_BYTES)`,
            ),
          );
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
