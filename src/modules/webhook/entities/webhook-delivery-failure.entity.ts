import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * A durable record of a webhook delivery that exhausted all of its retries. The queued path (BullMQ)
 * otherwise only leaves a `failed` job that the queue evicts after a day, and the direct fallback path
 * swallowed the final error entirely — so a receiver outage longer than the retry window silently lost
 * events with no operator-visible trail. Each terminal failure is appended here (see
 * `recordWebhookDeliveryFailure`) and surfaced via the ADMIN `GET /webhooks/delivery-failures` endpoint.
 *
 * Lives on the `data` connection (auto-loaded by the webhook entity glob).
 */
@Entity('webhook_delivery_failures')
@Index('IDX_webhook_delivery_failures_sessionId', ['sessionId'])
export class WebhookDeliveryFailure {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  webhookId: string;

  @Column()
  sessionId: string;

  @Column()
  event: string;

  @Column()
  url: string;

  /** The idempotency key the receiver would have deduped on (lets an operator correlate the lost event). */
  @Column({ nullable: true })
  idempotencyKey: string;

  @Column({ nullable: true })
  deliveryId: string;

  /** Total attempts made before giving up. */
  @Column({ type: 'int' })
  attempts: number;

  /** Last HTTP status, when the failure was a non-2xx response (null for a network/timeout/SSRF error). */
  @Column({ type: 'int', nullable: true })
  lastStatusCode: number | null;

  @Column({ type: 'text' })
  lastError: string;

  /** When the delivery was finally abandoned. */
  @CreateDateColumn()
  createdAt: Date;
}
