import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Session } from '../../session/entities/session.entity';
import { DateTransformer } from '../../../common/transformers/date.transformer';
import { jsonColumnType, dateColumnType } from '../../../common/utils/column-types';

@Entity('webhooks')
// dispatch() queries by (sessionId, active) on every inbound/outbound event.
@Index(['sessionId', 'active'])
export class Webhook {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
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
