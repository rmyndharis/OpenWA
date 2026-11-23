import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';
import { NulFreeTransformer } from '../../../common/transformers/nul-free.transformer';
import { jsonColumnType } from '../../../common/utils/column-types';

/**
 * A durable record of a webhook delivery that exhausted all of its retries. The queued path (BullMQ)
 * otherwise only leaves a `failed` job that the queue evicts after a day, and the direct fallback path
 * swallowed the final error entirely — so a receiver outage longer than the retry window silently lost
 * events with no operator-visible trail. Each lost delivery is appended here once (see
 * `recordWebhookDeliveryFailure`, which skips a delivery it has already recorded so a replayed one is
 * not reported several times) and surfaced via the ADMIN `GET /webhooks/delivery-failures` endpoint.
 *
 * Lives on the `data` connection (auto-loaded by the webhook entity glob).
 */
@Entity('webhook_delivery_failures')
@Index('IDX_webhook_delivery_failures_sessionId', ['sessionId'])
@Index('IDX_webhook_delivery_failures_createdAt', ['createdAt'])
@Index('IDX_webhook_delivery_failures_sessionId_createdAt', ['sessionId', 'createdAt'])
// Backs the before-insert duplicate lookup that keeps one row per lost delivery rather than one per
// reconciler replay. See AddWebhookDeliveryFailureLookupIndex1786300000000.
@Index('IDX_webhook_delivery_failures_delivery', ['webhookId', 'idempotencyKey'])
@Index('UQ_webhook_delivery_failures_terminal', ['webhookId', 'idempotencyKey'], {
  unique: true,
  where: '"attempts" > 0',
})
export class WebhookDeliveryFailure {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  webhookId!: string;

  @Column()
  sessionId!: string;

  @Column()
  event!: string;

  @Column()
  url!: string;

  /** The idempotency key the receiver would have deduped on (lets an operator correlate the lost event). */
  @Column({ nullable: true })
  idempotencyKey!: string;

  @Column({ nullable: true })
  deliveryId!: string;

  /** Total attempts made before giving up. */
  @Column({ type: 'int' })
  attempts!: number;

  /** Last HTTP status, when the failure was a non-2xx response (null for a network/timeout/SSRF error). */
  @Column({ type: 'int', nullable: true })
  lastStatusCode!: number | null;

  @Column({ type: 'text', transformer: NulFreeTransformer })
  lastError!: string;

  /**
   * The event data the delivery was built from (pre-`webhook:before`, after inline-media shedding),
   * kept so `POST /webhooks/delivery-failures/redrive` can replay the lost event. Written only for a
   * terminal row (attempts > 0) and only while WEBHOOK_FAILURE_PAYLOAD_RETENTION_HOURS > 0; the
   * retention sweep nulls it once that window passes, leaving the row itself for the audit trail.
   * NULL on every row recorded with the knob off, which keeps today's behaviour.
   *
   * `select: false`: the column can hold a whole message body, and the list endpoint serializes
   * these entities as they are read. Only the redrive path selects it explicitly.
   */
  @Column({ type: jsonColumnType(), nullable: true, select: false })
  payload!: Record<string, unknown> | null;

  /** When the delivery was finally abandoned. */
  @CreateDateColumn()
  createdAt!: Date;
}
