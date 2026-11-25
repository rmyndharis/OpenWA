import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';
import type { ApiKeyCapability } from '../api-key-permissions';

export enum ApiKeyRole {
  ADMIN = 'admin',
  OPERATOR = 'operator',
  VIEWER = 'viewer',
}

@Entity('api_keys')
export class ApiKey {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Index('IDX_api_keys_keyHash', { unique: true })
  @Column({ type: 'varchar', length: 64 })
  keyHash!: string;

  // 12 to fit the 12-char prefix that auth.service writes (was varchar(8); harmless on the
  // hardcoded-SQLite `main` connection, but kept consistent with the code).
  @Column({ type: 'varchar', length: 12 })
  keyPrefix!: string;

  @Column({
    type: 'varchar',
    length: 20,
    default: ApiKeyRole.OPERATOR,
  })
  role!: ApiKeyRole;

  @Column({ type: 'simple-array', nullable: true })
  allowedIps!: string[] | null;

  @Column({ type: 'simple-array', nullable: true })
  allowedSessions!: string[] | null;

  // Chat-level allowlist, independent of allowedSessions and the same fail-open semantic: NULL or
  // empty means "every chat". Entries are WhatsApp chat ids (a group `<id>@g.us`, a contact
  // `<phone>@c.us` / `<lid>@lid`, or a bare phone number). Enforced on the read surface and on
  // sends; see src/common/security/chat-scope.ts.
  @Column({ type: 'simple-array', nullable: true })
  allowedChats!: string[] | null;

  // Blocked-capability list, independent of role and of both id scopes: NULL or empty means
  // "nothing blocked". Each entry turns off the routes tagged with that capability; see
  // src/modules/auth/api-key-permissions.ts.
  @Column({ type: 'simple-array', nullable: true })
  deniedPermissions!: ApiKeyCapability[] | null;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ type: 'datetime', nullable: true })
  expiresAt!: Date | null;

  @Column({ type: 'datetime', nullable: true })
  lastUsedAt!: Date | null;

  @Column({ type: 'int', default: 0 })
  usageCount!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
