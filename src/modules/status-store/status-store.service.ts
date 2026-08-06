import { Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { In, IsNull, LessThan, MoreThan, Not, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { StatusUpdate } from './entities/status-update.entity';
import type { IncomingStatus } from './incoming-status';
import type { Status } from '../../engine/interfaces/whatsapp-engine.interface';
import { StorageService } from '../../common/storage/storage.service';
import { isUniqueConstraintError } from '../../common/utils/unique-constraint.util';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { userPart } from '../../engine/identity/wa-id';
import { createLogger } from '../../common/services/logger.service';

/** A status/story lives for 24h from posting, matching WhatsApp's own expiry. Exported for the
 * session service's seed, which skips backfilling statuses that have already run out their TTL. */
export const STATUS_TTL_MS = 24 * 60 * 60 * 1000;
/** How often the TTL purge sweeps expired rows. */
const PURGE_INTERVAL_MS = 15 * 60 * 1000;
/** Default per-file cap on persisted status media. Exported for the session service's seed, which
 * pre-gates history downloads at the same cap so over-cap blobs are never fetched. */
export const DEFAULT_MEDIA_MAX_BYTES = 10 * 1024 * 1024;
/** Default cadence of the orphaned-media reconciliation sweep (overridable via
 * STATUS_ORPHAN_SWEEP_INTERVAL_MS). Lighter-than-it-sounds: one streamed enumeration + one indexed query. */
const DEFAULT_ORPHAN_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** Default grace window before an unreferenced status media file is deleted (overridable via
 * STATUS_ORPHAN_GRACE_MS), so a file mid-ingest is never reaped. */
const DEFAULT_ORPHAN_GRACE_MS = 60 * 60 * 1000;

/** Storage key prefix owned by the status store; the media bucket is shared with chat media. */
const STATUS_MEDIA_PREFIX = 'statuses/';

/** Subtypes whose registered mimetype name differs from the conventional file extension. */
const MIME_SUBTYPE_EXT_OVERRIDES: Record<string, string> = { jpeg: 'jpg', quicktime: 'mov' };

/** File extension to store a status media blob under, derived from its mimetype; 'bin' when unrecognized. */
function extFromMimetype(mimetype: string): string {
  const subtype = mimetype.split('/')[1]?.split(';')[0]?.trim().toLowerCase();
  if (!subtype || !/^[a-z0-9]+$/.test(subtype)) return 'bin';
  return MIME_SUBTYPE_EXT_OVERRIDES[subtype] ?? subtype;
}

/**
 * Persists inbound status/story broadcasts (`StatusUpdate` rows) with a 24h TTL, storing any attached
 * media through `StorageService`. Runs two recurring sweeps: the TTL purge (once at startup, then
 * every 15 minutes) so the store never accumulates stories past their WhatsApp-side expiry, and an
 * hourly reconciliation sweep that reaps media files no row references (crash leftovers).
 */
@Injectable()
export class StatusStoreService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('StatusStoreService');
  private purgeTimer?: ReturnType<typeof setInterval>;
  private orphanSweepTimer?: ReturnType<typeof setInterval>;
  /** First sweep sighting (epoch ms) of each unreferenced status media file, for the grace window. */
  private readonly orphanFirstSeenAt = new Map<string, number>();

  constructor(
    @InjectRepository(StatusUpdate, 'data')
    private readonly repository: Repository<StatusUpdate>,
    private readonly storageService: StorageService,
    private readonly configService: ConfigService,
    // Optional, mirroring WebhookService: resolution is a best-effort display concern — without the
    // store, contacts just show under whichever JID the status arrived with.
    @Optional() private readonly lidMappingStore?: LidMappingStoreService,
  ) {}

  onModuleInit(): void {
    const runPurge = (): void => {
      this.purgeExpired(Date.now()).catch(err =>
        this.logger.error('Status purge failed', err instanceof Error ? err.stack : String(err)),
      );
    };
    runPurge(); // sweep once at startup
    this.purgeTimer = setInterval(runPurge, PURGE_INTERVAL_MS);
    this.purgeTimer.unref?.();

    const runOrphanSweep = (): void => {
      this.sweepOrphanedMedia(Date.now()).catch(err =>
        this.logger.error('Status media orphan sweep failed', err instanceof Error ? err.stack : String(err)),
      );
    };
    runOrphanSweep(); // the first pass only records first-seen; nothing is deleted before the grace window
    const sweepIntervalMs = this.configService.get<number>(
      'status.orphanSweepIntervalMs',
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
   * Insert a status row (idempotent on `(sessionId, waStatusId)`), persisting any attached media.
   * `created` tells the caller whether this call actually inserted the row — false for a duplicate
   * delivery or a lost insert race — so a once-per-status side effect (the status.received webhook)
   * doesn't fire again for a status consumers already saw.
   *
   * Row-first ordering: the row is saved BEFORE its media file is written. A crash mid-ingest then
   * leaves a consistent media-omitted row behind (the worst case is a missing attachment), never a
   * permanent orphan file; the narrow window between the file write and the row update is the only
   * remaining orphan source, and the reconciliation sweep reaps those.
   */
  async ingest(sessionId: string, s: IncomingStatus): Promise<{ row: StatusUpdate; created: boolean }> {
    const existing = await this.repository.findOne({ where: { sessionId, waStatusId: s.waStatusId } });
    if (existing) return { row: existing, created: false };

    const row = new StatusUpdate();
    row.sessionId = sessionId;
    row.contactJid = s.contactJid;
    row.contactName = s.contactName;
    row.contactPushName = s.contactPushName;
    row.waStatusId = s.waStatusId;
    row.type = s.type;
    row.caption = s.caption;
    row.backgroundColor = s.backgroundColor;
    row.font = s.font;
    row.postedAt = s.postedAt;
    row.expiresAt = s.postedAt + STATUS_TTL_MS;
    // Settles every media outcome that does NOT need a file write; a keepable blob stays
    // omitted-for-now until attachMedia lands the file and flips it (post-save).
    const keepMedia = this.applyMediaDecision(row, s);

    let saved: StatusUpdate;
    try {
      saved = await this.repository.save(row);
    } catch (error) {
      // The unique (sessionId, waStatusId) index is the idempotency backstop for a concurrent ingest
      // of the same status racing past the findOne check above; on a unique-constraint violation the
      // loser re-reads and returns the row the winner just inserted instead of surfacing the
      // constraint error to the caller. Any OTHER save error is a genuine persistence failure and
      // must propagate — never be masked by a coincidentally matching row. No media file has been
      // written at this point (row-first ordering), so unlike a file-first ingest there is nothing
      // to reap here — the winner's own call owns its file write.
      const winner = await this.repository.findOne({ where: { sessionId, waStatusId: s.waStatusId } });
      if (winner && isUniqueConstraintError(error)) return { row: winner, created: false };
      throw error;
    }

    if (keepMedia) {
      await this.attachMedia(saved, sessionId, s);
    }
    return { row: saved, created: true };
  }

  /**
   * Settle the row's mediaOmitted/omitReason fields for every outcome that does not require a file
   * write (no media, engine-omitted, over the store cap). Returns true when the blob should be
   * written post-save; the row is then saved as omitted-for-now (no omitReason) and attachMedia
   * upgrades it once the file exists.
   */
  private applyMediaDecision(row: StatusUpdate, s: IncomingStatus): boolean {
    const media = s.media;
    if (!media) {
      row.mediaOmitted = false;
      return false;
    }

    const maxBytes = this.configService.get<number>('status.mediaMaxBytes', DEFAULT_MEDIA_MAX_BYTES);
    const sizeBytes = media.sizeBytes ?? (media.data ? Buffer.byteLength(media.data, 'base64') : undefined);
    const withinCap = sizeBytes !== undefined && sizeBytes <= maxBytes;

    if (!media.omitted && media.data && withinCap) {
      row.mediaOmitted = true; // pending the post-save write; attachMedia flips it back off
      return true;
    }

    row.mediaOmitted = true;
    // A blob the engine skipped precisely because the caller tightened the cap below it (the status
    // seed's pre-gate) is over the STORE's cap — keep the reason truthful on both arrival paths.
    row.omitReason =
      sizeBytes !== undefined && sizeBytes > maxBytes ? 'over_cap' : media.omitted ? 'engine_omitted' : 'over_cap';
    return false;
  }

  /**
   * Write the media file for a row already saved in the omitted-for-now state, then point the row at
   * it. A failed write is recorded as omitReason 'write_failed' rather than thrown — a storage
   * hiccup must not lose the status itself. A failure of the follow-up row update leaves the file
   * unreferenced; that is the reconciliation sweep's job, so it is logged and swallowed here.
   */
  private async attachMedia(row: StatusUpdate, sessionId: string, s: IncomingStatus): Promise<void> {
    const media = s.media;
    if (!media?.data) return;

    const key = `${STATUS_MEDIA_PREFIX}${sessionId}/${randomUUID()}.${extFromMimetype(media.mimetype)}`;
    try {
      await this.storageService.putFile(key, Buffer.from(media.data, 'base64'));
    } catch (error) {
      this.logger.error(
        `Failed to persist status media for session ${sessionId}, status ${s.waStatusId}`,
        error instanceof Error ? error.stack : String(error),
      );
      row.omitReason = 'write_failed';
      await this.repository.save(row).catch(err =>
        this.logger.warn(`Failed to record the write_failed omission for status ${s.waStatusId}`, {
          error: String(err),
        }),
      );
      return;
    }

    row.mediaPath = key;
    row.mediaMimetype = media.mimetype;
    row.mediaOmitted = false;
    try {
      await this.repository.save(row);
    } catch (error) {
      // The file exists but the row cannot reference it — an orphan the reconciliation sweep reaps
      // after its grace window. The persisted row stays consistent (still omitted from the first
      // save), so don't fail the ingest; restore the matching in-memory state too.
      this.logger.warn(`Status media ${key} written but the row update failed; leaving it for the orphan sweep`, {
        error: String(error),
      });
      row.mediaPath = undefined;
      row.mediaMimetype = undefined;
      row.mediaOmitted = true;
      // This same object is what the status.received webhook carries, and every other omission path
      // names its reason ('engine_omitted' / 'over_cap' / 'write_failed'). Leaving it unset here
      // would hand a consumer a media-less status it cannot tell apart from an unexplained
      // omission — the media really is gone (nothing retries), so say so.
      row.omitReason = 'write_failed';
    }
  }

  // Reads exclude already-expired rows: WhatsApp hides a status the moment its 24h are up, but the
  // purge sweep only reaps rows every 15 minutes — without the filter an expired status would stay
  // visible in the gap.
  async list(sessionId: string): Promise<Status[]> {
    const rows = await this.repository.find({
      where: { sessionId, expiresAt: MoreThan(Date.now()) },
      order: { postedAt: 'DESC' },
    });
    return rows.map(row => this.toStatus(row));
  }

  async listByContact(sessionId: string, contactJid: string): Promise<Status[]> {
    // The same person may hold rows under both a @lid and their @c.us (the mapping was learned
    // mid-window) — match every candidate so a resolved-form query doesn't silently miss lid rows.
    const candidates = new Set<string>([contactJid]);
    if (this.lidMappingStore) {
      const phone = userPart(contactJid);
      candidates.add(`${phone}@c.us`);
      // Forward-resolve a @lid query to its phone too, or rows ingested after the mapping was
      // learned (stored under @c.us) are missed by a consumer querying the raw lid.
      const resolved = this.lidMappingStore.getCached(phone);
      if (resolved) candidates.add(`${resolved}@c.us`);
      for (const lid of this.lidMappingStore.lidsForPhone(phone)) candidates.add(`${lid}@lid`);
    }
    const rows = await this.repository.find({
      where: { sessionId, contactJid: In([...candidates]), expiresAt: MoreThan(Date.now()) },
      order: { postedAt: 'DESC' },
    });
    return rows.map(row => this.toStatus(row));
  }

  /**
   * Canonical display form of a contact JID: resolve a @lid to its phone via the shared mapping.
   * Read-time (not ingest-time) on purpose: a mapping learned after the status arrived still merges
   * the contact's rows into one group. Only @lid inputs go through the map — its keys are raw digit
   * strings, so resolving a phone-shaped JID could collide with an unrelated lid. Unknown or
   * known-unresolved lids stay as-is.
   */
  private canonicalContactJid(jid: string): string {
    if (!jid.endsWith('@lid')) return jid;
    const phone = this.lidMappingStore?.getCached(userPart(jid));
    return phone ? `${phone}@c.us` : jid;
  }

  private toStatus(row: StatusUpdate): Status {
    return {
      id: row.waStatusId,
      contact: { id: this.canonicalContactJid(row.contactJid), name: row.contactName, pushName: row.contactPushName },
      type: row.type,
      caption: row.caption,
      mediaUrl:
        row.mediaPath && !row.mediaOmitted
          ? `/api/sessions/${row.sessionId}/status/${row.waStatusId}/media`
          : undefined,
      backgroundColor: row.backgroundColor,
      font: row.font,
      timestamp: new Date(row.postedAt),
      expiresAt: new Date(row.expiresAt),
    };
  }

  async getMedia(sessionId: string, statusId: string): Promise<{ path: string; mimetype: string } | null> {
    const row = await this.repository.findOne({
      where: { sessionId, waStatusId: statusId, expiresAt: MoreThan(Date.now()) },
    });
    if (!row || row.mediaOmitted || !row.mediaPath || !row.mediaMimetype) return null;
    return { path: row.mediaPath, mimetype: row.mediaMimetype };
  }

  /**
   * Deletes rows (and their media files) whose `expiresAt` is before `now`. Returns the count removed.
   * A row whose media delete FAILS is kept — deleting it would orphan the file permanently (a row-less
   * file is only rediscovered by the orphan sweep after its grace window), so the row stays and the
   * next sweep retries the delete. A missing file is a successful delete (see StorageService), so an
   * already-gone file never wedges its row.
   */
  async purgeExpired(now: number): Promise<number> {
    const expired = await this.repository.find({ where: { expiresAt: LessThan(now) } });
    if (expired.length === 0) return 0;

    const deletableIds: string[] = [];
    await Promise.all(
      expired.map(async row => {
        if (!row.mediaPath) {
          deletableIds.push(row.id);
          return;
        }
        try {
          await this.storageService.deleteFile(row.mediaPath);
          deletableIds.push(row.id);
        } catch (err) {
          this.logger.warn(
            `Failed to delete expired status media ${row.mediaPath}; keeping the row for the next sweep`,
            {
              error: String(err),
            },
          );
        }
      }),
    );

    // Every media delete may have failed — delete([]) throws TypeORM's empty-criteria error.
    if (deletableIds.length === 0) return 0;
    const result = await this.repository.delete(deletableIds);
    return result.affected ?? deletableIds.length;
  }

  /**
   * Reconcile the media store with the status rows: delete `statuses/` files no row references.
   * Orphans arise from the narrow crash window between the media write and its row update (row-first
   * ingest keeps every other path consistent). Scoped to the statuses/ prefix — the media store is
   * shared with chat media, which this sweep must never touch.
   *
   * A file is deleted only after the sweep has seen it unreferenced for at least the grace window:
   * first-seen is tracked in memory (a restart simply restarts the grace clock, which fails safe),
   * so a file mid-ingest or freshly written is never reaped. Returns the count removed.
   */
  async sweepOrphanedMedia(now: number = Date.now()): Promise<number> {
    const graceMs = this.configService.get<number>('status.orphanGraceMs', DEFAULT_ORPHAN_GRACE_MS);
    // Stream via iterateFiles: listFiles() truncates at STORAGE_LIST_MAX_FILES (a per-call DoS
    // guard, not a completeness contract), which would strand every orphan past the cap. Scope the
    // walk to the statuses/ prefix so dropping that cap does not pull the whole media store — chat
    // media shares this bucket — through the iterator and its dedupe set.
    const files: string[] = [];
    for await (const file of this.storageService.iterateFiles(STATUS_MEDIA_PREFIX)) {
      if (file.startsWith(STATUS_MEDIA_PREFIX)) files.push(file);
    }
    const rows = await this.repository.find({
      where: { mediaPath: Not(IsNull()) },
      select: { mediaPath: true },
    });
    const referenced = new Set(rows.map(row => row.mediaPath));

    let removed = 0;
    const present = new Set(files);
    for (const file of files) {
      if (referenced.has(file)) {
        this.orphanFirstSeenAt.delete(file);
        continue;
      }
      const firstSeenAt = this.orphanFirstSeenAt.get(file) ?? now;
      this.orphanFirstSeenAt.set(file, firstSeenAt);
      if (now - firstSeenAt < graceMs) continue;
      try {
        await this.storageService.deleteFile(file);
        this.orphanFirstSeenAt.delete(file);
        removed += 1;
      } catch (err) {
        this.logger.warn(`Failed to delete orphaned status media ${file}`, { error: String(err) });
      }
    }
    // Drop bookkeeping for files that are gone so the map can't grow unbounded.
    for (const key of [...this.orphanFirstSeenAt.keys()]) {
      if (!present.has(key)) this.orphanFirstSeenAt.delete(key);
    }
    if (removed > 0) this.logger.log(`Status media orphan sweep removed ${removed} file(s)`);
    return removed;
  }
}
