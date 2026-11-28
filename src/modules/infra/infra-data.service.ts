import {
  BadRequestException,
  ConflictException,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { setImmediate } from 'timers/promises';
import { DataSource, QueryRunner } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { createLogger } from '../../common/services/logger.service';
import { ShutdownService } from '../../common/services/shutdown.service';
import { isMissingTableError } from '../../common/utils/db-errors';
import { closeSessionWrites } from '../../common/utils/session-write-scope';
import {
  awaitNoOpenTransaction,
  holdSharedConnection,
  SHARED_CONNECTION_DIALECTS,
  type SharedConnectionHold,
} from '../../common/utils/shared-connection';
import { failUnfinishedSessionBatches } from '../message/batch-media.util';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { SessionService } from '../session/session.service';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { ChatStateStoreService } from '../../engine/adapters/baileys-chat-state-store.service';
import { BaileysMessageStoreService } from '../../engine/adapters/baileys-message-store.service';
import { SessionOwnershipService } from '../session/session-ownership.service';
import { ScopeBindingService } from '../integration/scope-binding.service';
import { AutomationRulesService } from '../automation/automation-rules.service';
import { PluginLoaderService } from '../../core/plugins/plugin-loader.service';
import type { PluginConfigSchema } from '../../core/plugins/plugin.interfaces';
import { ReKeyChatStatesBySessionId1786500000000 } from '../../database/migrations/1786500000000-ReKeyChatStatesBySessionId';
import { ScrubRevokedMessageContent1786900000000 } from '../../database/migrations/1786900000000-ScrubRevokedMessageContent';
import { ScrubNonPhoneLidMappings1786950000000 } from '../../database/migrations/1786950000000-ScrubNonPhoneLidMappings';
import { BackfillLegacyMessageTypes1791300000000 } from '../../database/migrations/1791300000000-BackfillLegacyMessageTypes';
import { Session as SessionEntity, SessionStatus } from '../session/entities/session.entity';
import { In } from 'typeorm';
import type { BetterSqlite3DataSourceOptions } from 'typeorm/driver/better-sqlite3/BetterSqlite3DataSourceOptions';
import { checkpointOffThread } from '../../database/sqlite-checkpoint';
import { DateUtils } from 'typeorm/util/DateUtils';
import type { MigrationTables, PluginInstanceRow, TableCounts } from './migration-tables.types';
import { EXPORT_TABLES, EXPORT_TABLE_EXCLUSIONS, type AnyExportTable, type ExportReadContext } from './export-tables';
import { TABLE_IMPORTERS, deduplicateArchivedWebhookFailures, isRedactedPluginSecret } from './table-importers';
import { openExportSnapshot, sweepExportSnapshotCopies, type ExportSnapshot } from './export-snapshot';

/**
 * The ownership quartet SessionOwnershipService maintains: which process holds a session's engine and
 * until when. Cluster RUNTIME state — it belongs to the machines currently running, never to a backup.
 */
export interface SessionOwnershipRow {
  id: string;
  nodeId: string | null;
  claimedAt: unknown;
  leaseExpiresAt: unknown;
  nodeUrl: string | null;
}

/**
 * Read the live claims through the caller's queryRunner, so the read sits inside the import's own
 * transaction. The columns are PROBED rather than SELECTed-and-caught: on PostgreSQL any failed
 * statement aborts the surrounding transaction (25P02), so catching a missing-column error would
 * still poison every statement after it — including the DELETE this read precedes. Absent columns
 * mean a database whose ownership migration was rolled back; there is simply nothing to carry.
 */
async function readSessionOwnership(queryRunner: QueryRunner): Promise<SessionOwnershipRow[] | null> {
  if (!(await queryRunner.hasColumn('sessions', 'nodeId'))) return null;
  return (await queryRunner.query(
    'SELECT id, "nodeId", "claimedAt", "leaseExpiresAt", "nodeUrl" FROM sessions WHERE "nodeId" IS NOT NULL',
  )) as SessionOwnershipRow[];
}

/**
 * Carry a lease across the transaction by its REMAINING time rather than its absolute stamp.
 *
 * The stamp is a deadline, and the transaction that re-applies it can run for longer than the
 * deadline has left. Writing it back unchanged therefore commits an expiry this request already knows
 * has passed, while `nodeId` still names the owner whose engine never stopped — a lapse manufactured
 * by the restore, on a claim it observed live moments earlier.
 *
 * A claim that was ALREADY lapsed when read is re-bound untouched: shifting that one would resurrect
 * a dead node's hold, which is the property the verbatim write was protecting. So is anything
 * unparseable — a value this function does not understand is not one it should rewrite.
 *
 * The stored shape is preserved (ISO text on SQLite, Date on Postgres) because these values go back
 * through raw SQL, bypassing the column transformer that would otherwise normalise them.
 *
 * Note the deliberate asymmetry with `claimedAt`, which stays verbatim because it is a historical
 * fact. After a carry the pair therefore no longer spans a single TTL — `leaseExpiresAt - claimedAt`
 * is the TTL plus the restore's duration — so it must not be used to derive a lease age.
 */
function carryLease(raw: unknown, readAt: Date, now: Date): unknown {
  // Only the two shapes these columns are actually stored in are interpreted, and for text only the
  // UTC form the two writers emit (`DateTransformer.to` and `leaseParam`, both `toISOString()`).
  // Anything else is left alone: rewriting a shape this function does not understand would be worse
  // than not carrying it, because a local-time parse would bake the host's UTC offset into the
  // column permanently — where the old verbatim write merely passed the odd value through.
  if (!(raw instanceof Date) && typeof raw !== 'string') return raw;
  if (typeof raw === 'string' && !raw.endsWith('Z')) return raw;
  const deadline = raw instanceof Date ? raw : new Date(raw);
  const remainingMs = deadline.getTime() - readAt.getTime();
  if (Number.isNaN(remainingMs) || remainingMs <= 0) return raw;
  // Never earlier than what was read: a backward clock step between the two stamps must not be able
  // to commit an expiry sooner than the row already carried, which would re-create the very problem.
  const carried = new Date(Math.max(now.getTime() + remainingMs, deadline.getTime()));
  // A deadline that is representable but whose carry is not: fall back rather than throw, since the
  // caller routes a throw into `warnings` and every later row in the loop would lose its claim.
  if (!Number.isFinite(carried.getTime())) return raw;
  return raw instanceof Date ? carried : carried.toISOString();
}

/**
 * Re-apply the claims for ids present in both the pre-import database and the restored set.
 * `nodeId`/`claimedAt`/`nodeUrl` are re-bound exactly as they were read rather than reconstructed;
 * only the lease deadline is carried forward (see {@link carryLease}). They go through the caller's
 * `insert` so the `$N`→`?` rewrite applies on SQLite. An id the backup did not restore simply
 * matches no row.
 *
 * Errors are NOT swallowed. On PostgreSQL a failed statement aborts the transaction, and the COMMIT
 * that followed would silently execute as a ROLLBACK — reporting a fully-discarded import as a
 * success with per-table counts. The caller routes a failure into `warnings`, which is the existing
 * all-or-nothing gate.
 */
export async function restoreSessionOwnership(
  preserved: SessionOwnershipRow[] | null,
  insert: (text: string, params: unknown[]) => Promise<unknown>,
  readAt: Date,
  now: Date = new Date(),
): Promise<void> {
  if (!preserved?.length) return;
  for (const row of preserved) {
    await insert(
      'UPDATE sessions SET "nodeId" = $1, "claimedAt" = $2, "leaseExpiresAt" = $3, "nodeUrl" = $4 WHERE id = $5',
      [row.nodeId, row.claimedAt, carryLease(row.leaseExpiresAt, readAt, now), row.nodeUrl, row.id],
    );
  }
}

/**
 * The `datetime` columns of each imported table on a SQLite data connection, keyed by backup table key
 * and read from the entity metadata: CreateDateColumn/UpdateDateColumn and any other column TypeORM
 * binds through its SQLite datetime path. DateTransformer columns are `text` there and are not listed,
 * because the app itself writes those in ISO form.
 */
export function sqliteDatetimeColumns(dataSource: DataSource): Map<keyof MigrationTables, string[]> {
  const byTable = new Map(
    dataSource.entityMetadatas.map(metadata => [
      metadata.tableName,
      metadata.columns
        .filter(column => dataSource.driver.normalizeType(column) === 'datetime')
        .map(column => column.databaseName),
    ]),
  );
  return new Map(EXPORT_TABLES.map(entry => [entry.key, byTable.get(entry.table) ?? []]));
}

/**
 * Rewrite one archived `datetime` value into the text TypeORM writes on SQLite (`YYYY-MM-DD HH:MM:SS.SSS`,
 * UTC). A PostgreSQL export serializes these columns as ISO `...T...Z`, and SQLite compares them as
 * text: `'T'` sorts after `' '`, so a restored row never matches `LessThan(date)` on its own calendar
 * day. Only ISO text with an explicit zone is converted. A value already in SQLite form carries no
 * zone, and parsing it would read it as host-local time and shift it, so it is left as it is.
 */
export function toSqliteDatetime(value: unknown): unknown {
  if (typeof value !== 'string' || !/T.*(Z|[+-]\d{2}:?\d{2})$/i.test(value)) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : DateUtils.mixedDateToUtcDatetimeString(date);
}

/**
 * Aggregate budget for the inline base64 media ONE export may carry, counted in the encoded bytes
 * that actually land in the JSON body. Override with EXPORT_INLINE_MEDIA_BUDGET_BYTES; 0 omits every
 * payload, and anything that is not a non-negative decimal integer falls back to the default.
 *
 * The export is bounded by nothing while the import rides the global request body limit (25mb by
 * default, `resolveBodyLimit`), so unbounded inline media produces a backup this gateway then refuses
 * with a 413 — inbound media is capped at MEDIA_DOWNLOAD_MAX_BYTES (50 MiB by default) and base64
 * inflates that to 4/3.
 *
 * A blanket strip would trade the 413 for silent data loss, which is why this is a budget and not a
 * flag: with the chat-media archive off — the default — `metadata.media.data` is the ONLY copy of an
 * inbound photo, and a 180 KB one costs nothing against a 25 MiB ceiling. Mirrors
 * CHAT_HISTORY_MEDIA_BUDGET_BYTES, which bounds the same failure on the chat-history response.
 */
const DEFAULT_EXPORT_INLINE_MEDIA_BUDGET_BYTES = 8 * 1024 * 1024;

function exportInlineMediaBudgetBytes(): number {
  const parsed = Number.parseInt(process.env.EXPORT_INLINE_MEDIA_BUDGET_BYTES ?? '', 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_EXPORT_INLINE_MEDIA_BUDGET_BYTES;
}

/**
 * A chunk of full-row reads from an inline-media table holds at most max(budget, 1 MiB) of stored
 * payload (and always at least one row), as the message list does. The row cap keeps a chunk of
 * small rows well inside every driver's bound-parameter limit.
 */
const EXPORT_READ_CHUNK_MIN_BYTES = 1024 * 1024;
const EXPORT_READ_CHUNK_MAX_ROWS = 200;

/** Rows of a table read at a time. A table read whole grew with it: two million rows took a 1 GiB heap. */
const EXPORT_READ_BATCH_ROWS = 500;
/** Keys of an inline-media table (id and payload size) read at a time. */
const EXPORT_KEY_BATCH_ROWS = 1000;

/**
 * Keys held at once while the budget is spent, about 13 MB. A table with more rows that carry a
 * payload has its keys read again for every further window, instead of a list of all of them.
 */
const EXPORT_KEY_WINDOW = 100_000;

/**
 * Characters of the export document handed on at a time. One JSON.stringify of the whole result
 * held the rows and their text together, and failed outright past V8's string limit of about half a
 * gigabyte, which a million text messages reach.
 */
const EXPORT_WRITE_CHUNK_CHARS = 64 * 1024;

/** What a key read returns for a row of an inline-media table, beside its recency column. */
interface InlineMediaKey {
  id: unknown;
  payloadBytes: number | string | null;
}

/** A key with what orders it for the budget: its recency, and where the database returned it. */
interface OrderedKey extends InlineMediaKey {
  recency: number;
  position: number;
}

/**
 * The order the media budget is spent in: newest first, keeping the most recent media when it cannot
 * hold everything. A table carries no order of its own: rows arrive in rowid order on SQLite, oldest
 * first, the exact inverse of what a backup wants, and in physical-tuple order on Postgres. Rows of
 * one recency keep the order they were returned in.
 */
const newestFirst = (a: OrderedKey, b: OrderedKey): number => b.recency - a.recency || a.position - b.position;

/**
 * The keys `scanKeys` returns whose payload is not empty, newest first, at most `window` at a time.
 * Each window is found by reading the keys again and keeping the newest that come after the last one
 * handed on, so what is held never grows with the table. The scan must return the same keys in the
 * same order every time, which a fixed snapshot does. A key with no usable recency sorts last, as
 * the least worth spending the budget on.
 */
export async function* newestFirstWindows(
  scanKeys: () => Promise<AsyncIterable<unknown[]>>,
  recencyOf: (key: unknown) => number,
  window: number,
): AsyncGenerator<OrderedKey[], void, undefined> {
  let last: OrderedKey | undefined;
  for (;;) {
    let newest: OrderedKey[] = [];
    let more = false;
    let position = 0;
    for await (const keys of await scanKeys()) {
      for (const key of keys as InlineMediaKey[]) {
        // A row whose payload column is empty has nothing to spend the budget on.
        if (!(Number(key.payloadBytes) > 0)) continue;
        const recency = recencyOf(key);
        const ordered = { ...key, recency: Number.isFinite(recency) ? recency : 0, position: position++ };
        if (!last || newestFirst(last, ordered) < 0) newest.push(ordered);
      }
      if (newest.length >= 2 * window) {
        newest = newest.sort(newestFirst).slice(0, window);
        more = true;
      }
    }
    newest.sort(newestFirst);
    if (newest.length > window) {
      newest.length = window;
      more = true;
    }
    if (newest.length > 0) yield newest;
    if (!more) return;
    last = newest[newest.length - 1];
  }
}

/** Split keys, in their order, into the chunks their full rows are read in. */
function* chunkKeys(keys: readonly InlineMediaKey[], chunkLimit: number): Generator<unknown[]> {
  let chunk: unknown[] = [];
  let chunkBytes = 0;
  for (const key of keys) {
    const bytes = Number(key.payloadBytes) || 0;
    if (chunk.length > 0 && (chunk.length === EXPORT_READ_CHUNK_MAX_ROWS || chunkBytes + bytes > chunkLimit)) {
      yield chunk;
      chunk = [];
      chunkBytes = 0;
    }
    chunk.push(key.id);
    chunkBytes += bytes;
  }
  if (chunk.length > 0) yield chunk;
}

/** The shared budget: `spend` takes a payload's bytes out of what is left, and says whether they fitted. */
interface InlineMediaBudget {
  /** The configured budget, which also sizes the export's chunked reads. */
  bytes: number;
  spend: (encodedBytes: number) => boolean;
}

function createInlineMediaBudget(): InlineMediaBudget {
  const bytes = exportInlineMediaBudgetBytes();
  let spent = 0;
  return {
    bytes,
    spend: (encodedBytes: number): boolean => {
      if (spent + encodedBytes > bytes) return false;
      spent += encodedBytes;
      return true;
    },
  };
}

/** What spending the budget on an inline-media table leaves for writing it out. */
interface InlineMediaPlan {
  /** The rows the budget left a payload on, already stripped, with the payloads each of them lost. */
  kept: Map<unknown, { row: unknown; dropped: number }>;
}

/** Opens the first statement on a table: undefined when the table is optional and does not exist. */
type OpenTable = (
  entry: AnyExportTable,
  sql: string,
  rows: number,
) => Promise<AsyncGenerator<unknown[], void, undefined> | undefined>;

/** What an export learns while its tables are written, reported after them. */
interface ExportSummary {
  /** Rows written per table so far. */
  counts: TableCounts;
  skippedTables: string[];
  omittedInlineMedia: Record<'messages' | 'messageBatches', number>;
  /** Whether any of the document has been handed on. */
  started: boolean;
}

/** The document GET /infra/export-data sends; InfraExportDataResponseDto is the published contract. */
export interface InfraExportDataResult {
  exportedAt: string;
  dataDbType: string;
  tables: MigrationTables;
  counts: TableCounts;
  /** Optional tables that were skipped because they genuinely do not exist in this DB (older schema). */
  skippedTables: string[];
  /**
   * Inline media payloads the export budget refused, so a truncated backup can be told apart from
   * a complete one. Zeroes mean everything fitted. Restoring an archive with a non-zero count is
   * still valid — the rows come back, their media does not.
   */
  omittedInlineMedia: { messages: number; messageBatches: number };
}

function parsePluginInstanceConfig(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

/**
 * Rows a SQLite restore on its own connection deletes or inserts between two turns of the event loop: a few
 * milliseconds of work each, about 55 ms with the message search triggers in place.
 */
const RESTORE_CHUNK_ROWS = 500;

/**
 * Turns of the event loop a SQLite restore gives between two chunks. libuv accepts one new connection per turn, so
 * with one turn a health probe would queue behind every connection opened before it, for as long as the restore runs.
 */
const RESTORE_TURNS_PER_CHUNK = 32;

const EMPTY_ARCHIVE_WARNING = 'Backup contained no rows to restore; refused to replace existing data. Check the file.';

/** Result of POST /infra/import-data; InfraImportDataResponseDto is the published contract. */
export interface InfraImportDataResult {
  imported: boolean;
  counts: TableCounts;
  warnings: string[];
  /**
   * Non-fatal operator-facing messages (e.g. orphan-engine reconciliation details). Distinct from
   * warnings: notices never cause a rollback, while warnings make the replace-rollback gate fire.
   */
  notices: string[];
  /**
   * True when an engine may still be writing into the restored tables, from any of three causes:
   * orphans deliberately left running (`force`), a `stopOrphans` teardown that failed, or sessions
   * held by another node, which this request has no channel to stop. Restart to reconcile those.
   * Also true when the post-commit plugin binding re-sync failed; a restart does not repair that
   * one, so its notice names the manual check instead.
   */
  restartRequired: boolean;
  /** Session ids with a running engine that the restored data no longer contains. */
  orphanedEngines: string[];
  /** Orphan engines stopped inside this request (only populated when stopOrphans=true was passed). */
  stoppedOrphanEngines: string[];
  /** Orphan engines whose teardown threw or timed out (Map reconciled regardless; investigate). */
  failedOrphanEngines: string[];
}

/**
 * The data-DB backup machinery behind InfraDataController: the full export (registry-driven, see
 * export-tables.ts) and the replace-all import with its single-flight gate, orphan-engine
 * reconciliation and all-or-nothing rollback. The controller owns only routing, guards and the
 * published response metadata.
 */
@Injectable()
export class InfraDataService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = createLogger('InfraDataService');

  /**
   * Whether a replace-all import is already running in this process. Not a nicety: on better-sqlite3
   * every query runner is a driver SINGLETON, so two overlapping imports share one transaction — the
   * second nests as SAVEPOINT, its commit issues RELEASE SAVEPOINT rather than COMMIT, and a rollback
   * at depth 1 issues a full ROLLBACK that discards a restore the other call already answered
   * `imported: true` for. Serialising them is the only honest answer; queueing the second would still
   * run a destructive replace nobody is waiting on.
   */
  private importInFlight = false;

  /**
   * Whether an export is running in this process. An import refuses while one runs: it would replace
   * the tables an archive is still being read from on PostgreSQL, and on SQLite the two would wait on
   * each other. A second export refuses too, because each one holds a snapshot until its download
   * ends: on PostgreSQL a pooled connection and a transaction that holds back vacuum, on SQLite the
   * write-ahead log or a whole copy of the database.
   */
  private exportInFlight = false;

  /** The snapshot the running export reads, closed at a stop before the WAL checkpoint, which it would hold back. */
  private openSnapshot?: ExportSnapshot;
  /** The running export's snapshot while it opens: a copy of the database is written then, for as long as that takes. */
  private openingSnapshot?: Promise<unknown>;
  /** Aborted at a stop: it ends a copy being written and refuses an export started after it. */
  private readonly stopping = new AbortController();
  /** Set while a restore holds the shared connection, resolved once it has let the callers it held go on. */
  private restoring?: Promise<void>;

  constructor(
    private readonly configService: ConfigService,
    @InjectDataSource('data')
    private readonly dataDataSource: DataSource,
    // Best-effort audit emission for the sensitive infra operations below. Injected @Optional and
    // grouped with the trailing @Optional args so it never shifts the required positional args: the
    // running app always provides the @Global AuditService, while the direct-construction unit tests
    // omit it — the `?.` at each call site then makes emission a no-op there instead of forcing
    // every test to wire a mock.
    @Optional()
    private readonly auditService?: AuditService,
    // Post-import runtime reconciliation (see importData). Same trailing-@Optional convention as
    // auditService: provided by the app (InfraModule imports SessionModule; EngineModule is @Global),
    // omitted by direct-construction unit tests, and every use is `?.`-guarded.
    @Optional()
    private readonly sessionService?: SessionService,
    @Optional()
    private readonly lidMappingStore?: LidMappingStoreService,
    // Same trailing-@Optional convention as the services above: provided by the app, omitted by the
    // direct-construction unit tests, and every use is `?.`-guarded.
    @Optional()
    private readonly ownership?: SessionOwnershipService,
    @Optional()
    private readonly chatStateStore?: ChatStateStoreService,
    // Resolves ScopeBindingService lazily (strict: false) for the post-import plugin binding resync.
    // A lookup rather than a module import: importing IntegrationModule here would move it deeper in
    // the module graph and reorder its lifecycle hooks relative to the rest of the app.
    @Optional()
    private readonly moduleRef?: ModuleRef,
    // Stops a restore between chunks once teardown has begun.
    @Optional()
    private readonly shutdown?: ShutdownService,
    // Same convention: what an unlinked account left while its kept clear waits is hidden from a backup as from reads.
    @Optional()
    private readonly baileysMessageStore?: BaileysMessageStoreService,
  ) {}

  /** An export that died with its process may have left a copy of the database beside it. */
  async onApplicationBootstrap(): Promise<void> {
    await sweepExportSnapshotCopies(this.dataDataSource, this.logger);
  }

  /**
   * Nest runs this before any beforeApplicationShutdown, so the shutdown checkpoint finds no reader
   * left. The download fails at its next read and is reset, as any failure after the first byte is.
   * A restore on a connection of its own stops at its next chunk and rolls back.
   */
  async onModuleDestroy(): Promise<void> {
    this.stopping.abort(
      new ServiceUnavailableException({
        statusCode: 503,
        error: 'Service Unavailable',
        message: 'The gateway stopped before the export sent its first byte; export again once it is back.',
        code: 'EXPORT_STOPPED',
      }),
    );
    // A restore on a connection of its own ends before the shared connection closes under the callers it holds.
    await this.restoring;
    const closed = this.closeStoppedSnapshot();
    // Only a SQLite reader holds the shutdown checkpoint back. On PostgreSQL the open can wait for a pool
    // connection and the rollback for a read in flight; DataSource.destroy() waits for the connection.
    if (this.dataDataSource.options.type === 'postgres') {
      void closed.catch((error: unknown) =>
        this.logger.warn('Could not close the export snapshot at the stop', { error: String(error) }),
      );
      return;
    }
    await closed;
  }

  private async closeStoppedSnapshot(): Promise<void> {
    // A copy being written ends at its next step and is removed: a few milliseconds, not the copy.
    await this.openingSnapshot?.catch(() => undefined);
    const snapshot = this.openSnapshot;
    this.openSnapshot = undefined;
    await snapshot?.close(false);
  }

  /**
   * Fail loudly when EXPORT_TABLES and the data connection's entity metadata disagree, BEFORE a
   * single table is read. A registry table the metadata does not know means a renamed or dropped
   * entity: proceeding would export the OLD table (or report it empty/skipped) and a restore would
   * re-populate a table nothing reads. A metadata table in neither the registry nor the exclusions
   * means a new entity nobody made a backup decision for: proceeding would silently leave it out of
   * every backup this gateway produces. Both are registry drift, not data conditions — the operator
   * cannot fix them from a request.
   */
  private assertExportRegistryMatchesMetadata(): void {
    const metadataTables = new Set(this.dataDataSource.entityMetadatas.map(metadata => metadata.tableName));
    for (const entry of EXPORT_TABLES) {
      if (!metadataTables.has(entry.table)) {
        throw new Error(
          `export-data: table "${entry.table}" (backup key "${entry.key}") is registered for export, but the ` +
            `data connection's entity metadata does not know it — a renamed or dropped entity must be ` +
            `updated in export-tables.ts, never exported around`,
        );
      }
    }
    const registryTables = new Set(EXPORT_TABLES.map(entry => entry.table));
    for (const table of metadataTables) {
      if (registryTables.has(table) || table in EXPORT_TABLE_EXCLUSIONS) continue;
      throw new Error(
        `export-data: data entity table "${table}" has no backup decision — add it to EXPORT_TABLES (with its ` +
          `import descriptor and the published tables/counts DTO keys) or to EXPORT_TABLE_EXCLUSIONS with a ` +
          `reason, in export-tables.ts`,
      );
    }
  }

  /**
   * The export as the pieces of one JSON document, in order: the text of an InfraExportDataResult,
   * written without ever holding the document or a table whole. Every row is read from one fixed
   * state of the database. The first piece comes only after every refusal and the spending of the
   * inline media budget, so until then a failure is an ordinary rejection. The export counts as
   * running until the pieces are read to the end or the generator is returned; `signal` ends it
   * while it is reading, where a return would wait.
   */
  async *exportData(options?: {
    includePluginSecrets?: boolean;
    signal?: AbortSignal;
  }): AsyncGenerator<string, void, undefined> {
    this.assertExportRegistryMatchesMetadata();
    if (this.importInFlight) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'A data import is running; export after it finishes.',
        code: 'IMPORT_ALREADY_RUNNING',
      });
    }
    if (this.exportInFlight) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'A data export is already running; start another after its download has ended.',
        code: 'EXPORT_IN_PROGRESS',
      });
    }
    this.exportInFlight = true;
    try {
      yield* this.runExport(options?.includePluginSecrets === true, options?.signal);
    } finally {
      this.exportInFlight = false;
    }
  }

  private resolvePluginConfigSchema(pluginId: string): PluginConfigSchema | undefined {
    if (!this.moduleRef) return undefined;
    try {
      const loader = this.moduleRef.get<
        typeof PluginLoaderService,
        { getPlugin?: (id: string) => { manifest?: { configSchema?: PluginConfigSchema } } | undefined } | undefined
      >(PluginLoaderService, { strict: false });
      return loader?.getPlugin?.(pluginId)?.manifest?.configSchema;
    } catch {
      return undefined;
    }
  }

  /** The table reads behind exportData, entered only through its guards. */
  private async *runExport(
    includePluginSecrets: boolean,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<string, void, undefined> {
    const summary: ExportSummary = {
      counts: {} as TableCounts,
      skippedTables: [],
      omittedInlineMedia: { messages: 0, messageBatches: 0 },
      started: false,
    };
    let unsent: string;
    let complete = false;

    // Held as soon as it opens, so a stop waiting for the open finds it to close.
    const opening = openExportSnapshot(
      this.dataDataSource,
      signal ? AbortSignal.any([this.stopping.signal, signal]) : this.stopping.signal,
    ).then(opened => (this.openSnapshot = opened));
    this.openingSnapshot = opening;
    const snapshot = await opening;
    try {
      try {
        // A PostgreSQL open does not watch the stop: one that ends after it sends nothing.
        this.stopping.signal.throwIfAborted();
        unsent = yield* this.writeTables(snapshot, includePluginSecrets, summary, signal);
        complete = true;
      } catch (error) {
        // A stop closed the snapshot before the first byte, so the stop is what the request is told.
        throw this.stopping.signal.aborted && !summary.started ? this.stopping.signal.reason : error;
      } finally {
        // Unless a stop has closed it already.
        if (this.openSnapshot === snapshot) {
          this.openSnapshot = undefined;
          await snapshot.close(complete);
        }
      }
    } finally {
      // Record who pulled a full-DB export, the per-table row counts, and whether plugin instance
      // secrets were opted in. Data itself is never logged. Rows leave the gateway while later ones
      // are still unread, so an export that failed or was abandoned after its first piece is on
      // record too, marked incomplete, with the rows written up to then.
      if (complete || summary.started) {
        await this.auditService?.logInfo(AuditAction.INFRA_DATA_EXPORTED, {
          metadata: { counts: summary.counts, includePluginSecrets, ...(complete ? {} : { incomplete: true }) },
        });
      }
    }

    yield (
      `${unsent}},"counts":${JSON.stringify(summary.counts)},"skippedTables":${JSON.stringify(summary.skippedTables)}` +
      `,"omittedInlineMedia":${JSON.stringify(summary.omittedInlineMedia)}}`
    );
  }

  /**
   * Read every table from the snapshot, a batch at a time, and write the document up to the end of
   * its last table, in pieces of about EXPORT_WRITE_CHUNK_CHARS. Returns the text not yet handed on,
   * which the caller closes the document after. Nothing is handed on before the first table has
   * been read.
   */
  private async *writeTables(
    snapshot: ExportSnapshot,
    includePluginSecrets: boolean,
    summary: ExportSummary,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<string, string, undefined> {
    // The tables below may legitimately not exist yet (created by migrations an older DB has not run).
    // Only a GENUINE missing-table error (isMissingTableError) may be tolerated; anything else (lock,
    // I/O, timeout, aborted connection) must FAIL the export.
    const skip = (entry: AnyExportTable, error: unknown): undefined => {
      if (!entry.optional || !isMissingTableError(error)) throw error;
      summary.skippedTables.push(entry.table);
      this.logger.warn('Optional table does not exist in this DB; exporting without it', { table: entry.table });
      return undefined;
    };
    const open: OpenTable = async (entry, sql, rows) => {
      if (!snapshot.failedStatementAborts || !entry.optional) {
        return snapshot.scan(sql, rows).catch((error: unknown) => skip(entry, error));
      }
      await snapshot.query('SAVEPOINT infra_export_optional');
      try {
        const scan = await snapshot.scan(sql, rows);
        await snapshot.query('RELEASE SAVEPOINT infra_export_optional');
        return scan;
      } catch (error) {
        await snapshot.query('ROLLBACK TO SAVEPOINT infra_export_optional');
        return skip(entry, error);
      }
    };

    const exportContext: ExportReadContext = {
      includePluginSecrets,
      resolvePluginConfigSchema: pluginId => this.resolvePluginConfigSchema(pluginId),
    };

    // One budget shared by the tables that carry a full inline payload (messages and
    // message_batches today), so the total is what is bounded rather than each table separately.
    // It is spent here, before anything is written, because the document reports each table in turn
    // and the budget is spent across them newest-first.
    const inlineMediaBudget = createInlineMediaBudget();
    const plans = new Map<AnyExportTable, InlineMediaPlan | undefined>();
    for (const entry of EXPORT_TABLES) {
      if (!entry.inlineMedia) continue;
      plans.set(
        entry,
        await this.planInlineMediaTable(snapshot, entry, entry.inlineMedia, inlineMediaBudget, open, signal),
      );
    }

    let unsent =
      `{"exportedAt":${JSON.stringify(snapshot.at.toISOString())}` +
      `,"dataDbType":${JSON.stringify(this.configService.get<string>('dataDatabase.type', 'sqlite'))},"tables":{`;
    for (const [index, entry] of EXPORT_TABLES.entries()) {
      unsent += `${index === 0 ? '' : ','}${JSON.stringify(entry.key)}:[`;
      const plan = plans.get(entry);
      const batches = !entry.inlineMedia
        ? await open(
            entry,
            `SELECT ${entry.columns?.map(column => `"${column}"`).join(', ') ?? '*'} FROM ${entry.table}`,
            EXPORT_READ_BATCH_ROWS,
          )
        : plan &&
          this.readInlineMediaRows(
            snapshot,
            entry,
            entry.inlineMedia,
            plan,
            inlineMediaBudget.bytes,
            summary.omittedInlineMedia,
          );
      summary.counts[entry.key] = 0;
      for await (const rows of batches ?? []) {
        signal?.throwIfAborted();
        entry.afterRead?.(rows as never[], exportContext);
        const restorable = entry.sessionFk ? await this.rowsOfArchivedSessions(snapshot, rows) : rows;
        for (const row of this.withoutUnlinkedRows(entry, restorable)) {
          unsent += `${summary.counts[entry.key]++ === 0 ? '' : ','}${JSON.stringify(row)}`;
          if (unsent.length >= EXPORT_WRITE_CHUNK_CHARS) {
            summary.started = true;
            yield unsent;
            unsent = '';
          }
        }
      }
      unsent += ']';
    }
    return unsent;
  }

  /**
   * The rows an unlinked account left in the Baileys stores while its kept clear waits are hidden from every read, and
   * from a backup too: restored, they would hand that account's messages and chat flags to the next one.
   */
  private withoutUnlinkedRows<R>(entry: AnyExportTable, rows: R[]): R[] {
    const store =
      entry.table === 'baileys_stored_messages'
        ? this.baileysMessageStore
        : entry.table === 'chat_states'
          ? this.chatStateStore
          : undefined;
    return store ? rows.filter(row => !store.hidesRaw(row as Record<string, unknown>)) : rows;
  }

  /**
   * See ExportTable.sessionFk: a child row of a session missing from the archive cannot be restored.
   * Asked of the snapshot per batch, so no list of the sessions is held. Compared as text: a value
   * that is not an id must drop its row, not fail the statement.
   */
  private async rowsOfArchivedSessions(snapshot: ExportSnapshot, rows: unknown[]): Promise<unknown[]> {
    const ids = [...new Set((rows as Array<{ sessionId: string }>).map(row => row.sessionId))];
    if (ids.length === 0) return rows;
    const archived = await snapshot.query<Array<{ id: string }>>(
      `SELECT CAST(id AS TEXT) AS "id" FROM sessions WHERE CAST(id AS TEXT) IN (${ids.map((_, i) => snapshot.placeholder(i + 1)).join(', ')})`,
      ids,
    );
    const present = new Set(archived.map(session => session.id));
    return (rows as Array<{ sessionId: string }>).filter(row => present.has(row.sessionId));
  }

  /**
   * Spend the budget on a table whose rows carry inline media, without ever holding all of its
   * payloads at once, and keep only the rows it left a payload on. Undefined when the table is
   * optional and does not exist.
   *
   * A `SELECT *` put every payload on the heap before the budget could drop one, so a media-heavy
   * database could exhaust memory for a response that only ever carries the budget's worth. Instead
   * the rows that carry a payload are read as `id`, recency key and the payload's stored size, a
   * window of keys at a time, newest first; their full rows follow in chunks, and each chunk is
   * stripped against the budget before the next is read. A row that lost every payload is let go
   * again: writing the table reads it a second time, so what stays in memory is one window of keys,
   * one chunk and the budget.
   *
   * The budget sees the rows in exactly the order a sort of the whole table would give it.
   */
  private async planInlineMediaTable(
    snapshot: ExportSnapshot,
    entry: AnyExportTable,
    media: NonNullable<AnyExportTable['inlineMedia']>,
    budget: InlineMediaBudget,
    open: OpenTable,
    signal: AbortSignal | undefined,
  ): Promise<InlineMediaPlan | undefined> {
    // Every row, although only those with a payload matter here: left to the database to pass over,
    // a history without media would be walked in one step, however long it is.
    const keySql = `SELECT id, "${media.recencyColumn}", OCTET_LENGTH("${media.payloadColumn}") AS "payloadBytes" FROM ${entry.table}`;
    // Only this first statement may find the table missing.
    let opened = await open(entry, keySql, EXPORT_KEY_BATCH_ROWS);
    if (!opened) return undefined;
    const scanKeys = async (): Promise<AsyncIterable<unknown[]>> => {
      const scan = opened ?? (await snapshot.scan(keySql, EXPORT_KEY_BATCH_ROWS));
      opened = undefined;
      return scan;
    };

    const kept: InlineMediaPlan['kept'] = new Map();
    const chunkLimit = Math.max(budget.bytes, EXPORT_READ_CHUNK_MIN_BYTES);
    const windows = newestFirstWindows(scanKeys, media.newestFirst as (key: unknown) => number, EXPORT_KEY_WINDOW);
    for await (const keys of windows) {
      for (const ids of chunkKeys(keys, chunkLimit)) {
        // A client that left before the first byte has nothing waiting on this pass.
        signal?.throwIfAborted();
        const byId = await this.readRowsById(snapshot, entry, ids);
        // IN returns the rows in no particular order; the budget is spent in the chunk's own order.
        for (const id of ids) {
          const row = byId.get(id);
          if (!row) continue;
          let fittedBytes = 0;
          let dropped = 0;
          media.strip(row as never, encodedBytes => {
            if (!budget.spend(encodedBytes)) {
              dropped += 1;
              return true;
            }
            fittedBytes += encodedBytes;
            return false;
          });
          if (fittedBytes > 0) kept.set(id, { row, dropped });
        }
      }
    }
    return { kept };
  }

  /**
   * The rows of a planned inline-media table in the order the table returns them, one chunk at a
   * time: ids and payload sizes first, so that a chunk of full rows stays within its byte limit. A
   * row the budget left a payload on comes from the plan; every other row is read here and loses the
   * payloads it carries.
   *
   * Each payload dropped from a row written here is tallied in `omitted`. The tally matters as much
   * as the bound: an over-budget payload is replaced with the engine's own omitted marker, which is
   * deliberately the same shape a payload skipped on the way in gets, so without a count a truncated
   * backup is indistinguishable from a complete one, both on inspection and on restore.
   */
  private async *readInlineMediaRows(
    snapshot: ExportSnapshot,
    entry: AnyExportTable,
    media: NonNullable<AnyExportTable['inlineMedia']>,
    plan: InlineMediaPlan,
    budgetBytes: number,
    omitted: ExportSummary['omittedInlineMedia'],
  ): AsyncGenerator<unknown[], void, undefined> {
    const keys = await snapshot.scan(
      `SELECT id, OCTET_LENGTH("${media.payloadColumn}") AS "payloadBytes" FROM ${entry.table}`,
      EXPORT_KEY_BATCH_ROWS,
    );
    const chunkLimit = Math.max(budgetBytes, EXPORT_READ_CHUNK_MIN_BYTES);
    for await (const batch of keys) {
      for (const ids of chunkKeys(batch as InlineMediaKey[], chunkLimit)) {
        const byId = await this.readRowsById(
          snapshot,
          entry,
          ids.filter(id => !plan.kept.has(id)),
        );
        const rows: unknown[] = [];
        for (const id of ids) {
          const held = plan.kept.get(id);
          const row = held?.row ?? byId.get(id);
          if (!row) continue;
          if (held) {
            omitted[media.bucket] += held.dropped;
          } else {
            media.strip(row as never, encodedBytes => {
              // A payload of no bytes fitted whatever was left of the budget, and stays as it did then.
              if (encodedBytes === 0) return false;
              omitted[media.bucket] += 1;
              return true;
            });
          }
          rows.push(row);
        }
        yield rows;
      }
    }
  }

  /** One chunk of full rows by id. */
  private async readRowsById(
    snapshot: ExportSnapshot,
    entry: AnyExportTable,
    ids: unknown[],
  ): Promise<Map<unknown, unknown>> {
    if (ids.length === 0) return new Map();
    const rows = await snapshot.query<Array<{ id: unknown }>>(
      `SELECT * FROM ${entry.table} WHERE id IN (${ids.map((_, i) => snapshot.placeholder(i + 1)).join(', ')})`,
      ids,
    );
    return new Map(rows.map(row => [row.id, row]));
  }

  async importData(data: {
    tables: Partial<MigrationTables>;
    force?: boolean;
    stopOrphans?: boolean;
  }): Promise<InfraImportDataResult> {
    // Check-and-set with NO await between them, so the single-threaded event loop makes this atomic:
    // the first call reaches the assignment before the second call starts. It guards the whole method,
    // including the pre-flight orphan teardown below — running that twice concurrently would stop
    // engines on behalf of a restore that is about to be refused.
    if (this.importInFlight) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'A data import is already running; wait for it to finish before starting another.',
        code: 'IMPORT_ALREADY_RUNNING',
      });
    }
    if (this.exportInFlight) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'A data export is running; import after it finishes.',
        code: 'EXPORT_IN_PROGRESS',
      });
    }
    this.importInFlight = true;
    try {
      return await this.runImport(data);
    } finally {
      this.importInFlight = false;
    }
  }

  /**
   * Whether the restore runs on a connection of its own: a SQLite file. `:memory:` and '' would open an empty
   * database of their own, so they keep the shared connection.
   */
  private restoresOnOwnConnection(): boolean {
    const { type, database } = this.dataDataSource.options;
    return type === 'better-sqlite3' && typeof database === 'string' && !['', ':memory:'].includes(database.trim());
  }

  /** The restore's connection to the data file: the shared connection's options, with nothing that writes at open. */
  private openRestoreSource(): Promise<DataSource> {
    const options = this.dataDataSource.options as BetterSqlite3DataSourceOptions;
    return new DataSource({
      ...options,
      // Its COMMIT leaves the WAL to checkpointOffThread: copying a whole restore back there would hold the loop.
      prepareDatabase: async (database: { pragma(source: string): unknown }): Promise<void> => {
        await options.prepareDatabase?.(database);
        database.pragma('wal_autocheckpoint = 0');
      },
      synchronize: false,
      migrationsRun: false,
      dropSchema: false,
      subscribers: [],
    }).initialize();
  }

  private async checkpointRestore(): Promise<void> {
    await checkpointOffThread(String(this.dataDataSource.options.database)).catch((error: unknown) =>
      this.logger.warn('Could not checkpoint the restored data off the main thread', { error: String(error) }),
    );
  }

  /** The replace-all restore itself. Only ever entered through importData's single-flight guard. */
  private async runImport(data: {
    tables: Partial<MigrationTables>;
    force?: boolean;
    stopOrphans?: boolean;
  }): Promise<InfraImportDataResult> {
    const warnings: string[] = [];

    // Runtime reconciliation, part 1 (pre-flight): the replace below DELETES every session not in the
    // backup, but an engine started for such a session keeps running as an unstoppable zombie (the
    // session service keys engines by session id, and every stop path goes through the now-missing DB
    // row) whose inbound messages land in tables that were just replaced. Three operator-chosen paths:
    //   - default: refuse with 409 listing the orphan ids;
    //   - force=true: proceed and leave the engines running until process restart (restartRequired=true);
    //   - stopOrphans=true: stop each orphan engine inside this request (best-effort, time-bounded,
    //     isolated per engine) and then proceed — restartRequired stays false on the success path.
    // stopOrphans is preferred over force for the orphan case: a force restore that silently leaves
    // engines writing into the freshly replaced tables for an unbounded time is the corruption this
    // gate exists to prevent, so the explicit-stop path closes that window instead of relying on the
    // operator to restart promptly.
    // Every present table must be an array of rows before anything dereferences one. `.map()` on a
    // string or a number is a TypeError — a 500 telling the operator the SERVER broke, when their
    // archive is simply malformed. Checked for all tables, not just `sessions`: the rest are read
    // inside the transaction, where the same mistake would fail mid-restore instead of before it.
    for (const [table, rows] of Object.entries(data.tables ?? {})) {
      if (rows === undefined) continue;
      if (!Array.isArray(rows)) {
        throw new BadRequestException(`tables.${table} must be an array of rows`);
      }
      // Array.isArray alone is not enough: `[null]` passes it and then dies on the first property
      // read, which is the same 500 with a longer fuse. Every element must be a row object.
      const badRow = rows.findIndex(row => typeof row !== 'object' || row === null || Array.isArray(row));
      if (badRow !== -1) {
        throw new BadRequestException(`tables.${table}[${badRow}] must be a row object`);
      }
    }

    // An archive with no rows is always refused (see the totalRestored check below), so refuse it here,
    // before the orphan pre-flight: with no sessions in it every running engine reads as an orphan, and
    // a stopOrphans retry would tear all of them down for a restore that was never going to happen.
    // A row a skip guard vetoes is just as certain a rollback (see the warnings gate below), and the
    // guards read only the archived tables, so run them here too. The in-transaction call stays as a backstop.
    const refusals = TABLE_IMPORTERS.every(importer => !data.tables[importer.key]?.length)
      ? [EMPTY_ARCHIVE_WARNING]
      : TABLE_IMPORTERS.flatMap(importer =>
          (data.tables[importer.key] ?? [])
            .map((row, _index, rows) => importer.skip?.(row as never, rows as never))
            .filter((warning): warning is string => warning != null),
        );
    if (refusals.length > 0) {
      return {
        imported: false,
        counts: Object.fromEntries(TABLE_IMPORTERS.map(importer => [importer.key, 0] as const)) as TableCounts,
        warnings: refusals,
        notices: [],
        restartRequired: false,
        orphanedEngines: [],
        stoppedOrphanEngines: [],
        failedOrphanEngines: [],
      };
    }

    const importedSessionIds = new Set((data.tables.sessions ?? []).map(s => s.id));
    const orphanedEngines = (this.sessionService?.getActiveSessionIds() ?? []).filter(
      id => !importedSessionIds.has(id),
    );

    let stoppedOrphanEngines: string[] = [];
    let failedOrphanEngines: string[] = [];
    let restartRequired = false;

    // notices collect non-fatal operator-facing messages (orphan-engine reconciliation details) that
    // must NOT trip the warnings→rollback gate further down. warnings is reserved for per-row import
    // failures that make the replace partial and therefore require a rollback.
    const notices: string[] = [];

    // `getActiveSessionIds` reads this process's own engine registry, so an engine another node is
    // running is invisible here and cannot be stopped from this request — there is no cross-process
    // control channel. Left unsaid, a clean response would read as "every orphan was reconciled".
    // Say it instead: the operator is the only one who can act on it.
    const heldElsewhere = (await this.ownership?.heldByOtherNodes()) ?? [];
    if (heldElsewhere.length > 0) {
      restartRequired = true;
      notices.push(
        `${heldElsewhere.length} session(s) are running on another node and could not be reconciled from ` +
          `this request: ${heldElsewhere.join(', ')}. Their engines may still write into the restored ` +
          `tables — stop those nodes before relying on this import.`,
      );
    }

    if (orphanedEngines.length > 0 && data.stopOrphans && this.sessionService) {
      // Stop the orphans inside this request, BEFORE the transaction opens. Two 10s deadlines per
      // engine (destroy, then forceDestroy), run in parallel, bound the worst case (a stuck Chromium
      // cannot wedge the import); the engines are reconciled from the Map regardless of teardown outcome.
      const result = await this.sessionService.stopOrphanEngines(orphanedEngines);
      stoppedOrphanEngines = result.stopped;
      failedOrphanEngines = result.failed;
      // The teardown cannot be rolled back, and the import's own audit row is written only for a committed
      // restore, so each stopped session is recorded here: a refused or failed restore would leave no trace.
      for (const sessionId of result.stopped) {
        await this.auditService?.logInfo(AuditAction.SESSION_STOPPED, {
          sessionId,
          metadata: { via: 'infra_import_data' },
        });
      }
      if (failedOrphanEngines.length > 0) {
        // Teardown failed for at least one orphan. The Map entry is removed regardless (see
        // stopOrphanEngines), so the engine no longer holds a concurrency slot — but its underlying
        // Chromium/socket may still be alive and writing into restored tables. Surface the ids and
        // flag restartRequired so the operator does not read a clean response as "engines stopped".
        restartRequired = true;
        notices.push(
          `Teardown failed for ${failedOrphanEngines.length} orphan engine(s): ${failedOrphanEngines.join(', ')} ` +
            `(removed from the engine registry; a process restart guarantees cleanup).`,
        );
      }
      // Sessions with no engine yet are reported in notRunning: one still initializing aborts its start()
      // on the stop mark, and one waiting to relaunch after a failed reconnect had its relaunch cancelled.
      // Neither is counted as stopped here.
      if (result.notRunning.length > 0) {
        notices.push(
          `${result.notRunning.length} orphan session(s) had no live engine yet (initializing or waiting to ` +
            `reconnect): ${result.notRunning.join(', ')}; they will not start.`,
        );
      }
    } else if (orphanedEngines.length > 0 && !data.force) {
      // Carries a code like the other two refusals, and for a stronger reason: this is the ONLY 409
      // on this route whose documented retry (stopOrphans=true) is destructive — it stops live
      // engines — and dashboard/src/utils/importRefusal.ts decides whether to offer that retry by
      // matching this code. Renaming it there and here together is required; renaming it here alone
      // leaves both suites green and withdraws the operator's only route to stopOrphans. Were the
      // case identified by the ABSENCE of a code instead, every unrecognised 409 (a proxy's, a body
      // that never parsed) would open a confirm whose OK tears down engines and replaces every table.
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message:
          `Import would orphan ${orphanedEngines.length} running engine(s) for session(s) ` +
          `${orphanedEngines.join(', ')} that the backup does not contain. Stop them first, retry with ` +
          `stopOrphans=true (stops them inside this request), or retry with force=true ` +
          `(a server restart is then required to stop the orphaned engines).`,
        code: 'IMPORT_WOULD_ORPHAN_ENGINES',
      });
    } else if (orphanedEngines.length > 0 && data.force) {
      // Legacy escape hatch: proceed and leave the engines running until restart.
      restartRequired = true;
    }

    // What the rollback branches below must report about the engines. The transaction can be rolled
    // back; the orphan teardown above CANNOT — it ran before the transaction opened and those engines
    // are already destroyed. Reporting empty arrays there would tell an operator nothing happened
    // while their sessions are down.
    //
    // restartRequired narrows to the one thing a rollback cannot undo: a FAILED teardown may have left
    // a Chromium/socket alive. The two other pre-flight outcomes do not survive the rollback as
    // restart-worthy — a cleanly stopped orphan leaves its session row intact (restart it through
    // POST /sessions/:id/start), and an engine the force path left running was never orphaned after
    // all, because the data it would have been orphaned by is gone.
    const engineStateAfterRollback = {
      restartRequired: failedOrphanEngines.length > 0,
      orphanedEngines,
      stoppedOrphanEngines,
      failedOrphanEngines,
    };

    // Silence the ownership heartbeat's loss detection for the whole transaction — but ONLY where the
    // hazard exists. On SQLite every query runner shares one connection, so a heartbeat tick executes
    // INSIDE this transaction, after the DELETE below and before the re-inserts commit, and sees no
    // session rows at all; it would read that as "a peer took everything" and tear down every engine
    // on this node, even on the paths where this import then rolls back. Postgres hands each runner a
    // dedicated pooled client, so the heartbeat cannot see any of it — suspending there would only
    // disable genuine loss detection in the multi-node deployment that depends on it.
    const sharesOneConnection = SHARED_CONNECTION_DIALECTS.has(this.dataDataSource.options.type);
    const resumeLossDetection = sharesOneConnection ? this.ownership?.suspendLossDetection() : undefined;

    // The replace deletes every session the archive does not hold, rows and all, and messages has no foreign
    // key to refuse a send or batch row that lands after it. So their write scopes are closed and drained
    // before the transaction opens, as SessionEngineControls.delete does. Not for an engine force left
    // running, which keeps writing (restartRequired says so), nor for one another node holds.
    const leftRunning = new Set([...heldElsewhere, ...(data.stopOrphans ? [] : orphanedEngines)]);
    let retired: Array<{ id: string; writes: ReturnType<typeof closeSessionWrites> }> = [];
    let committed = false;
    // Set when another transaction opened on the shared connection while the writes drained.
    let foreignTransaction = false;

    // A SQLite file is restored on a connection of its own, in chunks with a turn of the event loop between them,
    // while the shared connection holds every other caller: they wait as on a blocked loop and see the data from
    // before or after the restore, never a half state.
    const restoresAside = this.restoresOnOwnConnection();
    let hold: SharedConnectionHold | undefined;
    // What runs on the shared connection after the restore goes ahead of the callers it held.
    const asOwner = <T>(work: () => Promise<T>): Promise<T> => (hold ? hold.asOwner(work) : work());

    // Everything from here is wrapped so the token cannot outlive this request. It is not enough to
    // release it in the transaction's own finally: createQueryRunner/connect/startTransaction sit
    // before that finally exists, so any throw there — a driver change, a broadcaster subscriber, a
    // failing BEGIN/SAVEPOINT — would strand it. Defence in depth rather than a reachable bug today,
    // and deliberately so: a leaked token disables loss detection for the lifetime of the process,
    // silently, which is strictly worse than the teardown the suspension prevents.
    try {
      const sharedRunner = this.dataDataSource.createQueryRunner();
      let queryRunner = sharedRunner;
      let restoreSource: DataSource | undefined;
      // The restore's own connection is closed and the callers held let through, on every path, before the shared
      // connection is used again.
      let endRestoring = (): void => undefined;
      const endRestore = async (): Promise<void> => {
        const source = restoreSource;
        restoreSource = undefined;
        await source
          ?.destroy()
          .catch((error: unknown) =>
            this.logger.warn('Could not close the connection of a restore', { error: String(error) }),
          );
        hold?.release();
        endRestoring();
      };

      // Refuse BEFORE a single row is deleted, not after. On better-sqlite3 every query runner is a
      // driver SINGLETON, so if anything else already holds a transaction on this DataSource — a
      // session create or delete — this import would not get its own: it would become a SAVEPOINT
      // inside theirs, and commitTransaction() would issue RELEASE SAVEPOINT rather than COMMIT.
      //
      // The outcome of that is genuinely indeterminate, which is why detecting it afterwards is not
      // good enough: if the enclosing transaction commits, the replace lands; if it rolls back, the
      // replace vanishes. Either way this request cannot report the truth, and it has already
      // deleted every row — including any the enclosing transaction just wrote. Refusing up front is
      // the only answer that is both honest and non-destructive. On Postgres each runner gets its own
      // pooled client, so this is always false there and the check costs nothing.
      //
      // The try/finally that releases the runner opens only after BEGIN, so the refusal and a failing
      // BEGIN give the runner back here: a pooled PostgreSQL client would otherwise stay checked out for
      // the life of the process.
      const nestedTransaction = (): ConflictException =>
        new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          message:
            'Another database transaction is in progress on this connection, so a restore could not be ' +
            'made durable. Retry with no other data operation in flight.',
          code: 'IMPORT_NESTED_TRANSACTION',
        });
      const refuseNestedTransaction = (): void => {
        if (sharedRunner.isTransactionActive) throw nestedTransaction();
      };
      try {
        refuseNestedTransaction();
        // Drained before BEGIN: on SQLite a write still in flight would otherwise join this transaction. And
        // before this runner takes a pooled client on PostgreSQL, where the write may still need one: with a
        // pool of one it would wait for the import while the import waits for it. So the ids are read on a
        // client that goes back at once there; on SQLite this runner is the one connection anyway.
        const existing = await this.dataDataSource.query<Array<{ id: string }>>(
          'SELECT id FROM sessions',
          [],
          sharesOneConnection ? sharedRunner : undefined,
        );
        retired = existing
          .filter(({ id }) => !importedSessionIds.has(id) && !leftRunning.has(id))
          .map(({ id }) => ({ id, writes: closeSessionWrites(this.dataDataSource, id) }));
        await Promise.all(retired.map(({ writes }) => writes.drain()));
        if (restoresAside) {
          restoreSource = await this.openRestoreSource();
          // Taken on a turn that finds no transaction open on the shared connection, which a restore must not
          // nest into; one still open after the wait's bound is refused as above.
          hold = await holdSharedConnection(this.dataDataSource);
          this.restoring = new Promise(resolve => (endRestoring = resolve));
          if (!hold) {
            foreignTransaction = true;
            throw nestedTransaction();
          }
          queryRunner = restoreSource.createQueryRunner();
        } else {
          await queryRunner.connect();
          // Again after the drain's await: BEGIN must follow the check with nothing in between.
          if (queryRunner.isTransactionActive) foreignTransaction = true;
          refuseNestedTransaction();
        }
        await queryRunner.startTransaction();
      } catch (error) {
        await queryRunner.release().catch(() => undefined);
        await endRestore();
        throw error;
      }

      // Read inside the transaction, used once it has committed.
      let previousPluginBindings: Parameters<ScopeBindingService['resyncAfterImport']>[0] = [];
      let counts = {} as TableCounts;
      // Undefined once committed, otherwise the answer of a restore that rolled back.
      const replace = async (): Promise<InfraImportDataResult | undefined> => {
        try {
          const isPostgres = this.dataDataSource.options.type === 'postgres';
          if (isPostgres) {
            // The runtime pool carries a statement_timeout sized for request traffic (30 s by default), but
            // the clears and scrubs below scale with the live tables, not with the archive: restoring an
            // earlier export onto an instance whose messages table has since grown to millions of rows
            // would be cancelled mid-DELETE, after the engines of the sessions it drops were already
            // stopped. Lifted for this transaction only, as the migrations do. A lock wait keeps the bound
            // the statement timeout gave it, so a stuck lock still fails the import instead of hanging it.
            const lockWaitMs = Math.max(
              0,
              Math.trunc(this.configService.get<number>('dataDatabase.statementTimeoutMs', 30000)) || 0,
            );
            await queryRunner.query('SET LOCAL statement_timeout = 0');
            await queryRunner.query(`SET LOCAL lock_timeout = ${lockWaitMs}`);
          }
          // Clear existing data (in correct order due to foreign keys). templates,
          // baileys_stored_messages, and automation_rules FK sessions ON DELETE CASCADE, so the
          // sessions DELETE would clear them too; clearing them explicitly first keeps the order
          // correct on engines where the cascade is not enforced. Tolerate a genuinely-absent table (isMissingTableError) but let any
          // OTHER failure (lock, I/O, aborted tx) propagate to the transaction rollback below — a blind
          // `.catch(() => {})` here could otherwise silently commit a MERGED (not replaced) restore on
          // SQLite, violating the endpoint's "replaces existing data" contract.
          // A restore on its own connection gives the event loop a turn every RESTORE_CHUNK_ROWS rows.
          // A stop is checked on each turn, so it rolls the restore back within a chunk. A short restore can still
          // finish inside the shutdown grace, before teardown begins.
          const turn = restoresAside
            ? async (): Promise<void> => {
                for (let i = 0; i < RESTORE_TURNS_PER_CHUNK; i++) await setImmediate();
                if (this.stopping.signal.aborted || this.shutdown?.isTearingDown()) {
                  throw new ServiceUnavailableException({
                    statusCode: 503,
                    error: 'Service Unavailable',
                    message:
                      'The gateway stopped during the restore, which was rolled back: the data is as it was. ' +
                      'Restore again once the gateway is back.',
                    code: 'IMPORT_STOPPED',
                  });
                }
              }
            : undefined;
          // There it deletes in chunks too (no table is WITHOUT ROWID), and `affected` counts the rows a chunk took.
          const deleteRows = async (table: string, where = ''): Promise<void> => {
            if (!turn) {
              await queryRunner.query(`DELETE FROM ${table}${where}`);
              return;
            }
            const chunk = `SELECT rowid FROM ${table}${where} LIMIT ${RESTORE_CHUNK_ROWS}`;
            const deleteChunk = `DELETE FROM ${table} WHERE rowid IN (${chunk})`;
            while ((await queryRunner.query(deleteChunk, [], true)).affected === RESTORE_CHUNK_ROWS) {
              await turn();
            }
          };
          // There too it rewrites the restored messages by ranges of rowid, a turn after each as between the inserts: an
          // archive from before one of those rewrites can match every row.
          const eachMessageRange = async (rewrite: (range?: string) => Promise<void>): Promise<void> => {
            if (!turn || !(await queryRunner.hasTable('messages'))) return rewrite();
            for (let after = 0; ;) {
              const [last] = (await queryRunner.query(
                `SELECT rowid AS id FROM messages WHERE rowid > ${after} ORDER BY rowid LIMIT 1 OFFSET ${RESTORE_CHUNK_ROWS - 1}`,
              )) as Array<{ id: number }>;
              await rewrite(last ? `rowid > ${after} AND rowid <= ${last.id}` : `rowid > ${after}`);
              if (!last) return;
              after = last.id;
              await turn();
            }
          };
          const clearTable = async (table: string, where = ''): Promise<void> => {
            // Asked first on PostgreSQL: a statement that names a missing relation aborts the whole transaction even
            // when its error is caught, and every later statement then fails with 25P02.
            if (isPostgres && !(await queryRunner.hasTable(table))) {
              this.logger.debug('Skipped clearing a table that does not exist during import', { table });
              return;
            }
            try {
              await deleteRows(table, where);
            } catch (err) {
              if (isPostgres || !isMissingTableError(err)) throw err;
              this.logger.debug('Skipped clearing a table that does not exist during import', { table });
            }
          };
          // The INSERTs below are written once, in Postgres' `$N` placeholder form. better-sqlite3 differs
          // from the legacy sqlite3 driver on raw queries in two ways: SQLite parses `$N` as a NAMED
          // parameter, which cannot be bound from the positional array TypeORM passes through (RangeError),
          // and strict binding rejects booleans/undefined — which a Postgres-made backup carries (real
          // booleans survive the JSON round-trip). Postgres needs `$N` and binds booleans natively, so both
          // rewrites apply only on the SQLite path. Safe: every `$N` below occurs once, in ascending order.
          const insert = (text: string, params: unknown[]): Promise<unknown> =>
            queryRunner.query(
              isPostgres ? text : text.replace(/\$\d+/g, '?'),
              isPostgres ? params : params.map(v => (typeof v === 'boolean' ? Number(v) : (v ?? null))),
            );
          await deleteRows('webhooks');
          await clearTable('messages');
          await clearTable('message_batches');
          await clearTable('templates');
          await clearTable('baileys_stored_messages');
          await clearTable('automation_rules');
          // lid_mappings is not a FK to sessions, so the sessions DELETE below won't clear it; clear it
          // explicitly so a restore replaces the cache rather than colliding on existing lid PKs.
          await clearTable('lid_mappings');
          // chat_states is the same case: PK (sessionId, chatId), no FK to sessions, so the sessions DELETE
          // does not reach it. Without this, a restore onto an instance that already holds chat_states rows
          // collides on those PKs and the all-or-nothing gate rolls the whole import back.
          await clearTable('chat_states');
          // The runtime plugin bindings (activeSessions, per-session config) were projected from the rows
          // about to be deleted. Remember which scopes they bound so the post-commit resync can retire
          // the ones the restore drops. Probed first: on PostgreSQL a failed SELECT would abort the
          // transaction, and a missing table is tolerated by clearTable below.
          previousPluginBindings = (await queryRunner.hasTable('plugin_instances'))
            ? (
                (await queryRunner.query(
                  'SELECT "pluginId", "instanceId", "sessionScope", enabled, config FROM plugin_instances',
                )) as Array<{
                  pluginId: string;
                  instanceId?: string;
                  sessionScope: string | null;
                  enabled: boolean | number;
                  config?: unknown;
                }>
              ).map(row => ({
                ...row,
                enabled: Number(row.enabled) === 1,
                config: parsePluginInstanceConfig(row.config),
              }))
            : [];
          // Integration Fabric + both DLQs: none carry an FK constraint to sessions (sessionId is provenance),
          // so clearing them here before the sessions DELETE keeps the replace-semantics complete.
          await clearTable('plugin_instances');
          await clearTable('conversation_mappings');
          await clearTable('ingress_events');
          await clearTable('webhook_delivery_failures');
          // Same rule, and it bites harder here: webhook_outbox_events carries UNIQUE(webhookId,
          // idempotencyKey), so without this clear a restore onto an instance that already holds the
          // archive's rows collides on every one of them, and the all-or-nothing gate below rolls the
          // whole import back. Restoring a backup onto the instance that produced it is exactly the
          // rollback flow, so leaving it out broke the recovery path rather than a corner of it.
          await clearTable('webhook_outbox_events');
          await clearTable('integration_delivery_failures');
          // status_updates has no FK to sessions; clear it explicitly so the replace is complete.
          await clearTable('status_updates');
          // Session ownership is CLUSTER RUNTIME STATE, not backup payload: which process currently holds
          // a session's engine, and until when. The replace below deletes it along with everything else,
          // and the sessions importer does not restore it (deliberately — see below), so without this the
          // committed rows come back unclaimed and the next lease renewal reads "claim lost" and tears
          // down engines that never stopped running.
          //
          // It must NOT be restored from the payload instead. export-data does `SELECT *`, so real backups
          // DO carry these columns even though SessionRow does not declare them — restoring them would
          // install the SOURCE host's nodeId with its still-future lease, and every start would then 409
          // "running on another node" until that lease lapsed. Strictly worse than the bug.
          //
          // Read through the SAME queryRunner (a repository would take a second connection and self-
          // deadlock on Postgres) and tolerate the columns being absent, so a database whose ownership
          // migration has been rolled back still imports.
          const preservedOwnership = await readSessionOwnership(queryRunner);
          // Stamped AFTER the read, so the remaining lease time carried forward later is measured from
          // the latest moment these values are known to have been true — never longer than they were.
          const ownershipReadAt = new Date();

          await deleteRows('sessions');

          // Restore table by table in TABLE_IMPORTERS order (FK-safe: sessions first). The descriptors
          // carry each table's INSERT text, param mapping, and per-row skip guard; a missing or empty
          // table keeps its 0 count and contributes no warnings.
          counts = Object.fromEntries(TABLE_IMPORTERS.map(importer => [importer.key, 0] as const)) as TableCounts;
          const regeneratedPluginInstances: string[] = [];
          let rowsSinceTurn = 0;
          // SQLite only: archived datetime values are normalized to the form TypeORM writes there, so a
          // PostgreSQL-made backup compares and sorts like rows the app wrote itself.
          const datetimeColumns = isPostgres ? undefined : sqliteDatetimeColumns(this.dataDataSource);
          restore: for (const importer of TABLE_IMPORTERS) {
            const rows =
              importer.key === 'webhookDeliveryFailures'
                ? deduplicateArchivedWebhookFailures(data.tables.webhookDeliveryFailures ?? [])
                : data.tables[importer.key];
            if (!rows?.length) continue;
            const dateColumns = datetimeColumns?.get(importer.key) ?? [];
            for (const archivedRow of rows) {
              if (turn && ++rowsSinceTurn === RESTORE_CHUNK_ROWS) {
                rowsSinceTurn = 0;
                await turn();
              }
              const source = archivedRow as unknown as Record<string, unknown>;
              const untypedRow = {
                ...source,
                ...Object.fromEntries(
                  dateColumns
                    .filter(column => column in source)
                    .map(column => [column, toSqliteDatetime(source[column])]),
                ),
              };
              // `rows` was read from `data.tables[importer.key]`, so it holds exactly the row type this
              // descriptor's id/map/skip declare. That correlation is what the erased importer type
              // cannot carry, and this loop is the one place it is known, so the cast lives here rather
              // than at each of the three uses below.
              const row = untypedRow as never;
              const skipWarning = importer.skip?.(row, rows as never);
              if (skipWarning != null) {
                warnings.push(skipWarning);
                continue;
              }
              try {
                await insert(importer.sql, importer.map(row));
                counts[importer.key]++;
                if (
                  importer.key === 'pluginInstances' &&
                  isRedactedPluginSecret((untypedRow as unknown as PluginInstanceRow).secret)
                ) {
                  regeneratedPluginInstances.push(importer.id(row));
                }
              } catch (err) {
                warnings.push(
                  `Failed to import ${importer.label} ${importer.id(row)}: ${err instanceof Error ? err.message : String(err)}`,
                );
                // PostgreSQL aborts the transaction on a failed statement: every later one would fail with
                // "current transaction is aborted" and bury this row's real error. Stop at the first.
                if (isPostgres) break restore;
              }
            }
          }

          // Re-apply the claims read before the DELETE, for ids that exist in both. This runs BEFORE the
          // all-or-nothing gate below on purpose: a failure here must take the same rollback the gate
          // already implements. Degrading it to a notice and committing anyway would be worse than the
          // bug it fixes — on PostgreSQL a failed statement aborts the transaction, so the COMMIT would
          // execute as a ROLLBACK and the endpoint would report a fully discarded import as a success,
          // with per-table counts, to an operator restoring after data loss.
          // Skipped once a row has failed: the rollback below is already certain, and on PostgreSQL the
          // aborted transaction would only add a misleading warning.
          if (warnings.length === 0) {
            try {
              await restoreSessionOwnership(preservedOwnership, insert, ownershipReadAt);
            } catch (error) {
              warnings.push(
                `Failed to restore session ownership: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }

          // An archive taken before 0.23.5 keys chat_states by session NAME. The migration that re-keys
          // them to the session id has already run on this database, so a restored name-keyed row would
          // never be read again and its mute, archive and pin state would be silently lost. Run the same
          // re-key here, inside the transaction. A failure takes the rollback below, like the ownership
          // restore, because on PostgreSQL it has already aborted the transaction.
          if (warnings.length === 0) {
            try {
              if (await queryRunner.hasTable('chat_states')) {
                await queryRunner.query(
                  ReKeyChatStatesBySessionId1786500000000.rekey('name', 'id', { skipAlreadyKeyed: true }),
                );
              }
            } catch (error) {
              warnings.push(`Failed to re-key chat states: ${error instanceof Error ? error.message : String(error)}`);
            }
          }

          // The same holds for the 0.24.0 scrubs: an archive taken before them restores revoked messages
          // with their media, quote and reactions, and lid mappings with a broadcast id as the phone.
          if (warnings.length === 0) {
            try {
              await eachMessageRange(async range => {
                await ScrubRevokedMessageContent1786900000000.scrub(queryRunner, range);
                // An archive taken before the neutral message vocabulary restores the raw wwebjs tokens, which
                // the boot-time backfill no longer converts on a migration-managed database.
                await BackfillLegacyMessageTypes1791300000000.backfill(queryRunner, range);
              });
              await ScrubNonPhoneLidMappings1786950000000.scrub(queryRunner);
            } catch (error) {
              warnings.push(`Failed to clean restored rows: ${error instanceof Error ? error.message : String(error)}`);
            }
          }

          // send_idempotency_keys is not archived, so it is trimmed rather than cleared. A claim of a session
          // this restore dropped would outlive it by up to 24 h, and a later restore that brings the id back
          // would answer a retried send with the old stored response instead of sending it. The claims of a
          // session the restore keeps stay: a retry of a send made before the restore still replays.
          // Asked first rather than caught: on PostgreSQL a statement that fails, a missing table included,
          // aborts the whole import transaction, and every later statement then fails with it.
          if (warnings.length === 0 && (await queryRunner.hasTable('send_idempotency_keys'))) {
            try {
              // CAST: sessions.id is a uuid on PostgreSQL and the claim's sessionId a varchar, which `IN` does not
              // compare.
              await clearTable(
                'send_idempotency_keys',
                ' WHERE "sessionId" NOT IN (SELECT CAST("id" AS TEXT) FROM sessions)',
              );
            } catch (error) {
              warnings.push(
                `Failed to drop the send idempotency claims of removed sessions: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }

          // "Replace all data" must be all-or-nothing: the import already DELETEd every row, so if any
          // INSERT failed we must roll back (restoring the pre-import data) rather than commit a
          // half-wiped DB and report success. A partial restore reported as imported:true was how
          // message history could silently vanish on a SQLite->Postgres migration. It must precede
          // every further statement: on PostgreSQL a failure has aborted the transaction, so the
          // normalization UPDATE below would throw and turn this answer into a 500.
          if (warnings.length > 0) {
            await queryRunner.rollbackTransaction();
            return {
              imported: false,
              counts,
              warnings,
              notices,
              ...engineStateAfterRollback,
            };
          }

          // Normalize imported statuses the same way boot does: an ACTIVE status (ready,
          // initializing, ...) in a backup describes the SOURCE host's engines, and restoring it
          // verbatim leaves rows reading ready with no engine anywhere - invisible to auto-start
          // (selects disconnected) and to the takeover sweep, until a process restart. Scoped to
          // CLAIMABLE rows: a PEER's preserved claim (a live engine backs the row elsewhere) keeps
          // the backup's status; this node's own claims normalize exactly like boot's reset does -
          // for a live self-engine the row understates reality until the next engine status event,
          // which is the same trade boot makes.
          const ACTIVE_STATUSES = [
            SessionStatus.READY,
            SessionStatus.INITIALIZING,
            SessionStatus.QR_READY,
            SessionStatus.AUTHENTICATING,
            SessionStatus.ACTION_REQUIRED,
          ];
          const claimable = this.ownership?.claimableWhere() ?? [{}];
          // An empty clause list means nothing is claimable (no rows to normalize). TypeORM also
          // rejects empty update criteria, so skip rather than build an empty OR.
          const normalized =
            claimable.length === 0
              ? { affected: 0 }
              : await queryRunner.manager.getRepository(SessionEntity).update(
                  claimable.map(clause => ({ ...clause, status: In(ACTIVE_STATUSES) })),
                  { status: SessionStatus.DISCONNECTED },
                );
          if (normalized.affected && normalized.affected > 0) {
            notices.push(
              `${normalized.affected} imported session(s) carried an active status (the source host's engines): ` +
                'restored as disconnected - start them via POST /api/sessions/:id/start or let auto-start adopt them.',
            );
          }
          if (regeneratedPluginInstances.length > 0) {
            notices.push(
              `${regeneratedPluginInstances.length} imported plugin instance(s) had redacted or missing ingress secrets ` +
                `(${regeneratedPluginInstances.join(', ')}): regenerated fresh secrets and restored them disabled. ` +
                'Re-sync regenerated ingress secrets and any redacted plugin config secrets before re-enabling them.',
            );
          }

          // A wrong/empty/garbage backup file restores zero rows but the DELETE already ran — committing
          // would silently WIPE the database and report success. Refuse it and roll back instead. (#488)
          const totalRestored = Object.values(counts).reduce((sum, n) => sum + n, 0);
          if (totalRestored === 0) {
            await queryRunner.rollbackTransaction();
            return {
              imported: false,
              counts,
              warnings: [EMPTY_ARCHIVE_WARNING],
              notices,
              ...engineStateAfterRollback,
            };
          }

          await queryRunner.commitTransaction();
          committed = true;
          return undefined;
        } catch (error) {
          await queryRunner.rollbackTransaction();
          throw error;
        } finally {
          await queryRunner.release();
        }
      };
      let rolledBack: InfraImportDataResult | undefined;
      try {
        rolledBack = await (hold ? hold.asRestore(replace) : replace());
        // Copied back while the callers are still held: the next commit on the shared connection would otherwise
        // copy the whole restore on the loop.
        if (committed && restoresAside) await this.checkpointRestore();
      } finally {
        await endRestore();
      }
      if (rolledBack) return rolledBack;

      return await asOwner(async () => {
        // Ahead of the callers the restore held: a session row write kept from before the import is about the row it
        // replaced.
        this.sessionService?.forgetRestoredRows?.(importedSessionIds);
        // The replace removed these sessions without a delete, so what this process keeps for them goes here.
        for (const { id } of retired) this.sessionService?.forgetSession(id);
        // Retained live sessions and force-kept orphans bypass forgetSession() above, so clear all cached
        // automation rules and pre-import cooldowns immediately after commit.
        if (this.moduleRef) {
          try {
            const automationRules = this.moduleRef.get(AutomationRulesService, { strict: false });
            if (typeof automationRules?.clearCache === 'function') automationRules.clearCache();
          } catch {
            // AutomationModule may be absent in minimal test harnesses; best-effort post-commit.
          }
        }

        // Runtime reconciliation, part 2 (post-commit): the in-memory lid->phone mirror was warmed from
        // the OLD lid_mappings rows and is write-through only, so the just-restored table would never
        // reach it — resolution would keep serving stale entries (and miss restored ones) until the next
        // process start. Reload from the new DB contents. Best-effort: a miss falls back to engine
        // re-resolution, so a reload failure degrades instead of failing the (already committed) import.
        // The chat-state mirror has the same shape: left stale, GET /chats would serve the old
        // archived/pinned/muted flags and the next live update would write them back over the restore.
        await this.lidMappingStore?.reload();
        await this.chatStateStore?.reload();

        // Plugin runtime bindings are projected from plugin_instances rows and saved to the plugin
        // registry, and the boot pass only ever adds to them. Without this resync, an instance the
        // restore dropped keeps receiving its session's hooks with its old config, even after a
        // restart. Best-effort: the import is already committed.
        if (this.moduleRef) {
          try {
            await this.moduleRef.get(ScopeBindingService, { strict: false }).resyncAfterImport(previousPluginBindings);
          } catch (error) {
            restartRequired = true;
            notices.push(
              `Plugin instance bindings could not be re-applied after the restore ` +
                `(${error instanceof Error ? error.message : String(error)}): check each plugin's active sessions ` +
                `and per-session config (GET /api/plugins/:id, PUT /api/plugins/:id/sessions) against its restored instances, ` +
                `and its base config for a secret a dropped session-wide instance left behind (PUT /api/plugins/:id/config).`,
            );
          }
        }

        // Audit the destructive replace-all restore, only on the committed-success path (the rollback /
        // refused-empty branches above return without emitting, since no data actually changed). Any
        // warnings would have taken the rollback branch, so warnings.length is always 0 here — record
        // only the per-table counts.
        await this.auditService?.logInfo(AuditAction.INFRA_DATA_IMPORTED, { metadata: { counts } });

        // restartRequired was computed in the pre-flight, from three independent causes: orphans left
        // running (force=true legacy path), a stopOrphans teardown that failed for at least one
        // engine, and sessions held by another node, which this request cannot reach to stop. It is
        // also set above when the post-commit plugin binding re-sync fails; a restart does not repair
        // that one, so its notice names the manual check instead.
        return {
          imported: true,
          counts,
          warnings,
          notices,
          restartRequired,
          orphanedEngines,
          stoppedOrphanEngines,
          failedOrphanEngines,
        };
      });
    } finally {
      // A restore that did not commit keeps those sessions, but a batch run that captured their writes before
      // the close stays stopped, so its row is failed before the release, as a failed delete does. Their
      // engines are gone, so the batch could not have sent anyway. Not inside a transaction another caller
      // opened on the shared connection while the writes drained: the fail would roll back with it.
      await asOwner(async () => {
        if (foreignTransaction && retired.length > 0 && !(await awaitNoOpenTransaction(this.dataDataSource))) {
          this.logger.warn('Failing the unfinished batches of a refused import inside another open transaction', {
            action: 'infra_import_foreign_transaction_open',
            sessionIds: retired.map(({ id }) => id),
          });
        }
        for (const { id } of committed ? [] : retired) {
          await failUnfinishedSessionBatches(this.dataDataSource, id).catch((error: unknown) =>
            this.logger.warn(
              `Could not fail the unfinished batches of session ${id} after an import that did not commit`,
              {
                sessionId: id,
                action: 'infra_import_batch_fail_failed',
                error: error instanceof Error ? error.message : String(error),
              },
            ),
          );
        }
      });
      for (const { writes } of retired) writes.release();
      // Its own finally, so a throwing release() cannot strand the token either.
      resumeLossDetection?.();
    }
  }
}
