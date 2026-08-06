// Database migration types for export/import
export interface SessionRow {
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

export interface WebhookRow {
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
export interface MessageRow {
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
   * Chat-media archive pointers (nullable; added after author — keep the import list in sync).
   * Dropping these on import would leave the archived FILES restored but unreferenced, and the
   * orphan sweep would then delete them after its grace window.
   */
  mediaPath: string | null;
  mediaMimetype: string | null;
  /**
   * Postgres-only STORED generated tsvector (FTS). Present in `SELECT *` rows read from a Postgres
   * source (and in backups made before it was stripped) but never a real payload column: export drops
   * it, and the import's explicit column list ignores it. Declared so both directions type-check.
   */
  body_ts?: unknown;
}

export interface MessageBatchRow {
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
export interface TemplateRow {
  id: string;
  sessionId: string;
  name: string;
  body: string;
  header: string | null;
  footer: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BaileysStoredMessageRow {
  id: string;
  sessionId: string;
  waMessageId: string;
  serializedMessage: string;
  createdAt: string;
}

// The persisted lid->phone resolution cache. Not a FK to sessions (provenance only), so the import's
// `DELETE FROM sessions` never clears it — it must be exported + re-inserted explicitly or a
// backup→restore into a fresh DB loses the whole cache (it self-heals via re-lookup, but lossily).
export interface LidMappingRow {
  lid: string;
  phone: string | null;
  sessionId: string | null;
  updatedAt: string;
}

export interface PluginInstanceRow {
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

export interface ConversationMappingRow {
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

export interface IngressEventRow {
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

export interface WebhookDeliveryFailureRow {
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

export interface IntegrationDeliveryFailureRow {
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
export interface StatusUpdateRow {
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

/**
 * automation_rules has an ON DELETE CASCADE FK to sessions, so the import's `DELETE FROM sessions`
 * takes every rule with it — on SQLite too, where better-sqlite3 enforces foreign keys. Exporting
 * and re-inserting it is therefore not optional: without it a backup/restore silently destroys
 * every autoreply rule. `conditions` is stored as text (the webhook-filter JSON), `enabled` reads
 * back as a boolean on Postgres and 0/1 on SQLite.
 */
export interface AutomationRuleRow {
  id: string;
  sessionId: string;
  name: string;
  enabled: boolean | number;
  conditions: string | null;
  replyText: string;
  cooldownSeconds: number;
  createdAt: string | Date;
  updatedAt: string | Date;
}

export interface MigrationTables {
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
  automationRules: AutomationRuleRow[];
}

export type TableCounts = { [K in keyof MigrationTables]: number };
