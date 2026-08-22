import type { MigrationTables, WebhookRow, MessageRow, MessageBatchRow } from './migration-tables.types';

/**
 * A `data` value that is a POINTER rather than bytes. `metadata.media.data` holds `base64 || dto.url!`
 * (message.service.ts), and the URL form is the only one the send examples offer — so a URL must never
 * be treated as a payload: dropping it destroys the reference for a few dozen bytes that were never a
 * 413 risk, and reports a `sizeBytes` that is URL text measured as base64, the size of nothing.
 */
function isMediaPointer(data: string): boolean {
  // Case-insensitive to match the two adapters that actually fetch these (`isHttpUrl` in
  // wwebjs-messaging.ts, `resolveMediaBuffer` in baileys-messaging.ts). `@IsUrl()` accepts an
  // uppercase scheme, so a row can hold one; disagreeing with the senders here would destroy a
  // reference to media they had just delivered.
  return /^https?:\/\//i.test(data);
}

/**
 * Webhook credentials (the HMAC secret and custom headers, which may carry receiver tokens) do
 * not belong in a backup payload — omit them from the export. The importer restores the row
 * with secret null and headers {} when they are absent.
 */
function redactWebhookCredentials(rows: WebhookRow[]): void {
  for (const row of rows) {
    delete row.secret;
    delete row.headers;
  }
}

/**
 * Postgres carries a STORED generated tsvector column `body_ts` (FTS) that `SELECT *` picks up.
 * It is a server-maintained index artifact, not payload: strip it so backups stay dialect-neutral
 * (and small). The import's explicit column list already ignores it in older archives.
 */
function stripBodyTs(rows: MessageRow[]): void {
  for (const row of rows) {
    delete row.body_ts;
  }
}

/**
 * Replace an over-budget inline payload on a message row with the engine's own omitted marker
 * (`{ mimetype, filename?, omitted: true, sizeBytes }`, `capInboundMedia`), so a restored row is
 * indistinguishable from one whose media was skipped on the way in rather than a new shape consumers
 * must learn. `mediaPath`/`mediaMimetype` are untouched.
 *
 * NOTE: this bounds the media, not the export. A text-only history is still unbounded — every row
 * carries a few hundred bytes of scaffolding regardless of what was said.
 */
function stripInlineMediaPayload(row: MessageRow, exceedsBudget: (encodedBytes: number) => boolean): void {
  // `metadata` is TEXT on both dialects and the export reads through a raw query that never hydrates
  // an entity, so the value is always a string here.
  const raw = row.metadata;
  if (typeof raw !== 'string') return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Metadata we cannot parse is not ours to rewrite; the importer round-trips it verbatim.
    return;
  }
  // `JSON.parse('null')` yields null, and the import accepts a hand-edited archive verbatim, so this
  // is reachable — reading `.media` off it would 500 every export until the row is deleted by hand.
  if (typeof parsed !== 'object' || parsed === null) return;
  const bag = parsed as Record<string, unknown>;
  const media = bag.media as { data?: unknown; sizeBytes?: number } | null | undefined;
  if (!media || typeof media.data !== 'string' || isMediaPointer(media.data)) return;
  if (!exceedsBudget(Buffer.byteLength(media.data, 'utf8'))) return;
  const { data, ...withoutPayload } = media;
  bag.media = {
    ...withoutPayload,
    omitted: true,
    // Decoded bytes, matching what capInboundMedia reports — the caller asked how big it WAS.
    sizeBytes: media.sizeBytes ?? Buffer.byteLength(data, 'base64'),
  };
  row.metadata = JSON.stringify(bag);
}

/**
 * The same budget applied to a bulk batch's stored message list.
 *
 * `message_batches.messages` carries the whole outbound list, base64 included, for the entire
 * duration of a run — `stripBatchMediaPayloads` only fires on the four terminal transitions, and a
 * batch left PROCESSING by another node keeps its payloads indefinitely. Bounding only `messages`
 * would let the 413 arrive by this route instead. The batch shape keeps `url` in its own field, so
 * unlike a message row there is no pointer to confuse with a payload.
 */
function stripBatchInlineMedia(row: MessageBatchRow, exceedsBudget: (encodedBytes: number) => boolean): void {
  const raw = row.messages;
  if (typeof raw !== 'string') return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (!Array.isArray(parsed)) return;
  let stripped = false;
  for (const entry of parsed) {
    const content = (entry as { content?: unknown } | null)?.content;
    if (typeof content !== 'object' || content === null) continue;
    for (const key of ['image', 'video', 'audio', 'document']) {
      const media = (content as Record<string, unknown>)[key] as { base64?: unknown } | null | undefined;
      if (!media || typeof media !== 'object' || typeof media.base64 !== 'string') continue;
      if (!exceedsBudget(Buffer.byteLength(media.base64, 'utf8'))) continue;
      delete media.base64;
      stripped = true;
    }
  }
  if (stripped) row.messages = JSON.stringify(parsed);
}

// A per-table export step for InfraDataService.exportData: which backup key the rows land under, the
// physical table to read, whether a genuinely-absent table is tolerable, and the per-table hooks that
// stay explicit because they encode real decisions (credential redaction, dialect artifacts, the
// inline-media budget).
export interface ExportTable<K extends keyof MigrationTables = keyof MigrationTables> {
  /** Backup key in `tables`/`counts` — the published response shape (see MigrationTablesDto). */
  key: K;
  /**
   * Physical table name, exactly as the data DataSource's entity metadata reports it. Every export
   * validates the registry against that metadata BEFORE reading: a table the metadata does not know
   * (renamed or dropped entity) fails the request rather than exporting empty.
   */
  table: string;
  /**
   * The table may legitimately not exist in this DB (created by a migration an older database has
   * not run). Only a GENUINE missing-table error (isMissingTableError) is tolerated, and the table
   * is reported in `skippedTables`. Tables without the flag are required: a missing one fails the
   * export, because a backup that silently omits them is worse than no backup.
   */
  optional?: boolean;
  /** In-place row mutation applied right after the read (redaction, artifact stripping). */
  afterRead?: (rows: MigrationTables[K]) => void;
  /** Spends the export's shared inline-media budget on this table's payloads. */
  inlineMedia?: {
    /** Which arm of `omittedInlineMedia` reports this table's dropped payloads. */
    bucket: 'messages' | 'messageBatches';
    /** Recency key: the budget is spent newest-first, so the most recent media survives. */
    newestFirst: (row: MigrationTables[K][number]) => number;
    /** Drops the row's inline payload in place when it does not fit the budget. */
    strip: (row: MigrationTables[K][number], exceedsBudget: (encodedBytes: number) => boolean) => void;
  };
}

/**
 * A registered table with its row type erased, which is what the union-keyed EXPORT_TABLES array
 * holds (the same shape as AnyTableImporter: `never` is the only parameter type every concrete
 * ExportTable<K> can be assigned to, and soundness comes from the export loop only ever handing an
 * entry rows it read for that entry's own table).
 */
export type AnyExportTable = Omit<ExportTable, 'afterRead' | 'inlineMedia'> & {
  afterRead?: (rows: never[]) => void;
  inlineMedia?: {
    bucket: 'messages' | 'messageBatches';
    newestFirst: (row: never) => number;
    strip: (row: never, exceedsBudget: (encodedBytes: number) => boolean) => void;
  };
};

// Registers one concrete descriptor into the union-keyed EXPORT_TABLES array.
function defineExportTable<K extends keyof MigrationTables>(table: ExportTable<K>): AnyExportTable {
  return table;
}

/**
 * Every data-DB table a backup must carry, in the SAME FK-safe order TABLE_IMPORTERS restores them:
 * sessions first (everything else references it or cascades from it), then the standalone
 * cache/DLQ tables. The export-tables parity spec pins this order to TABLE_IMPORTERS, the table set
 * to the data connection's entity metadata, and the keys to the published counts DTO — so a new
 * entity table cannot silently miss a backup: it must be registered here (with its import descriptor
 * and DTO keys) or excluded below with a reason.
 */
export const EXPORT_TABLES: AnyExportTable[] = [
  // sessions first: webhooks/messages/templates/etc. all reference it (some via FK, all by sessionId).
  defineExportTable({ key: 'sessions', table: 'sessions' }),
  defineExportTable({ key: 'webhooks', table: 'webhooks', afterRead: redactWebhookCredentials }),

  // Both carry a full inline base64 payload, so they share ONE budget: messages are served first
  // (newest media kept), batches spend what is left. Optional — an older DB may predate them.
  defineExportTable({
    key: 'messages',
    table: 'messages',
    optional: true,
    afterRead: stripBodyTs,
    inlineMedia: {
      bucket: 'messages',
      newestFirst: (row: MessageRow) => Number(row.timestamp),
      strip: stripInlineMediaPayload,
    },
  }),
  defineExportTable({
    key: 'messageBatches',
    table: 'message_batches',
    optional: true,
    inlineMedia: {
      bucket: 'messageBatches',
      newestFirst: (row: MessageBatchRow) => Date.parse(row.created_at),
      strip: stripBatchInlineMedia,
    },
  }),

  // templates + baileys_stored_messages both FK sessions ON DELETE CASCADE, so the import's
  // `DELETE FROM sessions` wipes them; they must be exported and re-inserted or the documented
  // backup flow loses them permanently.
  defineExportTable({ key: 'templates', table: 'templates', optional: true }),
  defineExportTable({ key: 'baileysStoredMessages', table: 'baileys_stored_messages', optional: true }),

  // Database-backed Baileys auth state (BAILEYS_AUTH_STORE=database). Keyed by session NAME with
  // no FK, so the import's sessions DELETE never clears it — export + re-insert, or restoring a
  // backup into a fresh DB silently costs every database-mode session its pairing (a QR re-scan
  // per session). These are live WhatsApp credentials: the archive must be treated as secret, the
  // same standing rule the sessions table's own auth artifacts already impose on backups.
  defineExportTable({ key: 'baileysAuthState', table: 'baileys_auth_state', optional: true }),

  // The persisted lid->phone resolution cache. Not a FK to sessions (provenance only), so the
  // import's `DELETE FROM sessions` never clears it — it must be exported + re-inserted explicitly
  // or a backup→restore into a fresh DB loses the whole cache (it self-heals, but lossily).
  defineExportTable({ key: 'lidMappings', table: 'lid_mappings', optional: true }),

  // Integration Fabric + both DLQs: none carry an FK constraint to sessions (sessionId is
  // provenance), so the import clears them explicitly before the sessions DELETE to keep the
  // replace-semantics complete.
  defineExportTable({ key: 'pluginInstances', table: 'plugin_instances', optional: true }),
  defineExportTable({ key: 'conversationMappings', table: 'conversation_mappings', optional: true }),
  defineExportTable({ key: 'ingressEvents', table: 'ingress_events', optional: true }),
  defineExportTable({ key: 'webhookDeliveryFailures', table: 'webhook_delivery_failures', optional: true }),
  defineExportTable({ key: 'webhookOutboxEvents', table: 'webhook_outbox_events', optional: true }),
  defineExportTable({
    key: 'integrationDeliveryFailures',
    table: 'integration_delivery_failures',
    optional: true,
  }),

  // status_updates has no FK to sessions (plain columns), so the sessions DELETE never clears it —
  // it must be exported + re-inserted explicitly like lid_mappings.
  defineExportTable({ key: 'statusUpdates', table: 'status_updates', optional: true }),

  // automation_rules has an ON DELETE CASCADE FK to sessions, so the sessions DELETE takes every
  // rule with it — exporting and re-inserting it is not optional, or a restore silently destroys
  // every autoreply rule.
  defineExportTable({ key: 'automationRules', table: 'automation_rules', optional: true }),
];

/**
 * Data-connection entity tables deliberately absent from the export, each with a one-line reason.
 * The parity spec (and every export, at runtime) fails when an entity table is in neither list, so
 * adding an entity forces an explicit backup decision here rather than a silent miss. Note the
 * TypeORM migration ledger (`migrations`) never appears: it is not an entity, so the connection's
 * entity metadata does not report it.
 */
export const EXPORT_TABLE_EXCLUSIONS: Readonly<Record<string, string>> = {
  // (empty today: every data-connection entity table is exported)
};
