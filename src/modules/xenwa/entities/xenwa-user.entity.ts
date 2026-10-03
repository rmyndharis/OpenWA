import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * A XenAI Tech account that has signed in to XenWA through SSO. Linked by the platform user id
 * (`externalId`), with the email kept for invites and display. Each user owns exactly one managed
 * API key (`apiKeyId`), which is what the dashboard and the user's own integrations authenticate with.
 */
@Entity('xenwa_users')
export class XenwaUser {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_xenwa_users_externalId', { unique: true })
  @Column({ type: 'varchar', length: 64 })
  externalId!: string;

  @Index('IDX_xenwa_users_email', { unique: true })
  @Column({ type: 'varchar', length: 254 })
  email!: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  name!: string | null;

  @Column({ type: 'varchar', length: 1024, nullable: true })
  image!: string | null;

  /** The XenAI Tech role at the last sign-in (super_admin, admin, coach, client, guest). */
  @Column({ type: 'varchar', length: 32, default: 'client' })
  platformRole!: string;

  @Index('IDX_xenwa_users_apiKeyId')
  @Column({ type: 'varchar', length: 36, nullable: true })
  apiKeyId!: string | null;

  /** AES-256-GCM ciphertext of the raw managed key (see xenwa-config.ts). */
  @Column({ type: 'text', nullable: true })
  apiKeyCipher!: string | null;

  @Column({ type: 'datetime', nullable: true })
  lastLoginAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
