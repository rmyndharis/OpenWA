import { Column, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Persisted `lid -> phone` resolution table on the `data` connection. One global, cross-session row per
 * lid (the maintainer wants the mapping shared, not per-session), so a lid resolved in one session/run is
 * usable everywhere and survives restarts - replacing the per-session, in-memory `lidToPn` map.
 *
 * Last-write-wins: a stored mapping is "best known, not forever" (WhatsApp recycles numbers), so it's a
 * cache WhatsApp can correct. `phone` is nullable to record a negative result (a lid we looked up and
 * could not resolve) so active lookups stay one-network-call-per-unknown-lid. `sessionId` is provenance
 * only (which session last wrote the row) - intentionally NOT a foreign key, since the row outlives any
 * one session.
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

  /** The session that last wrote this row. Provenance/debugging only; not a foreign key. */
  @Column({ type: 'varchar', nullable: true })
  sessionId!: string | null;

  @UpdateDateColumn()
  updatedAt!: Date;
}
