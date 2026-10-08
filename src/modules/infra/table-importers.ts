import { NulFreeTransformer } from '../../common/transformers/nul-free.transformer';
import { isSafeSessionName } from '../../common/utils/path-safety';
import { collectFilterErrors } from '../webhook/filters/filter-validation';
import type {
  MigrationTables,
  SessionRow,
  WebhookRow,
  MessageRow,
  MessageBatchRow,
  TemplateRow,
  BaileysStoredMessageRow,
  LidMappingRow,
  ChatStateRow,
  PluginInstanceRow,
  ConversationMappingRow,
  IngressEventRow,
  WebhookDeliveryFailureRow,
  WebhookOutboxEventRow,
  IntegrationDeliveryFailureRow,
  StatusUpdateRow,
  AutomationRuleRow,
} from './migration-tables.types';

// A per-table restore step for importData: which backup key to read, the exact INSERT text (kept in
// Postgres' `$N` placeholder form; the insert() helper rewrites it for SQLite), the param mapping,
// and an optional per-row skip guard. key/label/id also drive the counts object and the failure
// warnings, so the import loop below stays table-agnostic.
export interface TableImporter<K extends keyof MigrationTables = keyof MigrationTables> {
  key: K;
  /** Singular noun used in the per-row failure warning: `Failed to import <label> <id>: <err>`. */
  label: string;
  /** Full INSERT ... VALUES ($1, ...) text, verbatim per table. */
  sql: string;
  /** The id interpolated into the failure warning (lid_mappings rows key on lid, not id). */
  id: (row: MigrationTables[K][number]) => string;
  map: (row: MigrationTables[K][number]) => unknown[];
  /**
   * Per-row veto: returns the warning to record (the row is skipped) or null to import the row.
   * `rows` is the whole archived table, for a guard that weighs a row against its siblings.
   */
  skip?: (row: MigrationTables[K][number], rows?: MigrationTables[K]) => string | null;
}

/**
 * A registered importer with its row type erased, which is what the union-keyed TABLE_IMPORTERS
 * array holds. The row-consuming members take `never` rather than the union of every row type: a
 * holder of the erased form cannot know which row type a given descriptor wants, and `never` is the
 * only parameter type that every concrete `TableImporter<K>` can be assigned to. Soundness comes
 * from the import loop, which only ever hands a descriptor rows read from `data.tables[its key]`.
 */
export type AnyTableImporter = Omit<TableImporter, 'id' | 'map' | 'skip'> & {
  id: (row: never) => string;
  map: (row: never) => unknown[];
  skip?: (row: never, rows?: never) => string | null;
};

// Registers one concrete descriptor into the union-keyed TABLE_IMPORTERS array.
function defineTableImporter<K extends keyof MigrationTables>(importer: TableImporter<K>): AnyTableImporter {
  return importer;
}

// A JSON column arrives decoded from Postgres and as text from SQLite. Text that does not parse is
// returned as-is, so a validator sees a string and refuses it rather than reading it as absent.
function decodeJsonColumn(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

// The entity columns that drop U+0000 do it in a TypeORM transformer, which raw SQL never runs. An
// older SQLite backup may still hold one, and PostgreSQL refuses it in a bound parameter, failing the
// whole restore. Apply the same drop here, to those same free-text columns and to the template and
// rule text the DTOs only refuse from 0.24.0 on; never to an id or a lookup key. A template name is the
// exception: no request can look up a name holding NUL, so keeping it would only strand the template.
function nulFree(value: unknown): unknown {
  return NulFreeTransformer.to(value);
}

/** Apply the terminal index's keeper order to archives created before that index existed. */
export function deduplicateArchivedWebhookFailures(rows: WebhookDeliveryFailureRow[]): WebhookDeliveryFailureRow[] {
  const owners = new Map<string, WebhookDeliveryFailureRow>();
  const identity = (row: WebhookDeliveryFailureRow): string => JSON.stringify([row.webhookId, row.idempotencyKey]);
  // SQLite's zone-less datetime strings represent UTC, just like PostgreSQL's explicit UTC exports.
  const timestamp = (value: string): number =>
    new Date(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value) ? `${value.replace(' ', 'T')}Z` : value,
    ).getTime();
  // Malformed archive rows must still reach the normal all-or-nothing restore checks.
  const eligible = (row: WebhookDeliveryFailureRow): boolean =>
    row.attempts > 0 &&
    row.idempotencyKey != null &&
    [row.id, row.webhookId, row.sessionId, row.event, row.url, row.lastError, row.createdAt].every(
      value => value != null,
    );
  for (const row of rows) {
    if (!eligible(row)) continue;
    const key = identity(row);
    const previous = owners.get(key);
    if (!previous) {
      owners.set(key, row);
      continue;
    }
    const rank =
      Number(row.payload == null) - Number(previous.payload == null) ||
      previous.attempts - row.attempts ||
      timestamp(previous.createdAt) - timestamp(row.createdAt) ||
      (row.id === previous.id ? 0 : row.id > previous.id ? -1 : 1);
    if (rank < 0) owners.set(key, row);
  }
  return rows.filter(row => !eligible(row) || owners.get(identity(row)) === row);
}

// (sessionId, NUL-free name) -> id of the first archived template holding it, built once per table.
const templateNameOwners = new WeakMap<TemplateRow[], Map<string, string>>();

function firstTemplateWithName(rows: TemplateRow[], sessionId: string, name: unknown): string | undefined {
  let owners = templateNameOwners.get(rows);
  if (!owners) {
    owners = new Map();
    for (const row of rows) {
      const key = JSON.stringify([row.sessionId, nulFree(row.name)]);
      if (!owners.has(key)) owners.set(key, row.id);
    }
    templateNameOwners.set(rows, owners);
  }
  return owners.get(JSON.stringify([sessionId, name]));
}

// Restore order is FK order: sessions first (webhooks/messages/templates/etc. reference it), the
// standalone cache/DLQ tables after. The per-block comments from the former inline import blocks
// live on their descriptor entries.
export const TABLE_IMPORTERS: AnyTableImporter[] = [
  // Import sessions first
  defineTableImporter({
    key: 'sessions',
    label: 'session',
    sql: `INSERT INTO sessions (id, name, status, phone, "pushName", config, "proxyUrl", "proxyType", "connectedAt", "lastActiveAt", "createdAt", "updatedAt", "desiredState")
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    id: (session: SessionRow) => session.id,
    // Both columns reach an auth-directory path: the id keys the directory itself, and the name is
    // still weighed against it (the boot migration and the legacy purge on delete). An unvalidated
    // imported value (this path bypasses CreateSessionDto) could traverse the filesystem, and an
    // unsafe id would only surface later as a refused start. Skip + warn instead of throwing, so one
    // bad row doesn't 500 the whole restore.
    skip: (session: SessionRow) => {
      if (!isSafeSessionName(session.id)) {
        return `Skipped session ${JSON.stringify(session.id)}: unsafe id`;
      }
      if (isSafeSessionName(session.name)) return null;
      return `Skipped session ${session.id}: unsafe name ${JSON.stringify(session.name)}`;
    },
    map: (session: SessionRow) => [
      session.id,
      session.name,
      session.status,
      session.phone,
      nulFree(session.pushName),
      typeof session.config === 'string' ? session.config : JSON.stringify(session.config || {}),
      session.proxyUrl,
      session.proxyType,
      session.connectedAt,
      session.lastActiveAt,
      session.createdAt,
      session.updatedAt,
      // 'stopped' is the only value the column holds. A backup written before the column existed,
      // or an unknown value, restores as NULL: eligible for auto-start and takeover, as before.
      session.desiredState === 'stopped' ? 'stopped' : null,
    ],
  }),

  // Import webhooks
  defineTableImporter({
    key: 'webhooks',
    label: 'webhook',
    sql: `INSERT INTO webhooks (id, "sessionId", url, events, secret, headers, filters, active, "retryCount", "lastTriggeredAt", "createdAt", "updatedAt")
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    id: (webhook: WebhookRow) => webhook.id,
    // This path bypasses CreateWebhookDto. Dispatch reads a filters value without a conditions array
    // as "no filtering", so a malformed one stored verbatim would deliver every subscribed event, and
    // an events value that is not a list never fires at all. Veto the row with a warning, like the
    // sessions guard; any warning rolls the restore back and names the row.
    skip: (webhook: WebhookRow) => {
      const events = decodeJsonColumn(webhook.events ?? []);
      if (!Array.isArray(events) || !events.every(event => typeof event === 'string')) {
        return `Skipped webhook ${webhook.id}: events is not a list of event names`;
      }
      const filterErrors = collectFilterErrors(decodeJsonColumn(webhook.filters));
      if (filterErrors.length === 0) return null;
      return `Skipped webhook ${webhook.id}: invalid filters (${filterErrors.join('; ')})`;
    },
    map: (webhook: WebhookRow) => [
      webhook.id,
      webhook.sessionId,
      webhook.url,
      typeof webhook.events === 'string' ? webhook.events : JSON.stringify(webhook.events || []),
      // Rows exported after credential redaction (and hand-trimmed archives) carry no secret at
      // all — restore those as unsigned rather than failing the row on a missing key.
      webhook.secret ?? null,
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
    sql: `INSERT INTO messages (id, "sessionId", "waMessageId", "chatId", "chatName", author, "from", "to", body, type, direction, "timestamp", metadata, status, "createdAt", "mediaPath", "mediaMimetype")
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
    id: (msg: MessageRow) => msg.id,
    map: (msg: MessageRow) => [
      msg.id,
      msg.sessionId,
      msg.waMessageId ?? null,
      msg.chatId,
      nulFree(msg.chatName ?? null),
      // Rows exported before the author column existed simply restore to NULL (legacy
      // behavior) instead of failing the whole import on an unknown key.
      msg.author ?? null,
      msg.from,
      msg.to,
      nulFree(msg.body ?? null),
      msg.type,
      msg.direction,
      msg.timestamp ?? null,
      msg.metadata == null ? null : typeof msg.metadata === 'string' ? msg.metadata : JSON.stringify(msg.metadata),
      msg.status,
      msg.createdAt,
      // Archives predating the chat-media columns restore to NULL, same as author above. Carrying
      // them matters because the media FILES ride along in the storage export: restoring the rows
      // without their pointers would turn every archived file into an orphan the sweep then reaps.
      msg.mediaPath ?? null,
      nulFree(msg.mediaMimetype ?? null),
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
    // (sessionId, name) is unique, and the name loses its NUL characters below. Two names of one
    // session that differ only by NUL would collide on insert and roll the whole restore back, after
    // any orphan engines were stopped; refuse the second one here instead, naming both rows.
    skip: (tpl: TemplateRow, rows: TemplateRow[] = []) => {
      const name = nulFree(tpl.name);
      const owner = firstTemplateWithName(rows, tpl.sessionId, name);
      if (owner === undefined || owner === tpl.id) return null;
      return `Skipped template ${tpl.id}: name ${JSON.stringify(name)} without NUL characters collides with template ${owner} of session ${tpl.sessionId}`;
    },
    map: (tpl: TemplateRow) => [
      tpl.id,
      tpl.sessionId,
      nulFree(tpl.name),
      nulFree(tpl.body),
      nulFree(tpl.header ?? null),
      nulFree(tpl.footer ?? null),
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

  // Import chat states (optional; not a FK, restored as a standalone per-session cache table)
  defineTableImporter({
    key: 'chatStates',
    label: 'chat state',
    sql: `INSERT INTO chat_states ("sessionId", "chatId", "muteEndTime", archived, pinned, observed, "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    id: (cs: ChatStateRow) => `${cs.sessionId}/${cs.chatId}`,
    map: (cs: ChatStateRow) => [
      cs.sessionId,
      cs.chatId,
      cs.muteEndTime ?? null,
      cs.archived,
      cs.pinned,
      cs.observed ?? null,
      cs.updatedAt,
    ],
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
      nulFree(wf.lastError),
      wf.createdAt,
    ],
  }),

  // Import the outbound delivery record. Restoring it restores the replay backlog: a 'pending'
  // row still carries its payload, so the reconciler on the target instance picks up where the
  // source left off.
  defineTableImporter({
    key: 'webhookOutboxEvents',
    label: 'webhook outbox event',
    sql: `INSERT INTO webhook_outbox_events (id, "webhookId", "sessionId", event, "idempotencyKey", "deliveryId", payload, state, attempts, "lastAttemptAt", "createdAt")
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    id: (row: WebhookOutboxEventRow) => row.id,
    map: (row: WebhookOutboxEventRow) => [
      row.id,
      row.webhookId,
      row.sessionId,
      row.event,
      row.idempotencyKey,
      row.deliveryId,
      row.payload == null ? null : typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload),
      row.state,
      row.attempts,
      row.lastAttemptAt,
      row.createdAt,
    ],
  }),

  // Import integration delivery failures (inbound DLQ; direction restored as stored)
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
      nulFree(df.lastError),
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
      nulFree(su.contactName ?? null),
      nulFree(su.contactPushName ?? null),
      su.waStatusId,
      su.type,
      nulFree(su.caption ?? null),
      su.mediaPath ?? null,
      nulFree(su.mediaMimetype ?? null),
      su.mediaOmitted ?? false,
      su.omitReason ?? null,
      su.backgroundColor ?? null,
      su.font ?? null,
      su.postedAt,
      su.expiresAt,
    ],
  }),
  // Import automation rules (per-session autoreply rules; FK sessions ON DELETE CASCADE, so the
  // import's `DELETE FROM sessions` wipes them and they must be re-inserted or a restore
  // permanently loses every rule).
  defineTableImporter({
    key: 'automationRules',
    label: 'automation rule',
    sql: `INSERT INTO automation_rules (id, "sessionId", name, enabled, conditions, "replyText", "cooldownSeconds", "createdAt", "updatedAt")
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    id: (rule: AutomationRuleRow) => rule.id,
    // This path bypasses the rule DTOs. A conditions value without a conditions array matches every
    // inbound message, so a malformed one stored verbatim would autoreply to every contact; veto the
    // row with a warning, like the webhooks guard.
    skip: (rule: AutomationRuleRow) => {
      const errors = collectFilterErrors(decodeJsonColumn(rule.conditions));
      if (errors.length === 0) return null;
      return `Skipped automation rule ${rule.id}: invalid conditions (${errors.join('; ')})`;
    },
    map: (rule: AutomationRuleRow) => [
      rule.id,
      rule.sessionId,
      nulFree(rule.name),
      rule.enabled ?? true,
      rule.conditions == null
        ? null
        : typeof rule.conditions === 'string'
          ? rule.conditions
          : JSON.stringify(rule.conditions),
      nulFree(rule.replyText),
      rule.cooldownSeconds ?? 60,
      rule.createdAt,
      rule.updatedAt,
    ],
  }),
];

// The `as TableCounts` cast in importData means a dropped or mis-keyed descriptor is invisible to
// the compiler: the table would silently never import and would vanish from the restored-row total
// that guards against wiping a database with an empty payload. Assert the set at module load.
const EXPECTED_TABLE_KEYS: ReadonlyArray<keyof MigrationTables> = [
  'sessions',
  'webhooks',
  'messages',
  'messageBatches',
  'templates',
  'baileysStoredMessages',
  'lidMappings',
  'chatStates',
  'pluginInstances',
  'conversationMappings',
  'ingressEvents',
  'webhookDeliveryFailures',
  'webhookOutboxEvents',
  'integrationDeliveryFailures',
  'statusUpdates',
  'automationRules',
];
const importerKeys = TABLE_IMPORTERS.map(importer => importer.key);
for (const key of EXPECTED_TABLE_KEYS) {
  if (!importerKeys.includes(key)) throw new Error(`table-importers: missing descriptor for "${key}"`);
}
if (importerKeys.length !== EXPECTED_TABLE_KEYS.length) {
  throw new Error(`table-importers: expected ${EXPECTED_TABLE_KEYS.length} descriptors, found ${importerKeys.length}`);
}
