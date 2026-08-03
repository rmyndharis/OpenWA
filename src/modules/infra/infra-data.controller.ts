import { Controller, Get, Post, Body, ConflictException, HttpCode, HttpStatus, Optional } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { RequireRole, RequireUnscopedKey } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { createLogger } from '../../common/services/logger.service';
import { isMissingTableError } from '../../common/utils/db-errors';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { SessionService } from '../session/session.service';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
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
} from './migration-tables.types';
import { TABLE_IMPORTERS } from './table-importers';

@ApiTags('infrastructure')
@Controller('infra')
// Every route here is deployment-global (data export/import, infra config, service orchestration),
// so the guard's route-param session fence can never bite. Reject session-scoped keys outright at
// class level, which also covers routes added later. @Public routes are unaffected: the guard
// returns before it reads this metadata.
@RequireUnscopedKey()
export class InfraDataController {
  private readonly logger = createLogger('InfraDataController');

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
      'Refused: live engines exist for sessions the backup would remove (retry with stopOrphans=true to stop them in-request, or force=true to proceed and restart after)',
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
      throw new ConflictException(
        `Import would orphan ${orphanedEngines.length} running engine(s) for session(s) ` +
          `${orphanedEngines.join(', ')} that the backup does not contain. Stop them first, retry with ` +
          `stopOrphans=true (stops them inside this request), or retry with force=true ` +
          `(a server restart is then required to stop the orphaned engines).`,
      );
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

    const queryRunner = this.dataDataSource.createQueryRunner();
    await queryRunner.connect();
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
      await queryRunner.query('DELETE FROM sessions');

      // Restore table by table in TABLE_IMPORTERS order (FK-safe: sessions first). The descriptors
      // carry each table's INSERT text, param mapping, and per-row skip guard; a missing or empty
      // table keeps its 0 count and contributes no warnings.
      const counts = Object.fromEntries(TABLE_IMPORTERS.map(importer => [importer.key, 0] as const)) as TableCounts;
      for (const importer of TABLE_IMPORTERS) {
        const rows = data.tables[importer.key];
        if (!rows?.length) continue;
        for (const row of rows) {
          const skipWarning = importer.skip?.(row);
          if (skipWarning != null) {
            warnings.push(skipWarning);
            continue;
          }
          try {
            await insert(importer.sql, importer.map(row));
            counts[importer.key]++;
          } catch (err) {
            warnings.push(`Failed to import ${importer.label} ${importer.id(row)}: ${err}`);
          }
        }
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
  }
}
