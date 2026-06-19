import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { TarArchive } from 'archiver';
import * as tar from 'tar-stream';
import { createGunzip } from 'zlib';
import { Readable, PassThrough } from 'stream';
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} from '@aws-sdk/client-s3';
import { createLogger } from '../services/logger.service';
import { isPathWithin, isSafeStorageKey } from '../utils/path-safety';

interface S3Config {
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  region?: string;
  bucket?: string;
}

/** Per-entry buffer cap for an import (200 MiB — 4× the inbound media cap). Bounds a decompression bomb. */
const DEFAULT_IMPORT_MAX_BYTES = 200 * 1024 * 1024;
/** Max number of entries an import archive may contain. Bounds an entry-count DoS. */
const DEFAULT_IMPORT_MAX_ENTRIES = 100_000;

function positiveIntFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

@Injectable()
export class StorageService {
  private readonly logger = createLogger('StorageService');
  private readonly storageType: string;
  private readonly localPath: string;
  private s3Client: S3Client | null = null;
  private s3Bucket = 'openwa';
  private s3Available = false;

  constructor(private readonly configService: ConfigService) {
    this.storageType = this.configService.get<string>('storage.type') || 'local';
    this.localPath = this.configService.get<string>('storage.localPath') || './data/media';

    // Initialize S3 client if storage type is s3
    if (this.storageType === 's3') {
      const s3Config = this.configService.get<S3Config>('storage.s3') || {};
      const endpoint = process.env.S3_ENDPOINT || s3Config.endpoint;
      // Canonical names are S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY (what configuration.ts
      // and the dashboard write). The legacy S3_ACCESS_KEY / S3_SECRET_KEY are still read as
      // a fallback so existing .env files keep working.
      const accessKeyId = process.env.S3_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY || s3Config.accessKeyId;
      const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY || process.env.S3_SECRET_KEY || s3Config.secretAccessKey;
      const region = process.env.S3_REGION || s3Config.region || 'us-east-1';

      if (endpoint && accessKeyId && secretAccessKey) {
        this.s3Client = new S3Client({
          endpoint,
          region,
          credentials: {
            accessKeyId,
            secretAccessKey,
          },
          forcePathStyle: true, // Required for MinIO
        });
        this.s3Bucket = process.env.S3_BUCKET || s3Config.bucket || 'openwa';
        void this.initializeS3Bucket();
      }
    }

    // Ensure local directory exists
    if (!fs.existsSync(this.localPath)) {
      fs.mkdirSync(this.localPath, { recursive: true });
    }
  }

  private async initializeS3Bucket(): Promise<void> {
    if (!this.s3Client) return;

    try {
      await this.s3Client.send(new HeadBucketCommand({ Bucket: this.s3Bucket }));
      this.s3Available = true;
      this.logger.log(`S3 bucket '${this.s3Bucket}' is available`);
    } catch (error: unknown) {
      const err = error as { name?: string };
      if (err.name === 'NotFound' || err.name === 'NoSuchBucket') {
        // Create bucket
        try {
          await this.s3Client.send(new CreateBucketCommand({ Bucket: this.s3Bucket }));
          this.s3Available = true;
          this.logger.log(`Created S3 bucket '${this.s3Bucket}'`);
        } catch (createError) {
          this.logger.error('Failed to create S3 bucket', String(createError));
        }
      } else {
        this.logger.error('S3 bucket check failed', String(error));
      }
    }
  }

  // ============================================================================
  // Current Storage Operations
  // ============================================================================

  getCurrentStorageType(): string {
    return this.storageType;
  }

  isS3Available(): boolean {
    return this.s3Available;
  }

  async listFiles(): Promise<string[]> {
    if (this.storageType === 's3' && this.s3Client && this.s3Available) {
      return this.listS3Files();
    }
    return this.listLocalFiles();
  }

  async getFile(filePath: string): Promise<Buffer> {
    // Mirror putFile: getLocalFile has its own isPathWithin guard, but getS3File builds
    // `media/${filePath}` with none — contain both read backends at this boundary.
    if (!isSafeStorageKey(filePath)) {
      throw new Error(`Refusing to read an unsafe storage key: ${filePath}`);
    }
    if (this.storageType === 's3' && this.s3Client && this.s3Available) {
      return this.getS3File(filePath);
    }
    return this.getLocalFile(filePath);
  }

  async putFile(filePath: string, data: Buffer): Promise<void> {
    // Centralized containment so BOTH backends inherit it: putLocalFile has its own isPathWithin
    // guard, but putS3File builds `media/${filePath}` with none — reject a traversing key here.
    if (!isSafeStorageKey(filePath)) {
      throw new Error(`Refusing to store an unsafe storage key: ${filePath}`);
    }
    if (this.storageType === 's3' && this.s3Client && this.s3Available) {
      return this.putS3File(filePath, data);
    }
    return this.putLocalFile(filePath, data);
  }

  async getFileCount(): Promise<{ count: number; sizeBytes: number }> {
    const files = await this.listFiles();
    let sizeBytes = 0;

    if (this.storageType === 's3' && this.s3Client && this.s3Available) {
      // S3 size would require additional API calls, estimate
      sizeBytes = files.length * 100000; // Estimate 100KB per file
    } else {
      for (const file of files) {
        try {
          const fullPath = path.join(this.localPath, file);
          const stats = fs.statSync(fullPath);
          sizeBytes += stats.size;
        } catch (error) {
          this.logger.debug(`Failed to stat file: ${file}`, { error: String(error) });
        }
      }
    }

    return { count: files.length, sizeBytes };
  }

  // ============================================================================
  // Export - Create tar.gz stream from current storage
  // ============================================================================

  async createExportStream(): Promise<PassThrough> {
    const files = await this.listFiles();
    const output = new PassThrough();

    const archive = new TarArchive({
      gzip: true,
      gzipOptions: { level: 6 },
    });

    // Surface archive-level failures (gzip/finalize) on the returned stream instead of
    // letting them become an unhandled rejection or a silently truncated download.
    archive.on('error', (err: Error) => {
      this.logger.error('Export archive failed', String(err));
      output.destroy(err);
    });

    archive.pipe(output);

    // Add files to archive
    for (const file of files) {
      try {
        const data = await this.getFile(file);
        archive.append(data, { name: file });
      } catch (error) {
        this.logger.warn(`Failed to export file: ${file}`, { error: String(error) });
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
  async importFromStream(inputStream: Readable): Promise<number> {
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
        reject(err);
      };

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
          this.putFile(header.name, data)
            .then(() => {
              importedCount++;
              this.logger.debug(`Imported file: ${header.name}`);
              next();
            })
            .catch((error: unknown) => {
              this.logger.error(`Failed to import file: ${header.name}`, String(error));
              next();
            });
        });
        stream.resume();
      });

      extract.on('finish', () => {
        if (settled) return;
        settled = true;
        this.logger.log(`Import completed: ${importedCount} files`);
        resolve(importedCount);
      });

      extract.on('error', (err: Error) => {
        this.logger.error('Import failed', String(err));
        fail(err);
      });

      inputStream.pipe(gunzip).pipe(extract);
    });
  }

  // ============================================================================
  // Local Storage Operations
  // ============================================================================

  private listLocalFiles(dir = ''): string[] {
    const fullPath = path.join(this.localPath, dir);
    const files: string[] = [];

    if (!fs.existsSync(fullPath)) {
      return files;
    }

    const entries = fs.readdirSync(fullPath, { withFileTypes: true });

    for (const entry of entries) {
      const relativePath = dir ? path.join(dir, entry.name) : entry.name;

      if (entry.isDirectory()) {
        files.push(...this.listLocalFiles(relativePath));
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }

    return files;
  }

  private getLocalFile(filePath: string): Promise<Buffer> {
    if (!isPathWithin(this.localPath, filePath)) {
      throw new Error(`Refusing to read outside storage root: ${filePath}`);
    }
    const fullPath = path.join(this.localPath, filePath);
    // Async read so the export loop (the only caller) yields the event loop per file instead of
    // blocking it with a synchronous read for every media file.
    return fs.promises.readFile(fullPath);
  }

  private putLocalFile(filePath: string, data: Buffer): Promise<void> {
    if (!isPathWithin(this.localPath, filePath)) {
      throw new Error(`Refusing to write outside storage root: ${filePath}`);
    }
    const fullPath = path.join(this.localPath, filePath);
    const dir = path.dirname(fullPath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(fullPath, data);
    return Promise.resolve();
  }

  // ============================================================================
  // S3 Storage Operations
  // ============================================================================

  private async listS3Files(): Promise<string[]> {
    if (!this.s3Client) return [];

    const files: string[] = [];
    let continuationToken: string | undefined;

    do {
      const response = await this.s3Client.send(
        new ListObjectsV2Command({
          Bucket: this.s3Bucket,
          Prefix: 'media/',
          ContinuationToken: continuationToken,
        }),
      );

      if (response.Contents) {
        for (const obj of response.Contents) {
          if (obj.Key) {
            // Remove 'media/' prefix
            files.push(obj.Key.replace(/^media\//, ''));
          }
        }
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return files;
  }

  private async getS3File(filePath: string): Promise<Buffer> {
    if (!this.s3Client) throw new Error('S3 client not initialized');

    const response = await this.s3Client.send(
      new GetObjectCommand({
        Bucket: this.s3Bucket,
        Key: `media/${filePath}`,
      }),
    );

    if (!response.Body) throw new Error('Empty response body');

    // Convert stream to buffer
    const chunks: Buffer[] = [];
    const stream = response.Body as Readable;

    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk as ArrayBuffer));
    }

    return Buffer.concat(chunks);
  }

  private async putS3File(filePath: string, data: Buffer): Promise<void> {
    if (!this.s3Client) throw new Error('S3 client not initialized');

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.s3Bucket,
        Key: `media/${filePath}`,
        Body: data,
      }),
    );
  }
}
