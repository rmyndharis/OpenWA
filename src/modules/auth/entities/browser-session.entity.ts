import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';

@Entity('browser_sessions')
@Index('UQ_browser_sessions_tokenHash', ['tokenHash'], { unique: true })
@Index('IDX_browser_sessions_apiKeyId', ['apiKeyId'])
@Index('IDX_browser_sessions_expiresAt', ['expiresAt'])
export class BrowserSession {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 64 })
  tokenHash!: string;

  @Column({ type: 'varchar', length: 36 })
  apiKeyId!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @Column({ type: 'datetime' })
  expiresAt!: Date;

  @Column({ type: 'datetime', nullable: true })
  revokedAt!: Date | null;
}
