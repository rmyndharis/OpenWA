import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Session } from '../../session/entities/session.entity';
import { DateTransformer } from '../../../common/transformers/date.transformer';
import { jsonColumnType, dateColumnType } from '../../../common/utils/column-types';
import { WebhookFilters } from '../filters/filter-types';

@Entity('webhooks')
export class Webhook {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // varchar (not uuid) to match the authoritative migration DDL and sessions.id; the data connection
  // runs synchronize:false, so a 'uuid' decorator here would only mislead schema diffs / a stray sync.
  @Column({ type: 'varchar' })
  sessionId: string;

  @ManyToOne(() => Session, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sessionId' })
  session: Session;

  @Column({ type: 'varchar', length: 2048 })
  url: string;

  @Column({ type: jsonColumnType(), default: '["message.received"]' })
  events: string[];

  @Column({ type: 'varchar', length: 255, nullable: true })
  secret: string | null;

  @Column({ type: jsonColumnType(), default: '{}' })
  headers: Record<string, string>;

  // Optional smart pre-filter. Null/absent means "no filtering" (fire on every subscribed event).
  @Column({ type: jsonColumnType(), nullable: true })
  filters: WebhookFilters | null;

  @Column({ type: 'boolean', default: true })
  active: boolean;

  @Column({ type: 'int', default: 3 })
  retryCount: number;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  lastTriggeredAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
