import { Column, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Persisted `lid -> phone` resolution table on the `data` connection. One global, cross-session row per
 * lid (the maintainer wants the mapping shared, not per-session), so a lid resolved in one session/run is
 * usable everywhere and survives restarts - replacing the per-session, in-memory `lidToPn` map.
 *
 * A phone is last-write-wins: a stored mapping is "best known, not forever" (WhatsApp recycles numbers),
 * so it's a cache WhatsApp can correct. `phone` is nullable to record a negative result (a lid we looked
 * up and could not resolve) so active lookups stay one-network-call-per-unknown-lid. A negative replaces a
 * phone only when the session that wrote it (or none, or one since deleted or logged out) answers it, since
 * another account may not see the number. `sessionId` is the row's owner, the session that last wrote it: a
 * negative, or a report of a phone. A repeated report checks the current shared row and preserves its
 * owner and timestamp when the phone is unchanged, so after s1, s2, s1 report one phone the owner is s2. A deleted or logged-out session owns nothing. Intentionally NOT a foreign key, since the row
 * outlives any one session.
 */
@Entity('lid_mappings')
@Index(['phone']) // reverse lookup: phone -> lids, for the message from-filter
export class LidMapping {
  /** The lid number (bare, device-stripped - the user-part of `<lid>@lid`). */
  @PrimaryColumn()
  lid!: string;

  /** E.164 phone digits, or null when the lid is known-but-unresolved (a cached negative result). */
  @Column({ type: 'varchar', nullable: true })
  phone!: string | null;

  /** The row's owner: the session that last wrote it (see above). Not a foreign key. */
  @Column({ type: 'varchar', nullable: true })
  sessionId!: string | null;

  /** True after an engine mapping report; cache-only lookups remain display data. */
  @Column({ type: 'boolean', default: false })
  isReported!: boolean;

  @UpdateDateColumn()
  updatedAt!: Date;
}
