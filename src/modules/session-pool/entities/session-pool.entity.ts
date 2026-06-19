import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn } from 'typeorm';

@Entity('session_pools')
export class SessionPool {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ default: 1 })
  targetStandbyCount: number;

  @Column({ type: 'text', default: '[]' })
  productionSessionIds: string; // JSON string[]

  @Column({ type: 'text', default: '[]' })
  standbySessionIds: string; // JSON string[]

  @Column({ default: true })
  autoFailover: boolean;

  @Column({ default: 60 })
  standbyWarmupSeconds: number;

  @CreateDateColumn()
  createdAt: Date;
}
