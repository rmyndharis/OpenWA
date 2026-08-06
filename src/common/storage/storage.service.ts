import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { Readable, PassThrough } from 'stream';
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} from '@aws-sdk/client-s3';
import { createLogger } from '../services/logger.service';
import { isSafeStorageKey } from '../utils/path-safety';
import { createExportStream, importFromStream } from './storage-transfer';
import { listLocalFiles, iterateLocalFiles, getLocalFile, putLocalFile, deleteLocalFile } from './storage-local-files';

interface S3Config {
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  region?: string;
  bucket?: string;
}

/** How often an S3-configured service re-probes a bucket that was unreachable at boot. */
export const DEFAULT_S3_REPROBE_INTERVAL_MS = 60_000;

/**
 * True when a storage read failed because the object is simply not there.
 *
 * Both backends must be covered, and they report it differently: the local backend raises a POSIX
 * `ENOENT` (a `.code`), while S3 raises `NoSuchKey`/`NotFound`, which carries a `.name` and no
 * `.code` at all — `getS3File` below rethrows that original error when the local read-through also
 * misses. Checking only `.code` turns a missing S3 object into a 500 on the one backend where
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

@Injectable()
export class StorageService implements OnModuleDestroy {
  private readonly logger = createLogger('StorageService');
  private readonly storageType: string;
  private readonly localPath: string;
  private s3Client: S3Client | null = null;
  private s3Bucket = 'openwa';
  private s3Available = false;
  private s3ReprobeTimer: NodeJS.Timeout | null = null;
  private readonly s3ReprobeIntervalMs = positiveIntFromEnv('S3_REPROBE_INTERVAL_MS', DEFAULT_S3_REPROBE_INTERVAL_MS);

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

      // Standard AWS S3 needs only credentials + region — the SDK derives the regional endpoint, and
      // an `endpoint` is only required for S3-compatible stores (MinIO, R2, …). Requiring it dropped
      // valid AWS configs to a silent local fallback (#735). forcePathStyle is likewise a path-style
      // concern (MinIO/etc.); AWS S3 uses virtual-hosted addressing — so tie both to the endpoint.
      if (accessKeyId && secretAccessKey) {
        this.s3Client = new S3Client({
          ...(endpoint ? { endpoint } : {}),
          region,
          credentials: {
            accessKeyId,
            secretAccessKey,
          },
          ...(endpoint ? { forcePathStyle: true } : {}), // Required for path-style stores (MinIO)
        });
        this.s3Bucket = process.env.S3_BUCKET || s3Config.bucket || 'openwa';
        void this.initializeS3Bucket();
        this.startS3Reprobe();
      }
    }

    // Ensure local directory exists
    if (!fs.existsSync(this.localPath)) {
      fs.mkdirSync(this.localPath, { recursive: true });
    }
  }

  onModuleDestroy(): void {
    this.clearS3Reprobe();
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
          this.warnLocalFallback();
        }
      } else {
        this.logger.error('S3 bucket check failed', String(error));
        this.warnLocalFallback();
      }
    }
  }

  private warnLocalFallback(): void {
    this.logger.warn(
      `S3 bucket '${this.s3Bucket}' is unreachable — media storage degraded, using the local fallback dir ` +
        `'${this.localPath}'. Re-probing every ${this.s3ReprobeIntervalMs}ms; writes return to S3 once it recovers.`,
    );
  }

  /**
   * Periodically re-probe S3 while the effective backend is the local fallback (S3 was unreachable at
   * boot). Recovery is one-way: availability only ever transitions false→true here, and once S3 is
   * back the timer stops — a session already on S3 is never dropped to local by a transient error
   * without an explicit re-evaluation.
   */
  private startS3Reprobe(): void {
    this.s3ReprobeTimer = setInterval(() => {
      if (this.s3Available) {
        this.clearS3Reprobe();
        return;
      }
      void this.refreshS3Availability().then(available => {
        if (!available) this.warnLocalFallback();
      });
    }, this.s3ReprobeIntervalMs);
    // Don't keep the process alive for a probe; shutdown clears it via onModuleDestroy.
    this.s3ReprobeTimer.unref();
  }

  private clearS3Reprobe(): void {
    if (this.s3ReprobeTimer) {
      clearInterval(this.s3ReprobeTimer);
      this.s3ReprobeTimer = null;
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

  private lastS3Check = 0;
  private s3CheckInFlight: Promise<void> | null = null;

  /**
   * Re-probe S3/MinIO reachability when it's currently marked unavailable — e.g. a bundled MinIO that
   * came up AFTER the app booted (the init HeadBucket raced and latched false). Throttled (10s) and
   * in-flight-deduped so the status endpoint and the periodic re-probe can call it cheaply. Once
   * available it stays available (no need to re-probe a healthy backend here).
   */
  async refreshS3Availability(): Promise<boolean> {
    if (this.storageType !== 's3' || !this.s3Client || this.s3Available) return this.s3Available;
    if (this.s3CheckInFlight) {
      await this.s3CheckInFlight;
      return this.s3Available;
    }
    const now = Date.now();
    if (now - this.lastS3Check < 10_000) return this.s3Available;
    this.lastS3Check = now;
    this.s3CheckInFlight = (async () => {
      try {
        await this.s3Client!.send(new HeadBucketCommand({ Bucket: this.s3Bucket }));
        this.s3Available = true;
        // WARN (not log): the degraded window matters — media written to the local fallback dir while
        // S3 was down stays local-only; reads for those keys keep working via the NoSuchKey
        // read-through in getS3File, but the operator should reconcile/acknowledge the gap.
        this.logger.warn(
          `S3 bucket '${this.s3Bucket}' recovered — media storage back on S3. Files written to the local ` +
            `fallback dir '${this.localPath}' during the outage remain there (still readable via read-through).`,
        );
      } catch {
        // still unreachable — leave s3Available false; a later poll retries after the throttle window
      } finally {
        this.s3CheckInFlight = null;
      }
    })();
    await this.s3CheckInFlight;
    return this.s3Available;
  }

  async listFiles(): Promise<string[]> {
    if (this.storageType === 's3' && this.s3Client && this.s3Available) {
      // Union with the local fallback dir: media written locally while S3 was down is otherwise
      // invisible to enumeration — getFile reads through to it, so a listing that omits it
      // contradicts what reads serve, and a sweep reconciling against this listing could never
      // reclaim it.
      const files = new Set(await this.listS3Files());
      for (const file of await this.listLocalFiles()) files.add(file);
      return [...files];
    }
    return this.listLocalFiles();
  }

  /**
   * Enumerate every file in the store (all S3 pages unioned with the local fallback dir, each key
   * once) as a stream — unlike listFiles(), whose STORAGE_LIST_MAX_FILES truncation is a per-call
   * DoS guard, not a completeness contract. Callers that must reconcile against the full store
   * (e.g. the status-media orphan sweep) should iterate this instead of a single capped listing.
   *
   * `prefix` narrows the walk at the source — the S3 ListObjectsV2 prefix and the local traversal
   * root — so a caller reconciling one subtree neither pages the whole store nor holds every key
   * of it in the dedupe Set. Removing the per-call cap must not trade one unbounded read for
   * another.
   */
  async *iterateFiles(prefix = ''): AsyncGenerator<string> {
    if (this.storageType === 's3' && this.s3Client && this.s3Available) {
      const seen = new Set<string>();
      for await (const file of this.iterateS3Files(prefix)) {
        seen.add(file);
        yield file;
      }
      for await (const file of this.iterateLocalFiles(prefix)) {
        if (!seen.has(file)) yield file;
      }
      return;
    }
    yield* this.iterateLocalFiles(prefix);
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

  /**
   * Delete a file previously written via `putFile`. Same unsafe-key guard as `getFile`/`putFile` (both
   * backends key off it, S3's has no host filesystem to check `isPathWithin` against). When S3 is
   * active the key is deleted from BOTH backends — delete-through, symmetric with getFile's
   * read-through: the key may exist only in the local fallback dir (written during an S3 outage),
   * and deleting just the S3 object would orphan those bytes permanently once the caller drops its
   * DB reference. Missing-file is treated as success on both backends (local: ENOENT is swallowed;
   * S3 DeleteObject is idempotent by design) so a caller doesn't have to special-case "already gone".
   */
  async deleteFile(filePath: string): Promise<void> {
    if (!isSafeStorageKey(filePath)) {
      throw new Error(`Refusing to delete an unsafe storage key: ${filePath}`);
    }
    if (this.storageType === 's3' && this.s3Client && this.s3Available) {
      await this.deleteS3File(filePath);
    }
    return this.deleteLocalFile(filePath);
  }

  async getFileCount(): Promise<{ count: number; sizeBytes: number }> {
    if (this.storageType === 's3' && this.s3Client && this.s3Available) {
      // ListObjectsV2 already returns each object's Size, so report the real total instead of a
      // 100KB-per-file estimate — no extra API calls beyond the listing we'd do anyway.
      const s3 = await this.getS3CountAndSize();
      // Union with the local fallback dir (same split-brain gap as listFiles): a local-only file
      // counts with its real on-disk size; for a key present in both, the S3 copy is authoritative.
      const s3Keys = new Set(s3.keys);
      let { count, sizeBytes } = s3;
      for await (const file of this.iterateLocalFiles()) {
        if (s3Keys.has(file)) continue;
        count += 1;
        try {
          sizeBytes += fs.statSync(path.join(this.localPath, file)).size;
        } catch (error) {
          this.logger.debug(`Failed to stat file: ${file}`, { error: String(error) });
        }
      }
      return { count, sizeBytes };
    }

    const files = await this.listFiles();
    let sizeBytes = 0;
    for (const file of files) {
      try {
        const fullPath = path.join(this.localPath, file);
        const stats = fs.statSync(fullPath);
        sizeBytes += stats.size;
      } catch (error) {
        this.logger.debug(`Failed to stat file: ${file}`, { error: String(error) });
      }
    }

    return { count: files.length, sizeBytes };
  }

  private async getS3CountAndSize(): Promise<{ count: number; sizeBytes: number; keys: string[] }> {
    let count = 0;
    let sizeBytes = 0;
    // Keys (prefix-stripped) are kept so getFileCount can union the local fallback dir without a
    // second listing.
    const keys: string[] = [];
    let continuationToken: string | undefined;

    do {
      const response = await this.s3Client!.send(
        new ListObjectsV2Command({
          Bucket: this.s3Bucket,
          Prefix: 'media/',
          ContinuationToken: continuationToken,
        }),
      );

      for (const obj of response.Contents ?? []) {
        count += 1;
        sizeBytes += obj.Size ?? 0;
        if (obj.Key) keys.push(obj.Key.replace(/^media\//, ''));
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return { count, sizeBytes, keys };
  }

  // ============================================================================
  // Export/Import - tar.gz streams (implemented in storage-transfer.ts)
  // ============================================================================

  createExportStream(): Promise<PassThrough> {
    return createExportStream(
      () => this.listFiles(),
      filePath => this.getFile(filePath),
      this.logger,
    );
  }

  // Best-effort, NOT atomic: see the implementation in storage-transfer.ts for the full contract.
  importFromStream(inputStream: Readable): Promise<number> {
    return importFromStream(inputStream, (filePath, data) => this.putFile(filePath, data), this.logger);
  }

  // ============================================================================
  // Local Storage Operations (implemented in storage-local-files.ts)
  // ============================================================================

  /**
   * Enumerate local files under the storage root, capped at STORAGE_LIST_MAX_FILES — a per-call
   * DoS guard (a healthy media store stays well under it), NOT a completeness contract. Callers
   * that must see the whole tree use iterateFiles().
   */
  private listLocalFiles(): Promise<string[]> {
    return listLocalFiles(this.localPath);
  }

  /**
   * Full local enumeration as a stream — no count cap. Async + iterative (a work queue, not
   * recursion) so a deep/wide media tree can't block the event loop or stack-overflow; still
   * bounded by the max directory depth so a pathological tree can't descend unbounded.
   */
  private iterateLocalFiles(prefix = ''): AsyncGenerator<string> {
    return iterateLocalFiles(this.localPath, prefix);
  }

  private getLocalFile(filePath: string): Promise<Buffer> {
    return getLocalFile(this.localPath, filePath);
  }

  private putLocalFile(filePath: string, data: Buffer): Promise<void> {
    return putLocalFile(this.localPath, filePath, data);
  }

  private deleteLocalFile(filePath: string): Promise<void> {
    return deleteLocalFile(this.localPath, filePath);
  }

  // ============================================================================
  // S3 Storage Operations
  // ============================================================================

  private async listS3Files(): Promise<string[]> {
    const files: string[] = [];
    for await (const file of this.iterateS3Files()) files.push(file);
    return files;
  }

  /** Stream every S3 object key (prefix-stripped), following the ListObjectsV2 pagination token. */
  private async *iterateS3Files(prefix = ''): AsyncGenerator<string> {
    if (!this.s3Client) return;

    let continuationToken: string | undefined;

    do {
      const response = await this.s3Client.send(
        new ListObjectsV2Command({
          Bucket: this.s3Bucket,
          Prefix: `media/${prefix}`,
          ContinuationToken: continuationToken,
        }),
      );

      for (const obj of response.Contents ?? []) {
        if (obj.Key) {
          // Remove 'media/' prefix
          yield obj.Key.replace(/^media\//, '');
        }
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);
  }

  private async getS3File(filePath: string): Promise<Buffer> {
    if (!this.s3Client) throw new Error('S3 client not initialized');

    let response;
    try {
      response = await this.s3Client.send(
        new GetObjectCommand({
          Bucket: this.s3Bucket,
          Key: `media/${filePath}`,
        }),
      );
    } catch (error: unknown) {
      // Read-through: media written while S3 was down lives only in the local fallback dir, so after
      // recovery a plain S3 read would split-brain (NoSuchKey even though the app served the file
      // fine during the outage). Fall through to the local copy; if there is none, surface the
      // original S3 error so "not found" semantics are unchanged.
      if ((error as { name?: string }).name !== 'NoSuchKey') throw error;
      try {
        const local = await this.getLocalFile(filePath);
        this.logger.debug(`Served '${filePath}' from the local fallback dir (not yet in S3)`);
        return local;
      } catch {
        throw error;
      }
    }

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

  private async deleteS3File(filePath: string): Promise<void> {
    if (!this.s3Client) throw new Error('S3 client not initialized');

    await this.s3Client.send(
      new DeleteObjectCommand({
        Bucket: this.s3Bucket,
        Key: `media/${filePath}`,
      }),
    );
  }
}
