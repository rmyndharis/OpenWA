import {
  Entity,
  Column,
  Index,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Session } from '../../session/entities/session.entity';
import { jsonColumnType } from '../../../common/utils/column-types';
import { WebhookFilters } from '../../webhook/filters/filter-types';

/**
 * A single-message autoreply rule: when an inbound message matches `conditions`, the gateway answers
 * the chat with `replyText` through the ordinary send path (send pacing and plugin vetoes included).
 *
 * `conditions` reuses the webhook filter shape (`message` family) verbatim — same JSON, same
 * validator, same evaluator — so a rule matches exactly what a filtered `message.received` webhook
 * would have fired for. Null/empty conditions match every inbound message.
 */
@Entity('automation_rules')
export class AutomationRule {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // varchar (not uuid) to match sessions.id, same reasoning as webhooks.sessionId; indexed because
  // the evaluation path loads a session's rules on every inbound message.
  @Index('IDX_automation_rules_sessionId')
  @Column({ type: 'varchar' })
  sessionId!: string;

  @ManyToOne(() => Session, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sessionId' })
  session!: Session;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  // Null/absent means "match every inbound message" — mirrors webhook filters' additive default.
  @Column({ type: jsonColumnType(), nullable: true })
  conditions!: WebhookFilters | null;

  @Column({ type: 'text' })
  replyText!: string;

  // Per-(rule, chat) quiet period: the same rule will not fire twice into the same chat within the
  // window. Together with the evaluator's freshness gate this rate-bounds (not: terminates) an
  // autoreply-vs-autoreply exchange. 0 disables it — knowingly.
  @Column({ type: 'int', default: 60 })
  cooldownSeconds!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
