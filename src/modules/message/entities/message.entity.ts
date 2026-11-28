import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index, ValueTransformer } from 'typeorm';
import { jsonColumnType } from '../../../common/utils/column-types';
import { NulFreeTransformer } from '../../../common/transformers/nul-free.transformer';

/**
 * A `bigint` column reads back as a string on PostgreSQL (pg avoids >2^53 precision loss) but as a
 * number on SQLite. WhatsApp epoch-seconds are far below 2^53, so coerce reads to a number for a
 * consistent REST/SDK/MCP contract (entity, DTO, the typed SDKs, and dashboard declare a numeric type).
 * Writes pass through unchanged; null stays null.
 */
export const bigintToNumberTransformer: ValueTransformer = {
  to: (value: number | null | undefined): number | null | undefined => value,
  from: (value: string | number | null): number | null => {
    if (value == null) return null;
    const n = Number(value);
    // Defensive: a bigint column can only return null or a numeric value, so NaN is unreachable —
    // but coerce a hypothetical non-numeric read to null rather than leak NaN into the contract.
    return Number.isNaN(n) ? null : n;
  },
};

export enum MessageDirection {
  INCOMING = 'incoming',
  OUTGOING = 'outgoing',
}

/** Where the engine reported a message and who it said wrote it (see {@link Message.engineRef}). */
export interface MessageEngineRef {
  chatId: string;
  direction: MessageDirection;
  author?: string | null;
  /**
   * Set on the row of an API send the engine delivered to another chat than the one it is filed under (the contact's
   * LID, for a send addressed by phone number): the row's own chat is the one the caller addressed, so a change is
   * judged by both. Never set where a hook chose the row's columns.
   */
  addressed?: true;
}

export enum MessageStatus {
  PENDING = 'pending',
  SENT = 'sent',
  DELIVERED = 'delivered',
  READ = 'read',
  FAILED = 'failed',
}

@Entity('messages')
@Index(['sessionId', 'createdAt'])
@Index(['chatId'])
// One chat's thread, paged newest-first, and its total; the send-pacing history probes filter on the
// same (sessionId, chatId, createdAt) prefix. The standalone chatId index stays for the search and
// stats reads that filter on chatId without a session. The explicit name matches the migration that
// creates it on synchronize-disabled deployments, so both schema paths converge on one index.
@Index('IDX_messages_sessionId_chatId_createdAt', ['sessionId', 'chatId', 'createdAt'])
// Explicit id tiebreaking keeps a message-time walk stable across SQLite and PostgreSQL.
@Index('IDX_messages_session_timestamp_id', ['sessionId', 'timestamp', 'id'])
@Index('IDX_messages_session_chat_timestamp_id', ['sessionId', 'chatId', 'timestamp', 'id'])
@Index('IDX_messages_session_direction_timestamp_id', ['sessionId', 'direction', 'timestamp', 'id'])
@Index('IDX_messages_sessionId_status', ['sessionId', 'status'])
@Index('IDX_messages_sessionId_direction_createdAt', ['sessionId', 'direction', 'createdAt'])
@Index('IDX_messages_status_createdAt', ['status', 'createdAt'])
// Composite index for the ack-driven status UPDATE (scoped by sessionId + waMessageId).
// Without it every ack does a full table scan of a hot table.
@Index('UQ_messages_sessionId_waMessageId', ['sessionId', 'waMessageId'], { unique: true })
export class Message {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // No standalone @Index here: sessionId-only lookups are already served by the composite indexes
  // that lead with sessionId: (sessionId, createdAt), (sessionId, chatId, createdAt) and the unique
  // (sessionId, waMessageId).
  @Column()
  sessionId!: string;

  @Column({ nullable: true })
  waMessageId!: string;

  @Column()
  chatId!: string;

  /** The sender's contact name (pushName) as the engine reported it: in a group that is the member, not
   *  the group. Null on legacy rows and on rows that carried no contact. */
  @Column({ nullable: true, transformer: NulFreeTransformer })
  chatName?: string;

  /**
   * Stable sender identity for a group, status or broadcast-list message: the JID who actually
   * posted (`from` is the group, `status@broadcast` or list id; on Baileys a list message the account
   * received is filed under the sender, so `from` is the sender too). Lets the chat view tell two
   * same-named participants apart. Null on 1:1 messages, outgoing echoes, and legacy rows.
   */
  @Column({ nullable: true })
  author?: string;

  /**
   * The chat, direction and author the engine reported, kept only when a `message:received` or `message:sent`
   * handler filed the row under others or rewrote its `from` or `to`: a revoke, edit, reaction or receipt is judged
   * by them, never by what the handler chose. Kept as well, `addressed`, when an API send was delivered to another
   * chat than the one its caller addressed, which the row is filed under: a change is then judged by both. Null on
   * every other row and on rows of earlier releases, which are judged by their own columns (a whatsapp-web.js one
   * also by the chat its id names).
   * Never selected by default, so no API read returns the chat a handler moved the message away from.
   */
  @Column({ type: jsonColumnType(), nullable: true, select: false })
  engineRef?: MessageEngineRef | null;

  /**
   * On the row of an API send whose message id the own-send echo's row took first: that id, while what this row holds
   * (the media bytes, a quote, a poll) is not yet merged onto the echo row. The pending reaper's sweep merges it and
   * drops this row, or, with the echo row gone, gives this row the id. Null on every other row. Never selected by
   * default; the partial index keeps the sweep to the rows that carry it.
   */
  @Index('IDX_messages_echoOf', { where: '"echoOf" IS NOT NULL' })
  @Column({ type: 'varchar', nullable: true, select: false })
  echoOf?: string | null;

  @Column()
  from!: string;

  @Column()
  to!: string;

  @Column({ type: 'text', nullable: true, transformer: NulFreeTransformer })
  body!: string;

  @Column({ default: 'text' })
  type!: string;

  @Column({
    type: 'varchar',
    default: MessageDirection.OUTGOING,
  })
  direction!: MessageDirection;

  @Column({ type: 'bigint', nullable: true, transformer: bigintToNumberTransformer })
  timestamp!: number;

  @Column({ type: jsonColumnType(), nullable: true })
  metadata!: Record<string, unknown>;

  /**
   * Storage key of this message's archived media, or null when nothing was archived — which is the
   * case for every row written while `CHAT_MEDIA_ARCHIVE_ENABLED` is off (the default), for non-media
   * messages, and for media above the archive cap. Independent of the inline base64 copy in
   * `metadata.media`, which stays inline by default and is replaced after verification in archive mode.
   */
  // Partial index for the chat-media orphan sweep's per-chunk `mediaPath IN (...)` lookup. NULL for
  // every un-archived row (archiving is opt-in), so the WHERE clause keeps the index to rows that
  // can ever match. The explicit name matches the migration that creates it on synchronize-disabled
  // deployments, so both schema paths converge on one index.
  // The column name is QUOTED in the predicate on purpose: PostgreSQL folds a bare identifier to
  // lower case, so `mediaPath IS NOT NULL` makes synchronize fail on `column "mediapath" does not
  // exist`. The migration below already quotes it, so this is also what keeps the two in step.
  @Index('IDX_messages_mediaPath', { where: '"mediaPath" IS NOT NULL' })
  @Column({ nullable: true })
  mediaPath?: string;

  /** Mimetype of the archived media, so the read endpoint can serve a Content-Type without
   *  depending on the inline copy. Null whenever `mediaPath` is. */
  @Column({ nullable: true, transformer: NulFreeTransformer })
  mediaMimetype?: string;

  @Column({
    type: 'varchar',
    default: MessageStatus.SENT,
  })
  @Index()
  status!: MessageStatus;

  // Standalone index for the createdAt-only range predicates of the stats aggregates — the
  // composite above leads with sessionId, so it can't serve them (SQLite needs ANALYZE stats for
  // a skip-scan; Postgres has none). The explicit name matches the migration that creates it on
  // synchronize-disabled deployments, so both schema paths converge on one index.
  @CreateDateColumn()
  @Index('IDX_messages_createdAt')
  createdAt!: Date;
}
