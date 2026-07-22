import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Current reaction state, keyed by the persisted message and the reacting WhatsApp identity.
 * A cleared engine reaction deletes this row; no unbounded reaction event history is retained.
 */
@Entity('message_reactions')
@Index(['sessionId', 'messageId'])
export class MessageReaction {
  @PrimaryColumn()
  messageId: string;

  @PrimaryColumn()
  senderId: string;

  @Column()
  sessionId: string;

  @Column({ type: 'text' })
  emoji: string;
}
