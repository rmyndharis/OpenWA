import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';
import { jsonColumnType } from '../../../common/utils/column-types';

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
@Index(['sessionId', 'waMessageId'])
export class Message {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  @Index()
  sessionId: string;

  @Column({ nullable: true })
  waMessageId: string;

  @Column()
  chatId: string;

  @Column()
  from: string;

  @Column()
  to: string;

  @Column({ type: 'text', nullable: true })
  body: string;

  @Column({ default: 'text' })
  type: string;

  @Column({
    type: 'varchar',
    default: MessageDirection.OUTGOING,
  })
  direction: MessageDirection;

  @Column({ type: 'bigint', nullable: true })
  timestamp: number;

  @Column({ type: jsonColumnType(), nullable: true })
  metadata: Record<string, unknown>;

  @Column({
    type: 'varchar',
    default: MessageStatus.SENT,
  })
  @Index()
  status: MessageStatus;

  @CreateDateColumn()
  createdAt: Date;
}
