import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type ClientMappingKind = 'contact' | 'group' | 'teammate';
export type ClientMappingStatus = 'active' | 'inactive';

/**
 * Maps a WhatsApp contact/group JID, or an internal teammate identifier, onto client/team
 * organizational context — useful for anyone running OpenWA across multiple clients, teams, or
 * projects (agencies, community managers, support desks) who wants to tag WhatsApp identities with
 * "who this is" metadata for reporting, exports, or downstream automation. `sessionId` is non-FK
 * provenance, same reasoning as `ConversationMapping`: a mapping should outlive a single WhatsApp
 * session (reconnects, session id churn), and a `kind='teammate'` row has no WhatsApp session at
 * all, so it is nullable rather than a real foreign key.
 *
 * Uniqueness: (sessionId, jid, kind) is enforced at the DB for contact/group rows. It is NOT
 * enforced there for teammate rows, because both Postgres and SQLite treat every NULL sessionId as
 * distinct in a unique index — two teammate rows with the same jid and a NULL sessionId would not
 * collide. `ClientMappingService` enforces teammate-jid uniqueness itself before insert instead of
 * a DB constraint; this is a low-frequency, admin-managed table, so the service-level check's race
 * window is an acceptable tradeoff, same shape as the automation rule per-session cap ("bounds
 * amplification, not an invariant").
 *
 * A SECOND uniqueness rule (migration 1786600000000): (sessionId, phone) is also unique whenever
 * phone is set — the backstop for the "same real contact, two jids" bug (see docs/32 §5): WhatsApp
 * addresses the same person through a `@c.us` jid in a direct chat and a separate `@lid` (privacy
 * id) jid in a group's participant list, and naive import logic can create one row per jid instead
 * of recognizing them as the same person. `ClientMappingService.resolveAndUpsert` is the app-layer
 * fix; this index is the DB-level one for any writer that skips it. Partial/filtered so
 * group/teammate rows (`phone` always NULL) never collide with each other on it. The predicate
 * quotes the column — an unquoted `where` reaches PostgreSQL verbatim and gets case-folded to
 * `phone`, which happens to still match here since the column IS lowercase, but quoting stays
 * consistent with every other identifier in this file and with the migration's own predicate (see
 * message.entity.ts's `mediaPath` index for the case where skipping this actually breaks).
 */
@Entity('client_mappings')
@Index('IDX_client_mappings_sessionId', ['sessionId'])
@Index('UQ_client_mappings_session_jid_kind', ['sessionId', 'jid', 'kind'], { unique: true })
@Index('UQ_client_mappings_session_phone', ['sessionId', 'phone'], { unique: true, where: '"phone" IS NOT NULL' })
export class ClientMapping {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', nullable: true })
  sessionId!: string | null;

  /** WhatsApp JID for contact/group kinds; an internal teammate identifier for `kind='teammate'`. */
  @Column({ type: 'varchar' })
  jid!: string;

  @Column({ type: 'varchar' })
  kind!: ClientMappingKind;

  @Column({ type: 'varchar', length: 200 })
  name!: string;

  /** Nullable: groups don't have a phone number. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  phone!: string | null;

  /** The organization this mapping belongs to — your own company, or a client/customer name. */
  @Column({ type: 'varchar', length: 200 })
  company!: string;

  /** Department, e.g. 'Sales', 'Support'. Nullable: not every mapped row has one. */
  @Column({ type: 'varchar', length: 100, nullable: true })
  team!: string | null;

  /** Job title/function within `team`, e.g. 'Account Manager'. */
  @Column({ type: 'varchar', length: 100, nullable: true })
  role!: string | null;

  /** IANA time zone name. Useful for scheduling/automation built on top of this directory to
   *  account for the contact's working hours. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  timezone!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status!: ClientMappingStatus;

  /**
   * Designated backup/secondary contact for this mapping: another `ClientMapping` row's id. A
   * generic hook for anyone building a notification or escalation workflow on top of this
   * directory (e.g. "who to notify if the primary contact hasn't been reached"); OpenWA itself does
   * not act on this field. Deliberately NOT a DB foreign key — it references the same table, and
   * self-referential FK + this table's own uniqueness constraints add migration complexity this
   * admin-managed field doesn't earn. Validated at the service layer instead (must point at an
   * existing row, and not at itself).
   */
  @Column({ type: 'varchar', nullable: true })
  backupOwnerId!: string | null;

  /** Per-group opt-out flag reserved for future message-sentiment/analytics features built on top
   *  of this directory. Not consumed by anything in OpenWA core today. Ignored for other kinds. */
  @Column({ type: 'boolean', default: true })
  sentimentTracking!: boolean;

  /** Free-text context about this contact/group — preferred contact hours, account history,
   *  anything worth surfacing alongside the mapping. */
  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  /**
   * JSON array of every other jid WhatsApp has used to address this same real contact — e.g. a
   * `@lid` seen in a group's participant list, once `resolveAndUpsert` matches it to this row by
   * phone instead of creating a second row for it (see docs/32 §5). Informational only: `jid` stays
   * the one address every other part of the app reads/writes through. Nullable/never set for
   * group/teammate rows, which have no phone to match aliases against in the first place.
   */
  @Column({ type: 'text', nullable: true })
  aliasJids!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
