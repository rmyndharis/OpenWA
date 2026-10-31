import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { Readable, PassThrough, Transform, finished, pipeline } from 'stream';
import {
  S3Client,
  S3ClientConfig,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} from '@aws-sdk/client-s3';
import { createLogger } from '../services/logger.service';
import { positiveIntFromEnv } from '../utils/env-int';
import { isSafeStorageKey } from '../utils/path-safety';
import { DEFAULT_S3_KEY_PREFIX, normalizeS3KeyPrefix } from './s3-key-prefix';
import {
  createExportStream,
  DownloadsBusyException,
  ExportFileSource,
  importFromStream,
  isMissingObjectError,
} from './storage-transfer';
import { iterateLocalFiles, getLocalFile, openLocalFile, putLocalFile, deleteLocalFile } from './storage-local-files';

// Re-exported so feature modules keep importing it next to StorageService.
export { isMissingObjectError } from './storage-transfer';

interface S3Config {
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  region?: string;
  bucket?: string;
  keyPrefix?: string;
}

/** How often an S3-configured service re-probes a bucket that was unreachable at boot. */
export const DEFAULT_S3_REPROBE_INTERVAL_MS = 60_000;

/**
 * Cap on one S3 DeleteObject. The retention purges delete row by row behind a single-flight guard,
 * so a delete that never settles would hold that guard and stop every later purge until a restart.
 */
export const S3_DELETE_TIMEOUT_MS = 30_000;

/**
 * Cap on one bucket probe request. The status endpoint and the storage migration routes await the
 * probe, and every later re-probe waits on one already in flight, so it gets a tighter bound than
 * the idle-socket timeout below, and one that also stops the SDK's retries.
 */
export const S3_PROBE_TIMEOUT_MS = 10_000;

/**
 * Connect and idle-socket bounds for every S3 request. Without them a store that accepts the
 * connection and never answers (a paused container, a stuck proxy) leaves the request pending
 * forever, holding its media buffer and the caller. The socket bound is an idle timeout, so a long
 * upload or download that keeps moving bytes is not cut off. A bare requestTimeout would not do:
 * the HTTP handler only logs a warning when it expires. The HTTP handler stops applying the socket
 * bound once the response headers arrive, so an object body gets the same idle bound in openS3File,
 * and a listing page S3_LIST_TIMEOUT_MS.
 */
export const S3_CONNECT_TIMEOUT_MS = 5_000;
export const S3_SOCKET_TIMEOUT_MS = 30_000;

/**
 * Cap on one ListObjectsV2 page, the whole request. A page holds at most 1000 keys, a few hundred kilobytes,
 * so a page that is moving has ample time, while one whose body stalls would hang an orphan sweep for good:
 * its guarded interval skips every later tick while that run is pending.
 */
export const S3_LIST_TIMEOUT_MS = 30_000;

/**
 * Downloads open at once on the stream client, the SDK's pool size. Each holds a pooled socket until its
 * stream finishes; one more would wait for a socket until three connect timeouts failed it, about 15 s.
 */
export const S3_MAX_OPEN_DOWNLOADS = 50;

/**
 * How long an S3 download may wait on its reader, from the last chunk that reader let through. An HTTP reader
 * takes from the body only once the response socket and the kernel buffers on the way to the client have room
 * again: on Linux, once the client has read about 1.1 MiB (after about 2.7 MiB filled them; about 250 KiB on
 * macOS), so a client reading 3 to 8 KiB/s pulls every 2 to 6 minutes, and with no Range to resume from a cut
 * there means a large file never arrives. Ten minutes keeps a client reading about 2 KiB/s or more going; a
 * reader that stopped holds its download place that long.
 */
export const S3_READER_IDLE_MS = 600_000;

/**
 * Pass an object body on, failing it with a TimeoutError once nothing has come through it for idleMs while it
 * waits on the store, or for readerIdleMs while its reader holds it back. The reader is behind while the guard's
 * readable side is full, which also covers the tail once the store has sent the last byte. The timer is cleared
 * once the whole body has come through, so it only fires while the pipeline still listens for the guard's error.
 */
function withIdleBound(body: Readable, idleMs: number, readerIdleMs: number): Readable {
  // A full readable side can only refill through transform, so this counts from the reader's last take.
  let heldBackMs = 0;
  const timer = setTimeout(() => {
    const readerBehind = guard.readableLength >= guard.readableHighWaterMark;
    if (readerBehind && (heldBackMs += idleMs) < readerIdleMs) {
      timer.refresh();
      return;
    }
    const idle = readerBehind ? `reader took nothing for ${heldBackMs} ms` : `body sent nothing for ${idleMs} ms`;
    guard.destroy(Object.assign(new Error(`S3 object ${idle}`), { name: 'TimeoutError' }));
  }, idleMs);
  timer.unref();
  const guard = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      heldBackMs = 0;
      timer.refresh();
      callback(null, chunk);
    },
    flush(callback) {
      clearTimeout(timer);
      callback();
    },
    destroy(error, callback) {
      clearTimeout(timer);
      callback(error);
    },
  });
  // pipeline, not pipe: destroying the guard (a client that went away, or the timer) must destroy the body too.
  pipeline(body, guard, () => undefined);
  return guard;
}

@Injectable()
export class StorageService implements OnModuleDestroy {
  private readonly logger = createLogger('StorageService');
  private readonly storageType: string;
  private readonly localPath: string;
  private s3Client: S3Client | null = null;
  /**
   * Serves openFile. A stream holds its pooled socket until its reader has taken the whole object, so a slow
   * HTTP client holds it for its whole download, a stalled store for S3_SOCKET_TIMEOUT_MS and a stopped reader
   * for S3_READER_IDLE_MS. On a pool of their own, a burst of downloads cannot leave the writes, deletes and
   * listings on s3Client waiting for a socket.
   */
  private s3StreamClient: S3Client | null = null;
  private s3OpenDownloads = 0;
  private s3Bucket = 'openwa';
  private s3KeyRoot = DEFAULT_S3_KEY_PREFIX;
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
        const clientConfig: S3ClientConfig = {
          ...(endpoint ? { endpoint } : {}),
          region,
          credentials: {
            accessKeyId,
            secretAccessKey,
          },
          ...(endpoint ? { forcePathStyle: true } : {}), // Required for path-style stores (MinIO)
          requestHandler: { connectionTimeout: S3_CONNECT_TIMEOUT_MS, socketTimeout: S3_SOCKET_TIMEOUT_MS },
        };
        // Each client builds its own HTTP handler, and with it its own socket pool.
        this.s3Client = new S3Client(clientConfig);
        this.s3StreamClient = new S3Client(clientConfig);
        this.s3Bucket = process.env.S3_BUCKET || s3Config.bucket || 'openwa';
        const keyRoot = normalizeS3KeyPrefix(process.env.S3_KEY_PREFIX || s3Config.keyPrefix);
        if (!keyRoot) throw new Error('S3_KEY_PREFIX is not a safe relative key prefix');
        this.s3KeyRoot = keyRoot;
        void this.initializeS3Bucket();
        this.startS3Reprobe();
      } else {
        // Every other degradation in this service announces itself, but this one could not: the
        // logging all lives past the client construction above, so an s3 deployment missing its
        // credentials built no client, wrote every file to local disk, and said nothing at all.
        // The operator's first symptom was an empty bucket with no failure to point at.
        //
        // Name the variables actually missing rather than declaring all of them absent: reaching
        // here with one of the pair set is a plain typo in the other, and "no credentials found"
        // would send that operator looking at the one they got right.
        const missing = [
          accessKeyId ? null : 'S3_ACCESS_KEY_ID',
          secretAccessKey ? null : 'S3_SECRET_ACCESS_KEY',
        ].filter((name): name is string => name !== null);
        this.logger.warn(
          `STORAGE_TYPE=s3 but ${missing.join(' and ')} is not set; media is being written to the ` +
            `local dir '${this.localPath}' instead of the bucket. The built-in MinIO uses ` +
            `minioadmin/minioadmin.`,
        );
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
      await this.ensureS3Bucket();
      this.s3Available = true;
      this.logger.log(`S3 bucket '${this.s3Bucket}' is available`);
    } catch (error: unknown) {
      this.logger.error('S3 bucket check failed', String(error));
      this.lastS3Error = String(error);
      this.warnLocalFallback();
    }
  }

  /**
   * HeadBucket, and create the bucket when the store answers that it does not exist. Throws when the
   * store is unreachable or the create fails. The boot probe and every re-probe share it: a store that
   * was down at boot and comes back empty (a fresh MinIO volume) must still get its bucket, or the
   * re-probe would see NotFound forever and S3 would never become available without a restart.
   */
  private async ensureS3Bucket(): Promise<void> {
    try {
      await this.s3Client!.send(new HeadBucketCommand({ Bucket: this.s3Bucket }), {
        abortSignal: AbortSignal.timeout(S3_PROBE_TIMEOUT_MS),
      });
      return;
    } catch (error: unknown) {
      const name = (error as { name?: string }).name;
      if (name !== 'NotFound' && name !== 'NoSuchBucket') throw error;
    }
    try {
      await this.s3Client!.send(new CreateBucketCommand({ Bucket: this.s3Bucket }), {
        abortSignal: AbortSignal.timeout(S3_PROBE_TIMEOUT_MS),
      });
    } catch (error: unknown) {
      // Another replica (or an overlapping probe) created it first, and this deployment owns it.
      // BucketAlreadyExists means another account owns the name, so that one still throws.
      if ((error as { name?: string }).name !== 'BucketAlreadyOwnedByYou') throw error;
      return;
    }
    this.logger.log(`Created S3 bucket '${this.s3Bucket}'`);
  }

  private warnLocalFallback(): void {
    this.logger.warn(
      `S3 bucket '${this.s3Bucket}' is unavailable (${this.lastS3Error}); media storage degraded, using the ` +
        `local fallback dir '${this.localPath}'. Re-probing every ${this.s3ReprobeIntervalMs}ms; writes return ` +
        'to S3 once it recovers.',
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

  private lastS3Check = 0;
  /** Why the last probe failed. The fallback warning names it: a store refusing the create is not an outage. */
  private lastS3Error = '';
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
        await this.ensureS3Bucket();
        this.s3Available = true;
        // WARN (not log): the degraded window matters — media written to the local fallback dir while
        // S3 was down stays local-only; reads for those keys keep working via the NoSuchKey
        // read-through in getS3File, but the operator should reconcile/acknowledge the gap.
        this.logger.warn(
          `S3 bucket '${this.s3Bucket}' recovered — media storage back on S3. Files written to the local ` +
            `fallback dir '${this.localPath}' during the outage remain there (still readable via read-through).`,
        );
      } catch (error: unknown) {
        // still unavailable: leave s3Available false; a later poll retries after the throttle window
        this.lastS3Error = String(error);
      } finally {
        this.s3CheckInFlight = null;
      }
    })();
    await this.s3CheckInFlight;
    return this.s3Available;
  }

  /**
   * Enumerate every file in the store (all S3 pages unioned with the local fallback dir, each key
   * once) as a stream. The union matters: media written locally while S3 was down is otherwise
   * invisible to enumeration, although getFile reads through to it, and a sweep reconciling against
   * the listing could never reclaim it. Callers that must reconcile against the full store (e.g.
   * the status-media orphan sweep) iterate this.
   *
   * `prefix` narrows the walk at the source (the S3 ListObjectsV2 prefix and the local traversal
   * root), so a caller reconciling one subtree neither pages the whole store nor walks the rest.
   *
   * The local dir is walked first and its keys remembered, so a key in both is listed once: on an
   * S3 deployment it holds what was written during an outage (and, after a move from local storage, the old
   * local media until it is cleaned up), while the bucket can hold an
   * archive of millions of files that the S3 pages then stream past without being kept.
   *
   * A local directory the walk cannot read fails it, so no caller is handed a short listing without
   * knowing. `skipUnreadable` is for a caller that only acts on the files it was shown (an orphan
   * sweep): the directory is named in a warning and left alone.
   */
  async *iterateFiles(prefix = '', options: { skipUnreadable?: boolean } = {}): AsyncGenerator<string> {
    if (this.storageType === 's3' && this.s3Client && this.s3Available) {
      const local = new Set<string>();
      for await (const file of this.iterateLocalFiles(prefix, options.skipUnreadable)) {
        local.add(file);
        yield file;
      }
      for await (const file of this.iterateS3Files(prefix)) {
        if (!local.has(file)) yield file;
      }
      return;
    }
    yield* this.iterateLocalFiles(prefix, options.skipUnreadable);
  }

  async getFile(filePath: string): Promise<Buffer> {
    // Mirror putFile: getLocalFile has its own isPathWithin guard, but getS3File builds
    // `${s3KeyRoot}${filePath}` with none, so contain both read backends at this boundary.
    if (!isSafeStorageKey(filePath)) {
      throw new Error(`Refusing to read an unsafe storage key: ${filePath}`);
    }
    if (this.storageType === 's3' && this.s3Client && this.s3Available) {
      return this.getS3File(filePath);
    }
    return this.getLocalFile(filePath);
  }

  /**
   * Open a file as a stream instead of reading it into memory, with the same key guard and S3
   * read-through as getFile. A missing or unreadable file rejects here rather than on the stream.
   * On S3 a download past S3_MAX_OPEN_DOWNLOADS is refused at once with a 503.
   */
  async openFile(filePath: string): Promise<ExportFileSource> {
    return this.openStoredFile(filePath, this.s3StreamClient);
  }

  private async openStoredFile(filePath: string, client: S3Client | null): Promise<ExportFileSource> {
    if (!isSafeStorageKey(filePath)) {
      throw new Error(`Refusing to read an unsafe storage key: ${filePath}`);
    }
    if (this.storageType === 's3' && this.s3Client && this.s3Available) {
      return this.openS3File(filePath, client);
    }
    return openLocalFile(this.localPath, filePath);
  }

  async putFile(filePath: string, data: Buffer): Promise<void> {
    // Centralized containment so BOTH backends inherit it: putLocalFile has its own isPathWithin
    // guard, but putS3File builds `${s3KeyRoot}${filePath}` with none, so reject a traversing key here.
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
      // Union with the local fallback dir (media written locally while S3 was down is not in the
      // bucket listing): a local-only file counts with its real on-disk size; for a key present in
      // both, the S3 copy is authoritative.
      const s3Keys = new Set(s3.keys);
      let { count, sizeBytes } = s3;
      for await (const file of this.iterateLocalFiles()) {
        if (s3Keys.has(file) || !this.isExportableKey(file)) continue;
        count += 1;
        try {
          // Same reason as the local branch below: the walk covers the whole store, so the stat must yield.
          sizeBytes += (await fs.promises.stat(path.join(this.localPath, file))).size;
        } catch (error) {
          this.logger.debug(`Failed to stat file: ${file}`, { error: String(error) });
        }
      }
      return { count, sizeBytes };
    }

    // The whole store is walked, for the same reason createExportStream does: this is the pre-check an
    // operator runs BEFORE the export/import migration, so it has to see every file the export will carry.
    const files = await this.listExportableFiles();
    let sizeBytes = 0;
    for (const file of files) {
      try {
        const fullPath = path.join(this.localPath, file);
        // Awaited, not statSync: a synchronous stat per file holds the event loop for the whole store,
        // so health checks, webhooks and every in-flight request wait behind a count. Measured at one
        // event-loop tick for 2000 files.
        const stats = await fs.promises.stat(fullPath);
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
          Prefix: this.s3KeyRoot,
          ContinuationToken: continuationToken,
        }),
        { abortSignal: AbortSignal.timeout(S3_LIST_TIMEOUT_MS) },
      );

      for (const obj of response.Contents ?? []) {
        const key = this.stripS3KeyRoot(obj.Key);
        if (key === null || !this.isExportableKey(key)) continue;
        count += 1;
        sizeBytes += obj.Size ?? 0;
        keys.push(key);
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return { count, sizeBytes, keys };
  }

  // ============================================================================
  // Export/Import - tar.gz streams (implemented in storage-transfer.ts)
  // ============================================================================

  createExportStream(): Promise<PassThrough> {
    // The whole store is enumerated (iterateFiles): an export exists to be complete, and a short one
    // would leave media behind on the old backend silently after the documented local→S3 migration
    // (export, repoint STORAGE_TYPE, import).
    // A listed key openFile would refuse (an S3 object named `..`, or one sitting exactly at the key
    // root) is left out here: the export fails on any open error other than a missing object, and a
    // key that can never be opened must not fail every export.
    // Entries are read on s3Client, one at a time: the downloads' pool can be full, and the export must not
    // fail behind it.
    return createExportStream(
      () => this.listExportableFiles(),
      filePath => this.openStoredFile(filePath, this.s3Client),
      this.logger,
    );
  }

  /**
   * Whether the export carries a listed key. The file count applies the same rule, so the pre-check never
   * promises a file the archive will not hold.
   */
  private isExportableKey(file: string): boolean {
    // A key ending in "/" is a folder placeholder an S3 console leaves behind: it holds no file, and written to
    // the archive as one it would fail the import that restores it onto a local store.
    if (file.endsWith('/')) return false;
    if (isSafeStorageKey(file)) return true;
    this.logger.warn(`Leaving an unsafe storage key out of the export and the file count: ${JSON.stringify(file)}`);
    return false;
  }

  /** Every key in the store that the export carries. */
  private async listExportableFiles(): Promise<string[]> {
    const files: string[] = [];
    for await (const file of this.iterateFiles()) {
      if (this.isExportableKey(file)) files.push(file);
    }
    return files;
  }

  // Best-effort, NOT atomic: see the implementation in storage-transfer.ts for the full contract.
  importFromStream(inputStream: Readable): Promise<{ imported: number; failed: number }> {
    return importFromStream(inputStream, (filePath, data) => this.putFile(filePath, data), this.logger);
  }

  // ============================================================================
  // Local Storage Operations (implemented in storage-local-files.ts)
  // ============================================================================

  /**
   * Local enumeration as a stream. Async + iterative (a work queue, not recursion) so a deep/wide
   * media tree can't block the event loop or stack-overflow; still bounded by the max directory
   * depth so a pathological tree can't descend unbounded.
   */
  private iterateLocalFiles(prefix = '', skipUnreadable = false): AsyncGenerator<string> {
    return iterateLocalFiles(this.localPath, prefix, { skipUnreadable, logger: this.logger });
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

  /** Stream every S3 object key (prefix-stripped), following the ListObjectsV2 pagination token. */
  private async *iterateS3Files(prefix = ''): AsyncGenerator<string> {
    if (!this.s3Client) return;

    let continuationToken: string | undefined;

    do {
      const response = await this.s3Client.send(
        new ListObjectsV2Command({
          Bucket: this.s3Bucket,
          Prefix: `${this.s3KeyRoot}${prefix}`,
          ContinuationToken: continuationToken,
        }),
        { abortSignal: AbortSignal.timeout(S3_LIST_TIMEOUT_MS) },
      );

      for (const obj of response.Contents ?? []) {
        const key = this.stripS3KeyRoot(obj.Key);
        if (key !== null) yield key;
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);
  }

  /** The store-relative key for a listed object, or null for one outside this deployment's key root. */
  private stripS3KeyRoot(key: string | undefined): string | null {
    return key?.startsWith(this.s3KeyRoot) ? key.slice(this.s3KeyRoot.length) : null;
  }

  private async getS3File(filePath: string): Promise<Buffer> {
    const { stream } = await this.openS3File(filePath, this.s3Client);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk as ArrayBuffer));
    }
    return Buffer.concat(chunks);
  }

  private async openS3File(filePath: string, client: S3Client | null): Promise<ExportFileSource> {
    if (!client) throw new Error('S3 client not initialized');
    // Only the stream client, whose pool serves the downloads, is bounded. Checked and taken before any await.
    let held = client === this.s3StreamClient;
    if (held && this.s3OpenDownloads >= S3_MAX_OPEN_DOWNLOADS) {
      throw new DownloadsBusyException();
    }
    if (held) this.s3OpenDownloads++;
    const release = (): void => {
      if (held) this.s3OpenDownloads--;
      held = false;
    };

    let response;
    try {
      response = await client.send(
        new GetObjectCommand({
          Bucket: this.s3Bucket,
          Key: `${this.s3KeyRoot}${filePath}`,
        }),
      );
    } catch (error: unknown) {
      release();
      // Read-through: media written while S3 was down lives only in the local fallback dir, so after
      // recovery a plain S3 read would split-brain (NoSuchKey even though the app served the file
      // fine during the outage). Fall through to the local copy; if there is none, surface the
      // original S3 error so "not found" semantics are unchanged. A local copy that exists but cannot
      // be opened surfaces its own error, so it is never mistaken for a missing file.
      if ((error as { name?: string }).name !== 'NoSuchKey') throw error;
      let local: ExportFileSource;
      try {
        local = await openLocalFile(this.localPath, filePath);
      } catch (localError: unknown) {
        throw isMissingObjectError(localError) ? error : localError;
      }
      this.logger.debug(`Served '${filePath}' from the local fallback dir (not yet in S3)`);
      return local;
    }

    if (!response.Body) {
      release();
      throw new Error('Empty response body');
    }
    const body = response.Body as Readable;
    // Released on the SDK body, which holds the socket: it goes back once the body is read to the end, fails, or
    // is destroyed (a client that went away, or the idle bound). Released on the guard instead, a reader that
    // stopped with the last chunks in the guard's buffer would hold the place after the socket went back.
    finished(body, release);
    return { stream: withIdleBound(body, S3_SOCKET_TIMEOUT_MS, S3_READER_IDLE_MS), size: response.ContentLength };
  }

  private async putS3File(filePath: string, data: Buffer): Promise<void> {
    if (!this.s3Client) throw new Error('S3 client not initialized');

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.s3Bucket,
        Key: `${this.s3KeyRoot}${filePath}`,
        Body: data,
      }),
    );
  }

  private async deleteS3File(filePath: string): Promise<void> {
    if (!this.s3Client) throw new Error('S3 client not initialized');

    await this.s3Client.send(
      new DeleteObjectCommand({
        Bucket: this.s3Bucket,
        Key: `${this.s3KeyRoot}${filePath}`,
      }),
      { abortSignal: AbortSignal.timeout(S3_DELETE_TIMEOUT_MS) },
    );
  }
}
