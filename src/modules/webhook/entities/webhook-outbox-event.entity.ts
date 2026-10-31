import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { dateColumnType, jsonColumnType } from '../../../common/utils/column-types';
import { DateTransformer } from '../../../common/transformers/date.transformer';

// pending: recorded before dispatch; queued: BullMQ owns the current job.
// Both retain replay data. The worker settles queued rows after success or durable failure.
// dispatched/failed: settled, payload retired. NULL denotes unwatched legacy rows.
export type WebhookOutboxState = 'pending' | 'queued' | 'dispatched' | 'failed';

/**
 * Durable record of an outbound webhook delivery, written before the attempt.
 *
 * Fan-out is fire-and-forget from the projector (`void dispatch(...)`), so until this row existed a
 * hard crash between persisting a message and completing its POST lost the delivery with nothing
 * left behind in either mode. The in-memory `inFlightDeliveries` map already tracked exactly this
 * set; the row is its durable twin.
 *
 * UNIQUE(webhookId, idempotencyKey): the key is already salted per webhook at dispatch, so the pair
 * names one delivery attempt-set exactly, and a replay reuses the STORED key rather than deriving a
 * new one, which is what keeps a redelivery deduplicable at the receiver.
 */
@Entity('webhook_outbox_events')
@Index('UQ_webhook_outbox_events_webhook_key', ['webhookId', 'idempotencyKey'], { unique: true })
@Index('IDX_webhook_outbox_events_state_createdAt', ['state', 'createdAt'])
// A session delete removes its outbox rows by sessionId, in batches.
@Index('IDX_webhook_outbox_events_sessionId', ['sessionId'])
export class WebhookOutboxEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  webhookId!: string;

  @Column()
  sessionId!: string;

  @Column()
  event!: string;

  @Column()
  idempotencyKey!: string;

  @Column()
  deliveryId!: string;

  // Pending and queued rows keep their payload until delivery or durable failure handoff.
  @Column({ type: jsonColumnType(), nullable: true })
  payload!: Record<string, unknown> | null;

  @Column({ type: 'varchar', nullable: true })
  state!: WebhookOutboxState | null;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  lastAttemptAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
