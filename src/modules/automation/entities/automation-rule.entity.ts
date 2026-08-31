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
 *
 * `newContactOnly` and `pauseOnHumanReply` are gates on the CHAT's history rather than on the
 * message, which is why they are rule fields and not `conditions` entries: the filter registry
 * resolves each field synchronously out of the message payload, and neither question can be
 * answered without reading the `messages` table. They apply on top of `conditions` — an empty
 * `conditions` with a gate set no longer means "every inbound message".
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

  /**
   * Fire only on a chat this account has never exchanged a message with before — a first-contact
   * greeting. The probe reads the `messages` table for any row in the chat OTHER than the inbound
   * message being evaluated (which the projector has already committed by the time a rule runs),
   * under both user-id dialects, so a contact known as `@s.whatsapp.net` is not greeted again as
   * `@c.us`.
   *
   * "Ever", not "recently": history is the whole table, so a contact whose rows have been reaped
   * by retention reads as new again.
   */
  @Column({ type: 'boolean', default: false })
  newContactOnly!: boolean;

  /**
   * Go quiet in a chat for good once a HUMAN has sent anything into it — the operator answering
   * from the dashboard, the API, or their own linked phone. The rule's own autoreplies are exempt:
   * they are written with `messages.automated = true`, which is precisely why that column exists.
   *
   * Deliberately permanent, not a window: "a human is handling this conversation" does not expire
   * on a timer, and a rule that resumed on its own would talk over an open ticket. Re-arming a chat
   * means the operator clearing that chat's history, or the rule being scoped away from it.
   */
  @Column({ type: 'boolean', default: false })
  pauseOnHumanReply!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
