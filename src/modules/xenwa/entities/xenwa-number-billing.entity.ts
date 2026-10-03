import { Entity, Column, PrimaryColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * Monthly billing state of one connected WhatsApp number (session). The owner pays from their XenAI
 * Tech credit balance; teammates never pay. `paidUntil` is the end of the period already paid for.
 *
 * status:
 * - `active` — paid (or inside the grace period after a failed renewal)
 * - `paused` — renewal failed past the grace period: the engine was stopped and managed keys may only
 *   read until the owner tops up; the next successful renewal resumes it automatically.
 */
@Entity('xenwa_number_billing')
export class XenwaNumberBilling {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  sessionId!: string;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status!: 'active' | 'paused';

  @Index('IDX_xenwa_billing_paidUntil')
  @Column({ type: 'datetime' })
  paidUntil!: Date;

  @Column({ type: 'datetime', nullable: true })
  lastChargedAt!: Date | null;

  /** Credits taken for the current period (0 for the free rollout period). */
  @Column({ type: 'int', default: 0 })
  lastChargeCredits!: number;

  /** Idempotency key of the last successful charge (`xenwa:<sessionId>:<YYYY-MM>`). */
  @Column({ type: 'varchar', length: 128, nullable: true })
  lastChargeKey!: string | null;

  /** Why the current period is free, e.g. `rollout` for numbers that existed before billing. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  freeReason!: string | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  lastError!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
