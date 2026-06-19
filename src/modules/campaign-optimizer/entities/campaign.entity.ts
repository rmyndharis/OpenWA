import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

@Entity('campaigns')
@Index(['sessionId'])
export class Campaign {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  sessionId: string;

  @Column({ length: 200 })
  name: string;

  @Column({ type: 'integer', default: 0 })
  enrollmentCount: number;

  @Column({ type: 'float', nullable: true })
  completionRate?: number;

  @Column({ type: 'float', nullable: true })
  unsubscribeRate?: number;

  @Column({ type: 'float', nullable: true })
  replyRate?: number;

  @Column({ type: 'text', nullable: true })
  stepFunnel?: string;

  @Column({ type: 'text', nullable: true })
  steps?: string;

  @Column({ type: 'integer', default: 0 })
  lastOptimizedEnrollmentCount: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
