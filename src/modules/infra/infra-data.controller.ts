import { Controller, Get, Post, Body, ConflictException, HttpCode, HttpStatus, Optional } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { DataSource, QueryRunner } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { RequireRole, RequireUnscopedKey } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { createLogger } from '../../common/services/logger.service';
import { isMissingTableError } from '../../common/utils/db-errors';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { SessionService } from '../session/session.service';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { SessionOwnershipService } from '../session/session-ownership.service';
import type {
  MigrationTables,
  TableCounts,
  SessionRow,
  WebhookRow,
  MessageRow,
  MessageBatchRow,
  TemplateRow,
  BaileysStoredMessageRow,
  LidMappingRow,
  PluginInstanceRow,
  ConversationMappingRow,
  IngressEventRow,
  WebhookDeliveryFailureRow,
  IntegrationDeliveryFailureRow,
  StatusUpdateRow,
  AutomationRuleRow,
} from './migration-tables.types';
import { TABLE_IMPORTERS } from './table-importers';

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
 * Dialects where every TypeORM query runner shares ONE connection, so an open transaction is visible
 * to anything else querying in the same process. A positive list on purpose: a dialect nobody has
 * classified must not silently opt into suspending a safety mechanism.
 */
const SHARED_CONNECTION_DIALECTS = new Set(['better-sqlite3', 'sqlite']);

@ApiTags('infrastructure')
@Controller('infra')
// Every route here is deployment-global (data export/import, infra config, service orchestration),
// so the guard's route-param session fence can never bite. Reject session-scoped keys outright at
// class level, which also covers routes added later. @Public routes are unaffected: the guard
// returns before it reads this metadata.
@RequireUnscopedKey()
export class InfraDataController {
  private readonly logger = createLogger('InfraDataController');

  /**
   * Whether a replace-all import is already running in this process. Not a nicety: on better-sqlite3
   * every query runner is a driver SINGLETON, so two overlapping imports share one transaction — the
   * second nests as SAVEPOINT, its commit issues RELEASE SAVEPOINT rather than COMMIT, and a rollback
   * at depth 1 issues a full ROLLBACK that discards a restore the other call already answered
   * `imported: true` for. Serialising them is the only honest answer; queueing the second would still
   * run a destructive replace nobody is waiting on.
   */
  private importInFlight = false;

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
  ) {}

  @Get('export-data')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Export all data from Data DB for migration' })
  @ApiResponse({ status: 200, description: 'Exported data as JSON' })
  async exportData(): Promise<{
    exportedAt: string;
    dataDbType: string;
    tables: MigrationTables;
    counts: {
      sessions: number;
      webhooks: number;
      messages: number;
      messageBatches: number;
      templates: number;
      baileysStoredMessages: number;
      lidMappings: number;
      pluginInstances: number;
      conversationMappings: number;
      ingressEvents: number;
      webhookDeliveryFailures: number;
      integrationDeliveryFailures: number;
      statusUpdates: number;
      automationRules: number;
    };
    /** Optional tables that were skipped because they genuinely do not exist in this DB (older schema). */
    skippedTables: string[];
  }> {
    // Get all entities from Data DB
    const sessions = await this.dataDataSource.query<SessionRow[]>('SELECT * FROM sessions');
    const webhooks = await this.dataDataSource.query<WebhookRow[]>('SELECT * FROM webhooks');

    // The tables below may legitimately not exist yet (created by migrations an older DB has not run).
    // Only a GENUINE missing-table error (isMissingTableError) may be tolerated — anything else (lock,
    // I/O, timeout, aborted connection) must FAIL the export. The old blind `catch { debug-log }`
    // pattern reported those as "table is empty", producing a 200 "complete" backup that was actually
    // partial — which the import then treated as authoritative and DELETEd the missing tables' rows.
    // A skipped table is surfaced in `skippedTables` (and logged as a warning) so an operator can tell
    // "not migrated yet" apart from "exported empty".
    const skippedTables: string[] = [];
    const queryOptionalTable = async <T>(table: string): Promise<T[]> => {
      try {
        return await this.dataDataSource.query<T[]>(`SELECT * FROM ${table}`);
      } catch (error) {
        if (!isMissingTableError(error)) throw error;
        skippedTables.push(table);
        this.logger.warn('Optional table does not exist in this DB; exporting without it', { table });
        return [];
      }
    };

    const messages = await queryOptionalTable<MessageRow>('messages');
    // Postgres carries a STORED generated tsvector column `body_ts` (FTS) that `SELECT *` picks up.
    // It is a server-maintained index artifact, not payload: strip it so backups stay dialect-neutral
    // (and small). The import's explicit column list already ignores it in older archives.
    for (const row of messages) {
      delete row.body_ts;
    }
    const messageBatches = await queryOptionalTable<MessageBatchRow>('message_batches');
    const templates = await queryOptionalTable<TemplateRow>('templates');
    const baileysStoredMessages = await queryOptionalTable<BaileysStoredMessageRow>('baileys_stored_messages');
    const lidMappings = await queryOptionalTable<LidMappingRow>('lid_mappings');
    // Integration Fabric + both DLQs were added after the original migration set; tolerate a genuinely
    // absent table (older DB) like the tables above rather than 500-ing the whole export.
    const pluginInstances = await queryOptionalTable<PluginInstanceRow>('plugin_instances');
    const conversationMappings = await queryOptionalTable<ConversationMappingRow>('conversation_mappings');
    const ingressEvents = await queryOptionalTable<IngressEventRow>('ingress_events');
    const webhookDeliveryFailures = await queryOptionalTable<WebhookDeliveryFailureRow>('webhook_delivery_failures');
    const integrationDeliveryFailures = await queryOptionalTable<IntegrationDeliveryFailureRow>(
      'integration_delivery_failures',
    );
    const statusUpdates = await queryOptionalTable<StatusUpdateRow>('status_updates');
    const automationRules = await queryOptionalTable<AutomationRuleRow>('automation_rules');

    const counts = {
      sessions: sessions.length,
      webhooks: webhooks.length,
      messages: messages.length,
      messageBatches: messageBatches.length,
      templates: templates.length,
      baileysStoredMessages: baileysStoredMessages.length,
      lidMappings: lidMappings.length,
      pluginInstances: pluginInstances.length,
      conversationMappings: conversationMappings.length,
      ingressEvents: ingressEvents.length,
      webhookDeliveryFailures: webhookDeliveryFailures.length,
      integrationDeliveryFailures: integrationDeliveryFailures.length,
      statusUpdates: statusUpdates.length,
      automationRules: automationRules.length,
    };

    // Audit the full-DB export: this payload carries webhook + plugin-instance secrets, so WHO pulled
    // a dump (and the per-table row counts) is exactly the trail C002 was missing. Data itself is never
    // logged — only counts.
    await this.auditService?.logInfo(AuditAction.INFRA_DATA_EXPORTED, { metadata: { counts } });

    return {
      exportedAt: new Date().toISOString(),
      dataDbType: this.configService.get<string>('dataDatabase.type', 'sqlite'),
      tables: {
        sessions,
        webhooks,
        messages,
        messageBatches,
        templates,
        baileysStoredMessages,
        lidMappings,
        pluginInstances,
        conversationMappings,
        ingressEvents,
        webhookDeliveryFailures,
        integrationDeliveryFailures,
        statusUpdates,
        automationRules,
      },
      counts,
      skippedTables,
    };
  }

  @Post('import-data')
  @HttpCode(HttpStatus.OK)
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Import data to Data DB (replaces existing data)' })
  @ApiBody({
    description: 'Exported data from export-data endpoint',
    schema: {
      type: 'object',
      properties: {
        force: {
          type: 'boolean',
          description:
            'Allow the replace to proceed even while engines are running for sessions the backup does not contain (they keep running until restart; see restartRequired). Prefer stopOrphans, which closes that window inside this request instead.',
        },
        stopOrphans: {
          type: 'boolean',
          description:
            'Stop the running engines for sessions the backup does not contain, inside this request and before the replace runs. Supersedes force for the orphan case: with stopOrphans the engines no longer need a process restart to reconcile, so restartRequired stays false on the success path.',
        },
        tables: {
          type: 'object',
          properties: {
            sessions: { type: 'array' },
            webhooks: { type: 'array' },
            messages: { type: 'array' },
            messageBatches: { type: 'array' },
            statusUpdates: { type: 'array' },
          },
        },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Data imported successfully' })
  @ApiResponse({
    status: 409,
    description:
      'Refused, with the reason in `code`. IMPORT_ALREADY_RUNNING: another import is running — wait for it. IMPORT_NESTED_TRANSACTION: another database transaction holds this connection, so a restore could not be made durable — retry with nothing else in flight. IMPORT_WOULD_ORPHAN_ENGINES: live engines exist for sessions the backup would remove — retry with stopOrphans=true to stop them in-request, or force=true to proceed and restart after. Only the last of these is retryable with stopOrphans; the others leave nothing to decide',
  })
  async importData(
    @Body()
    data: {
      tables: Partial<MigrationTables>;
      force?: boolean;
      /**
       * Stop the running engines for sessions the backup does not contain, inside this request and
       * before the replace runs (best-effort, time-bounded per engine). Supersedes force=true for the
       * orphan case: with stopOrphans the engines no longer need a process restart to reconcile, so
       * restartRequired stays false on the success path. Without it the pre-existing behavior holds —
       * refuse with 409, or proceed with force=true and leave the engines running until restart.
       */
      stopOrphans?: boolean;
    },
  ): Promise<{
    imported: boolean;
    counts: TableCounts;
    warnings: string[];
    /**
     * Non-fatal operator-facing messages (e.g. orphan-engine reconciliation details). Distinct from
     * warnings: notices never cause a rollback, while warnings make the replace-rollback gate fire.
     */
    notices: string[];
    /** True when live engines were left pointing at sessions this restore removed — restart to stop them. */
    restartRequired: boolean;
    /** Session ids with a running engine that the restored data no longer contains. */
    orphanedEngines: string[];
    /** Orphan engines stopped inside this request (only populated when stopOrphans=true was passed). */
    stoppedOrphanEngines: string[];
    /** Orphan engines whose teardown threw or timed out (Map reconciled regardless; investigate). */
    failedOrphanEngines: string[];
  }> {
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
    this.importInFlight = true;
    try {
      return await this.runImport(data);
    } finally {
      this.importInFlight = false;
    }
  }

  /** The replace-all restore itself. Only ever entered through importData's single-flight guard. */
  private async runImport(data: { tables: Partial<MigrationTables>; force?: boolean; stopOrphans?: boolean }): Promise<{
    imported: boolean;
    counts: TableCounts;
    warnings: string[];
    notices: string[];
    restartRequired: boolean;
    orphanedEngines: string[];
    stoppedOrphanEngines: string[];
    failedOrphanEngines: string[];
  }> {
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
      // Stop the orphans inside this request, BEFORE the transaction opens. destroyEngineSafely's
      // per-engine 10s deadline bounds the worst case (a stuck Chromium cannot wedge the import); the
      // engines are reconciled from the Map regardless of teardown outcome.
      const result = await this.sessionService.stopOrphanEngines(orphanedEngines);
      stoppedOrphanEngines = result.stopped;
      failedOrphanEngines = result.failed;
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
      // Engines still mid-initialization (no Map entry yet) are reported in notRunning: their start()
      // self-aborts via the stop mark, but they are not counted as stopped here.
      if (result.notRunning.length > 0) {
        notices.push(
          `${result.notRunning.length} orphan session(s) had no live engine yet (still initializing): ` +
            `${result.notRunning.join(', ')} — their start() will self-abort.`,
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

    // Everything from here is wrapped so the token cannot outlive this request. It is not enough to
    // release it in the transaction's own finally: createQueryRunner/connect/startTransaction sit
    // before that finally exists, so any throw there — a driver change, a broadcaster subscriber, a
    // failing BEGIN/SAVEPOINT — would strand it. Defence in depth rather than a reachable bug today,
    // and deliberately so: a leaked token disables loss detection for the lifetime of the process,
    // silently, which is strictly worse than the teardown the suspension prevents.
    try {
      const queryRunner = this.dataDataSource.createQueryRunner();
      await queryRunner.connect();

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
      if (queryRunner.isTransactionActive) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          message:
            'Another database transaction is in progress on this connection, so a restore could not be ' +
            'made durable. Retry with no other data operation in flight.',
          code: 'IMPORT_NESTED_TRANSACTION',
        });
      }

      // startTransaction is inside the runner's own try/finally, so a throw from it still releases
      // the runner instead of stranding it for the life of the process.
      await queryRunner.startTransaction();

      try {
        // Clear existing data (in correct order due to foreign keys). templates and
        // baileys_stored_messages FK sessions ON DELETE CASCADE, so the sessions DELETE would clear
        // them too; clearing them explicitly first keeps the order correct on engines where the
        // cascade is not enforced. Tolerate a genuinely-absent table (isMissingTableError) but let any
        // OTHER failure (lock, I/O, aborted tx) propagate to the transaction rollback below — a blind
        // `.catch(() => {})` here could otherwise silently commit a MERGED (not replaced) restore on
        // SQLite, violating the endpoint's "replaces existing data" contract.
        const clearTable = async (table: string): Promise<void> => {
          try {
            await queryRunner.query(`DELETE FROM ${table}`);
          } catch (err) {
            if (!isMissingTableError(err)) throw err;
            this.logger.debug('Skipped clearing a table that does not exist during import', { table });
          }
        };
        // The INSERTs below are written once, in Postgres' `$N` placeholder form. better-sqlite3 differs
        // from the legacy sqlite3 driver on raw queries in two ways: SQLite parses `$N` as a NAMED
        // parameter, which cannot be bound from the positional array TypeORM passes through (RangeError),
        // and strict binding rejects booleans/undefined — which a Postgres-made backup carries (real
        // booleans survive the JSON round-trip). Postgres needs `$N` and binds booleans natively, so both
        // rewrites apply only on the SQLite path. Safe: every `$N` below occurs once, in ascending order.
        const isPostgres = this.dataDataSource.options.type === 'postgres';
        const insert = (text: string, params: unknown[]): Promise<unknown> =>
          queryRunner.query(
            isPostgres ? text : text.replace(/\$\d+/g, '?'),
            isPostgres ? params : params.map(v => (typeof v === 'boolean' ? Number(v) : (v ?? null))),
          );
        await queryRunner.query('DELETE FROM webhooks');
        await clearTable('messages');
        await clearTable('message_batches');
        await clearTable('templates');
        await clearTable('baileys_stored_messages');
        // lid_mappings is not a FK to sessions, so the sessions DELETE below won't clear it; clear it
        // explicitly so a restore replaces the cache rather than colliding on existing lid PKs.
        await clearTable('lid_mappings');
        // Integration Fabric + both DLQs: none carry an FK constraint to sessions (sessionId is provenance),
        // so clearing them here before the sessions DELETE keeps the replace-semantics complete.
        await clearTable('plugin_instances');
        await clearTable('conversation_mappings');
        await clearTable('ingress_events');
        await clearTable('webhook_delivery_failures');
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

        await queryRunner.query('DELETE FROM sessions');

        // Restore table by table in TABLE_IMPORTERS order (FK-safe: sessions first). The descriptors
        // carry each table's INSERT text, param mapping, and per-row skip guard; a missing or empty
        // table keeps its 0 count and contributes no warnings.
        const counts = Object.fromEntries(TABLE_IMPORTERS.map(importer => [importer.key, 0] as const)) as TableCounts;
        for (const importer of TABLE_IMPORTERS) {
          const rows = data.tables[importer.key];
          if (!rows?.length) continue;
          for (const untypedRow of rows) {
            // `rows` was read from `data.tables[importer.key]`, so it holds exactly the row type this
            // descriptor's id/map/skip declare. That correlation is what the erased importer type
            // cannot carry, and this loop is the one place it is known — so the cast lives here rather
            // than at each of the three uses below.
            const row = untypedRow as never;
            const skipWarning = importer.skip?.(row);
            if (skipWarning != null) {
              warnings.push(skipWarning);
              continue;
            }
            try {
              await insert(importer.sql, importer.map(row));
              counts[importer.key]++;
            } catch (err) {
              warnings.push(
                `Failed to import ${importer.label} ${importer.id(row)}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        }

        // Re-apply the claims read before the DELETE, for ids that exist in both. This runs BEFORE the
        // all-or-nothing gate below on purpose: a failure here must take the same rollback the gate
        // already implements. Degrading it to a notice and committing anyway would be worse than the
        // bug it fixes — on PostgreSQL a failed statement aborts the transaction, so the COMMIT would
        // execute as a ROLLBACK and the endpoint would report a fully discarded import as a success,
        // with per-table counts, to an operator restoring after data loss.
        try {
          await restoreSessionOwnership(preservedOwnership, insert, ownershipReadAt);
        } catch (error) {
          warnings.push(
            `Failed to restore session ownership: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        // "Replace all data" must be all-or-nothing: the import already DELETEd every row, so if any
        // INSERT failed we must roll back (restoring the pre-import data) rather than commit a
        // half-wiped DB and report success. A partial restore reported as imported:true was how
        // message history could silently vanish on a SQLite->Postgres migration.
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

        // A wrong/empty/garbage backup file restores zero rows but the DELETE already ran — committing
        // would silently WIPE the database and report success. Refuse it and roll back instead. (#488 review)
        const totalRestored = Object.values(counts).reduce((sum, n) => sum + n, 0);
        if (totalRestored === 0) {
          await queryRunner.rollbackTransaction();
          return {
            imported: false,
            counts,
            warnings: ['Backup contained no rows to restore; refused to replace existing data. Check the file.'],
            notices,
            ...engineStateAfterRollback,
          };
        }

        await queryRunner.commitTransaction();

        // Runtime reconciliation, part 2 (post-commit): the in-memory lid->phone mirror was warmed from
        // the OLD lid_mappings rows and is write-through only, so the just-restored table would never
        // reach it — resolution would keep serving stale entries (and miss restored ones) until the next
        // process start. Reload from the new DB contents. Best-effort: a miss falls back to engine
        // re-resolution, so a reload failure degrades instead of failing the (already committed) import.
        await this.lidMappingStore?.reload();

        // Audit the destructive replace-all restore, only on the committed-success path (the rollback /
        // refused-empty branches above return without emitting, since no data actually changed). Any
        // warnings would have taken the rollback branch, so warnings.length is always 0 here — record
        // only the per-table counts.
        await this.auditService?.logInfo(AuditAction.INFRA_DATA_IMPORTED, { metadata: { counts } });

        // restartRequired was computed in the pre-flight: true only when orphans were left running
        // (force=true legacy path) or when stopOrphans teardown failed for at least one engine.
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
      } catch (error) {
        await queryRunner.rollbackTransaction();
        throw error;
      } finally {
        await queryRunner.release();
      }
    } finally {
      // Its own finally, so a throwing release() cannot strand the token either.
      resumeLossDetection?.();
    }
  }
}
