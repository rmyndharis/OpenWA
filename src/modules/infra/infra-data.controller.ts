import { Controller, Get, Post, Body, ConflictException, HttpCode, HttpStatus, Optional } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { RequireRole, RequireUnscopedKey } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { isSafeSessionName } from '../../common/utils/path-safety';
import { createLogger } from '../../common/services/logger.service';
import { isMissingTableError } from '../../common/utils/db-errors';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { SessionService } from '../session/session.service';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';

// Database migration types for export/import
interface SessionRow {
  id: string;
  name: string;
  status: string;
  phone: string | null;
  pushName: string | null;
  config: string | Record<string, unknown>;
  proxyUrl: string | null;
  proxyType: string | null;
  connectedAt: string | null;
  lastActiveAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface WebhookRow {
  id: string;
  sessionId: string;
  url: string;
  events: string | string[];
  secret: string | null;
  headers: string | Record<string, string>;
  filters: string | Record<string, unknown> | null;
  active: boolean | number;
  retryCount: number;
  lastTriggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// Shapes mirror the REAL table columns as returned by `SELECT *` (export-data), not the
// camelCase TypeORM entity properties. `messages` columns are the property names; `message_batches`
// columns are snake_case (the entity maps them via `name:`). Keeping these accurate is what keeps
// the import column lists below from drifting back into "no such column" failures.
interface MessageRow {
  id: string;
  sessionId: string;
  waMessageId: string | null;
  chatId: string;
  chatName: string | null;
  /** Group participant JID (nullable; added to messages after chatName — keep the import list in sync). */
  author: string | null;
  from: string;
  to: string;
  body: string | null;
  type: string;
  direction: string;
  timestamp: number | string | null;
  metadata: string | Record<string, unknown> | null;
  status: string;
  createdAt: string;
  /**
   * Postgres-only STORED generated tsvector (FTS). Present in `SELECT *` rows read from a Postgres
   * source (and in backups made before it was stripped) but never a real payload column: export drops
   * it, and the import's explicit column list ignores it. Declared so both directions type-check.
   */
  body_ts?: unknown;
}

interface MessageBatchRow {
  id: string;
  batch_id: string;
  session_id: string;
  status: string;
  messages: string | unknown[];
  options: string | Record<string, unknown> | null;
  progress: string | Record<string, unknown> | null;
  results: string | unknown[] | null;
  current_index: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

// templates + baileys_stored_messages both FK sessions ON DELETE CASCADE, so import's
// `DELETE FROM sessions` wipes them; they must be exported and re-inserted or the documented
// backup flow loses them permanently.
interface TemplateRow {
  id: string;
  sessionId: string;
  name: string;
  body: string;
  header: string | null;
  footer: string | null;
  createdAt: string;
  updatedAt: string;
}

interface BaileysStoredMessageRow {
  id: string;
  sessionId: string;
  waMessageId: string;
  serializedMessage: string;
  createdAt: string;
}

// The persisted lid->phone resolution cache. Not a FK to sessions (provenance only), so the import's
// `DELETE FROM sessions` never clears it — it must be exported + re-inserted explicitly or a
// backup→restore into a fresh DB loses the whole cache (it self-heals via re-lookup, but lossily).
interface LidMappingRow {
  lid: string;
  phone: string | null;
  sessionId: string | null;
  updatedAt: string;
}

interface PluginInstanceRow {
  id: string;
  pluginId: string;
  instanceId: string;
  sessionScope: string | null;
  secret: string;
  verifyToken: string | null;
  config: string | Record<string, unknown> | null;
  enabled: boolean | number;
  createdAt: string;
  updatedAt: string;
}

interface ConversationMappingRow {
  id: string;
  sessionId: string;
  chatId: string;
  pluginId: string;
  instanceId: string;
  providerConversationId: string;
  handoverState: string;
  metadata: string | Record<string, unknown> | null;
  updatedAt: string;
}

interface IngressEventRow {
  id: string;
  instanceId: string;
  pluginId: string;
  providerDeliveryId: string;
  route: string;
  // Retired to NULL once the dispatch outcome is recorded; only 'pending' rows still carry one.
  payload: string | Record<string, unknown> | null;
  payloadHash?: string | null;
  // Dispatch lifecycle (the AddIngressEventDispatchState migration). A restored 'pending' row must
  // keep these or the reconciler never replays it while the dedup row still blocks the provider's
  // retry. Optional because backups exported before the columns existed don't carry them.
  dispatchState?: 'pending' | 'dispatched' | 'failed' | null;
  dispatchAttempts?: number;
  lastDispatchAt?: string | null;
  sessionId: string | null;
  createdAt: string;
}

interface WebhookDeliveryFailureRow {
  id: string;
  webhookId: string;
  sessionId: string;
  event: string;
  url: string;
  idempotencyKey: string | null;
  deliveryId: string | null;
  attempts: number;
  lastStatusCode: number | null;
  lastError: string;
  createdAt: string;
}

interface IntegrationDeliveryFailureRow {
  id: string;
  direction: string;
  pluginId: string;
  instanceId: string;
  sessionId: string | null;
  deliveryId: string | null;
  attempts: number;
  lastError: string;
  payload: string | Record<string, unknown> | null;
  redriven: boolean | number;
  createdAt: string;
}

// status_updates has no FK to sessions (plain columns), so the import's `DELETE FROM sessions` never
// clears it — it must be exported + re-inserted explicitly like lid_mappings. postedAt/expiresAt are
// bigint epoch-ms: raw queries bypass the entity transformer, so Postgres returns them as strings.
interface StatusUpdateRow {
  id: string;
  sessionId: string;
  contactJid: string;
  contactName: string | null;
  contactPushName: string | null;
  waStatusId: string;
  type: string;
  caption: string | null;
  mediaPath: string | null;
  mediaMimetype: string | null;
  mediaOmitted: boolean | number;
  omitReason: string | null;
  backgroundColor: string | null;
  font: number | null;
  postedAt: number | string;
  expiresAt: number | string;
}

interface MigrationTables {
  sessions: SessionRow[];
  webhooks: WebhookRow[];
  messages: MessageRow[];
  messageBatches: MessageBatchRow[];
  templates: TemplateRow[];
  baileysStoredMessages: BaileysStoredMessageRow[];
  lidMappings: LidMappingRow[];
  pluginInstances: PluginInstanceRow[];
  conversationMappings: ConversationMappingRow[];
  ingressEvents: IngressEventRow[];
  webhookDeliveryFailures: WebhookDeliveryFailureRow[];
  integrationDeliveryFailures: IntegrationDeliveryFailureRow[];
  statusUpdates: StatusUpdateRow[];
}

type TableCounts = { [K in keyof MigrationTables]: number };

// A per-table restore step for importData: which backup key to read, the exact INSERT text (kept in
// Postgres' `$N` placeholder form; the insert() helper rewrites it for SQLite), the param mapping,
// and an optional per-row skip guard. key/label/id also drive the counts object and the failure
// warnings, so the import loop below stays table-agnostic.
interface TableImporter<K extends keyof MigrationTables = keyof MigrationTables> {
  key: K;
  /** Singular noun used in the per-row failure warning: `Failed to import <label> <id>: <err>`. */
  label: string;
  /** Full INSERT ... VALUES ($1, ...) text, verbatim per table. */
  sql: string;
  /** The id interpolated into the failure warning (lid_mappings rows key on lid, not id). */
  id: (row: MigrationTables[K][number]) => string;
  map: (row: MigrationTables[K][number]) => unknown[];
  /** Per-row veto: returns the warning to record (the row is skipped) or null to import the row. */
  skip?: (row: MigrationTables[K][number]) => string | null;
}

// Registers one concrete descriptor into the union-keyed TABLE_IMPORTERS array. The return type
// widens the row-specific id/map/skip to the union of all row types; sound because the import loop
// only ever feeds a descriptor rows read from data.tables[its own key].
function defineTableImporter<K extends keyof MigrationTables>(importer: TableImporter<K>): TableImporter {
  return importer;
}

// Restore order is FK order: sessions first (webhooks/messages/templates/etc. reference it), the
// standalone cache/DLQ tables after. The per-block comments from the former inline import blocks
// live on their descriptor entries.
const TABLE_IMPORTERS: TableImporter[] = [
  // Import sessions first
  defineTableImporter({
    key: 'sessions',
    label: 'session',
    sql: `INSERT INTO sessions (id, name, status, phone, "pushName", config, "proxyUrl", "proxyType", "connectedAt", "lastActiveAt", "createdAt", "updatedAt") 
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    id: (session: SessionRow) => session.id,
    // A session name becomes the engine auth-directory key, so an unvalidated imported name (this
    // path bypasses CreateSessionDto) could traverse the filesystem. Skip + warn instead of
    // throwing, so one bad row doesn't 500 the whole restore.
    skip: (session: SessionRow) => {
      if (isSafeSessionName(session.name)) return null;
      return `Skipped session ${session.id}: unsafe name ${JSON.stringify(session.name)}`;
    },
    map: (session: SessionRow) => [
      session.id,
      session.name,
      session.status,
      session.phone,
      session.pushName,
      typeof session.config === 'string' ? session.config : JSON.stringify(session.config || {}),
      session.proxyUrl,
      session.proxyType,
      session.connectedAt,
      session.lastActiveAt,
      session.createdAt,
      session.updatedAt,
    ],
  }),

  // Import webhooks
  defineTableImporter({
    key: 'webhooks',
    label: 'webhook',
    sql: `INSERT INTO webhooks (id, "sessionId", url, events, secret, headers, filters, active, "retryCount", "lastTriggeredAt", "createdAt", "updatedAt")
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    id: (webhook: WebhookRow) => webhook.id,
    map: (webhook: WebhookRow) => [
      webhook.id,
      webhook.sessionId,
      webhook.url,
      typeof webhook.events === 'string' ? webhook.events : JSON.stringify(webhook.events || []),
      webhook.secret,
      typeof webhook.headers === 'string' ? webhook.headers : JSON.stringify(webhook.headers || {}),
      webhook.filters == null
        ? null
        : typeof webhook.filters === 'string'
          ? webhook.filters
          : JSON.stringify(webhook.filters),
      webhook.active,
      webhook.retryCount,
      webhook.lastTriggeredAt,
      webhook.createdAt,
      webhook.updatedAt,
    ],
  }),

  // Import messages (optional)
  defineTableImporter({
    key: 'messages',
    label: 'message',
    sql: `INSERT INTO messages (id, "sessionId", "waMessageId", "chatId", "chatName", author, "from", "to", body, type, direction, "timestamp", metadata, status, "createdAt")
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    id: (msg: MessageRow) => msg.id,
    map: (msg: MessageRow) => [
      msg.id,
      msg.sessionId,
      msg.waMessageId ?? null,
      msg.chatId,
      msg.chatName ?? null,
      // Rows exported before the author column existed simply restore to NULL (legacy
      // behavior) instead of failing the whole import on an unknown key.
      msg.author ?? null,
      msg.from,
      msg.to,
      msg.body ?? null,
      msg.type,
      msg.direction,
      msg.timestamp ?? null,
      msg.metadata == null ? null : typeof msg.metadata === 'string' ? msg.metadata : JSON.stringify(msg.metadata),
      msg.status,
      msg.createdAt,
    ],
  }),

  // Import message batches (optional)
  defineTableImporter({
    key: 'messageBatches',
    label: 'message batch',
    sql: `INSERT INTO message_batches (id, batch_id, session_id, status, messages, options, progress, results, current_index, created_at, updated_at, started_at, completed_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    id: (batch: MessageBatchRow) => batch.id,
    map: (batch: MessageBatchRow) => [
      batch.id,
      batch.batch_id,
      batch.session_id,
      batch.status,
      typeof batch.messages === 'string' ? batch.messages : JSON.stringify(batch.messages ?? []),
      batch.options == null ? null : typeof batch.options === 'string' ? batch.options : JSON.stringify(batch.options),
      batch.progress == null
        ? null
        : typeof batch.progress === 'string'
          ? batch.progress
          : JSON.stringify(batch.progress),
      batch.results == null ? null : typeof batch.results === 'string' ? batch.results : JSON.stringify(batch.results),
      batch.current_index,
      batch.created_at,
      batch.updated_at,
      batch.started_at,
      batch.completed_at,
    ],
  }),

  // Import templates (optional; FK -> sessions, restored above)
  defineTableImporter({
    key: 'templates',
    label: 'template',
    sql: `INSERT INTO templates (id, "sessionId", name, body, header, footer, "createdAt", "updatedAt")
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    id: (tpl: TemplateRow) => tpl.id,
    map: (tpl: TemplateRow) => [
      tpl.id,
      tpl.sessionId,
      tpl.name,
      tpl.body,
      tpl.header ?? null,
      tpl.footer ?? null,
      tpl.createdAt,
      tpl.updatedAt,
    ],
  }),

  // Import baileys stored messages (optional; FK -> sessions, restored above)
  defineTableImporter({
    key: 'baileysStoredMessages',
    label: 'baileys stored message',
    sql: `INSERT INTO baileys_stored_messages (id, "sessionId", "waMessageId", "serializedMessage", "createdAt")
               VALUES ($1, $2, $3, $4, $5)`,
    id: (bsm: BaileysStoredMessageRow) => bsm.id,
    map: (bsm: BaileysStoredMessageRow) => [
      bsm.id,
      bsm.sessionId,
      bsm.waMessageId,
      bsm.serializedMessage,
      bsm.createdAt,
    ],
  }),

  // Import lid mappings (optional; not a FK, restored as a standalone cache table)
  defineTableImporter({
    key: 'lidMappings',
    label: 'lid mapping',
    sql: `INSERT INTO lid_mappings (lid, phone, "sessionId", "updatedAt") VALUES ($1, $2, $3, $4)`,
    id: (lm: LidMappingRow) => lm.lid,
    map: (lm: LidMappingRow) => [lm.lid, lm.phone ?? null, lm.sessionId ?? null, lm.updatedAt],
  }),

  // Import plugin instances (Integration Fabric config + ingress HMAC secret)
  defineTableImporter({
    key: 'pluginInstances',
    label: 'plugin instance',
    sql: `INSERT INTO plugin_instances (id, "pluginId", "instanceId", "sessionScope", secret, "verifyToken", config, enabled, "createdAt", "updatedAt")
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    id: (pi: PluginInstanceRow) => pi.id,
    map: (pi: PluginInstanceRow) => [
      pi.id,
      pi.pluginId,
      pi.instanceId,
      pi.sessionScope,
      pi.secret,
      pi.verifyToken,
      pi.config == null ? null : typeof pi.config === 'string' ? pi.config : JSON.stringify(pi.config),
      pi.enabled,
      pi.createdAt,
      pi.updatedAt,
    ],
  }),

  // Import conversation mappings (handover state; sessionId is non-FK provenance)
  defineTableImporter({
    key: 'conversationMappings',
    label: 'conversation mapping',
    sql: `INSERT INTO conversation_mappings (id, "sessionId", "chatId", "pluginId", "instanceId", "providerConversationId", "handoverState", metadata, "updatedAt")
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    id: (cm: ConversationMappingRow) => cm.id,
    map: (cm: ConversationMappingRow) => [
      cm.id,
      cm.sessionId,
      cm.chatId,
      cm.pluginId,
      cm.instanceId,
      cm.providerConversationId,
      cm.handoverState,
      cm.metadata == null ? null : typeof cm.metadata === 'string' ? cm.metadata : JSON.stringify(cm.metadata),
      cm.updatedAt,
    ],
  }),

  // Import ingress events (durable inbound dedup oracle; payload is JSON). The dispatch-lifecycle
  // columns ride along: dropping them would strand a restored 'pending' row (NULL dispatchState is
  // never swept by the reconciler) while its dedup key still blocks the provider's retry. Columns
  // absent from a pre-lifecycle backup import as NULL/0 — the same "not watched" reading legacy
  // rows have by design. dispatchAttempts is NOT NULL, so it coalesces to 0 rather than NULL.
  defineTableImporter({
    key: 'ingressEvents',
    label: 'ingress event',
    sql: `INSERT INTO ingress_events (id, "instanceId", "pluginId", "providerDeliveryId", route, payload, "payloadHash", "sessionId", "dispatchState", "dispatchAttempts", "lastDispatchAt", "createdAt")
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    id: (ie: IngressEventRow) => ie.id,
    map: (ie: IngressEventRow) => [
      ie.id,
      ie.instanceId,
      ie.pluginId,
      ie.providerDeliveryId,
      ie.route,
      // A retired (NULL) payload must stay NULL — re-materializing it as '{}' would make a
      // slimmed dedup row read as a pending event with an empty body.
      ie.payload == null ? null : typeof ie.payload === 'string' ? ie.payload : JSON.stringify(ie.payload),
      ie.payloadHash ?? null,
      ie.sessionId,
      ie.dispatchState ?? null,
      ie.dispatchAttempts ?? 0,
      ie.lastDispatchAt ?? null,
      ie.createdAt,
    ],
  }),

  // Import webhook delivery failures (webhook DLQ)
  defineTableImporter({
    key: 'webhookDeliveryFailures',
    label: 'webhook delivery failure',
    sql: `INSERT INTO webhook_delivery_failures (id, "webhookId", "sessionId", event, url, "idempotencyKey", "deliveryId", attempts, "lastStatusCode", "lastError", "createdAt")
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    id: (wf: WebhookDeliveryFailureRow) => wf.id,
    map: (wf: WebhookDeliveryFailureRow) => [
      wf.id,
      wf.webhookId,
      wf.sessionId,
      wf.event,
      wf.url,
      wf.idempotencyKey,
      wf.deliveryId,
      wf.attempts,
      wf.lastStatusCode,
      wf.lastError,
      wf.createdAt,
    ],
  }),

  // Import integration delivery failures (inbound + outbound DLQ)
  defineTableImporter({
    key: 'integrationDeliveryFailures',
    label: 'integration delivery failure',
    sql: `INSERT INTO integration_delivery_failures (id, direction, "pluginId", "instanceId", "sessionId", "deliveryId", attempts, "lastError", payload, redriven, "createdAt")
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    id: (df: IntegrationDeliveryFailureRow) => df.id,
    map: (df: IntegrationDeliveryFailureRow) => [
      df.id,
      df.direction,
      df.pluginId,
      df.instanceId,
      df.sessionId,
      df.deliveryId,
      df.attempts,
      df.lastError,
      df.payload == null ? null : typeof df.payload === 'string' ? df.payload : JSON.stringify(df.payload),
      df.redriven,
      df.createdAt,
    ],
  }),

  // Import status updates (24h-TTL status/story store; sessionId is non-FK provenance)
  defineTableImporter({
    key: 'statusUpdates',
    label: 'status update',
    sql: `INSERT INTO status_updates (id, "sessionId", "contactJid", "contactName", "contactPushName", "waStatusId", type, caption, "mediaPath", "mediaMimetype", "mediaOmitted", "omitReason", "backgroundColor", font, "postedAt", "expiresAt")
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
    id: (su: StatusUpdateRow) => su.id,
    map: (su: StatusUpdateRow) => [
      su.id,
      su.sessionId,
      su.contactJid,
      su.contactName ?? null,
      su.contactPushName ?? null,
      su.waStatusId,
      su.type,
      su.caption ?? null,
      su.mediaPath ?? null,
      su.mediaMimetype ?? null,
      su.mediaOmitted ?? false,
      su.omitReason ?? null,
      su.backgroundColor ?? null,
      su.font ?? null,
      su.postedAt,
      su.expiresAt,
    ],
  }),
];

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
