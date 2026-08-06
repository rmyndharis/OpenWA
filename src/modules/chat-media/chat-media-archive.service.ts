import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { In, IsNull, LessThan, Not, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { Message } from '../message/entities/message.entity';
import { StorageService } from '../../common/storage/storage.service';
import { createLogger } from '../../common/services/logger.service';

/** Storage key prefix owned by the chat-media archive; the media bucket is shared with statuses. */
export const CHAT_MEDIA_PREFIX = 'chat-media/';

/** Default per-file cap on archived chat media. */
export const DEFAULT_ARCHIVE_MAX_BYTES = 25 * 1024 * 1024;
/** Default cadence of the orphaned-file reconciliation sweep. */
const DEFAULT_ORPHAN_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** Default grace window before an unreferenced archive file is deleted. */
const DEFAULT_ORPHAN_GRACE_MS = 60 * 60 * 1000;
/** How often the retention purge sweeps archived files past their TTL. */
const PURGE_INTERVAL_MS = 15 * 60 * 1000;
/** Rows cleared per purge statement. Keeps the id list far below the drivers' bind-parameter
 *  ceilings (SQLite 32766, Postgres 65535) and bounds how much work one failure can undo. */
const PURGE_BATCH_SIZE = 500;
/** Cap on batches per run, so one tick cannot monopolise the process draining a huge backlog;
 *  whatever is left is picked up by the next scheduled run. */
const PURGE_MAX_BATCHES_PER_RUN = 200;
/** Archive keys reconciled per orphan-sweep query — bounds peak memory independently of store size. */
const SWEEP_CHUNK_SIZE = 500;

/** Subtypes whose registered mimetype name differs from the conventional file extension. */
const MIME_SUBTYPE_EXT_OVERRIDES: Record<string, string> = { jpeg: 'jpg', quicktime: 'mov' };

/** File extension to store a blob under, derived from its mimetype; 'bin' when unrecognized. */
function extFromMimetype(mimetype: string): string {
  const subtype = mimetype.split('/')[1]?.split(';')[0]?.trim().toLowerCase();
  if (!subtype || !/^[a-z0-9]+$/.test(subtype)) return 'bin';
  return MIME_SUBTYPE_EXT_OVERRIDES[subtype] ?? subtype;
}

/** The inline media shape carried on a persisted row's `metadata.media`. */
interface InlineMedia {
  mimetype?: string;
  data?: string;
  omitted?: boolean;
  sizeBytes?: number;
}

/**
 * Archives chat-message media to the file store so it stays retrievable after delivery, independent
 * of the inline base64 copy the message row already carries.
 *
 * Opt-in (`CHAT_MEDIA_ARCHIVE_ENABLED`, default off) because it doubles storage for media under the
 * cap: the inline copy is deliberately left in place, since the dashboard renders from it and
 * stripping it would break the response contract.
 *
 * Two recurring sweeps run only while archiving is enabled: a retention purge (when
 * `CHAT_MEDIA_ARCHIVE_TTL_DAYS` is non-zero) that clears files past their TTL along with the
 * columns pointing at them, and an hourly reconciliation sweep that reaps files no row references —
 * the crash leftovers of the narrow window between a file write and its row update.
 */
@Injectable()
export class ChatMediaArchiveService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('ChatMediaArchiveService');
  private purgeTimer?: ReturnType<typeof setInterval>;
  private orphanSweepTimer?: ReturnType<typeof setInterval>;
  /** First sweep sighting (epoch ms) of each unreferenced archive file, for the grace window. */
  private readonly orphanFirstSeenAt = new Map<string, number>();

  constructor(
    @InjectRepository(Message, 'data')
    private readonly repository: Repository<Message>,
    private readonly storageService: StorageService,
    private readonly configService: ConfigService,
  ) {}

  get enabled(): boolean {
    return this.configService.get<boolean>('chatMedia.archiveEnabled', false);
  }

  onModuleInit(): void {
    // Both sweeps exist only to maintain archived files. With archiving off no row can hold a
    // mediaPath, so scheduling them would be a recurring no-op walk of the store.
    if (!this.enabled) return;

    const runPurge = (): void => {
      this.purgeExpired(Date.now()).catch(err =>
        this.logger.error('Chat media purge failed', err instanceof Error ? err.stack : String(err)),
      );
    };
    runPurge(); // sweep once at startup
    this.purgeTimer = setInterval(runPurge, PURGE_INTERVAL_MS);
    this.purgeTimer.unref?.();

    const runOrphanSweep = (): void => {
      this.sweepOrphanedMedia(Date.now()).catch(err =>
        this.logger.error('Chat media orphan sweep failed', err instanceof Error ? err.stack : String(err)),
      );
    };
    runOrphanSweep(); // the first pass only records first-seen; nothing is deleted before the grace window
    const sweepIntervalMs = this.configService.get<number>(
      'chatMedia.orphanSweepIntervalMs',
      DEFAULT_ORPHAN_SWEEP_INTERVAL_MS,
    );
    this.orphanSweepTimer = setInterval(runOrphanSweep, sweepIntervalMs);
    this.orphanSweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.purgeTimer) clearInterval(this.purgeTimer);
    if (this.orphanSweepTimer) clearInterval(this.orphanSweepTimer);
  }

  /**
   * Archive the media of an already-persisted message row, then point the row at the stored file.
   *
   * Row-first by construction — the caller persists before calling this — so a crash mid-archive
   * leaves a consistent row whose media is simply not archived, never a row pointing at a file that
   * does not exist. The reverse window (file written, row update failed) leaves an unreferenced
   * file, which is the reconciliation sweep's job.
   *
   * Never throws: archiving is a side benefit of receiving a message, and a storage hiccup must not
   * surface on the receive path. Returns the storage key when a file was written.
   */
  async archive(row: Pick<Message, 'id' | 'sessionId' | 'metadata'>): Promise<string | null> {
    if (!this.enabled) return null;

    const media = (row.metadata as { media?: InlineMedia } | null | undefined)?.media;
    if (!media?.data || media.omitted || !media.mimetype) return null;

    const maxBytes = this.configService.get<number>('chatMedia.maxBytes', DEFAULT_ARCHIVE_MAX_BYTES);
    const sizeBytes = media.sizeBytes ?? Buffer.byteLength(media.data, 'base64');
    if (sizeBytes > maxBytes) return null;

    // A random key rather than the WhatsApp message id: message ids are engine-controlled strings
    // that can carry '/' (base64 id segments), which would silently nest the object and leak the
    // id into S3 keys. The row is read on the way out anyway, so nothing is gained by a derivable
    // key. Mirrors the status store.
    const key = `${CHAT_MEDIA_PREFIX}${row.sessionId}/${randomUUID()}.${extFromMimetype(media.mimetype)}`;
    try {
      await this.storageService.putFile(key, Buffer.from(media.data, 'base64'));
    } catch (error) {
      this.logger.error(
        `Failed to archive chat media for session ${row.sessionId}, message ${row.id}`,
        error instanceof Error ? error.stack : String(error),
      );
      return null;
    }

    try {
      await this.repository.update({ id: row.id }, { mediaPath: key, mediaMimetype: media.mimetype });
    } catch (error) {
      // The file exists but no row references it — an orphan the sweep reaps after its grace
      // window. The row itself stays consistent (mediaPath still null), so nothing else to undo.
      this.logger.warn(`Chat media ${key} written but the row update failed; leaving it for the orphan sweep`, {
        error: String(error),
      });
      return null;
    }
    return key;
  }

  /**
   * Resolve the archived media of one message, addressed the way the REST layer addresses messages
   * (session + chat + WhatsApp message id). Returns null when nothing is archived for it.
   */
  async getMedia(
    sessionId: string,
    chatId: string,
    waMessageId: string,
  ): Promise<{ path: string; mimetype: string } | null> {
    const row = await this.repository.findOne({ where: { sessionId, chatId, waMessageId } });
    if (!row?.mediaPath || !row.mediaMimetype) return null;
    return { path: row.mediaPath, mimetype: row.mediaMimetype };
  }

  /**
   * Delete archived files older than the configured retention, clearing the columns that point at
   * them. The message ROW survives — retention here governs the archived blob, not the message
   * history, which has its own lifecycle.
   *
   * A row whose file delete fails keeps its columns so the next sweep retries; clearing them would
   * strand the file until the orphan sweep's grace window. A missing file counts as deleted (see
   * StorageService), so an already-gone file never wedges its row. Returns the count cleared.
   */
  async purgeExpired(now: number): Promise<number> {
    const ttlDays = this.configService.get<number>('chatMedia.ttlDays', 0);
    if (ttlDays <= 0) return 0; // 0 = keep forever

    const cutoff = new Date(now - ttlDays * 24 * 60 * 60 * 1000);
    let cleared = 0;

    // Batched, not one pass. The archive's default TTL is 0 (keep forever), so the first run after
    // an operator sets a retention can face an arbitrarily large backlog — unlike the status store,
    // whose 24h TTL bounds every batch by construction. Unbatched that backlog broke three ways at
    // once: tens of thousands of concurrent deletes, and a single `UPDATE ... WHERE id IN (...)`
    // past the driver's bind-parameter ceiling (SQLite 32766, Postgres 65535) that throws AFTER the
    // files are already gone — leaving rows pointing at deleted files, and every later tick
    // repeating the same failure. Draining in bounded batches keeps each statement small and makes
    // partial progress durable.
    for (let batch = 0; batch < PURGE_MAX_BATCHES_PER_RUN; batch++) {
      const expired = await this.repository.find({
        where: { mediaPath: Not(IsNull()), createdAt: LessThan(cutoff) },
        select: { id: true, mediaPath: true },
        take: PURGE_BATCH_SIZE,
      });
      if (expired.length === 0) break;

      const clearableIds: string[] = [];
      for (const row of expired) {
        try {
          await this.storageService.deleteFile(row.mediaPath!);
          clearableIds.push(row.id);
        } catch (err) {
          this.logger.warn(`Failed to delete expired chat media ${row.mediaPath}; keeping the row for the next sweep`, {
            error: String(err),
          });
        }
      }

      // Every delete in the batch failed: the same rows would be re-selected forever, so stop
      // rather than spin. The next scheduled run retries them.
      if (clearableIds.length === 0) break;

      await this.repository.update(clearableIds, {
        mediaPath: null as unknown as undefined,
        mediaMimetype: null as unknown as undefined,
      });
      cleared += clearableIds.length;

      // A short batch means the backlog is drained; anything else costs an extra empty query.
      if (expired.length < PURGE_BATCH_SIZE) break;
    }

    if (cleared > 0) this.logger.log(`Chat media retention purge cleared ${cleared} file(s)`);
    return cleared;
  }

  /**
   * Reconcile the media store with the message rows: delete `chat-media/` files no row references.
   * Scoped to that prefix — the store is shared with status media, which this sweep must never
   * touch, and the status sweep must never touch these.
   *
   * A file is deleted only after the sweep has seen it unreferenced for at least the grace window;
   * first-seen is tracked in memory, so a restart simply restarts the grace clock (fails safe) and
   * a file mid-write is never reaped. Returns the count removed.
   */
  async sweepOrphanedMedia(now: number = Date.now()): Promise<number> {
    const graceMs = this.configService.get<number>('chatMedia.orphanGraceMs', DEFAULT_ORPHAN_GRACE_MS);
    let removed = 0;
    // Keys still unreferenced at the end of THIS pass. Bounded by the orphan count (normally ~0),
    // not by the size of the store, so it can safely drive the bookkeeping prune below.
    const stillOrphaned = new Set<string>();

    // Reconciled in chunks rather than as two whole-store sets. iterateFiles streams (listFiles
    // truncates at STORAGE_LIST_MAX_FILES, which would strand every orphan past the cap), but
    // collecting every key AND every archived row into memory would undo that: with the default
    // TTL of 0 the archive grows without bound, so a mature gateway would spend an hourly spike
    // holding millions of key strings. Each chunk asks the DB only which of ITS keys are
    // referenced — an indexed lookup over a bounded id list.
    let chunk: string[] = [];
    const flush = async (): Promise<void> => {
      if (chunk.length === 0) return;
      const rows = await this.repository.find({ where: { mediaPath: In(chunk) }, select: { mediaPath: true } });
      const referenced = new Set(rows.map(row => row.mediaPath));
      for (const file of chunk) {
        if (referenced.has(file)) {
          this.orphanFirstSeenAt.delete(file);
          continue;
        }
        stillOrphaned.add(file);
        const firstSeenAt = this.orphanFirstSeenAt.get(file) ?? now;
        this.orphanFirstSeenAt.set(file, firstSeenAt);
        if (now - firstSeenAt < graceMs) continue;
        try {
          await this.storageService.deleteFile(file);
          this.orphanFirstSeenAt.delete(file);
          stillOrphaned.delete(file);
          removed += 1;
        } catch (err) {
          this.logger.warn(`Failed to delete orphaned chat media ${file}`, { error: String(err) });
        }
      }
      chunk = [];
    };

    for await (const file of this.storageService.iterateFiles(CHAT_MEDIA_PREFIX)) {
      if (!file.startsWith(CHAT_MEDIA_PREFIX)) continue;
      chunk.push(file);
      if (chunk.length >= SWEEP_CHUNK_SIZE) await flush();
    }
    await flush();
    // Drop bookkeeping for anything not still orphaned this pass — the file is gone, or a row now
    // references it. Keyed off the orphan set rather than a full listing so this stays bounded too.
    for (const key of [...this.orphanFirstSeenAt.keys()]) {
      if (!stillOrphaned.has(key)) this.orphanFirstSeenAt.delete(key);
    }
    if (removed > 0) this.logger.log(`Chat media orphan sweep removed ${removed} file(s)`);
    return removed;
  }
}
