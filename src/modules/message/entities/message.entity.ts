import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index, ValueTransformer } from 'typeorm';
import { jsonColumnType } from '../../../common/utils/column-types';

/**
 * A `bigint` column reads back as a string on PostgreSQL (pg avoids >2^53 precision loss) but as a
 * number on SQLite. WhatsApp epoch-seconds are far below 2^53, so coerce reads to a number for a
 * consistent REST/SDK/MCP contract (entity, DTO, all three SDKs, and dashboard declare `number`).
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
// Composite index for the ack-driven status UPDATE (scoped by sessionId + waMessageId).
// Without it every ack does a full table scan of a hot table.
@Index('UQ_messages_sessionId_waMessageId', ['sessionId', 'waMessageId'], { unique: true })
export class Message {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // No standalone @Index here: sessionId-only lookups are already served by the composite indexes
  // that lead with sessionId — (sessionId, createdAt) above and the unique (sessionId, waMessageId).
  @Column()
  sessionId!: string;

  @Column({ nullable: true })
  waMessageId!: string;

  @Column()
  chatId!: string;

  /** Human-readable name for the chat (contact pushName, group name, etc). Populated on save when available — null for legacy rows. */
  @Column({ nullable: true })
  chatName?: string;

  /**
   * Stable sender identity for a group message: the participant JID who actually posted (`from` is
   * the group JID). Lets the chat view tell two same-named participants apart. Null on 1:1
   * messages, outgoing echoes, and legacy rows.
   */
  @Column({ nullable: true })
  author?: string;

  @Column()
  from!: string;

  @Column()
  to!: string;

  @Column({ type: 'text', nullable: true })
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
   * case for every row while `CHAT_MEDIA_ARCHIVE_ENABLED` is off (the default), for non-media
   * messages, and for media above the archive cap. Independent of the inline base64 copy in
   * `metadata.media`, which is unaffected by archiving.
   */
  @Column({ nullable: true })
  mediaPath?: string;

  /** Mimetype of the archived media, so the read endpoint can serve a Content-Type without
   *  depending on the inline copy. Null whenever `mediaPath` is. */
  @Column({ nullable: true })
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
