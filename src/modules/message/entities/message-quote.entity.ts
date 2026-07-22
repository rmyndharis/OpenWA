import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Typed, minimal reply context for a persisted message. This deliberately mirrors only the stable
 * engine quote fields; the legacy JSON metadata remains untouched for existing API consumers.
 */
@Entity('message_quotes')
@Index(['sessionId', 'messageId'])
export class MessageQuote {
  @PrimaryColumn()
  messageId: string;

  @Column()
  sessionId: string;

  @Column()
  quotedWaMessageId: string;

  @Column({ type: 'text', nullable: true })
  body?: string;
}
