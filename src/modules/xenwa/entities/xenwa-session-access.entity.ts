import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * Who may use a WhatsApp account (session), and how. One row per (session, email):
 *
 * - `role = 'owner'`  — the account's owner: every permission, plus deleting the account and managing
 *   its team. At most one per session.
 * - `role = 'member'` — a teammate with the listed `permissions` (always including `read`).
 *
 * `userId` is NULL while the invite is pending (the email has never signed in to XenWA); the first
 * SSO sign-in with that email claims every pending row for it.
 */
@Entity('xenwa_session_access')
@Index('IDX_xenwa_access_session_email', ['sessionId', 'email'], { unique: true })
export class XenwaSessionAccess {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_xenwa_access_sessionId')
  @Column({ type: 'varchar', length: 64 })
  sessionId!: string;

  @Index('IDX_xenwa_access_email')
  @Column({ type: 'varchar', length: 254 })
  email!: string;

  @Index('IDX_xenwa_access_userId')
  @Column({ type: 'varchar', length: 36, nullable: true })
  userId!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'member' })
  role!: 'owner' | 'member';

  @Column({ type: 'simple-array', nullable: true })
  permissions!: string[] | null;

  /** xenwa user id of whoever granted it, or `api-key:<id>` when an admin key did. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  grantedBy!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
