import { Column, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { jsonColumnType } from '../../../common/utils/column-types';

export type HandoverState = 'bot' | 'human' | 'closed';

// Maps a WA chat to a provider conversation, both directions. sessionId is non-FK provenance
// (a mapping outlives a session; last-write-wins).
@Entity('conversation_mappings')
@Index('UQ_conversation_mappings_forward', ['sessionId', 'chatId', 'pluginId', 'instanceId'], { unique: true })
@Index('UQ_conversation_mappings_reverse', ['pluginId', 'instanceId', 'providerConversationId'], { unique: true })
export class ConversationMapping {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  sessionId: string;

  @Column()
  chatId: string;

  @Column()
  pluginId: string;

  @Column()
  instanceId: string;

  @Column()
  providerConversationId: string;

  @Column({ default: 'bot' })
  handoverState: HandoverState;

  @Column({ type: jsonColumnType(), nullable: true })
  metadata: Record<string, unknown> | null;

  @UpdateDateColumn()
  updatedAt: Date;
}
