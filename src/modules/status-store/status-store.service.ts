import { Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { In, LessThan, MoreThan, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { StatusUpdate } from './entities/status-update.entity';
import type { IncomingStatus } from './incoming-status';
import type { Status } from '../../engine/interfaces/whatsapp-engine.interface';
import { StorageService } from '../../common/storage/storage.service';
import { sweepOrphanedFiles } from '../../common/storage/orphan-sweep';
import { startGuardedInterval } from '../../common/utils/guarded-interval';
import { extFromMimetype } from '../../common/media/mime-ext';
import { isUniqueViolation } from '../../common/utils/db-errors';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { resolveJidCandidates } from '../../engine/identity/jid-candidates';
import { createLogger } from '../../common/services/logger.service';
import { captureSessionWrites, SessionWriteScope } from '../../common/utils/session-write-scope';

/** A status/story lives for 24h from posting, matching WhatsApp's own expiry. Exported for the
 * session service's seed, which skips backfilling statuses that have already run out their TTL. */
export const STATUS_TTL_MS = 24 * 60 * 60 * 1000;
/** How often the TTL purge sweeps expired rows. */
const PURGE_INTERVAL_MS = 15 * 60 * 1000;
/** Rows removed per purge statement. Keeps the id list far below the drivers' bind-parameter
 *  ceilings (SQLite 32766, Postgres 65535) and bounds how much work one failure can undo. */
const PURGE_BATCH_SIZE = 500;
/** Cap on batches per run, so one tick cannot monopolise the process draining a huge backlog;
 *  whatever is left is picked up by the next scheduled run. */
const PURGE_MAX_BATCHES_PER_RUN = 200;
/** Files the orphan sweep reconciles per reference lookup: bounds the keys it holds and each query's key list. */
const SWEEP_CHUNK_SIZE = 500;
/** Default per-file cap on persisted status media. Exported for the session service's seed, which
 * pre-gates history downloads at the same cap so over-cap blobs are never fetched. */
export const DEFAULT_MEDIA_MAX_BYTES = 10 * 1024 * 1024;
/** Default cadence of the orphaned-media reconciliation sweep (overridable via
 * STATUS_ORPHAN_SWEEP_INTERVAL_MS). Lighter-than-it-sounds: one streamed enumeration + one indexed query per chunk. */
const DEFAULT_ORPHAN_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** Default grace window before an unreferenced status media file is deleted (overridable via
 * STATUS_ORPHAN_GRACE_MS), so a file mid-ingest is never reaped. */
const DEFAULT_ORPHAN_GRACE_MS = 60 * 60 * 1000;

/** Storage key prefix owned by the status store; the media bucket is shared with chat media. */
const STATUS_MEDIA_PREFIX = 'statuses/';

/**
 * Persists inbound status/story broadcasts (`StatusUpdate` rows) with a 24h TTL, storing any attached
 * media through `StorageService`. Runs two recurring sweeps: the TTL purge (once at startup, then
 * every 15 minutes) so the store never accumulates stories past their WhatsApp-side expiry, and an
 * hourly reconciliation sweep that reaps media files no row references (crash leftovers).
 */
@Injectable()
export class StatusStoreService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('StatusStoreService');
  /** Stops the TTL purge and the orphan sweep; set while the service is running. */
  private stopMaintenance: Array<() => void> = [];
  /** First sweep sighting (epoch ms) of each unreferenced status media file, for the grace window. */
  private readonly orphanFirstSeenAt = new Map<string, number>();
  /** Last row id the TTL purge walked past; the next run resumes after it. */
  private purgeCursor?: string;
  /** Ingests whose row is not saved yet, by `${sessionId}:${waStatusId}`: the delete of the same story waits for them. */
  private readonly unsaved = new Map<string, Promise<void>>();
  /** Deletes of a story in progress, by the same key: an ingest that starts meanwhile sets `joined` on each of them. */
  private readonly removals = new Map<string, Set<{ joined: boolean }>>();

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
    const failed = (what: string) => (err: unknown) =>
      this.logger.error(`${what} failed`, err instanceof Error ? err.stack : String(err));
    const sweepIntervalMs = this.configService.get<number>(
      'status.orphanSweepIntervalMs',
      DEFAULT_ORPHAN_SWEEP_INTERVAL_MS,
    );
    this.stopMaintenance = [
      // Once at startup, then on a timer; a pass that outlasts its interval is not stacked on.
      startGuardedInterval(() => this.purgeExpired(Date.now()), PURGE_INTERVAL_MS, failed('Status purge')),
      // The first pass only records first-seen; nothing is deleted before the grace window.
      startGuardedInterval(
        () => this.sweepOrphanedMedia(Date.now()),
        sweepIntervalMs,
        failed('Status media orphan sweep'),
      ),
    ];
  }

  onModuleDestroy(): void {
    for (const stop of this.stopMaintenance) stop();
    this.stopMaintenance = [];
  }

  /**
   * Insert a status row (idempotent on `(sessionId, waStatusId)`), persisting any attached media.
   * `created` tells the caller whether this call actually inserted the row: false for a duplicate
   * delivery, a lost insert race, or a row removed while its media was written, so a once-per-status
   * side effect (the status.received webhook) doesn't fire again for a status consumers already saw.
   *
   * Row-first ordering: the row is saved BEFORE its media file is written. A crash mid-ingest then
   * leaves a consistent media-omitted row behind (the worst case is a missing attachment), never a
   * permanent orphan file; the narrow window between the file write and the row update is the only
   * remaining orphan source, and the reconciliation sweep reaps those.
   */
  async ingest(
    sessionId: string,
    s: IncomingStatus,
    lifetime?: SessionWriteScope,
  ): Promise<{ row: StatusUpdate; created: boolean }> {
    const scope = lifetime ?? this.captureWrites(sessionId);
    const rowSaved = this.holdUnsaved(sessionId, s.waStatusId);
    try {
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
        // Without a transaction: a single-row save() wraps itself in one, and on SQLite's single shared
        // connection the rollback of the unique violation expected below also discards the rows other callers
        // wrote while it was open, after they were reported stored.
        saved = await scope.write(() => this.repository.save(row, { transaction: false }));
      } catch (error) {
        // The unique (sessionId, waStatusId) index is the idempotency backstop for a concurrent ingest
        // of the same status racing past the findOne check above; on a unique-constraint violation the
        // loser re-reads and returns the row the winner just inserted instead of surfacing the
        // constraint error to the caller. Any OTHER save error is a genuine persistence failure and
        // must propagate — never be masked by a coincidentally matching row. No media file has been
        // written at this point (row-first ordering), so unlike a file-first ingest there is nothing
        // to reap here — the winner's own call owns its file write.
        const winner = await this.repository.findOne({ where: { sessionId, waStatusId: s.waStatusId } });
        if (winner && isUniqueViolation(error)) return { row: winner, created: false };
        throw error;
      }

      // The row is there for a delete of the story to find; its media is still to be written.
      rowSaved();
      // A row removed while its media was being written (a purge, a session delete) was never stored.
      if (keepMedia && !(await this.attachMedia(saved, sessionId, s))) return { row: saved, created: false };
      return { row: saved, created: true };
    } finally {
      rowSaved();
      if (!lifetime) scope.close();
    }
  }

  /** Mark a story's row as not saved yet until the returned function is called (calling it again does nothing). */
  private holdUnsaved(sessionId: string, waStatusId: string): () => void {
    const key = `${sessionId}:${waStatusId}`;
    for (const removal of this.removals.get(key) ?? []) removal.joined = true;
    let release!: () => void;
    const mine = new Promise<void>(resolve => (release = resolve));
    // The same story may be ingested twice at once (the connect-time seed beside the live message): both are waited for.
    const held = Promise.all([this.unsaved.get(key), mine]).then(() => undefined);
    this.unsaved.set(key, held);
    void held.then(() => {
      if (this.unsaved.get(key) === held) this.unsaved.delete(key);
    });
    return release;
  }

  captureWrites(sessionId: string): SessionWriteScope {
    return captureSessionWrites(this.repository.manager?.connection ?? this.repository, sessionId);
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
   * unreferenced; that is the reconciliation sweep's job, so it is logged and swallowed here. Returns
   * false when the row no longer exists: the file is removed and nothing was published.
   */
  private async attachMedia(row: StatusUpdate, sessionId: string, s: IncomingStatus): Promise<boolean> {
    const media = s.media;
    if (!media?.data) return true;

    const key = `${STATUS_MEDIA_PREFIX}${sessionId}/${randomUUID()}.${extFromMimetype(media.mimetype)}`;
    try {
      await this.storageService.putFile(key, Buffer.from(media.data, 'base64'));
    } catch (error) {
      this.logger.error(
        `Failed to persist status media for session ${sessionId}, status ${s.waStatusId}`,
        error instanceof Error ? error.stack : String(error),
      );
      row.omitReason = 'write_failed';
      const omitted = await this.repository
        .update({ id: row.id, sessionId }, { omitReason: row.omitReason })
        .catch(err => {
          this.logger.warn(`Failed to record the write_failed omission for status ${s.waStatusId}`, {
            error: String(err),
          });
          return undefined;
        });
      // A row removed while its media was being written (a delete of the story, a purge) was never stored.
      return omitted?.affected !== 0;
    }

    row.mediaPath = key;
    row.mediaMimetype = media.mimetype;
    row.mediaOmitted = false;
    try {
      const result = await this.repository.update(
        { id: row.id, sessionId },
        {
          mediaPath: row.mediaPath,
          mediaMimetype: row.mediaMimetype,
          mediaOmitted: false,
        },
      );
      if (result.affected === 0) {
        row.mediaPath = undefined;
        row.mediaMimetype = undefined;
        row.mediaOmitted = true;
        await this.storageService.deleteFile(key).catch(() => undefined); // else the orphan sweep reaps it
        return false;
      }
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
    return true;
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

  /** Every id a contact's rows may be stored under, the contact's own first. */
  private async contactCandidates(contactJid: string): Promise<string[]> {
    // The same person may hold rows under both a @lid and their @c.us (the mapping was learned
    // mid-window) — match every candidate so a resolved-form query doesn't silently miss lid rows.
    // The expansion is the one the message filters and the chat fence use: a lid's digits are never read
    // as a phone, and an id that names no individual (a group, or one with a second @) matches only itself.
    const candidates = new Set<string>([contactJid]);
    const lids = this.lidMappingStore;
    if (lids) {
      const forms = await resolveJidCandidates(contactJid, {
        resolveLid: lid => lids.findPhoneForLid(lid),
        lidsForPhone: phone => lids.findLidsForPhone(phone),
      });
      for (const form of forms) candidates.add(form);
    }
    return [...candidates];
  }

  async listByContact(sessionId: string, contactJid: string): Promise<Status[]> {
    const rows = await this.repository.find({
      where: { sessionId, contactJid: In(await this.contactCandidates(contactJid)), expiresAt: MoreThan(Date.now()) },
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
    const phone = this.lidMappingStore?.resolveLid(jid);
    return phone ? `${phone}@c.us` : jid;
  }

  // The nullable columns read back as null, while Status declares these fields optional: `?? undefined`
  // keeps them off the wire, as the contract (StatusDto, openapi) says.
  private toStatus(row: StatusUpdate): Status {
    return {
      id: row.waStatusId,
      contact: {
        id: this.canonicalContactJid(row.contactJid),
        name: row.contactName ?? undefined,
        pushName: row.contactPushName ?? undefined,
      },
      type: row.type,
      caption: row.caption ?? undefined,
      mediaUrl:
        row.mediaPath && !row.mediaOmitted
          ? `/api/sessions/${row.sessionId}/status/${row.waStatusId}/media`
          : undefined,
      backgroundColor: row.backgroundColor ?? undefined,
      font: row.font ?? undefined,
      timestamp: new Date(row.postedAt),
      expiresAt: new Date(row.expiresAt),
    };
  }

  async getMedia(sessionId: string, statusId: string): Promise<{ path: string; mimetype: string } | null> {
    const row = await this.repository.findOne({
      where: { sessionId, waStatusId: statusId, expiresAt: MoreThan(Date.now()) },
    });
    // Same condition toStatus() advertises a mediaUrl on. Media stored without a type (an engine that
    // reported none) is still served, as octet-stream.
    if (!row || row.mediaOmitted || !row.mediaPath) return null;
    return { path: row.mediaPath, mimetype: row.mediaMimetype || 'application/octet-stream' };
  }

  /**
   * Remove a story its poster deleted, and its media file. The row goes first, so every read stops at once; a file that
   * cannot be deleted is left to the orphan sweep. An ingest of the story that has not saved its row yet is waited for,
   * or the story would be saved after its delete.
   *
   * `by` is given when the engine does not vouch for who sent the delete: Baileys passes a delete on unchecked once the
   * story's copy has left its own message store. Then only a story of `by.poster` goes, under either of its ids (see
   * contactCandidates), and none when the sender is unknown. Without it the engine did vouch: whatsapp-web.js reports
   * a delete only after WhatsApp Web accepted it. Resolves to whether a story was removed.
   */
  async removeRevoked(sessionId: string, waStatusId: string, by?: { poster?: string }): Promise<boolean> {
    // An undefined value is dropped from a where clause, which would then match every row of the session.
    if (!waStatusId || (by && !by.poster)) return false;
    // A second ingest of the story can start while the delete waits or reads (the connect-time seed beside the live
    // message), and its lookup may run after the delete's: it would then save the story the delete just removed. So the
    // delete waits for every ingest pending when it looks, and looks again when one started during its last pass.
    const key = `${sessionId}:${waStatusId}`;
    const watch = { joined: false };
    const watching = this.removals.get(key) ?? new Set<{ joined: boolean }>();
    watching.add(watch);
    this.removals.set(key, watching);
    try {
      // Only an ingest of this story starting during a pass sets `joined`, so the loop ends with the last such ingest:
      // stopping earlier would let that one save the story after this delete had answered.
      let removed = false;
      do {
        for (let pending = this.unsaved.get(key); pending; pending = this.unsaved.get(key)) await pending;
        watch.joined = false;
        removed = (await this.removeStored(sessionId, waStatusId, by)) || removed;
      } while (watch.joined);
      return removed;
    } finally {
      watching.delete(watch);
      if (watching.size === 0) this.removals.delete(key);
    }
  }

  /** One pass of {@link removeRevoked}: the row, then its media file. Resolves to whether a row was removed. */
  private async removeStored(sessionId: string, waStatusId: string, by?: { poster?: string }): Promise<boolean> {
    const contactJid = by?.poster ? In(await this.contactCandidates(by.poster)) : undefined;
    const row = await this.repository.findOne({
      where: { sessionId, waStatusId, ...(contactJid ? { contactJid } : {}) },
      select: { id: true, mediaPath: true },
    });
    if (!row) return false;
    await this.repository.delete({ id: row.id, sessionId });
    if (row.mediaPath) {
      try {
        await this.storageService.deleteFile(row.mediaPath);
      } catch (err) {
        this.logger.warn('Failed to delete the media of a deleted status; leaving it for the orphan sweep', {
          mediaPath: row.mediaPath,
          error: String(err),
        });
      }
    }
    this.logger.debug('Removed a status its poster deleted', { sessionId, statusId: waStatusId });
    return true;
  }

  /**
   * Deletes rows (and their media files) whose `expiresAt` is before `now`. Returns the count removed.
   * A row whose media delete FAILS is kept — deleting it would orphan the file permanently (a row-less
   * file is only rediscovered by the orphan sweep after its grace window), so the row stays and the
   * next sweep retries the delete. A missing file is a successful delete (see StorageService), so an
   * already-gone file never wedges its row.
   *
   * Drained in bounded batches. The 24h TTL does not bound a backlog: a restart after downtime, or
   * media deletes that keep failing, leave any number of expired rows, and a single
   * `DELETE ... WHERE id IN (...)` past the driver's bind-parameter ceiling throws after the files are
   * gone, then fails the same way on every later run. The batches walk the expired rows by id, resuming
   * across runs, so rows whose delete keeps failing are stepped over instead of blocking newer ones. A
   * batch in which every delete fails ends the run: that means the store is down, and walking on would
   * only repeat the failure.
   */
  async purgeExpired(now: number): Promise<number> {
    let removed = 0;
    let after = this.purgeCursor;
    this.purgeCursor = undefined;
    for (let batch = 0; batch < PURGE_MAX_BATCHES_PER_RUN; batch++) {
      const expired = await this.repository.find({
        where: { expiresAt: LessThan(now), ...(after ? { id: MoreThan(after) } : {}) },
        select: { id: true, mediaPath: true },
        order: { id: 'ASC' },
        take: PURGE_BATCH_SIZE,
      });
      if (expired.length === 0) break;
      after = expired[expired.length - 1].id;

      const deletableIds: string[] = [];
      for (const row of expired) {
        try {
          if (row.mediaPath) await this.storageService.deleteFile(row.mediaPath);
          deletableIds.push(row.id);
        } catch (err) {
          this.logger.warn(
            `Failed to delete expired status media ${row.mediaPath}; keeping the row for the next sweep`,
            { error: String(err) },
          );
        }
      }

      // Rows whose delete failed are kept; they are retried once the walk wraps around.
      if (deletableIds.length === 0) {
        this.purgeCursor = after;
        break;
      }
      const result = await this.repository.delete(deletableIds);
      removed += result.affected ?? deletableIds.length;
      // A short batch means the backlog is drained and the next run starts over from the lowest id;
      // a run that hits the batch cap resumes where it stopped.
      if (expired.length < PURGE_BATCH_SIZE) break;
      if (batch === PURGE_MAX_BATCHES_PER_RUN - 1) this.purgeCursor = after;
    }
    return removed;
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
    // Reconciled in chunks, as the chat-media archive does: the rows are bounded by the 24h TTL, but the files under the
    // prefix are not (a session delete leaves every file of the session behind), and listing them all before asking
    // the database would hold every key at once. Each chunk asks only which of its own keys are referenced.
    const removed = await sweepOrphanedFiles({
      storage: this.storageService,
      prefix: STATUS_MEDIA_PREFIX,
      graceMs,
      now,
      firstSeenAt: this.orphanFirstSeenAt,
      chunkSize: SWEEP_CHUNK_SIZE,
      referencedAmong: async keys => {
        const rows = await this.repository.find({ where: { mediaPath: In(keys) }, select: { mediaPath: true } });
        return new Set(rows.map(row => row.mediaPath));
      },
      onDeleteFailed: (file, err) =>
        this.logger.warn(`Failed to delete orphaned status media ${file}`, { error: String(err) }),
    });
    if (removed > 0) this.logger.log(`Status media orphan sweep removed ${removed} file(s)`);
    return removed;
  }
}
