import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Unique, Index } from 'typeorm';
import { DateTransformer } from '../../../common/transformers/date.transformer';
import { jsonColumnType, dateColumnType } from '../../../common/utils/column-types';
import type { ParticipantMap } from '../core/ports';

@Entity('translation_groups')
@Unique(['sessionId', 'chatId'])
export class TranslationGroup {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'varchar', length: 100 })
  sessionId: string;

  @Column({ type: 'varchar', length: 100 })
  chatId: string;

  @Column({ type: 'boolean', default: false })
  active: boolean;

  @Column({ type: jsonColumnType(), default: '{}' })
  participants: ParticipantMap;

  @Column({ type: jsonColumnType(), default: '[]' })
  delegatedControllers: string[];

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  announcedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
